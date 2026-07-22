import * as vscode from 'vscode';
import { config } from './config';
import { ensureRtkInstalled, ensureRtkInitialized, RtkInitFailure } from './rtk';
import {
  ensureHeadroomInstalled,
  ensureHeadroomWrapped,
  ensureHeadroomMcpInstalled,
  runHeadroomLearn,
} from './headroom';
import { ProxyDaemonManager } from './daemon';
import { HeadroomStatusBar } from './statusBar';
import { RtkReportingWatcher } from './rtkReporting';
import { registerCommands } from './commands';
import { formatError } from './errors';

let daemon: ProxyDaemonManager | undefined;
let statusBar: HeadroomStatusBar | undefined;
let reportingWatcher: RtkReportingWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  daemon = new ProxyDaemonManager(context);
  registerCommands(context, daemon);

  let rtkBinPath: string | undefined;
  let rtkFailures: RtkInitFailure[] = [];
  try {
    rtkBinPath = await ensureRtkInstalled(context);
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
    void vscode.window.showErrorMessage(`easy-headroom: RTK setup failed — ${formatError(err)}`);
  }

  if (config.headroomEnabled()) {
    try {
      if (config.headroomMode() === 'local') {
        const headroom = await ensureHeadroomInstalled(context);
        if (!headroom) {
          void vscode.window.showWarningMessage(
            'easy-headroom: no working Python 3.10+ interpreter found — Headroom setup skipped. RTK is unaffected.'
          );
        } else {
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
      void vscode.window.showErrorMessage(`easy-headroom: Headroom setup failed — ${formatError(err)}`);
    }
  }

  await daemon.applyEnvironment();
  daemon.startLifecycleTimers();

  statusBar = new HeadroomStatusBar(rtkBinPath, rtkFailures);
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
