/* ============================================================
 * strat-core.js —— 策略引擎（浏览器与 Node 共用同一份代码）
 *
 * 为什么必须共用：回测和实盘模拟如果各用一套指标实现，
 * 两边结果对不上就毫无意义。所以指标、信号求值、回测全在这里，
 * 前端 index.html 用 <script> 引入，后端 require 同一文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StratCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;
  var vm = null;
  if (isNode) { try { vm = require('vm'); } catch (e) { vm = null; } }

  // ---------- 指标（原始序列）----------
  function sma(a, n) {
    var o = new Array(a.length).fill(null), s = 0;
    for (var i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function emaSeries(a, n) {
    var o = new Array(a.length).fill(null), k = 2 / (n + 1), p = null;
    for (var i = 0; i < a.length; i++) { p = p === null ? a[i] : a[i] * k + p * (1 - k); if (i >= n - 1) o[i] = p; }
    return o;
  }
  function rsiSeries(a, n) {
    var o = new Array(a.length).fill(null), ag = 0, al = 0;
    for (var i = 1; i < a.length; i++) {
      var d = a[i] - a[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (i <= n) { ag += g; al += l; if (i === n) { ag /= n; al /= n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
      else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    }
    return o;
  }
  function atrSeries(c, n) {
    var o = new Array(c.length).fill(null), tr = [];
    for (var i = 0; i < c.length; i++) {
      var k = c[i], pc = i > 0 ? c[i - 1].c : k.c;
      tr.push(Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc)));
    }
    var s = 0;
    for (var j = 0; j < c.length; j++) {
      if (j < n) { s += tr[j]; if (j === n - 1) o[j] = s / n; }
      else o[j] = (o[j - 1] * (n - 1) + tr[j]) / n;
    }
    return o;
  }
  function bollSeries(a, n, k) {
    var mid = sma(a, n), up = new Array(a.length).fill(null), lo = new Array(a.length).fill(null);
    for (var i = 0; i < a.length; i++) {
      if (mid[i] === null) continue;
      var s = 0;
      for (var j = i - n + 1; j <= i; j++) s += (a[j] - mid[i]) * (a[j] - mid[i]);
      var sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
    }
    return { mid: mid, up: up, low: lo };
  }
  function macdSeries(a, f, s, g) {
    var ef = emaSeries(a, f), es = emaSeries(a, s);
    var dif = new Array(a.length).fill(null);
    for (var i = 0; i < a.length; i++) if (ef[i] !== null && es[i] !== null) dif[i] = ef[i] - es[i];
    var dea = emaSeries(dif.map(function (x) { return x === null ? 0 : x; }), g);
    var hist = new Array(a.length).fill(null);
    for (var j = 0; j < a.length; j++) if (dif[j] !== null && dea[j] !== null) hist[j] = dif[j] - dea[j];
    return { dif: dif, dea: dea, hist: hist };
  }
  function hhvSeries(a, n) {
    var o = new Array(a.length).fill(null);
    for (var i = n - 1; i < a.length; i++) { var m = -Infinity; for (var k = i - n + 1; k <= i; k++) if (a[k] > m) m = a[k]; o[i] = m; }
    return o;
  }
  function llvSeries(a, n) {
    var o = new Array(a.length).fill(null);
    for (var i = n - 1; i < a.length; i++) { var m = Infinity; for (var k = i - n + 1; k <= i; k++) if (a[k] < m) m = a[k]; o[i] = m; }
    return o;
  }

  // ---------- 求值上下文：把指标包装成策略里用的 MA/RSI/... ----------
  function makeCtx(candles) {
    var closes = candles.map(function (k) { return k.c; });
    var vols = candles.map(function (k) { return k.v; });
    var st = { i: 0 };
    var c1 = {}, cB = {}, cM = {};
    function ser(kind, n) {
      var key = kind + n;
      if (c1[key]) return c1[key];
      var v = kind === 'ma' ? sma(closes, n)
        : kind === 'vma' ? sma(vols, n)
        : kind === 'ema' ? emaSeries(closes, n)
        : kind === 'rsi' ? rsiSeries(closes, n)
        : kind === 'atr' ? atrSeries(candles, n)
        : kind === 'hhv' ? hhvSeries(closes, n)
        : llvSeries(closes, n);
      c1[key] = v; return v;
    }
    function S(arr) {
      return {
        get v() { return arr[st.i]; },
        get p() { return arr[st.i - 1]; },
        at: function (o) { return arr[st.i - (o || 0)]; },
      };
    }
    var ctx = {
      st: st,
      MA: function (n) { return S(ser('ma', n)); },
      VMA: function (n) { return S(ser('vma', n)); },
      EMA: function (n) { return S(ser('ema', n)); },
      RSI: function (n) { return S(ser('rsi', n)); },
      ATR: function (n) { return S(ser('atr', n)); },
      highest: function (n) { return S(ser('hhv', n)); },
      lowest: function (n) { return S(ser('llv', n)); },
      BOLL: function (n, k) {
        var key = n + '_' + k;
        if (!cB[key]) cB[key] = bollSeries(closes, n, k);
        var b = cB[key]; return { mid: S(b.mid), up: S(b.up), low: S(b.low) };
      },
      MACD: function (f, s, g) {
        var key = f + '_' + s + '_' + g;
        if (!cM[key]) cM[key] = macdSeries(closes, f, s, g);
        var m = cM[key]; return { dif: S(m.dif), dea: S(m.dea), hist: S(m.hist) };
      },
      crossover: function (x, y) { return x.p !== null && y.p !== null && x.v !== null && y.v !== null && x.p <= y.p && x.v > y.v; },
      crossunder: function (x, y) { return x.p !== null && y.p !== null && x.v !== null && y.v !== null && x.p >= y.p && x.v < y.v; },
      price: S(closes), volume: S(vols), closes: closes,
    };
    return ctx;
  }

  // ---------- 编译策略代码 ----------
  // 浏览器里用 Function；Node 里放进 vm 沙箱并加超时（策略代码可能来自远端分享）
  var ARGS = ['MA', 'VMA', 'EMA', 'RSI', 'ATR', 'MACD', 'BOLL', 'crossover', 'crossunder',
    'highest', 'lowest', 'price', 'volume', 'POS', 'i', 'ENTRY', 'BARS'];
  function compile(code) {
    if (isNode && vm) {
      var ctx = vm.createContext(Object.create(null));
      vm.runInContext('__fn = function(' + ARGS.join(',') + '){\n' + code + '\n}', ctx, { timeout: 2000 });
      return vm.runInContext('__fn', ctx);
    }
    return Function.apply(null, ARGS.concat([code]));
  }

  function callFn(fn, ctx, pos, entry, bars) {
    ctx.st.i = ctx.st.i; // noop，保持显式
    return fn(ctx.MA, ctx.VMA, ctx.EMA, ctx.RSI, ctx.ATR, ctx.MACD, ctx.BOLL,
      ctx.crossover, ctx.crossunder, ctx.highest, ctx.lowest, ctx.price, ctx.volume,
      pos, ctx.st.i, entry, bars);
  }

  // 在指定下标求信号；返回 -1 / 0 / 1
  function signalAt(candles, code, i, pos, entry, bars, allowShort) {
    var fn = compile(code);
    var ctx = makeCtx(candles);
    ctx.st.i = i;
    var t = Math.round(Number(callFn(fn, ctx, pos || 0, entry || 0, bars || 0)) || 0);
    if (t > 1) t = 1; if (t < -1) t = -1;
    if (allowShort === false && t < 0) t = 0;
    return t;
  }

  // ---------- 回测 ----------
  // 与实盘共用同一 makeCtx / compile，保证口径一致
  // opts: { capital, lev, fee, posPct, allowShort, warm, slippage, fixed }
  function backtest(candles, code, opts) {
    opts = opts || {};
    var fn = compile(code);
    var ctx = makeCtx(candles);
    var closes = ctx.closes;
    var capital = opts.capital || 10000;
    var lev = opts.lev || 1;
    var fee = opts.fee === undefined ? 0.0005 : opts.fee;
    var posPct = opts.posPct === undefined ? 1 : opts.posPct;
    var allowShort = opts.allowShort !== false;
    var warm = opts.warm || 30;
    var slip = opts.slippage || 0;

    var trades = [], marks = [], eq = [];
    var pos = 0, qty = 0, entry = 0, entryIdx = 0, entryFee = 0, liqPx = null;
    var equity = capital, peak = capital, maxDD = 0, liquidated = false, errMsg = null;
    var fixedNotional = opts.fixed ? capital * lev * posPct : null;

    // 时序必须与实盘一致：第 i 根只能看到「已收盘」的 i-1 根及其之前的数据，
    // 用 i-1 求信号，在 i 的价格成交。
    // （早期版本用的是含第 i 根收盘价的指标 + 第 i 根价格成交 = 轻度未来函数，
    //   会让回测结果系统性偏乐观、与实盘对不上。已修正。）
    for (var i = warm; i < candles.length; i++) {
      ctx.st.i = i - 1;
      var target;
      try {
        target = callFn(fn, ctx, pos, pos !== 0 ? entry : 0, pos !== 0 ? (i - 1 - entryIdx) : 0);
      } catch (e) { errMsg = '第 ' + i + ' 根执行出错：' + e.message; break; }
      target = Math.round(Number(target) || 0);
      if (target > 1) target = 1; if (target < -1) target = -1;
      if (!allowShort && target < 0) target = 0;

      var bar = candles[i], px = bar.c;
      // 爆仓
      if (pos !== 0 && liqPx !== null && ((pos > 0 && bar.l <= liqPx) || (pos < 0 && bar.h >= liqPx))) {
        var g = (liqPx - entry) * qty * (pos > 0 ? 1 : -1), f2 = qty * liqPx * fee;
        equity += g - f2;
        if (equity < 0) equity = 0;
        trades.push({ openT: candles[entryIdx].t, closeT: bar.t, side: pos, entry: entry, exit: liqPx, qty: qty, pnl: g - f2 - entryFee, reason: '爆仓', openIdx: entryIdx, closeIdx: i });
        marks.push({ i: i, kind: 'liq' });
        eq.push({ t: bar.t, e: equity });
        pos = 0; qty = 0; liqPx = null;
        if (equity < capital * 0.01) { liquidated = true; break; }
        continue;
      }
      if (target !== pos) {
        if (pos !== 0) {
          var fill = px * (1 - slip * pos);
          var gg = (fill - entry) * qty * (pos > 0 ? 1 : -1), f3 = qty * fill * fee;
          equity += gg - f3;
          trades.push({ openT: candles[entryIdx].t, closeT: bar.t, side: pos, entry: entry, exit: fill, qty: qty, pnl: gg - f3 - entryFee, reason: '信号', openIdx: entryIdx, closeIdx: i });
          marks.push({ i: i, kind: pos > 0 ? 'sell' : 'cover' });
          pos = 0; qty = 0; liqPx = null;
        }
        if (target !== 0) {
          var fill2 = px * (1 + slip * target);
          pos = target; entry = fill2; entryIdx = i;
          var notional = fixedNotional !== null ? fixedNotional : (equity * lev * posPct);
          if (notional <= 0) { pos = 0; }
          else {
            qty = notional / fill2; entryFee = notional * fee; equity -= entryFee;
            liqPx = pos > 0 ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
            marks.push({ i: i, kind: pos > 0 ? 'buy' : 'short' });
          }
        }
      }
      var unreal = pos !== 0 ? (px - entry) * qty * (pos > 0 ? 1 : -1) : 0;
      var cur = equity + unreal;
      if (cur > peak) peak = cur;
      if (peak > 0) { var dd = (peak - cur) / peak; if (dd > maxDD) maxDD = dd; }
      eq.push({ t: bar.t, e: cur });
    }
    if (pos !== 0) {
      var lb = candles[candles.length - 1];
      var g4 = (lb.c - entry) * qty * (pos > 0 ? 1 : -1), f4 = qty * lb.c * fee;
      equity += g4 - f4;
      trades.push({ openT: candles[entryIdx].t, closeT: lb.t, side: pos, entry: entry, exit: lb.c, qty: qty, pnl: g4 - f4 - entryFee, reason: '收盘平仓', openIdx: entryIdx, closeIdx: candles.length - 1 });
      marks.push({ i: candles.length - 1, kind: pos > 0 ? 'sell' : 'cover' });
      pos = 0;
    }
    var wins = trades.filter(function (t) { return t.pnl > 0; });
    var losses = trades.filter(function (t) { return t.pnl <= 0; });
    var gp = wins.reduce(function (s, t) { return s + t.pnl; }, 0);
    var gl = Math.abs(losses.reduce(function (s, t) { return s + t.pnl; }, 0));
    return {
      capital: capital, lev: lev, fee: fee, posPct: posPct, allowShort: allowShort,
      finalEquity: equity, liquidated: liquidated, errMsg: errMsg,
      returnPct: equity / capital * 100 - 100,
      winRate: trades.length ? wins.length / trades.length * 100 : null,
      pf: gl > 0 ? gp / gl : null, maxDD: maxDD * 100,
      trades: trades.length, buyHold: closes[warm] ? (closes[closes.length - 1] / closes[warm] - 1) * 100 : null,
      avgWin: wins.length ? gp / wins.length : 0, avgLoss: losses.length ? gl / losses.length : 0,
      tradeList: trades, marks: marks, eq: eq,
    };
  }

  return {
    sma: sma, emaSeries: emaSeries, rsiSeries: rsiSeries, atrSeries: atrSeries,
    bollSeries: bollSeries, macdSeries: macdSeries, hhvSeries: hhvSeries, llvSeries: llvSeries,
    makeCtx: makeCtx, compile: compile, signalAt: signalAt, backtest: backtest,
  };
});
