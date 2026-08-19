import * as path from 'path';
import { constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { findOnPath } from './archive';

/**
 * Locating a Claude Code client on this machine — the one thing Headroom's routing is useless
 * without, since `ANTHROPIC_BASE_URL` only redirects a client that exists.
 *
 * Two installs count, and they are not interchangeable:
 * - a `claude` on the PATH (the npm/native CLI install);
 * - the official VS Code extension, which **ships the very same CLI** inside its own directory
 *   (`resources/native-binary/claude`, a ~330 MB standalone ELF/Mach-O/PE — confirmed by running
 *   `--version` on it: it reports the extension's own version, e.g. `2.1.234 (Claude Code)`) but
 *   never exposes it on the PATH.
 *
 * That second case is now the *default* for most users: the extension is a one-click install, the
 * CLI is not, so assuming a `claude` on the PATH silently breaks setup for the majority.
 */

export type ClaudeSource = 'path' | 'extension';

export interface ClaudeClient {
  binPath: string;
  /** `path` = the user's own CLI install; `extension` = the copy bundled in the VS Code extension. */
  source: ClaudeSource;
}

/** `vscode.extensions.getExtension` matches this case-insensitively — publisher `Anthropic`, name `claude-code`. */
const CLAUDE_EXTENSION_ID = 'Anthropic.claude-code';

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH first, deliberately: a CLI the user installed themselves is the one they maintain and
 * update, and it keeps working outside VS Code — the extension's copy is pinned to whatever
 * extension version is currently active and disappears when they uninstall it. Same
 * prefer-the-user's-own-install rule `ensureRtkInstalled`/`ensureTokensaveInstalled` already apply.
 *
 * Only the *active* extension version is considered: `getExtension()` resolves that for us, which
 * globbing `~/.vscode/extensions/anthropic.claude-code-*` would not — several versions commonly sit
 * side by side on disk, each with its own copy of the binary.
 */
export async function findClaudeClient(): Promise<ClaudeClient | undefined> {
  const onPath = await findOnPath('claude');
  if (onPath) return { binPath: onPath, source: 'path' };

  const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!extension) return undefined;

  const bundled = path.join(
    extension.extensionPath,
    'resources',
    'native-binary',
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  );
  return (await isExecutable(bundled)) ? { binPath: bundled, source: 'extension' } : undefined;
}
