import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { config } from './config';
import { storagePaths } from './paths';
import { isHeadroomWrapped } from './claudeSettings';
import { listHeadroomReleases } from './versions';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function run(bin: string, args: string[]): Promise<{ code: number | null }> {
  return runCapture(bin, args).then(({ code }) => ({ code }));
}

function runCapture(bin: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ code, stdout });
      } else {
        // Some CLIs (headroom's included) print their actual error to stdout rather than
        // stderr, so both must be captured or the failure surfaces as a bare exit code.
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ');
        reject(new Error(`${bin} ${args.join(' ')} exited ${code}${output ? `: ${output}` : ''}`));
      }
    });
  });
}

async function commandWorks(bin: string, args: string[]): Promise<boolean> {
  try {
    const { code } = await run(bin, args);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Windows: `python` may be the Microsoft Store "App Execution Alias" stub, which exits successfully
 * but never actually runs Python — `py -3` (the official launcher) is unaffected by that stub.
 */
async function isWindowsStorePythonStub(bin: string): Promise<boolean> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['-c', 'import sys; print(sys.executable)']);
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', reject);
      child.on('exit', () => resolve(out));
    });
    return output.toLowerCase().includes('windowsapps');
  } catch {
    return true;
  }
}

const MIN_PYTHON: [number, number] = [3, 10];

/** headroom-ai ships cp310-abi3 wheels only — reject anything below 3.10 rather than trust `--version` exiting 0. */
async function pythonVersionAtLeastMin(bin: string): Promise<boolean> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
    });
    const [major, minor] = output.split('.').map(Number);
    return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
  } catch {
    return false;
  }
}

async function findPythonInterpreter(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    if ((await commandWorks('py', ['-3', '--version'])) && (await pythonVersionAtLeastMin('py -3'))) {
      return 'py -3';
    }
    if (
      (await commandWorks('python', ['--version'])) &&
      !(await isWindowsStorePythonStub('python')) &&
      (await pythonVersionAtLeastMin('python'))
    ) {
      return 'python';
    }
    return undefined;
  }
  // A bare `python3` on PATH isn't reliably >=3.10 — e.g. an old system stub can shadow a
  // perfectly good python3.1x installed alongside it. Try newest-first versioned binaries too.
  const candidates = ['python3', 'python3.13', 'python3.12', 'python3.11', 'python3.10'];
  for (const candidate of candidates) {
    if (await pythonVersionAtLeastMin(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function splitInterpreter(interpreter: string): { bin: string; args: string[] } {
  const [bin, ...args] = interpreter.split(' ');
  return { bin, args };
}

async function createVenv(interpreter: string, venvDir: string): Promise<void> {
  const { bin, args } = splitInterpreter(interpreter);
  await run(bin, [...args, '-m', 'venv', venvDir]);
}

function venvPip(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip');
}

export interface HeadroomInstallResult {
  binPath: string;
  /** True if this call actually (re)installed the package — callers should force-restart the shared daemon. */
  updated: boolean;
}

interface VersionMarker {
  installedVersion: string;
  lastCheckedAt: number;
}

// Unpinned mode re-checks PyPI for a newer release at most this often, to avoid a network
// round-trip on every single activation.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function readVersionMarker(file: string): Promise<VersionMarker | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as VersionMarker;
  } catch {
    return undefined;
  }
}

async function writeVersionMarker(file: string, marker: VersionMarker): Promise<void> {
  await fs.writeFile(file, JSON.stringify(marker), 'utf8');
}

/** Ground truth for "what's actually installed" — the requested spec string isn't proof of the outcome. */
async function installedHeadroomVersion(venvDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await runCapture(venvPip(venvDir), ['show', 'headroom-ai']);
    const match = stdout.match(/^Version:\s*(\S+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Installs Headroom into one venv per host (`<globalStorage>/headroom-venv`), shared across all
 * projects — see "Headroom install — Python venv, not a binary" in CLAUDE.md for why this isn't
 * per-project. Returns undefined (with a warning surfaced by the caller) if no Python is found.
 */
export async function ensureHeadroomInstalled(
  context: vscode.ExtensionContext
): Promise<HeadroomInstallResult | undefined> {
  if (!config.headroomEnabled() || config.headroomMode() !== 'local') return undefined;

  const paths = storagePaths(context);
  const pinned = config.headroomPinnedVersion();
  const alreadyInstalled = await pathExists(paths.headroomBinPath);

  if (alreadyInstalled) {
    const marker = await readVersionMarker(paths.headroomVersionFile);

    if (pinned) {
      if (marker?.installedVersion === pinned) {
        return { binPath: paths.headroomBinPath, updated: false };
      }
      // Pinned to a version we're not currently on — fall through and (re)install.
    } else {
      const checkedRecently = marker && Date.now() - marker.lastCheckedAt < CHECK_INTERVAL_MS;
      if (checkedRecently) {
        return { binPath: paths.headroomBinPath, updated: false };
      }

      const releases = await listHeadroomReleases();
      const latest = releases[0];
      if (!latest || latest === marker?.installedVersion) {
        await writeVersionMarker(paths.headroomVersionFile, {
          installedVersion: marker?.installedVersion ?? '',
          lastCheckedAt: Date.now(),
        });
        return { binPath: paths.headroomBinPath, updated: false };
      }
      // A newer release exists — fall through and upgrade.
    }
  }

  const interpreter = await findPythonInterpreter();
  if (!interpreter) {
    return undefined;
  }

  if (!alreadyInstalled) {
    await createVenv(interpreter, paths.headroomVenvDir);
  }

  const packageSpec = pinned ? `headroom-ai[proxy,code]==${pinned}` : 'headroom-ai[proxy,code]';
  await run(venvPip(paths.headroomVenvDir), ['install', '--upgrade', packageSpec]);

  if (!(await pathExists(paths.headroomBinPath))) {
    throw new Error('Headroom install completed but the executable was not found in the venv');
  }

  const version = await installedHeadroomVersion(paths.headroomVenvDir);
  await writeVersionMarker(paths.headroomVersionFile, {
    installedVersion: version ?? pinned ?? '',
    lastCheckedAt: Date.now(),
  });

  return { binPath: paths.headroomBinPath, updated: true };
}

/** Idempotent: only runs `headroom wrap claude` if ~/.claude/settings.json doesn't already reference it. */
export async function ensureHeadroomWrapped(headroomBinPath: string): Promise<void> {
  if (await isHeadroomWrapped()) return;
  await run(headroomBinPath, ['wrap', 'claude']);
}

/**
 * `headroom learn --verbosity --apply` seeds the output shaper's savings baseline from behavioral
 * signals (interrupts, fast-skips) — the other half of "start measuring" alongside
 * HEADROOM_OUTPUT_SHAPER=1 on the proxy (see ProxyDaemonManager.ensureRunning). Re-run on every
 * activation rather than gated behind an idempotency check: --verbosity is heuristic-only (no LLM
 * call, no --llm-judge), so it's cheap, and re-applying just refreshes the learned level over time.
 */
export async function runHeadroomLearn(headroomBinPath: string): Promise<void> {
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const args = ['learn', '--verbosity', '--apply', ...(projectPath ? ['--project', projectPath] : [])];
  await run(headroomBinPath, args);
}

/**
 * `headroom mcp install --proxy-url <url>` registers the Headroom MCP server for every agent it
 * detects on the host (Claude Code, Codex, ...). No `--force` here deliberately: the command is
 * already non-destructive on its own — if an existing registration differs (e.g. a stale venv path
 * from a prior manual setup), it only warns and prints the `--force` suggestion rather than
 * overwriting, so there's no local diff-checking to duplicate on our side.
 */
export async function ensureHeadroomMcpInstalled(headroomBinPath: string): Promise<void> {
  const proxyUrl = `http://127.0.0.1:${config.headroomLocalPort()}`;
  await run(headroomBinPath, ['mcp', 'install', '--proxy-url', proxyUrl]);
}
