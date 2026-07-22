import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { config } from './config';
import { storagePaths } from './paths';
import { projectSlug } from './slug';
import { applyProjectEnv, clearProjectEnv } from './claudeSettings';

const HEARTBEAT_INTERVAL_MS = 45_000;
const REAPER_INTERVAL_MS = 3 * 60_000;
// Must cover crashed/zombied windows: a heartbeat file older than this is treated as dead.
const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS;
const HEALTH_TIMEOUT_MS = 2_000;
// Re-checks health and respawns if needed — the only thing that catches a mid-session crash,
// since ensureRunning is otherwise only called once at activation.
const WATCHDOG_INTERVAL_MS = 30_000;

interface ProxyLock {
  pid: number;
  port: number;
}

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already dead — fine, killing an already-dead PID is a no-op by design
  }
}

export class ProxyDaemonManager {
  private readonly windowId = crypto.randomUUID();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reaperTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private headroomBinPath: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get paths() {
    return storagePaths(this.context);
  }

  private localBaseUrl(): string {
    return `http://127.0.0.1:${config.headroomLocalPort()}`;
  }

  /**
   * Sets this window's PATH and ANTHROPIC_BASE_URL for its own integrated terminals, and mirrors
   * ANTHROPIC_BASE_URL into `.claude/settings.local.json`'s `env` block — required for Claude
   * Code's own VS Code extension, which spawns its CLI directly rather than through a terminal and
   * so never sees environmentVariableCollection at all (see applyProjectEnv in claudeSettings.ts).
   *
   * In remote mode, also sets ANTHROPIC_CUSTOM_HEADERS to carry X-Headroom-Proxy-Token — the
   * header Headroom's own proxy natively checks to gate access, separate from the real
   * Authorization/x-api-key headers Claude Code already sends for actual Anthropic auth. The
   * Docker bundle deliberately does not inject this header itself anymore (see docker/CLAUDE.md)
   * to avoid clobbering those real credentials, so the client must send it.
   */
  async applyEnvironment(): Promise<void> {
    const collection = this.context.environmentVariableCollection;
    collection.clear();

    if (config.rtkEnabled()) {
      collection.prepend('PATH', this.paths.rtkBinDir + path.delimiter);
    }
    if (config.headroomEnabled() && config.headroomMode() === 'local') {
      collection.prepend('PATH', path.dirname(this.paths.headroomBinPath) + path.delimiter);
    }

    const managedKeys = ['ANTHROPIC_BASE_URL', 'HEADROOM_OUTPUT_SHAPER', 'ANTHROPIC_CUSTOM_HEADERS'];

    if (!config.headroomEnabled()) {
      await clearProjectEnv(managedKeys);
      return;
    }

    const slug = projectSlug();
    const base = config.headroomMode() === 'local' ? this.localBaseUrl() : config.headroomRemoteUrl().replace(/\/$/, '');
    if (!base) {
      await clearProjectEnv(managedKeys);
      return;
    }

    const baseUrl = `${base}/p/${slug}`;
    collection.replace('ANTHROPIC_BASE_URL', baseUrl);

    const vars: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
    const staleKeys: string[] = [];

    if (config.headroomMode() === 'local') {
      vars.HEADROOM_OUTPUT_SHAPER = '1';
      staleKeys.push('ANTHROPIC_CUSTOM_HEADERS');
    } else {
      staleKeys.push('HEADROOM_OUTPUT_SHAPER');
      const proxyToken = config.headroomProxyToken();
      if (proxyToken) {
        const customHeaders = `X-Headroom-Proxy-Token: ${proxyToken}`;
        collection.replace('ANTHROPIC_CUSTOM_HEADERS', customHeaders);
        vars.ANTHROPIC_CUSTOM_HEADERS = customHeaders;
      } else {
        staleKeys.push('ANTHROPIC_CUSTOM_HEADERS');
      }
    }

    await applyProjectEnv(vars);
    if (staleKeys.length) await clearProjectEnv(staleKeys);
  }

  /**
   * Singleton spawn: reuse an already-healthy daemon, or spawn one detached and record its PID.
   * `forceRestart` kills a healthy-but-stale daemon first — used after an actual Headroom upgrade,
   * since the running process is still the old binary until restarted.
   */
  async ensureRunning(headroomBinPath: string, opts: { forceRestart?: boolean } = {}): Promise<void> {
    this.headroomBinPath = headroomBinPath;
    if (config.headroomMode() !== 'local') return;

    const healthy = await checkHealth(this.localBaseUrl());
    if (healthy && !opts.forceRestart) return;
    if (healthy && opts.forceRestart) {
      await this.stop();
      await this.waitUntilStopped();
    }

    await fs.mkdir(this.paths.root, { recursive: true });
    const port = config.headroomLocalPort();
    const log = await fs.open(this.paths.proxyLogFile, 'a');
    const child = spawn(headroomBinPath, ['proxy', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      // Required for `headroom learn --verbosity` to have anything to measure — see runHeadroomLearn.
      env: { ...process.env, HEADROOM_OUTPUT_SHAPER: '1' },
    });
    child.unref();
    // The child dup'd the fd on spawn; the parent's handle can (and must) be closed independently.
    await log.close();

    if (child.pid) {
      const lock: ProxyLock = { pid: child.pid, port };
      await fs.writeFile(this.paths.proxyLockFile, JSON.stringify(lock), 'utf8');
    }
  }

  /**
   * Bounded poll after `stop()` — reduces (doesn't eliminate) the race where the old process hasn't
   * released the port yet when we try to spawn the new one.
   */
  private async waitUntilStopped(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await checkHealth(this.localBaseUrl()))) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Watchdog tick: re-checks health and respawns via ensureRunning if the daemon died mid-session. */
  private async watchdog(): Promise<void> {
    if (!this.headroomBinPath) return;
    await this.ensureRunning(this.headroomBinPath);
  }

  /** Manual escape hatch (`easy-headroom.stopProxy`) — kills the shared daemon unconditionally. */
  async stop(): Promise<void> {
    const lock = await this.readLock();
    if (lock) {
      killPid(lock.pid);
      await fs.rm(this.paths.proxyLockFile, { force: true });
    }
  }

  private async readLock(): Promise<ProxyLock | undefined> {
    try {
      const raw = await fs.readFile(this.paths.proxyLockFile, 'utf8');
      return JSON.parse(raw) as ProxyLock;
    } catch {
      return undefined;
    }
  }

  private heartbeatFile(): string {
    return path.join(this.paths.proxyClientsDir, `${this.windowId}.heartbeat`);
  }

  private async writeHeartbeat(): Promise<void> {
    await fs.mkdir(this.paths.proxyClientsDir, { recursive: true });
    await fs.writeFile(this.heartbeatFile(), String(Date.now()), 'utf8');
  }

  private async reap(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.paths.proxyClientsDir);
    } catch {
      return;
    }

    const now = Date.now();
    let liveWindows = 0;
    for (const entry of entries) {
      const full = path.join(this.paths.proxyClientsDir, entry);
      try {
        const raw = await fs.readFile(full, 'utf8');
        const ts = Number(raw);
        if (Number.isFinite(ts) && now - ts <= HEARTBEAT_STALE_MS) {
          liveWindows += 1;
        } else {
          await fs.rm(full, { force: true });
        }
      } catch {
        await fs.rm(full, { force: true });
      }
    }

    if (liveWindows === 0) {
      const lock = await this.readLock();
      if (lock) {
        killPid(lock.pid);
        await fs.rm(this.paths.proxyLockFile, { force: true });
      }
    }
  }

  startLifecycleTimers(): void {
    void this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.reaperTimer = setInterval(() => void this.reap(), REAPER_INTERVAL_MS);
    this.watchdogTimer = setInterval(() => void this.watchdog(), WATCHDOG_INTERVAL_MS);
  }

  /** Best-effort on deactivate — correctness must not depend on this firing (see CLAUDE.md). */
  async dispose(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    await fs.rm(this.heartbeatFile(), { force: true }).catch(() => undefined);
  }
}
