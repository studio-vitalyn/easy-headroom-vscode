import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { storagePaths } from './paths';
import { latestRelease, RTK_REPO, TOKENSAVE_REPO } from './versions';
import { formatError } from './errors';
import { log } from './log';

export type ToolId = 'rtk' | 'tokensave';

const TOOLS: Record<ToolId, { repo: string }> = {
  rtk: { repo: RTK_REPO },
  tokensave: { repo: TOKENSAVE_REPO },
};

// RTK's own installer: verifies the archive against the release's checksums.txt, never prompts,
// and takes its target directory from RTK_INSTALL_DIR — so it can overwrite the copy in use in place.
const RTK_INSTALL_SCRIPT = 'https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh';

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * How to upgrade the copy at `binPath`, as a POSIX shell line — or undefined when there's no way we
 * can be confident of. Homebrew is asked to do it when it owns the binary (overwriting a file in its
 * Cellar would leave brew believing in a version that's no longer there). Otherwise TokenSave has
 * its own self-updater, and RTK — which has none (checked against `rtk --help`) — gets its install
 * script pointed at the binary's own directory, provided we can write there.
 */
async function resolveUpgradeCommand(tool: ToolId, binPath: string): Promise<string | undefined> {
  const real = await fs.realpath(binPath).catch(() => binPath);
  if (/[\\/]Cellar[\\/]/.test(real)) return `brew upgrade ${tool}`;
  if (tool === 'tokensave') return `${shQuote(binPath)} upgrade`;
  // The install script is sh-only, and a cargo-built rtk would be replaced by a release build.
  if (process.platform === 'win32' || /[\\/]\.cargo[\\/]bin[\\/]/.test(real)) return undefined;
  const dir = path.dirname(real);
  try {
    await fs.access(dir, fsConstants.W_OK);
  } catch {
    return undefined;
  }
  return `curl -fsSL ${RTK_INSTALL_SCRIPT} | RTK_INSTALL_DIR=${shQuote(dir)} sh`;
}

const changeEmitter = new vscode.EventEmitter<void>();
/** Fires when a notice appears or goes away outside a caller's own await — i.e. after an upgrade. */
export const onDidChangeUpdates = changeEmitter.event;

const upgrading = new Set<ToolId>();

// Same cadence as the marker-file gates in tokensave.ts/headroom.ts, for the same reason: one
// unauthenticated GitHub request per tool per day, whatever a window's reload pattern looks like.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const LATEST_KEY = (tool: ToolId) => `systemUpdate.latest.${tool}`;
const NOTIFIED_KEY = (tool: ToolId) => `systemUpdate.notified.${tool}`;

interface LatestCache {
  latest: string;
  checkedAt: number;
}

export interface UpdateNotice {
  tool: ToolId;
  /** Version the binary on PATH actually reports. */
  current: string;
  latest: string;
  binPath: string;
  upgradeCommand?: string;
  releasesUrl: string;
}

// Last computed state, read synchronously by the status bar tooltip and the Settings tab. Module
// level rather than a field on some owner object because both readers are far from the writer and
// neither should have to await a network check to render.
const notices = new Map<ToolId, UpdateNotice>();

export function knownUpdates(): UpdateNotice[] {
  return [...notices.values()];
}

export function knownUpdate(tool: ToolId): UpdateNotice | undefined {
  return notices.get(tool);
}

/** `<bin> --version` prints `<name> <semver>` for both tools (confirmed empirically). */
function readBinaryVersion(binPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binPath, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? out.trim().match(/(\d+\.\d+\.\d+)/)?.[1] : undefined));
  });
}

function parseVersion(raw: string): number[] | undefined {
  const m = raw.replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * Strictly-older comparison on the numeric triple only. A build with a suffix (`7.9.0-beta.1`)
 * compares equal to its release, which is the conservative choice here: this drives a nag, and
 * telling someone on a prerelease that they're behind the release they're ahead of is worse than
 * staying quiet.
 */
function isOlder(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

async function resolveLatest(context: vscode.ExtensionContext, tool: ToolId): Promise<string | undefined> {
  const cached = context.globalState.get<LatestCache>(LATEST_KEY(tool));
  if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) return cached.latest;

  const latest = await latestRelease(TOOLS[tool].repo);
  if (!latest) return cached?.latest;
  await context.globalState.update(LATEST_KEY(tool), { latest, checkedAt: Date.now() } satisfies LatestCache);
  return latest;
}

/**
 * Runs the upgrade only on an explicit click, and in a visible terminal rather than a hidden spawn:
 * the binary is the user's, not ours (see "Prefer an existing system install" in CLAUDE.md), so a
 * failure must be theirs to read, and `tokensave upgrade` asks before killing the other running
 * tokensave processes — the live MCP server among them — which only a terminal lets them answer.
 * Re-checks the version afterwards, so the notice, the tooltip and the Settings banner clear on
 * their own once it worked.
 */
export async function runSystemUpgrade(context: vscode.ExtensionContext, tool: ToolId): Promise<void> {
  const notice = notices.get(tool);
  if (!notice?.upgradeCommand || upgrading.has(tool)) return;
  upgrading.add(tool);
  try {
    // Pinned to /bin/sh so the quoting in `upgradeCommand` holds whatever the user's own shell is.
    // On Windows (TokenSave only — see resolveUpgradeCommand) the binary is run directly instead.
    const execution =
      process.platform === 'win32'
        ? new vscode.ShellExecution({ value: notice.binPath, quoting: vscode.ShellQuoting.Strong }, ['upgrade'])
        : new vscode.ShellExecution(notice.upgradeCommand, { executable: '/bin/sh', shellArgs: ['-c'] });
    const task = new vscode.Task(
      { type: 'shell', id: `easy-headroom-upgrade-${tool}` },
      vscode.TaskScope.Global,
      `Upgrade ${tool}`,
      'easy-headroom',
      execution
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, panel: vscode.TaskPanelKind.Dedicated };

    const exitCode = await new Promise<number | undefined>((resolve, reject) => {
      let started: vscode.TaskExecution | undefined;
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === started || e.execution.task.definition.id === task.definition.id) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
      vscode.tasks.executeTask(task).then(
        (execution) => (started = execution),
        (err) => {
          sub.dispose();
          reject(err);
        }
      );
    });

    await checkSystemBinaries(context, { [tool]: notice.binPath }, { notify: false });
    changeEmitter.fire();
    const after = notices.get(tool);
    if (exitCode === 0 && !after) {
      void vscode.window.showInformationMessage(
        `easy-headroom: ${tool} upgraded to ${notice.latest}.` +
          (tool === 'tokensave' ? ' Start a new Claude Code session to use it as the MCP server.' : '')
      );
    } else {
      void vscode.window.showWarningMessage(
        `easy-headroom: the ${tool} upgrade didn't complete${exitCode ? ` (exit code ${exitCode})` : ''} — see the "Upgrade ${tool}" terminal.`
      );
    }
  } catch (err) {
    log(`Upgrade of ${tool} failed — ${formatError(err)}`);
    void vscode.window.showErrorMessage(`easy-headroom: could not start the ${tool} upgrade — ${formatError(err)}`);
  } finally {
    upgrading.delete(tool);
  }
}

/**
 * Once per (tool, version) for the lifetime of the install — a nag that reappears on every window
 * reload is one people learn to dismiss without reading. The upgrade itself only ever runs behind
 * the click — see `runSystemUpgrade`.
 */
async function notifyOnce(context: vscode.ExtensionContext, notice: UpdateNotice): Promise<void> {
  if (context.globalState.get<string>(NOTIFIED_KEY(notice.tool)) === notice.latest) return;
  await context.globalState.update(NOTIFIED_KEY(notice.tool), notice.latest);

  const actions = notice.upgradeCommand ? ['Update now', 'Release notes'] : ['Release notes'];
  const choice = await vscode.window.showInformationMessage(
    `easy-headroom: ${notice.tool} ${notice.current} is installed on this machine — ${notice.latest} is available.` +
      (notice.upgradeCommand ? '' : ' This install has to be upgraded by hand.'),
    ...actions
  );
  if (choice === 'Update now') {
    await runSystemUpgrade(context, notice.tool);
  } else if (choice === 'Release notes') {
    void vscode.env.openExternal(vscode.Uri.parse(notice.releasesUrl));
  }
}

/**
 * Staleness check for binaries the extension *didn't* install. Deferring to a system copy
 * (`ensureRtkInstalled`/`ensureTokensaveInstalled`) also hands over responsibility for keeping it
 * current, and nothing was reporting that: an RTK from June sat two minor versions behind for
 * months without a word. Read-only by construction — it runs `--version`, asks GitHub for a tag,
 * and reports the difference.
 */
export async function checkSystemBinaries(
  context: vscode.ExtensionContext,
  bins: Partial<Record<ToolId, string | undefined>>,
  opts: { notify?: boolean } = {}
): Promise<void> {
  const paths = storagePaths(context);
  const ownCopy: Record<ToolId, string> = { rtk: paths.rtkBinPath, tokensave: paths.tokensaveBinPath };

  for (const tool of Object.keys(bins) as ToolId[]) {
    const binPath = bins[tool];
    // Our own copy is upgraded in place by its own install path — nothing to tell the user about.
    if (!binPath || path.resolve(binPath) === path.resolve(ownCopy[tool])) {
      notices.delete(tool);
      continue;
    }

    try {
      const current = await readBinaryVersion(binPath);
      if (!current) {
        log(`Update check skipped for ${tool} — could not read a version out of '${binPath} --version'`);
        continue;
      }
      const latest = await resolveLatest(context, tool);
      if (!latest || !isOlder(current, latest)) {
        notices.delete(tool);
        continue;
      }

      const notice: UpdateNotice = {
        tool,
        current,
        latest: latest.replace(/^v/i, ''),
        binPath,
        upgradeCommand: await resolveUpgradeCommand(tool, binPath),
        releasesUrl: `https://github.com/${TOOLS[tool].repo}/releases`,
      };
      notices.set(tool, notice);
      log(`System ${tool} at ${binPath} is ${current}; ${notice.latest} is available`);
      // Not awaited: the toast stays up until dismissed, and an upgrade behind it takes a while —
      // neither should hold up activation or the update timer's tick.
      if (opts.notify !== false) void notifyOnce(context, notice);
    } catch (err) {
      log(`Update check failed for ${tool} — ${formatError(err)}`);
    }
  }
}

/**
 * Called by the unwrap-all cleanup: the "already told you about 7.9.0" bookkeeping lives in
 * globalState, which survives an uninstall/reinstall. Leaving it behind would silence the first
 * notice of a fresh install for no reason a user could ever guess at.
 */
export async function clearUpdateState(context: vscode.ExtensionContext): Promise<void> {
  notices.clear();
  for (const tool of Object.keys(TOOLS) as ToolId[]) {
    await context.globalState.update(LATEST_KEY(tool), undefined);
    await context.globalState.update(NOTIFIED_KEY(tool), undefined);
  }
}
