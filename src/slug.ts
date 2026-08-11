import * as vscode from 'vscode';
import { config } from './config';

/**
 * Strips VS Code's window decorations from a workspace name: the remote label
 * (`[SSH: dev]`, `[WSL: Ubuntu]`, `[Dev Container]`) and the localized
 * "(Workspace)"/"(Espace de travail)" suffix a multi-root `.code-workspace`
 * gets. Without this, the same project opened over Remote-SSH would attribute
 * its usage to `myproject-ssh-dev` instead of `myproject`.
 */
function undecorate(name: string): string {
  return name.replace(/(\s*[[(][^\])]*[\])])+\s*$/, '').trim();
}

/** Sanitized to lowercase alphanumeric-and-hyphens for use in the `/p/<slug>` URL path. */
export function projectSlug(): string {
  // The root folder's own name first: it's the bare directory basename, never
  // decorated, unlike `workspace.name`.
  const name =
    config.projectName() ||
    vscode.workspace.workspaceFolders?.[0]?.name ||
    (vscode.workspace.name && undecorate(vscode.workspace.name)) ||
    'default';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}
