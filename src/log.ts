import * as vscode from 'vscode';

// Persistent record of setup steps — activation can fire several toasts back to back
// (RTK/Headroom/TokenSave), so a missed notification shouldn't be the only way to see why
// something failed.
export const outputChannel = vscode.window.createOutputChannel('easy-headroom');

export function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
