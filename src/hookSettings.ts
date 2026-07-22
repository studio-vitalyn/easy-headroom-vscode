import * as fs from 'fs/promises';
import * as path from 'path';

interface HookGroup {
  hooks?: Array<{ command?: string }>;
}

export interface HookSettings {
  hooks?: Record<string, HookGroup[]>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export async function readJsonSettings(filePath: string): Promise<HookSettings> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as HookSettings;
  } catch {
    return {};
  }
}

export async function writeJsonSettings(filePath: string, settings: HookSettings): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8');
}

export function containsHookCommand(settings: HookSettings, needle: string): boolean {
  const haystack = JSON.stringify(settings.hooks ?? {});
  return haystack.includes(needle);
}

export function removeMatchingHooks(settings: HookSettings, needle: string): HookSettings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const filtered = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks?.filter((h) => !h.command?.includes(needle)),
      }))
      .filter((group) => (group.hooks?.length ?? 0) > 0);
    if (filtered.length > 0) hooks[event] = filtered;
  }
  return { ...settings, hooks };
}
