function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDashboardPage(): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>xAgent Trading Desk</title>",
    '  <meta name="color-scheme" content="dark" />',
    '  <link rel="stylesheet" href="/dashboard/styles.css" />',
    "</head>",
    "<body>",
    '  <div class="app-frame">',
    '    <aside class="sidebar" aria-label="Dashboard navigation">',
    '      <div class="brand-block">',
    '        <span class="brand-mark">XA</span>',
    '        <div>',
    '          <strong>xAgent</strong>',
    '          <small>Trading Desk</small>',
    '        </div>',
    '      </div>',
    '      <div class="sidebar-status">',
    '        <span id="status-badge" class="pill tone-neutral">等待连接</span>',
    '        <span id="sidebar-caption" class="subtle">尚未拉取数据</span>',
    '      </div>',
    '      <nav class="side-nav">',
    '        <a class="nav-item is-active" href="#positions-events" data-view-link="positions-events">仓位矩阵</a>',
    '        <a class="nav-item" href="#events" data-view-link="events">事件查询</a>',
    '        <a class="nav-item" href="#settings" data-view-link="settings">系统设置</a>',
    '      </nav>',
    '      <label class="refresh-control" for="refresh-interval">',
    '        <span>自动刷新</span>',
    '        <select id="refresh-interval">',
    '          <option value="5000">5 秒</option>',
    '          <option value="10000" selected>10 秒</option>',
    '          <option value="30000">30 秒</option>',
    '          <option value="0">关闭</option>',
    '        </select>',
    '      </label>',
    '    </aside>',
    '    <main class="workspace">',
    '      <header class="topbar">',
    '        <div class="topbar-left">',
    '          <p class="eyebrow">Control Plane</p>',
    '          <h1>交易监控台</h1>',
    '          <div class="topbar-meta">',
    '            <span id="execution-badge" class="pill tone-neutral">Execution n/a</span>',
    '            <span id="refresh-caption" class="subtle">尚未刷新</span>',
    '          </div>',
    '        </div>',
    '        <div class="control-bar">',
    '          <button class="action-button action-ghost" data-action="refresh" data-busy-key="global:refresh">刷新</button>',
    '          <button class="action-button" data-action="run-main-cycle" data-busy-key="global:refresh">运行主循环</button>',
    '          <button class="action-button action-warn" data-action="pause" data-busy-key="global:refresh">暂停</button>',
    '          <button class="action-button action-safe" data-action="resume" data-busy-key="global:refresh">恢复</button>',
    '        </div>',
    '      </header>',
    '      <section id="view-positions-events" class="view is-active" data-view="positions-events">',
    '        <div id="overview-grid" class="kpi-strip" aria-live="polite">',
    '          <article class="stat-card loading-card"><span>正在加载交易概览...</span></article>',
    '        </div>',
    '        <div class="desk-grid">',
    '          <section class="panel positions-panel">',
    '            <div class="panel-head">',
    '              <div><p class="eyebrow">Positions</p><h2>仓位矩阵</h2></div>',
    '              <span id="positions-caption" class="subtle">等待仓位数据...</span>',
    '            </div>',
    '            <div class="query-toolbar positions-toolbar">',
    '              <label><span>状态</span><select id="position-status"><option value="all">全部</option><option value="active">活跃</option><option value="closed">已关闭</option><option value="closing">关闭中</option><option value="error">异常</option></select></label>',
    '              <label><span>Token</span><input id="position-token" type="search" placeholder="Symbol / mint / pool" /></label>',
    '              <label><span>Skill</span><select id="position-skill"><option value="">全部 Skill</option></select></label>',
    '              <label><span>搜索</span><input id="position-search" type="search" placeholder="position / narrative" /></label>',
    '              <label><span>排序</span><select id="position-sort"><option value="openedAt">Opened</option><option value="closedAt">Closed</option><option value="pnlPercent">PnL</option><option value="currentValueUsd">Value</option><option value="depositedSol">Deposit</option><option value="fees">Fees</option></select></label>',
    '              <label><span>方向</span><select id="position-order"><option value="desc">降序</option><option value="asc">升序</option></select></label>',
    '              <button class="action-button action-ghost" data-action="positions-reset" data-busy-key="global:refresh">重置</button>',
    '            </div>',
    '            <div id="positions-panel" class="table-shell loading-block">正在加载仓位列表...</div>',
    '          </section>',
    '          <aside class="right-rail">',
    '            <section class="panel compact-panel">',
    '              <div class="panel-head">',
    '                <div><p class="eyebrow">Cycle</p><h2>执行摘要</h2></div>',
    '              </div>',
    '              <div id="cycle-summary" class="stack loading-block">等待最近一次循环结果...</div>',
    '            </section>',
    '          </aside>',
    '        </div>',
    '      </section>',
    '      <section id="view-events" class="view" data-view="events">',
    '        <section class="panel events-panel audit-card">',
    '          <div class="panel-head">',
    '            <div><p class="eyebrow">Audit</p><h2>事件查询</h2></div>',
    '            <span class="subtle">按来源、Cycle、关键词和时间范围检索审计事件</span>',
    '          </div>',
    '          <div class="query-toolbar audit-toolbar">',
    '            <label><span>Source</span><select id="audit-source"><option value="">全部</option><option value="actions">actions</option><option value="errors">errors</option><option value="phases">phases</option><option value="cycles">cycles</option><option value="llm">llm</option></select></label>',
    '            <label><span>关键词</span><input id="audit-search" type="search" placeholder="payload / error / action" /></label>',
    '            <label><span>Cycle</span><input id="audit-cycle-id" type="search" placeholder="cycle id" /></label>',
    '            <label><span>开始</span><input id="audit-since" type="datetime-local" /></label>',
    '            <label><span>结束</span><input id="audit-until" type="datetime-local" /></label>',
    '            <button class="action-button action-ghost" data-action="audit-query" data-busy-key="global:refresh">查询</button>',
    '            <button class="action-button action-ghost" data-action="audit-reset" data-busy-key="global:refresh">重置</button>',
    '          </div>',
    '          <div id="audit-panel" class="event-stream event-list loading-block">正在加载最近审计事件...</div>',
    '          <button id="audit-load-more" class="action-button action-ghost load-more-button" data-action="audit-load-more" data-busy-key="audit:load-more" disabled>加载更多</button>',
    '        </section>',
    '      </section>',
    '      <section id="view-settings" class="view" data-view="settings">',
    '        <div class="settings-grid">',
    '          <section class="panel">',
    '            <div class="panel-head">',
    '              <div><p class="eyebrow">Execution</p><h2>执行后端</h2></div>',
    '              <a class="text-link" href="/metrics" target="_blank" rel="noreferrer">Prometheus</a>',
    '            </div>',
    '            <div id="execution-summary" class="stack loading-block">等待执行后端状态...</div>',
    '          </section>',
    '          <section class="panel">',
    '            <div class="panel-head">',
    '              <div><p class="eyebrow">Infra</p><h2>RPC 与数据源</h2></div>',
    '            </div>',
    '            <div id="infra-health" class="stack loading-block">正在加载基础设施状态...</div>',
    '          </section>',
    '          <section class="panel skills-section">',
    '            <div class="panel-head">',
    '              <div><p class="eyebrow">Skills</p><h2>策略控制台</h2></div>',
    '              <button class="action-button" data-action="refresh-skill-optimizer" data-busy-key="skill-optimizer">刷新优化建议</button>',
    '            </div>',
    '            <div id="skills-panel" class="skill-grid loading-block">正在加载 Skill 列表...</div>',
    '          </section>',
    '          <section class="panel danger-zone">',
    '            <div class="panel-head">',
    '              <div><p class="eyebrow">Risk Control</p><h2>Danger Zone</h2></div>',
    '              <span class="subtle">高风险操作会要求二次确认</span>',
    '            </div>',
    '            <button class="action-button action-danger" data-action="emergency-exit-all" data-busy-key="global:refresh">全仓紧急撤出</button>',
    '          </section>',
    '        </div>',
    '      </section>',
    "    </main>",
    "  </div>",
    '  <div id="toast-stack" class="toast-stack" aria-live="polite" aria-atomic="true"></div>',
    '  <script src="/dashboard/app.js" defer></script>',
    "</body>",
    "</html>"
  ].join("\n");
}

export const DASHBOARD_STYLES = `
:root {
  --bg-primary: #f7f7f8;
  --bg-secondary: #ffffff;
  --bg-card: #ffffff;
  --bg-card-hover: #fafafa;
  --bg-elevated: #fbfbfc;
  --bg-inset: #f4f4f5;
  --ink: #111113;
  --ink-secondary: #303035;
  --muted: #71717a;
  --muted-strong: #52525b;
  --line: #e4e4e7;
  --line-strong: #d4d4d8;
  --line-accent: #c7d2fe;
  --teal: #047857;
  --teal-dim: #ecfdf5;
  --blue: #2563eb;
  --blue-dim: #eff6ff;
  --rust: #b45309;
  --rust-dim: #fffbeb;
  --gold: #a16207;
  --gold-dim: #fefce8;
  --rose: #dc2626;
  --rose-dim: #fef2f2;
  --emerald: #059669;
  --shadow-sm: 0 1px 2px rgba(17, 17, 19, 0.04);
  --shadow: 0 8px 24px rgba(17, 17, 19, 0.06);
  --shadow-lg: 0 18px 48px rgba(17, 17, 19, 0.12);
  --radius-xl: 8px;
  --radius-lg: 8px;
  --radius-md: 8px;
  --radius-sm: 6px;
}

* {
  box-sizing: border-box;
}

html {
  min-height: 100%;
  background: var(--bg-primary);
  overflow-x: hidden;
}

body {
  margin: 0;
  min-height: 100vh;
  overflow-x: hidden;
  color: var(--ink);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
  font-feature-settings: "ss01", "cv11", "tnum";
  background: var(--bg-primary);
  -webkit-font-smoothing: antialiased;
  letter-spacing: 0;
}

.page-noise {
  display: none;
}

.shell {
  width: min(1440px, calc(100vw - 48px));
  max-width: 100%;
  margin: 0 auto;
  padding: 24px 0 72px;
  position: relative;
  display: grid;
  gap: 16px;
}

.panel {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--radius-xl);
  border: 1px solid var(--line);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.panel:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}

.panel::before {
  display: none;
}

.panel::after {
  display: none;
}

.panel,
.stat-card,
.toast,
.auto-refresh-card {
  animation: rise-in 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.reveal:nth-of-type(2) {
  animation-delay: 60ms;
}

.reveal:nth-of-type(3) {
  animation-delay: 100ms;
}

.reveal:nth-of-type(4) {
  animation-delay: 140ms;
}

.hero {
  padding: 24px;
  display: grid;
  gap: 24px;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr);
  align-items: start;
  background: var(--bg-card);
}

.hero-copy,
.hero-actions {
  position: relative;
  z-index: 2;
  min-width: 0;
}

.hero-copy h1,
.panel-head h2 {
  margin: 0;
  font-weight: 700;
  letter-spacing: 0;
  color: var(--ink);
}

.hero-copy h1 {
  font-size: 1.85rem;
  line-height: 1.18;
  max-width: 20ch;
  letter-spacing: 0;
  overflow-wrap: break-word;
}

.panel-head h2 {
  font-size: 1.05rem;
  letter-spacing: 0;
}

.hero-text {
  margin: 10px 0 0;
  max-width: 54ch;
  color: var(--muted);
  font-size: 0.92rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.hero-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

.eyebrow {
  margin: 0 0 7px;
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.subtle {
  color: var(--muted);
  font-size: 0.88rem;
}

.hero-actions {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 14px;
}

.control-bar {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  gap: 8px;
  justify-content: flex-start;
}

.action-button {
  border: 1px solid #111113;
  border-radius: var(--radius-sm);
  padding: 9px 14px;
  font: inherit;
  font-size: 0.84rem;
  font-weight: 600;
  color: #ffffff;
  background: #111113;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  letter-spacing: 0;
  box-shadow: var(--shadow-sm);
}

.action-button:hover {
  background: #27272a;
  border-color: #27272a;
  box-shadow: var(--shadow);
}

.action-button:active {
  background: #18181b;
}

.action-button:disabled {
  cursor: wait;
  opacity: 0.55;
  box-shadow: none;
}

.action-ghost {
  background: #ffffff;
  color: var(--ink);
  border-color: var(--line-strong);
  box-shadow: none;
}

.action-ghost:hover {
  background: var(--bg-inset);
  border-color: #a1a1aa;
  box-shadow: none;
}

.action-safe {
  background: #047857;
  border-color: #047857;
  color: #ffffff;
}

.action-safe:hover {
  background: #065f46;
  border-color: #065f46;
}

.action-warn {
  background: #b45309;
  border-color: #b45309;
  color: #ffffff;
}

.action-warn:hover {
  background: #92400e;
  border-color: #92400e;
}

.action-danger {
  background: #dc2626;
  border-color: #dc2626;
  color: #ffffff;
}

.action-danger:hover {
  background: #b91c1c;
  border-color: #b91c1c;
}

.auto-refresh-card {
  display: grid;
  gap: 8px;
  width: min(100%, 320px);
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
}

.auto-refresh-card span {
  font-weight: 600;
  font-size: 0.88rem;
  color: var(--ink-secondary);
}

.auto-refresh-card small {
  color: var(--muted);
  font-size: 0.8rem;
}

.auto-refresh-card select {
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg-card);
  font: inherit;
  font-size: 0.88rem;
  color: var(--ink);
  outline: none;
}

.auto-refresh-card select:focus {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-dim);
}

.hero-orbit {
  display: none;
}

.hero-orbit-a {
  display: none;
}

.hero-orbit-b {
  display: none;
}

.stat-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}

.stat-card {
  position: relative;
  min-width: 0;
  padding: 18px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: var(--bg-card);
  transition: border-color 160ms ease, box-shadow 160ms ease;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}

.stat-card::before {
  display: none;
}

.stat-card:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}

.stat-label {
  color: var(--muted-strong);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.stat-value {
  margin-top: 8px;
  font-size: 1.55rem;
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: 0;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  word-break: normal;
}

.stat-note {
  margin-top: 8px;
  color: var(--muted);
  font-size: 0.82rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.two-column {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel-elevated,
.panel-tint,
.panel {
  padding: 22px;
}

.panel-tint {
  background: var(--bg-card);
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.stack {
  display: grid;
  gap: 12px;
}

.summary-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}

.mini-card {
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  transition: border-color 180ms ease, background 180ms ease;
}

.mini-card:hover {
  border-color: var(--line-strong);
  background: var(--bg-card-hover);
}

.mini-card .stat-label {
  font-size: 0.7rem;
}

.mini-card strong {
  display: block;
  margin-top: 6px;
  font-size: 1.15rem;
  color: var(--ink);
}

.inline-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0;
  border: 1px solid transparent;
  overflow-wrap: anywhere;
}

.pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.tone-good {
  color: var(--teal);
  background: var(--teal-dim);
  border-color: #bbf7d0;
}

.tone-warn {
  color: var(--rust);
  background: var(--rust-dim);
  border-color: #fde68a;
}

.tone-danger {
  color: var(--rose);
  background: var(--rose-dim);
  border-color: #fecaca;
}

.tone-neutral {
  color: var(--ink-secondary);
  background: var(--bg-inset);
  border-color: var(--line);
}

.text-link {
  color: var(--blue);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.88rem;
  transition: color 160ms ease;
}

.text-link:hover {
  color: #1d4ed8;
}

.health-list,
.feed-list {
  display: grid;
  gap: 8px;
}

.provider-row,
.feed-item {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  transition: border-color 160ms ease, background 160ms ease;
}

.provider-row:hover,
.feed-item:hover {
  background: var(--bg-card-hover);
}

.provider-row:hover,
.feed-item:hover {
  border-color: var(--line-strong);
}

.provider-top,
.feed-top,
.skill-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.provider-top strong,
.feed-top strong {
  color: var(--ink);
}

.provider-meta,
.feed-meta,
.skill-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--muted);
  font-size: 0.82rem;
}

.provider-meta span,
.feed-meta span,
.skill-meta span {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}

.table-shell {
  overflow-x: auto;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: var(--bg-card);
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 980px;
}

thead th {
  text-align: left;
  padding: 14px 18px;
  color: var(--muted-strong);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--line-strong);
  background: var(--bg-elevated);
  position: sticky;
  top: 0;
}

tbody td {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
  font-size: 0.9rem;
  color: var(--ink-secondary);
}

tbody tr {
  transition: background 120ms ease;
}

tbody tr:hover {
  background: var(--bg-card-hover);
}

tbody tr:last-child td {
  border-bottom: none;
}

.token-cell strong,
.skill-title {
  display: block;
  font-size: 0.95rem;
  color: var(--ink);
}

.token-cell small,
.skill-title small {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 0.78rem;
}

.metric-positive {
  color: var(--emerald);
  font-weight: 600;
}

.metric-negative {
  color: var(--rose);
  font-weight: 600;
}

.metric-flat {
  color: var(--muted);
}

.table-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.table-action {
  border: 1px solid #fecaca;
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  background: var(--rose-dim);
  color: var(--rose);
  cursor: pointer;
  transition: all 160ms ease;
}

.table-action:hover {
  background: #fee2e2;
}

.table-link-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  min-height: 34px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--ink);
  background: #ffffff;
  text-decoration: none;
  transition: all 160ms ease;
}

.table-link-action:hover {
  border-color: #a1a1aa;
  background: var(--bg-inset);
}

.table-action:disabled {
  cursor: wait;
  opacity: 0.4;
}

.skill-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.skill-card {
  position: relative;
  padding: 18px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: var(--bg-card);
  transition: border-color 160ms ease, box-shadow 160ms ease;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}

.skill-card::before {
  display: none;
}

.skill-card:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}

.skill-rules {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}

.chip {
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: var(--blue-dim);
  color: var(--blue);
  font-size: 0.78rem;
  font-weight: 500;
  border: 1px solid #dbeafe;
}

.skill-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.skill-actions input {
  width: 80px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg-card);
  font: inherit;
  font-size: 0.85rem;
  color: var(--ink);
  outline: none;
}

.skill-actions input:focus {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-dim);
}

.skill-actions button {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 160ms ease;
}

.skill-enable {
  background: var(--teal-dim);
  color: var(--teal);
  border-color: #bbf7d0;
}

.skill-enable:hover {
  background: #d1fae5;
}

.skill-disable {
  background: var(--rose-dim);
  color: var(--rose);
  border-color: #fecaca;
}

.skill-disable:hover {
  background: #fee2e2;
}

.skill-canary {
  background: var(--gold-dim);
  color: var(--gold);
  border-color: #fef08a;
}

.skill-canary:hover {
  background: #fef9c3;
}

.skill-optimizer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  display: grid;
  gap: 8px;
}

.optimizer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.optimizer-patch {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--muted);
  font-size: 0.76rem;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.empty-state {
  padding: 24px;
  border-radius: var(--radius-lg);
  border: 1px dashed var(--line-strong);
  color: var(--muted);
  text-align: center;
  font-size: 0.9rem;
}

.loading-block,
.loading-card {
  color: var(--muted);
}

.toast-stack {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: grid;
  gap: 10px;
  width: min(360px, calc(100vw - 40px));
  z-index: 20;
}

.toast {
  padding: 16px 18px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: var(--bg-card);
  box-shadow: var(--shadow-lg);
  transition: opacity 300ms ease, transform 300ms ease;
}

.toast-title {
  font-weight: 700;
  font-size: 0.9rem;
  margin-bottom: 4px;
  color: var(--ink);
}

.toast-body {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.5;
}

.token-prompt-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(2 6 23 / 0.72);
}

.token-prompt {
  width: min(420px, 100%);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  box-shadow: var(--shadow-lg);
  padding: 20px;
}

.token-prompt h2 {
  margin: 0 0 8px;
  font-size: 1rem;
}

.token-prompt p {
  margin: 0 0 14px;
  color: var(--muted);
  font-size: 0.86rem;
  line-height: 1.5;
}

.token-prompt input {
  width: 100%;
  margin-bottom: 14px;
}

.token-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@keyframes rise-in {
  from {
    opacity: 0;
    transform: translateY(16px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes drift {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }

  50% {
    transform: translate3d(0, 8px, 0) scale(1.02);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}

/* scrollbar */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: #d4d4d8;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #a1a1aa;
}

@media (max-width: 1024px) {
  .hero,
  .two-column {
    grid-template-columns: 1fr;
  }

  .hero-copy h1 {
    max-width: none;
  }

  .stat-grid {
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  }
}

@media (max-width: 720px) {
  .shell {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding-top: 10px;
  }

  .panel,
  .hero,
  .panel-elevated,
  .panel-tint {
    padding: 18px;
  }

  .hero {
    gap: 18px;
    max-width: 100%;
  }

  .hero-copy,
  .hero-actions,
  .control-bar,
  .auto-refresh-card {
    width: 100%;
    max-width: 100%;
  }

  .control-bar {
    display: grid;
    grid-template-columns: 1fr;
  }

  .action-button,
  .auto-refresh-card,
  .skill-actions input,
  .skill-actions button {
    width: 100%;
  }

  .panel-head,
  .provider-top,
  .feed-top,
  .skill-top {
    flex-direction: column;
    align-items: flex-start;
  }

  .stat-grid,
  .summary-grid,
  .skill-grid {
    grid-template-columns: 1fr;
  }

  .hero-copy h1 {
    font-size: 1.55rem;
    line-height: 1.12;
    max-width: 100%;
  }

  .hero-text {
    max-width: 100%;
    font-size: 0.92rem;
  }

  .stat-value {
    font-size: 1.55rem;
  }
}

/* Trading desk layout */
:root {
  --bg-primary: #090b0d;
  --bg-secondary: #0f1216;
  --bg-card: #12161b;
  --bg-card-hover: #171c22;
  --bg-elevated: #161b21;
  --bg-inset: #0b0e12;
  --ink: #f3f5f7;
  --ink-secondary: #d7dde3;
  --muted: #8f9aa6;
  --muted-strong: #acb6c0;
  --line: #222a33;
  --line-strong: #34404d;
  --line-accent: #2dd4bf;
  --teal: #34d399;
  --teal-dim: rgba(52, 211, 153, 0.12);
  --blue: #38bdf8;
  --blue-dim: rgba(56, 189, 248, 0.12);
  --rust: #f59e0b;
  --rust-dim: rgba(245, 158, 11, 0.12);
  --gold: #facc15;
  --gold-dim: rgba(250, 204, 21, 0.12);
  --rose: #fb7185;
  --rose-dim: rgba(251, 113, 133, 0.12);
  --emerald: #34d399;
  --shadow-sm: none;
  --shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
  --shadow-lg: 0 20px 52px rgba(0, 0, 0, 0.38);
}

html,
body {
  height: 100%;
  background: var(--bg-primary);
}

body {
  color: var(--ink);
}

.app-frame {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
  min-height: 100vh;
  height: 100vh;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(45, 212, 191, 0.04), transparent 240px),
    var(--bg-primary);
}

.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100vh;
  padding: 18px 14px;
  border-right: 1px solid var(--line);
  background: #0b0e12;
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 6px 18px;
  border-bottom: 1px solid var(--line);
}

.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--teal);
  background: var(--bg-elevated);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0;
}

.brand-block strong {
  display: block;
  color: var(--ink);
  font-size: 1rem;
}

.brand-block small {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 0.76rem;
}

.sidebar-status {
  display: grid;
  gap: 8px;
  padding: 16px 6px;
}

.side-nav {
  display: grid;
  gap: 6px;
  padding: 4px 0;
}

.nav-item {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--muted-strong);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 700;
}

.nav-item:hover {
  color: var(--ink);
  background: var(--bg-elevated);
}

.nav-item.is-active {
  color: var(--ink);
  border-color: rgba(45, 212, 191, 0.28);
  background: rgba(45, 212, 191, 0.1);
}

.refresh-control {
  display: grid;
  gap: 8px;
  margin-top: auto;
  padding: 14px 6px 4px;
  color: var(--muted);
  font-size: 0.82rem;
}

.refresh-control span {
  color: var(--muted-strong);
  font-weight: 700;
}

.refresh-control select {
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--ink);
  background: var(--bg-inset);
  font: inherit;
}

.workspace {
  min-width: 0;
  height: 100vh;
  overflow: auto;
  padding: 16px;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 76px;
  margin: -16px -16px 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(9, 11, 13, 0.94);
  backdrop-filter: blur(18px);
}

.topbar-left {
  min-width: 0;
}

.topbar h1 {
  margin: 0;
  color: var(--ink);
  font-size: 1.24rem;
  line-height: 1.15;
  letter-spacing: 0;
}

.topbar-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.view {
  display: none;
  min-width: 0;
}

.view.is-active {
  display: block;
}

.panel,
.stat-card,
.skill-card,
.mini-card,
.provider-row,
.feed-item,
.toast {
  border-color: var(--line);
  background: var(--bg-card);
  box-shadow: none;
}

.panel:hover,
.stat-card:hover,
.skill-card:hover {
  border-color: var(--line-strong);
  box-shadow: none;
}

.panel {
  padding: 16px;
}

.panel-head {
  align-items: center;
  margin-bottom: 12px;
}

.panel-head h2 {
  color: var(--ink);
  font-size: 0.98rem;
}

.eyebrow {
  color: var(--muted);
  font-size: 0.66rem;
  letter-spacing: 0.08em;
}

.subtle {
  color: var(--muted);
}

.kpi-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.stat-card {
  min-height: 96px;
  padding: 14px;
}

.stat-label {
  color: var(--muted);
  font-size: 0.66rem;
  letter-spacing: 0.08em;
}

.stat-value {
  margin-top: 7px;
  color: var(--ink);
  font-size: 1.28rem;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}

.stat-note {
  margin-top: 7px;
  color: var(--muted);
  font-size: 0.76rem;
}

.desk-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 12px;
  min-height: 0;
}

.positions-panel {
  display: flex;
  min-height: 0;
  height: calc(100vh - 210px);
  flex-direction: column;
}

.right-rail {
  display: grid;
  align-content: start;
  gap: 12px;
  min-height: 0;
  height: calc(100vh - 210px);
}

.compact-panel {
  min-height: 0;
}

.audit-card {
  display: flex;
  min-height: 0;
  flex-direction: column;
}

.events-panel {
  height: calc(100vh - 150px);
}

.table-shell {
  flex: 1;
  min-height: 260px;
  overflow: auto;
  border-color: var(--line);
  background: var(--bg-inset);
}

table {
  min-width: 1160px;
}

thead th {
  top: 0;
  z-index: 2;
  padding: 11px 12px;
  color: var(--muted-strong);
  border-bottom-color: var(--line-strong);
  background: #11161c;
  font-size: 0.66rem;
}

tbody td {
  padding: 11px 12px;
  border-bottom-color: var(--line);
  color: var(--ink-secondary);
  font-size: 0.84rem;
}

tbody tr:hover {
  background: var(--bg-card-hover);
}

.token-cell strong,
.skill-title {
  color: var(--ink);
}

.token-cell small,
.skill-title small {
  color: var(--muted);
}

.number-cell {
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.query-toolbar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
  margin: -6px 0 12px;
  align-items: end;
}

.query-toolbar label {
  display: grid;
  min-width: 0;
  gap: 5px;
  color: var(--muted);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.query-toolbar input,
.query-toolbar select {
  min-width: 0;
  width: 100%;
  height: 36px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--bg-elevated);
  font: inherit;
  font-size: 0.8rem;
  letter-spacing: 0;
  outline: none;
}

.query-toolbar input:focus,
.query-toolbar select:focus {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
}

.query-toolbar .action-button {
  height: 36px;
  padding: 7px 10px;
}

.audit-toolbar {
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
}

.event-payload {
  display: none;
  max-width: 100%;
  margin: 8px 0 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink-secondary);
  background: var(--bg-inset);
  font-size: 0.76rem;
  line-height: 1.45;
  white-space: pre;
}

.event-payload.is-open {
  display: block;
}

.inline-action {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  color: var(--ink-secondary);
  background: var(--bg-inset);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.load-more-button {
  width: 100%;
  margin-top: 10px;
}

.event-stream {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 8px;
}

.event-list {
  padding-right: 4px;
}

.feed-list,
.health-list,
.stack {
  gap: 8px;
}

.feed-item,
.provider-row,
.mini-card {
  padding: 11px;
  background: var(--bg-elevated);
}

.feed-top,
.provider-top,
.skill-top {
  align-items: center;
}

.provider-meta,
.feed-meta,
.skill-meta {
  gap: 6px;
  color: var(--muted);
  font-size: 0.76rem;
}

.provider-meta span,
.feed-meta span,
.skill-meta span {
  background: var(--bg-inset);
  border: 1px solid var(--line);
}

.summary-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.mini-card strong {
  color: var(--ink);
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
}

.settings-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.skills-section {
  grid-column: 1 / -1;
}

.danger-zone {
  border-color: rgba(251, 113, 133, 0.32);
  background: rgba(251, 113, 133, 0.06);
}

.skill-grid {
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 10px;
}

.skill-card {
  padding: 14px;
}

.skill-actions {
  margin-top: 12px;
  padding-top: 12px;
  border-top-color: var(--line);
}

.skill-actions input,
.skill-actions button,
.table-link-action,
.table-action,
.action-button {
  border-radius: 7px;
}

.skill-actions input {
  color: var(--ink);
  background: var(--bg-inset);
}

.action-button {
  padding: 8px 12px;
  border-color: var(--line-strong);
  color: var(--ink);
  background: var(--bg-elevated);
  box-shadow: none;
}

.action-button:hover {
  border-color: var(--muted);
  background: var(--bg-card-hover);
  box-shadow: none;
}

.action-ghost {
  color: var(--ink-secondary);
  background: transparent;
}

.action-safe {
  color: #022c22;
  border-color: var(--teal);
  background: var(--teal);
}

.action-warn {
  color: #451a03;
  border-color: var(--rust);
  background: var(--rust);
}

.action-danger,
.table-action {
  color: #fff1f2;
  border-color: rgba(251, 113, 133, 0.66);
  background: rgba(225, 29, 72, 0.36);
}

.action-danger:hover,
.table-action:hover {
  border-color: var(--rose);
  background: rgba(225, 29, 72, 0.5);
}

.table-link-action {
  color: var(--ink-secondary);
  border-color: var(--line-strong);
  background: var(--bg-elevated);
}

.table-link-action:hover {
  color: var(--ink);
  border-color: var(--muted);
  background: var(--bg-card-hover);
}

.pill {
  border-radius: 999px;
  font-size: 0.7rem;
  white-space: nowrap;
}

.tone-good {
  color: var(--teal);
  background: var(--teal-dim);
  border-color: rgba(52, 211, 153, 0.34);
}

.tone-warn {
  color: var(--rust);
  background: var(--rust-dim);
  border-color: rgba(245, 158, 11, 0.34);
}

.tone-danger {
  color: var(--rose);
  background: var(--rose-dim);
  border-color: rgba(251, 113, 133, 0.34);
}

.tone-neutral {
  color: var(--muted-strong);
  background: var(--bg-elevated);
  border-color: var(--line-strong);
}

.metric-positive {
  color: var(--teal);
}

.metric-negative {
  color: var(--rose);
}

.metric-flat {
  color: var(--muted);
}

.empty-state {
  border-color: var(--line-strong);
  color: var(--muted);
  background: var(--bg-inset);
}

.text-link {
  color: var(--blue);
}

.toast-stack {
  z-index: 50;
}

.toast-title {
  color: var(--ink);
}

.toast-body {
  color: var(--muted);
}

@media (max-width: 1180px) {
  .app-frame {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .kpi-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .desk-grid {
    grid-template-columns: 1fr;
  }

  .positions-panel,
  .right-rail,
  .events-panel {
    height: auto;
  }

  .event-stream {
    max-height: 360px;
  }

  .events-panel {
    min-height: calc(100vh - 150px);
  }

  .events-panel .event-stream {
    max-height: none;
  }
}

@media (max-width: 860px) {
  .app-frame {
    grid-template-columns: 1fr;
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .sidebar {
    position: sticky;
    top: 0;
    z-index: 30;
    height: auto;
    padding: 10px;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .brand-block {
    display: none;
  }

  .sidebar-status {
    display: none;
  }

  .side-nav {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .nav-item {
    justify-content: center;
    min-height: 38px;
  }

  .refresh-control {
    margin-top: 8px;
    padding: 0;
    grid-template-columns: auto minmax(120px, 1fr);
    align-items: center;
  }

  .workspace {
    height: auto;
    min-height: 0;
    overflow: visible;
    padding: 12px;
  }

  .topbar {
    position: static;
    display: grid;
    margin: 0 0 12px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg-card);
  }

  .control-bar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }

  .action-button,
  .skill-actions input,
  .skill-actions button {
    width: 100%;
  }

  .kpi-strip,
  .settings-grid,
  .right-rail {
    grid-template-columns: 1fr;
  }

  .skills-section {
    grid-column: auto;
  }

  .positions-panel {
    height: auto;
  }

  .table-shell {
    max-height: 62vh;
  }
}

@media (max-width: 560px) {
  .workspace {
    padding: 10px;
  }

  .panel {
    padding: 12px;
  }

  .control-bar,
  .summary-grid,
  .skill-grid,
  .query-toolbar {
    grid-template-columns: 1fr;
  }

  .topbar-meta,
  .panel-head,
  .provider-top,
  .feed-top,
  .skill-top {
    align-items: flex-start;
    flex-direction: column;
  }
}
`;

export const DASHBOARD_SCRIPT = `
const dashboardState = {
  refreshIntervalMs: 10000,
  refreshTimer: null,
  streamReconnectTimer: null,
  statusStream: null,
  isRefreshing: false,
  busyKeys: new Set(),
  authToken: window.sessionStorage.getItem("xagent_api_token") ?? "",
  currentView: "positions-events",
  positionsPage: null,
  auditEvents: [],
  auditPage: null
};

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value, options) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("zh-CN", options ?? { maximumFractionDigits: 2 }).format(value);
}

function formatCompact(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatDate(value) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "n/a";
  }

  if (seconds < 60) {
    return Math.round(seconds) + "s";
  }

  if (seconds < 3600) {
    return Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
  }

  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
}

function formatCardValue(value) {
  return escapeHtml(value).replaceAll("_", "_<wbr>");
}

function metricClass(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "metric-flat";
  }

  if (value > 0) {
    return "metric-positive";
  }

  if (value < 0) {
    return "metric-negative";
  }

  return "metric-flat";
}

function pillClass(ok, warning) {
  if (warning) {
    return "pill tone-warn";
  }

  return ok ? "pill tone-good" : "pill tone-danger";
}

function skillTone(status) {
  if (status === "active") {
    return "pill tone-good";
  }

  if (status === "canary") {
    return "pill tone-warn";
  }

  if (status === "disabled" || status === "deprecated") {
    return "pill tone-danger";
  }

  return "pill tone-neutral";
}

function executionTone(execution) {
  if (!execution) {
    return "pill tone-neutral";
  }

  return execution.healthy ? "pill tone-good" : "pill tone-danger";
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
}

function buildAuthHeaders() {
  return dashboardState.authToken
    ? {
        Authorization: "Bearer " + dashboardState.authToken
      }
    : {};
}

function buildStreamUrl(path) {
  const url = new URL(path, window.location.origin);
  if (dashboardState.authToken) {
    url.searchParams.set("token", dashboardState.authToken);
  }
  return url.toString();
}

function setQueryParam(params, key, value) {
  if (value !== undefined && value !== null && String(value).trim().length > 0) {
    params.set(key, String(value).trim());
  }
}

function buildQueryUrl(path, values) {
  const params = new URLSearchParams();
  Object.keys(values).forEach(function (key) {
    setQueryParam(params, key, values[key]);
  });
  const query = params.toString();
  return query ? path + "?" + query : path;
}

function inputValue(id) {
  const node = byId(id);
  return node && "value" in node ? String(node.value ?? "").trim() : "";
}

function readPositionQuery() {
  return {
    status: inputValue("position-status") || "all",
    token: inputValue("position-token"),
    skillId: inputValue("position-skill"),
    q: inputValue("position-search"),
    sort: inputValue("position-sort") || "openedAt",
    order: inputValue("position-order") || "desc",
    limit: 100,
    offset: 0
  };
}

function readAuditQuery(offset) {
  return {
    source: inputValue("audit-source"),
    q: inputValue("audit-search"),
    cycleId: inputValue("audit-cycle-id"),
    since: toIsoFromLocalInput(inputValue("audit-since")),
    until: toIsoFromLocalInput(inputValue("audit-until")),
    limit: 20,
    offset: offset ?? 0
  };
}

function toIsoFromLocalInput(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function ensureAuthToken(forcePrompt) {
  if (!forcePrompt && dashboardState.authToken) {
    return;
  }

  const entered = await requestAuthToken();
  if (entered === null) {
    throw new Error("缺少 API Token，无法访问受保护控制面。");
  }

  dashboardState.authToken = entered.trim();
  if (dashboardState.authToken) {
    window.sessionStorage.setItem("xagent_api_token", dashboardState.authToken);
  } else {
    window.sessionStorage.removeItem("xagent_api_token");
  }

  connectStatusStream();
}

function requestAuthToken() {
  return new Promise(function (resolve) {
    const existing = byId("token-prompt-backdrop");
    if (existing) {
      existing.remove();
    }

    const backdrop = document.createElement("div");
    backdrop.id = "token-prompt-backdrop";
    backdrop.className = "token-prompt-backdrop";
    backdrop.innerHTML =
      '<div class="token-prompt" role="dialog" aria-modal="true" aria-labelledby="token-prompt-title">' +
      '<h2 id="token-prompt-title">输入 xAgent API Token</h2>' +
      '<p>控制面已启用 Bearer Token。Token 只会保存在当前浏览器会话。</p>' +
      '<input id="token-prompt-input" type="password" autocomplete="off" placeholder="xAgent API Token" />' +
      '<div class="token-prompt-actions">' +
      '<button type="button" id="token-prompt-cancel" class="ghost">取消</button>' +
      '<button type="button" id="token-prompt-submit">确认</button>' +
      "</div>" +
      "</div>";

    document.body.appendChild(backdrop);

    const input = byId("token-prompt-input");
    const submit = byId("token-prompt-submit");
    const cancel = byId("token-prompt-cancel");

    if (input && "value" in input) {
      input.value = dashboardState.authToken || "";
      input.focus();
      input.select();
    }

    const close = function (value) {
      backdrop.remove();
      resolve(value);
    };

    submit?.addEventListener("click", function () {
      close(input && "value" in input ? String(input.value ?? "") : "");
    });

    cancel?.addEventListener("click", function () {
      close(null);
    });

    backdrop.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        close(input && "value" in input ? String(input.value ?? "") : "");
      }
      if (event.key === "Escape") {
        close(null);
      }
    });
  });
}

async function apiRequest(url, options) {
  const buildRequestOptions = function () {
    return {
      ...(options ?? {}),
      headers: {
        ...(options?.headers ?? {}),
        ...buildAuthHeaders()
      }
    };
  };

  let response = await fetch(url, buildRequestOptions());
  if (response.status === 401) {
    await ensureAuthToken(true);
    response = await fetch(url, buildRequestOptions());
  }

  const payload = await parseResponse(response);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string"
        ? payload.error
        : typeof payload === "string"
          ? payload
          : response.status + " " + response.statusText;
    throw new Error(message);
  }

  return payload;
}

function showToast(title, body, tone) {
  const stack = byId("toast-stack");
  if (!stack) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML =
    '<div class="toast-title ' + escapeHtml(tone || "") + '">' + escapeHtml(title) + "</div>" +
    '<div class="toast-body">' + escapeHtml(body) + "</div>";
  stack.prepend(toast);

  window.setTimeout(function () {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
  }, 3200);

  window.setTimeout(function () {
    toast.remove();
  }, 3800);
}

function setBusy(key, value) {
  if (value) {
    dashboardState.busyKeys.add(key);
  } else {
    dashboardState.busyKeys.delete(key);
  }

  document.querySelectorAll("[data-busy-key='" + key + "']").forEach(function (node) {
    node.disabled = value;
  });
}

function resolveViewFromHash() {
  if (window.location.hash === "#settings") {
    return "settings";
  }
  if (window.location.hash === "#events") {
    return "events";
  }
  return "positions-events";
}

function setCurrentView(view, updateHash) {
  dashboardState.currentView = view;

  document.querySelectorAll("[data-view]").forEach(function (node) {
    node.classList.toggle("is-active", node.dataset.view === view);
  });

  document.querySelectorAll("[data-view-link]").forEach(function (node) {
    node.classList.toggle("is-active", node.dataset.viewLink === view);
  });

  if (updateHash) {
    const targetHash = "#" + view;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, "", targetHash);
    }
  }
}

function renderOverview(status, skills, positions) {
  const activePositions = positions.filter(function (position) {
    return position.status === "active";
  });
  const activeValueUsd = activePositions.reduce(function (sum, position) {
    return sum + (typeof position.currentValueUsd === "number" && Number.isFinite(position.currentValueUsd) ? position.currentValueUsd : 0);
  }, 0);
  const avgPnl =
    activePositions.length > 0
      ? activePositions.reduce(function (sum, position) {
          return sum + (typeof position.pnlPercent === "number" && Number.isFinite(position.pnlPercent) ? position.pnlPercent : 0);
        }, 0) / activePositions.length
      : 0;
  const schedulableSkills = skills.filter(function (skill) {
    return skill.status === "active" || skill.status === "canary";
  }).length;
  const cards = [
    {
      label: "可用资金",
      value: formatNumber(status.availableCapitalSol, { maximumFractionDigits: 4 }),
      note: "SOL balance"
    },
    {
      label: "活跃仓位",
      value: formatNumber(status.activePositions),
      note: "总计 " + formatNumber(status.totalPositions)
    },
    {
      label: "持仓估值",
      value: "$" + formatCompact(activeValueUsd),
      note: "active mark value"
    },
    {
      label: "平均 PnL",
      value: formatNumber(avgPnl, { maximumFractionDigits: 2 }) + "%",
      note: "活跃仓位均值"
    },
    {
      label: "执行模式",
      value: String(status.execution?.mode ?? "n/a"),
      note: status.execution?.healthy ? "backend healthy" : "backend needs attention"
    },
    {
      label: "Paper / Skill",
      value: (status.paperTrading?.enabled ? "ON" : "OFF") + " / " + formatNumber(schedulableSkills),
      note: "stale " + formatNumber(status.paperTrading?.stalePositions)
    }
  ];

  return cards.map(function (card) {
    return (
      '<article class="stat-card">' +
        '<div class="stat-label">' + escapeHtml(card.label) + "</div>" +
        '<div class="stat-value">' + formatCardValue(card.value) + "</div>" +
        '<div class="stat-note">' + escapeHtml(card.note) + "</div>" +
      "</article>"
    );
  }).join("");
}

function renderCycleSummary(status) {
  const cycle = status.lastCycleResult;
  if (!cycle) {
    return '<div class="empty-state">还没有循环结果。先运行一次主循环，页面会在这里展示扫描、审批和执行结果。</div>';
  }

  const actionItems = (cycle.results ?? []).slice(0, 8).map(function (result) {
    const tone = result.status === "success" ? "tone-good" : result.status === "failed" ? "tone-danger" : "tone-warn";
    return (
      '<div class="feed-item">' +
        '<div class="feed-top">' +
          '<strong>' + escapeHtml(String(result.type).toUpperCase()) + "</strong>" +
          '<span class="pill ' + tone + '">' + escapeHtml(String(result.status).toUpperCase()) + "</span>" +
        "</div>" +
        '<div class="feed-meta">' +
          "<span>latency " + escapeHtml(formatNumber(result.latencyMs, { maximumFractionDigits: 0 })) + " ms</span>" +
          "<span>tx " + escapeHtml(String((result.txSignatures ?? []).length)) + "</span>" +
        "</div>" +
        '<div class="subtle">' + escapeHtml(result.message ?? "") + "</div>" +
      "</div>"
    );
  }).join("");

  return (
    '<div class="summary-grid">' +
      '<div class="mini-card"><span class="stat-label">Scanned</span><strong>' + escapeHtml(formatNumber(cycle.scanned)) + "</strong></div>" +
      '<div class="mini-card"><span class="stat-label">Plans</span><strong>' + escapeHtml(formatNumber(cycle.plans)) + "</strong></div>" +
      '<div class="mini-card"><span class="stat-label">Executed</span><strong>' + escapeHtml(formatNumber(cycle.executed)) + "</strong></div>" +
      '<div class="mini-card"><span class="stat-label">Failed</span><strong>' + escapeHtml(formatNumber(cycle.failed)) + "</strong></div>" +
    "</div>" +
    '<div class="feed-item">' +
      '<div class="feed-top">' +
        '<strong>最近一次循环</strong>' +
        '<span class="' + pillClass(cycle.failed === 0, cycle.failed > 0 && cycle.executed > 0) + '">' + escapeHtml(String(cycle.mode).toUpperCase()) + "</span>" +
      "</div>" +
      '<div class="feed-meta">' +
        "<span>开始 " + escapeHtml(formatDate(cycle.startedAt)) + "</span>" +
        "<span>结束 " + escapeHtml(formatDate(cycle.finishedAt)) + "</span>" +
        "<span>批准 " + escapeHtml(formatNumber(cycle.approved)) + "</span>" +
      "</div>" +
    "</div>" +
    '<div class="feed-list">' + actionItems + "</div>"
  );
}

function renderExecutionSummary(status) {
  const execution = status.execution;
  if (!execution) {
    return '<div class="empty-state">执行层状态暂不可用。</div>';
  }

  return (
    '<div class="provider-row">' +
      '<div class="provider-top">' +
        '<strong>' + escapeHtml(String(execution.mode).toUpperCase()) + "</strong>" +
        '<span class="' + executionTone(execution) + '">' + escapeHtml(execution.healthy ? "HEALTHY" : "ERROR") + "</span>" +
      "</div>" +
      '<div class="provider-meta">' +
        "<span>backend " + escapeHtml(execution.backend ?? "n/a") + "</span>" +
        "<span>strategy " + escapeHtml(execution.submissionStrategy ?? "n/a") + "</span>" +
        "<span>target " + escapeHtml(execution.target ?? "n/a") + "</span>" +
      "</div>" +
      '<div class="provider-meta">' +
        "<span>最近成功 " + escapeHtml(formatDate(execution.lastSuccessAt)) + "</span>" +
        "<span>最近错误 " + escapeHtml(formatDate(execution.lastErrorAt)) + "</span>" +
      "</div>" +
      (execution.lastError ? '<div class="subtle">' + escapeHtml(execution.lastError) + "</div>" : "") +
    "</div>"
  );
}

function renderProviderRow(status, activeName) {
  const tone = status.ok ? "pill tone-good" : "pill tone-danger";
  return (
    '<div class="provider-row">' +
      '<div class="provider-top">' +
        '<strong>' + escapeHtml(status.provider) + "</strong>" +
        '<span class="' + tone + '">' + escapeHtml(status.ok ? "UP" : "DOWN") + "</span>" +
      "</div>" +
      '<div class="provider-meta">' +
        (activeName && status.provider.endsWith(activeName) ? "<span>当前活跃</span>" : "") +
        "<span>read " + escapeHtml(status.canRead ? "yes" : "no") + "</span>" +
        "<span>write " + escapeHtml(status.canWrite ? "yes" : "no") + "</span>" +
        "<span>latency " + escapeHtml(formatNumber(status.latencyMs, { maximumFractionDigits: 0 })) + " ms</span>" +
        "<span>failures " + escapeHtml(formatNumber(status.consecutiveFailures, { maximumFractionDigits: 0 })) + "</span>" +
      "</div>" +
      '<div class="provider-meta">' +
        "<span>checked " + escapeHtml(formatDate(status.lastCheckedAt)) + "</span>" +
        (status.simulated ? "<span>simulated</span>" : "") +
      "</div>" +
      (status.lastError ? '<div class="subtle">' + escapeHtml(status.lastError) + "</div>" : "") +
    "</div>"
  );
}

function renderInfra(status) {
  const rpcStatuses = (status.rpc?.statuses ?? []).map(function (rpcStatus) {
    return renderProviderRow(rpcStatus, status.rpc?.activeName);
  }).join("");

  const providerStatuses = (status.dataProviders?.providerStatuses ?? []).map(function (providerStatus) {
    return renderProviderRow(providerStatus);
  }).join("");

  return (
    '<div class="stack">' +
      '<div>' +
        '<div class="provider-top">' +
          '<strong>RPC Layer</strong>' +
          '<span class="' + pillClass(Boolean(status.rpc?.canWrite), !status.rpc?.canWrite) + '">' + escapeHtml(status.rpc?.activeName ?? "n/a") + "</span>" +
        "</div>" +
        '<div class="health-list">' + (rpcStatuses || '<div class="empty-state">无 RPC 状态。</div>') + "</div>" +
      "</div>" +
      '<div>' +
        '<div class="provider-top">' +
          '<strong>Pool Source</strong>' +
          '<span class="' + pillClass(Boolean(status.poolSource), false) + '">' + escapeHtml(status.poolSource ?? "n/a") + "</span>" +
        "</div>" +
        '<div class="subtle">当前候选池发现入口。若真实源失败，会自动降级到 mock 样例数据。</div>' +
      "</div>" +
      '<div>' +
        '<div class="provider-top">' +
          '<strong>Storage</strong>' +
          '<span class="' + pillClass(Boolean(status.storage?.sqliteConfigured || status.storage?.stateStoreKind === "file"), false) + '">' + escapeHtml(status.storage?.stateStoreKind ?? "n/a") + "</span>" +
        "</div>" +
        '<div class="provider-meta">' +
          "<span>audit " + escapeHtml(status.storage?.auditStoreKind ?? "n/a") + "</span>" +
          "<span>cache " + escapeHtml(status.storage?.cacheStoreKind ?? "n/a") + "</span>" +
          "<span>sqlite " + escapeHtml(status.storage?.sqliteConfigured ? "configured" : "off") + "</span>" +
        "</div>" +
      "</div>" +
      '<div>' +
        '<div class="provider-top">' +
          '<strong>Runtime Lock</strong>' +
          '<span class="' + pillClass(Boolean(status.runtimeLock), false) + '">' + escapeHtml(status.runtimeLock?.kind ?? "off") + "</span>" +
        "</div>" +
        '<div class="provider-meta">' +
          "<span>key " + escapeHtml(status.runtimeLock?.key ?? "n/a") + "</span>" +
          "<span>pid " + escapeHtml(status.runtimeLock?.pid ?? "n/a") + "</span>" +
          "<span>host " + escapeHtml(status.runtimeLock?.hostname ?? "n/a") + "</span>" +
        "</div>" +
      "</div>" +
      '<div>' +
        '<div class="provider-top">' +
          '<strong>Wallet</strong>' +
          '<span class="' + pillClass(Boolean(status.wallet?.secretLoaded), !status.wallet?.secretLoaded) + '">' + escapeHtml(status.wallet?.secretLoaded ? "SECRET_LOADED" : "ADDRESS_ONLY") + "</span>" +
        "</div>" +
        '<div class="provider-meta">' +
          "<span>address " + escapeHtml(status.wallet?.activeAddress ?? "n/a") + "</span>" +
          "<span>source " + escapeHtml(status.wallet?.secretSource ?? "n/a") + "</span>" +
          "<span>key " + escapeHtml(status.wallet?.keyVersion ?? "n/a") + "</span>" +
          "<span>forward " + escapeHtml(status.wallet?.allowSecretForwarding ? "enabled" : "disabled") + "</span>" +
        "</div>" +
      "</div>" +
      '<div>' +
        '<div class="provider-top">' +
          '<strong>Data Providers</strong>' +
          '<span class="' + pillClass(Boolean(status.dataProviders?.hasAnyProvider), !status.dataProviders?.hasPrimaryProvider) + '">' + escapeHtml(status.dataProviders?.hasAnyProvider ? "ONLINE" : "OFFLINE") + "</span>" +
        "</div>" +
        '<div class="health-list">' + (providerStatuses || '<div class="empty-state">无数据源状态。</div>') + "</div>" +
      "</div>" +
    "</div>"
  );
}

function renderAudit(events) {
  if (!events.length) {
    return '<div class="empty-state">还没有审计事件。</div>';
  }

  return events.map(function (event, index) {
    const payload = event.payload ?? {};
    const summary =
      typeof payload.phase === "string"
        ? "phase=" + payload.phase
        : typeof payload.cycleId === "string"
          ? "cycle=" + payload.cycleId
          : typeof payload.role === "string"
            ? "role=" + payload.role
            : typeof payload.type === "string"
              ? "type=" + payload.type
              : "event";

    const compactPayload = JSON.stringify(payload).slice(0, 240);
    const fullPayload = JSON.stringify(payload, null, 2);
    const payloadId = "audit-payload-" + index;

    return (
      '<div class="feed-item">' +
        '<div class="feed-top">' +
          '<strong>' + escapeHtml(event.source ?? "audit") + "</strong>" +
          '<span class="pill tone-neutral">' + escapeHtml(summary) + "</span>" +
        "</div>" +
        '<div class="feed-meta">' +
          "<span>" + escapeHtml(formatDate(event.timestamp)) + "</span>" +
        "</div>" +
        '<div class="subtle">' + escapeHtml(compactPayload) + "</div>" +
        '<button class="inline-action" data-action="toggle-event-payload" data-target-id="' + escapeHtml(payloadId) + '">Payload</button>' +
        '<pre id="' + escapeHtml(payloadId) + '" class="event-payload">' + escapeHtml(fullPayload) + "</pre>" +
      "</div>"
    );
  }).join("");
}

function renderPositions(positions) {
  if (!positions.length) {
    return '<div class="empty-state">当前没有仓位。跑一轮主循环后，这里会出现仓位矩阵。</div>';
  }

  function renderExternalAction(label, href) {
    if (!href) {
      return "";
    }

    return (
      '<a class="table-link-action" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(label) +
      "</a>"
    );
  }

  const rows = positions.map(function (position) {
    const pnl = typeof position.pnlPercent === "number" ? position.pnlPercent : 0;
    const forceExitDisabled = position.status !== "active" ? "disabled" : "";
    const key = "position:" + position.id;
    const tokenMint = typeof position.tokenMint === "string" && position.tokenMint.length > 0 ? position.tokenMint : undefined;
    const poolAddress = typeof position.poolAddress === "string" && position.poolAddress.length > 0 ? position.poolAddress : undefined;
    const gmgnUrl = tokenMint ? "https://gmgn.ai/sol/address/" + encodeURIComponent(tokenMint) : undefined;
    const meteoraUrl = poolAddress ? "https://www.meteora.ag/dlmm/" + encodeURIComponent(poolAddress) : undefined;
    const paperStale = position.paper?.staleReason
      ? "<br /><span class='subtle'>paper stale: " + escapeHtml(position.paper.staleReason) + "</span>"
      : position.paper
        ? "<br /><span class='subtle'>paper " + escapeHtml(formatDate(position.paper.lastValuationAt)) + "</span>"
        : "";

    return (
      "<tr>" +
        '<td class="token-cell"><strong>' + escapeHtml(position.tokenSymbol ?? "n/a") + "</strong><small>" + escapeHtml(position.tokenMint ?? "") + "</small></td>" +
        "<td>" + escapeHtml(position.skillId ?? "n/a") + "<br /><span class='subtle'>v" + escapeHtml(position.skillVersion ?? "n/a") + "</span></td>" +
        "<td>" + escapeHtml(String(position.fromBinId)) + " → " + escapeHtml(String(position.toBinId)) + "</td>" +
        '<td class="number-cell">' + escapeHtml(formatNumber(position.depositedSol, { maximumFractionDigits: 4 })) + " SOL</td>" +
        '<td class="number-cell">$' + escapeHtml(formatCompact(position.currentValueUsd)) + "</td>" +
        '<td class="number-cell ' + metricClass(pnl) + '">' + escapeHtml(formatNumber(pnl, { maximumFractionDigits: 2 })) + "%</td>" +
        '<td class="number-cell">' + escapeHtml(formatNumber(position.totalFeesClaimedSol, { maximumFractionDigits: 4 })) + " SOL</td>" +
        '<td><span class="pill tone-neutral">' + escapeHtml(position.status ?? "n/a") + "</span>" + paperStale + "</td>" +
        "<td>" + escapeHtml(formatDate(position.openedAt)) + "</td>" +
        "<td>" + escapeHtml(formatDate(position.closedAt)) + "</td>" +
        '<td><div class="table-actions">' +
          renderExternalAction("GMGN", gmgnUrl) +
          renderExternalAction("Meteora", meteoraUrl) +
          "<button class='table-action' " + forceExitDisabled + " data-position-id='" + escapeHtml(position.id) + "' data-action='force-exit' data-busy-key='" + escapeHtml(key) + "'>强退</button>" +
        "</div></td>" +
      "</tr>"
    );
  }).join("");

  return (
    "<table>" +
      "<thead><tr><th>Token</th><th>Skill</th><th>Range</th><th>Deposit</th><th>Value</th><th>PnL</th><th>Fees</th><th>Status</th><th>Opened</th><th>Closed</th><th>Action</th></tr></thead>" +
      "<tbody>" + rows + "</tbody>" +
    "</table>"
  );
}

function syncPositionSkillOptions(skills) {
  const select = byId("position-skill");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }

  const currentValue = select.value;
  const options = ['<option value="">全部 Skill</option>'].concat(
    skills.map(function (skill) {
      return '<option value="' + escapeHtml(skill.id) + '">' + escapeHtml(skill.id) + "</option>";
    })
  );
  select.innerHTML = options.join("");
  select.value = currentValue;
}

function updatePositionsCaption(status, positionsPayload) {
  const counts = positionsPayload.counts ?? {};
  const page = positionsPayload.page ?? {};
  const shown = positionsPayload.positions?.length ?? 0;
  const total = page.total ?? counts.total ?? status.totalPositions;
  byId("positions-caption").textContent =
    "展示 " + formatNumber(shown) + " / 匹配 " + formatNumber(total) +
    " · 活跃 " + formatNumber(counts.active ?? status.activePositions) +
    " · 已关闭 " + formatNumber(counts.closed ?? 0) +
    " · 异常 " + formatNumber(counts.error ?? 0);
}

function updateAuditLoadMore(page) {
  const button = byId("audit-load-more");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.disabled = !page?.hasMore;
  button.textContent = page?.hasMore ? "加载更多" : "没有更多事件";
}

function findSkillRecommendation(recommendations, skill) {
  return (recommendations ?? []).find(function (recommendation) {
    return recommendation.skillId === skill.id && recommendation.skillVersion === skill.version;
  });
}

function renderSkillOptimizer(recommendation) {
  if (!recommendation) {
    return (
      '<div class="skill-optimizer">' +
        '<div class="optimizer-head"><strong>Optimizer</strong><span class="subtle">暂无建议</span></div>' +
      "</div>"
    );
  }

  const patch = {
    params: recommendation.paramsPatch ?? {},
    riskLimits: recommendation.riskLimitsPatch ?? {}
  };
  const hasPatch = Object.keys(patch.params).length > 0 || Object.keys(patch.riskLimits).length > 0;

  return (
    '<div class="skill-optimizer">' +
      '<div class="optimizer-head">' +
        "<strong>Optimizer</strong>" +
        '<span class="pill tone-neutral">' + escapeHtml(String(recommendation.suggestedAction ?? "hold")) + "</span>" +
      "</div>" +
      '<div class="skill-meta">' +
        "<span>confidence " + escapeHtml(formatNumber((recommendation.confidence ?? 0) * 100)) + "%</span>" +
        "<span>evaluated " + escapeHtml(formatDate(recommendation.evaluatedAt)) + "</span>" +
      "</div>" +
      '<p class="subtle">' + escapeHtml(recommendation.disabledReason ?? recommendation.reason ?? "") + "</p>" +
      (hasPatch ? '<pre class="optimizer-patch">' + escapeHtml(JSON.stringify(patch, null, 2)) + "</pre>" : '<span class="subtle">无参数 patch</span>') +
    "</div>"
  );
}

function renderSkills(skills, recommendations) {
  if (!skills.length) {
    return '<div class="empty-state">没有 Skill 配置。</div>';
  }

  return skills.map(function (skill) {
    const key = "skill:" + skill.id;
    const canaryValue = typeof skill.canaryPercent === "number" ? skill.canaryPercent : 10;
    const stats = skill.stats;
    const recommendation = findSkillRecommendation(recommendations, skill);

    return (
      '<article class="skill-card">' +
        '<div class="skill-top">' +
          '<div class="skill-title"><strong>' + escapeHtml(skill.name) + '</strong><small>' + escapeHtml(skill.id) + " · v" + escapeHtml(skill.version) + "</small></div>" +
          '<span class="' + skillTone(skill.status) + '">' + escapeHtml(String(skill.status).toUpperCase()) + "</span>" +
        "</div>" +
        '<p class="subtle">' + escapeHtml(skill.description ?? "") + "</p>" +
        '<div class="skill-meta">' +
          "<span>Lincoln ≥ " + escapeHtml(formatNumber(skill.applicability?.minLincolnScore)) + "</span>" +
          "<span>Safety ≥ " + escapeHtml(formatNumber(skill.applicability?.minSafetyScore)) + "</span>" +
          "<span>max alive " + escapeHtml(formatNumber(skill.riskLimits?.maxAliveHours, { maximumFractionDigits: 0 })) + "h</span>" +
          "<span>max rebalance " + escapeHtml(formatNumber(skill.riskLimits?.maxDailyRebalances, { maximumFractionDigits: 0 })) + "/day</span>" +
        "</div>" +
        '<div class="skill-rules">' +
          (skill.applicability?.lifecycleStages ?? []).map(function (stage) {
            return '<span class="chip">' + escapeHtml(stage) + "</span>";
          }).join("") +
        "</div>" +
        '<div class="skill-meta">' +
          "<span>positions " + escapeHtml(formatNumber(stats?.totalPositions, { maximumFractionDigits: 0 })) + "</span>" +
          "<span>active " + escapeHtml(formatNumber(stats?.activePositions, { maximumFractionDigits: 0 })) + "</span>" +
          "<span>win rate " + escapeHtml(formatNumber(stats?.winRate)) + "%</span>" +
          "<span>avg hold " + escapeHtml(formatNumber(stats?.averagePositionHours)) + "h</span>" +
        "</div>" +
        '<div class="skill-meta">' +
          "<span>fees " + escapeHtml(formatNumber(stats?.totalFeesClaimedSol)) + " SOL</span>" +
          "<span>paper fees " + escapeHtml(formatNumber(stats?.paperFeesAccruedSol)) + " SOL</span>" +
          "<span>est pnl $" + escapeHtml(formatNumber(stats?.estimatedPnlUsd)) + "</span>" +
          "<span>active mark $" + escapeHtml(formatNumber(stats?.activeMarkPnlUsd)) + "</span>" +
          "<span>worst pnl " + escapeHtml(formatNumber(stats?.worstPnlPercent)) + "%</span>" +
          "<span>max dd " + escapeHtml(formatNumber(stats?.maxDrawdownPercent)) + "%</span>" +
        "</div>" +
        '<div class="skill-actions">' +
          '<button class="skill-enable" data-action="enable-skill" data-skill-id="' + escapeHtml(skill.id) + '" data-busy-key="' + escapeHtml(key) + '">启用</button>' +
          '<button class="skill-disable" data-action="disable-skill" data-skill-id="' + escapeHtml(skill.id) + '" data-busy-key="' + escapeHtml(key) + '">停用</button>' +
          '<input id="canary-' + escapeHtml(skill.id) + '" type="number" min="1" max="100" value="' + escapeHtml(String(canaryValue)) + '" />' +
          '<button class="skill-canary" data-action="canary-skill" data-skill-id="' + escapeHtml(skill.id) + '" data-busy-key="' + escapeHtml(key) + '">Canary</button>' +
        "</div>" +
        renderSkillOptimizer(recommendation) +
      "</article>"
    );
  }).join("");
}

function updateHeader(status) {
  const badge = byId("status-badge");
  const caption = byId("refresh-caption");
  const sidebarCaption = byId("sidebar-caption");
  const executionBadge = byId("execution-badge");

  if (badge) {
    const paused = Boolean(status.manualPause);
    badge.className = paused ? "pill tone-warn" : executionTone(status.execution);
    badge.textContent =
      paused
        ? "MANUAL PAUSE"
        : String(status.mode ?? "unknown").toUpperCase() + " · " + String(status.execution?.mode ?? "n/a").toUpperCase();
  }

  if (executionBadge) {
    executionBadge.className = executionTone(status.execution);
    executionBadge.textContent =
      "Execution " + String(status.execution?.healthy ? "HEALTHY" : "ERROR") + " · " + String(status.execution?.backend ?? "n/a");
  }

  if (caption) {
    caption.textContent =
      "上次主循环: " + formatDate(status.lastMainCycleAt) + " · 高频 tick: " + formatDate(status.lastHighFreqTickAt);
  }

  if (sidebarCaption) {
    sidebarCaption.textContent =
      "uptime " + formatDuration(status.uptimeSeconds) + " · " + String(status.poolSource ?? "n/a");
  }
}

function syncRefreshTimer() {
  if (dashboardState.refreshTimer) {
    window.clearInterval(dashboardState.refreshTimer);
    dashboardState.refreshTimer = null;
  }

  if (dashboardState.refreshIntervalMs > 0) {
    dashboardState.refreshTimer = window.setInterval(function () {
      refreshDashboard(false);
    }, dashboardState.refreshIntervalMs);
  }
}

function closeStatusStream() {
  if (dashboardState.statusStream) {
    dashboardState.statusStream.close();
    dashboardState.statusStream = null;
  }

  if (dashboardState.streamReconnectTimer) {
    window.clearTimeout(dashboardState.streamReconnectTimer);
    dashboardState.streamReconnectTimer = null;
  }
}

function connectStatusStream() {
  if (typeof window.EventSource !== "function") {
    return;
  }

  closeStatusStream();

  const stream = new window.EventSource(buildStreamUrl("/events/status"));
  dashboardState.statusStream = stream;

  stream.addEventListener("status", function () {
    refreshDashboard(false);
  });

  stream.addEventListener("error", function () {
    closeStatusStream();
    dashboardState.streamReconnectTimer = window.setTimeout(function () {
      connectStatusStream();
    }, 3000);
  });
}

async function refreshDashboard(showToastOnSuccess) {
  if (dashboardState.isRefreshing) {
    return;
  }

  dashboardState.isRefreshing = true;
  setBusy("global:refresh", true);

  try {
    const positionUrl = buildQueryUrl("/positions", readPositionQuery());
    const auditUrl = buildQueryUrl("/audit/events", readAuditQuery(0));
    const results = await Promise.all([
      apiRequest("/status"),
      apiRequest("/skills"),
      apiRequest("/skills/optimizer/recommendations"),
      apiRequest(positionUrl),
      apiRequest("/positions?status=active&limit=500"),
      apiRequest(auditUrl)
    ]);

    const status = results[0];
    const skills = results[1].skills ?? [];
    const optimizerRecommendations = results[2].recommendations ?? [];
    const positionsPayload = results[3];
    const positions = positionsPayload.positions ?? [];
    const overviewPositions = results[4].positions ?? [];
    const auditPayload = results[5];
    const auditEvents = auditPayload.events ?? [];
    dashboardState.auditEvents = auditEvents;
    dashboardState.auditPage = auditPayload.page ?? null;

    updateHeader(status);
    syncPositionSkillOptions(skills);
    byId("overview-grid").innerHTML = renderOverview(status, skills, overviewPositions);
    byId("cycle-summary").innerHTML = renderCycleSummary(status);
    byId("execution-summary").innerHTML = renderExecutionSummary(status);
    byId("infra-health").innerHTML = renderInfra(status);
    byId("audit-panel").innerHTML = renderAudit(dashboardState.auditEvents);
    byId("positions-panel").innerHTML = renderPositions(positions);
    byId("skills-panel").innerHTML = renderSkills(skills, optimizerRecommendations);
    updatePositionsCaption(status, positionsPayload);
    updateAuditLoadMore(dashboardState.auditPage);

    const stamp = new Date();
    byId("refresh-caption").textContent =
      "上次刷新 " + stamp.toLocaleTimeString("zh-CN", { hour12: false }) +
      " · 主循环 " + formatDate(status.lastMainCycleAt);

    if (showToastOnSuccess) {
      showToast("Dashboard 已刷新", "状态、仓位和 Skill 数据已同步。");
    }
  } catch (error) {
    showToast("刷新失败", error instanceof Error ? error.message : String(error), "tone-danger");
  } finally {
    dashboardState.isRefreshing = false;
    setBusy("global:refresh", false);
  }
}

async function loadMoreAuditEvents() {
  const page = dashboardState.auditPage;
  if (!page?.hasMore || page.nextOffset === null || page.nextOffset === undefined) {
    return;
  }

  await withAction("audit:load-more", async function () {
    const payload = await apiRequest(buildQueryUrl("/audit/events", readAuditQuery(page.nextOffset)));
    dashboardState.auditEvents = dashboardState.auditEvents.concat(payload.events ?? []);
    dashboardState.auditPage = payload.page ?? null;
    byId("audit-panel").innerHTML = renderAudit(dashboardState.auditEvents);
    updateAuditLoadMore(dashboardState.auditPage);
  });
}

async function withAction(key, fn) {
  if (dashboardState.busyKeys.has(key)) {
    return;
  }

  setBusy(key, true);
  try {
    await fn();
  } finally {
    setBusy(key, false);
  }
}

async function runControl(action) {
  const endpointMap = {
    "run-main-cycle": "/control/run-main-cycle",
    "resume": "/control/resume",
    "emergency-exit-all": "/control/emergency-exit-all"
  };

  if (action === "pause") {
    const reason = window.prompt("暂停原因", "manual_dashboard") || "manual_dashboard";
    await apiRequest("/control/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason })
    });
    showToast("系统已暂停", "原因: " + reason, "tone-warn");
    await refreshDashboard(false);
    return;
  }

  if (action === "refresh") {
    await refreshDashboard(true);
    return;
  }

  if (action === "emergency-exit-all") {
    const confirmed = window.confirm("确认执行全仓紧急撤出？该操作会先暂停系统，并对所有活跃仓位提交 emergency_exit。");
    if (!confirmed) {
      return;
    }
  }

  const endpoint = endpointMap[action];
  if (!endpoint) {
    return;
  }

  await apiRequest(endpoint, { method: "POST" });
  showToast("控制动作已提交", action + " 执行完成。");
  await refreshDashboard(false);
}

function resetPositionFilters() {
  const defaults = {
    "position-status": "all",
    "position-token": "",
    "position-skill": "",
    "position-search": "",
    "position-sort": "openedAt",
    "position-order": "desc"
  };
  Object.keys(defaults).forEach(function (id) {
    const node = byId(id);
    if (node && "value" in node) {
      node.value = defaults[id];
    }
  });
}

function resetAuditFilters() {
  ["audit-source", "audit-search", "audit-cycle-id", "audit-since", "audit-until"].forEach(function (id) {
    const node = byId(id);
    if (node && "value" in node) {
      node.value = "";
    }
  });
}

async function runSkillAction(action, skillId) {
  const key = "skill:" + skillId;
  await withAction(key, async function () {
    if (action === "disable-skill") {
      await apiRequest("/skills/" + encodeURIComponent(skillId) + "/disable", { method: "POST" });
      showToast("Skill 已停用", skillId + " 已进入 disabled 状态。");
      await refreshDashboard(false);
      return;
    }

    if (action === "enable-skill") {
      await apiRequest("/skills/" + encodeURIComponent(skillId) + "/enable", { method: "POST" });
      showToast("Skill 已启用", skillId + " 已恢复 active 状态。");
      await refreshDashboard(false);
      return;
    }

    if (action === "canary-skill") {
      const input = byId("canary-" + skillId);
      const canaryPercent = input ? Number(input.value) : 10;
      await apiRequest("/skills/" + encodeURIComponent(skillId) + "/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canaryPercent: Number.isFinite(canaryPercent) ? canaryPercent : 10 })
      });
      showToast("Canary 已更新", skillId + " canary 流量已设置。");
      await refreshDashboard(false);
    }
  });
}

async function refreshSkillOptimizer() {
  await withAction("skill-optimizer", async function () {
    await apiRequest("/skills/optimizer/evaluate", { method: "POST" });
    showToast("优化建议已刷新", "Skill Optimizer 已重新评估当前 paper trading 样本。");
    await refreshDashboard(false);
  });
}

async function runForceExit(positionId) {
  const confirmed = window.confirm("确认强制撤出仓位 " + positionId + "？");
  if (!confirmed) {
    return;
  }

  const key = "position:" + positionId;
  await withAction(key, async function () {
    await apiRequest("/positions/" + encodeURIComponent(positionId) + "/force-exit", { method: "POST" });
    showToast("仓位强退已提交", positionId + " 已请求强退。", "tone-warn");
    await refreshDashboard(false);
  });
}

document.addEventListener("click", function (event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  if (!action) {
    return;
  }

  if (action === "refresh" || action === "run-main-cycle" || action === "pause" || action === "resume" || action === "emergency-exit-all") {
    withAction("global:refresh", function () {
      return runControl(action);
    });
    return;
  }

  if (action === "positions-reset") {
    resetPositionFilters();
    withAction("global:refresh", function () {
      return refreshDashboard(false);
    });
    return;
  }

  if (action === "audit-query") {
    withAction("global:refresh", function () {
      return refreshDashboard(false);
    });
    return;
  }

  if (action === "audit-reset") {
    resetAuditFilters();
    withAction("global:refresh", function () {
      return refreshDashboard(false);
    });
    return;
  }

  if (action === "audit-load-more") {
    loadMoreAuditEvents();
    return;
  }

  if (action === "toggle-event-payload") {
    const targetId = target.dataset.targetId;
    const payload = targetId ? byId(targetId) : null;
    if (payload) {
      payload.classList.toggle("is-open");
    }
    return;
  }

  if (action === "enable-skill" || action === "disable-skill" || action === "canary-skill") {
    const skillId = target.dataset.skillId;
    if (skillId) {
      runSkillAction(action, skillId);
    }
    return;
  }

  if (action === "refresh-skill-optimizer") {
    refreshSkillOptimizer();
    return;
  }

  if (action === "force-exit") {
    const positionId = target.dataset.positionId;
    if (positionId) {
      runForceExit(positionId);
    }
  }
});

document.addEventListener("change", function (event) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLInputElement)) {
    return;
  }

  if (target.id === "refresh-interval") {
    dashboardState.refreshIntervalMs = Number(target.value);
    syncRefreshTimer();
    showToast("自动刷新已更新", dashboardState.refreshIntervalMs > 0 ? "间隔 " + (dashboardState.refreshIntervalMs / 1000) + " 秒。" : "已关闭自动刷新。");
    return;
  }

  if (target.id.startsWith("position-")) {
    refreshDashboard(false);
  }
});

document.addEventListener("keydown", function (event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || event.key !== "Enter") {
    return;
  }

  if (target.id.startsWith("position-") || target.id.startsWith("audit-")) {
    event.preventDefault();
    refreshDashboard(false);
  }
});

window.addEventListener("load", function () {
  const refreshButton = document.querySelector('[data-action="refresh"]');
  if (refreshButton instanceof HTMLButtonElement) {
    refreshButton.dataset.busyKey = "global:refresh";
  }

  setCurrentView(resolveViewFromHash(), !window.location.hash);
  syncRefreshTimer();
  connectStatusStream();
  refreshDashboard(false);
});

window.addEventListener("hashchange", function () {
  setCurrentView(resolveViewFromHash(), false);
});

window.addEventListener("beforeunload", function () {
  closeStatusStream();
});
`;

export const DASHBOARD_CONTENT_TYPE = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8"
} as const;

export function renderDashboardNotFoundPage(pathname: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>xAgent Dashboard</title>",
    '  <link rel="stylesheet" href="/dashboard/styles.css" />',
    "</head><body>",
    '  <main class="shell">',
    '    <section class="panel" style="margin-top:48px">',
    '      <p class="eyebrow">Missing Page</p>',
    '      <h1 style="margin:0 0 12px">' + escapeHtml(pathname) + "</h1>",
    '      <p class="hero-text">Dashboard 路径不存在。回到 <a class="text-link" href="/dashboard">/dashboard</a>。</p>',
    "    </section>",
    "  </main>",
    "</body></html>"
  ].join("");
}
