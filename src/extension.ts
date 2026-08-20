import * as vscode from 'vscode';
import { config } from './config';
import { ensureRtkInstalled, ensureRtkInitialized, RtkInitFailure } from './rtk';
import { ensureHeadroomInstalled, ensureHeadroomMcpInstalled, runHeadroomLearn } from './headroom';
import {
  ensureTokensaveInstalled,
  ensureTokensaveMcpInstalled,
  ensureTokensaveIndexed,
  installTokensaveGitHooks,
  TokensaveSyncTimer,
  TokensaveIndexFailure,
} from './tokensave';
import { ProxyDaemonManager } from './daemon';
import { findClaudeClient } from './claudeBinary';
import { ActivationIndicator, HeadroomStatusBar } from './statusBar';
import { RtkReportingWatcher } from './rtkReporting';
import { TokensaveReportingWatcher } from './tokensaveReporting';
import { UpdateCheckTimer } from './updateCheck';
import { EXTENSION_VERSION } from './buildInfo';
import { registerCommands } from './commands';
import { recordTouchedProject } from './projects';
import { checkSystemBinaries } from './systemUpdates';
import { formatError } from './errors';
import { outputChannel, log } from './log';

let daemon: ProxyDaemonManager | undefined;
let statusBar: HeadroomStatusBar | undefined;
let reportingWatcher: RtkReportingWatcher | undefined;
let tokensaveReportingWatcher: TokensaveReportingWatcher | undefined;
let tokensaveSyncTimer: TokensaveSyncTimer | undefined;
let updateCheckTimer: UpdateCheckTimer | undefined;
let activationIndicator: ActivationIndicator | undefined;

/** Serializes setup runs — see `runSetup`. */
let setupInFlight: Promise<void> | undefined;
/** The daemon's heartbeat/reaper/watchdog intervals are started once per window, not per setup. */
let lifecycleStarted = false;
/** The disposal hooks below belong to module state, so they're registered once, not per setup. */
let disposablesRegistered = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(outputChannel);
  const proxy = new ProxyDaemonManager(context);
  daemon = proxy;
  registerCommands(context, proxy, () => runSetup(context, proxy, { rerun: true }));

  await runSetup(context, proxy);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('easy-headroom')) {
        void daemon?.applyEnvironment();
      }
    })
  );
}

/**
 * Everything an activation does beyond creating the daemon and registering commands. Split out of
 * `activate()` so `easy-headroom.rerunSetup` can replay it in place: "Unwrap all" is a reset rather
 * than an off switch, and re-wrapping otherwise meant reloading the window. Every step is
 * idempotent — the installers check what is already on disk, the MCP registrations and git hooks
 * are rewritten in place, and `applyEnvironment` clears its collection before rebuilding it — so a
 * re-run is safe at any point, whether after a cleanup or after a step that failed.
 *
 * Concurrent runs would race on the same install directories, so a second caller joins the run
 * already in flight instead of starting its own.
 */
function runSetup(
  context: vscode.ExtensionContext,
  proxy: ProxyDaemonManager,
  opts: { rerun?: boolean } = {}
): Promise<void> {
  if (setupInFlight) return setupInFlight;
  const run = doSetup(context, proxy, opts).finally(() => {
    setupInFlight = undefined;
  });
  setupInFlight = run;
  return run;
}

async function doSetup(
  context: vscode.ExtensionContext,
  proxy: ProxyDaemonManager,
  opts: { rerun?: boolean }
): Promise<void> {
  if (opts.rerun) log('Re-running setup');

  if (!disposablesRegistered) {
    disposablesRegistered = true;
    context.subscriptions.push({ dispose: () => disposeSetupState() });
  }

  // Torn down before rather than after the work below: these all poll or watch on a timer, and a
  // re-run replaces every one of them. On the first run they are all undefined.
  disposeSetupState();

  // The full cleanup has to reach every project this extension ever wrote hooks or env into, not
  // just the one open right now — nothing else records that, and a failure here must never take
  // setup down with it.
  void recordTouchedProject(context).catch((err) => log(`Could not record this project: ${formatError(err)}`));

  // Runs for the whole setup below — see ActivationIndicator for why it exists. Held in module
  // state rather than a local so `disposeSetupState` owns it too: a throw anywhere in setup would
  // otherwise leave it spinning until the window is reloaded.
  activationIndicator = new ActivationIndicator();
  activationIndicator.start();

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
      }
    }
  } catch (err) {
    log(`RTK setup failed — ${formatError(err)}`);
    void vscode.window.showErrorMessage(`easy-headroom: RTK setup failed — ${formatError(err)}`);
  }

  if (config.headroomEnabled()) {
    // Headroom can only ever *redirect* an existing Claude Code client — ANTHROPIC_BASE_URL routes
    // nothing if there is nothing to route. Checked before the mode split (remote gets the same env
    // block) and outside the try below, since nothing else in the setup depends on it.
    const claudeClient = await findClaudeClient();
    if (claudeClient) {
      log(
        `Claude Code client: ${claudeClient.binPath} (${
          claudeClient.source === 'path' ? 'on the PATH' : 'bundled with the VS Code extension'
        })`
      );
    } else {
      log('No Claude Code client found — neither `claude` on the PATH nor the Claude Code VS Code extension');
      void vscode.window.showWarningMessage(
        'easy-headroom: no Claude Code client found — install the Claude Code extension (or the `claude` CLI) for Headroom routing to have any effect.'
      );
    }

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
          await ensureHeadroomMcpInstalled(headroom.binPath);
          await proxy.ensureRunning(headroom.binPath, { forceRestart: headroom.updated });

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

      if (config.tokensaveIngestEndpoint()) {
        tokensaveReportingWatcher = new TokensaveReportingWatcher();
        tokensaveReportingWatcher.start();
      }
    }
  } catch (err) {
    log(`TokenSave setup failed — ${formatError(err)}`);
    void vscode.window.showErrorMessage(`easy-headroom: TokenSave setup failed — ${formatError(err)}`);
  }

  await proxy.applyEnvironment();
  if (!lifecycleStarted) {
    proxy.startLifecycleTimers();
    lifecycleStarted = true;
  }

  // Hands over to the steady-state item only once the animation has had its minimum run — avoids
  // both a flicker on a fully-cached setup and the two items showing side by side.
  await activationIndicator.finish();
  activationIndicator = undefined;

  statusBar = new HeadroomStatusBar(
    context,
    rtkBinPath,
    rtkFailures,
    EXTENSION_VERSION,
    tokensaveIndexFailures,
    tokensaveBinPath
  );
  statusBar.start();

  // Fire-and-forget: a staleness hint must never sit in front of a window finishing activation.
  // Only reports on binaries we deferred to rather than installed — see `checkSystemBinaries`.
  void checkSystemBinaries(context, { rtk: rtkBinPath, tokensave: tokensaveBinPath })
    .then(() => statusBar?.refresh())
    .catch((err) => log(`System update check failed — ${formatError(err)}`));

  updateCheckTimer = new UpdateCheckTimer(context, proxy, rtkBinPath, () => void statusBar?.refresh());
  updateCheckTimer.start();

  if (opts.rerun) {
    log('Setup re-run finished');
    // Neither of these can be applied to a session that already exists: an open terminal keeps the
    // environment it was spawned with, and a running Claude Code session connects its MCP clients
    // at start. Saying so here is the whole point of the command — otherwise a re-run looks like it
    // did nothing (see the 0.6.1 report of "j'ai beau reload, le MCP semble mal reconnecté").
    void vscode.window
      .showInformationMessage(
        'easy-headroom: setup re-run. Open a new terminal for the PATH, and start a new Claude Code session for the MCP registrations.',
        'Show Log'
      )
      .then((choice) => {
        if (choice === 'Show Log') outputChannel.show(true);
      });
  }
}

/** Everything a setup run owns and a re-run replaces. Safe to call when nothing is set up yet. */
function disposeSetupState(): void {
  activationIndicator?.dispose();
  activationIndicator = undefined;
  statusBar?.dispose();
  statusBar = undefined;
  reportingWatcher?.dispose();
  reportingWatcher = undefined;
  tokensaveReportingWatcher?.dispose();
  tokensaveReportingWatcher = undefined;
  tokensaveSyncTimer?.dispose();
  tokensaveSyncTimer = undefined;
  updateCheckTimer?.dispose();
  updateCheckTimer = undefined;
}

export async function deactivate(): Promise<void> {
  await daemon?.dispose();
}
