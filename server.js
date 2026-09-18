'use strict';
/*
 * crypto-market-dashboard —— 零依赖 Node 后端
 *   GET /api/market     大盘总览 + 主流币行情 + 恐慌贪婪指数
 *   GET /api/momentum   20 个主流币的多周期动量 / 波动率画像
 *   GET /api/klines     K 线（Binance Vision）
 *   GET /api/hyperliquid Hyperliquid 市场（官方 API）+ 大户持仓 / 金库 / 多空比（CoinGlass）
 * 运行：node server.js  ->  http://127.0.0.1:8787
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { cgFetch } = require('./lib/coinglass');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VISION = 'https://data-api.binance.vision/api/v3';

// 重点观察（热力图基线；扫描发现的异动币会自动并入）
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'LINKUSDT', 'AVAXUSDT', 'TRXUSDT', 'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'SUIUSDT', 'APTUSDT',
  'NEARUSDT', 'ARBUSDT', 'OPUSDT', 'UNIUSDT', 'HBARUSDT', 'PEPEUSDT'];
// 全市场扫描：剔除稳定币 / 封装资产 / 杠杆代币，并设 24h 成交额下限
const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDE', 'USDS', 'PYUSD', 'USD1',
  'USDF', 'RLUSD', 'USD0', 'USDT0', 'SUSD', 'SUSDE', 'GUSD', 'USDP', 'USDD', 'USDY', 'BFUSD', 'AEUR',
  'EUR', 'EURI', 'TRY', 'BRL', 'ARS', 'JPY', 'GBP', 'ZAR', 'UAH', 'RUB', 'PLN', 'RON', 'CZK', 'MXN',
  'COP', 'BIDR', 'IDRT', 'VAI', 'XUSD', 'USDX', 'DUSD', 'EURT', 'EURS']);
const WRAPPED = new Set(['WBTC', 'WBETH', 'WETH', 'WEETH', 'STETH', 'WSTETH', 'CBBTC', 'SOLVBTC', 'RETH',
  'BNSOL', 'CBETH', 'EZETH', 'RSETH', 'SFRXETH', 'TBTC', 'LBTC', 'CLBTC', 'JITOSOL', 'MSOL', 'JUPSOL']);
const MIN_QUOTE_VOLUME = Number(process.env.MIN_QUOTE_VOLUME || 300000);
const SCAN_TTL = 90000;
const SCAN_HORIZONS = ['5m', '15m', '30m', '1h', '4h'];
const INTERVALS = ['5m', '15m', '30m', '1h', '4h', '12h', '1d'];
const INTERVAL_MS = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '12h': 43200000, '1d': 86400000 };
const RANGE_MAX_BARS = 5000;
const HORIZONS = [['5m', 1], ['15m', 3], ['30m', 6], ['1h', 12], ['4h', 48], ['12h', 144], ['24h', 288]];
const BARS_PER_DAY = 288; // 5m K 线一天 288 根

// ---------- 缓存 ----------
const cache = new Map();
async function getCached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  if (cache.size > 300) { // 动量缓存 key 会随扫描结果变化，定期清理
    const now = Date.now();
    for (const entry of cache) { if (now - entry[1].at > 120000) cache.delete(entry[0]); }
  }
  return val;
}

async function fetchJSON(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'crypto-market-dashboard/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function stdev(a) {
  if (a.length < 2) return 0;
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
  return Math.sqrt(v / a.length);
}
function sumOf(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }

// ---------- K 线 ----------
async function visionKlines(symbol, interval, limit) {
  const url = VISION + '/klines?symbol=' + encodeURIComponent(symbol) +
    '&interval=' + encodeURIComponent(interval) + '&limit=' + limit;
  const raw = await fetchJSON(url);
  return (raw || []).map((r) => ({
    t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7], n: r[8],
  }));
}
function getKlines(symbol, interval, limit) {
  const key = 'k:' + interval + ':' + symbol + ':' + limit;
  return getCached(key, 5000, () => visionKlines(symbol, interval, limit));
}
// 按时间区间分页拉取（Binance 单次上限 1000 根）
async function visionKlinesRange(symbol, interval, startTime, endTime, maxBars) {
  const step = INTERVAL_MS[interval] || 300000;
  const out = [];
  let cursor = startTime;
  let guard = 0;
  while (out.length < maxBars && guard++ < 20) {
    const url = VISION + '/klines?symbol=' + encodeURIComponent(symbol) +
      '&interval=' + encodeURIComponent(interval) + '&limit=1000' +
      (cursor ? '&startTime=' + cursor : '') +
      (endTime ? '&endTime=' + endTime : '');
    const raw = await fetchJSON(url);
    if (!raw || !raw.length) break;
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7], n: r[8] });
    }
    if (raw.length < 1000) break;
    cursor = raw[raw.length - 1][0] + step;
    if (endTime && cursor > endTime) break;
  }
  return out.slice(0, maxBars);
}
function getKlinesRange(symbol, interval, startTime, endTime) {
  const key = 'kr:' + interval + ':' + symbol + ':' + (startTime || 0) + ':' + (endTime || 0);
  return getCached(key, 30000, () => visionKlinesRange(symbol, interval, startTime, endTime, RANGE_MAX_BARS));
}


// ---------- 大盘总览 ----------
async function getMarket() {
  return getCached('market', 20000, async () => {
    const [tk, gl, fg] = await Promise.all([
      fetchJSON('https://api.coinlore.net/api/tickers/?start=0&limit=30'),
      fetchJSON('https://api.coinlore.net/api/global/'),
      fetchJSON('https://api.alternative.me/fng/?limit=31'),
    ]);
    const g = (gl || [])[0] || {};
    const coins = ((tk && tk.data) || []).map((c) => ({
      s: c.symbol, n: c.name, p: +c.price_usd,
      c1: +c.percent_change_1h, c24: +c.percent_change_24h, c7: +c.percent_change_7d,
      m: +c.market_cap_usd, v: +c.volume24,
    }));
    const fng = (((fg && fg.data) || []).map((d) => ({ v: +d.value, t: +d.timestamp }))).reverse();
    return {
      ok: true, updated: Date.now(),
      global: {
        mcap: +g.total_mcap, vol: +g.total_volume, btcD: +g.btc_d, ethD: +g.eth_d,
        mcapChg: +g.mcap_change, coins: +g.coins_count,
      },
      fng: { value: fng.length ? fng[fng.length - 1].v : null, series: fng },
      coins: coins,
    };
  });
}

// ---------- 全市场异动扫描 ----------
// 一次 ticker/24hr 拿到全市场，过滤后对每个 USDT 现货对拉 100 根 5m K 线（weight 1），
// 算 5m/15m/30m/1h/4h 动量与 1h 波动率 —— 不预设币种，谁异动谁上榜。
// 关键：只有 status=TRADING 的现货对才是活的。
// BREAK（已下架/停牌）的交易对，/ticker/24hr 会一直回放它最后一天的成交量，
// K 线也永远停在停牌那一刻 —— 不过滤掉就会把坟墓币的"最后一根暴涨"排上异动榜。
async function getTradingSet() {
  return getCached('trading', 600000, async () => {
    const info = await fetchJSON(VISION + '/exchangeInfo', 60000);
    const set = {};
    for (let i = 0; i < info.symbols.length; i++) {
      const s = info.symbols[i];
      if (s.status === 'TRADING' && s.quoteAsset === 'USDT') set[s.symbol] = 1;
    }
    return set;
  });
}

async function getUniverse() {
  return getCached('universe', 60000, async () => {
    const [tk, trading] = await Promise.all([fetchJSON(VISION + '/ticker/24hr', 40000), getTradingSet()]);
    const list = [];
    let dropped = 0;
    for (let i = 0; i < tk.length; i++) {
      const t = tk[i];
      if (!t.symbol || t.symbol.length < 6 || t.symbol.slice(-4) !== 'USDT') continue;
      const base = t.symbol.slice(0, -4);
      if (/UP|DOWN|BULL|BEAR/.test(base)) continue;
      if (STABLE.has(base) || WRAPPED.has(base)) continue;
      if (!trading[t.symbol]) { dropped++; continue; } // 下架/停牌 -> 数据是冻结的
      const qv = +t.quoteVolume;
      if (!(qv >= MIN_QUOTE_VOLUME)) continue;
      list.push({ symbol: t.symbol, base: base, price: +t.lastPrice, c24: +t.priceChangePercent, qv: qv });
    }
    list.sort((a, b) => b.qv - a.qv);
    return { list: list, dropped: dropped };
  });
}

async function runScan() {
  const uni = await getUniverse();
  const list = uni.list;
  const out = [];
  let i = 0, stale = 0;
  const CONC = 16;
  const workers = new Array(CONC).fill(0).map(async () => {
    while (i < list.length) {
      const t = list[i++];
      try {
        const ks = await visionKlines(t.symbol, '5m', 100);
        const n = ks.length;
        if (n < 50) continue;
        // 第二道闸：K 线必须新鲜，否则一律丢弃（兜底防任何形式的陈旧数据）
        if (Date.now() - (ks[n - 1].t + 300000) > 15 * 60000) { stale++; continue; }
        const last = ks[n - 1].c;
        const back = (b) => (n - 1 - b >= 0 ? +((last / ks[n - 1 - b].c - 1) * 100).toFixed(3) : null);
        const lr = [];
        for (let k = 1; k < n; k++) lr.push(Math.log(ks[k].c / ks[k - 1].c));
        const w = lr.slice(-12);
        const rv1h = stdev(w) * Math.sqrt(BARS_PER_DAY) * 100;
        const hour = ks.slice(-12);
        const vol1h = sumOf(hour.map((k) => k.q));
        out.push({
          s: t.base, sym: t.symbol, p: last, qv: t.qv, c24: t.c24,
          m5: back(1), m15: back(3), m30: back(6), h1: back(12), h4: back(48),
          rv1h: +rv1h.toFixed(2),
          acc: +(t.qv ? vol1h / (t.qv / 24) : 1).toFixed(2),
        });
      } catch (e) { /* 单个失败就跳过，不影响整轮 */ }
    }
  });
  await Promise.all(workers);
  return {
    ok: true, updated: Date.now(), threshold: MIN_QUOTE_VOLUME,
    universe: list.length, scanned: out.length, dropped: uni.dropped, stale: stale,
    horizons: SCAN_HORIZONS, coins: out,
  };
}

const scanState = { data: null, at: 0, running: false };
function revalidateScan() {
  if (scanState.running) return;
  scanState.running = true;
  runScan()
    .then((d) => { scanState.data = d; scanState.at = Date.now(); })
    .catch(() => {})
    .finally(() => { scanState.running = false; });
}
// 过期时先回旧数据、后台刷新，避免请求等十几秒
async function getScan() {
  if (scanState.data) {
    if (Date.now() - scanState.at >= SCAN_TTL) revalidateScan();
    return scanState.data;
  }
  scanState.running = true;
  try {
    const d = await runScan();
    scanState.data = d; scanState.at = Date.now();
    return d;
  } finally { scanState.running = false; }
}

// 按 |1h 动量| 取最异动的若干币，用于并入重点观察
function pickMovers(scan, n, exclude) {
  const sorted = scan.coins.slice().sort((a, b) => Math.abs(b.h1 || 0) - Math.abs(a.h1 || 0));
  const out = [];
  for (let i = 0; i < sorted.length && out.length < n; i++) {
    if (exclude && exclude[sorted[i].s]) continue;
    out.push(sorted[i].sym);
  }
  return out;
}

// ---------- 动量 / 波动率 ----------
function momAnalyze(symbol, ks, ticker) {
  const n = ks.length;
  if (n < 300) throw new Error('K线不足');
  const price = ks[n - 1].c;

  const rets = {};
  for (let i = 0; i < HORIZONS.length; i++) {
    const label = HORIZONS[i][0], bars = HORIZONS[i][1];
    const idx = n - 1 - bars;
    rets[label] = idx >= 0 ? (price / ks[idx].c - 1) * 100 : null;
  }

  const lr = [];
  for (let i = 1; i < n; i++) lr.push(Math.log(ks[i].c / ks[i - 1].c));
  const tail = (w) => lr.slice(Math.max(0, lr.length - w));
  const ann = Math.sqrt(BARS_PER_DAY);
  const rv1h = stdev(tail(12)) * ann * 100;
  const rv4h = stdev(tail(48)) * ann * 100;
  const rv24h = stdev(tail(BARS_PER_DAY)) * ann * 100;

  const hour = ks.slice(-12);
  const atr1h = sumOf(hour.map((k) => (k.h - k.l) / k.c * 100)) / hour.length;
  const vol1h = sumOf(hour.map((k) => k.q));

  const day = ks.slice(-BARS_PER_DAY);
  let hi24 = -Infinity, lo24 = Infinity;
  for (let i = 0; i < day.length; i++) {
    if (day[i].h > hi24) hi24 = day[i].h;
    if (day[i].l < lo24) lo24 = day[i].l;
  }
  const vol24 = ticker ? +ticker.quoteVolume : null;

  return {
    symbol: symbol, base: symbol.replace(/USDT$/, ''), price: price,
    chg24: ticker ? +ticker.priceChangePercent : rets['24h'],
    rets: rets, rv1h: rv1h, rv4h: rv4h, rv24h: rv24h,
    volExpansion: rv24h > 0 ? rv1h / rv24h : 1,
    atr1h: atr1h, vol1h: vol1h, vol24h: vol24,
    volAccel: vol24 ? vol1h / (vol24 / 24) : null,
    hi24h: hi24, lo24h: lo24,
    pos24h: hi24 > lo24 ? (price - lo24) / (hi24 - lo24) * 100 : 50,
  };
}

async function getMomentum() {
  const scan = await getScan().catch(() => null);
  const trading = await getTradingSet();
  const alive = WATCHLIST.filter((s) => trading[s]); // 名单里也可能有已下架的
  const baseSet = {};
  alive.forEach((s) => { baseSet[s.replace(/USDT$/, '')] = 1; });
  const dynList = scan ? pickMovers(scan, 10, baseSet) : [];
  const symbols = alive.concat(dynList);
  const dynSet = {};
  dynList.forEach((s) => { dynSet[s] = 1; });
  return getCached('momentum:' + symbols.join(','), 15000, async () => {
    let bySym = {};
    try {
      const tickers = await fetchJSON(VISION + '/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(symbols)));
      for (let i = 0; i < (tickers || []).length; i++) bySym[tickers[i].symbol] = tickers[i];
    } catch (e) { bySym = {}; }

    const coins = [], failed = [];
    for (let i = 0; i < symbols.length; i += 6) {
      const chunk = symbols.slice(i, i + 6);
      const part = await Promise.all(chunk.map(async (sym) => {
        try {
          const ks = await visionKlines(sym, '5m', 500);
          if (Date.now() - (ks[ks.length - 1].t + 300000) > 15 * 60000) throw new Error('K线陈旧');
          return momAnalyze(sym, ks, bySym[sym] || null);
        } catch (e) {
          return { symbol: sym, base: sym.replace(/USDT$/, ''), error: String(e.message || e) };
        }
      }));
      for (let k = 0; k < part.length; k++) {
        if (part[k].error) failed.push(part[k].base);
        else { part[k].dyn = !!dynSet[part[k].symbol]; coins.push(part[k]); }
      }
    }
    coins.sort((a, b) => (b.vol24h || 0) - (a.vol24h || 0));

    const breadth = {}, avgReturn = {};
    for (let i = 0; i < HORIZONS.length; i++) {
      const label = HORIZONS[i][0];
      const vals = coins.map((c) => c.rets[label]).filter((v) => v !== null && v !== undefined);
      const up = vals.filter((v) => v > 0).length;
      breadth[label] = { up: up, total: vals.length, upPct: vals.length ? (up / vals.length) * 100 : 0 };
      avgReturn[label] = vals.length ? sumOf(vals) / vals.length : 0;
    }
    return {
      ok: true, updated: Date.now(), count: coins.length, failed: failed,
      horizons: HORIZONS.map((h) => h[0]), coins: coins, breadth: breadth, avgReturn: avgReturn,
      dynamic: dynList.map((s) => s.replace(/USDT$/, '')),
    };
  });
}

// ---------- Hyperliquid 鲸鱼监控（CoinGlass）----------
// 板块结构对齐 https://www.coinglass.com/zh/hyperliquid ：
//   鲸鱼持仓总览 / 大户持仓 / 最新鲸鱼动态 / 持仓人数多空比
const HL_TTL = 20000;
const errMsg = (r) => String((r && r.message) || r);

async function getHyperliquid() {
  return getCached('hl', HL_TTL, async () => {
    const [tpR, acR, slR, ucR] = await Promise.allSettled([
      cgFetch('/api/hyperliquid/topPosition'),
      cgFetch('/api/hyperliquid/topPosition/action'),
      cgFetch('/api/hyperliquid/position/symbol/shortAndLong'),
      cgFetch('/api/hyperliquid/position/user/count'),
    ]);
    const errors = [];

    // 1) 大户持仓全量 -> 总览聚合（口径对齐页面：资金费取反号）
    const ov = {
      count: 0, pos: 0, posL: 0, posS: 0, margin: 0, marL: 0, marS: 0,
      pnl: 0, pnlL: 0, pnlS: 0, fee: 0, feeL: 0, feeS: 0,
    };
    let positions = [];
    if (tpR.status === 'fulfilled' && Array.isArray(tpR.value)) {
      const all = tpR.value;
      ov.count = all.length;
      all.forEach((p) => {
        const isLong = p.size > 0;
        const posUsd = Math.abs(p.positionUsd);
        const fee = -p.fundingFee; // 页面口径与原始字段反号
        ov.pos += posUsd; ov.margin += p.margin; ov.pnl += p.unrealizedPnl; ov.fee += fee;
        if (isLong) {
          ov.posL += posUsd; ov.marL += p.margin; ov.pnlL += p.unrealizedPnl; ov.feeL += fee;
        } else {
          ov.posS += posUsd; ov.marS += p.margin; ov.pnlS += p.unrealizedPnl; ov.feeS += fee;
        }
      });
      positions = all.slice()
        .sort((a, b) => Math.abs(b.positionUsd) - Math.abs(a.positionUsd))
        .slice(0, 50)
        .map((p) => ({
          user: p.userId, coin: p.coin, long: p.size > 0, lev: p.leverage,
          posUsd: Math.abs(p.positionUsd),
          roe: p.margin ? (p.unrealizedPnl / p.margin) * 100 : null,
          pnl: p.unrealizedPnl, entry: p.entryPrice, liq: p.liquidationPrice,
          margin: p.margin, fee: -p.fundingFee, price: p.price, openTime: p.createTime,
        }));
    } else if (tpR.status === 'rejected') errors.push('topPosition: ' + errMsg(tpR.reason));

    // 2) 最新鲸鱼动态：state 1=开仓 2=平仓，配合 size 正负得到四个动作
    let actions = [];
    if (acR.status === 'fulfilled' && Array.isArray(acR.value)) {
      actions = acR.value.slice(0, 50).map((a) => ({
        user: a.userId, coin: a.coin, state: a.state, long: a.size > 0,
        posUsd: Math.abs(a.positionUsd), price: a.entryPrice, lev: a.leverage, t: a.createTime,
      }));
    } else if (acR.status === 'rejected') errors.push('action: ' + errMsg(acR.reason));

    // 3) 各币持仓人数多空比
    let ratios = [];
    if (slR.status === 'fulfilled' && Array.isArray(slR.value)) {
      ratios = slR.value.map((r) => ({
        coin: r.symbol, longPct: r.longUserPercent, shortPct: r.shortUserPercent,
        longUsers: r.longUserSize, shortUsers: r.shortUserSize,
      })).sort((a, b) => (b.longUsers + b.shortUsers) - (a.longUsers + a.shortUsers));
    } else if (slR.status === 'rejected') errors.push('shortAndLong: ' + errMsg(slR.reason));

    // 4) 多空账户数（汇总 + 曲线）
    let users = null;
    const userSeries = [];
    if (ucR.status === 'fulfilled' && Array.isArray(ucR.value) && ucR.value.length) {
      const raw = ucR.value;
      const last = raw[raw.length - 1];
      users = {
        long: last.longUserSize, short: last.shortUserSize, total: last.userSize,
        ratio: last.shortUserSize ? last.longUserSize / last.shortUserSize : null,
      };
      const step = Math.max(1, Math.floor(raw.length / 120));
      for (let i = 0; i < raw.length; i += step) {
        userSeries.push({ t: raw[i].dateTime, l: raw[i].longUserSize, s: raw[i].shortUserSize });
      }
      if (userSeries.length && userSeries[userSeries.length - 1].t !== last.dateTime) {
        userSeries.push({ t: last.dateTime, l: last.longUserSize, s: last.shortUserSize });
      }
    } else if (ucR.status === 'rejected') errors.push('userCount: ' + errMsg(ucR.reason));

    return { ok: true, updated: Date.now(), overview: ov, positions, actions, ratios, users, userSeries, errors };
  });
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const p = url.pathname;
  try {
    if (p === '/api/market') return sendJSON(res, 200, await getMarket());
    if (p === '/api/scan') return sendJSON(res, 200, await getScan());
    if (p === '/api/momentum') return sendJSON(res, 200, await getMomentum());
    if (p === '/api/hyperliquid') return sendJSON(res, 200, await getHyperliquid());
    if (p === '/api/klines') {
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      const interval = url.searchParams.get('interval') || '5m';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '240', 10) || 240, 20), 1000);
      const startTime = parseInt(url.searchParams.get('startTime') || '0', 10) || 0;
      const endTime = parseInt(url.searchParams.get('endTime') || '0', 10) || 0;
      if (!/^[A-Z0-9]{4,20}$/.test(symbol)) return sendJSON(res, 400, { ok: false, error: 'bad symbol' });
      if (INTERVALS.indexOf(interval) === -1) return sendJSON(res, 400, { ok: false, error: 'bad interval' });
      if (startTime || endTime) {
        const ranged = await getKlinesRange(symbol, interval, startTime || undefined, endTime || undefined);
        return sendJSON(res, 200, {
          ok: true, symbol: symbol, interval: interval, candles: ranged,
          truncated: ranged.length >= RANGE_MAX_BARS, updated: Date.now(),
        });
      }
      const candles = await getKlines(symbol, interval, limit);
      return sendJSON(res, 200, { ok: true, symbol: symbol, interval: interval, candles: candles, updated: Date.now() });
    }
    if (p === '/api/health') {
      const [scan, trading] = await Promise.all([getScan().catch(() => null), getTradingSet()]);
      const alive = WATCHLIST.filter((s) => trading[s]);
      const baseSet = {};
      alive.forEach((s) => { baseSet[s.replace(/USDT$/, '')] = 1; });
      const dyn = scan ? pickMovers(scan, 10, baseSet) : [];
      return sendJSON(res, 200, {
        ok: true, ts: Date.now(), intervals: INTERVALS,
        symbols: alive.concat(dyn), watchlist: alive, dynamic: dyn,
      });
    }

    const file = p === '/' ? '/index.html' : p;
    const fp = path.join(PUBLIC_DIR, path.normalize(file));
    if (fp.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(buf);
    });
  } catch (e) {
    sendJSON(res, 502, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('crypto-market-dashboard -> http://' + HOST + ':' + PORT);
  // 预热全市场扫描，让首屏不用等
  getScan()
    .then((d) => console.log('[scan] 预热完成 ' + d.scanned + '/' + d.universe + ' 个交易对'))
    .catch((e) => console.log('[scan] 预热失败 ' + e.message));
});
