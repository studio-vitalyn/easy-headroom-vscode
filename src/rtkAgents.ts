import * as fs from 'fs/promises';
import { claudeSettingsPath, geminiSettingsPath, codexAgentsMdPath } from './paths';
import { readJsonSettings, writeJsonSettings, containsHookCommand, removeMatchingHooks } from './hookSettings';

/**
 * Per rtk-ai.app/docs/getting-started/supported-agents: Claude Code and Gemini CLI both get a
 * transparent shell/tool hook (`rtk init --global[--gemini]`), while Codex CLI only gets prompt-level
 * AGENTS.md instructions (`rtk init --global --codex`) — there is no interception for Codex.
 */
export type AgentId = 'claude' | 'gemini' | 'codex';

export const ALL_AGENTS: AgentId[] = ['claude', 'gemini', 'codex'];

/**
 * Confirmed via `rtk init --help` and real `--dry-run` runs (rtk 0.43.0):
 * - claude/gemini patch a settings.json and, without `--auto-patch`, prompt on stdin for confirmation
 *   first — fatal here since `run()` spawns with `stdio: 'ignore'` (no stdin to answer the prompt).
 * - `--codex` writes AGENTS.md/RTK.md directly (no settings.json involved) and actively *rejects*
 *   `--auto-patch` (`--codex cannot be combined with --auto-patch`), so it must be omitted for codex.
 */
export function rtkInitArgs(agent: AgentId): string[] {
  switch (agent) {
    case 'claude':
      return ['init', '--global', '--auto-patch'];
    case 'gemini':
      return ['init', '--global', '--gemini', '--auto-patch'];
    case 'codex':
      return ['init', '--global', '--codex'];
  }
}

export async function isRtkIntegrated(agent: AgentId): Promise<boolean> {
  if (agent === 'codex') {
    try {
      const raw = await fs.readFile(codexAgentsMdPath(), 'utf8');
      return raw.includes('rtk');
    } catch {
      return false;
    }
  }
  const settingsPath = agent === 'claude' ? claudeSettingsPath() : geminiSettingsPath();
  const settings = await readJsonSettings(settingsPath);
  return containsHookCommand(settings, 'rtk');
}

/** Used by `easy-headroom.uninstallCleanup`. Codex's AGENTS.md block is left for manual removal — text markdown has no safe machine-parseable boundary to excise. */
export async function removeRtkIntegration(agent: AgentId): Promise<void> {
  if (agent === 'codex') return;

  const settingsPath = agent === 'claude' ? claudeSettingsPath() : geminiSettingsPath();
  const settings = await readJsonSettings(settingsPath);
  if (!containsHookCommand(settings, 'rtk')) return;
  await writeJsonSettings(settingsPath, removeMatchingHooks(settings, 'rtk'));
}
