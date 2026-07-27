import * as fs from 'fs/promises';
import * as path from 'path';
import type { SqlJsStatic } from 'sql.js';

export interface TokensaveSavingsRow {
  id: number;
  ts: number;
  project_path: string;
  tool_name: string;
  before_tokens: number;
  after_tokens: number;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (config?: unknown) => Promise<SqlJsStatic>;
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => path.join(__dirname, file),
    });
  }
  return sqlJsPromise;
}

/**
 * Reads rows written after `sinceId`, directly off TokenSave's `global.db`. Unlike RTK's
 * history.db (see rtkDb.ts), this file is NOT WAL-checkpoint-clean between reads: `global.db` is
 * held open long-term (e.g. by a `tokensave serve` MCP process), not by a short-lived
 * per-invocation CLI, so it can have lingering `-wal`/`-shm` sidecars. A raw read of just the main
 * `.db` file can therefore lag behind the live WAL by up to SQLite's default autocheckpoint
 * threshold (~1000 pages / ~4MB) — confirmed empirically (undercounted rows by ~15% against a
 * WAL-aware read). This is bounded, self-resolving staleness (the next fs.watch change, once the
 * WAL autocheckpoints, picks up what was missed), not unbounded data loss — same tolerance as
 * RTK's own "best-effort, next retry" model.
 *
 * Deliberately excludes nothing sensitive here: `tool_name` is an MCP tool name (metadata), not
 * query/command content — same "never transmit shell command content" boundary RTK respects.
 */
export async function readSavingsSince(dbPath: string, sinceId: number, limit: number): Promise<TokensaveSavingsRow[]> {
  const SQL = await loadSqlJs();
  const buf = await fs.readFile(dbPath);
  const db = new SQL.Database(buf);
  try {
    const stmt = db.prepare(
      `SELECT id, ts, project_path, tool_name, before_tokens, after_tokens
       FROM savings_ledger WHERE id > :sinceId ORDER BY id ASC LIMIT :limit`
    );
    stmt.bind({ ':sinceId': sinceId, ':limit': limit });
    const rows: TokensaveSavingsRow[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as TokensaveSavingsRow);
    }
    stmt.free();
    return rows;
  } finally {
    db.close();
  }
}
