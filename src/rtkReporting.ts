import * as fs from 'fs';
import { config } from './config';
import { rtkHistoryDbPath } from './paths';
import { readCommandsSince } from './rtkDb';
import { getOrCreateInstanceId, readLastPushedId, writeLastPushedId } from './rtkSyncState';
import { projectSlug } from './slug';

const DEBOUNCE_MS = 2_000;
const PUSH_BATCH_SIZE = 500;

async function fetchRemoteCheckpoint(instanceId: string): Promise<number | undefined> {
  const endpoint = config.rtkCheckpointEndpoint();
  if (!endpoint) return undefined;
  const headers: Record<string, string> = {};
  const proxyToken = config.headroomProxyToken();
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
  const endpoint = config.rtkIngestEndpoint();
  if (!endpoint) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const proxyToken = config.headroomProxyToken();
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
 * Watches RTK's SQLite history DB directly and pushes new rows incrementally, instead of
 * relaying `rtk gain`'s pre-aggregated summary — the aggregator needs raw per-command rows to
 * compute project-scoped stats, which the CLI's own summary output doesn't expose.
 *
 * Only ever instantiated in remote mode (see `config.rtkIngestEndpoint`) — local mode has no
 * ingest aggregator to report to, since `easy-headroom` isn't running anywhere in that setup.
 */
export class RtkReportingWatcher {
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pushing = false;
  private pendingRepush = false;

  start(): void {
    if (!config.rtkIngestEndpoint()) return;

    // Reconcile against the server's own last-seen id before the first push: the local
    // checkpoint file can only ever be behind the server (never ahead — the ingest endpoint is
    // an idempotent upsert, and we only advance the local checkpoint after a push succeeds), so
    // this only matters if the local file itself was lost or reset.
    void this.reconcileCheckpoint().finally(() => {
      // Also catches up on anything RTK wrote before this session started (e.g. while the
      // window was closed), not just future fs.watch events.
      void this.pushReport();
    });

    const dbPath = rtkHistoryDbPath();
    try {
      this.watcher = fs.watch(dbPath, () => this.onChange());
    } catch {
      // history.db doesn't exist yet (no RTK activity recorded) — nothing to watch until it does
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
      const dbPath = rtkHistoryDbPath();
      const instanceId = await getOrCreateInstanceId();
      const idProject = projectSlug();
      for (;;) {
        const lastPushedId = await readLastPushedId();
        const rows = await readCommandsSince(dbPath, lastPushedId, PUSH_BATCH_SIZE);
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
