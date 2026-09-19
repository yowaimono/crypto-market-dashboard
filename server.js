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

// ---------- 币股（Binance 代币化股票 / ETF）----------
// Binance 现货把代币化股票统一挂在 "XXXXB/USDT" 上：AAPLB=苹果、NVDAB=英伟达、SPYB=标普500。
// exchangeInfo 里没有任何「这是股票」的字段，只能靠 B 后缀 + 排除本来就叫 XXXB 的加密货币。
// 名称逐条对过 Nasdaq 官方接口（76/76 全部对应真实上市公司/ETF）。
// 这里只放展示用的代号与板块；币种集合仍从 exchangeInfo 动态取，将来新上的票会自动出现。
const CRYPTO_ENDING_B = new Set(['BNB', 'DGB', 'TRB', 'CKB', 'SHIB', 'ARB', 'BB', 'YB', 'MUB']);
const STOCK_META = {
  // 半导体
  NVDAB: ['NVDA', '英伟达', 'semi'], TSMB: ['TSM', '台积电', 'semi'], AVGOB: ['AVGO', '博通', 'semi'],
  AMDB: ['AMD', '超威半导体', 'semi'], AMATB: ['AMAT', '应用材料', 'semi'], ASMLB: ['ASML', '阿斯麦', 'semi'],
  ARMB: ['ARM', 'Arm控股', 'semi'], MRVLB: ['MRVL', '迈威尔', 'semi'], QCOMB: ['QCOM', '高通', 'semi'],
  INTCB: ['INTC', '英特尔', 'semi'], SKHYB: ['SKHY', 'SK海力士', 'semi'], LITEB: ['LITE', 'Lumentum', 'semi'],
  COHRB: ['COHR', '相干公司', 'semi'], CRDOB: ['CRDO', 'Credo', 'semi'], AAOIB: ['AAOI', '应用光电', 'semi'],
  AXTIB: ['AXTI', 'AXT', 'semi'], ALABB: ['ALAB', 'Astera Labs', 'semi'], CBRSB: ['CBRS', 'Cerebras', 'semi'],
  // 科技硬件
  AAPLB: ['AAPL', '苹果', 'tech'], MSFTB: ['MSFT', '微软', 'soft'], GOOGLB: ['GOOGL', '谷歌', 'net'],
  METAB: ['META', 'Meta', 'net'], AMZNB: ['AMZN', '亚马逊', 'net'], NFLXB: ['NFLX', '奈飞', 'net'],
  TSLAB: ['TSLA', '特斯拉', 'tech'], IBMB: ['IBM', 'IBM', 'tech'], DELLB: ['DELL', '戴尔', 'tech'],
  SMCIB: ['SMCI', '超微电脑', 'tech'], STXB: ['STX', '希捷', 'tech'], WDCB: ['WDC', '西部数据', 'tech'],
  SNDKB: ['SNDK', '闪迪', 'tech'], GLWB: ['GLW', '康宁', 'tech'], NOKB: ['NOK', '诺基亚', 'tech'],
  GPROB: ['GPRO', 'GoPro', 'tech'], QNTB: ['QNT', 'Quantinuum', 'tech'],
  // 软件 / 云
  ORCLB: ['ORCL', '甲骨文', 'soft'], CRMB: ['CRM', '赛富时', 'soft'], PLTRB: ['PLTR', 'Palantir', 'soft'],
  CRWDB: ['CRWD', 'CrowdStrike', 'soft'], CRWVB: ['CRWV', 'CoreWeave', 'soft'], NBISB: ['NBIS', 'Nebius', 'soft'],
  // 互联网 / 平台
  BABAB: ['BABA', '阿里巴巴', 'net'], RDDTB: ['RDDT', 'Reddit', 'net'], GMEB: ['GME', '游戏驿站', 'net'],
  DJTB: ['DJT', '特朗普媒体', 'net'],
  // 金融 / 加密相关
  COINB: ['COIN', 'Coinbase', 'crypto'], CRCLB: ['CRCL', 'Circle', 'crypto'], MSTRB: ['MSTR', 'Strategy', 'crypto'],
  BMNRB: ['BMNR', 'BitMine', 'crypto'], BNCB: ['BNC', 'CEA Industries', 'crypto'], IRENB: ['IREN', 'IREN', 'crypto'],
  HOODB: ['HOOD', 'Robinhood', 'fin'], GSB: ['GS', '高盛', 'fin'], PYPLB: ['PYPL', 'PayPal', 'fin'],
  // 医疗
  MRNAB: ['MRNA', 'Moderna', 'health'], HIMSB: ['HIMS', 'Hims & Hers', 'health'],
  // 航天 / 工业
  SPCXB: ['SPCX', 'SpaceX', 'space'], RKLBB: ['RKLB', '火箭实验室', 'space'], ASTSB: ['ASTS', 'AST太空移动', 'space'],
  BEB: ['BE', 'Bloom Energy', 'energy'], FLNCB: ['FLNC', 'Fluence', 'energy'], USARB: ['USAR', 'USA Rare Earth', 'other'],
  // 指数 ETF
  SPYB: ['SPY', '标普500 ETF', 'index'], QQQB: ['QQQ', '纳指100 ETF', 'index'],
  SMHB: ['SMH', '半导体 ETF', 'index'], EWYB: ['EWY', '韩国 ETF', 'index'], DRAMB: ['DRAM', '存储 ETF', 'index'],
  // 杠杆 / 反向 ETF
  TQQQB: ['TQQQ', '纳指3倍做多', 'lev'], SQQQB: ['SQQQ', '纳指3倍做空', 'lev'],
  SOXLB: ['SOXL', '半导体3倍做多', 'lev'], SOXSB: ['SOXS', '半导体3倍做空', 'lev'],
  KORUB: ['KORU', '韩国3倍做多', 'lev'], INTWB: ['INTW', '英特尔2倍做多', 'lev'],
  MUUB: ['MUU', '美光2倍做多', 'lev'], MVLLB: ['MVLL', '迈威尔2倍做多', 'lev'],
  SNXXB: ['SNXX', '闪迪2倍做多', 'lev'],
};
const STOCK_SECTORS = {
  semi: '半导体', tech: '科技硬件', soft: '软件云', net: '互联网平台',
  crypto: '加密相关', fin: '金融', health: '医疗', space: '航天工业',
  energy: '能源', index: '指数 ETF', lev: '杠杆 ETF', other: '其他',
};

// 动态取「当前在交易的币股」，元数据缺失的也照样上榜（用代号兜底）
async function getStockUniverse() {
  return getCached('stockuniverse', 600000, async () => {
    const info = await fetchJSON(VISION + '/exchangeInfo', 60000);
    const out = [];
    for (let i = 0; i < info.symbols.length; i++) {
      const s = info.symbols[i];
      if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT') continue;
      const b = s.baseAsset;
      if (!/B$/.test(b) || CRYPTO_ENDING_B.has(b)) continue;
      const m = STOCK_META[b];
      out.push({
        symbol: s.symbol, base: b,
        ticker: m ? m[0] : b.slice(0, -1),   // 元数据里没有的，去掉 B 当代号
        name: m ? m[1] : b, sector: m ? m[2] : 'other',
      });
    }
    out.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
    return out;
  });
}

// 币股行情：复用加密货币那套动量/波动率算法（实测这些代币 7x24 连续成交，5m 无跳空）
async function getStocks() {
  const uni = await getStockUniverse();
  const symbols = uni.map((u) => u.symbol);
  return getCached('stocks:' + symbols.length, 15000, async () => {
    let bySym = {};
    try {
      const tickers = await fetchJSON(VISION + '/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(symbols)), 40000);
      for (let i = 0; i < (tickers || []).length; i++) bySym[tickers[i].symbol] = tickers[i];
    } catch (e) { bySym = {}; }

    const coins = [], failed = [];
    for (let i = 0; i < uni.length; i += 6) {
      const chunk = uni.slice(i, i + 6);
      const part = await Promise.all(chunk.map(async (u) => {
        try {
          const ks = await visionKlines(u.symbol, '5m', 500);
          if (Date.now() - (ks[ks.length - 1].t + 300000) > 15 * 60000) throw new Error('K线陈旧');
          const a = momAnalyze(u.symbol, ks, bySym[u.symbol] || null);
          a.ticker = u.ticker; a.name = u.name; a.sector = u.sector;
          return a;
        } catch (e) {
          return { symbol: u.symbol, base: u.base, ticker: u.ticker, error: String(e.message || e) };
        }
      }));
      for (let k = 0; k < part.length; k++) {
        if (part[k].error) failed.push(part[k].ticker);
        else coins.push(part[k]);
      }
    }
    coins.sort((a, b) => (b.vol24h || 0) - (a.vol24h || 0));

    // 板块聚合：等权收益 + 上涨家数占比 + 平均波动
    const sec = {};
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      const g = sec[c.sector] || (sec[c.sector] = { key: c.sector, n: 0, sum: {}, cnt: {}, up: {}, rv: 0, qv: 0 });
      g.n++; g.qv += (c.vol24h || 0); g.rv += c.rv1h;
      for (let h = 0; h < HORIZONS.length; h++) {
        const L = HORIZONS[h][0], v = c.rets[L];
        if (v === null || v === undefined) continue;
        g.sum[L] = (g.sum[L] || 0) + v;
        g.cnt[L] = (g.cnt[L] || 0) + 1;
        g.up[L] = (g.up[L] || 0) + (v > 0 ? 1 : 0);
      }
    }
    const sectors = Object.keys(sec).map((k) => {
      const g = sec[k], avg = {}, upPct = {};
      for (let h = 0; h < HORIZONS.length; h++) {
        const L = HORIZONS[h][0], n = g.cnt[L] || 0;
        avg[L] = n ? g.sum[L] / n : 0;
        upPct[L] = n ? (g.up[L] / n) * 100 : 0;
      }
      return { key: g.key, label: STOCK_SECTORS[g.key] || g.key, n: g.n, avg: avg, upPct: upPct,
        rv1h: g.n ? g.rv / g.n : 0, vol24h: g.qv };
    }).sort((a, b) => (b.avg['1h'] || 0) - (a.avg['1h'] || 0));

    const breadth = {}, avgReturn = {};
    for (let i = 0; i < HORIZONS.length; i++) {
      const L = HORIZONS[i][0];
      const vals = coins.map((c) => c.rets[L]).filter((v) => v !== null && v !== undefined);
      const up = vals.filter((v) => v > 0).length;
      breadth[L] = { up: up, total: vals.length, upPct: vals.length ? (up / vals.length) * 100 : 0 };
      avgReturn[L] = vals.length ? sumOf(vals) / vals.length : 0;
    }
    return {
      ok: true, updated: Date.now(), count: coins.length, failed: failed,
      universe: uni.length, horizons: HORIZONS.map((h) => h[0]),
      coins: coins, sectors: sectors, breadth: breadth, avgReturn: avgReturn,
      vol24h: sumOf(coins.map((c) => c.vol24h || 0)),
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

// ---------- 币种图标 ----------
// 每个币都尽量给一张真图标。链路：
//   1) bin.bnbstatic.com（币安自家 logo 库，全世界最全：连美股代币、中文名币都有）
//      —— 本机 DNS 解析不了这个域名，所以套一层 wsrv.nl 图片代理转发
//   2) 兑不到就退回 CoinLore 的 nameid 图标
//   3) 都拿不到 -> 404，前端退化成首字母色块
// 命中后落盘到 public/icons/，7 天有效，之后全走本地磁盘，不再打网络。
const ICON_DIR = path.join(PUBLIC_DIR, 'icons');
try { fs.mkdirSync(ICON_DIR, { recursive: true }); } catch (e) {}
const iconInflight = new Map();

// 币安 logo 库的文件名就是币种代号，且存在中文名的币（币安人生 / 牛来），
// 所以这里保留 ASCII 字母数字 + 汉字，其余一律剔除
function safeBase(b) {
  return String(b || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 24);
}
// 中文名不能直接当文件名，给非 ASCII 的代号生成一个稳定的哈希名
function iconFile(b) {
  if (/^[A-Z0-9]+$/.test(b)) return path.join(ICON_DIR, b + '.png');
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) { h ^= b.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return path.join(ICON_DIR, 'u' + h.toString(16) + '.png');
}

// CoinLore: symbol -> nameid（图标文件名），缓存 6 小时，只做兜底用
function getLoreNames() {
  return getCached('lorenames', 6 * 3600 * 1000, async () => {
    const map = {};
    for (let start = 0; start < 4000; start += 100) {
      let j;
      try { j = await fetchJSON('https://api.coinlore.net/api/tickers/?start=' + start + '&limit=100', 20000); }
      catch (e) { break; }
      const rows = (j && j.data) || [];
      if (!rows.length) break;
      for (let k = 0; k < rows.length; k++) {
        const s = String(rows[k].symbol || '').toUpperCase();
        if (s && !map[s]) map[s] = rows[k].nameid;
      }
      if (rows.length < 100) break;
    }
    return map;
  });
}

async function fetchImage(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'crypto-market-dashboard/1.0' } });
    if (!res.ok) return null;
    if (!/^image\//.test(res.headers.get('content-type') || '')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 120 ? buf : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function iconBytes(base) {
  const b = safeBase(base);
  if (!b) return Promise.resolve(null);
  const file = iconFile(b);
  try {
    const st = fs.statSync(file);
    if (st.size > 120) return Promise.resolve(fs.readFileSync(file));
  } catch (e) { /* 没缓存，往下走 */ }
  if (iconInflight.has(b)) return iconInflight.get(b); // 同一张图并发只打一次网络

  const task = (async () => {
    const upstream = 'bin.bnbstatic.com/static/assets/logos/' + b + '.png';
    let buf = await fetchImage(
      'https://wsrv.nl/?url=' + encodeURIComponent(upstream) + '&w=64&h=64&fit=cover&output=png', 15000);
    if (!buf) {
      try {
        const nid = (await getLoreNames())[b];
        if (nid) buf = await fetchImage('https://www.coinlore.com/img/' + encodeURIComponent(nid) + '.png', 12000);
      } catch (e) { /* 兜底失败就算了 */ }
    }
    if (buf) { try { fs.writeFileSync(file, buf); } catch (e) {} }
    return buf || null;
  })().finally(() => iconInflight.delete(b));

  iconInflight.set(b, task);
  return task;
}

// 预热：只补磁盘上没有的，避免首次打开表格时每张图都在转圈
async function warmIcons() {
  let uni;
  try { uni = await getUniverse(); } catch (e) { return; }
  const bases = [], seen = {};
  for (let i = 0; i < uni.list.length; i++) {
    const b = uni.list[i].base;
    if (!seen[b]) { seen[b] = 1; bases.push(b); }
  }
  let i = 0, ok = 0;
  const workers = new Array(6).fill(0).map(async () => {
    while (i < bases.length) {
      const b = bases[i++];
      try { if (await iconBytes(b)) ok++; } catch (e) {}
    }
  });
  await Promise.all(workers);
  console.log('[icon] 预热完成 ' + ok + '/' + bases.length + ' 个币种图标');
}

// ---------- 消息面（币界网 528btc 快讯）----------
// 数据源：https://www.528btc.com/e/extend/api/index.php?m=data&c=kx （POST）
//   表单 important=&type=101&page=N&size=20
// 两个坑：
//   1. 这个接口偶尔不返回 JSON，而是吐一段混淆过的 JS「挑战脚本」，要求带上
//      __tst_status / EO_Bot_Ssid 两个 cookie 才放行。脚本是纯计算的，没有外部依赖，
//      所以这里直接把脚本丢进沙箱跑一遍，读 document.cookie 拿到值（见 solveChallenge）。
//   2. size 参数无效，服务端始终只给 20 条 —— 想多要只能翻页。
const NEWS_API = 'https://www.528btc.com/e/extend/api/index.php?m=data&c=kx';
const NEWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const NEWS_TTL = 60000;
const NEWS_PAGES = 5;          // 普通快讯 5 页 = 100 条
const NEWS_IMP_PAGES = 3;      // important=1 精选流 3 页（该源可能停更，见下）
const NEWS_IMP_MAX_LAG = 12 * 3600000; // 精选条目比快讯流旧超过 12 小时就不要了
let newsWatermark = 0;         // 快讯流最新一条的时间，用来判断精选流是否还活着
let newsImportantDropped = 0;  // 因为太旧被丢掉的精选条数（前端如实展示）
const NEWS_CACHE_FILE = path.join(__dirname, '.news-cache.json');
let newsCookie = '';

// 把挑战脚本跑一遍，取出它想写的 cookie
function solveChallenge(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return '';
  const jar = [];
  const document = {
    get cookie() { return jar.join(' '); },
    set cookie(v) { jar.push(String(v)); },
  };
  const location = { href: 'https://www.528btc.com/kx/' };
  try {
    // 脚本只用 document.cookie / location.href / setTimeout，没有别的能力
    new Function('document', 'location', 'setTimeout', m[1])(document, location, () => 0);
  } catch (e) { return ''; }
  const pairs = [];
  for (let i = 0; i < jar.length; i++) {
    const parts = String(jar[i]).split(';');
    for (let k = 0; k < parts.length; k++) {
      const x = parts[k].trim().replace(/#$/, '');
      if (x && x.indexOf('=') > 0) pairs.push(x);
    }
  }
  return pairs.join('; ');
}

function newsHeaders(cookie) {
  const h = {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'accept': '*/*', 'accept-language': 'zh-CN,zh;q=0.9',
    'origin': 'https://www.528btc.com', 'referer': 'https://www.528btc.com/kx/',
    'user-agent': NEWS_UA, 'x-requested-with': 'XMLHttpRequest',
  };
  if (cookie) h.cookie = cookie;
  return h;
}

// 抓一页；撞上挑战就自动解一次再重试
async function newsFetchPage(page, extra, attempt) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(NEWS_API, {
      method: 'POST', headers: newsHeaders(newsCookie), signal: ac.signal,
      body: (extra || 'important=&') + 'type=101&page=' + page + '&size=20',
    });
    const text = await res.text();
    if (text.charAt(0) === '<') { // 挑战脚本
      if ((attempt || 0) >= 2) return null;
      const ck = solveChallenge(text);
      if (!ck) return null;
      newsCookie = ck;
      return newsFetchPage(page, extra, (attempt || 0) + 1);
    }
    const j = JSON.parse(text);
    if (!j || j.code !== 200 || !j.data) return null;
    return j.data;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 快讯自带一个 coins 标签数组，但噪声极大 —— SEC / ETF / WHALE / LABS / APPLE
// 这类概念词也会被当成「币」标进来（实测 SEC 出现 18 次、ETF 16 次），
// 所以只认能真正对应上主流币的标签，其余全部丢掉，免得前端点进去是空气。
// 另外标签只覆盖 24% 的条目，这里再补两条线索：$SYMBOL 写法和中文币名。
const NEWS_TAG_OK = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX',
  'DOT', 'LTC', 'BCH', 'SUI', 'APT', 'NEAR', 'ARB', 'OP', 'UNI', 'HBAR', 'PEPE', 'SHIB', 'TON',
  'MATIC', 'POL', 'AAVE', 'ATOM', 'FIL', 'INJ', 'SEI', 'TIA', 'ORDI', 'WLD', 'ENA', 'JUP', 'PYTH',
  'RNDR', 'RENDER', 'FET', 'TAO', 'ZEC', 'XMR', 'ETC', 'XLM', 'ALGO', 'VET', 'ICP', 'IMX', 'SAND',
  'MANA', 'AXS', 'GALA', 'CRV', 'MKR', 'SNX', 'COMP', 'DYDX', 'LDO', 'EIGEN', 'ETHFI', 'PENDLE',
  'ONDO', 'WIF', 'BONK', 'FLOKI', 'MEME', 'PENGU', 'TRUMP', 'HYPE', 'KAITO', 'VIRTUAL', 'USDC']);
// 注：USDT 是计价单位不是标的，故意不放进白名单；能否点得开最终由前端按实时交易集合判定
// 中文行文里最常出现的币名（中文媒体基本这么写）
const NEWS_TAG_CN = {
  比特币: 'BTC', 以太坊: 'ETH', 以太币: 'ETH', 币安币: 'BNB', 索拉纳: 'SOL', 瑞波: 'XRP',
  狗狗币: 'DOGE', 艾达币: 'ADA', 波场: 'TRX', 莱特币: 'LTC', 比特现金: 'BCH', 比特币现金: 'BCH',
  波卡: 'DOT', 雪崩: 'AVAX', 恒星币: 'XLM', 门罗币: 'XMR', 零币: 'ZEC', 大零币: 'ZEC',
  柴犬币: 'SHIB', 佩佩: 'PEPE', 独角兽: 'UNI', 链环: 'LINK', 柚子币: 'EOS',
};

// 从「自带标签 + $SYMBOL + 中文币名」三处汇总，去重且只保留能点开的
function newsTags(item) {
  const out = [], seen = {};
  const push = (s) => {
    const u = String(s || '').toUpperCase();
    if (NEWS_TAG_OK.has(u) && !seen[u]) { seen[u] = 1; out.push(u); }
  };
  const coins = item.coins || [];
  for (let i = 0; i < coins.length; i++) push(coins[i].s);

  const hay = String(item.title || '') + ' ' + String(item.smalltext || '');
  let m;
  const re = /\$([A-Z][A-Z0-9]{1,9})\b/g;
  while ((m = re.exec(hay))) push(m[1]);
  for (const k in NEWS_TAG_CN) { if (hay.indexOf(k) >= 0) push(NEWS_TAG_CN[k]); }
  return out;
}

function shapeNews(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const d = items[i];
    if (!d || !d.title) continue;
    out.push({
      id: String(d.id),
      t: +d.newstime * 1000,
      title: d.title,
      text: String(d.smalltext || '').replace(/<[^>]*>/g, '').trim(),
      tags: newsTags(d),
      important: +d.important === 1,
    });
  }
  return out;
}

function readNewsCache() {
  try { return JSON.parse(fs.readFileSync(NEWS_CACHE_FILE, 'utf8')); } catch (e) { return null; }
}

async function getNews() {
  const hit = cache.get('news');
  if (hit && Date.now() - hit.at < NEWS_TTL) return hit.val;

    // 普通快讯流（实时）
  const batches = [];
  for (let p = 1; p <= NEWS_PAGES; p++) batches.push(await newsFetchPage(p, '', 0));
  let items = [];
  for (let i = 0; i < batches.length; i++) if (batches[i]) items = items.concat(batches[i]);
  if (items.length) newsWatermark = Math.max(newsWatermark, +items[0].newstime * 1000);

  // important=1 这条「精选流」是停更的（服务端冻结在 2026-04-01，早于快讯流半年），
  // 直接混进来会把四月的旧闻当成今天推给你。所以只在它确实紧跟快讯流时才采信，
  // 否则整段丢弃 —— 宁可少给内容，也不能给你一条错的时间线。
  if (items.length) {
    const imp = [];
    for (let p = 1; p <= NEWS_IMP_PAGES; p++) imp.push(await newsFetchPage(p, 'important=1&', 0));
    let impItems = [];
    for (let i = 0; i < imp.length; i++) if (imp[i]) impItems = impItems.concat(imp[i]);
    const fresh = impItems.filter((d) => newsWatermark - +d.newstime * 1000 <= NEWS_IMP_MAX_LAG);
    newsImportantDropped = impItems.length - fresh.length;
    items = items.concat(fresh);
  }

  if (!items.length) {
    // 接口挂了就回上一次的缓存，页面上能看出是旧数据
    const old = readNewsCache();
    if (old) return Object.assign({}, old, { stale: true });
    return { ok: false, error: '币界网快讯不可达' };
  }

  // 去重（翻页之间有重叠），按时间倒序
  const seen = {}, uniq = [];
  items.forEach((d) => { const id = String(d.id); if (!seen[id]) { seen[id] = 1; uniq.push(d); } });
  uniq.sort((a, b) => +b.newstime - +a.newstime);

  const shaped = shapeNews(uniq);
  const now = Date.now();
  const windows = [[1, '1h'], [4, '4h'], [24, '24h']];
  const pace = {};
  windows.forEach((w) => { pace[w[1]] = shaped.filter((n) => now - n.t <= w[0] * 3600000).length; });
  const freshCut = now - 24 * 3600000;
  const fresh = shaped.filter((n) => n.t >= freshCut);

  // 热度：按币种统计提及次数（近 24h）
  const heat = {};
  shaped.forEach((n) => { if (now - n.t > 24 * 3600000) return; n.tags.forEach((s) => { heat[s] = (heat[s] || 0) + 1; }); });
  const hot = Object.keys(heat).map((s) => ({ s: s, n: heat[s] })).sort((a, b) => b.n - a.n).slice(0, 24);

  const val = {
    ok: true, updated: now, count: shaped.length,
    latest: shaped.length ? shaped[0].t : null,
    oldest: shaped.length ? shaped[shaped.length - 1].t : null,
    pace: pace, hot: hot, hotWindow: fresh.length,
    important: shaped.filter((n) => n.important).length,
    dropped: newsImportantDropped,
    source: '币界网 528btc · 快讯',
    news: shaped,
  };
  try { fs.writeFileSync(NEWS_CACHE_FILE, JSON.stringify(val)); } catch (e) {}
  cache.set('news', { at: Date.now(), val: val });
  return val;
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
    if (p === '/api/icon') {
      // 任意币种图标：命中缓存直接吐磁盘，没有就去取，取不到给前端一个明确的 404
      const raw = (url.searchParams.get('base') || url.searchParams.get('symbol') || '').trim();
      // 传 USDTUSDT 之类的交易对也没关系；但 base 本身就等于 USDT 时不能剥成空串
      const stripped = raw.replace(/USDT$/i, '');
      const base = stripped || raw;
      const buf = await iconBytes(base).catch(() => null);
      if (!buf) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('no icon');
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }
    if (p === '/api/market') return sendJSON(res, 200, await getMarket());
    if (p === '/api/scan') return sendJSON(res, 200, await getScan());
    if (p === '/api/momentum') return sendJSON(res, 200, await getMomentum());
    if (p === '/api/stocks') return sendJSON(res, 200, await getStocks());
    if (p === '/api/news') return sendJSON(res, 200, await getNews());
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
      const [scan, trading, stockUni] = await Promise.all([
        getScan().catch(() => null), getTradingSet(), getStockUniverse().catch(() => [])]);
      const alive = WATCHLIST.filter((s) => trading[s]);
      const baseSet = {};
      alive.forEach((s) => { baseSet[s.replace(/USDT$/, '')] = 1; });
      const dyn = scan ? pickMovers(scan, 10, baseSet) : [];
      return sendJSON(res, 200, {
        ok: true, ts: Date.now(), intervals: INTERVALS,
        symbols: alive.concat(dyn), watchlist: alive, dynamic: dyn,
        stocks: stockUni.map((u) => ({ symbol: u.symbol, ticker: u.ticker, name: u.name })),
      });
    }

    const file = p === '/' ? '/index.html' : p;
    const fp = path.join(PUBLIC_DIR, path.normalize(file));
    if (fp.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      const hdr = { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length };
      if (fp.indexOf(ICON_DIR) === 0) hdr['Cache-Control'] = 'public, max-age=604800, immutable';
      res.writeHead(200, hdr);
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
    .then((d) => {
      console.log('[scan] 预热完成 ' + d.scanned + '/' + d.universe + ' 个交易对');
      warmIcons().catch((e) => console.log('[icon] 预热失败 ' + e.message));
    })
    .catch((e) => console.log('[scan] 预热失败 ' + e.message));
});
