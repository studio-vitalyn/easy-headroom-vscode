import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { storagePaths } from './paths';
import { latestRelease, RTK_REPO, TOKENSAVE_REPO } from './versions';
import { formatError } from './errors';
import { log } from './log';

export type ToolId = 'rtk' | 'tokensave';

interface ToolSpec {
  repo: string;
  /** The tool's own self-updater, when it has one. */
  upgradeCommand?: string;
}

const TOOLS: Record<ToolId, ToolSpec> = {
  // RTK has no update/upgrade subcommand (checked against `rtk --help`), so its notice can only
  // point at the releases page — there is nothing to copy that would do the job.
  rtk: { repo: RTK_REPO },
  tokensave: { repo: TOKENSAVE_REPO, upgradeCommand: 'tokensave upgrade' },
};

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
 * Once per (tool, version) for the lifetime of the install — a nag that reappears on every window
 * reload is one people learn to dismiss without reading. Deliberately does *not* run the upgrade
 * itself, even behind a click: this binary is the user's, not ours (see "Prefer an existing system
 * install" in CLAUDE.md), and for TokenSave it is also the live MCP server, so swapping it out from
 * under a running session is the extension's call to make least of all. The command goes to the
 * clipboard instead, to be run where the user can see it fail.
 */
async function notifyOnce(context: vscode.ExtensionContext, notice: UpdateNotice): Promise<void> {
  if (context.globalState.get<string>(NOTIFIED_KEY(notice.tool)) === notice.latest) return;
  await context.globalState.update(NOTIFIED_KEY(notice.tool), notice.latest);

  const actions = notice.upgradeCommand ? ['Copy upgrade command', 'Release notes'] : ['Release notes'];
  const choice = await vscode.window.showInformationMessage(
    `easy-headroom: ${notice.tool} ${notice.current} is installed on this machine — ${notice.latest} is available. ` +
      `The extension uses your own install and never upgrades it for you.`,
    ...actions
  );
  if (choice === 'Copy upgrade command' && notice.upgradeCommand) {
    await vscode.env.clipboard.writeText(notice.upgradeCommand);
    void vscode.window.showInformationMessage(`Copied: ${notice.upgradeCommand}`);
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
  bins: Partial<Record<ToolId, string | undefined>>
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
        upgradeCommand: TOOLS[tool].upgradeCommand,
        releasesUrl: `https://github.com/${TOOLS[tool].repo}/releases`,
      };
      notices.set(tool, notice);
      log(`System ${tool} at ${binPath} is ${current}; ${notice.latest} is available`);
      await notifyOnce(context, notice);
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
