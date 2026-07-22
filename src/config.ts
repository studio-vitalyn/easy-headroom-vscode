import * as vscode from 'vscode';
import { AgentId } from './rtkAgents';

export type HeadroomMode = 'local' | 'remote';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('easy-headroom');
}

export const config = {
  rtkEnabled: (): boolean => cfg().get<boolean>('rtk.enabled', true),
  rtkAgents: (): AgentId[] => cfg().get<AgentId[]>('rtk.agents', ['claude']),
  rtkPinnedVersion: (): string => cfg().get<string>('rtk.pinnedVersion', ''),

  /**
   * Derived, not user-configurable: RTK stats always report to the same Headroom instance
   * used for API proxying, at its fixed /rtk/ingest route (see docker/CLAUDE.md). Only
   * meaningful in remote mode — local mode has no ingest aggregator to report to.
   */
  rtkIngestEndpoint: (): string => {
    if (!cfg().get<boolean>('headroom.enabled', false)) return '';
    if (cfg().get<HeadroomMode>('headroom.mode', 'local') !== 'remote') return '';
    const url = cfg().get<string>('headroom.remoteUrl', '');
    return url ? `${url.replace(/\/+$/, '')}/rtk/ingest` : '';
  },

  /** Same derivation as `rtkIngestEndpoint` — used at startup to reconcile the local push
   *  checkpoint against the server's actual last-seen id for this instance (see rtkReporting.ts). */
  rtkCheckpointEndpoint: (): string => {
    if (!cfg().get<boolean>('headroom.enabled', false)) return '';
    if (cfg().get<HeadroomMode>('headroom.mode', 'local') !== 'remote') return '';
    const url = cfg().get<string>('headroom.remoteUrl', '');
    return url ? `${url.replace(/\/+$/, '')}/rtk/checkpoint` : '';
  },

  /** Same derivation as `rtkIngestEndpoint` — backs the RTK dashboard tab's remote-mode stats
   *  fetch (see rtkStats.ts). Empty in local mode: the dashboard reads history.db directly there. */
  rtkAggregateEndpoint: (): string => {
    if (!cfg().get<boolean>('headroom.enabled', false)) return '';
    if (cfg().get<HeadroomMode>('headroom.mode', 'local') !== 'remote') return '';
    const url = cfg().get<string>('headroom.remoteUrl', '');
    return url ? `${url.replace(/\/+$/, '')}/rtk/aggregate` : '';
  },

  /** Same derivation as `rtkAggregateEndpoint` — backs the RTK dashboard tab's project picker. */
  rtkProjectsEndpoint: (): string => {
    if (!cfg().get<boolean>('headroom.enabled', false)) return '';
    if (cfg().get<HeadroomMode>('headroom.mode', 'local') !== 'remote') return '';
    const url = cfg().get<string>('headroom.remoteUrl', '');
    return url ? `${url.replace(/\/+$/, '')}/rtk/projects` : '';
  },

  projectName: (): string => cfg().get<string>('projectName', ''),

  headroomEnabled: (): boolean => cfg().get<boolean>('headroom.enabled', false),
  headroomMode: (): HeadroomMode => cfg().get<HeadroomMode>('headroom.mode', 'local'),
  headroomRemoteUrl: (): string => cfg().get<string>('headroom.remoteUrl', ''),
  headroomProxyToken: (): string => cfg().get<string>('headroom.proxyToken', ''),
  headroomLocalPort: (): number => cfg().get<number>('headroom.localPort', 8787),
  headroomPinnedVersion: (): string => cfg().get<string>('headroom.pinnedVersion', ''),

  setRtkPinnedVersion: (version: string): Thenable<void> =>
    cfg().update('rtk.pinnedVersion', version, vscode.ConfigurationTarget.Global),
  setHeadroomPinnedVersion: (version: string): Thenable<void> =>
    cfg().update('headroom.pinnedVersion', version, vscode.ConfigurationTarget.Global),
};
