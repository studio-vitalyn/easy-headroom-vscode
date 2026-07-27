import * as fs from 'fs';
import { config } from './config';
import { tokensaveGlobalDbPath } from './paths';
import { readSavingsSince } from './tokensaveDb';
import { getOrCreateInstanceId, readLastPushedId, writeLastPushedId } from './tokensaveSyncState';
import { projectSlug } from './slug';

const DEBOUNCE_MS = 2_000;
const PUSH_BATCH_SIZE = 500;

async function fetchRemoteCheckpoint(instanceId: string): Promise<number | undefined> {
  const endpoint = config.tokensaveCheckpointEndpoint();
  if (!endpoint) return undefined;
  const headers: Record<string, string> = {};
  const proxyToken = config.proxyToken();
  if (proxyToken) headers['X-Headroom-Proxy-Token'] = proxyToken;
  try {
    const res = await fetch(`${endpoint}?instance_id=${encodeURIComponent(instanceId)}`, { headers });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { last_id?: number };
    return typeof body.last_id === 'number' ? body.last_id : undefined;
  } catch {
    return undefined;
  }
}

async function pushRows(instanceId: string, idProject: string, rows: unknown[]): Promise<boolean> {
  const endpoint = config.tokensaveIngestEndpoint();
  if (!endpoint) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const proxyToken = config.proxyToken();
  if (proxyToken) headers['X-Headroom-Proxy-Token'] = proxyToken;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ instance_id: instanceId, id_project: idProject, rows }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Watches TokenSave's `global.db` directly and pushes new rows incrementally — same principle as
 * `RtkReportingWatcher` (rtkReporting.ts), just against `savings_ledger` instead of `commands`.
 *
 * Only ever instantiated in remote mode (see `config.tokensaveIngestEndpoint`) — local mode has no
 * ingest aggregator to report to.
 */
export class TokensaveReportingWatcher {
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pushing = false;
  private pendingRepush = false;

  start(): void {
    if (!config.tokensaveIngestEndpoint()) return;

    void this.reconcileCheckpoint().finally(() => {
      void this.pushReport();
    });

    const dbPath = tokensaveGlobalDbPath();
    try {
      this.watcher = fs.watch(dbPath, () => this.onChange());
    } catch {
      // global.db doesn't exist yet (no TokenSave activity recorded) — nothing to watch until it does
    }
  }

  private async reconcileCheckpoint(): Promise<void> {
    const instanceId = await getOrCreateInstanceId();
    const [local, remote] = await Promise.all([readLastPushedId(), fetchRemoteCheckpoint(instanceId)]);
    if (remote !== undefined && remote > local) {
      await writeLastPushedId(remote);
    }
  }

  private onChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.pushReport();
    }, DEBOUNCE_MS);
  }

  private async pushReport(): Promise<void> {
    if (this.pushing) {
      this.pendingRepush = true;
      return;
    }
    this.pushing = true;
    try {
      const dbPath = tokensaveGlobalDbPath();
      const instanceId = await getOrCreateInstanceId();
      const idProject = projectSlug();
      for (;;) {
        const lastPushedId = await readLastPushedId();
        const rows = await readSavingsSince(dbPath, lastPushedId, PUSH_BATCH_SIZE);
        if (rows.length === 0) break;
        const ok = await pushRows(instanceId, idProject, rows);
        if (!ok) break;
        await writeLastPushedId(rows[rows.length - 1].id);
        if (rows.length < PUSH_BATCH_SIZE) break;
      }
    } catch {
      // best-effort — the next fs.watch change, or next window startup's reconcile, retries
    } finally {
      this.pushing = false;
      if (this.pendingRepush) {
        this.pendingRepush = false;
        void this.pushReport();
      }
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
  }
}
