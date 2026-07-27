import * as vscode from 'vscode';
import { AgentId } from './rtkAgents';

export type Mode = 'local' | 'remote';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('easy-headroom');
}

/**
 * Whether we're in remote mode with a usable shared-instance URL — single source of truth for
 * every layer's remote-reporting endpoints (RTK today, TokenSave once it gains one). Independent
 * of `headroom.enabled`: `mode` is project-wide, Headroom's own proxying is one layer among
 * several that can each be on/off independently (see CLAUDE.md's "Guiding principle").
 */
function remoteBase(): string {
  if (cfg().get<Mode>('mode', 'local') !== 'remote') return '';
  const url = cfg().get<string>('remoteUrl', '');
  return url ? url.replace(/\/+$/, '') : '';
}

export const config = {
  rtkEnabled: (): boolean => cfg().get<boolean>('rtk.enabled', true),
  rtkAgents: (): AgentId[] => cfg().get<AgentId[]>('rtk.agents', ['claude']),
  rtkPinnedVersion: (): string => cfg().get<string>('rtk.pinnedVersion', ''),

  /** Single source of truth for "are we in remote mode with a usable URL" — see `remoteBase`. */
  remoteBaseUrl: (): string => remoteBase(),

  /**
   * Derived, not user-configurable: RTK stats always report to the same shared instance's
   * fixed /rtk/ingest route (see docker/CLAUDE.md). Only meaningful in remote mode — local mode
   * has no ingest aggregator to report to.
   */
  rtkIngestEndpoint: (): string => {
    const base = remoteBase();
    return base ? `${base}/rtk/ingest` : '';
  },

  /** Same derivation as `rtkIngestEndpoint` — used at startup to reconcile the local push
   *  checkpoint against the server's actual last-seen id for this instance (see rtkReporting.ts). */
  rtkCheckpointEndpoint: (): string => {
    const base = remoteBase();
    return base ? `${base}/rtk/checkpoint` : '';
  },

  /** Same derivation as `rtkIngestEndpoint` — backs the RTK dashboard tab's remote-mode stats
   *  fetch (see rtkStats.ts). Empty in local mode: the dashboard reads history.db directly there. */
  rtkAggregateEndpoint: (): string => {
    const base = remoteBase();
    return base ? `${base}/rtk/aggregate` : '';
  },

  /** Same derivation as `rtkAggregateEndpoint` — backs the RTK dashboard tab's project picker. */
  rtkProjectsEndpoint: (): string => {
    const base = remoteBase();
    return base ? `${base}/rtk/projects` : '';
  },

  projectName: (): string => cfg().get<string>('projectName', ''),

  mode: (): Mode => cfg().get<Mode>('mode', 'local'),
  remoteUrl: (): string => cfg().get<string>('remoteUrl', ''),
  proxyToken: (): string => cfg().get<string>('proxyToken', ''),

  headroomEnabled: (): boolean => cfg().get<boolean>('headroom.enabled', false),
  headroomLocalPort: (): number => cfg().get<number>('headroom.localPort', 8787),
  headroomPinnedVersion: (): string => cfg().get<string>('headroom.pinnedVersion', ''),

  tokensaveEnabled: (): boolean => cfg().get<boolean>('tokensave.enabled', true),
  tokensavePinnedVersion: (): string => cfg().get<string>('tokensave.pinnedVersion', ''),

  setRtkPinnedVersion: (version: string): Thenable<void> =>
    cfg().update('rtk.pinnedVersion', version, vscode.ConfigurationTarget.Global),
  setHeadroomPinnedVersion: (version: string): Thenable<void> =>
    cfg().update('headroom.pinnedVersion', version, vscode.ConfigurationTarget.Global),
  setTokensavePinnedVersion: (version: string): Thenable<void> =>
    cfg().update('tokensave.pinnedVersion', version, vscode.ConfigurationTarget.Global),
};
