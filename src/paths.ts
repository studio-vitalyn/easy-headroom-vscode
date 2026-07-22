import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Confirmed against a real `rtk init --global --gemini --dry-run`: patches this exact path. */
export function geminiSettingsPath(): string {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Codex CLI's RTK integration is prompt-level only (AGENTS.md + RTK.md), not a JSON hooks file —
 * see rtkAgents.ts. Confirmed via `rtk init --help`: `-g --codex` targets `$CODEX_HOME/AGENTS.md`,
 * falling back to `~/.codex/` when unset.
 */
export function codexAgentsMdPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'AGENTS.md');
}

/**
 * Project-local, machine-specific overrides Claude Code itself reads (its own `env` block) —
 * distinct from `claudeSettingsPath()` (global `~/.claude/settings.json`). Conventionally
 * gitignored, so per-project/per-machine values (like a local proxy port) belong here rather than
 * in the shared, committed `.claude/settings.json`. Undefined if no workspace folder is open.
 */
export function projectClaudeSettingsLocalPath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return path.join(folder.uri.fsPath, '.claude', 'settings.local.json');
}

export function rtkHistoryDbPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'rtk', 'history.db');
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'rtk', 'history.db');
  }
  return path.join(os.homedir(), '.local', 'share', 'rtk', 'history.db');
}

/**
 * Deliberately kept next to history.db, not in `context.globalStorageUri` — under Remote-SSH,
 * globalStorage lives inside `.vscode-server`, which gets wiped by a `.vscode-server` reset,
 * while `~/.local/share/rtk/` doesn't. Also needs to be readable/writable independently of the
 * extension host process, matching the existing fs.watch-on-the-db hook model in rtkReporting.ts.
 */
export function rtkInstanceIdPath(): string {
  return path.join(path.dirname(rtkHistoryDbPath()), '.easy-headroom-instance-id');
}

/** Same rationale as `rtkInstanceIdPath` — see rtkSyncState.ts. */
export function rtkLastPushedIdPath(): string {
  return path.join(path.dirname(rtkHistoryDbPath()), '.easy-headroom-last-pushed-id');
}

export function storagePaths(context: vscode.ExtensionContext) {
  const root = context.globalStorageUri.fsPath;
  return {
    root,
    rtkBinDir: path.join(root, 'rtk-bin'),
    rtkBinPath: path.join(root, 'rtk-bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk'),
    headroomVenvDir: path.join(root, 'headroom-venv'),
    headroomBinPath: path.join(
      root,
      'headroom-venv',
      process.platform === 'win32' ? path.join('Scripts', 'headroom.exe') : path.join('bin', 'headroom')
    ),
    proxyLockFile: path.join(root, 'proxy.lock.json'),
    proxyLogFile: path.join(root, 'proxy.log'),
    proxyClientsDir: path.join(root, 'proxy-clients'),
    headroomVersionFile: path.join(root, 'headroom-version.json'),
  };
}
