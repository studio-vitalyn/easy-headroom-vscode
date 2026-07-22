import * as fs from 'fs/promises';
import * as path from 'path';
import type { SqlJsStatic } from 'sql.js';

export interface RtkCommandRow {
  id: number;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  saved_tokens: number;
  savings_pct: number;
  exec_time_ms: number;
  project_path: string;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

// sql.js (pure JS/WASM) rather than a native SQLite binding: this runs inside the extension
// host on whatever arbitrary machine/architecture the user has, with no per-platform prebuild
// story available here (unlike the Docker server, built once for a single controlled target —
// see docker/easy-headroom/server.js, which uses better-sqlite3 instead).
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (config?: unknown) => Promise<SqlJsStatic>;
    sqlJsPromise = initSqlJs({
      // esbuild bundles sql.js's JS glue into dist/extension.js but can't inline the .wasm
      // binary — esbuild.js copies it to dist/sql-wasm.wasm as a build step, and __dirname
      // inside a bundled CJS output resolves to that same dist/ directory at runtime.
      locateFile: (file: string) => path.join(__dirname, file),
    });
  }
  return sqlJsPromise;
}

/**
 * Reads rows written after `sinceId`, directly off RTK's SQLite file. Safe to read the raw
 * file (no WAL-merging needed): RTK is a short-lived per-invocation CLI, not a daemon, so its
 * WAL checkpoints back into the main .db file as soon as that invocation's connection closes —
 * confirmed empirically (no lingering -wal/-shm sidecar files between commands).
 *
 * Deliberately excludes `original_cmd`/`rtk_cmd` (the actual shell command text) — per the
 * "never transmit shell command content" rule in CLAUDE.md, only stats (tokens, timing, project)
 * leave the machine, same boundary `rtk gain`'s own summary output already respected.
 */
export async function readCommandsSince(dbPath: string, sinceId: number, limit: number): Promise<RtkCommandRow[]> {
  const SQL = await loadSqlJs();
  const buf = await fs.readFile(dbPath);
  const db = new SQL.Database(buf);
  try {
    const stmt = db.prepare(
      `SELECT id, timestamp, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path
       FROM commands WHERE id > :sinceId ORDER BY id ASC LIMIT :limit`
    );
    stmt.bind({ ':sinceId': sinceId, ':limit': limit });
    const rows: RtkCommandRow[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as RtkCommandRow);
    }
    stmt.free();
    return rows;
  } finally {
    db.close();
  }
}
