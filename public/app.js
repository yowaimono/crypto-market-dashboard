'use strict';
// ============================================================
// 加密货币大盘 · 动量与波动率
// ============================================================
function themeColor(token) {
  const probe = document.createElement('span');
  probe.style.color = 'var(' + token + ')';
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}
function fmtPrice(p) {
  if (p === null || p === undefined || isNaN(p)) return '—';
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 100) return '$' + p.toFixed(1);
  if (p >= 1) return '$' + p.toFixed(2);
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toPrecision(3);
}
function fmtCap(m) {
  if (!m || isNaN(m)) return '—';
  if (m >= 1e12) return '$' + (m / 1e12).toFixed(2) + 'T';
  if (m >= 1e9) return '$' + (m / 1e9).toFixed(2) + 'B';
  if (m >= 1e6) return '$' + (m / 1e6).toFixed(2) + 'M';
  return '$' + m.toFixed(0);
}
function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}
function signClass(v) { return v >= 0 ? 'up' : 'down'; }
function fngLabel(v) {
  if (v <= 24) return '极度恐惧';
  if (v <= 44) return '恐惧';
  if (v <= 55) return '中性';
  if (v <= 74) return '贪婪';
  return '极度贪婪';
}
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
function pad2(n) { return String(n).padStart(2, '0'); }

// ============================================================
// 币种图标：每个币都尽量给一张真图标
//   后端 /api/icon 依次尝试 币安 logo 库(经 wsrv 代理) -> CoinLore，
//   命中即落盘并长缓存；真拿不到的退化成首字母色块（保证列表里每行都有图标）
// ============================================================
const ICON_OK = Object.create(null);   // 已知有真图标的
const ICON_BAD = Object.create(null);  // 已知没有的，直接走首字母，不再发请求
function baseOf(sym) {
  const s = String(sym || '').toUpperCase();
  const stripped = s.replace(/USDT$/, '');
  return stripped || s; // 币种本身就是 USDT 时，不能剥成空串
}
// "1000CAT" 这种显示成 "1KCAT"，省得把整列撑开
function iconLabel(base) { return base.replace(/^1000/, '1K'); }
// 由币种名稳定地生成一个色相，保证首字母色块不会一片灰
const CI_HUES = [210, 160, 28, 276, 340, 190, 45, 118, 0, 300];
function ciHue(base) {
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return CI_HUES[h % CI_HUES.length];
}
function ciHtml(sym, size) {
  const b = baseOf(sym);
  if (!b) return '';
  const cls = 'ci' + (size ? ' ci-' + size : '');
  const label = iconLabel(b);
  const src = ICON_BAD[b] ? '' : '/api/icon?base=' + encodeURIComponent(b);
  const font = label.length > 2 ? 5.6 : 7.4; // 3 个字符要缩一号才塞得下
  const fallback = '<svg viewBox="0 0 18 18" width="100%" height="100%" aria-hidden="true"><rect width="18" height="18" fill="hsl(' + ciHue(b) + ', 52%, 42%)"/>'
    + '<text x="9" y="12.6" font-size="' + font + '" text-anchor="middle" fill="#fff" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="700">'
    + escAttr(label.slice(0, 3)) + '</text></svg>';
  return '<span class="' + cls + '">' + fallback
    + '<img src="' + src + '" alt="" loading="lazy" decoding="async"'
    + ' onerror="iconFail(this)" onload="iconLoad(this)"></span>';
}
// 图标取到了：把底下的首字母藏起来
function iconLoad(img) {
  const b = baseOf((img.getAttribute('src') || '').replace(/^.*base=/, ''));
  if (b) ICON_OK[b] = 1;
  img.previousElementSibling.style.display = 'none';
}
// 取不到：记下来，之后都用首字母，省掉无意义的请求
function iconFail(img) {
  const b = baseOf((img.getAttribute('src') || '').replace(/^.*base=/, ''));
  if (b) ICON_BAD[b] = 1;
  img.style.display = 'none';
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 币种格：图标 + 可点击的代号
function coinCell(sym, label, size, clickable) {
  const txt = escAttr(label === undefined ? baseOf(sym) : label);
  return '<span class="cc">' + ciHtml(sym, size)
    + (clickable === false ? '<span class="sym">' + txt + '</span>'
       : '<span class="coin sym" data-kline="' + escAttr(sym) + '">' + txt + '</span>') + '</span>';
}

const state = { view: 'market', symbol: 'BTCUSDT', interval: '5m', candles: [], hover: null, market: null, momentum: null, scan: null };

// 主题色（canvas / Chart.js 都读不到 CSS 变量，只能探测后缓存）
function readColors() {
  return {
    up: themeColor('--up'), down: themeColor('--down'),
    border: themeColor('--border'), muted: themeColor('--muted-foreground'),
    fg: themeColor('--foreground'), card: themeColor('--card'), primary: themeColor('--primary'),
    s1: themeColor('--viz-series-1'), s2: themeColor('--viz-series-2'), s3: themeColor('--viz-series-3'),
  };
}
let C = readColors();
// 给主题色叠透明度（热力图底色、渐变填充用）
function withAlpha(c, a) {
  const m = String(c).match(/rgba?\(([^)]+)\)/);
  if (!m) return c;
  const p = m[1].split(',');
  return 'rgba(' + parseFloat(p[0]) + ',' + parseFloat(p[1]) + ',' + parseFloat(p[2]) + ',' + a + ')';
}

// ============================================================
// 主题：浅色 / 深色 / 跟随系统
// ============================================================
const THEME_KEY = 'cmd-theme';
function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return (t === 'light' || t === 'dark') ? t : 'auto';
}
// 配色全部由 light-dark() 决定，所以只需要钉住 color-scheme
function applyTheme(mode, persist) {
  if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
  else document.documentElement.removeAttribute('data-theme');
  if (persist !== false) {
    try {
      if (mode === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch (e) {}
  }
  syncThemeButtons();
  refreshThemeColors();
}
function syncThemeButtons() {
  const cur = currentTheme();
  Array.prototype.forEach.call(document.querySelectorAll('#themeSeg button'), (b) => {
    b.className = (b.getAttribute('data-theme') === cur) ? 'on' : '';
  });
}
// 关键：canvas 与 Chart.js 用的是启动时探测的旧色值，换主题必须重算并重绘
function refreshThemeColors() {
  C = readColors();
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = C.border;
  if (fngChart) {
    fngChart.data.datasets[0].borderColor = C.s1;
    fngChart.data.datasets[0].backgroundColor = fngGradient();
    fngChart.options.scales.y.grid.color = C.border;
    fngChart.update('none');
  }
  if (donutChart) {
    donutChart.data.datasets[0].backgroundColor = [C.s1, C.s2, C.s3];
    donutChart.update('none');
  }
  if (state.candles.length) drawKline();
  if (state.momentum) {
    renderHeat(state.momentum);
    renderVolBars(state.momentum);
    renderScatter(state.momentum);
  }
  if (hlChart) {
    hlChart.data.datasets[0].borderColor = C.up;
    hlChart.data.datasets[1].borderColor = C.down;
    hlChart.options.scales.y.grid.color = C.border;
    hlChart.update('none');
  }
}

// ============================================================
// 大盘：统计块 / 表格 / 恐贪 / 占比
// ============================================================
let fngChart = null, donutChart = null;

function renderStats(d) {
  const g = d.global;
  document.getElementById('stMcap').textContent = fmtCap(g.mcap);
  const chg = document.getElementById('stMcapChg');
  chg.textContent = '24h ' + fmtPct(g.mcapChg);
  chg.className = 'sub ' + signClass(g.mcapChg);
  document.getElementById('stVol').textContent = fmtCap(g.vol);
  document.getElementById('stBtcD').textContent = g.btcD.toFixed(2) + '%';
  document.getElementById('stEthD').textContent = g.ethD.toFixed(2) + '%';
  document.getElementById('stFng').textContent = d.fng.value + ' / 100';

  const badge = document.getElementById('fngBadge');
  badge.textContent = '情绪 · ' + fngLabel(d.fng.value);
  document.getElementById('donutSub').textContent = '全市场约 ' + fmtCap(g.mcap);
  document.getElementById('donutBtc').textContent = g.btcD.toFixed(1) + '%';

  const snap = d.fng.series.length ? new Date(d.fng.series[d.fng.series.length - 1].t * 1000) : new Date(d.updated);
  document.getElementById('snap').textContent = snap.toISOString().slice(0, 10);
  document.getElementById('updated').textContent = new Date(d.updated).toLocaleTimeString('zh-CN', { hour12: false });
}

function renderTable(coins) {
  const rows = coins.slice(0, 10);
  let html = '';
  rows.forEach((c) => {
    html += '<tr><td>' + coinCell(c.s + 'USDT', c.s) + ' <span class="name">' + c.n + '</span></td>'
      + '<td>' + fmtPrice(c.p) + '</td>'
      + '<td class="' + signClass(c.c1) + '">' + fmtPct(c.c1) + '</td>'
      + '<td class="' + signClass(c.c24) + '">' + fmtPct(c.c24) + '</td>'
      + '<td class="' + signClass(c.c7) + '">' + fmtPct(c.c7) + '</td>'
      + '<td>' + fmtCap(c.m) + '</td></tr>';
  });
  document.getElementById('mcapBody').innerHTML = html;
}

function fngGradient() {
  const g = document.getElementById('fngChart').getContext('2d').createLinearGradient(0, 0, 0, 190);
  g.addColorStop(0, withAlpha(C.s1, 0.28));
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  return g;
}

function renderFng(d) {
  const labels = d.fng.series.map((p) => {
    const dt = new Date(p.t * 1000);
    return (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate();
  });
  const values = d.fng.series.map((p) => p.v);
  const ctx = document.getElementById('fngChart');
  if (fngChart) { fngChart.data.labels = labels; fngChart.data.datasets[0].data = values; fngChart.update(); return; }
  const grad = fngGradient();
  fngChart = new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: [{ data: values, borderColor: C.s1, backgroundColor: grad, fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.y + ' · ' + fngLabel(c.parsed.y) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { min: 0, max: 100, ticks: { stepSize: 25 }, grid: { color: C.border } },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function renderDonut(d) {
  const g = d.global;
  const data = [g.btcD, g.ethD, Math.max(0, 100 - g.btcD - g.ethD)];
  const ctx = document.getElementById('donut');
  if (donutChart) { donutChart.data.datasets[0].data = data; donutChart.update(); return; }
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['BTC', 'ETH', '其他'],
      datasets: [{ data: data, backgroundColor: [C.s1, C.s2, C.s3], borderWidth: 0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '64%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { callbacks: { label: (c) => c.label + ' ' + Number(c.parsed).toFixed(2) + '%' } },
      },
    },
  });
}

async function loadMarket() {
  try {
    const d = await fetchJSON('/api/market');
    if (!d.ok) throw new Error(d.error || 'no data');
    state.market = d;
    renderStats(d); renderTable(d.coins); renderFng(d); renderDonut(d);
  } catch (e) {
    document.getElementById('updated').textContent = '大盘数据不可达';
  }
}

// ============================================================
// 动量与波动率
// ============================================================
function heatBg(v, scale) {
  if (v === null || v === undefined || isNaN(v)) return 'transparent';
  const a = (Math.min(1, Math.abs(v) / scale) * 0.5 + 0.05).toFixed(3);
  return withAlpha(v >= 0 ? C.up : C.down, a); // 深色模式下用亮色，不然糊在深底上看不清
}
function renderHeat(d) {
  const rows = d.coins.slice().sort((a, b) => (b.rets['1h'] || 0) - (a.rets['1h'] || 0));
  const scale = {};
  d.horizons.forEach((h) => {
    let m = 0;
    d.coins.forEach((c) => { const v = Math.abs(c.rets[h] || 0); if (v > m) m = v; });
    scale[h] = Math.max(m, 0.1);
  });
  let html = '<table class="heat"><thead><tr><th>币种</th>';
  d.horizons.forEach((h) => { html += '<th>' + h + '</th>'; });
  html += '<th>1h波动</th><th>量能</th></tr></thead><tbody>';
  rows.forEach((c) => {
    const acc = c.volAccel || 1;
    const accTxt = '<span class="' + (acc >= 1.2 ? 'up' : acc <= 0.8 ? 'down' : '') + '">×' + acc.toFixed(1) + '</span>';
    html += '<tr><td class="sym">' + (c.dyn ? '<span class="dot" title="扫描发现的异动币"></span>' : '') + coinCell(c.symbol, c.base) + '</td>';
    d.horizons.forEach((h) => {
      html += '<td style="background:' + heatBg(c.rets[h], scale[h]) + '">' + fmtPct(c.rets[h]) + '</td>';
    });
    html += '<td>' + c.rv1h.toFixed(2) + '%</td><td>' + accTxt + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('heat').innerHTML = html;
}

function renderVolBars(d) {
  const top = d.coins.slice().sort((a, b) => b.rv1h - a.rv1h).slice(0, 12);
  const max = top.length ? top[0].rv1h : 1;
  let html = '';
  top.forEach((c, i) => {
    const w = Math.max(3, (c.rv1h / max) * 100);
    const ex = c.volExpansion;
    const cls = ex >= 1.25 ? 'hot' : ex <= 0.8 ? 'cool' : '';
    const exTxt = (ex >= 1.25 ? '扩 ' : ex <= 0.8 ? '收 ' : '') + ex.toFixed(2) + '×';
    html += '<div class="vrow">'
      + '<span class="rk">' + (i + 1) + '</span>'
      + '<span class="cc">' + ciHtml(c.symbol, 'sm') + '<span class="sym">' + c.base + '</span></span>'
      + '<span class="track"><span class="bar" style="width:' + w.toFixed(1) + '%"></span></span>'
      + '<span class="val">' + c.rv1h.toFixed(2) + '%</span>'
      + '<span class="chip ' + cls + '" title="近 1 小时波动 ÷ 近 24 小时波动">' + exTxt + '</span>'
      + '</div>';
  });
  document.getElementById('volBars').innerHTML = html;
}

function renderScatter(d) {
  const W = 600, H = 300, padL = 40, padR = 56, padT = 14, padB = 30;
  const pw = W - padL - padR, ph = H - padT - padB;
  let xmax = 0.05, ymax = 0.1, vmax = 1;
  d.coins.forEach((c) => {
    const xv = Math.abs(c.rets['1h'] || 0);
    if (xv > xmax) xmax = xv;
    if (c.rv1h > ymax) ymax = c.rv1h;
    if ((c.vol24h || 0) > vmax) vmax = c.vol24h || 0;
  });
  ymax = ymax * 1.15;
  const X = (v) => padL + ((v + xmax) / (2 * xmax)) * pw;
  const Y = (v) => padT + ph - (v / ymax) * ph;
  const R = (c) => 2.5 + Math.sqrt((c.vol24h || 0) / vmax) * 9;

  let s = '<svg class="scatter-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
  for (let i = 0; i <= 4; i++) {
    const yy = padT + (ph * i) / 4;
    s += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '" stroke="' + C.border + '" stroke-width="1"/>';
    s += '<text x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1) + '" fill="' + C.muted + '" font-size="10" text-anchor="end">' + (ymax * (1 - i / 4)).toFixed(1) + '%</text>';
  }
  const x0 = X(0);
  s += '<line x1="' + x0.toFixed(1) + '" y1="' + padT + '" x2="' + x0.toFixed(1) + '" y2="' + (padT + ph) + '" stroke="' + C.muted + '" stroke-dasharray="4 3" stroke-width="1" opacity="0.55"/>';
  s += '<text x="' + (x0 + 4).toFixed(1) + '" y="' + (padT + 11) + '" fill="' + C.muted + '" font-size="9.5">动量为 0</text>';

  const labeled = {};
  d.coins.slice().sort((a, b) => Math.abs(b.rets['1h'] || 0) - Math.abs(a.rets['1h'] || 0)).slice(0, 6).forEach((c) => { labeled[c.base] = 1; });
  d.coins.slice().sort((a, b) => b.rv1h - a.rv1h).slice(0, 4).forEach((c) => { labeled[c.base] = 1; });

  d.coins.forEach((c) => {
    const m1 = c.rets['1h'] || 0;
    const cx = X(m1), cy = Y(c.rv1h), rr = R(c);
    const up = m1 >= 0;
    s += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + rr.toFixed(1) + '" fill="' + (up ? C.up : C.down) + '" fill-opacity="0.4" stroke="' + (up ? C.up : C.down) + '" stroke-width="1">'
      + '<title>' + c.base + ' 1h ' + fmtPct(m1) + ' · 波动 ' + c.rv1h.toFixed(2) + '%/日 · 24h量 ' + fmtCap(c.vol24h) + '</title></circle>';
    if (labeled[c.base]) {
      s += '<text x="' + (cx + rr + 2).toFixed(1) + '" y="' + (cy + 3).toFixed(1) + '" fill="' + C.muted + '" font-size="9.5">' + c.base + '</text>';
    }
  });
  s += '<text x="' + (padL + pw / 2) + '" y="' + (H - 8) + '" fill="' + C.muted + '" font-size="10" text-anchor="middle">近 1 小时动量 →（右=上涨，左=下跌）</text>';
  s += '<text x="11" y="' + (padT + ph / 2) + '" fill="' + C.muted + '" font-size="10" text-anchor="middle" transform="rotate(-90 11 ' + (padT + ph / 2) + ')">1h 波动率（日均 %）</text>';
  s += '</svg>';
  document.getElementById('scatter').innerHTML = s;
}

function renderConclusion(d) {
  const byMom = d.coins.slice().sort((a, b) => (b.rets['1h'] || 0) - (a.rets['1h'] || 0));
  const lead = byMom[0], lag = byMom[byMom.length - 1];
  const volKing = d.coins.slice().sort((a, b) => b.rv1h - a.rv1h)[0];
  const exp = d.coins.slice().sort((a, b) => b.volExpansion - a.volExpansion)[0];
  const b1 = d.breadth['1h'] || { up: 0, total: 0 };
  const b24 = d.breadth['24h'] || { up: 0, total: 0 };
  document.getElementById('conclusion').innerHTML = [
    '1h 动量最强 <b>' + lead.base + '</b> ' + fmtPct(lead.rets['1h']),
    '最弱 <b>' + lag.base + '</b> ' + fmtPct(lag.rets['1h']),
    '波动最猛 <b>' + volKing.base + '</b> ' + volKing.rv1h.toFixed(2) + '%/日',
    '波动扩张 <b>' + exp.base + '</b> ×' + exp.volExpansion.toFixed(2),
    '宽度 1h ' + b1.up + '/' + b1.total + ' · 24h ' + b24.up + '/' + b24.total + ' 上涨',
  ].join(' ｜ ');
  const badge = document.getElementById('momBadge');
  badge.className = 'badge';
  badge.textContent = d.count + ' 币 · 5m 聚合';
}

async function loadMomentum() {
  try {
    const d = await fetchJSON('/api/momentum');
    if (!d.ok || !d.coins.length) throw new Error(d.error || 'no data');
    state.momentum = d;
    renderHeat(d); renderVolBars(d); renderScatter(d); renderConclusion(d);
  } catch (e) {
    const badge = document.getElementById('momBadge');
    badge.textContent = '动量数据不可达';
  }
}

// ============================================================
// 全市场异动扫描（动态发现，不预设币种）
// ============================================================
const SCAN_COLS = [{ k: 'm5', label: '5m' }, { k: 'm15', label: '15m' }, { k: 'm30', label: '30m' }, { k: 'h1', label: '1h' }, { k: 'h4', label: '4h' }];
const SCAN_ROWS = 50;
let scanHorizon = 'h1', scanQuery = '';

function buildScanTabs() {
  const seg = document.getElementById('scanTabs');
  seg.innerHTML = SCAN_COLS.map((c) => '<button type="button" data-h="' + c.k + '"' + (c.k === scanHorizon ? ' class="on"' : '') + '>' + c.label + '</button>').join('');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-h]');
    if (!b) return;
    scanHorizon = b.getAttribute('data-h');
    Array.prototype.forEach.call(seg.querySelectorAll('button'), (o) => { o.className = (o === b) ? 'on' : ''; });
    if (state.scan) renderScan(state.scan);
  });
}

function scanSorted(d) {
  const q = scanQuery.trim().toUpperCase();
  const list = q ? d.coins.filter((c) => c.s.indexOf(q) >= 0) : d.coins;
  return list.slice().sort((a, b) => (b[scanHorizon] || 0) - (a[scanHorizon] || 0));
}

function renderScan(d) {
  const list = scanSorted(d);
  const rows = list.slice(0, SCAN_ROWS);
  let html = '<table class="tbl scan"><thead><tr><th>#</th><th>币种</th><th>价格</th>';
  SCAN_COLS.forEach((c) => { html += '<th class="' + (c.k === scanHorizon ? 'on' : '') + '">' + c.label + '</th>'; });
  html += '<th>24h</th><th>24h 成交额</th><th>1h波动</th><th>量能</th></tr></thead><tbody>';
  rows.forEach((c, i) => {
    html += '<tr data-sym="' + c.sym + '"><td class="rk">' + (i + 1) + '</td>'
      + '<td>' + coinCell(c.sym, c.s) + '</td><td>' + fmtPrice(c.p) + '</td>';
    SCAN_COLS.forEach((col) => {
      html += '<td class="' + (col.k === scanHorizon ? 'hi ' : '') + signClass(c[col.k]) + '">' + fmtPct(c[col.k]) + '</td>';
    });
    const acc = c.acc || 1;
    html += '<td class="' + signClass(c.c24) + '">' + fmtPct(c.c24) + '</td>'
      + '<td>' + fmtCap(c.qv) + '</td>'
      + '<td>' + c.rv1h.toFixed(2) + '%</td>'
      + '<td class="' + (acc >= 1.5 ? 'up' : '') + '">×' + acc.toFixed(2) + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('scanTable').innerHTML = html;

  const label = (SCAN_COLS.filter((c) => c.k === scanHorizon)[0] || {}).label || scanHorizon;
  const byM5 = d.coins.slice().sort((a, b) => (b.m5 || 0) - (a.m5 || 0))[0];
  const byC24 = d.coins.slice().sort((a, b) => b.c24 - a.c24)[0];
  document.getElementById('scanLead').innerHTML = list.length
    ? [label + ' 领涨 <b>' + list[0].s + '</b> ' + fmtPct(list[0][scanHorizon]),
       '领跌 <b>' + list[list.length - 1].s + '</b> ' + fmtPct(list[list.length - 1][scanHorizon]),
       '5m 最猛 <b>' + byM5.s + '</b> ' + fmtPct(byM5.m5),
       '24h 涨幅之最 <b>' + byC24.s + '</b> ' + fmtPct(byC24.c24)].join(' ｜ ')
    : '没有匹配的币种';
  document.getElementById('scanFoot').textContent = '显示 ' + rows.length + ' / ' + list.length + ' 个'
    + (scanQuery ? '（搜索：' + scanQuery + '）' : '') + ' · 点击任意一行直接看它的 K 线';
  document.getElementById('scanSub').textContent = '全市场 ' + d.scanned + '/' + d.universe + ' 个在交易的 USDT 现货对（已剔除 '
    + (d.dropped || 0) + ' 个下架/停牌）· 24h 成交额 ≥ $' + Math.round(d.threshold / 10000) + ' 万 · '
    + new Date(d.updated).toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新';
}

function augmentSymbolSelect(d) {
  d.coins.slice().sort((a, b) => Math.abs(b.h1 || 0) - Math.abs(a.h1 || 0)).slice(0, 15)
    .forEach((c) => ensureOption(c.sym, '（扫描）'));
}

async function loadScan() {
  try {
    const d = await fetchJSON('/api/scan');
    if (!d.ok || !d.coins.length) throw new Error(d.error || 'no data');
    state.scan = d;
    if (!document.getElementById('scanTabs').children.length) buildScanTabs();
    renderScan(d);
    augmentSymbolSelect(d);
  } catch (e) {
    document.getElementById('scanLead').textContent = '扫描数据不可达：' + e.message;
  }
}

document.getElementById('scanSearch').addEventListener('input', (e) => {
  scanQuery = e.target.value || '';
  if (state.scan) renderScan(state.scan);
});
document.getElementById('scanTable').addEventListener('click', (e) => {
  if (e.target.closest('[data-kline]')) return; // 币种单元格交给弹窗
  const tr = e.target.closest('tr[data-sym]');
  if (tr) setKlineSymbol(tr.getAttribute('data-sym'));
});

// ============================================================
// K 线（canvas 蜡烛 + 成交量 + 十字光标）
// ============================================================
function fmtAxisTime(ts, iv) {
  const d = new Date(ts);
  const mm = pad2(d.getMonth() + 1), dd = pad2(d.getDate());
  const hh = pad2(d.getHours()), mi = pad2(d.getMinutes());
  if (iv === '1d') return mm + '-' + dd;
  if (iv === '12h' || iv === '4h') return mm + '-' + dd + ' ' + hh + ':00';
  return hh + ':' + mi;
}
function fmtFullTime(ts) {
  const d = new Date(ts);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// 右侧留白比例：最后一根 K 线不贴右边框，留出可悬停/可点击的余量
const CANDLE_RIGHT_GAP = 0.12;

// 由鼠标 x 反推第几根 K 线；右侧留白区域吸附到最后一根，保证能点到
function candleIndexAt(cv, clientX, n) {
  if (!n) return null;
  const W = cv.parentElement.clientWidth;
  const padL = 62, padR = 66;
  const candlesW = (W - padL - padR) * (1 - CANDLE_RIGHT_GAP);
  const rel = clientX - cv.getBoundingClientRect().left - padL;
  if (rel < 0) return null;
  const idx = Math.floor((rel / candlesW) * n);
  return Math.min(n - 1, idx);
}

// 指标配色（中间饱和度，明暗主题下都能看清）
const IND_COLORS = { ma5: '#f0a020', ma10: '#8b5cf6', ma20: '#06b6d4', ema12: '#ec4899', ema26: '#10b981', boll: '#6366f1' };

function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
}
function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function emaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += arr[j];
      prev = s / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}
function bollSeries(closes, n, mult) {
  const mid = sma(closes, n);
  const up = new Array(closes.length).fill(null);
  const low = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j] - m) * (closes[j] - m);
    const sd = Math.sqrt(v / n);
    up[i] = m + mult * sd;
    low[i] = m - mult * sd;
  }
  return { mid: mid, up: up, low: low };
}
function macdSeries(closes, fast, slow, signal) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const dif = closes.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
  const dea = new Array(closes.length).fill(null);
  const k = 2 / (signal + 1);
  let prev = null, cnt = 0, seed = 0;
  for (let i = 0; i < dif.length; i++) {
    if (dif[i] === null) continue;
    cnt++;
    if (cnt < signal) { seed += dif[i]; continue; }
    if (cnt === signal) { seed += dif[i]; prev = seed / signal; dea[i] = prev; continue; }
    prev = dif[i] * k + prev * (1 - k);
    dea[i] = prev;
  }
  const hist = closes.map((_, i) => (dif[i] !== null && dea[i] !== null) ? (dif[i] - dea[i]) * 2 : null);
  return { dif: dif, dea: dea, hist: hist };
}
function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}
// 同一份 candles 只算一次（鼠标移动会反复重绘）
const indCacheMap = new WeakMap();
function computeIndicators(candles) {
  const hit = indCacheMap.get(candles);
  if (hit) return hit;
  const closes = candles.map((k) => k.c);
  const val = {
    ma5: sma(closes, 5), ma10: sma(closes, 10), ma20: sma(closes, 20),
    ema12: emaSeries(closes, 12), ema26: emaSeries(closes, 26),
    boll: bollSeries(closes, 20, 2),
    macd: macdSeries(closes, 12, 26, 9),
    rsi: rsiSeries(closes, 14),
  };
  indCacheMap.set(candles, val);
  return val;
}

// 指标开关（主图与弹窗共用）
const IND = { ma: true, ema: false, boll: false, vol: true, sub: 'none' };

function syncIndButtons() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-indbar] button'), (b) => {
    const k = b.getAttribute('data-ind');
    const on = (k === 'macd' || k === 'rsi') ? (IND.sub === k) : !!IND[k];
    b.className = on ? 'on' : '';
  });
}
function toggleInd(k) {
  if (k === 'macd' || k === 'rsi') IND.sub = (IND.sub === k) ? 'none' : k;
  else IND[k] = !IND[k];
  syncIndButtons();
  drawKline();
  if (!document.getElementById('klineModal').hidden) drawModal();
}
function initIndicators() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-indbar]'), (bar) => {
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-ind]');
      if (b) toggleInd(b.getAttribute('data-ind'));
    });
  });
  syncIndButtons();
}

function drawCandles(cv, candles, interval, hover, ohlcElId, marks, indCfg) {
  const wrap = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth || 900, H = wrap.clientHeight || 380;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const IC = indCfg || IND;
  const body = candles;
  const setOhlc = (k) => {
    if (!ohlcElId) return;
    const el = document.getElementById(ohlcElId);
    if (!el) return;
    el.innerHTML = '<span>开 ' + fmtPrice(k.o) + '</span><span>高 ' + fmtPrice(k.h) + '</span>'
      + '<span>低 ' + fmtPrice(k.l) + '</span><span>收 ' + fmtPrice(k.c) + '</span>'
      + '<span>量 ' + k.v.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</span>';
  };
  if (!body.length) {
    ctx.fillStyle = C.muted; ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('K 线加载中…', W / 2, H / 2);
    return;
  }
  const n = body.length;
  const ind = computeIndicators(body);
  const subOn = IC.sub !== 'none';
  const volOn = IC.vol;

  const padL = 62, padR = 66, padT = 10, padB = 22, gapv = 8;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const volH = volOn ? 44 : 0;
  const subH = subOn ? 64 : 0;
  const priceH = plotH - volH - subH - (volOn ? gapv : 0) - (subOn ? gapv : 0);
  const candlesW = plotW * (1 - CANDLE_RIGHT_GAP);
  const step = candlesW / n;
  const cw = Math.max(1, step * 0.68);

  const priceTop = padT, priceBottom = padT + priceH;
  let cursor = priceBottom, subTop = 0, volTop = 0;
  if (subOn) { subTop = cursor + gapv; cursor = subTop + subH; }
  if (volOn) { volTop = cursor + gapv; }
  const panesBottom = volOn ? (volTop + volH) : (subOn ? (subTop + subH) : priceBottom);

  // 价格区间（布林带也纳入，避免被裁）
  let hi = -Infinity, lo = Infinity, vmax = 0;
  for (let i = 0; i < n; i++) {
    const k = body[i];
    if (k.h > hi) hi = k.h;
    if (k.l < lo) lo = k.l;
    if (k.v > vmax) vmax = k.v;
  }
  if (IC.boll) {
    for (let i = 0; i < n; i++) {
      const u = ind.boll.up[i], d = ind.boll.low[i];
      if (u !== null && u > hi) hi = u;
      if (d !== null && d < lo) lo = d;
    }
  }
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) hi = lo + 1;
  const rawSpan = hi - lo;
  hi += rawSpan * 0.06; lo -= rawSpan * 0.06;
  const span = hi - lo || 1;
  const Y = (v) => priceTop + priceH - ((v - lo) / span) * priceH;
  const X = (i) => padL + (i + 0.5) * step;
  const volY = (v) => volTop + volH - (vmax ? (v / vmax) * volH : 0);

  const stroke = (series, color, width, yFn) => {
    const yy = yFn || Y;
    ctx.strokeStyle = color; ctx.lineWidth = width || 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      if (v === null || v === undefined || !isFinite(v)) { started = false; continue; }
      const x = X(i), y = yy(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  };

  // 价格网格
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span * i) / 4;
    const yy = Y(v);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.textAlign = 'right';
    ctx.fillText(fmtPrice(v), padL - 6, yy);
  }
  // 时间刻度
  ctx.textAlign = 'center'; ctx.fillStyle = C.muted;
  const tickN = Math.max(1, Math.floor(n / 7));
  for (let i = 0; i < n; i += tickN) ctx.fillText(fmtAxisTime(body[i].t, interval), X(i), H - 9);

  // 成交量
  if (volOn) {
    for (let i = 0; i < n; i++) {
      const k = body[i];
      ctx.fillStyle = (k.c >= k.o ? C.up : C.down);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(X(i) - cw / 2, volY(k.v), cw, Math.max(1, volTop + volH - volY(k.v)));
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = C.muted; ctx.textAlign = 'left';
    ctx.fillText('VOL', padL + 4, volTop + 8);
  }

  // 布林带
  if (IC.boll) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = ind.boll.up[i];
      if (v === null) { continue; }
      const x = X(i), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    if (started) {
      for (let i = n - 1; i >= 0; i--) {
        const v = ind.boll.low[i];
        if (v === null) continue;
        ctx.lineTo(X(i), Y(v));
      }
      ctx.closePath();
      ctx.fillStyle = hexA(IND_COLORS.boll, 0.08);
      ctx.fill();
      stroke(ind.boll.up, hexA(IND_COLORS.boll, 0.7), 1);
      stroke(ind.boll.low, hexA(IND_COLORS.boll, 0.7), 1);
      stroke(ind.boll.mid, IND_COLORS.boll, 1.2);
    }
  }

  // 蜡烛
  for (let i = 0; i < n; i++) {
    const k = body[i];
    const col = k.c >= k.o ? C.up : C.down;
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(i), Y(k.h)); ctx.lineTo(X(i), Y(k.l)); ctx.stroke();
    ctx.fillStyle = col;
    const yO = Y(k.o), yC = Y(k.c);
    ctx.fillRect(X(i) - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
  }

  // 均线叠加
  if (IC.ma) {
    stroke(ind.ma5, IND_COLORS.ma5, 1.3);
    stroke(ind.ma10, IND_COLORS.ma10, 1.3);
    stroke(ind.ma20, IND_COLORS.ma20, 1.3);
  }
  if (IC.ema) {
    stroke(ind.ema12, IND_COLORS.ema12, 1.3);
    stroke(ind.ema26, IND_COLORS.ema26, 1.3);
  }

  // 策略买卖点
  if (marks && marks.length) {
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let m = 0; m < marks.length; m++) {
      const mk = marks[m];
      if (mk.i < 0 || mk.i >= n) continue;
      const k = body[mk.i];
      const x = X(mk.i);
      const below = (mk.kind === 'buy' || mk.kind === 'cover');
      const col = mk.kind === 'liq' ? '#ef4444'
        : mk.kind === 'sell' ? '#f0a020'
        : mk.kind === 'short' ? C.down : C.up;
      const label = mk.kind === 'buy' ? '买' : mk.kind === 'short' ? '空'
        : mk.kind === 'sell' ? '卖' : mk.kind === 'cover' ? '平' : '爆';
      const yTip = below ? Y(k.l) + 6 : Y(k.h) - 6;
      ctx.fillStyle = col;
      ctx.beginPath();
      if (below) { ctx.moveTo(x, yTip); ctx.lineTo(x - 5, yTip + 9); ctx.lineTo(x + 5, yTip + 9); }
      else { ctx.moveTo(x, yTip); ctx.lineTo(x - 5, yTip - 9); ctx.lineTo(x + 5, yTip - 9); }
      ctx.closePath(); ctx.fill();
      ctx.fillText(label, x, below ? yTip + 17 : yTip - 17);
    }
  }

  // 副图：MACD / RSI
  if (subOn) {
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, subTop); ctx.lineTo(W - padR, subTop); ctx.stroke();
    if (IC.sub === 'macd') {
      let mx = 0, mn = 0;
      for (let i = 0; i < n; i++) {
        const arr = [ind.macd.dif[i], ind.macd.dea[i], ind.macd.hist[i]];
        for (let j = 0; j < 3; j++) {
          const v = arr[j];
          if (v === null || !isFinite(v)) continue;
          if (v > mx) mx = v;
          if (v < mn) mn = v;
        }
      }
      const rng = (mx - mn) || 1;
      const SY = (v) => subTop + subH - ((v - mn) / rng) * subH;
      ctx.strokeStyle = C.border;
      ctx.beginPath(); ctx.moveTo(padL, SY(0)); ctx.lineTo(W - padR, SY(0)); ctx.stroke();
      for (let i = 0; i < n; i++) {
        const h = ind.macd.hist[i];
        if (h === null) continue;
        ctx.fillStyle = (h >= 0 ? C.up : C.down);
        ctx.globalAlpha = 0.6;
        const y0 = SY(0), y1 = SY(h);
        ctx.fillRect(X(i) - cw / 2, Math.min(y0, y1), cw, Math.max(1, Math.abs(y1 - y0)));
        ctx.globalAlpha = 1;
      }
      stroke(ind.macd.dif, IND_COLORS.ma5, 1.2, SY);
      stroke(ind.macd.dea, IND_COLORS.ma20, 1.2, SY);
      ctx.fillStyle = C.muted; ctx.textAlign = 'left';
      ctx.fillText('MACD(12,26,9)', padL + 4, subTop + 9);
    } else if (IC.sub === 'rsi') {
      const SY = (v) => subTop + subH - (v / 100) * subH;
      ctx.strokeStyle = C.border; ctx.setLineDash([3, 3]);
      [30, 70].forEach((v) => {
        ctx.beginPath(); ctx.moveTo(padL, SY(v)); ctx.lineTo(W - padR, SY(v)); ctx.stroke();
      });
      ctx.setLineDash([]);
      stroke(ind.rsi, IND_COLORS.ema12, 1.4, SY);
      ctx.fillStyle = C.muted; ctx.textAlign = 'left';
      ctx.fillText('RSI(14)', padL + 4, subTop + 9);
    }
  }

  // 最新价虚线 + 标签
  const last = body[n - 1];
  const yLast = Y(last.c);
  ctx.strokeStyle = C.primary; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yLast); ctx.lineTo(W - padR, yLast); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = C.primary; ctx.textAlign = 'left';
  ctx.fillText(fmtPrice(last.c), W - padR + 6, yLast);

  // 指标图例（显示悬停那根 / 或者最后一根的值）
  const ref = (hover !== null && hover >= 0 && hover < n) ? hover : n - 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let lx = padL + 4, ly = priceTop + 10;
  const put = (label, color, val) => {
    const txt = label + ' ' + (val === null || val === undefined || !isFinite(val) ? '—' : fmtPrice(val));
    const wdt = ctx.measureText(txt).width;
    if (lx + wdt > W - padR) { lx = padL + 4; ly += 13; }
    ctx.fillStyle = color;
    ctx.fillText(txt, lx, ly);
    lx += wdt + 12;
  };
  if (IC.ma) { put('MA5', IND_COLORS.ma5, ind.ma5[ref]); put('MA10', IND_COLORS.ma10, ind.ma10[ref]); put('MA20', IND_COLORS.ma20, ind.ma20[ref]); }
  if (IC.ema) { put('EMA12', IND_COLORS.ema12, ind.ema12[ref]); put('EMA26', IND_COLORS.ema26, ind.ema26[ref]); }
  if (IC.boll) put('BOLL', IND_COLORS.boll, ind.boll.mid[ref]);

  // 十字光标
  const hv = hover;
  if (hv !== null && hv >= 0 && hv < n) {
    const k = body[hv];
    const hx = X(hv), hy = Y(k.c);
    ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, panesBottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(W - padR, hy); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    const lines = [
      fmtFullTime(k.t),
      '开 ' + fmtPrice(k.o) + '   高 ' + fmtPrice(k.h),
      '低 ' + fmtPrice(k.l) + '   收 ' + fmtPrice(k.c),
      '量 ' + k.v.toLocaleString('en-US', { maximumFractionDigits: 1 }),
    ];
    const bw = 176, bh = 14 * lines.length + 12;
    let bx = hx + 12;
    if (bx + bw > W - padR) bx = hx - bw - 12;
    const by = Math.max(priceTop + 6, ly + 16);
    ctx.fillStyle = C.card; ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh); }
    ctx.fillStyle = C.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], bx + 10, by + 12 + i * 14);

    setOhlc(k);
  } else {
    setOhlc(last);
  }
}

function drawKline() {
  drawCandles(document.getElementById('klineCanvas'), state.candles, state.interval, state.hover, 'klineOhlc');
}

function renderKlineHead() {
  const body = state.candles;
  if (!body.length) return;
  const last = body[body.length - 1];
  const first = body[0];
  const chg = first.o ? (last.c / first.o - 1) * 100 : null;
  const b = baseOf(state.symbol);
  document.getElementById('klineName').innerHTML = ciHtml(state.symbol, 'lg')
    + '<span class="coin" data-kline="' + escAttr(state.symbol) + '">' + escAttr(b) + '</span>'
    + '<span class="name"> / USDT</span>';
  document.getElementById('klinePrice').textContent = fmtPrice(last.c);
  const el = document.getElementById('klineChange');
  el.className = 'sub ' + signClass(chg);
  el.textContent = fmtPct(chg) + ' · 本图区间（' + body.length + ' 根 ' + state.interval + '）';
  document.getElementById('klineRange').textContent = fmtFullTime(first.t) + ' ~ ' + fmtFullTime(last.t);
}

async function loadKlines() {
  try {
    const d = await fetchJSON('/api/klines?symbol=' + state.symbol + '&interval=' + state.interval + '&limit=240');
    if (!d.ok || !d.candles.length) throw new Error(d.error || 'no candles');
    state.candles = d.candles;
    state.hover = null;
    renderKlineHead();
    drawKline();
    document.getElementById('klineNote').textContent = '快照 ' + new Date(d.updated).toLocaleTimeString('zh-CN', { hour12: false }) + ' · 自动补最新一根';
  } catch (e) {
    document.getElementById('klineNote').textContent = 'K 线不可达：' + e.message;
  }
}

// ============================================================
// Hyperliquid 鲸鱼监控（板块对齐 coinglass.com/zh/hyperliquid）
// ============================================================
let hlData = null, hlChart = null;

function shortAddr(a) { return a ? a.slice(0, 6) + '..' + a.slice(-2) : '—'; }
// 地址外链：显示缩写，完整地址放在 href 与 title 里
function traderUrl(addr) { return 'https://hyperbot.network/trader/' + addr; }
function addrLink(addr) {
  if (!addr) return '—';
  return '<a class="addr" href="' + traderUrl(addr) + '" target="_blank" rel="noopener noreferrer" title="' + addr + '">'
    + shortAddr(addr) + '</a>';
}
function fmtUsdSigned(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v < 0 ? '-' : '+') + fmtCap(Math.abs(v));
}
function pctOf(a, b) { return b ? (a / b * 100).toFixed(2) + '%' : '—'; }
// state 1=开仓 2=平仓，配合 size 正负得到页面上的四种动作
function actionLabel(state, long) {
  if (state === 1) return long ? '买入开多' : '卖出开空';
  if (state === 2) return long ? '卖出平多' : '买入平空';
  return '—';
}
function timeShort(t) {
  const d = new Date(t);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function switchView(name) {
  state.view = name;
  ['market', 'hyperliquid', 'strategy'].forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = (v !== name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#mainTabs .mtab'), (b) => {
    b.className = 'mtab' + (b.getAttribute('data-view') === name ? ' on' : '');
  });
  if (name === 'hyperliquid') {
    if (hlData) renderHyperliquid(hlData);
    else loadHyperliquid();
  } else if (name === 'strategy') {
    onStrategyView();
  } else if (state.candles.length) {
    drawKline(); // canvas 在隐藏时尺寸为 0，切回来必须重画
  }
}

function renderHlOverview(d) {
  const o = d.overview || {};
  const set = (id, val, sub, cls) => {
    const el = document.getElementById(id);
    el.textContent = val;
    el.className = 'stat-value' + (cls || '');
    document.getElementById(id + 'Sub').innerHTML = sub;
  };
  const split = (l, s) => '<span class="up">多 ' + l + '</span> · <span class="down">空 ' + s + '</span>';
  set('hlPos', fmtCap(o.pos), split(fmtCap(o.posL) + ' (' + pctOf(o.posL, o.pos) + ')', fmtCap(o.posS) + ' (' + pctOf(o.posS, o.pos) + ')'));
  set('hlMargin', fmtCap(o.margin), split(fmtCap(o.marL) + ' (' + pctOf(o.marL, o.margin) + ')', fmtCap(o.marS) + ' (' + pctOf(o.marS, o.margin) + ')'));
  set('hlPnl', fmtUsdSigned(o.pnl), split(fmtUsdSigned(o.pnlL), fmtUsdSigned(o.pnlS)), ' ' + signClass(o.pnl));
  set('hlFee', fmtUsdSigned(o.fee), split(fmtUsdSigned(o.feeL), fmtUsdSigned(o.feeS)), ' ' + signClass(o.fee));
  document.getElementById('hlOvSub').textContent = o.count + ' 个持仓地址 · 数据 CoinGlass · '
    + new Date(d.updated).toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新';
  const badge = document.getElementById('hlBadge');
  badge.textContent = (d.errors && d.errors.length) ? '部分数据异常' : 'CoinGlass';
}

function renderHlPositions(d) {
  let html = '<table class="tbl"><thead><tr><th>#</th><th>用户</th><th>资产</th><th>方向</th><th>仓位</th>'
    + '<th>未实现盈亏 (%)</th><th>开仓价格</th><th>爆仓价格</th><th>保证金</th><th>资金费</th><th>价格</th><th>开仓时间</th></tr></thead><tbody>';
  (d.positions || []).forEach((p, i) => {
    html += '<tr><td class="rk">' + (i + 1) + '</td>'
      + '<td class="mono">' + addrLink(p.user) + '</td>'
      + '<td>' + coinCell(p.coin, p.coin, 'sm', false) + '</td>'
      + '<td>' + (p.long ? '<span class="up">多</span>' : '<span class="down">空</span>')
      + ' <span class="lev">' + p.lev + 'x</span></td>'
      + '<td>' + fmtCap(p.posUsd) + '</td>'
      + '<td class="' + signClass(p.pnl) + '">' + fmtUsdSigned(p.pnl)
      + ' <span class="lev">(' + (p.roe === null ? '—' : (p.roe > 0 ? '+' : '') + p.roe.toFixed(2) + '%') + ')</span></td>'
      + '<td>' + fmtPrice(p.entry) + '</td>'
      + '<td>' + (p.liq ? fmtPrice(p.liq) : '—') + '</td>'
      + '<td>' + fmtCap(p.margin) + '</td>'
      + '<td class="' + signClass(p.fee) + '">' + fmtUsdSigned(p.fee) + '</td>'
      + '<td>' + fmtPrice(p.price) + '</td>'
      + '<td class="sub-cell">' + fmtFullTime(p.openTime) + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('hlPositions').innerHTML = html;
}

const HL_ACTIONS = 8; // 与右侧卡片等高，只展示最近 8 笔

function renderHlActions(d) {
  let html = '<table class="tbl"><thead><tr><th>地址</th><th>资产</th><th>操作</th><th>仓位</th><th>价格</th><th>时间</th></tr></thead><tbody>';
  (d.actions || []).slice(0, HL_ACTIONS).forEach((a) => {
    const cls = a.state === 1 ? (a.long ? 'up' : 'down') : 'muted';
    html += '<tr><td class="mono">' + addrLink(a.user) + '</td>'
      + '<td>' + coinCell(a.coin, a.coin, 'sm', false) + '</td>'
      + '<td class="' + cls + '">' + actionLabel(a.state, a.long) + '</td>'
      + '<td>' + fmtCap(a.posUsd) + '</td>'
      + '<td>' + fmtPrice(a.price) + '</td>'
      + '<td class="sub-cell">' + timeShort(a.t) + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('hlActions').innerHTML = html;
}

function renderHlRatios(d) {
  const rows = d.ratios || [];
  let html = '';
  rows.forEach((r) => {
    html += '<div class="rrow">' + coinCell(r.coin, r.coin, 'sm', false)
      + '<span class="rbar"><i class="rl" style="width:' + r.longPct.toFixed(1) + '%"></i>'
      + '<i class="rs" style="width:' + (100 - r.longPct).toFixed(1) + '%"></i></span>'
      + '<span class="rp up">' + r.longPct.toFixed(2) + '%</span>'
      + '<span class="rp down">' + r.shortPct.toFixed(2) + '%</span></div>';
  });
  document.getElementById('hlRatios').innerHTML = html || '<div class="sub">暂无数据</div>';
}

function renderHlUsers(d) {
  const u = d.users;
  if (u) {
    document.getElementById('hlULong').textContent = u.long.toLocaleString('en-US');
    document.getElementById('hlUShort').textContent = u.short.toLocaleString('en-US');
    document.getElementById('hlURatio').textContent = u.ratio ? u.ratio.toFixed(4) : '—';
  }
  const s = d.userSeries || [];
  if (!s.length) return;
  const labels = s.map((p) => {
    const x = new Date(p.t);
    return (x.getMonth() + 1) + '/' + x.getDate() + ' ' + pad2(x.getHours()) + ':00';
  });
  const longs = s.map((p) => p.l);
  const shorts = s.map((p) => p.s);
  if (hlChart) {
    hlChart.data.labels = labels;
    hlChart.data.datasets[0].data = longs;
    hlChart.data.datasets[1].data = shorts;
    hlChart.update('none');
    return;
  }
  hlChart = new Chart(document.getElementById('hlUsersChart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: '多单人数', data: longs, borderColor: C.up, backgroundColor: withAlpha(C.up, 0.12), fill: true, borderWidth: 2, pointRadius: 0, tension: 0.25 },
        { label: '空单人数', data: shorts, borderColor: C.down, backgroundColor: withAlpha(C.down, 0.12), fill: true, borderWidth: 2, pointRadius: 0, tension: 0.25 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { callbacks: { label: (c) => c.dataset.label + ' ' + Number(c.parsed.y).toLocaleString('en-US') } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 5 } },
        y: { grid: { color: C.border }, ticks: { maxTicksLimit: 5 } },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function renderHyperliquid(d) {
  renderHlOverview(d); renderHlPositions(d); renderHlActions(d); renderHlRatios(d); renderHlUsers(d);
}

async function loadHyperliquid() {
  try {
    const d = await fetchJSON('/api/hyperliquid');
    if (!d.ok) throw new Error(d.error || 'no data');
    hlData = d;
    renderHyperliquid(d);
  } catch (e) {
    document.getElementById('hlOvSub').textContent = 'Hyperliquid 数据不可达：' + e.message;
  }
}

// ============================================================
// 币种 K 线弹窗（大盘行情里点币种弹出）
// ============================================================
const MODAL_TFS = ['5m', '15m', '30m', '1h', '4h', '12h', '1d'];
const modalState = { sym: null, tf: '15m', candles: [], hover: null };

function pairOf(sym) {
  if (!sym) return null;
  const s = String(sym).toUpperCase();
  return /USDT$/.test(s) ? s : s + 'USDT';
}

function buildModalTf() {
  document.getElementById('modalTf').innerHTML = MODAL_TFS.map((t) =>
    '<button type="button" data-mtf="' + t + '"' + (t === modalState.tf ? ' class="on"' : '') + '>' + t + '</button>').join('');
}

function openKlineModal(sym) {
  const pair = pairOf(sym);
  if (!pair) return;
  modalState.sym = pair;
  modalState.candles = [];
  modalState.hover = null;
  document.getElementById('modalSymbol').innerHTML = ciHtml(pair, 'lg')
    + '<span>' + escAttr(baseOf(pair)) + '</span><span class="name"> / USDT</span>';
  document.getElementById('modalPrice').textContent = '加载中…';
  document.getElementById('modalOhlc').innerHTML = '';
  document.getElementById('modalNote').textContent = '加载中…';
  document.getElementById('klineModal').hidden = false;
  document.body.classList.add('modal-open');
  buildModalTf();
  loadModalKlines();
}

function closeKlineModal() {
  document.getElementById('klineModal').hidden = true;
  document.body.classList.remove('modal-open');
}

async function loadModalKlines() {
  if (!modalState.sym) return;
  const sym = modalState.sym;
  const tf = modalState.tf;
  try {
    const d = await fetchJSON('/api/klines?symbol=' + sym + '&interval=' + tf + '&limit=240');
    if (!d.ok || !d.candles.length) throw new Error(d.error || 'no candles');
    if (sym !== modalState.sym || tf !== modalState.tf) return; // 期间又切了币或周期
    modalState.candles = d.candles;
    modalState.hover = null;
    const first = d.candles[0], last = d.candles[d.candles.length - 1];
    const chg = first.o ? (last.c / first.o - 1) * 100 : null;
    document.getElementById('modalPrice').innerHTML =
      fmtPrice(last.c) + ' <span class="' + signClass(chg) + '">' + fmtPct(chg) + '</span>';
    document.getElementById('modalNote').textContent = 'Binance 现货 · ' + d.candles.length + ' 根 ' + tf
      + ' · ' + fmtFullTime(first.t) + ' ~ ' + fmtFullTime(last.t);
    drawModal();
  } catch (e) {
    document.getElementById('modalPrice').textContent = '不可达';
    document.getElementById('modalNote').textContent = sym + ' 取不到 K 线：' + e.message;
    drawModal();
  }
}

function drawModal() {
  drawCandles(document.getElementById('modalCanvas'), modalState.candles, modalState.tf, modalState.hover, 'modalOhlc');
}

function initKlineModal() {
  const box = document.getElementById('klineModal');
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.id === 'modalClose') closeKlineModal();
  });
  document.getElementById('modalTf').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mtf]');
    if (!b) return;
    modalState.tf = b.getAttribute('data-mtf');
    Array.prototype.forEach.call(document.querySelectorAll('#modalTf button'), (o) => { o.className = (o === b) ? 'on' : ''; });
    loadModalKlines();
  });
  const cv = document.getElementById('modalCanvas');
  cv.style.cursor = 'crosshair';
  cv.addEventListener('mousemove', (e) => {
    modalState.hover = candleIndexAt(cv, e.clientX, modalState.candles.length);
    drawModal();
  });
  cv.addEventListener('mouseleave', () => { modalState.hover = null; drawModal(); });
  window.addEventListener('resize', () => {
    if (!document.getElementById('klineModal').hidden) drawModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('klineModal').hidden) closeKlineModal();
  });
  // 任意表格里带 data-kline 的币种，点击弹窗
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-kline]');
    if (el) openKlineModal(el.getAttribute('data-kline'));
  });
}

// ============================================================
// 策略模拟盘（浏览器内回测，无后端）
// ============================================================
const STRAT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'LINKUSDT', 'AVAXUSDT', 'SUIUSDT', 'ARBUSDT', 'OPUSDT', 'LTCUSDT', 'BCHUSDT', 'DOTUSDT', 'TRXUSDT',
  'NEARUSDT', 'APTUSDT', 'PEPEUSDT', 'UNIUSDT', 'HBARUSDT', 'TONUSDT', 'TAOUSDT', 'WLDUSDT'];
const STRAT_PRESETS = {
  // ---------- 趋势跟随 ----------
  ma: [
    '// 双均线交叉：快线上穿慢线做多，下穿平仓',
    'const fast = MA(5);',
    'const slow = MA(20);',
    'if (fast.v === null || slow.v === null) return 0;',
    'if (crossover(fast, slow)) return 1;',
    'if (crossunder(fast, slow)) return 0;',
    'return POS;',
  ].join('\n'),
  ma3: [
    '// 三均线多头排列：MA5>MA10>MA20 且价在 MA5 之上做多，排列破坏离场',
    '// 适合单边上涨，震荡市会被反复打脸',
    'const a = MA(5), b = MA(10), c = MA(20);',
    'if (a.v === null || b.v === null || c.v === null) return 0;',
    'if (a.v > b.v && b.v > c.v && price.v > a.v) return 1;',
    'if (a.v < b.v) return 0;',
    'return POS;',
  ].join('\n'),
  macd: [
    '// MACD 金叉做多，死叉平仓',
    'const m = MACD(12, 26, 9);',
    'if (m.dif.v === null || m.dea.v === null) return 0;',
    'if (crossover(m.dif, m.dea)) return 1;',
    'if (crossunder(m.dif, m.dea)) return 0;',
    'return POS;',
  ].join('\n'),
  donchian: [
    '// 唐奇安通道（海龟式）：突破前 20 根新高做多，跌破前 10 根新低离场',
    '// 典型趋势突破策略，横盘时假信号多',
    'const hi = highest(20), lo = lowest(10);',
    'if (hi.p === null || lo.p === null) return 0;',
    'if (price.v > hi.p) return 1;',
    'if (price.v < lo.p) return 0;',
    'return POS;',
  ].join('\n'),

  // ---------- 震荡回归 ----------
  rsi: [
    '// RSI 超买超卖：跌破 30 做多，升破 70 平仓',
    '// 适合宽幅震荡，单边行情里会过早离场',
    'const r = RSI(14);',
    'if (r.v === null) return 0;',
    'if (r.v < 30) return 1;',
    'if (r.v > 70) return 0;',
    'return POS;',
  ].join('\n'),
  bollrev: [
    '// 布林带均值回归：跌破下轨做多（超跌反弹），回到中轨平仓',
    '// 纯震荡策略，破位下跌时要靠杠杆小 + 止损保护',
    'const b = BOLL(20, 2);',
    'if (b.mid.v === null) return 0;',
    'if (price.v < b.low.v) return 1;',
    'if (price.v >= b.mid.v) return 0;',
    'return POS;',
  ].join('\n'),
  grid: [
    '// 区间网格：在近 48 根的区间内，价格处于下沿 20% 做多，上沿 20% 平仓',
    '// 适合箱体震荡，区间被打破时会踩反',
    'const hi = highest(48), lo = lowest(48);',
    'if (hi.v === null || lo.v === null || hi.v <= lo.v) return 0;',
    'const pct = (price.v - lo.v) / (hi.v - lo.v);',
    'if (pct < 0.2) return 1;',
    'if (pct > 0.8) return 0;',
    'return POS;',
  ].join('\n'),

  // ---------- 突破 / 波动 ----------
  boll: [
    '// 布林带突破追多：站上上轨追（趋势延续），跌回中轨离场',
    '// 适合放量突破行情，震荡市会频繁止损',
    'const b = BOLL(20, 2);',
    'if (b.mid.v === null) return 0;',
    'if (price.v > b.up.v) return 1;',
    'if (price.v < b.mid.v) return 0;',
    'return POS;',
  ].join('\n'),
  atrbreak: [
    '// 动量突破 + ATR 止损：创 24 根新高做多，跌破「入场价 − 2×ATR」离场',
    '// ENTRY 是当前持仓的开仓价，BARS 是已持仓根数',
    'const hi = highest(24), a = ATR(14);',
    'if (hi.p === null || a.v === null) return 0;',
    'if (POS === 0 && price.v > hi.p) return 1;',
    'if (POS === 1 && ENTRY > 0 && price.v < ENTRY - a.v * 2) return 0;',
    'return POS;',
  ].join('\n'),
  volfilter: [
    '// 波动率过滤趋势：ATR(7) > ATR(28)（波动放大）且 MA10 > MA30 才做多',
    '// 用波动放大过滤掉无聊的假突破',
    'const a7 = ATR(7), a28 = ATR(28);',
    'const f = MA(10), s = MA(30);',
    'if (a7.v === null || a28.v === null || f.v === null || s.v === null) return 0;',
    'if (a7.v > a28.v && f.v > s.v) return 1;',
    'if (f.v < s.v) return 0;',
    'return POS;',
  ].join('\n'),

  // ---------- 做空 ----------
  short: [
    '// 空头趋势（需勾选「允许做空」）：价在 MA20 下方且 MA5<MA20 做空，站上 MA20 平仓',
    'const f = MA(5), s = MA(20);',
    'if (f.v === null || s.v === null) return 0;',
    'if (price.v < s.v && f.v < s.v) return -1;',
    'if (price.v > s.v) return 0;',
    'return POS;',
  ].join('\n'),
};

const stratState = { symbol: 'BTCUSDT', tf: '1h', candles: [], marks: [], trades: [], eq: [], hover: null, ready: false, inited: false };
const SIND = { ma: true, ema: false, boll: false, vol: true, sub: 'none' };
let stratEquityChart = null;

function stratMsg(t) {
  const el = document.getElementById('stratMsg');
  if (el) el.textContent = t;
}

// ---- 回测用指标序列 ----
function hhvSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) {
    let m = -Infinity;
    for (let k = i - n + 1; k <= i; k++) if (arr[k] > m) m = arr[k];
    out[i] = m;
  }
  return out;
}
function llvSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) {
    let m = Infinity;
    for (let k = i - n + 1; k <= i; k++) if (arr[k] < m) m = arr[k];
    out[i] = m;
  }
  return out;
}
function atrSeries(candles, n) {
  const out = new Array(candles.length).fill(null);
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const pc = i > 0 ? candles[i - 1].c : k.c;
    trs.push(Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < n) { sum += trs[i]; if (i === n - 1) out[i] = sum / n; }
    else out[i] = (out[i - 1] * (n - 1) + trs[i]) / n;
  }
  return out;
}

// ---- 回测主流程 ----
function runStrategy() {
  const candles = stratState.candles;
  if (!candles || candles.length < 60) { stratMsg('K 线还没加载好，稍等一下再跑'); return; }
  const capital = Math.max(100, +document.getElementById('stratCapital').value || 10000);
  const lev = Math.max(1, Math.min(100, +document.getElementById('stratLev').value || 1));
  const fee = Math.max(0, (+document.getElementById('stratFee').value || 0) / 1000);
  const posPct = Math.max(0.01, Math.min(1, (+((document.getElementById('stratPos') || {}).value || 100)) / 100));
  const allowShort = document.getElementById('stratShort').checked;
  const code = document.getElementById('stratCode').value;

  const closes = candles.map((k) => k.c);
  const vols = candles.map((k) => k.v);
  const st = { i: 0 };
  const cache1 = {}, cacheB = {}, cacheM = {};
  const ser = (kind, n) => {
    const key = kind + n;
    if (!cache1[key]) {
      cache1[key] = kind === 'ma' ? sma(closes, n)
        : kind === 'ema' ? emaSeries(closes, n)
        : kind === 'rsi' ? rsiSeries(closes, n)
        : kind === 'atr' ? atrSeries(candles, n)
        : kind === 'hhv' ? hhvSeries(closes, n)
        : llvSeries(closes, n);
    }
    return cache1[key];
  };
  const S = (arr) => ({
    get v() { return arr[st.i]; },
    get p() { return arr[st.i - 1]; },
    at: (o) => arr[st.i - (o || 0)],
  });
  const MA = (n) => S(ser('ma', n));
  const EMA = (n) => S(ser('ema', n));
  const RSI = (n) => S(ser('rsi', n));
  const ATR = (n) => S(ser('atr', n));
  const highest = (n) => S(ser('hhv', n));
  const lowest = (n) => S(ser('llv', n));
  const BOLL = (n, k) => {
    const key = n + '_' + k;
    if (!cacheB[key]) cacheB[key] = bollSeries(closes, n, k);
    const b = cacheB[key];
    return { mid: S(b.mid), up: S(b.up), low: S(b.low) };
  };
  const MACD = (f, s, g) => {
    const key = f + '_' + s + '_' + g;
    if (!cacheM[key]) cacheM[key] = macdSeries(closes, f, s, g);
    const m = cacheM[key];
    return { dif: S(m.dif), dea: S(m.dea), hist: S(m.hist) };
  };
  const crossover = (x, y) => x.p !== null && y.p !== null && x.v !== null && y.v !== null && x.p <= y.p && x.v > y.v;
  const crossunder = (x, y) => x.p !== null && y.p !== null && x.v !== null && y.v !== null && x.p >= y.p && x.v < y.v;
  const price = S(closes);
  const volume = S(vols);

  let fn;
  try {
    fn = new Function('MA', 'EMA', 'RSI', 'ATR', 'MACD', 'BOLL', 'crossover', 'crossunder',
      'highest', 'lowest', 'price', 'volume', 'POS', 'i', 'ENTRY', 'BARS', code);
  } catch (e) {
    stratMsg('策略语法错误：' + e.message);
    return;
  }

  const trades = [], marks = [], eq = [];
  let pos = 0, qty = 0, entry = 0, entryIdx = 0, entryFee = 0, liqPx = null;
  let cash = capital, peak = capital, maxDD = 0, liquidated = false, errMsg = null;
  const warm = 25;

  for (let i = warm; i < candles.length; i++) {
    st.i = i;
    let target;
    try {
      target = fn(MA, EMA, RSI, ATR, MACD, BOLL, crossover, crossunder, highest, lowest, price, volume, pos, i, pos !== 0 ? entry : 0, pos !== 0 ? (i - entryIdx) : 0);
    } catch (e) { errMsg = '第 ' + i + ' 根执行出错：' + e.message; break; }
    target = Math.round(Number(target) || 0);
    if (target > 1) target = 1;
    if (target < -1) target = -1;
    if (!allowShort && target < 0) target = 0;

    const bar = candles[i];
    const px = bar.c;

    // 爆仓（用本根的最低价/最高价判断）
    if (pos !== 0 && liqPx !== null && ((pos > 0 && bar.l <= liqPx) || (pos < 0 && bar.h >= liqPx))) {
      const gross = (liqPx - entry) * qty * (pos > 0 ? 1 : -1);
      const feeOut = qty * liqPx * fee;
      cash += gross - feeOut;
      if (cash < 0) cash = 0;
      trades.push({ openT: candles[entryIdx].t, closeT: bar.t, side: pos, entry: entry, exit: liqPx, qty: qty, pnl: gross - feeOut - entryFee, reason: '爆仓' });
      marks.push({ i: i, kind: 'liq' });
      eq.push({ t: bar.t, e: cash });
      pos = 0; qty = 0; liqPx = null;
      if (cash < capital * 0.01) { liquidated = true; break; } // 权益基本归零才算出局
      continue; // 部分仓位下爆仓只亏该笔保证金，继续回测
    }

    if (target !== pos) {
      if (pos !== 0) {
        const gross = (px - entry) * qty * (pos > 0 ? 1 : -1);
        const feeOut = qty * px * fee;
        cash += gross - feeOut;
        trades.push({ openT: candles[entryIdx].t, closeT: bar.t, side: pos, entry: entry, exit: px, qty: qty, pnl: gross - feeOut - entryFee, reason: '信号' });
        marks.push({ i: i, kind: pos > 0 ? 'sell' : 'cover' });
        pos = 0; qty = 0; liqPx = null;
      }
      if (target !== 0 && cash > 1) {
        pos = target;
        entry = px; entryIdx = i;
        const notional = cash * lev * posPct;
        qty = notional / px;
        entryFee = notional * fee;
        cash -= entryFee;
        liqPx = pos > 0 ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
        marks.push({ i: i, kind: pos > 0 ? 'buy' : 'short' });
      }
    }

    const unreal = pos !== 0 ? (px - entry) * qty * (pos > 0 ? 1 : -1) : 0;
    const cur = cash + unreal;
    if (cur > peak) peak = cur;
    if (peak > 0) { const dd = (peak - cur) / peak; if (dd > maxDD) maxDD = dd; }
    eq.push({ t: bar.t, e: cur });
  }

  // 末尾强制平仓
  if (pos !== 0) {
    const lastBar = candles[candles.length - 1];
    const gross = (lastBar.c - entry) * qty * (pos > 0 ? 1 : -1);
    const feeOut = qty * lastBar.c * fee;
    cash += gross - feeOut;
    trades.push({ openT: candles[entryIdx].t, closeT: lastBar.t, side: pos, entry: entry, exit: lastBar.c, qty: qty, pnl: gross - feeOut - entryFee, reason: '收盘平仓' });
    marks.push({ i: candles.length - 1, kind: pos > 0 ? 'sell' : 'cover' });
    pos = 0;
  }

  const finalEquity = liquidated ? cash : cash;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const avgWin = wins.length ? wins.reduce((x, t) => x + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((x, t) => x + t.pnl, 0) / losses.length) : 0;
  const bh = closes[warm] ? (closes[closes.length - 1] / closes[warm] - 1) * 100 : null;

  const res = {
    capital, lev, fee, posPct, allowShort, finalEquity, liquidated, errMsg,
    returnPct: finalEquity / capital * 100 - 100,
    winRate: trades.length ? wins.length / trades.length * 100 : null,
    pf: avgLoss > 0 ? avgWin / avgLoss : null,
    maxDD: maxDD * 100,
    trades: trades.length, buyHold: bh, avgWin, avgLoss,
  };
  stratState.marks = marks;
  stratState.trades = trades;
  stratState.eq = eq;
  stratState.result = res;
  renderStratStats(res);
  renderStratTrades(trades);
  renderStratEquityChart(eq);
  drawStrategyChart();
  stratMsg('回测完成：' + candles.length + ' 根 ' + stratState.tf + ' · ' + trades.length + ' 笔交易'
    + (liquidated ? ' · 已爆仓' : '') + (res.errMsg ? ' · ' + res.errMsg : ''));
}

// ---- 渲染 ----
function renderStratStats(r) {
  const money = (v) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  document.getElementById('ssRet').textContent = (r.returnPct >= 0 ? '+' : '') + r.returnPct.toFixed(2) + '%';
  document.getElementById('ssRet').className = 'stat-value ' + signClass(r.returnPct);
  document.getElementById('ssRetSub').textContent = '买入持有 ' + (r.buyHold === null ? '—' : (r.buyHold >= 0 ? '+' : '') + r.buyHold.toFixed(2) + '%');
  document.getElementById('ssEquity').textContent = money(r.finalEquity);
  document.getElementById('ssEquitySub').textContent = '初始 ' + money(r.capital) + ' · ' + r.lev + 'x 杠杆 · ' + Math.round((r.posPct === undefined ? 1 : r.posPct) * 100) + '% 仓位';
  document.getElementById('ssTrades').textContent = r.trades;
  document.getElementById('ssTradesSub').textContent = r.liquidated ? '已爆仓' : (r.allowShort ? '可做空' : '仅做多');
  document.getElementById('ssWin').textContent = r.winRate === null ? '—' : r.winRate.toFixed(1) + '%';
  document.getElementById('ssWinSub').textContent = '均盈 ' + money(r.avgWin) + ' / 均亏 ' + money(-r.avgLoss);
  document.getElementById('ssDd').textContent = r.maxDD.toFixed(2) + '%';
  document.getElementById('ssDdSub').textContent = '峰值回撤';
  document.getElementById('ssPf').textContent = r.pf === null ? '—' : r.pf.toFixed(2);
  document.getElementById('ssPfSub').textContent = '平均盈利 ÷ 平均亏损';
  const badge = document.getElementById('stratBadge');
  badge.textContent = r.liquidated ? '已爆仓' : (r.returnPct >= 0 ? '盈利' : '亏损');
}

function renderStratTrades(trades) {
  if (!trades.length) {
    document.getElementById('stratTrades').innerHTML = '<div class="sub" style="padding:14px">没有产生交易</div>';
    document.getElementById('stratTradeSub').textContent = '0 笔';
    return;
  }
  let html = '<table class="tbl"><thead><tr><th>#</th><th>方向</th><th>开仓时间</th><th>开仓价</th>'
    + '<th>平仓时间</th><th>平仓价</th><th>盈亏</th><th>原因</th></tr></thead><tbody>';
  trades.forEach((t, i) => {
    html += '<tr><td class="rk">' + (i + 1) + '</td>'
      + '<td>' + (t.side > 0 ? '<span class="up">多</span>' : '<span class="down">空</span>') + '</td>'
      + '<td class="sub-cell">' + fmtFullTime(t.openT) + '</td>'
      + '<td>' + fmtPrice(t.entry) + '</td>'
      + '<td class="sub-cell">' + fmtFullTime(t.closeT) + '</td>'
      + '<td>' + fmtPrice(t.exit) + '</td>'
      + '<td class="' + signClass(t.pnl) + '">' + (t.pnl >= 0 ? '+' : '-') + '$' + Math.abs(t.pnl).toFixed(2) + '</td>'
      + '<td class="sub-cell">' + t.reason + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('stratTrades').innerHTML = html;
  document.getElementById('stratTradeSub').textContent = trades.length + ' 笔';
}

function renderStratEquityChart(eq) {
  if (!eq.length) return;
  const labels = eq.map((p) => {
    const d = new Date(p.t);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  });
  const data = eq.map((p) => +p.e.toFixed(2));
  if (stratEquityChart) {
    stratEquityChart.data.labels = labels;
    stratEquityChart.data.datasets[0].data = data;
    stratEquityChart.update('none');
    return;
  }
  stratEquityChart = new Chart(document.getElementById('stratEquityChart'), {
    type: 'line',
    data: { labels: labels, datasets: [{ data: data, borderColor: C.primary, backgroundColor: withAlpha(C.primary, 0.14), fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => '$' + Number(c.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 2 }) } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 5 } }, y: { grid: { color: C.border }, ticks: { maxTicksLimit: 5 } } },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function drawStrategyChart() {
  drawCandles(document.getElementById('stratCanvas'), stratState.candles, stratState.tf, stratState.hover, 'stratOhlc', stratState.marks, SIND);
  if (!stratState.candles.length) return;
  const a = stratState.candles[0], z = stratState.candles[stratState.candles.length - 1];
  document.getElementById('stratRange').textContent = fmtFullTime(a.t) + ' ~ ' + fmtFullTime(z.t) + ' · ' + stratState.candles.length + ' 根';
  document.getElementById('stratChartSub').textContent = stratState.symbol.replace(/USDT$/, '') + ' / USDT · '
    + stratState.tf + ' · 共 ' + stratState.marks.length + ' 个买卖点';
}

function syncStratInd() {
  Array.prototype.forEach.call(document.querySelectorAll('#stratIndBar button'), (b) => {
    const k = b.getAttribute('data-sind');
    const on = (k === 'macd' || k === 'rsi') ? (SIND.sub === k) : !!SIND[k];
    b.className = on ? 'on' : '';
  });
}

async function loadStratKlines() {
  const fromEl = document.getElementById('stratFrom');
  const toEl = document.getElementById('stratTo');
  const from = fromEl ? dateInputToTs(fromEl.value, false) : null;
  const to = toEl ? dateInputToTs(toEl.value, true) : null;
  stratMsg('加载 K 线…');
  try {
    let url = '/api/klines?symbol=' + stratState.symbol + '&interval=' + stratState.tf;
    url += (from || to) ? ((from ? '&startTime=' + from : '') + (to ? '&endTime=' + to : '')) : '&limit=500';
    const d = await fetchJSON(url);
    if (!d.ok || !d.candles.length) throw new Error(d.error || 'no candles');
    stratState.candles = d.candles;
    stratState.marks = []; stratState.trades = []; stratState.eq = []; stratState.hover = null;
    stratState.result = null;
    drawStrategyChart();
    const barsEl = document.getElementById('stratBars');
    if (barsEl) barsEl.textContent = d.candles.length + ' 根' + (d.truncated ? '（已达上限，区间被截断）' : '');
    stratMsg('K 线就绪（' + d.candles.length + ' 根），点「运行回测」开始');
  } catch (e) {
    stratMsg('K 线不可达：' + e.message);
  }
}


function toDateInput(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function dateInputToTs(v, endOfDay) {
  if (!v) return null;
  const p = String(v).split('-');
  if (p.length !== 3) return null;
  const d = new Date(+p[0], +p[1] - 1, +p[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  const t = d.getTime();
  return isNaN(t) ? null : t;
}
function syncRangeButtons(days) {
  Array.prototype.forEach.call(document.querySelectorAll('#stratQuick button'), (b) => {
    b.className = (Number(b.getAttribute('data-days')) === days) ? 'on' : '';
  });
}
function applyRangeDays(days) {
  const to = Date.now();
  const from = to - days * 86400000;
  document.getElementById('stratFrom').value = toDateInput(from);
  document.getElementById('stratTo').value = toDateInput(to);
  syncRangeButtons(days);
  loadStratKlines();
}

function onStrategyView() {
  if (!stratState.inited) {
    stratState.inited = true;
    const symSel = document.getElementById('stratSymbol');
    symSel.innerHTML = STRAT_SYMBOLS.map((s) => '<option value="' + s + '">' + s.replace(/USDT$/, '') + ' / USDT</option>').join('');
    symSel.value = stratState.symbol;
    symSel.addEventListener('change', () => { stratState.symbol = symSel.value; loadStratKlines(); });
    const tfSeg = document.getElementById('stratTf');
    tfSeg.innerHTML = ['15m', '1h', '4h', '12h', '1d'].map((t) =>
      '<button type="button" data-stf="' + t + '"' + (t === stratState.tf ? ' class="on"' : '') + '>' + t + '</button>').join('');
    tfSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-stf]');
      if (!b) return;
      stratState.tf = b.getAttribute('data-stf');
      Array.prototype.forEach.call(tfSeg.querySelectorAll('button'), (o) => { o.className = (o === b) ? 'on' : ''; });
      loadStratKlines();
    });
    document.getElementById('stratQuick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-days]');
      if (b) applyRangeDays(Number(b.getAttribute('data-days')));
    });
    document.getElementById('stratFrom').addEventListener('change', () => { syncRangeButtons(-1); loadStratKlines(); });
    document.getElementById('stratTo').addEventListener('change', () => { syncRangeButtons(-1); loadStratKlines(); });
    const _now = Date.now();
    document.getElementById('stratFrom').value = toDateInput(_now - 30 * 86400000);
    document.getElementById('stratTo').value = toDateInput(_now);
    syncRangeButtons(30);
    document.getElementById('stratCode').value = STRAT_PRESETS.ma;
    document.getElementById('stratPreset').addEventListener('change', (e) => {
      document.getElementById('stratCode').value = STRAT_PRESETS[e.target.value] || '';
    });
    document.getElementById('stratRun').addEventListener('click', runStrategy);
    document.getElementById('stratIndBar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sind]');
      if (!b) return;
      const k = b.getAttribute('data-sind');
      if (k === 'macd' || k === 'rsi') SIND.sub = (SIND.sub === k) ? 'none' : k;
      else SIND[k] = !SIND[k];
      syncStratInd();
      drawStrategyChart();
    });
    const cv = document.getElementById('stratCanvas');
    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', (e) => {
      stratState.hover = candleIndexAt(cv, e.clientX, stratState.candles.length);
      drawStrategyChart();
    });
    cv.addEventListener('mouseleave', () => { stratState.hover = null; drawStrategyChart(); });
    syncStratInd();
    loadStratKlines();
  } else {
    drawStrategyChart();
  }
}

// ============================================================
// 控件与初始化
// ============================================================
function ensureOption(sym, tag) {
  const sel = document.getElementById('symbolSelect');
  let found = false;
  Array.prototype.forEach.call(sel.options, (o) => { if (o.value === sym) found = true; });
  if (found) return false;
  const o = document.createElement('option');
  o.value = sym;
  o.textContent = sym.replace(/USDT$/, '') + ' / USDT' + (tag || '');
  sel.appendChild(o);
  return true;
}

// 扫描表点一行 -> 直接切到该币 K 线（即使它不在观察名单里）
function setKlineSymbol(sym) {
  ensureOption(sym, '（扫描）');
  const sel = document.getElementById('symbolSelect');
  sel.value = sym;
  state.symbol = sym; state.candles = []; state.hover = null;
  loadKlines();
}

function buildControls(health) {
  const sel = document.getElementById('symbolSelect');
  sel.innerHTML = health.symbols.map((s) => '<option value="' + s + '">' + s.replace(/USDT$/, '') + ' / USDT</option>').join('');
  sel.value = state.symbol;
  sel.addEventListener('change', () => { state.symbol = sel.value; state.candles = []; state.hover = null; loadKlines(); });

  const seg = document.getElementById('tfTabs');
  seg.innerHTML = health.intervals.map((iv) =>
    '<button type="button" data-iv="' + iv + '"' + (iv === state.interval ? ' class="on"' : '') + '>' + iv + '</button>').join('');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-iv]');
    if (!b) return;
    state.interval = b.getAttribute('data-iv');
    state.candles = []; state.hover = null;
    Array.prototype.forEach.call(seg.querySelectorAll('button'), (o) => { o.className = (o === b) ? 'on' : ''; });
    loadKlines();
  });

  const cv = document.getElementById('klineCanvas');
  cv.style.cursor = 'crosshair';
  cv.addEventListener('mousemove', (e) => {
    state.hover = candleIndexAt(cv, e.clientX, state.candles.length);
    drawKline();
  });
  cv.addEventListener('mouseleave', () => { state.hover = null; drawKline(); });
  window.addEventListener('resize', () => drawKline());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { state.hover = null; drawKline(); } });
}

let timers = [];
function setupAuto() {
  timers.forEach((t) => clearInterval(t));
  timers = [];
  const on = document.getElementById('autoToggle').checked;
  if (!on) return;
  timers.push(setInterval(loadMarket, 20000));
  timers.push(setInterval(loadMomentum, 15000));
  timers.push(setInterval(loadKlines, 6000));
  timers.push(setInterval(loadScan, 60000));
  timers.push(setInterval(() => { if (state.view === 'hyperliquid') loadHyperliquid(); }, 20000));
}

async function init() {
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = C.border;
  Chart.defaults.font.family = 'inherit';
  try {
    const health = await fetchJSON('/api/health');
    buildControls(health);
  } catch (e) {
    document.getElementById('klineNote').textContent = '后端未启动：请先运行 node server.js';
    return;
  }
  // 主题：恢复上次选择 + 绑定切换 + 跟随系统时响应系统变化
  syncThemeButtons();
  document.getElementById('themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (b) applyTheme(b.getAttribute('data-theme'));
  });
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentTheme() === 'auto') refreshThemeColors();
    });
  } catch (e) {}

  initIndicators();
  initKlineModal();
  // 顶部主标签切换
  document.getElementById('mainTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) switchView(b.getAttribute('data-view'));
  });
  // 支持 ?view=hyperliquid 直接打进 Hyperliquid 标签页
  try {
    const vq = new URLSearchParams(location.search).get('view');
    if (vq === 'hyperliquid' || vq === 'strategy') switchView(vq);
  } catch (e) {}

  loadMarket(); loadMomentum(); loadKlines(); loadScan();
  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (state.view === 'hyperliquid') loadHyperliquid();
    else { loadMarket(); loadMomentum(); loadKlines(); loadScan(); }
  });
  document.getElementById('autoToggle').addEventListener('change', setupAuto);
  setupAuto();
}
init();
