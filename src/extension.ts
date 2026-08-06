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
  TokensaveIndexFailure,
} from './tokensave';
import { ProxyDaemonManager } from './daemon';
import { ActivationIndicator, HeadroomStatusBar } from './statusBar';
import { RtkReportingWatcher } from './rtkReporting';
import { TokensaveReportingWatcher } from './tokensaveReporting';
import { UpdateCheckTimer } from './updateCheck';
import { registerCommands } from './commands';
import { formatError } from './errors';
import { outputChannel, log } from './log';

let daemon: ProxyDaemonManager | undefined;
let statusBar: HeadroomStatusBar | undefined;
let reportingWatcher: RtkReportingWatcher | undefined;
let tokensaveReportingWatcher: TokensaveReportingWatcher | undefined;
let tokensaveSyncTimer: TokensaveSyncTimer | undefined;
let updateCheckTimer: UpdateCheckTimer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(outputChannel);
  daemon = new ProxyDaemonManager(context);
  registerCommands(context, daemon);

  // Runs for the whole setup below — see ActivationIndicator for why it exists. Registered for
  // disposal too, so a throw anywhere in activate() can't leave it spinning forever.
  const activationIndicator = new ActivationIndicator();
  activationIndicator.start();
  context.subscriptions.push({ dispose: () => activationIndicator.dispose() });

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

  let tokensaveIndexFailures: TokensaveIndexFailure[] = [];
  let tokensaveBinPath: string | undefined;
  try {
    tokensaveBinPath = await ensureTokensaveInstalled(context);
    log(tokensaveBinPath ? `TokenSave ready at ${tokensaveBinPath}` : 'TokenSave disabled (easy-headroom.tokensave.enabled = false)');
    if (tokensaveBinPath) {
      await ensureTokensaveMcpInstalled(tokensaveBinPath);
      tokensaveIndexFailures = await ensureTokensaveIndexed(tokensaveBinPath);
      if (tokensaveIndexFailures.length > 0) {
        const list = tokensaveIndexFailures.map((f) => `${f.folder} (${formatError(f.error)})`).join(', ');
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

      if (config.tokensaveIngestEndpoint()) {
        tokensaveReportingWatcher = new TokensaveReportingWatcher();
        tokensaveReportingWatcher.start();
        context.subscriptions.push({ dispose: () => tokensaveReportingWatcher?.dispose() });
      }
    }
  } catch (err) {
    log(`TokenSave setup failed — ${formatError(err)}`);
    void vscode.window.showErrorMessage(`easy-headroom: TokenSave setup failed — ${formatError(err)}`);
  }

  await daemon.applyEnvironment();
  daemon.startLifecycleTimers();

  // Hands over to the steady-state item only once the animation has had its minimum run — avoids
  // both a flicker on a fully-cached setup and the two items showing side by side.
  await activationIndicator.finish();

  statusBar = new HeadroomStatusBar(
    context,
    rtkBinPath,
    rtkFailures,
    context.extension.packageJSON.version,
    tokensaveIndexFailures,
    tokensaveBinPath
  );
  statusBar.start();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  updateCheckTimer = new UpdateCheckTimer(context, daemon, rtkBinPath, () => void statusBar?.refresh());
  updateCheckTimer.start();
  context.subscriptions.push({ dispose: () => updateCheckTimer?.dispose() });

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
