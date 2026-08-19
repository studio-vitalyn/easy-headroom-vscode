import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Every project this extension has written per-project state into (`.claude/settings.local.json`'s
 * env block, `.git/hooks/*`), recorded so the full cleanup can reach all of them rather than only
 * the window it happens to be invoked from. Without this, uninstalling from project B silently
 * leaves project A pointed at a proxy and syncing an index that no longer exists.
 *
 * Deliberately a plain JSON list in `globalStorageUri` rather than `context.globalState`: it holds
 * nothing but paths, and being readable/inspectable on disk matches how the rest of this
 * extension's own state (version markers, proxy lock) is stored.
 */
const FILE_NAME = 'touched-projects.json';

function registryPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, FILE_NAME);
}

export async function listTouchedProjects(context: vscode.ExtensionContext): Promise<string[]> {
  try {
    const raw = await fs.readFile(registryPath(context), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Called on every activation — idempotent, and a failure here must never break setup. */
export async function recordTouchedProject(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  const known = await listTouchedProjects(context);
  if (known.includes(root)) return;

  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  await fs.writeFile(registryPath(context), JSON.stringify([...known, root], null, 2), 'utf8');
}

export async function clearTouchedProjects(context: vscode.ExtensionContext): Promise<void> {
  await fs.rm(registryPath(context), { force: true });
}
