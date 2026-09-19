/* ============================================================
 * paper.js —— 实盘模拟（paper trading）引擎
 *
 * 设计要点：
 *  1. 一个组合（portfolio）可以挂多个「策略实例」，每个实例独立设置
 *     本金 / 杠杆 / 仓位比例 / 手续费 / 是否允许做空 / 参数。
 *  2. 每个实例按自己的周期（1m/5m/15m/1h/4h）轮询最新 K 线，用 strat-core
 *     里与回测**完全相同**的信号函数求值，只在「新收出一根 K 线」时判信号，
 *     避免同一根 K 线内反复触发。
 *  3. 成交按当前价 + 滑点模拟；开仓记手续费；持仓逐 tick 盯市，实时计算
 *     权益 / 浮盈 / 最大回撤；触及强平价立即爆仓。
 *  4. 状态落盘 .paper-state.json，进程重启后继续跑（不丢仓位与历史）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const Core = require('./public/strat-core.js');

const STATE_FILE = path.join(__dirname, '.paper-state.json');
const VISION = 'https://data-api.binance.vision/api/v3';

const IV_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '12h': 43200000, '1d': 86400000 };
const IV_KLINES = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '12h': '12h', '1d': '1d' };

let state = null;
let klineCache = new Map();   // sym|iv -> {at, candles}
const lastBarSeen = new Map(); // instId -> 已处理过的最后一根 K 线时间

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    state = { instances: [], updated: 0 };
  }
  if (!Array.isArray(state.instances)) state.instances = [];
  return state;
}
let saveTimer = null;
function save() {
  // 高频调用，合并写盘
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { if (state) fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
  }, 400);
}

async function fetchKlines(sym, iv, limit) {
  const key = sym + '|' + iv + '|' + limit;
  const hit = klineCache.get(key);
  const ttl = Math.min(20000, (IV_MS[iv] || 300000) / 4);
  if (hit && Date.now() - hit.at < ttl) return hit.candles;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(VISION + '/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + IV_KLINES[iv] + '&limit=' + limit, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const c = j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7] }));
    klineCache.set(key, { at: Date.now(), candles: c });
    return c;
  } finally { clearTimeout(timer); }
}

function instById(id) {
  const s = load();
  for (let i = 0; i < s.instances.length; i++) if (s.instances[i].id === id) return s.instances[i];
  return null;
}

// 新建一个策略实例
function createInstance(o) {
  const s = load();
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const inst = {
    id: id,
    name: String(o.name || '未命名').slice(0, 40),
    symbol: String(o.symbol || 'BTCUSDT').toUpperCase(),
    interval: IV_MS[o.interval] ? o.interval : '15m',
    code: String(o.code || 'return 0;'),
    capital: Math.max(10, +o.capital || 1000),
    lev: Math.max(1, Math.min(100, +o.lev || 1)),
    posPct: Math.max(0.01, Math.min(1, +o.posPct || 1)),
    fee: Math.max(0, +o.fee || 0.0005),
    slippage: Math.max(0, +o.slippage || 0.0002),
    allowShort: !!o.allowShort,
    createdAt: Date.now(),
    startedAt: Date.now(),
    running: true,
    // 账户
    equity: Math.max(10, +o.capital || 1000),
    pos: 0, qty: 0, entry: 0, entryT: 0, entryIdx: 0, entryFee: 0, liqPx: null,
    peak: Math.max(10, +o.capital || 1000), maxDD: 0,
    lastPrice: null, lastBarT: 0, lastSignal: 0, lastError: null,
    ticks: 0, signals: 0,
    trades: [], eq: [], events: [],
  };
  s.instances.push(inst);
  if (s.instances.length > 40) s.instances.splice(0, s.instances.length - 40);
  save();
  return inst;
}

function removeInstance(id) {
  const s = load();
  const i = s.instances.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const inst = s.instances[i];
  closePosition(inst, inst.lastPrice || inst.entry, '手动平仓');
  s.instances.splice(i, 1);
  save();
  return true;
}

function closePosition(inst, price, reason) {
  if (!inst.pos || !inst.qty) return;
  const g = (price - inst.entry) * inst.qty * (inst.pos > 0 ? 1 : -1);
  const f = inst.qty * price * inst.fee;
  const net = g - f - inst.entryFee;
  inst.equity += g - f;
  inst.trades.push({
    openT: inst.entryT, closeT: Date.now(), side: inst.pos, entry: inst.entry,
    exit: price, qty: inst.qty, pnl: net, reason: reason, entryIdx: inst.entryIdx,
  });
  inst.events.push({ t: Date.now(), type: 'close', side: inst.pos, price: price, pnl: net, reason: reason });
  inst.pos = 0; inst.qty = 0; inst.liqPx = null;
  if (inst.events.length > 200) inst.events.splice(0, inst.events.length - 200);
}

function openPosition(inst, side, price) {
  const notional = inst.equity * inst.lev * inst.posPct;
  if (notional <= 0 || inst.equity <= 0) return;
  const fill = price * (1 + inst.slippage * side);
  inst.pos = side; inst.entry = fill; inst.entryT = Date.now();
  inst.qty = notional / fill; inst.entryFee = notional * inst.fee;
  inst.equity -= inst.entryFee;
  inst.liqPx = side > 0 ? fill * (1 - 1 / inst.lev) : fill * (1 + 1 / inst.lev);
  inst.events.push({ t: Date.now(), type: 'open', side: side, price: fill, qty: inst.qty });
  if (inst.events.length > 200) inst.events.splice(0, inst.events.length - 200);
}

// 单个实例推进一次
async function tickInstance(inst) {
  if (!inst.running) return;
  let candles;
  try {
    candles = await fetchKlines(inst.symbol, inst.interval, 400);
  } catch (e) {
    inst.lastError = 'K线获取失败: ' + e.message;
    return;
  }
  if (!candles || candles.length < 60) { inst.lastError = 'K线不足'; return; }
  const last = candles[candles.length - 1];
  inst.lastPrice = last.c;
  inst.ticks++;
  inst.lastError = null;

  // 盯市 + 爆仓
  if (inst.pos !== 0 && inst.liqPx !== null) {
    if ((inst.pos > 0 && last.l <= inst.liqPx) || (inst.pos < 0 && last.h >= inst.liqPx)) {
      const g = (inst.liqPx - inst.entry) * inst.qty * (inst.pos > 0 ? 1 : -1);
      const f = inst.qty * inst.liqPx * inst.fee;
      inst.equity += g - f;
      if (inst.equity < 0) inst.equity = 0;
      inst.trades.push({ openT: inst.entryT, closeT: Date.now(), side: inst.pos, entry: inst.entry, exit: inst.liqPx, qty: inst.qty, pnl: g - f - inst.entryFee, reason: '爆仓', entryIdx: inst.entryIdx });
      inst.events.push({ t: Date.now(), type: 'liq', side: inst.pos, price: inst.liqPx, pnl: g - f - inst.entryFee });
      inst.pos = 0; inst.qty = 0; inst.liqPx = null;
      if (inst.equity < inst.capital * 0.01) inst.running = false;   // 归零即停
    }
  }

  // 只在「新 K 线收出」时判信号，避免同根反复触发
  if (inst.lastBarT === last.t) { markToMarket(inst); return; }
  const prevBarT = inst.lastBarT;
  inst.lastBarT = last.t;

  // 信号用「已收盘的上一根」做决策，用当前价成交（避免用未收盘 K 线自欺）
  const closed = candles.slice(0, candles.length - 1);
  if (closed.length < 60) { markToMarket(inst); return; }
  let target;
  try {
    target = Core.signalAt(closed, inst.code, closed.length - 1,
      inst.pos, inst.pos !== 0 ? inst.entry : 0, inst.pos !== 0 ? (closed.length - 1 - inst.entryIdx) : 0,
      inst.allowShort);
  } catch (e) {
    inst.lastError = '策略执行出错: ' + e.message;
    markToMarket(inst);
    return;
  }
  if (target !== inst.lastSignal || target !== inst.pos) inst.signals++;
  inst.lastSignal = target;
  if (prevBarT === 0) { markToMarket(inst); return; }  // 首根只登记，不交易

  const px = last.c;
  if (target !== inst.pos) {
    if (inst.pos !== 0) closePosition(inst, px * (1 - inst.slippage * inst.pos), '信号平仓');
    if (target !== 0 && inst.equity > 1) openPosition(inst, target, px);
  }
  markToMarket(inst);
}

function markToMarket(inst) {
  const px = inst.lastPrice;
  const unreal = inst.pos !== 0 && px ? (px - inst.entry) * inst.qty * (inst.pos > 0 ? 1 : -1) : 0;
  const cur = inst.equity + unreal;
  inst.markEquity = cur;
  if (cur > inst.peak) inst.peak = cur;
  if (inst.peak > 0) { const dd = (inst.peak - cur) / inst.peak; if (dd > inst.maxDD) inst.maxDD = dd; }
  inst.eq.push({ t: Date.now(), e: cur });
  if (inst.eq.length > 3000) inst.eq.splice(0, inst.eq.length - 3000);
  save();
}

// 全量推进
let ticking = false;
async function tickAll() {
  const s = load();
  const running = s.instances.filter((x) => x.running);
  if (!running.length) return;
  if (ticking) return;
  ticking = true;
  try {
    await Promise.all(running.map((inst) => tickInstance(inst).catch((e) => { inst.lastError = String(e.message || e); })));
    s.updated = Date.now();
    save();
  } finally { ticking = false; }
}

function summary(inst) {
  const cur = inst.markEquity !== undefined ? inst.markEquity : inst.equity;
  const wins = inst.trades.filter((t) => t.pnl > 0);
  const gp = wins.reduce((a, b) => a + b.pnl, 0);
  const gl = Math.abs(inst.trades.filter((t) => t.pnl <= 0).reduce((a, b) => a + b.pnl, 0));
  const unreal = inst.pos !== 0 && inst.lastPrice ? (inst.lastPrice - inst.entry) * inst.qty * (inst.pos > 0 ? 1 : -1) : 0;
  return {
    id: inst.id, name: inst.name, symbol: inst.symbol, interval: inst.interval,
    capital: inst.capital, lev: inst.lev, posPct: inst.posPct, fee: inst.fee,
    allowShort: inst.allowShort, running: inst.running, startedAt: inst.startedAt,
    equity: cur, cash: inst.equity, pnl: cur - inst.capital,
    returnPct: (cur / inst.capital - 1) * 100,
    pos: inst.pos, qty: inst.qty, entry: inst.entry, lastPrice: inst.lastPrice,
    unreal: unreal, liqPx: inst.liqPx, maxDD: inst.maxDD * 100,
    trades: inst.trades.length, winRate: inst.trades.length ? wins.length / inst.trades.length * 100 : null,
    pf: gl > 0 ? gp / gl : null,
    ticks: inst.ticks, signals: inst.signals, lastSignal: inst.lastSignal,
    lastError: inst.lastError, lastBarT: inst.lastBarT,
    ageMs: Date.now() - inst.startedAt,
    code: inst.code,
  };
}

function getState() {
  const s = load();
  return {
    ok: true, updated: s.updated || 0,
    instances: s.instances.map(summary),
  };
}
function getDetail(id) {
  const inst = instById(id);
  if (!inst) return null;
  return {
    ok: true, summary: summary(inst),
    trades: inst.trades.slice(-200).reverse(),
    events: inst.events.slice(-100).reverse(),
    eq: inst.eq.slice(-1200),
  };
}

module.exports = {
  load: load, createInstance: createInstance, removeInstance: removeInstance,
  tickAll: tickAll, getState: getState, getDetail: getDetail, instById: instById,
  setRunning: function (id, run) { const i = instById(id); if (!i) return false; i.running = !!run; save(); return true; },
  closeNow: function (id) { const i = instById(id); if (!i) return false; closePosition(i, i.lastPrice || i.entry, '手动平仓'); save(); return true; },
  reset: function (id) { const i = instById(id); if (!i) return false;
    i.equity = i.capital; i.pos = 0; i.qty = 0; i.liqPx = null; i.trades = []; i.eq = []; i.events = [];
    i.peak = i.capital; i.maxDD = 0; i.ticks = 0; i.signals = 0; i.startedAt = Date.now(); i.running = true;
    save(); return true; },
};
