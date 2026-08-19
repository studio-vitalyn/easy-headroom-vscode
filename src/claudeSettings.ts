import { claudeSettingsPath, projectClaudeSettingsLocalPath } from './paths';
import { readJsonSettings, writeJsonSettings } from './hookSettings';

/**
 * Headroom wraps the Anthropic API traffic (ANTHROPIC_BASE_URL), so it's inherently Claude-Code-only
 * (Gemini/Codex talk to different providers entirely) — unlike RTK's per-agent setup in rtkAgents.ts.
 *
 * Routing is written as `env` keys only — no hooks. `headroom wrap claude` is a *session launcher*
 * (it starts a proxy, sets env vars and execs the tool; it writes no config at all), so there has
 * never been a "wrap entry" in settings.json to detect or remove; the persistent equivalent is
 * `headroom install apply`, which we deliberately don't use — applyEnvironment below covers the
 * same ground per-project.
 */

/**
 * Per-project `ANTHROPIC_BASE_URL` routing must land in `.claude/settings.local.json`'s own `env`
 * block, not just `environmentVariableCollection` — Claude Code reads that file directly and, when
 * run as a VS Code extension, spawns its CLI without going through an integrated terminal at all,
 * so a shell-scoped env var never reaches it. Project-local beats `~/.claude/settings.json`, so this
 * also takes precedence over any global, slug-less `ANTHROPIC_BASE_URL` a manual `headroom install
 * apply --scope user` may have left there — per-project attribution depends on the slug surviving.
 * Merges into (rather than replaces) whatever else is already in that file.
 */
export async function applyProjectEnv(vars: Record<string, string>): Promise<void> {
  const settingsPath = projectClaudeSettingsLocalPath();
  if (!settingsPath) return;
  const settings = await readJsonSettings(settingsPath);
  await writeJsonSettings(settingsPath, { ...settings, env: { ...settings.env, ...vars } });
}

/**
 * Counterpart to applyProjectEnv — used when Headroom gets disabled/misconfigured so a stale URL
 * doesn't linger. `root` targets a project other than the open one (see
 * `projectClaudeSettingsLocalPath`), which is how the full cleanup reaches every project it has
 * touched rather than only the window it happens to run from.
 */
export async function clearProjectEnv(keys: string[], root?: string): Promise<void> {
  const settingsPath = projectClaudeSettingsLocalPath(root);
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

/**
 * Removes only the given keys from `~/.claude/settings.json`'s own `env` block — a global,
 * slug-less `ANTHROPIC_BASE_URL` can be sitting there from a manual `headroom install apply`
 * (see `applyProjectEnv`), and left behind it points every Claude Code session at a proxy that no
 * longer exists. Deliberately key-scoped: the user's own entries in that same block must survive.
 */
export async function removeGlobalEnv(keys: string[]): Promise<void> {
  const settingsPath = claudeSettingsPath();
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
