/* Index-level backtest in R units. Option premium/OI/IV history is not available, so this tests the
   trend + opening-range core only. Costs are NOT included (see paper trading for real fills + charges). */
(function (root) {
  const BT = {};
  const E = () => root.SignalEngine;
  const A = () => root.Analytics;

  // candles: ascending 1-min candles of ONE day. Returns trades in R.
  BT.simulateDay = function (candles, opts) {
    opts = Object.assign({ rr: 2, timeStopMin: 45, minRiskPct: 0.0012, maxSignals: 2, stride: 1, slipPts: 0, symbol: 'NIFTY' }, opts || {});
    const e = E(), out = [];
    let signals = 0, dayR = 0, consec = 0, lastLossT = null, nextIdx = 0, recent = [];
    for (let i = 0; i < candles.length - 1; i += 1) {
      if (i < nextIdx) continue;
      if (opts.stride > 1 && i % opts.stride) continue;
      const nowMs = candles[i].t + 60000, nm = e.istMin(nowMs);
      if (nm < 570) continue;
      if (nm > 870) break;
      if (signals >= opts.maxSignals) break;
      const res = e.analyze({
        symbol: opts.symbol, spot: candles[i].c, candles: candles.slice(0, i + 1), vix: null, chain: [], lotSize: 1,
        nowMs, signalsToday: signals, indexOnly: true, maxRiskRs: 1, dayPnl: dayR, consecLosses: consec,
        lastLossAgoMin: lastLossT == null ? null : (nowMs - lastLossT) / 60000, recentSignals: recent, flags: opts.flags,
      });
      if (res.noTrade || !res.signal) continue;
      const sg = res.signal, dir = sg.dir;
      const entryBar = candles[i + 1];
      const entry = entryBar.o + dir * opts.slipPts;
      const risk = Math.max(Math.abs(entry - sg.invalidation), entry * opts.minRiskPct);
      const stop = entry - dir * risk, target = entry + dir * opts.rr * risk;
      const t0 = entryBar.t;
      let exit = null, why = null, j = i + 1;
      for (; j < candles.length; j++) {
        const b = candles[j];
        const hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
        const hitTgt = dir > 0 ? b.h >= target : b.l <= target;
        if (hitStop) { exit = stop; why = 'SL'; break; } // same-bar tie counts as stop (conservative)
        if (hitTgt) { exit = target; why = 'TARGET'; break; }
        const closeT = b.t + 60000;
        if (closeT - t0 >= opts.timeStopMin * 60000) { exit = b.c; why = 'TIME'; break; }
        if (e.istMin(closeT) >= 915) { exit = b.c; why = 'EOD'; break; }
      }
      if (exit == null) { j = candles.length - 1; exit = candles[j].c; why = 'EOD'; }
      const r = ((exit - entry) * dir) / risk;
      out.push({ date: e.istDate(entryBar.t), t: entryBar.t, hour: Math.floor(e.istMin(entryBar.t) / 60), dir, option: dir > 0 ? 'CE' : 'PE',
        entry, stop, target, exit, why, r, risk, bars: j - i });
      signals++; dayR += r; recent.push({ dir, t: nowMs });
      if (r < 0) { consec++; lastLossT = candles[j].t + 60000; } else consec = 0;
      nextIdx = j + 1;
    }
    return out;
  };

  // days: array of ascending candle arrays (one per day)
  BT.run = function (days, opts) {
    const trades = [];
    days.forEach((d) => trades.push(...BT.simulateDay(d, opts)));
    return BT.summarize(trades, opts);
  };

  BT.summarize = function (trades, opts) {
    const rr = (opts && opts.rr) || 2;
    const st = A().stats(trades.map((t) => ({ r: t.r })));
    const by = (f) => { const m = {}; trades.forEach((t) => { const k = f(t); (m[k] = m[k] || []).push({ r: t.r }); }); const o = {}; Object.keys(m).forEach((k) => (o[k] = A().stats(m[k]))); return o; };
    return {
      trades, stats: st, rr, breakevenWinRate: 1 / (1 + rr),
      ci: st.n ? A().winRateCI(st.winRate, st.n) : null,
      byDir: by((t) => t.option), byHour: by((t) => t.hour), byWhy: by((t) => t.why),
      equity: trades.reduce((a, t) => { a.push((a.length ? a[a.length - 1] : 0) + t.r); return a; }, []),
    };
  };

  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / Math.max(1, a.length - 1)); };
  BT.VARIANTS = [
    { name: 'Baseline', flags: {} },
    { name: '+ Breakout confirm', flags: { confirm: true } },
    { name: '+ Sideways filter', flags: { regime: true } },
    { name: 'Dono filter', flags: { confirm: true, regime: true } },
  ];
  // Compare variants on the same days. First `split` fraction of days = in-sample, rest = out-of-sample.
  BT.compare = async function (days, opts, split, tick) {
    const cut = Math.max(1, Math.floor(days.length * (split || 0.7)));
    const rows = [];
    for (const v of BT.VARIANTS) {
      const tin = [], tout = [];
      for (let i = 0; i < days.length; i++) {
        (i < cut ? tin : tout).push(...BT.simulateDay(days[i], Object.assign({}, opts, { flags: v.flags })));
        if (tick && i % 4 === 0) await tick(v.name, i + 1, days.length);
      }
      const f = (t) => { const st = A().stats(t.map((x) => ({ r: x.r }))); st.se = t.length > 1 ? sd(t.map((x) => x.r)) / Math.sqrt(t.length) : null; return st; };
      rows.push({ name: v.name, flags: v.flags, inS: f(tin), outS: f(tout) });
    }
    const base = rows[0];
    // Verdict must beat noise: out-of-sample expectancy has to be > 2 standard errors above zero,
    // and better than baseline in BOTH halves. (3 variants are tried, so the bar is stricter than 1.65.)
    rows.forEach((r, i) => {
      if (!i) { r.verdict = 'Reference'; return; }
      const z = r.outS.se ? r.outS.expR / r.outS.se : 0;
      r.z = z;
      if (r.outS.n < 25) r.verdict = 'Out-of-sample sample kam (' + r.outS.n + '). Pakka nahi.';
      else if (r.inS.expR > base.inS.expR && r.outS.expR > base.outS.expR && z >= 2) r.verdict = 'Dono hisson mein behtar aur noise se upar. Rakhne layak.';
      else if (r.inS.expR > base.inS.expR && r.outS.expR > base.outS.expR) r.verdict = 'Behtar dikh raha hai, par ±error ke andar (noise ho sakta hai). Pakka nahi, aur data chahiye.';
      else if (r.inS.expR > base.inS.expR) r.verdict = 'Sirf purane data mein behtar. Overfit ka shak, mat lagao.';
      else r.verdict = 'Baseline se behtar nahi.';
    });
    return { rows, cut, nDays: days.length };
  };

  // Deterministic random-walk days (no edge by construction) to sanity-check the machinery.
  BT.randomDays = function (nDays, seed, volPerMin) {
    let a = seed >>> 0;
    const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const days = []; let px = 24000;
    for (let d = 0; d < nDays; d++) {
      const base = Date.parse('2026-01-05T09:15:00+05:30') + d * 86400000, c = [];
      for (let i = 0; i < 375; i++) {
        const o = px; let h = o, l = o, cl = o;
        for (let k = 0; k < 4; k++) { cl += gauss() * volPerMin * px / 2; h = Math.max(h, cl); l = Math.min(l, cl); }
        px = cl;
        c.push({ t: base + i * 60000, o, h, l, c: cl, v: 0 });
      }
      days.push(c);
    }
    return days;
  };

  root.Backtest = BT;
  if (typeof module !== 'undefined') module.exports = BT;
})(typeof window !== 'undefined' ? window : globalThis);
