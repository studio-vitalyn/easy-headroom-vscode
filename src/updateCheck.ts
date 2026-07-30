import * as vscode from 'vscode';
import { config } from './config';
import { ProxyDaemonManager } from './daemon';
import { ensureHeadroomInstalled, ensureHeadroomWrapped, ensureHeadroomMcpInstalled, runHeadroomLearn } from './headroom';
import { ensureTokensaveInstalled, ensureTokensaveMcpInstalled } from './tokensave';
import { formatError } from './errors';
import { log } from './log';

// Same 24h marker-file gate `ensureTokensaveInstalled`/`ensureHeadroomInstalled` already apply
// internally — this only has to tick more often than a VS Code window typically stays open
// uninterrupted, since `activate()` runs that version check exactly once per window/reload. Each
// `ensure*` call is a cheap no-op past its own marker unless 24h have actually elapsed, so ticking
// hourly costs almost nothing on the 23 misses out of 24.
const TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Periodic re-check for newer TokenSave/Headroom releases, independent of activation.
 * `ensureTokensaveInstalled`/`ensureHeadroomInstalled` are otherwise only invoked once, at
 * `activate()` — a long-lived window (left open for days, no reload) would never pick up a newer
 * release even though their own version marker allows a recheck every 24h, since nothing was
 * re-triggering that check. This timer is that trigger; RTK is unaffected/not included here since
 * its own install always re-resolves "latest" on every activation already (see CLAUDE.md's "RTK
 * install — static binary").
 */
export class UpdateCheckTimer {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemon: ProxyDaemonManager,
    private readonly rtkBinPath: string | undefined,
    private readonly onChange: () => void
  ) {}

  private async tick(): Promise<void> {
    try {
      const tokensaveBinPath = await ensureTokensaveInstalled(this.context);
      if (tokensaveBinPath) {
        await ensureTokensaveMcpInstalled(tokensaveBinPath);
      }
    } catch (err) {
      log(`TokenSave update check failed — ${formatError(err)}`);
    }

    if (config.headroomEnabled() && config.mode() === 'local') {
      try {
        const headroom = await ensureHeadroomInstalled(this.context);
        if (headroom?.updated) {
          log(`Headroom upgraded — restarting the proxy daemon`);
          await ensureHeadroomWrapped(headroom.binPath);
          await ensureHeadroomMcpInstalled(headroom.binPath);
          await this.daemon.ensureRunning(headroom.binPath, { forceRestart: true });
          if (config.rtkEnabled() && this.rtkBinPath) {
            void runHeadroomLearn(headroom.binPath).catch(() => undefined);
          }
        }
      } catch (err) {
        log(`Headroom update check failed — ${formatError(err)}`);
      }
    }

    this.onChange();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
