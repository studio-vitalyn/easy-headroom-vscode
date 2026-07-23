import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as vscode from 'vscode';
import { config } from './config';
import { storagePaths } from './paths';
import { ProxyDaemonManager, checkHealth } from './daemon';
import { listRtkReleases, listHeadroomReleases } from './versions';
import { removeHeadroomWrap, clearProjectEnv } from './claudeSettings';
import { removeRtkIntegration } from './rtkAgents';
import { getRtkStats, getRtkProjects } from './rtkStats';
import { computeCarbonEstimate, type CarbonEstimate } from './carbonFootprint';

let dashboardPanel: vscode.WebviewPanel | undefined;

let dashboardProxyServer: http.Server | undefined;
let dashboardProxyPort: number | undefined;
let dashboardProxyTarget: string | undefined;
// Headroom's own dashboard (Alpine.js) already polls its backend's /stats endpoint on its own —
// this just taps the response as it flows back through our proxy, so we never issue a second
// request ourselves. Module-level rather than a startDashboardProxy() param because the proxy
// server is a singleton reused across openDashboard() calls (see the early-return above); set by
// openDashboard for the currently-open panel, cleared on dispose.
let onHeadroomStats: ((raw: unknown) => void) | undefined;

// Headroom's dashboard is client-rendered (Alpine.js polling its own backend via relative
// fetch()) and sends `X-Frame-Options: DENY`, so a plain <iframe> pointed at it directly is
// blocked. This local reverse proxy (runs on the same host as the rest of the extension —
// the remote host under Remote-SSH, per `extensionKind: workspace`) strips that header so the
// iframe can load, and forwards everything else unchanged so the framed page's own relative
// fetch() calls land on a real, same-origin http://127.0.0.1:<port> — no CORS needed.
//
// Tried and abandoned: asking Headroom for a CSP `frame-ancestors` config option instead of
// stripping the header. Doesn't work in practice — see the note in vscode/CLAUDE.md under
// "Status bar" for why.
function startDashboardProxy(targetBase: string): Promise<number> {
  if (dashboardProxyServer && dashboardProxyTarget === targetBase && dashboardProxyPort) {
    return Promise.resolve(dashboardProxyPort);
  }
  stopDashboardProxy();
  dashboardProxyTarget = targetBase;
  const target = new URL(targetBase);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const lib = target.protocol === 'https:' ? https : http;
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
      // easy-headroom-proxy gates access with X-Headroom-Proxy-Token (remote mode only — local
      // mode's daemon has no such gate). Nothing else attaches this header for dashboard traffic:
      // easy-headroom itself only forwards headers through untouched (see docker/CLAUDE.md), and
      // the dashboard's own iframe/fetch calls, routed through this same local proxy, can't set
      // custom headers on their own — this is the one place to inject it for the whole dashboard.
      if (config.headroomMode() === 'remote') {
        const proxyToken = config.headroomProxyToken();
        if (proxyToken) headers['x-headroom-proxy-token'] = proxyToken;
      }
      const proxyReq = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: req.url,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          const headers = { ...proxyRes.headers };
          delete headers['x-frame-options'];
          // frame-ancestors blocks framing independently of X-Frame-Options, and Headroom's
          // dashboard response sends both — stripping only the legacy header isn't enough.
          delete headers['content-security-policy'];
          delete headers['content-security-policy-report-only'];
          res.writeHead(proxyRes.statusCode ?? 200, headers);
          // Readable streams broadcast to every attached 'data' listener in flowing mode, so
          // buffering here alongside the pipe() below observes the exact same bytes already
          // headed to the browser — no extra round-trip to Headroom.
          if (onHeadroomStats && (req.url ?? '').split('?')[0] === '/stats') {
            const chunks: Buffer[] = [];
            proxyRes.on('data', (chunk) => chunks.push(chunk));
            proxyRes.on('end', () => {
              try {
                onHeadroomStats?.(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              } catch {
                // malformed/unexpected response shape — skip this tick, the next poll retries
              }
            });
          }
          proxyRes.pipe(res);
        }
      );
      proxyReq.on('error', () => {
        res.writeHead(502);
        res.end('Bad gateway');
      });
      req.pipe(proxyReq);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      dashboardProxyPort = typeof addr === 'object' && addr ? addr.port : undefined;
      dashboardProxyServer = server;
      resolve(dashboardProxyPort!);
    });
  });
}

function stopDashboardProxy(): void {
  dashboardProxyServer?.close();
  dashboardProxyServer = undefined;
  dashboardProxyPort = undefined;
  dashboardProxyTarget = undefined;
}

/** RTK's dashboard tab has its own data source (local history.db or a remote aggregator) —
 *  independent of Headroom's own enabled/mode state, see rtkStats.ts. */
function rtkDashboardAvailable(): boolean {
  return config.rtkEnabled() || Boolean(config.rtkAggregateEndpoint());
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

interface HeadroomLiveStats {
  requests?: number;
  costSavedUsd?: number;
  savingsPct?: number;
  cacheHitRate?: number;
  avgLatencyMs?: number;
  history: number[];
  carbon?: CarbonEstimate;
}

const STATS_HISTORY_POINTS = 40;

/**
 * Headroom's /stats response is an internal, undocumented shape (no schema/versioning contract) —
 * read defensively in this one place, so a field rename on Headroom's side only breaks this
 * function instead of scattering optional-chaining across the webview script.
 */
async function extractHeadroomStats(raw: unknown): Promise<HeadroomLiveStats> {
  const r = raw as Record<string, any> | null | undefined;
  const summary = r?.summary;
  const history: number[] = Array.isArray(r?.savings_history)
    ? r.savings_history
        .slice(-STATS_HISTORY_POINTS)
        .map((p: unknown) => (Array.isArray(p) && typeof p[1] === 'number' ? p[1] : 0))
    : [];

  // `persistent_savings.by_model` (== headroom's own SavingsTracker.stats_preview()) is the rich,
  // per-model breakdown (tokens_saved/total_input_tokens/...) — not `savings.by_model`, which is
  // just a flat {model: request_count} dict with no token data. RTK has no model column at all
  // (see rtkDb.ts), so Headroom is the only source that can attribute tokens to a model.
  let carbon: CarbonEstimate | undefined;
  try {
    carbon = await computeCarbonEstimate(r?.persistent_savings?.by_model);
  } catch {
    // carbon-coefficients.json missing/corrupt — skip the CO2 card, rest of the dashboard is unaffected
  }

  return {
    requests: typeof summary?.api_requests === 'number' ? summary.api_requests : undefined,
    costSavedUsd: typeof summary?.cost?.total_saved_usd === 'number' ? summary.cost.total_saved_usd : undefined,
    savingsPct: typeof summary?.cost?.savings_pct === 'number' ? summary.cost.savings_pct : undefined,
    cacheHitRate: typeof r?.prefix_cache?.totals?.hit_rate === 'number' ? r.prefix_cache.totals.hit_rate : undefined,
    avgLatencyMs: typeof r?.latency?.average_ms === 'number' ? r.latency.average_ms : undefined,
    history,
    carbon,
  };
}

function renderDashboardHtml(opts: {
  headroomAvailable: boolean;
  rtkAvailable: boolean;
  externalOrigin: string;
  iconUri: string;
  cspSource: string;
}): string {
  const { headroomAvailable, rtkAvailable, externalOrigin, iconUri, cspSource } = opts;
  const nonce = getNonce();
  // CO2 needs Headroom's per-model token breakdown (see extractHeadroomStats), so it rides along
  // with the Headroom tab rather than being its own top-level availability check.
  const co2Available = headroomAvailable;
  // Only show a tab switcher when more than one view is actually available — otherwise there's
  // nothing to switch between, so skip straight to whichever single view applies. CO2 rides in
  // third position, after both raw-data tabs.
  const tabOrder: Array<'headroom' | 'rtk' | 'co2'> = [];
  if (headroomAvailable) tabOrder.push('headroom');
  if (rtkAvailable) tabOrder.push('rtk');
  if (co2Available) tabOrder.push('co2');
  const showTabs = tabOrder.length > 1;
  const defaultTab = tabOrder[0];
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`,
    headroomAvailable ? `frame-src ${externalOrigin}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  #tabbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border); flex: 0 0 auto; }
  .brand-block { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 2px 10px 2px 2px; margin-right: 4px; border-right: 1px solid var(--vscode-widget-border); }
  .brand-logo { width: 20px; height: 20px; display: block; }
  .tab-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 4px 12px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); cursor: pointer; font-family: inherit; }
  .tab-btn.active { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); }
  .tab-btn .tab-title { font-weight: 600; font-size: 12px; }
  .tab-btn .tab-metric { font-size: 11px; opacity: 0.75; }
  #views { flex: 1; min-height: 0; position: relative; }
  .view { position: absolute; inset: 0; overflow: auto; }
  .view.hidden { display: none; }
  #view-headroom { display: flex; flex-direction: column; overflow: hidden; }
  #hr-stats { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--vscode-widget-border); flex: 0 0 auto; }
  #hr-stats .card { padding: 6px 12px; min-width: 90px; }
  #hr-stats .value { font-size: 15px; }
  #hr-stats .spark-card { display: flex; flex-direction: column; justify-content: flex-end; min-width: 80px; }
  #hr-stats .spark { position: relative; height: 24px; }
  #hr-stats .spark svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  iframe { width: 100%; flex: 1; min-height: 0; border: none; display: block; }
  .rtk-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 2px 6px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 4px 14px 16px; }
  .card {
    position: relative;
    overflow: hidden;
    background: linear-gradient(160deg, color-mix(in srgb, var(--vscode-charts-blue) 14%, var(--vscode-editorWidget-background)), var(--vscode-editorWidget-background) 65%);
    border: 1px solid color-mix(in srgb, var(--vscode-charts-blue) 35%, var(--vscode-widget-border));
    border-radius: 6px;
    padding: 8px 14px;
    min-width: 110px;
  }
  .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, var(--vscode-charts-blue), transparent); }
  .card .value { font-size: 18px; font-weight: 600; }
  .card .label { font-size: 10px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.03em; }
  .rtk-section-title { margin: 16px 14px 6px; font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.04em; }
  .chart {
    position: relative;
    height: 110px;
    margin: 0 14px 8px;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--vscode-widget-border);
  }
  .chart svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .chart .hotspots { position: absolute; inset: 0; display: flex; }
  .chart .hotspot { flex: 1 1 auto; position: relative; }
  .chart .hotspot:hover::before {
    content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px;
    background: var(--vscode-focusBorder); transform: translateX(-50%);
  }
  .chart .hotspot:hover::after {
    content: attr(data-tooltip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border);
    padding: 4px 6px; font-size: 11px; white-space: nowrap; border-radius: 4px; z-index: 1; margin-bottom: 4px;
  }
  table { width: calc(100% - 28px); margin: 0 14px 20px; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  .empty { padding: 24px 14px; opacity: 0.7; font-size: 13px; }
  .hidden { display: none !important; }
  .co2-intro { margin: 12px 14px 14px; font-size: 12px; opacity: 0.85; line-height: 1.5; max-width: 640px; }
  .co2-intro a { color: var(--vscode-textLink-foreground); }
  .co2-legend { display: flex; gap: 16px; margin: 0 14px 12px; font-size: 11px; opacity: 0.85; }
  .legend-item { display: flex; align-items: center; gap: 5px; }
  .legend-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .co2-headline { display: flex; flex-direction: column; gap: 8px; margin: 0 14px 20px; max-width: 480px; }
  .co2-headline-row { display: flex; align-items: center; gap: 8px; }
  .co2-headline-label { width: 128px; font-size: 11px; opacity: 0.8; flex: 0 0 auto; }
  .co2-headline-track { flex: 1; height: 14px; background: var(--vscode-editorWidget-background); border-radius: 4px; overflow: hidden; }
  .co2-headline-fill { height: 100%; border-radius: 4px; }
  .co2-headline-value { width: 90px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
  .co2-cell-bar { display: flex; align-items: center; gap: 6px; }
  .co2-cell-track { width: 60px; height: 8px; background: var(--vscode-editorWidget-background); border-radius: 3px; overflow: hidden; flex: 0 0 auto; }
  .co2-cell-fill { height: 100%; border-radius: 3px; }
  .conf-estimated { opacity: 0.65; font-style: italic; }
  .co2-calc-disclaimer { margin: 8px 14px 20px; font-size: 11px; font-style: italic; opacity: 0.7; max-width: 640px; }
</style>
</head>
<body>
<div id="tabbar">
  <div class="brand-block">
    <img class="brand-logo" src="${iconUri}" alt="easyHeadroom" />
  </div>
${
  showTabs
    ? `${headroomAvailable ? `  <button class="tab-btn${defaultTab === 'headroom' ? ' active' : ''}" id="tab-headroom" data-tab="headroom">
    <span class="tab-title">Headroom</span>
  </button>` : ''}
${rtkAvailable ? `  <button class="tab-btn${defaultTab === 'rtk' ? ' active' : ''}" id="tab-rtk" data-tab="rtk">
    <span class="tab-title">RTK</span>
    <span class="tab-metric" id="tab-rtk-metric">…</span>
  </button>` : ''}
${co2Available ? `  <button class="tab-btn${defaultTab === 'co2' ? ' active' : ''}" id="tab-co2" data-tab="co2">
    <span class="tab-title">CO₂</span>
    <span class="tab-metric" id="tab-co2-metric">…</span>
  </button>` : ''}`
    : ''
}
</div>
<div id="views">
${
  headroomAvailable
    ? `  <div class="view${showTabs && defaultTab !== 'headroom' ? ' hidden' : ''}" id="view-headroom">
    <div class="hidden" id="hr-stats"></div>
    <iframe src="${externalOrigin}/dashboard"></iframe>
  </div>`
    : ''
}
${
  rtkAvailable
    ? `  <div class="view${showTabs && defaultTab !== 'rtk' ? ' hidden' : ''}" id="view-rtk">
    <div class="rtk-toolbar">
      <label for="project-select">Project</label>
      <select id="project-select"><option value="">All projects</option></select>
    </div>
    <div class="empty hidden" id="rtk-empty">No RTK data yet — run some commands via RTK to see stats here.</div>
    <div id="rtk-content">
      <div class="cards" id="rtk-cards"></div>
      <div class="rtk-section-title">Daily</div>
      <div class="chart" id="rtk-daily"></div>
      <div class="rtk-section-title">Weekly</div>
      <div class="chart" id="rtk-weekly"></div>
      <div class="rtk-section-title">Monthly</div>
      <div class="chart" id="rtk-monthly"></div>
      <div class="rtk-section-title hidden" id="rtk-projects-title">Projects</div>
      <table class="hidden" id="rtk-projects-table"><thead><tr><th>Project</th><th>Commands</th><th>Saved tokens</th><th>Avg savings %</th></tr></thead><tbody></tbody></table>
    </div>
  </div>`
    : ''
}
${
  co2Available
    ? `  <div class="view${showTabs && defaultTab !== 'co2' ? ' hidden' : ''}" id="view-co2">
    <div class="co2-intro">
      <p>Indicative CO₂ estimate — not an official figure. Anthropic does not publish per-token
      carbon data. Grams below are derived from Headroom's own per-model token counts combined
      with public coefficients from <a href="https://carbon-llm.com/methodology">carbon-llm.com/methodology</a>.
      When a model isn't in that catalog, the closest same-tier Claude model's coefficient is used
      instead (marked "estimated"), falling back to a generic coefficient if no tier match exists.
      Treat these numbers as a rough order of magnitude, not a measurement.</p>
    </div>
    <div class="empty hidden" id="co2-empty">No CO₂ data yet — waiting for Headroom request activity.</div>
    <div class="hidden" id="co2-content">
      <div class="co2-legend" id="co2-legend"></div>
      <div class="co2-headline" id="co2-headline"></div>
      <div class="rtk-section-title">By model</div>
      <table id="co2-table"><thead><tr><th>Model</th><th>Confidence</th><th>CO₂ sent</th><th>CO₂ avoided (Headroom)</th><th>CO₂ avoided (RTK, est.)</th></tr></thead><tbody></tbody></table>
      <p class="co2-calc-disclaimer" id="co2-calc-disclaimer"></p>
    </div>
  </div>`
    : ''
}
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const tabs = Array.from(document.querySelectorAll('.tab-btn'));
  const views = { headroom: document.getElementById('view-headroom'), rtk: document.getElementById('view-rtk'), co2: document.getElementById('view-co2') };
  tabs.forEach((btn) => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    tabs.forEach((b) => b.classList.toggle('active', b === btn));
    Object.keys(views).forEach((key) => { if (views[key]) views[key].classList.toggle('hidden', key !== tab); });
  }));

  const projectSelect = document.getElementById('project-select');
  let projectsPopulated = false;
  // Cached across independent message streams (headroom:stats / rtk:data) so the CO2 tab can
  // combine them — see renderCo2().
  let latestCarbon = null;
  let latestRtkSaved;
  if (projectSelect) {
    projectSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'rtk:selectProject', project: projectSelect.value || null });
    });
  }

  function fmtNum(n) {
    if (n === undefined || n === null) return '–';
    const abs = Math.abs(n);
    const suffixes = [[1e9, 'G'], [1e6, 'M'], [1e3, 'K']];
    for (const [threshold, suffix] of suffixes) {
      if (abs >= threshold) {
        const scaled = n / threshold;
        const digits = Math.abs(scaled) >= 100 ? 0 : 1;
        return (Math.round(scaled * 10 ** digits) / 10 ** digits).toLocaleString() + suffix;
      }
    }
    const r = Math.round(n * 10) / 10;
    return r.toLocaleString();
  }
  function fmtPct(n) {
    return (n === undefined || n === null) ? '–' : (Math.round(n * 10) / 10) + '%';
  }
  function fmtGrams(g) {
    if (g === undefined || g === null) return '–';
    return g >= 1000 ? (Math.round(g / 10) / 100) + ' kg CO₂e' : Math.round(g) + ' g CO₂e';
  }
  // Compact form for tight spaces (tab-bar metric) — no space, no "CO2e" unit spelled out.
  function fmtGramsShort(g) {
    if (g === undefined || g === null) return '–';
    return g >= 1000 ? (Math.round(g / 10) / 100) + 'kg' : Math.round(g) + 'g';
  }
  function fmtUsd(n) {
    return (n === undefined || n === null) ? '–' : '$' + (Math.round(n * 100) / 100).toLocaleString();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderHeadroomStats(stats) {
    const el = document.getElementById('hr-stats');
    if (!el) return;
    if (!stats) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const cards = [
      ['Requests', fmtNum(stats.requests)],
      ['Cost saved', fmtUsd(stats.costSavedUsd)],
      ['Savings', fmtPct(stats.savingsPct)],
      ['Cache hit rate', fmtPct(stats.cacheHitRate)],
      ['Avg latency', fmtNum(stats.avgLatencyMs) + ' ms'],
    ];
    const history = stats.history || [];
    const spark = buildTrendAreaSvg(history, 'hr-spark-grad', '--vscode-charts-blue', 1.25);
    el.innerHTML = cards.map(([label, value, tooltip]) =>
      '<div class="card"' + (tooltip ? ' title="' + esc(tooltip) + '"' : '') + '><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>'
    ).join('') + (history.length ? '<div class="card spark-card"><div class="spark">' + spark + '</div><div class="label">Recent savings</div></div>' : '');
  }

  // Builds a filled area-under-line trend chart (gradient fill + a thin stroked line on top),
  // matching the look of Headroom's own dashboard trend charts rather than discrete bars.
  function buildTrendAreaSvg(values, gradId, colorVar, strokeWidth) {
    const n = values.length;
    if (n === 0) return '';
    const max = Math.max(1, ...values);
    const stepX = n > 1 ? 100 / (n - 1) : 0;
    const coords = values.map((v, i) => {
      const x = n > 1 ? i * stepX : 50;
      const y = 100 - Math.max(0, Math.min(100, (v / max) * 92));
      return x.toFixed(2) + ',' + y.toFixed(2);
    });
    const linePath = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c).join(' ');
    const areaPath = 'M' + coords[0].split(',')[0] + ',100 L' + coords.join(' L') + ' L' + coords[coords.length - 1].split(',')[0] + ',100 Z';
    return '<svg viewBox="0 0 100 100" preserveAspectRatio="none">'
      + '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="var(' + colorVar + ')" stop-opacity="0.45"/>'
      + '<stop offset="100%" stop-color="var(' + colorVar + ')" stop-opacity="0"/>'
      + '</linearGradient></defs>'
      + '<path d="' + areaPath + '" fill="url(#' + gradId + ')" stroke="none"/>'
      + '<path d="' + linePath + '" fill="none" stroke="var(' + colorVar + ')" stroke-width="' + (strokeWidth || 1.5) + '" vector-effect="non-scaling-stroke"/>'
      + '</svg>';
  }

  function renderCo2(carbon, rtkTotalSaved) {
    const empty = document.getElementById('co2-empty');
    const content = document.getElementById('co2-content');
    if (!empty || !content) return;
    if (!carbon || !carbon.perModel || carbon.perModel.length === 0) {
      empty.classList.remove('hidden');
      content.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    content.classList.remove('hidden');

    // RTK has no per-model attribution (see carbonFootprint.ts): its saved-token total is
    // allocated across models using Headroom's own sent-token mix as the best available proxy,
    // backing out each model's g/token coefficient from its existing sent totals.
    const totalSentTokens = carbon.perModel.reduce((sum, m) => sum + m.sentTokens, 0);
    const perModelRtkAvoided = (rtkTotalSaved > 0 && totalSentTokens > 0)
      ? carbon.perModel.map((m) => {
          if (!m.sentTokens) return 0;
          const coeffGramsPerToken = m.sentGrams / m.sentTokens;
          const weight = m.sentTokens / totalSentTokens;
          return rtkTotalSaved * weight * coeffGramsPerToken;
        })
      : null;
    const rtkAvoidedGrams = perModelRtkAvoided ? perModelRtkAvoided.reduce((a, b) => a + b, 0) : undefined;

    const legendEl = document.getElementById('co2-legend');
    if (legendEl) {
      const legendItem = (colorVar, label) =>
        '<span class="legend-item"><span class="legend-swatch" style="background: var(' + colorVar + ')"></span>' + esc(label) + '</span>';
      legendEl.innerHTML = legendItem('--vscode-charts-blue', 'CO₂ sent')
        + legendItem('--vscode-charts-green', 'CO₂ avoided (Headroom)')
        + (rtkAvoidedGrams !== undefined ? legendItem('--vscode-charts-purple', 'CO₂ avoided (RTK, est.)') : '');
    }

    const headlineEl = document.getElementById('co2-headline');
    if (headlineEl) {
      const maxHeadline = Math.max(1, carbon.totalSentGrams, carbon.totalAvoidedGrams, rtkAvoidedGrams || 0);
      const headlineRow = (label, grams, colorVar) =>
        '<div class="co2-headline-row"><div class="co2-headline-label">' + esc(label) + '</div>'
        + '<div class="co2-headline-track"><div class="co2-headline-fill" style="width: ' + Math.max(2, (grams / maxHeadline) * 100) + '%; background: var(' + colorVar + ')"></div></div>'
        + '<div class="co2-headline-value">' + esc(fmtGrams(grams)) + '</div></div>';
      headlineEl.innerHTML = headlineRow('Sent', carbon.totalSentGrams, '--vscode-charts-blue')
        + headlineRow('Avoided', carbon.totalAvoidedGrams, '--vscode-charts-green')
        + (rtkAvoidedGrams !== undefined ? headlineRow('Avoided (RTK, est.)', rtkAvoidedGrams, '--vscode-charts-purple') : '');
    }

    const tbody = document.querySelector('#co2-table tbody');
    if (tbody) {
      const maxSent = Math.max(1, ...carbon.perModel.map((m) => m.sentGrams));
      const maxAvoided = Math.max(1, ...carbon.perModel.map((m) => m.avoidedGrams));
      const maxRtkAvoided = Math.max(1, ...(perModelRtkAvoided || [0]));
      const barCell = (grams, max, colorVar) =>
        '<td><div class="co2-cell-bar"><div class="co2-cell-track"><div class="co2-cell-fill" style="width: '
        + (grams == null ? 0 : Math.max(2, (grams / max) * 100)) + '%; background: var(' + colorVar + ')"></div></div><span>' + esc(fmtGrams(grams)) + '</span></div></td>';
      tbody.innerHTML = carbon.perModel.map((m, i) => {
        const confClass = m.confidence === 'estimated' ? ' class="conf-estimated"' : '';
        const matchTitle = m.matchedCoefficientModel && m.matchedCoefficientModel !== m.model
          ? ' title="Matched to ' + esc(m.matchedCoefficientModel) + '\\'s coefficient (closest tier, or generic fallback)"'
          : '';
        return '<tr' + matchTitle + '><td>' + esc(m.model) + '</td><td><span' + confClass + '>' + esc(m.confidence) + '</span></td>'
          + barCell(m.sentGrams, maxSent, '--vscode-charts-blue') + barCell(m.avoidedGrams, maxAvoided, '--vscode-charts-green')
          + barCell(perModelRtkAvoided ? perModelRtkAvoided[i] : null, maxRtkAvoided, '--vscode-charts-purple') + '</tr>';
      }).join('');
    }

    const metricEl = document.getElementById('tab-co2-metric');
    if (metricEl) metricEl.textContent = fmtGramsShort(carbon.totalAvoidedGrams + (rtkAvoidedGrams || 0)) + ' avoided';

    const disclaimerEl = document.getElementById('co2-calc-disclaimer');
    if (disclaimerEl) {
      disclaimerEl.textContent = perModelRtkAvoided
        ? 'RTK\\'s own savings aren\\'t attributed to a model, so its CO₂ avoided (RTK, est.) figure is allocated across models using Headroom\\'s sent-token mix as a proxy — an extra layer of approximation on top of the Headroom figures above.'
        : '';
    }
  }

  function renderCards(summary) {
    const el = document.getElementById('rtk-cards');
    if (!el) return;
    const cards = [
      ['Commands', fmtNum(summary.total_commands)],
      ['Input tokens', fmtNum(summary.total_input)],
      ['Output tokens', fmtNum(summary.total_output)],
      ['Saved tokens', fmtNum(summary.total_saved)],
      ['Avg savings', fmtPct(summary.avg_savings_pct)],
      ['Avg exec time', fmtNum(summary.avg_time_ms) + ' ms'],
    ];
    el.innerHTML = cards.map(([label, value]) => '<div class="card"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>').join('');
  }

  function renderChart(elId, points, labelKey) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!points || points.length === 0) { el.innerHTML = '<div class="empty">No data</div>'; return; }
    const values = points.map((p) => p.saved_tokens || 0);
    const svg = buildTrendAreaSvg(values, elId + '-grad', '--vscode-charts-blue', 1.5);
    const hotspots = points.map((p) => {
      const label = p[labelKey] || '';
      const tooltip = label + ': ' + fmtNum(p.saved_tokens) + ' saved, ' + fmtPct(p.savings_pct) + ', ' + (p.commands || 0) + ' cmds';
      return '<div class="hotspot" data-tooltip="' + esc(tooltip) + '"></div>';
    }).join('');
    el.innerHTML = svg + '<div class="hotspots">' + hotspots + '</div>';
  }

  function renderProjects(projects) {
    const title = document.getElementById('rtk-projects-title');
    const tableEl = document.getElementById('rtk-projects-table');
    if (!title || !tableEl) return;
    if (!projects || projects.length === 0) {
      title.classList.add('hidden');
      tableEl.classList.add('hidden');
      return;
    }
    title.classList.remove('hidden');
    tableEl.classList.remove('hidden');
    tableEl.querySelector('tbody').innerHTML = projects.map((p) =>
      '<tr><td>' + esc(p.label || p.id_project) + '</td><td>' + fmtNum(p.commands) + '</td><td>' + fmtNum(p.saved_tokens) + '</td><td>' + fmtPct(p.avg_savings_pct) + '</td></tr>'
    ).join('');
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'headroom:stats') {
      renderHeadroomStats(msg.stats);
      latestCarbon = (msg.stats && msg.stats.carbon) || null;
      renderCo2(latestCarbon, latestRtkSaved);
      return;
    }
    if (msg.type !== 'rtk:data') return;
    const empty = document.getElementById('rtk-empty');
    const content = document.getElementById('rtk-content');
    if (!msg.stats) {
      if (empty) empty.classList.remove('hidden');
      if (content) content.classList.add('hidden');
      latestRtkSaved = undefined;
    } else {
      if (empty) empty.classList.add('hidden');
      if (content) content.classList.remove('hidden');
      renderCards(msg.stats.summary);
      renderChart('rtk-daily', msg.stats.daily, 'date');
      renderChart('rtk-weekly', msg.stats.weekly, 'week_start');
      renderChart('rtk-monthly', msg.stats.monthly, 'month');
      renderProjects(msg.selected ? null : msg.projects);
      if (!msg.selected) {
        const metricEl = document.getElementById('tab-rtk-metric');
        if (metricEl) metricEl.textContent = fmtNum(msg.stats.summary.total_saved) + ' saved · ' + fmtPct(msg.stats.summary.avg_savings_pct);
      }
      // RTK has no per-model attribution (see carbonFootprint.ts), so its saved-token count is
      // fed into the CO2 tab as an unattributed pool — renderCo2() allocates it across models
      // using Headroom's own sent-token mix as the best available proxy.
      latestRtkSaved = msg.stats.summary ? msg.stats.summary.total_saved : undefined;
    }
    renderCo2(latestCarbon, latestRtkSaved);
    if (projectSelect && !projectsPopulated && msg.projects && msg.projects.length) {
      msg.projects.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id_project;
        opt.textContent = p.label || p.id_project;
        projectSelect.appendChild(opt);
      });
      projectsPopulated = true;
    }
  });

  if (document.getElementById('view-rtk')) {
    vscode.postMessage({ type: 'rtk:init' });
  }
})();
</script>
</body>
</html>`;
}

async function openDashboard(context: vscode.ExtensionContext): Promise<void> {
  const headroomAvailable = config.headroomEnabled();
  const rtkAvailable = rtkDashboardAvailable();

  if (!headroomAvailable && !rtkAvailable) {
    void vscode.window.showInformationMessage('easy-headroom: nothing to show — enable RTK and/or Headroom first.');
    return;
  }

  let targetBase = '';
  if (headroomAvailable) {
    targetBase = config.headroomMode() === 'local'
      ? `http://127.0.0.1:${config.headroomLocalPort()}`
      : config.headroomRemoteUrl().replace(/\/$/, '');

    if (!targetBase) {
      void vscode.window.showErrorMessage('easy-headroom: headroom.remoteUrl is not set.');
      return;
    }
  }

  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    'easyHeadroomDashboard',
    'easyHeadroom Dashboard',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
    }
  );
  const panel = dashboardPanel;
  panel.onDidDispose(() => {
    dashboardPanel = undefined;
    onHeadroomStats = undefined;
  });

  let externalOrigin = '';
  if (headroomAvailable) {
    onHeadroomStats = (raw) => {
      void extractHeadroomStats(raw).then((stats) => {
        void panel.webview.postMessage({ type: 'headroom:stats', stats });
      });
    };
    const proxyPort = await startDashboardProxy(targetBase);
    const external = await vscode.env.asExternalUri(
      vscode.Uri.parse(`http://127.0.0.1:${proxyPort}`)
    );
    externalOrigin = external.toString(true).replace(/\/$/, '');
  }

  // The RTK tab never fetches its own data over the network from inside the webview (no
  // connect-src needed in the CSP above, and no Remote-SSH port-forwarding concerns like the
  // Headroom iframe has) — the extension host resolves it (local DB read or remote aggregator
  // fetch, see rtkStats.ts) and pushes the result in, the same trust boundary as every other
  // filesystem/network access this extension does.
  panel.webview.onDidReceiveMessage(async (msg: { type?: string; project?: string | null }) => {
    if (msg?.type !== 'rtk:init' && msg?.type !== 'rtk:selectProject') return;
    const project = msg.type === 'rtk:selectProject' && msg.project ? msg.project : undefined;
    const [stats, projects] = await Promise.all([getRtkStats(project), getRtkProjects()]);
    void panel.webview.postMessage({ type: 'rtk:data', stats: stats ?? null, projects, selected: project ?? null });
  });

  const iconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png'));
  panel.webview.html = renderDashboardHtml({
    headroomAvailable,
    rtkAvailable,
    externalOrigin,
    iconUri: iconUri.toString(),
    cspSource: panel.webview.cspSource,
  });
}

function openSettings(): void {
  void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vitalyn.easy-headroom');
}

async function showStatusBarMenu(context: vscode.ExtensionContext): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(dashboard) Open Dashboard', action: 'dashboard' as const },
      { label: '$(gear) Open Settings', action: 'settings' as const },
    ],
    { placeHolder: 'easy-headroom' }
  );
  if (!picked) return;
  if (picked.action === 'dashboard') {
    await openDashboard(context);
  } else {
    openSettings();
  }
}

async function selectRtkVersion(): Promise<void> {
  const versions = await listRtkReleases();
  if (versions.length === 0) {
    void vscode.window.showErrorMessage('easy-headroom: could not fetch RTK releases.');
    return;
  }
  const picked = await vscode.window.showQuickPick(['(latest)', ...versions], {
    placeHolder: 'Select an RTK version to pin (or latest)',
  });
  if (picked === undefined) return;
  await config.setRtkPinnedVersion(picked === '(latest)' ? '' : picked);
  void vscode.window.showInformationMessage(
    'easy-headroom: reload the window to reinstall RTK at the selected version.'
  );
}

async function selectHeadroomVersion(): Promise<void> {
  const versions = await listHeadroomReleases();
  if (versions.length === 0) {
    void vscode.window.showErrorMessage('easy-headroom: could not fetch Headroom releases.');
    return;
  }
  const picked = await vscode.window.showQuickPick(['(latest)', ...versions], {
    placeHolder: 'Select a Headroom version to pin (or latest)',
  });
  if (picked === undefined) return;
  await config.setHeadroomPinnedVersion(picked === '(latest)' ? '' : picked);
  void vscode.window.showInformationMessage(
    'easy-headroom: reload the window to reinstall Headroom at the selected version.'
  );
}

async function uninstallCleanup(context: vscode.ExtensionContext, daemon: ProxyDaemonManager): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'This removes the RTK integration for every configured agent and the Headroom wrap from ' +
      '~/.claude/settings.json, deletes the downloaded RTK binary and Headroom venv, and stops the ' +
      'shared proxy daemon if running. Continue?',
    { modal: true },
    'Clean Up'
  );
  if (confirmed !== 'Clean Up') return;

  await daemon.stop();
  for (const agent of config.rtkAgents()) {
    await removeRtkIntegration(agent);
  }
  await removeHeadroomWrap();
  await clearProjectEnv(['ANTHROPIC_BASE_URL', 'HEADROOM_OUTPUT_SHAPER']);

  const paths = storagePaths(context);
  await fs.rm(paths.rtkBinDir, { recursive: true, force: true });
  await fs.rm(paths.headroomVenvDir, { recursive: true, force: true });

  void vscode.window.showInformationMessage('easy-headroom: cleanup complete.');
}

async function connectionTestBeforeRemote(): Promise<void> {
  const url = config.headroomRemoteUrl();
  if (!url) return;
  const healthy = await checkHealth(url);
  if (!healthy) {
    void vscode.window.showWarningMessage(
      `easy-headroom: could not reach ${url}/health — check headroom.remoteUrl before relying on remote mode.`
    );
  }
}

export function registerCommands(context: vscode.ExtensionContext, daemon: ProxyDaemonManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('easy-headroom.openDashboard', () => openDashboard(context)),
    vscode.commands.registerCommand('easy-headroom.openSettings', openSettings),
    vscode.commands.registerCommand('easy-headroom.statusBarMenu', () => showStatusBarMenu(context)),
    vscode.commands.registerCommand('easy-headroom.stopProxy', () => daemon.stop()),
    vscode.commands.registerCommand('easy-headroom.selectRtkVersion', selectRtkVersion),
    vscode.commands.registerCommand('easy-headroom.selectHeadroomVersion', selectHeadroomVersion),
    vscode.commands.registerCommand('easy-headroom.uninstallCleanup', () => uninstallCleanup(context, daemon))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('easy-headroom.headroom.remoteUrl') && config.headroomMode() === 'remote') {
        void connectionTestBeforeRemote();
      }
    })
  );
}
