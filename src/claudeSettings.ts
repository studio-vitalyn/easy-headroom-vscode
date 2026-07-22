import { claudeSettingsPath, projectClaudeSettingsLocalPath } from './paths';
import { readJsonSettings, writeJsonSettings, containsHookCommand, removeMatchingHooks } from './hookSettings';

/**
 * Headroom wraps the Anthropic API traffic (ANTHROPIC_BASE_URL), so it's inherently Claude-Code-only
 * (Gemini/Codex talk to different providers entirely) — unlike RTK's per-agent setup in rtkAgents.ts.
 */

/**
 * `headroom wrap claude` behavior is not yet fully confirmed (see "Open questions" in CLAUDE.md) —
 * this checks for a plausible marker and should be revisited once that's verified against the real CLI.
 */
export async function isHeadroomWrapped(): Promise<boolean> {
  const settings = await readJsonSettings(claudeSettingsPath());
  return containsHookCommand(settings, 'headroom');
}

/** Used by `easy-headroom.uninstallCleanup` — removes the Headroom wrap entry from settings.json, if present. */
export async function removeHeadroomWrap(): Promise<void> {
  const settings = await readJsonSettings(claudeSettingsPath());
  if (!containsHookCommand(settings, 'headroom')) return;
  await writeJsonSettings(claudeSettingsPath(), removeMatchingHooks(settings, 'headroom'));
}

/**
 * Per-project `ANTHROPIC_BASE_URL` routing must land in `.claude/settings.local.json`'s own `env`
 * block, not just `environmentVariableCollection` — Claude Code reads that file directly and, when
 * run as a VS Code extension, spawns its CLI without going through an integrated terminal at all,
 * so a shell-scoped env var never reaches it. `headroom wrap claude` already writes a global,
 * slug-less `env.ANTHROPIC_BASE_URL` to `~/.claude/settings.json` — this project-local value must
 * take precedence over that one for per-project attribution to actually show up on the dashboard.
 * Merges into (rather than replaces) whatever else is already in that file.
 */
export async function applyProjectEnv(vars: Record<string, string>): Promise<void> {
  const settingsPath = projectClaudeSettingsLocalPath();
  if (!settingsPath) return;
  const settings = await readJsonSettings(settingsPath);
  await writeJsonSettings(settingsPath, { ...settings, env: { ...settings.env, ...vars } });
}

/** Counterpart to applyProjectEnv — used when Headroom gets disabled/misconfigured so a stale URL doesn't linger. */
export async function clearProjectEnv(keys: string[]): Promise<void> {
  const settingsPath = projectClaudeSettingsLocalPath();
  if (!settingsPath) return;
  const settings = await readJsonSettings(settingsPath);
  if (!settings.env) return;
  const env = { ...settings.env };
  let changed = false;
  for (const key of keys) {
    if (key in env) {
      delete env[key];
      changed = true;
    }
  }
  if (!changed) return;
  await writeJsonSettings(settingsPath, { ...settings, env });
}
