import * as vscode from 'vscode';
import { config } from './config';
import { ensureRtkInstalled, ensureRtkInitialized, RtkInitFailure } from './rtk';
import {
  ensureHeadroomInstalled,
  ensureHeadroomWrapped,
  ensureHeadroomMcpInstalled,
  runHeadroomLearn,
} from './headroom';
import {
  ensureTokensaveInstalled,
  ensureTokensaveMcpInstalled,
  ensureTokensaveIndexed,
  installTokensaveGitHooks,
  TokensaveSyncTimer,
} from './tokensave';
import { ProxyDaemonManager } from './daemon';
import { HeadroomStatusBar } from './statusBar';
import { RtkReportingWatcher } from './rtkReporting';
import { registerCommands } from './commands';
import { formatError } from './errors';
import { outputChannel, log } from './log';

let daemon: ProxyDaemonManager | undefined;
let statusBar: HeadroomStatusBar | undefined;
let reportingWatcher: RtkReportingWatcher | undefined;
let tokensaveSyncTimer: TokensaveSyncTimer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(outputChannel);
  daemon = new ProxyDaemonManager(context);
  registerCommands(context, daemon);

  let rtkBinPath: string | undefined;
  let rtkFailures: RtkInitFailure[] = [];
  try {
    rtkBinPath = await ensureRtkInstalled(context);
    log(rtkBinPath ? `RTK ready at ${rtkBinPath}` : 'RTK disabled (easy-headroom.rtk.enabled = false)');
    if (rtkBinPath) {
      rtkFailures = await ensureRtkInitialized(rtkBinPath);
      if (rtkFailures.length > 0) {
        const list = rtkFailures.map((f) => `${f.agent} (${formatError(f.error)})`).join(', ');
        void vscode.window.showWarningMessage(`easy-headroom: RTK setup failed for: ${list}`);
      }
      if (config.rtkIngestEndpoint()) {
        reportingWatcher = new RtkReportingWatcher();
        reportingWatcher.start();
        context.subscriptions.push({ dispose: () => reportingWatcher?.dispose() });
      }
    }
  } catch (err) {
    log(`RTK setup failed — ${formatError(err)}`);
    void vscode.window.showErrorMessage(`easy-headroom: RTK setup failed — ${formatError(err)}`);
  }

  if (config.headroomEnabled()) {
    try {
      if (config.mode() === 'local') {
        const headroom = await ensureHeadroomInstalled(context);
        if (!headroom) {
          log('Headroom setup skipped — no working Python 3.10+ interpreter found');
          void vscode.window.showWarningMessage(
            'easy-headroom: no working Python 3.10+ interpreter found — Headroom setup skipped. RTK is unaffected.'
          );
        } else {
          log(`Headroom ready at ${headroom.binPath}`);
          await ensureHeadroomWrapped(headroom.binPath);
          await ensureHeadroomMcpInstalled(headroom.binPath);
          await daemon.ensureRunning(headroom.binPath, { forceRestart: headroom.updated });

          // "Start measuring": needs RTK active (it's what feeds the behavioral signals) and the
          // local headroom binary (nothing to run this against in remote mode) — best-effort,
          // deliberately silent on failure (see "no popups" in CLAUDE.md; this isn't a setup step
          // the user needs to act on).
          if (config.rtkEnabled() && rtkBinPath) {
            void runHeadroomLearn(headroom.binPath).catch(() => undefined);
          }
        }
      }
    } catch (err) {
      log(`Headroom setup failed — ${formatError(err)}`);
      void vscode.window.showErrorMessage(`easy-headroom: Headroom setup failed — ${formatError(err)}`);
    }
  }

  try {
    const tokensaveBinPath = await ensureTokensaveInstalled(context);
    log(tokensaveBinPath ? `TokenSave ready at ${tokensaveBinPath}` : 'TokenSave disabled (easy-headroom.tokensave.enabled = false)');
    if (tokensaveBinPath) {
      await ensureTokensaveMcpInstalled(tokensaveBinPath);
      const indexFailures = await ensureTokensaveIndexed(tokensaveBinPath);
      if (indexFailures.length > 0) {
        const list = indexFailures.map((f) => `${f.folder} (${formatError(f.error)})`).join(', ');
        log(`TokenSave indexing failed for: ${list}`);
        void vscode.window.showWarningMessage(`easy-headroom: TokenSave indexing failed for: ${list}`);
      }

      try {
        await installTokensaveGitHooks(tokensaveBinPath);
      } catch (err) {
        log(`TokenSave git hook install failed — ${formatError(err)}`);
      }

      tokensaveSyncTimer = new TokensaveSyncTimer(tokensaveBinPath);
      tokensaveSyncTimer.start();
      context.subscriptions.push({ dispose: () => tokensaveSyncTimer?.dispose() });
    }
  } catch (err) {
    log(`TokenSave setup failed — ${formatError(err)}`);
    void vscode.window.showErrorMessage(`easy-headroom: TokenSave setup failed — ${formatError(err)}`);
  }

  await daemon.applyEnvironment();
  daemon.startLifecycleTimers();

  statusBar = new HeadroomStatusBar(rtkBinPath, rtkFailures, context.extension.packageJSON.version);
  statusBar.start();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('easy-headroom')) {
        void daemon?.applyEnvironment();
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  await daemon?.dispose();
}
