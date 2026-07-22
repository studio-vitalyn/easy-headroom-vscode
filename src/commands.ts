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
}

const STATS_HISTORY_POINTS = 40;

/**
 * Headroom's /stats response is an internal, undocumented shape (no schema/versioning contract) —
 * read defensively in this one place, so a field rename on Headroom's side only breaks this
 * function instead of scattering optional-chaining across the webview script.
 */
function extractHeadroomStats(raw: unknown): HeadroomLiveStats {
  const r = raw as Record<string, any> | null | undefined;
  const summary = r?.summary;
  const history: number[] = Array.isArray(r?.savings_history)
    ? r.savings_history
        .slice(-STATS_HISTORY_POINTS)
        .map((p: unknown) => (Array.isArray(p) && typeof p[1] === 'number' ? p[1] : 0))
    : [];
  return {
    requests: typeof summary?.api_requests === 'number' ? summary.api_requests : undefined,
    costSavedUsd: typeof summary?.cost?.total_saved_usd === 'number' ? summary.cost.total_saved_usd : undefined,
    savingsPct: typeof summary?.cost?.savings_pct === 'number' ? summary.cost.savings_pct : undefined,
    cacheHitRate: typeof r?.prefix_cache?.totals?.hit_rate === 'number' ? r.prefix_cache.totals.hit_rate : undefined,
    avgLatencyMs: typeof r?.latency?.average_ms === 'number' ? r.latency.average_ms : undefined,
    history,
  };
}

function renderDashboardHtml(opts: { headroomAvailable: boolean; rtkAvailable: boolean; externalOrigin: string }): string {
  const { headroomAvailable, rtkAvailable, externalOrigin } = opts;
  const nonce = getNonce();
  // Only show a tab switcher when both sources are actually configured — otherwise there's
  // nothing to switch between, so skip straight to whichever single view applies.
  const showTabs = headroomAvailable && rtkAvailable;
  const defaultTab = headroomAvailable ? 'headroom' : 'rtk';
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
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
  #tabbar { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border); flex: 0 0 auto; }
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
</style>
</head>
<body>
${
  showTabs
    ? `<div id="tabbar">
  <button class="tab-btn${defaultTab === 'headroom' ? ' active' : ''}" id="tab-headroom" data-tab="headroom">
    <span class="tab-title">Headroom</span>
  </button>
  <button class="tab-btn${defaultTab === 'rtk' ? ' active' : ''}" id="tab-rtk" data-tab="rtk">
    <span class="tab-title">RTK</span>
    <span class="tab-metric" id="tab-rtk-metric">…</span>
  </button>
</div>`
    : ''
}
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
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const tabs = Array.from(document.querySelectorAll('.tab-btn'));
  const views = { headroom: document.getElementById('view-headroom'), rtk: document.getElementById('view-rtk') };
  tabs.forEach((btn) => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    tabs.forEach((b) => b.classList.toggle('active', b === btn));
    Object.keys(views).forEach((key) => { if (views[key]) views[key].classList.toggle('hidden', key !== tab); });
  }));

  const projectSelect = document.getElementById('project-select');
  let projectsPopulated = false;
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
    el.innerHTML = cards.map(([label, value]) =>
      '<div class="card"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>'
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
      return;
    }
    if (msg.type !== 'rtk:data') return;
    const empty = document.getElementById('rtk-empty');
    const content = document.getElementById('rtk-content');
    if (!msg.stats) {
      if (empty) empty.classList.remove('hidden');
      if (content) content.classList.add('hidden');
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
    }
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

async function openDashboard(): Promise<void> {
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
    'easy-headroom Dashboard',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const panel = dashboardPanel;
  panel.onDidDispose(() => {
    dashboardPanel = undefined;
    onHeadroomStats = undefined;
  });

  let externalOrigin = '';
  if (headroomAvailable) {
    onHeadroomStats = (raw) => {
      void panel.webview.postMessage({ type: 'headroom:stats', stats: extractHeadroomStats(raw) });
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

  panel.webview.html = renderDashboardHtml({ headroomAvailable, rtkAvailable, externalOrigin });
}

function openSettings(): void {
  void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vitalyn.easy-headroom');
}

async function showStatusBarMenu(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(dashboard) Open Dashboard', action: 'dashboard' as const },
      { label: '$(gear) Open Settings', action: 'settings' as const },
    ],
    { placeHolder: 'easy-headroom' }
  );
  if (!picked) return;
  if (picked.action === 'dashboard') {
    await openDashboard();
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
    vscode.commands.registerCommand('easy-headroom.openDashboard', openDashboard),
    vscode.commands.registerCommand('easy-headroom.openSettings', openSettings),
    vscode.commands.registerCommand('easy-headroom.statusBarMenu', showStatusBarMenu),
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
