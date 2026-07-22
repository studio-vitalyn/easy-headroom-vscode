import * as vscode from 'vscode';
import { config } from './config';

/** Sanitized to lowercase alphanumeric-and-hyphens for use in the `/p/<slug>` URL path. */
export function projectSlug(): string {
  const name =
    config.projectName() || vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || 'default';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}
