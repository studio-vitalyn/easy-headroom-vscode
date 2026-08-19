import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import {
  storagePaths,
  rtkInstanceIdPath,
  rtkLastPushedIdPath,
  tokensaveInstanceIdPath,
  tokensaveLastPushedIdPath,
  codexAgentsMdPath,
  geminiSettingsPath,
} from './paths';
import { ProxyDaemonManager } from './daemon';
import { removeGlobalEnv, clearProjectEnv } from './claudeSettings';
import { ALL_AGENTS, removeRtkIntegration } from './rtkAgents';
import { pathExists, findOnPath } from './archive';
import { runCapture, removeTokensaveGitHooks } from './tokensave';
import { listTouchedProjects, clearTouchedProjects } from './projects';
import { clearUpdateState } from './systemUpdates';
import { formatError } from './errors';

/**
 * VS Code exposes no uninstall hook (`onWillUninstall` doesn't exist), so nothing this extension
 * puts on the machine can be undone automatically when the user clicks Uninstall — this is the
 * single entry point that does it on demand, from both the Command Palette and the Settings tab's
 * danger zone.
 *
 * Every step is independently try/caught: a cleanup that aborts halfway is worse than one that
 * reports what it couldn't do, since the half-removed state is exactly what causes the
 * two-competing-installs crashes this is meant to end.
 */
export interface CleanupReport {
  /** What was actually removed, in the order it happened. */
  done: string[];
  /** Left on the machine on purpose — needs a human decision or a manual edit. */
  manual: string[];
  /** Steps that failed; the rest of the cleanup still ran. */
  errors: string[];
}

/** Everything this extension writes into an `env` block — never touches keys it didn't set. */
const MANAGED_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'HEADROOM_OUTPUT_SHAPER', 'ANTHROPIC_CUSTOM_HEADERS'];

async function step(report: CleanupReport, label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    report.done.push(label);
  } catch (err) {
    report.errors.push(`${label} — ${formatError(err)}`);
  }
}

export async function runFullCleanup(
  context: vscode.ExtensionContext,
  daemon: ProxyDaemonManager
): Promise<CleanupReport> {
  const report: CleanupReport = { done: [], manual: [], errors: [] };
  const paths = storagePaths(context);
  const projects = await listTouchedProjects(context);

  await step(report, 'Stopped the shared Headroom proxy daemon', () => daemon.stop());

  // Unregister MCP servers *before* deleting the binaries that do the unregistering — the previous
  // ordering deleted the tokensave binary while git hooks still pointed at it.
  const tokensaveBin = (await pathExists(paths.tokensaveBinPath))
    ? paths.tokensaveBinPath
    : await findOnPath('tokensave', paths.root);
  if (tokensaveBin) {
    try {
      await runCapture(tokensaveBin, ['uninstall', '--agent', 'claude']);
      report.done.push('Unregistered the TokenSave MCP server from Claude Code');
    } catch (err) {
      report.errors.push(`TokenSave MCP unregistration — ${formatError(err)}`);
      report.manual.push('TokenSave MCP entry in ~/.claude.json (`mcpServers`) — remove by hand');
    }
  }

  if (await pathExists(paths.headroomBinPath)) {
    try {
      await runCapture(paths.headroomBinPath, ['mcp', 'uninstall']);
      report.done.push('Unregistered the Headroom MCP server');
    } catch (err) {
      // `headroom mcp uninstall` is not confirmed to exist on every version — treat a failure as
      // "leave it to the user" rather than an error worth alarming about.
      report.manual.push(
        `Headroom MCP entry in ~/.claude.json (\`mcpServers\`) — \`headroom mcp uninstall\` failed (${formatError(err)})`
      );
    }
  }

  for (const root of projects) {
    await step(report, `Removed the TokenSave git hooks from ${root}`, () => removeTokensaveGitHooks(root));
  }

  // Every agent, not just the ones currently in `rtk.agents` — the setting may have been narrowed
  // since an agent was integrated, and that agent's hook would otherwise be orphaned forever.
  for (const agent of ALL_AGENTS) {
    if (agent === 'codex') continue;
    await step(report, `Removed the RTK integration for ${agent}`, () => removeRtkIntegration(agent));
  }

  await step(report, 'Removed the managed env vars from ~/.claude/settings.json', () =>
    removeGlobalEnv(MANAGED_ENV_KEYS)
  );

  for (const root of projects) {
    await step(report, `Removed the managed env vars from ${root}/.claude/settings.local.json`, () =>
      clearProjectEnv(MANAGED_ENV_KEYS, root)
    );
  }

  await step(report, 'Deleted the downloaded RTK binary', () =>
    fs.rm(paths.rtkBinDir, { recursive: true, force: true })
  );
  await step(report, 'Deleted the Headroom venv', () =>
    fs.rm(paths.headroomVenvDir, { recursive: true, force: true })
  );
  await step(report, 'Deleted the downloaded TokenSave binary', () =>
    fs.rm(paths.tokensaveBinDir, { recursive: true, force: true })
  );
  await step(report, 'Deleted the version markers and proxy state', async () => {
    await fs.rm(paths.tokensaveVersionFile, { force: true });
    await fs.rm(paths.headroomVersionFile, { force: true });
    await fs.rm(paths.proxyClientsDir, { recursive: true, force: true });
    await fs.rm(paths.proxyLogFile, { force: true });
    await fs.rm(paths.proxyLockFile, { force: true });
  });

  // These deliberately live outside globalStorage (see paths.ts), so nothing above catches them.
  await step(report, 'Deleted the RTK/TokenSave reporting state files', async () => {
    await fs.rm(rtkInstanceIdPath(), { force: true });
    await fs.rm(rtkLastPushedIdPath(), { force: true });
    await fs.rm(tokensaveInstanceIdPath(), { force: true });
    await fs.rm(tokensaveLastPushedIdPath(), { force: true });
  });

  await step(report, 'Cleared the touched-projects registry', () => clearTouchedProjects(context));
  await step(report, 'Cleared the update-check state', () => clearUpdateState(context));

  // Deliberate leftovers. Each is either not safely machine-editable, or is real user data that a
  // cleanup has no business deleting.
  if (await pathExists(codexAgentsMdPath())) {
    report.manual.push(
      `RTK block in ${codexAgentsMdPath()} (and its RTK.md) — free-form markdown has no safe boundary to excise automatically`
    );
  }
  if (await pathExists(geminiSettingsPath())) {
    report.manual.push('~/.gemini/GEMINI.md and ~/.gemini/hooks/rtk-hook-gemini.sh, if RTK created them');
  }

  for (const [name, bin] of [
    ['RTK', await findOnPath('rtk', paths.root)],
    ['TokenSave', await findOnPath('tokensave', paths.root)],
  ] as const) {
    if (bin) {
      report.manual.push(`${name} is also installed on this machine at ${bin} — left alone (not ours to remove)`);
    }
  }

  report.manual.push("Project indexes (.tokensave/), ~/.tokensave/global.db and RTK's history.db — your own data, kept");

  return report;
}

export function formatCleanupReport(report: CleanupReport): string {
  const lines: string[] = ['easy-headroom cleanup report', ''];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`${title}:`);
    for (const item of items) lines.push(`  - ${item}`);
    lines.push('');
  };
  section('Removed', report.done);
  section('Left for you to remove', report.manual);
  section('Failed', report.errors);
  return lines.join('\n');
}
