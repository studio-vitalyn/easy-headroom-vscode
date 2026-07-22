import * as fs from 'fs/promises';
import * as path from 'path';
import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import { config } from './config';
import { rtkHistoryDbPath } from './paths';

export interface RtkSummary {
  total_commands: number;
  total_input: number;
  total_output: number;
  total_saved: number;
  avg_savings_pct: number;
  total_time_ms: number;
  avg_time_ms: number;
}

interface RtkSeriesDerived {
  commands: number;
  input_tokens: number;
  output_tokens: number;
  saved_tokens: number;
  savings_pct: number;
  avg_time_ms: number;
}

export type RtkDaily = RtkSeriesDerived & { date: string };
export type RtkWeekly = RtkSeriesDerived & { week_start: string; week_end: string };
export type RtkMonthly = RtkSeriesDerived & { month: string };

export interface RtkStats {
  summary: RtkSummary;
  daily: RtkDaily[];
  weekly: RtkWeekly[];
  monthly: RtkMonthly[];
}

export interface RtkProjectSummary {
  id_project: string;
  label: string;
  commands: number;
  input_tokens: number;
  output_tokens: number;
  saved_tokens: number;
  avg_savings_pct: number;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (config?: unknown) => Promise<SqlJsStatic>;
    sqlJsPromise = initSqlJs({ locateFile: (file: string) => path.join(__dirname, file) });
  }
  return sqlJsPromise;
}

async function withLocalDb<T>(fn: (db: SqlJsDatabase) => T): Promise<T | undefined> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(rtkHistoryDbPath());
  } catch {
    return undefined;
  }
  const SQL = await loadSqlJs();
  const db = new SQL.Database(buf);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function queryAll(db: SqlJsDatabase, sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function savingsPct(saved: number, input: number, output: number): number {
  const denom = input + output;
  return denom > 0 ? (saved / denom) * 100 : 0;
}

interface RawSeriesRow {
  commands: number;
  input_tokens: number;
  output_tokens: number;
  saved_tokens: number;
  total_time_ms: number;
}

function derive<T extends RawSeriesRow>({ total_time_ms, ...rest }: T): Omit<T, 'total_time_ms'> & RtkSeriesDerived {
  return {
    ...rest,
    savings_pct: savingsPct(rest.saved_tokens, rest.input_tokens, rest.output_tokens),
    avg_time_ms: rest.commands ? total_time_ms / rest.commands : 0,
  };
}

const SERIES_COLUMNS = `
  COUNT(*) AS commands,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(saved_tokens), 0) AS saved_tokens,
  COALESCE(SUM(exec_time_ms), 0) AS total_time_ms
`;

/**
 * Local RTK data has no `id_project` — that's a concept added when a row is pushed to the
 * remote aggregator (see rtkSyncState.ts). Locally, the closest equivalent is `project_path`
 * (RTK's own per-command cwd), grouped/filtered on the raw path, labeled with its basename for
 * a readable picker.
 */
async function getLocalStats(projectPath?: string): Promise<RtkStats | undefined> {
  return withLocalDb((db) => {
    const where = projectPath ? 'WHERE project_path = ?' : '';
    const params = projectPath ? [projectPath] : [];

    const summaryRow = queryAll(
      db,
      `SELECT COUNT(*) AS total_commands,
              COALESCE(SUM(input_tokens), 0) AS total_input,
              COALESCE(SUM(output_tokens), 0) AS total_output,
              COALESCE(SUM(saved_tokens), 0) AS total_saved,
              COALESCE(SUM(exec_time_ms), 0) AS total_time_ms
       FROM commands ${where}`,
      params
    )[0] as unknown as {
      total_commands: number;
      total_input: number;
      total_output: number;
      total_saved: number;
      total_time_ms: number;
    };
    const summary: RtkSummary = {
      ...summaryRow,
      avg_savings_pct: savingsPct(summaryRow.total_saved, summaryRow.total_input, summaryRow.total_output),
      avg_time_ms: summaryRow.total_commands > 0 ? summaryRow.total_time_ms / summaryRow.total_commands : 0,
    };

    const daily = (
      queryAll(
        db,
        `SELECT date(timestamp) AS date, ${SERIES_COLUMNS} FROM commands ${where} GROUP BY date ORDER BY date ASC`,
        params
      ) as unknown as (RawSeriesRow & { date: string })[]
    ).map(derive);

    // SQLite has no canonical ISO-week function — see the same caveat in docker/CLAUDE.md's
    // "RTK data model" for the server-side equivalent of this query.
    const weekly = (
      queryAll(
        db,
        `SELECT strftime('%Y-%W', timestamp) AS week, MIN(date(timestamp)) AS week_start,
                MAX(date(timestamp)) AS week_end, ${SERIES_COLUMNS}
         FROM commands ${where} GROUP BY week ORDER BY week ASC`,
        params
      ) as unknown as (RawSeriesRow & { week: string; week_start: string; week_end: string })[]
    ).map(({ week, ...rest }) => derive(rest));

    const monthly = (
      queryAll(
        db,
        `SELECT strftime('%Y-%m', timestamp) AS month, ${SERIES_COLUMNS} FROM commands ${where} GROUP BY month ORDER BY month ASC`,
        params
      ) as unknown as (RawSeriesRow & { month: string })[]
    ).map(derive);

    return { summary, daily, weekly, monthly };
  });
}

async function getLocalProjects(): Promise<RtkProjectSummary[]> {
  const rows = await withLocalDb((db) =>
    queryAll(
      db,
      `SELECT project_path AS id_project,
              COUNT(*) AS commands,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(saved_tokens), 0) AS saved_tokens
       FROM commands
       WHERE project_path IS NOT NULL AND project_path != ''
       GROUP BY project_path ORDER BY commands DESC`
    )
  );
  if (!rows) return [];
  return (
    rows as unknown as { id_project: string; commands: number; input_tokens: number; output_tokens: number; saved_tokens: number }[]
  ).map((r) => ({
    ...r,
    label: path.basename(r.id_project) || r.id_project,
    avg_savings_pct: savingsPct(r.saved_tokens, r.input_tokens, r.output_tokens),
  }));
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const headers: Record<string, string> = {};
  const proxyToken = config.headroomProxyToken();
  if (proxyToken) headers['X-Headroom-Proxy-Token'] = proxyToken;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

async function getRemoteStats(project?: string): Promise<RtkStats | undefined> {
  const base = config.rtkAggregateEndpoint();
  if (!base) return undefined;
  const url = project ? `${base}?project=${encodeURIComponent(project)}` : base;
  return fetchJson<RtkStats>(url);
}

async function getRemoteProjects(): Promise<RtkProjectSummary[]> {
  const base = config.rtkProjectsEndpoint();
  if (!base) return [];
  const body = await fetchJson<{
    projects: { id_project: string; commands: number; input_tokens: number; output_tokens: number; saved_tokens: number; avg_savings_pct: number }[];
  }>(base);
  if (!body) return [];
  return body.projects.map((p) => ({ ...p, label: p.id_project }));
}

function useRemote(): boolean {
  return Boolean(config.rtkAggregateEndpoint());
}

export async function getRtkStats(project?: string): Promise<RtkStats | undefined> {
  return useRemote() ? getRemoteStats(project) : getLocalStats(project);
}

export async function getRtkProjects(): Promise<RtkProjectSummary[]> {
  return useRemote() ? getRemoteProjects() : getLocalProjects();
}
