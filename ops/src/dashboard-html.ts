/**
 * Internal ops dashboard markup + styles.
 * Visual system: Nexus dark palette + teal accent (see repo .cursor/skills/design-foundations).
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>AgentOS Ops — Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #171614;
    --surface: #1c1b19;
    --surface-alt: #201f1d;
    --border: #393836;
    --text: #cdccca;
    --text-muted: #797876;
    --text-faint: #5a5957;
    --primary: #4f98a3;
    --primary-hover: #227f8b;
    --success: #6daa45;
    --warning: #bb653b;
    --error: #d163a7;
    --chart-teal: #20808d;
    --chart-rust: #a84b2f;
    --radius: 10px;
    --radius-sm: 6px;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html { font-size: 16px; -webkit-font-smoothing: antialiased; }

  body {
    font-family: "DM Sans", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }

  .mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }

  .container { max-width: 1400px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  /* Header */
  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    padding-bottom: var(--space-4);
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .header__title {
    font-size: 1.375rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .header__title span { color: var(--primary); font-weight: 700; }

  .header__meta { font-size: 0.8125rem; color: var(--text-muted); margin-top: var(--space-1); }

  .header__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 0.8125rem;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }

  .checkbox-label input { accent-color: var(--primary); width: 1rem; height: 1rem; }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
  }

  .btn:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .btn--primary {
    background: var(--primary);
    color: #171614;
    border-color: var(--primary);
  }

  .btn--primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: #fff; }

  .btn--ghost {
    background: var(--surface-alt);
    color: var(--text-muted);
    border-color: var(--border);
  }

  .btn--ghost:hover {
    background: var(--surface);
    color: var(--text);
    border-color: var(--text-faint);
  }

  /* Grids */
  .grid { display: grid; gap: var(--space-4); margin-bottom: var(--space-5); }
  .grid-4 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
  .grid-3 { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .grid-2 { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }

  /* Cards (KPI pattern: value dominant, label muted) */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
    transition: border-color 0.2s ease;
  }

  .card:hover { border-color: var(--text-faint); }

  .card__label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }

  .card__value {
    font-size: 1.75rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1.15;
  }

  .card__sub { font-size: 0.8125rem; color: var(--text-muted); margin-top: var(--space-2); }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .badge--ok { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
  .badge--warn { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
  .badge--bad { background: color-mix(in srgb, var(--error) 18%, transparent); color: var(--error); }

  /* Sections */
  .section { margin-bottom: var(--space-6); }

  .section__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .section__title { font-size: 1rem; font-weight: 600; color: var(--text); }

  /* Tabs */
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--surface-alt);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 0.375rem 0.875rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }

  .tab:hover { color: var(--text); background: color-mix(in srgb, var(--primary) 8%, transparent); }

  .tab:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

  .tab--active {
    background: var(--surface);
    color: var(--primary);
    border-color: var(--border);
    font-weight: 600;
  }

  /* Tables */
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }

  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    color: var(--text-faint);
    font-weight: 500;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  tbody tr:hover td { background: color-mix(in srgb, var(--primary) 5%, transparent); }

  .right { text-align: right; }
  .truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }

  .bal-pos { color: var(--success); font-weight: 600; }
  .bal-neg { color: var(--error); font-weight: 600; }

  .metric-val { font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .metric-val--ok { color: var(--success); }
  .metric-val--warn { color: var(--warning); }
  .metric-val--bad { color: var(--error); }

  /* Model usage rows */
  .model-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    font-size: 0.8125rem;
  }
  .model-row:last-child { border-bottom: none; }

  .pill-list { list-style: none; display: flex; flex-direction: column; gap: var(--space-2); max-height: 220px; overflow-y: auto; }
  .pill-list li {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: var(--space-3); font-size: 0.8125rem; padding: var(--space-1) 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .pill-list li span:first-child { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
  .pill-list .cnt { font-weight: 700; color: var(--primary); font-variant-numeric: tabular-nums; flex-shrink: 0; }

  .hygiene-line { display: flex; justify-content: space-between; font-size: 0.8125rem; padding: var(--space-2) 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
  .hygiene-line:last-child { border-bottom: none; }
  .text-muted { color: var(--text-muted); }

  /* Loading */
  .loading { color: var(--text-faint); padding: var(--space-6); text-align: center; }

  @keyframes pulse-soft {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  .pulse { animation: pulse-soft 2s ease-in-out infinite; }

  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; opacity: 0.85; }
    .btn, .tab, .card { transition: none; }
  }

  /* Sentry-style command shell */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    background: color-mix(in srgb, var(--bg) 92%, black);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
    margin: calc(-1 * var(--space-5)) calc(-1 * var(--space-4)) var(--space-5);
    padding: var(--space-3) var(--space-4);
  }

  .topbar__row {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .topbar__brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .crumb { font-size: 0.8125rem; color: var(--text-muted); }
  .crumb strong { color: var(--text); font-weight: 600; }
  .crumb span { color: var(--primary); font-weight: 700; }

  .env-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--primary) 15%, transparent);
    color: var(--primary);
    border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
  }

  .search {
    flex: 1;
    min-width: 180px;
    max-width: 360px;
    padding: 0.45rem 0.75rem;
    font-size: 0.8125rem;
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-alt);
    color: var(--text);
  }

  .search:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
    border-color: var(--primary);
  }

  .search::placeholder { color: var(--text-faint); }

  #issues, #performance, #explore { scroll-margin-top: 72px; }

  .issue-feed { display: flex; flex-direction: column; gap: var(--space-2); }
  .issue-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    border-left-width: 3px;
    cursor: default;
    transition: background-color 0.15s ease;
  }
  .issue-row:hover { background: var(--surface-alt); }
  .issue-row--fatal { border-left-color: var(--error); }
  .issue-row--error { border-left-color: var(--error); }
  .issue-row--warn { border-left-color: var(--warning); }
  .issue-row--ok { border-left-color: var(--success); }
  .issue-row__title { font-weight: 600; font-size: 0.875rem; }
  .issue-row__meta { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
  .issue-row__count { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }

  .perf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-5); }
  .hbar { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
  .hbar__label { width: 2rem; font-size: 0.75rem; color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
  .hbar__track {
    flex: 1;
    height: 1.5rem;
    background: var(--surface-alt);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    border: 1px solid var(--border);
  }
  .hbar__fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.35s ease;
    min-width: 2px;
  }
  .hbar__val {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text);
    text-shadow: 0 0 6px var(--bg);
  }

  .throughput {
    padding: var(--space-3) 0;
  }
  .throughput__chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 100px;
    padding-top: var(--space-2);
  }
  .throughput__bar {
    flex: 1;
    min-width: 3px;
    max-width: 24px;
    background: linear-gradient(180deg, var(--primary), color-mix(in srgb, var(--primary) 40%, var(--bg)));
    border-radius: 2px 2px 0 0;
    opacity: 0.85;
    transition: opacity 0.15s ease;
  }
  .throughput__bar:hover { opacity: 1; }
  .throughput__caption { font-size: 0.75rem; color: var(--text-muted); margin-top: var(--space-2); }

  .regressed-table { font-size: 0.75rem; }
  .regressed-table td { white-space: nowrap; }
</style>
</head>
<body>
<header class="topbar" role="banner">
  <div class="topbar__row">
    <div class="topbar__brand">
      <span class="crumb"><span>AgentOS</span> / <strong>Ops</strong></span>
      <span class="env-badge" title="Internal command center">Production</span>
    </div>
    <input type="search" class="search" id="explore-filter" placeholder="Filter current table…" autocomplete="off" aria-label="Filter table rows">
    <div class="header__actions" style="margin:0">
      <label class="checkbox-label">
        <input type="checkbox" id="auto-refresh" checked>
        Live (30s)
      </label>
      <button type="button" class="btn btn--primary" onclick="loadAll()">Refresh</button>
    </div>
  </div>
</header>

<main class="container">
  <p class="header__meta" id="updated" aria-live="polite" style="margin-bottom:var(--space-4)">Loading…</p>

  <section class="section" id="issues" aria-labelledby="issues-h">
    <div class="section__head">
      <h2 id="issues-h" class="section__title">Issues &amp; signals</h2>
      <span class="header__meta">Sentry-style triage — what needs attention right now</span>
    </div>
    <div class="issue-feed" id="issue-feed"></div>
    <div class="card table-wrap" style="margin-top: var(--space-4);">
      <div class="card__label">Regressed turns (24h)</div>
      <p class="card__sub" style="margin-bottom:8px">Refusals, <span class="mono">errors</span>, or middleware warnings</p>
      <div id="regressed-turns" class="loading">Loading…</div>
    </div>
  </section>

  <section class="section" id="performance" aria-labelledby="perf-h">
    <div class="section__head">
      <h2 id="perf-h" class="section__title">Performance</h2>
      <span class="header__meta">Turn latency percentiles · last 24 hours</span>
    </div>
    <div class="perf-grid">
      <div class="card" id="perf-wall-card">
        <div class="card__label">Wall time (full turn)</div>
        <div id="perf-wall" class="pulse">Loading…</div>
      </div>
      <div class="card" id="perf-llm-card">
        <div class="card__label">LLM time only</div>
        <div id="perf-llm" class="pulse">Loading…</div>
      </div>
      <div class="card">
        <div class="card__label">Throughput</div>
        <div class="throughput" id="throughput-wrap">
          <div class="throughput__chart" id="throughput-chart"></div>
          <p class="throughput__caption" id="throughput-caption"></p>
        </div>
      </div>
    </div>
  </section>

  <div class="grid grid-4" id="overview-cards" aria-label="24 hour overview">
    <div class="card"><div class="card__label">Sessions (24h)</div><div class="card__value pulse">—</div></div>
    <div class="card"><div class="card__label">Cost (24h)</div><div class="card__value pulse">—</div></div>
    <div class="card"><div class="card__label">Turns (24h)</div><div class="card__value pulse">—</div></div>
    <div class="card"><div class="card__label">Tokens (24h)</div><div class="card__value pulse">—</div></div>
  </div>

  <div class="grid grid-3" id="health-cards">
    <div class="card">
      <div class="card__label">Queue health</div>
      <div id="queue-health" class="pulse">Loading…</div>
    </div>
    <div class="card">
      <div class="card__label">Billing accuracy</div>
      <div id="billing-accuracy" class="pulse">Loading…</div>
    </div>
    <div class="card">
      <div class="card__label">Model usage (24h)</div>
      <div id="model-usage" class="pulse">Loading…</div>
    </div>
  </div>

  <section class="section" aria-labelledby="turn-intel-heading">
    <div class="section__head">
      <h2 id="turn-intel-heading" class="section__title">Turn intelligence (24h)</h2>
      <span class="header__meta">Per-turn telemetry from <span class="mono">turns</span> — refusals, tools, cache, LLM vs wall time</span>
    </div>
    <div class="grid grid-4" id="turn-kpis"></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card__label">Session hygiene (24h)</div>
        <div id="session-hygiene" class="pulse">Loading…</div>
      </div>
      <div class="card">
        <div class="card__label">Stop reasons</div>
        <ul class="pill-list" id="stop-reasons"></ul>
      </div>
      <div class="card">
        <div class="card__label">Execution modes</div>
        <ul class="pill-list" id="exec-modes"></ul>
      </div>
    </div>
    <div class="card table-wrap" style="margin-bottom: var(--space-5);">
      <div class="card__label">Hot tools (24h)</div>
      <div id="top-tools" class="loading">Loading…</div>
    </div>
  </section>

  <section class="section" aria-labelledby="credits-heading">
    <div class="section__head">
      <h2 id="credits-heading" class="section__title">Org credits</h2>
    </div>
    <div class="card table-wrap">
      <div id="credits-table" class="loading">Loading…</div>
    </div>
  </section>

  <section class="section" id="explore" aria-labelledby="activity-heading">
    <div class="section__head">
      <h2 id="activity-heading" class="section__title">Explore</h2>
      <div class="tabs" role="tablist" aria-label="Data tables">
        <button type="button" class="tab tab--active" role="tab" data-tab="sessions" aria-selected="true" onclick="showTab('sessions', this)">Sessions</button>
        <button type="button" class="tab" role="tab" data-tab="billing" aria-selected="false" onclick="showTab('billing', this)">Billing</button>
        <button type="button" class="tab" role="tab" data-tab="turns" aria-selected="false" onclick="showTab('turns', this)">Turns</button>
        <button type="button" class="tab" role="tab" data-tab="events" aria-selected="false" onclick="showTab('events', this)">Runtime</button>
        <button type="button" class="tab" role="tab" data-tab="middleware" aria-selected="false" onclick="showTab('middleware', this)">Middleware</button>
        <button type="button" class="tab" role="tab" data-tab="audit" aria-selected="false" onclick="showTab('audit', this)">Audit</button>
        <button type="button" class="tab" role="tab" data-tab="tables" aria-selected="false" onclick="showTab('tables', this)">DB stats</button>
      </div>
    </div>
    <div class="card table-wrap">
      <div id="table-content" class="loading">Loading…</div>
    </div>
  </section>
</main>

<script>
let currentTab = 'sessions';
let refreshTimer;

function fmt(n, d) { d = d === undefined ? 2 : d; return Number(n || 0).toFixed(d); }
function fmtK(n) {
  var v = Number(n || 0);
  return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v);
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function ago(ts) {
  if (!ts) return '—';
  var s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

async function api(path) {
  var r = await fetch(path);
  return r.json();
}

function overviewCard(title, value, subHtml) {
  return '<div class="card"><div class="card__label">' + title + '</div><div class="card__value">' + value + '</div><div class="card__sub">' + subHtml + '</div></div>';
}

function jumpExplore(tab) {
  var btn = document.querySelector('.tab[data-tab="' + tab + '"]');
  if (btn) {
    showTab(tab, btn);
    var ex = document.getElementById('explore');
    if (ex) ex.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  setTimeout(applyTableFilter, 100);
}

function jumpExploreFromBtn(el) {
  var tab = el && el.getAttribute('data-go-tab');
  if (tab) jumpExplore(tab);
}

function issueRow(level, title, meta, count, exploreTab) {
  var lvl = level === 'fatal' ? 'fatal' : level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'ok';
  var btn = exploreTab
    ? '<button type="button" class="btn btn--ghost" style="font-size:11px;padding:0.25rem 0.5rem" data-go-tab="' + escapeHtml(exploreTab) + '" onclick="jumpExploreFromBtn(this)">Explore</button>'
    : '';
  return '<div class="issue-row issue-row--' + lvl + '">' +
    '<div><div class="issue-row__title">' + escapeHtml(title) + '</div><div class="issue-row__meta">' + meta + '</div></div>' +
    '<div style="display:flex;align-items:center;gap:10px"><span class="issue-row__count">' + count + '</span>' + btn + '</div></div>';
}

function renderIssueFeed(tsum, qh, overview) {
  var b = overview.billing || {};
  var turns24 = Number(tsum.turns_24h || 0);
  var te = Number(tsum.turns_with_errors || 0);
  var tr = Number(tsum.refusals_24h || 0);
  var tmw = Number(tsum.turns_with_mw_warnings || 0);
  var orphan = Number(qh.orphan_sessions_1h || 0);
  var ztok = Number(qh.zero_token_billing_1h || 0);
  var z24 = Number(b.zero_token_24h || 0);

  var html = '';
  html += issueRow(te > 0 ? 'error' : 'ok', 'Turns with errors (24h)', 'Non-empty <span class="mono">errors</span> on turn rows', te, 'turns');
  html += issueRow(tr > 0 ? 'warn' : 'ok', 'Model refusals (24h)', 'Safety / policy refusals · ' + (turns24 ? Math.round((tr / turns24) * 1000) / 10 : 0) + '% of turns', tr, 'turns');
  html += issueRow(tmw > 0 ? 'warn' : 'ok', 'Middleware warnings (24h)', 'Loop or guardrail signals on turns', tmw, 'middleware');
  html += issueRow(orphan > 0 ? 'error' : 'ok', 'Orphan sessions (1h)', 'Sessions with no turns yet', orphan, 'sessions');
  html += issueRow(ztok > 0 ? 'warn' : 'ok', 'Zero-token billing (1h)', 'Possible ingest mismatch', ztok, 'billing');
  html += issueRow(z24 > 0 ? 'warn' : 'ok', 'Zero-token billing rows (24h)', (b.last_24h || 0) + ' billing rows in window', z24, 'billing');
  document.getElementById('issue-feed').innerHTML = html;
}

function renderPerfBars(data, color) {
  if (!data || !data.samples) {
    return '<p class="card__sub">No samples in the last 24 hours.</p>';
  }
  var p99 = Math.max(Number(data.p99 || 0), 1);
  function row(label, val) {
    var v = val != null ? Number(val) : 0;
    var pct = Math.min(100, Math.round((v / p99) * 100));
    return '<div class="hbar"><span class="hbar__label">' + label + '</span><div class="hbar__track"><div class="hbar__fill" style="width:' + pct + '%;background:' + color + '"></div>' +
      '<span class="hbar__val">' + (val != null ? val + 'ms' : '—') + '</span></div></div>';
  }
  return '<p class="card__sub" style="margin-bottom:10px">' + data.samples + ' samples · scale = p99</p>' +
    row('p50', data.p50) + row('p75', data.p75) + row('p95', data.p95) + row('p99', data.p99);
}

function renderPerformance(perf) {
  var w = document.getElementById('perf-wall');
  var l = document.getElementById('perf-llm');
  w.innerHTML = renderPerfBars(perf.wall, 'var(--chart-teal)');
  l.innerHTML = renderPerfBars(perf.llm, 'var(--chart-rust)');
  w.classList.remove('pulse');
  l.classList.remove('pulse');
}

function renderThroughput(rows) {
  var chart = document.getElementById('throughput-chart');
  var cap = document.getElementById('throughput-caption');
  if (!rows || !rows.length) {
    chart.innerHTML = '';
    cap.textContent = 'No turns in the last 24 hours.';
    return;
  }
  var max = 1;
  rows.forEach(function (r) { max = Math.max(max, Number(r.turns || 0)); });
  chart.innerHTML = rows.map(function (r) {
    var n = Number(r.turns || 0);
    var h = Math.max(4, Math.round((n / max) * 100));
    var t = '';
    try { t = new Date(r.hour).toLocaleString(undefined, { hour: '2-digit', day: 'numeric', month: 'short' }); } catch (e) { t = String(r.hour); }
    return '<div class="throughput__bar" style="height:' + h + '%" title="' + escapeHtml(t + ' · ' + n + ' turns') + '"></div>';
  }).join('');
  var total = rows.reduce(function (s, r) { return s + Number(r.turns || 0); }, 0);
  cap.textContent = total.toLocaleString() + ' turns in ' + rows.length + ' hourly buckets (browser-local time labels).';
}

async function loadRegressedTurns() {
  var el = document.getElementById('regressed-turns');
  try {
    var d = await api('/api/turns/regressed-recent');
    if (!d.length) {
      el.innerHTML = '<p class="card__sub">No regressed turns in the last 24 hours.</p>';
      return;
    }
    el.innerHTML = '<table class="regressed-table"><thead><tr><th>When</th><th>Session</th><th class="right">#</th><th>Model</th><th class="right">Err</th><th>Refusal</th><th>Stop</th><th class="right">Wall ms</th></tr></thead><tbody>' +
      d.map(function (r) {
        return '<tr><td class="mono">' + ago(r.created_at) + '</td><td class="mono truncate">' + escapeHtml(r.session_id) + '</td><td class="right">' + r.turn_number + '</td><td class="mono">' + escapeHtml((r.model_used || '').split('/').pop()) + '</td><td class="right">' + (r.error_count || 0) + '</td><td>' + (r.refusal ? '<span class="badge badge--warn">yes</span>' : '—') + '</td><td class="mono">' + escapeHtml((r.stop_reason || '').slice(0, 16)) + '</td><td class="right">' + fmt(r.latency_ms, 0) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } catch (e) {
    el.innerHTML = '<p class="card__sub">Could not load regressed turns.</p>';
  }
}

function renderOverviewCards(d) {
  var s = d.sessions;
  var b = d.billing;
  document.getElementById('overview-cards').innerHTML = [
    overviewCard('Sessions (24h)', s.last_24h, s.last_1h + ' last hour · ' + s.total + ' total'),
    overviewCard('Cost (24h)', '$' + fmt(s.cost_24h), 'Avg latency ' + fmt(s.avg_latency_24h, 1) + 's'),
    overviewCard('Turns (24h)', d.turns.last_24h, d.turns.total + ' total'),
    overviewCard('Tokens (24h)', fmtK(b.input_tokens_24h) + ' in / ' + fmtK(b.output_tokens_24h) + ' out',
      b.zero_token_24h > 0
        ? '<span class="badge badge--bad">' + b.zero_token_24h + ' zero-token records</span>'
        : '<span class="badge badge--ok">All records have tokens</span>'),
  ].join('');
}

function renderQueueHealth(d) {
  var el = document.getElementById('queue-health');
  var orphan = d.orphan_sessions_1h;
  var zero = d.zero_token_billing_1h;
  var ev = d.event_breakdown_1h || [];
  var evHtml = '';
  if (ev.length) {
    evHtml = '<div class="card__sub" style="margin-top:10px">Runtime events (1h)</div><div style="font-size:0.75rem;color:var(--text-muted);line-height:1.5">' +
      ev.slice(0, 8).map(function (x) {
        return '<span class="mono">' + escapeHtml(String(x.event_type || '')) + '</span> <strong>' + x.cnt + '</strong>';
      }).join(' · ') +
      '</div>';
  }
  el.innerHTML =
    '<div style="margin-bottom:8px">' +
      (orphan === 0 ? '<span class="badge badge--ok">No orphan sessions</span>' : '<span class="badge badge--bad">' + orphan + ' orphan sessions (no turns)</span>') +
    '</div>' +
    '<div>' +
      (zero === 0 ? '<span class="badge badge--ok">All billing has tokens</span>' : '<span class="badge badge--warn">' + zero + ' zero-token billing (1h)</span>') +
    '</div>' +
    evHtml;
  el.classList.remove('pulse');
}

function renderBillingAccuracy(d) {
  var el = document.getElementById('billing-accuracy');
  var b = d.billing;
  var pct = b.last_24h > 0 ? Math.round((1 - b.zero_token_24h / b.last_24h) * 100) : 100;
  var cls = pct === 100 ? 'metric-val metric-val--ok' : pct > 90 ? 'metric-val metric-val--warn' : 'metric-val metric-val--bad';
  el.innerHTML =
    '<div class="' + cls + '">' + pct + '%</div>' +
    '<div class="card__sub">' + b.last_24h + ' records, ' + b.zero_token_24h + ' missing tokens</div>';
  el.classList.remove('pulse');
}

function renderModelUsage(d) {
  var el = document.getElementById('model-usage');
  if (!d.length) {
    el.innerHTML = '<div class="card__sub">No usage in last 24h</div>';
    el.classList.remove('pulse');
    return;
  }
  el.innerHTML = d.map(function (m) {
    var name = (m.model || 'unknown').split('/').pop();
    return '<div class="model-row">' +
      '<span class="mono">' + escapeHtml(name) + '</span>' +
      '<span>$' + fmt(m.cost_usd) + ' · ' + fmtK(m.input_tokens + m.output_tokens) + ' tok</span>' +
    '</div>';
  }).join('');
  el.classList.remove('pulse');
}

function fillPillList(id, rows, key, countKey) {
  var ul = document.getElementById(id);
  if (!rows || !rows.length) {
    ul.innerHTML = '<li class="card__sub" style="border:0">No data</li>';
    return;
  }
  ul.innerHTML = rows.map(function (r) {
    return '<li><span title="' + escapeHtml(String(r[key])) + '">' + escapeHtml(String(r[key])) + '</span><span class="cnt">' + r[countKey] + '</span></li>';
  }).join('');
}

function renderTurnIntelBundle(tsum, sess, stops, modes, tools) {
  var turns24 = Number(tsum.turns_24h || 0);
  var refPct = turns24 ? Math.round((Number(tsum.refusals_24h || 0) / turns24) * 1000) / 10 : 0;
  var errPct = turns24 ? Math.round((Number(tsum.turns_with_errors || 0) / turns24) * 1000) / 10 : 0;

  document.getElementById('turn-kpis').innerHTML = [
    overviewCard('Refusals', String(tsum.refusals_24h || 0), refPct + '% of turns · model safety signal'),
    overviewCard('Turns w/ errors', String(tsum.turns_with_errors || 0), errPct + '% · json <span class="mono">errors</span> non-empty'),
    overviewCard('Avg LLM / wall', (tsum.avg_llm_ms != null ? tsum.avg_llm_ms : '—') + ' / ' + (tsum.avg_wall_ms != null ? tsum.avg_wall_ms : '—') + ' ms', 'Mean · see Performance for percentiles'),
    overviewCard('Cache tokens (24h)', fmtK(tsum.sum_cache_read) + ' read / ' + fmtK(tsum.sum_cache_write) + ' write', 'Avg ' + (tsum.avg_tool_calls_per_turn != null ? tsum.avg_tool_calls_per_turn : '—') + ' tool calls / turn · ' + (tsum.turns_with_tools || 0) + ' turns used tools'),
  ].join('');

  var sh = document.getElementById('session-hygiene');
  sh.innerHTML =
    '<div class="hygiene-line"><span class="text-muted">Sessions started</span><strong>' + (sess.sessions_started_24h || 0) + '</strong></div>' +
    '<div class="hygiene-line"><span>Repairs</span><strong>' + fmtK(sess.repairs) + '</strong></div>' +
    '<div class="hygiene-line"><span>Compactions</span><strong>' + fmtK(sess.compactions) + '</strong></div>' +
    '<div class="hygiene-line"><span>Session cache read / write</span><strong>' + fmtK(sess.sum_cache_read) + ' / ' + fmtK(sess.sum_cache_write) + '</strong></div>';
  sh.classList.remove('pulse');

  fillPillList('stop-reasons', stops, 'stop_reason', 'cnt');
  fillPillList('exec-modes', modes, 'mode', 'cnt');

  var tt = document.getElementById('top-tools');
  if (!tools || !tools.length) {
    tt.innerHTML = '<p class="card__sub" style="padding:0.5rem 0">No tool calls in last 24h</p>';
  } else {
    tt.innerHTML = '<table><thead><tr><th>Tool</th><th class="right">Calls</th></tr></thead><tbody>' +
      tools.map(function (x) {
        return '<tr><td class="mono">' + escapeHtml(x.tool_name || '') + '</td><td class="right">' + x.call_count + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
}

async function loadCredits() {
  var d = await api('/api/credits');
  var el = document.getElementById('credits-table');
  if (!d.length) {
    el.innerHTML = '<p class="card__sub" style="padding:1rem">No org credits found</p>';
    return;
  }
  el.innerHTML = '<table><thead><tr><th>Org</th><th class="right">Balance</th><th class="right">Purchased</th><th class="right">Consumed</th><th>Updated</th></tr></thead><tbody>' +
    d.map(function (c) {
      var neg = Number(c.balance_usd) <= 0;
      return '<tr><td>' + (c.org_name || c.org_id) + '</td>' +
        '<td class="right ' + (neg ? 'bal-neg' : 'bal-pos') + '">$' + fmt(c.balance_usd) + '</td>' +
        '<td class="right">$' + fmt(c.lifetime_purchased_usd) + '</td>' +
        '<td class="right">$' + fmt(c.lifetime_consumed_usd) + '</td>' +
        '<td class="mono">' + ago(c.updated_at) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

async function loadTable(tab) {
  var el = document.getElementById('table-content');
  el.innerHTML = '<div class="loading pulse">Loading…</div>';

  if (tab === 'sessions') {
    var d = await api('/api/sessions/recent');
    el.innerHTML = '<table><thead><tr><th>Session</th><th>Trace</th><th>Org</th><th>Agent</th><th>Model</th><th>Status</th><th class="right">Cost</th><th class="right">Steps</th><th class="right">Wall</th><th class="right">Repair</th><th class="right">Cache R/W</th><th>Created</th></tr></thead><tbody>' +
      d.map(function (r) {
        var tr = (r.trace_id || '').slice(0, 10);
        var cr = r.total_cache_read_tokens != null ? fmtK(r.total_cache_read_tokens) : '0';
        var cw = r.total_cache_write_tokens != null ? fmtK(r.total_cache_write_tokens) : '0';
        return '<tr><td class="mono truncate">' + escapeHtml(r.session_id) + '</td><td class="mono">' + escapeHtml(tr || '—') + '</td><td class="mono truncate">' + escapeHtml((r.org_id || '').slice(0, 12)) + '</td><td>' + escapeHtml(r.agent_name || '—') + '</td><td class="mono">' + escapeHtml((r.model || '').split('/').pop()) + '</td><td><span class="badge badge--ok">' + escapeHtml(r.status || '?') + '</span></td><td class="right">$' + fmt(r.cost_total_usd, 4) + '</td><td class="right">' + (r.step_count || 0) + '</td><td class="right">' + fmt(r.wall_clock_seconds, 1) + 's</td><td class="right">' + (r.repair_count || 0) + '</td><td class="right mono">' + cr + '/' + cw + '</td><td class="mono">' + ago(r.created_at) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else if (tab === 'billing') {
    var d2 = await api('/api/billing/recent');
    el.innerHTML = '<table><thead><tr><th>Session</th><th>Org</th><th>Agent</th><th>Model</th><th class="right">In</th><th class="right">Out</th><th class="right">Cost</th><th>Created</th></tr></thead><tbody>' +
      d2.map(function (r) {
        return '<tr><td class="mono truncate">' + r.session_id + '</td><td class="mono truncate">' + (r.org_id || '').slice(0, 12) + '</td><td>' + (r.agent_name || '—') + '</td><td class="mono">' + (r.model || '').split('/').pop() + '</td><td class="right">' + fmtK(r.input_tokens) + '</td><td class="right">' + fmtK(r.output_tokens) + '</td><td class="right">$' + fmt(r.inference_cost_usd, 4) + '</td><td class="mono">' + ago(r.created_at) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else if (tab === 'turns') {
    var d3 = await api('/api/turns/recent');
    el.innerHTML = '<table><thead><tr><th>Session</th><th class="right">#</th><th>Model</th><th class="right">Tok in/out</th><th class="right">$</th><th class="right">LLM ms</th><th class="right">Wall ms</th><th class="right">Tools</th><th class="right">Err</th><th class="right">Cache R/W</th><th>Mode</th><th>Stop</th><th>Flags</th><th>Created</th></tr></thead><tbody>' +
      d3.map(function (r) {
        var ref = r.refusal ? '<span class="badge badge--warn">refusal</span>' : '';
        var mw = Number(r.mw_warn_count || 0) > 0 ? '<span class="badge badge--warn">mw×' + r.mw_warn_count + '</span>' : '';
        var flags = (ref + ' ' + mw).trim() || '—';
        return '<tr><td class="mono truncate">' + escapeHtml(r.session_id) + '</td><td class="right">' + r.turn_number + '</td><td class="mono">' + escapeHtml((r.model_used || '').split('/').pop()) + '</td><td class="right">' + fmtK(r.input_tokens) + '/' + fmtK(r.output_tokens) + '</td><td class="right">$' + fmt(r.cost_total_usd, 4) + '</td><td class="right">' + fmt(r.llm_latency_ms, 0) + '</td><td class="right">' + fmt(r.latency_ms, 0) + '</td><td class="right">' + (r.tool_call_count || 0) + '</td><td class="right">' + (r.error_count || 0) + '</td><td class="right mono">' + fmtK(r.cache_read_tokens) + '/' + fmtK(r.cache_write_tokens) + '</td><td class="mono">' + escapeHtml((r.execution_mode || '—').slice(0, 14)) + '</td><td class="mono">' + escapeHtml((r.stop_reason || '—').slice(0, 18)) + '</td><td>' + flags + '</td><td class="mono">' + ago(r.created_at) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else if (tab === 'events') {
    var d4 = await api('/api/runtime-events/recent');
    el.innerHTML = '<table><thead><tr><th>Type</th><th>Node</th><th>Status</th><th class="right">Latency</th><th>Session</th><th>Created</th></tr></thead><tbody>' +
      d4.map(function (r) {
        return '<tr><td class="mono">' + escapeHtml(r.event_type) + '</td><td class="mono">' + escapeHtml(r.node_id || '—') + '</td><td>' + escapeHtml(r.status || '—') + '</td><td class="right">' + fmt(r.latency_ms, 1) + 'ms</td><td class="mono truncate">' + escapeHtml(r.session_id || '—') + '</td><td class="mono">' + ago(r.created_at) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else if (tab === 'middleware') {
    var dm;
    try {
      dm = await api('/api/middleware/recent');
    } catch (e) {
      el.innerHTML = '<p class="card__sub">Middleware feed unavailable</p>';
      applyTableFilter();
      return;
    }
    if (!dm.length) {
      el.innerHTML = '<p class="card__sub">No middleware events</p>';
      applyTableFilter();
      return;
    }
    el.innerHTML = '<table><thead><tr><th>Time</th><th>Session</th><th>Middleware</th><th>Action</th><th class="right">Turn</th><th>Details</th></tr></thead><tbody>' +
      dm.map(function (r) {
        var det = '';
        try { det = JSON.stringify(r.details).slice(0, 140); } catch (e2) { det = String(r.details || ''); }
        return '<tr><td class="mono">' + ago(r.created_at) + '</td><td class="mono truncate">' + escapeHtml(r.session_id || '') + '</td><td class="mono">' + escapeHtml(r.middleware_name || '') + '</td><td>' + escapeHtml(r.action || '') + '</td><td class="right">' + (r.turn_number != null ? r.turn_number : '—') + '</td><td class="mono truncate" title="' + escapeHtml(det) + '">' + escapeHtml(det) + (det.length >= 140 ? '…' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else if (tab === 'audit') {
    var da;
    try {
      da = await api('/api/audit/recent');
    } catch (e) {
      el.innerHTML = '<p class="card__sub">Audit feed unavailable</p>';
      applyTableFilter();
      return;
    }
    if (!da.length) {
      el.innerHTML = '<p class="card__sub">No audit rows</p>';
      applyTableFilter();
      return;
    }
    el.innerHTML = '<table><thead><tr><th>Time</th><th>Action</th><th>Resource</th><th>Actor</th><th>Org</th><th>Details</th></tr></thead><tbody>' +
      da.map(function (r) {
        var det = '';
        try { det = JSON.stringify(r.details).slice(0, 160); } catch (e2) { det = String(r.details || ''); }
        return '<tr><td class="mono">' + ago(r.created_at) + '</td><td class="mono">' + escapeHtml(r.action || '') + '</td><td>' + escapeHtml((r.resource_type || '') + ':' + (r.resource_name || '')) + '</td><td class="mono truncate">' + escapeHtml(r.actor_id || '') + '</td><td class="mono truncate">' + escapeHtml((r.org_id || '').slice(0, 12)) + '</td><td class="mono truncate" title="' + escapeHtml(det) + '">' + escapeHtml(det) + (det.length >= 160 ? '…' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else if (tab === 'tables') {
    var d5 = await api('/api/table-stats');
    el.innerHTML = '<table><thead><tr><th>Table</th><th class="right">Rows (est.)</th><th class="right">Size</th></tr></thead><tbody>' +
      d5.map(function (r) {
        return '<tr><td class="mono">' + r.table_name + '</td><td class="right">' + fmtK(r.row_estimate) + '</td><td class="right">' + r.total_size + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  applyTableFilter();
}

function applyTableFilter() {
  var inp = document.getElementById('explore-filter');
  if (!inp) return;
  var q = (inp.value || '').trim().toLowerCase();
  var wrap = document.getElementById('table-content');
  if (!wrap) return;
  var trs = wrap.querySelectorAll('tbody tr');
  if (!trs.length) return;
  trs.forEach(function (tr) {
    tr.style.display = !q || (tr.textContent && tr.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
  });
}

function showTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.remove('tab--active');
    t.setAttribute('aria-selected', 'false');
  });
  if (btn) {
    btn.classList.add('tab--active');
    btn.setAttribute('aria-selected', 'true');
  }
  loadTable(tab);
}

async function loadAll() {
  document.getElementById('updated').textContent = 'Updating…';
  try {
    var bundle = await Promise.all([
      api('/api/overview'),
      api('/api/queue-health'),
      api('/api/turns/summary-24h'),
      api('/api/performance/turn-latency-24h'),
      api('/api/trends/turns-hourly-24h'),
      api('/api/model-usage'),
      api('/api/sessions/summary-24h'),
      api('/api/turns/stop-reasons-24h'),
      api('/api/turns/execution-modes-24h'),
      api('/api/tools/top-24h'),
    ]);
    renderOverviewCards(bundle[0]);
    renderQueueHealth(bundle[1]);
    renderBillingAccuracy(bundle[0]);
    renderModelUsage(bundle[5]);
    renderIssueFeed(bundle[2], bundle[1], bundle[0]);
    renderPerformance(bundle[3]);
    renderThroughput(bundle[4]);
    renderTurnIntelBundle(bundle[2], bundle[6], bundle[7], bundle[8], bundle[9]);
  } catch (e) {
    document.getElementById('issue-feed').innerHTML = '<p class="card__sub">Primary bundle failed to load. Check API / DB.</p>';
  }

  await Promise.all([loadCredits(), loadTable(currentTab), loadRegressedTurns()]);
  document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  applyTableFilter();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(function () {
    if (document.getElementById('auto-refresh').checked) loadAll();
  }, 30000);
}

var _filterInp = document.getElementById('explore-filter');
if (_filterInp) _filterInp.addEventListener('input', applyTableFilter);

loadAll();
startAutoRefresh();
</script>
</body>
</html>`;
