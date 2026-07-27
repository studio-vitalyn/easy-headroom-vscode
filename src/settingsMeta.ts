import * as vscode from 'vscode';

export type TargetName = 'Global' | 'Workspace' | 'WorkspaceFolder';

const TARGET_ENUM: Record<TargetName, vscode.ConfigurationTarget> = {
  Global: vscode.ConfigurationTarget.Global,
  Workspace: vscode.ConfigurationTarget.Workspace,
  WorkspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
};

const PREFIX = 'easy-headroom.';

/** Nicer labels than the raw key for the ~9 settings this tab exposes — small enough set that a
 *  hand-picked map reads better than deriving one from camelCase. */
const LABELS: Record<string, string> = {
  projectName: 'Project name',
  'rtk.enabled': 'Enable RTK',
  'rtk.agents': 'Agents',
  'rtk.pinnedVersion': 'Pinned version',
  mode: 'Mode',
  remoteUrl: 'Remote URL',
  proxyToken: 'Proxy token',
  'headroom.enabled': 'Enable Headroom',
  'headroom.localPort': 'Local port',
  'headroom.pinnedVersion': 'Pinned version',
  'tokensave.enabled': 'Enable TokenSave',
  'tokensave.pinnedVersion': 'Pinned version',
};

/** Where a setting *should* be written by default, when that differs from "most permissive
 *  allowed level" — e.g. `projectName` is technically settable at User level (scope: resource)
 *  but is a per-project fact, not a global preference. Keys not listed here default to Global. */
const RECOMMENDED_TARGET: Record<string, TargetName> = {
  projectName: 'Workspace',
};

/** Hard exceptions on top of the scope-derived `allowedTargets()` result, for settings where the
 *  declared `scope` is more permissive than what actually makes sense — `projectName` is `resource`
 *  scoped (so User/Global is technically legal) but is a per-project fact, never a global
 *  preference, so User is excluded outright rather than merely de-prioritized via
 *  `RECOMMENDED_TARGET`. Falls back to the unrestricted list if the restriction would leave zero
 *  options (e.g. no workspace open at all — nothing to restrict to). */
const RESTRICT_ALLOWED: Partial<Record<string, TargetName[]>> = {
  projectName: ['Workspace', 'WorkspaceFolder'],
};

function applyRestriction(key: string, allowed: TargetName[]): TargetName[] {
  const restriction = RESTRICT_ALLOWED[key];
  if (!restriction) return allowed;
  const restricted = allowed.filter((t) => restriction.includes(t));
  return restricted.length > 0 ? restricted : allowed;
}

interface WorkspaceContext {
  hasWorkspace: boolean;
  singleFolder: boolean;
}

/**
 * Mirrors VS Code's own configuration-scope semantics for `contributes.configuration.properties[].scope`
 * (documented on the extension manifest schema, not in @types/vscode — confirmed against the installed
 * typings that the *write* API only has 3 targets: Global/Workspace/WorkspaceFolder, no separate "Remote"
 * one). `machine`/`application` block Workspace and Folder entirely (that's the whole point of those
 * scopes — e.g. a committed .vscode/settings.json can't silently redirect remoteUrl).
 * `machine-overridable` allowing Workspace but not Folder is the one assumption here not verified against
 * a real multi-root workspace — treat as unconfirmed until manually tested.
 */
export function allowedTargets(scope: string | undefined, ctx: WorkspaceContext): TargetName[] {
  let base: TargetName[];
  switch (scope) {
    case 'application':
    case 'machine':
      base = ['Global'];
      break;
    case 'machine-overridable':
    case 'window':
      base = ['Global', 'Workspace'];
      break;
    default:
      base = ['Global', 'Workspace', 'WorkspaceFolder'];
  }
  if (!ctx.hasWorkspace) return base.filter((t) => t === 'Global');
  if (!ctx.singleFolder) return base.filter((t) => t !== 'WorkspaceFolder');
  return base;
}

export interface SettingItem {
  key: string;
  label: string;
  type: string;
  enum?: string[];
  items?: { enum?: string[] };
  default: unknown;
  description: string;
  scope?: string;
  allowed: TargetName[];
  recommended: TargetName;
  current?: TargetName;
  value: {
    effective: unknown;
    global: unknown;
    workspace: unknown;
    workspaceFolder: unknown;
  };
}

export interface SettingsGroup {
  title: string;
  items: SettingItem[];
}

/** Builds the full settings tab payload from the same `contributes.configuration` groups/descriptions
 *  package.json already declares — single source of truth for type/default/description/scope, so this
 *  tab can't drift from what the native Settings UI shows for the same key. */
export function buildSettingsSnapshot(context: vscode.ExtensionContext): SettingsGroup[] {
  const raw = context.extension.packageJSON?.contributes?.configuration;
  const groups: Array<{ title: string; properties: Record<string, any> }> = Array.isArray(raw)
    ? raw
    : raw
      ? [raw]
      : [];

  const folders = vscode.workspace.workspaceFolders;
  const ctx: WorkspaceContext = {
    hasWorkspace: (folders?.length ?? 0) > 0,
    singleFolder: folders?.length === 1,
  };
  const resource = ctx.singleFolder ? folders![0].uri : undefined;
  const cfg = vscode.workspace.getConfiguration('easy-headroom', resource);

  return groups.map((group) => ({
    title: group.title.replace(/^easy-headroom\s*(›\s*)?/, '').trim() || 'General',
    items: Object.entries(group.properties).map(([fullKey, prop]: [string, any]) => {
      const key = fullKey.startsWith(PREFIX) ? fullKey.slice(PREFIX.length) : fullKey;
      const inspected = cfg.inspect<unknown>(key);
      const allowed = applyRestriction(key, allowedTargets(prop.scope, ctx));
      const recommendedWanted = RECOMMENDED_TARGET[key] ?? 'Global';
      const item: SettingItem = {
        key,
        label: LABELS[key] ?? key,
        type: prop.type,
        enum: prop.enum,
        items: prop.items,
        default: prop.default,
        description: prop.description ?? '',
        scope: prop.scope,
        allowed,
        recommended: allowed.includes(recommendedWanted) ? recommendedWanted : allowed[0],
        value: {
          effective: cfg.get(key),
          global: inspected?.globalValue,
          workspace: inspected?.workspaceValue,
          workspaceFolder: inspected?.workspaceFolderValue,
        },
      };
      if (item.value.workspaceFolder !== undefined) item.current = 'WorkspaceFolder';
      else if (item.value.workspace !== undefined) item.current = 'Workspace';
      else if (item.value.global !== undefined) item.current = 'Global';
      return item;
    }),
  }));
}

export async function writeSetting(key: string, value: unknown, target: TargetName): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const resource = target === 'WorkspaceFolder' && folders?.length === 1 ? folders[0].uri : undefined;
  const cfg = vscode.workspace.getConfiguration('easy-headroom', resource);
  await cfg.update(key, value, TARGET_ENUM[target]);
}
