import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import * as tar from 'tar';
import { config } from './config';
import { storagePaths } from './paths';
import { pathExists, download, extractZipWindows, findBinaryRecursive, findOnPath } from './archive';

const REPO = 'aovestdipaperino/tokensave';

/**
 * Unlike RTK, tokensave's release asset filenames embed the version
 * (`tokensave-<version>-<arch>-<os>.<ext>`), so there's no stable
 * `releases/latest/download/<asset>` URL to hit blind — the actual latest
 * tag has to be resolved first. Confirmed against the real releases: no
 * x86_64-macos asset is published (arm64 only) — returns undefined there.
 */
function assetName(version: string): { file: string; kind: 'tar.gz' | 'zip' } | undefined {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    if (arch === 'arm64') return { file: `tokensave-${version}-aarch64-macos.tar.gz`, kind: 'tar.gz' };
    return undefined;
  }
  if (platform === 'win32') {
    const a = arch === 'arm64' ? 'aarch64' : 'x86_64';
    return { file: `tokensave-${version}-${a}-windows.zip`, kind: 'zip' };
  }
  // linux
  const a = arch === 'arm64' ? 'aarch64' : 'x86_64';
  return { file: `tokensave-${version}-${a}-linux.tar.gz`, kind: 'tar.gz' };
}

interface GitHubRelease {
  tag_name: string;
}

/** Single call, only made on first install (no binary yet) — same rate-limit budget as the RTK/Headroom pickers. */
async function resolveLatestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to resolve latest tokensave release: HTTP ${res.status}`);
  }
  const release = (await res.json()) as GitHubRelease;
  return release.tag_name;
}

function downloadUrl(version: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${version}/${asset}`;
}

interface VersionMarker {
  installedVersion: string;
  lastCheckedAt: number;
}

// Unpinned mode re-checks GitHub for a newer release at most this often, to avoid a network
// round-trip on every single activation — same interval/rationale as Headroom's own check.
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

/**
 * Asks the binary itself what it is (`tokensave --version` → `tokensave 7.9.0`). Used both to
 * verify a fresh install actually landed and to report a *system* binary's version, which has no
 * marker file of ours to read.
 */
async function readBinaryVersion(binPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runCapture(binPath, ['--version']);
    return stdout.trim().split(/\s+/).pop();
  } catch {
    return undefined;
  }
}

/**
 * For the status bar tooltip — reads the marker written by the last successful install, falling
 * back to asking the binary directly when there is no marker (i.e. we deferred to a system install,
 * see `ensureTokensaveInstalled`).
 */
export async function getInstalledTokensaveVersion(
  context: vscode.ExtensionContext,
  binPath?: string
): Promise<string | undefined> {
  const marker = await readVersionMarker(storagePaths(context).tokensaveVersionFile);
  if (marker?.installedVersion) return marker.installedVersion;
  if (!binPath) return undefined;
  return readBinaryVersion(binPath);
}

async function installVersion(paths: ReturnType<typeof storagePaths>, version: string): Promise<void> {
  const asset = assetName(version);
  if (!asset) {
    throw new Error(`No prebuilt tokensave release for ${process.platform}/${process.arch}`);
  }

  await fs.mkdir(paths.tokensaveBinDir, { recursive: true });
  const url = downloadUrl(version, asset.file);
  const tmpFile = path.join(os.tmpdir(), `easy-headroom-tokensave-${Date.now()}-${asset.file}`);

  try {
    await download(url, tmpFile);

    if (asset.kind === 'tar.gz') {
      await tar.extract({ file: tmpFile, cwd: paths.tokensaveBinDir });
    } else {
      await extractZipWindows(tmpFile, paths.tokensaveBinDir);
    }

    const binaryName = process.platform === 'win32' ? 'tokensave.exe' : 'tokensave';
    const found = await findBinaryRecursive(paths.tokensaveBinDir, binaryName);
    if (!found) {
      throw new Error(`Could not locate '${binaryName}' inside extracted tokensave archive`);
    }
    if (found !== paths.tokensaveBinPath) {
      // Overwrites any previously installed version already at this path.
      await fs.rename(found, paths.tokensaveBinPath);
    }
    if (process.platform !== 'win32') {
      await fs.chmod(paths.tokensaveBinPath, 0o755);
    }
  } finally {
    await fs.rm(tmpFile, { force: true });
  }

  // Verify what actually landed before recording it. The marker drives both the 24h update gate and
  // the status bar's version display, so writing it blind means a failed/partial replacement shows
  // up as a successful upgrade forever after — observed in practice as a marker claiming v7.9.0 next
  // to a binary reporting 7.8.1. Throwing here leaves the marker untouched, so the next activation
  // simply retries instead of believing it is already up to date.
  const actual = await readBinaryVersion(paths.tokensaveBinPath);
  if (actual && actual !== version.replace(/^v/, '')) {
    throw new Error(`tokensave ${version} was installed but the binary reports ${actual}`);
  }

  await writeVersionMarker(paths.tokensaveVersionFile, { installedVersion: version, lastCheckedAt: Date.now() });
}

/**
 * Unpinned mode re-checks GitHub's latest release once per `CHECK_INTERVAL_MS` and upgrades in
 * place if a newer tag exists — same pattern as `ensureHeadroomInstalled`, so a stale TokenSave
 * binary doesn't linger indefinitely just because the presence-check alone used to pass.
 */
export async function ensureTokensaveInstalled(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (!config.tokensaveEnabled()) return undefined;

  const paths = storagePaths(context);
  const pinned = config.tokensavePinnedVersion();

  // Prefer a copy the user already has on their PATH, and drop our own so the two can't coexist —
  // see `findOnPath`. This is the fix for a genuine failure mode, not just tidiness: the MCP
  // registration points at an absolute path while the Claude Code hooks resolve `tokensave` through
  // PATH, so two installs of different versions ended up driving the same `.tokensave/tokensave.db`
  // concurrently. A pinned version is explicit intent to run *that* build, so it keeps our copy.
  if (!pinned) {
    const system = await findOnPath('tokensave', paths.root);
    if (system) {
      await fs.rm(paths.tokensaveBinDir, { recursive: true, force: true });
      await fs.rm(paths.tokensaveVersionFile, { force: true });
      return system;
    }
  }

  const alreadyInstalled = await pathExists(paths.tokensaveBinPath);

  if (alreadyInstalled) {
    const marker = await readVersionMarker(paths.tokensaveVersionFile);

    if (pinned) {
      if (marker?.installedVersion === pinned) {
        return paths.tokensaveBinPath;
      }
      // Pinned to a version we're not currently on — fall through and (re)install.
    } else {
      const checkedRecently = marker && Date.now() - marker.lastCheckedAt < CHECK_INTERVAL_MS;
      if (checkedRecently) {
        return paths.tokensaveBinPath;
      }

      const latest = await resolveLatestVersion();
      if (latest === marker?.installedVersion) {
        await writeVersionMarker(paths.tokensaveVersionFile, {
          installedVersion: marker?.installedVersion ?? '',
          lastCheckedAt: Date.now(),
        });
        return paths.tokensaveBinPath;
      }

      // A newer release exists — upgrade in place.
      await installVersion(paths, latest);
      return paths.tokensaveBinPath;
    }
  }

  const version = pinned || (await resolveLatestVersion());
  await installVersion(paths, version);
  return paths.tokensaveBinPath;
}

export function runCapture(bin: string, args: string[], cwd?: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout });
      } else {
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ');
        reject(new Error(`${bin} ${args.join(' ')} exited ${code}${output ? `: ${output}` : ''}`));
      }
    });
  });
}

/**
 * `tokensave install --agent claude` registers the MCP server in Claude Code's own config
 * (`~/.claude.json`'s `mcpServers`, not a file this extension otherwise touches). Not gated behind
 * our own idempotency check, same rationale as `ensureHeadroomMcpInstalled`: re-running a CLI's own
 * declarative "install" command is what it exists for, so it's as cheap and safe to call on every
 * activation as re-running `rtk init`.
 */
export async function ensureTokensaveMcpInstalled(tokensaveBinPath: string): Promise<void> {
  await runCapture(tokensaveBinPath, ['install', '--agent', 'claude']);
}

export interface TokensaveIndexFailure {
  folder: string;
  error: Error;
}

/**
 * Single local index (`.tokensave/`) at the project root — `init` if it doesn't exist yet, `sync`
 * otherwise. One instance covers the whole project (submodules included, since tokensave walks
 * the directory tree rather than following git boundaries), not one per open workspace folder.
 */
export async function ensureTokensaveIndexed(tokensaveBinPath: string): Promise<TokensaveIndexFailure[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const cwd = folder.uri.fsPath;
  try {
    const initialized = await pathExists(path.join(cwd, '.tokensave'));
    await runCapture(tokensaveBinPath, initialized ? ['sync'] : ['init'], cwd);
  } catch (err) {
    return [{ folder: folder.name, error: err as Error }];
  }
  return [];
}

const HOOK_MARKER = '# easy-headroom: tokensave sync hook';
const HOOKED_GIT_EVENTS = ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite'];

function hookScript(tokensaveBinPath: string, cwd: string): string {
  return [
    '#!/usr/bin/env bash',
    HOOK_MARKER,
    `if [ -e "${cwd}/.tokensave/tokensave.db" ]; then`,
    `  "${tokensaveBinPath}" sync "${cwd}" >/dev/null 2>&1 &`,
    'else',
    `  "${tokensaveBinPath}" init "${cwd}" >/dev/null 2>&1 &`,
    'fi',
    '',
  ].join('\n');
}

/**
 * The root's own `.git` must be a real directory — a submodule working dir has a `.git` *file*
 * instead, pointing at `.git/modules/<name>` in the superproject, and is deliberately left alone.
 */
async function gitHooksDir(root: string): Promise<string | undefined> {
  const gitDir = path.join(root, '.git');
  try {
    const stat = await fs.stat(gitDir);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return path.join(gitDir, 'hooks');
}

/**
 * Best-effort, project-root workspace folder only — the extension has no submodule awareness, so
 * this never walks into subdirectories looking for nested `.git`s. The root folder's own `.git`
 * must be a real directory (a submodule working dir has a `.git` *file* instead, pointing
 * elsewhere) — that case is silently skipped, and `TokensaveSyncTimer` is the fallback. Appends to
 * (never overwrites) an existing hook, guarded by `HOOK_MARKER` so re-running this on every
 * activation doesn't keep duplicating the block.
 */
export async function installTokensaveGitHooks(tokensaveBinPath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const cwd = folder.uri.fsPath;
  const hooksDir = await gitHooksDir(cwd);
  if (!hooksDir) return;
  await fs.mkdir(hooksDir, { recursive: true });
  for (const hookName of HOOKED_GIT_EVENTS) {
    const hookFile = path.join(hooksDir, hookName);
    let existing = '';
    try {
      existing = await fs.readFile(hookFile, 'utf8');
    } catch {
      // no existing hook for this event
    }
    if (existing.includes(HOOK_MARKER)) continue;

    const script = hookScript(tokensaveBinPath, cwd);
    const next = existing ? `${existing.trimEnd()}\n\n${script}` : script;
    await fs.writeFile(hookFile, next, 'utf8');
    await fs.chmod(hookFile, 0o755);
  }
}

/**
 * Counterpart to `installTokensaveGitHooks`, used by the full cleanup — excises only our own
 * marker-guarded block and leaves any hook content the user wrote around it intact. A file that
 * held nothing but our block (shebang included) is deleted outright rather than left as an empty
 * executable git would still run on every commit.
 */
export async function removeTokensaveGitHooks(root: string): Promise<void> {
  const hooksDir = await gitHooksDir(root);
  if (!hooksDir) return;

  for (const hookName of HOOKED_GIT_EVENTS) {
    const hookFile = path.join(hooksDir, hookName);
    let existing: string;
    try {
      existing = await fs.readFile(hookFile, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripHookBlock(existing);
    if (stripped === undefined) continue;

    if (stripped === '' || /^#![^\n]*$/.test(stripped)) {
      await fs.rm(hookFile, { force: true });
    } else {
      await fs.writeFile(hookFile, `${stripped}\n`, 'utf8');
    }
  }
}

/**
 * Returns the file content without our block, or `undefined` if the marker isn't there at all.
 * The block is `[shebang] marker … fi` — bounded by the marker line above and the `if`/`fi` pair
 * `hookScript` emits, so nothing outside it is touched.
 */
function stripHookBlock(content: string): string | undefined {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === HOOK_MARKER);
  if (idx === -1) return undefined;

  let start = idx;
  if (start > 0 && lines[start - 1].startsWith('#!')) start -= 1;

  let end = idx;
  while (end < lines.length && lines[end].trim() !== 'fi') end += 1;
  if (end >= lines.length) end = lines.length - 1;

  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n').trim();
}

const SYNC_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Fallback for changes the root-only git hook can't see — e.g. a commit made inside a submodule
 * (`docker/`, `vscode/`), which never fires the root repo's own hooks even though that content is
 * covered by the single project-root index. Re-runs the same init-or-sync call as activation
 * itself, just on a timer instead of only once per window open.
 */
export class TokensaveSyncTimer {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly tokensaveBinPath: string) {}

  start(): void {
    this.timer = setInterval(() => void ensureTokensaveIndexed(this.tokensaveBinPath), SYNC_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
