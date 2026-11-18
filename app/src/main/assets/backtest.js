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
    // 5-minute closes and EMA9, each known only AFTER its candle completes (no look-ahead). Used by the trail exit.
    let c5 = null;
    if (opts.trail) {
      c5 = []; let cur = null, ema = null;
      candles.forEach((b) => {
        const m = e.istMin(b.t), bs = Math.floor(m / 5) * 5;
        if (!cur || cur.bs !== bs) { if (cur) { ema = ema == null ? cur.c : ema + (cur.c - ema) * 2 / 10; c5.push({ done: cur.bs * 1 + 5, c: cur.c, ema }); } cur = { bs, c: b.c }; } else cur.c = b.c;
      });
    }
    let signals = 0, dayR = 0, consec = 0, lastLossT = null, nextIdx = 0, recent = [];
    for (let i = 0; i < candles.length - 1; i += 1) {
      if (i < nextIdx) continue;
      if (opts.stride > 1 && i % opts.stride) continue;
      const nowMs = candles[i].t + 60000, nm = e.istMin(nowMs);
      if (nm < Math.max(570, opts.startMin || 0)) continue; // startMin: test later start times (e.g. 615 = 10:15)
      if (nm > (opts.cutoffMin || 870)) break;
      if (signals >= opts.maxSignals) break;
      const res = e.analyze({
        symbol: opts.symbol, spot: candles[i].c, candles: candles.slice(0, i + 1), vix: null, chain: [], lotSize: 1,
        nowMs, signalsToday: signals, maxSignals: opts.maxSignals, cutoffMin: opts.cutoffMin, indexOnly: true, maxRiskRs: 1, dayPnl: dayR, consecLosses: consec,
        lastLossAgoMin: lastLossT == null ? null : (nowMs - lastLossT) / 60000, recentSignals: recent, flags: opts.flags, prevAgg: opts.prevAgg,
      });
      if (res.noTrade || !res.signal) continue;
      const sg = res.signal, dir = sg.dir;
      const entryBar = candles[i + 1];
      const entry = entryBar.o + dir * opts.slipPts;
      const risk = Math.max(Math.abs(entry - sg.invalidation), entry * opts.minRiskPct);
      const stop = entry - dir * risk, target = entry + dir * opts.rr * risk;
      const t0 = entryBar.t;
      let exit = null, why = null, j = i + 1, curStop = stop, trailing = false;
      for (; j < candles.length; j++) {
        const b = candles[j];
        const hitStop = dir > 0 ? b.l <= curStop : b.h >= curStop;
        const hitTgt = !opts.trail && (dir > 0 ? b.h >= target : b.l <= target);
        if (hitStop) { exit = curStop; why = trailing ? 'TRAIL' : 'SL'; break; } // same-bar tie counts as stop (conservative)
        if (hitTgt) { exit = target; why = 'TARGET'; break; }
        if (opts.trail) {
          // after +1R the stop moves to entry; then exit when a completed 5-min candle closes beyond EMA9 against the trade
          if (!trailing && (dir > 0 ? b.h >= entry + risk : b.l <= entry - risk)) { trailing = true; curStop = entry; }
          if (trailing) {
            const nmj = e.istMin(b.t + 60000);
            let k = -1; for (let q = c5.length - 1; q >= 0; q--) { if (c5[q].done <= nmj) { k = q; break; } }
            if (k >= 0 && (dir > 0 ? c5[k].c < c5[k].ema : c5[k].c > c5[k].ema) && nmj % 5 === 0) { exit = b.c; why = 'TRAIL'; break; }
          }
        }
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
  // Warm-up: the first `warm` days are used only to initialise EMAs for the next days; trades come from the rest.
  BT.prevAggs = function (days, W) {
    return days.map((_, i) => (W > 0 && i >= W ? E().prevAgg([].concat(...days.slice(i - W, i))) : null));
  };
  BT.run = function (days, opts) {
    const W = (opts && opts.warm) || 0, pa = BT.prevAggs(days, W), trades = [];
    for (let i = W; i < days.length; i++) trades.push(...BT.simulateDay(days[i], Object.assign({}, opts, { prevAgg: pa[i] })));
    return BT.summarize(trades, opts);
  };

  BT.summarize = function (trades, opts) {
    const rr = (opts && opts.rr) || 2;
    const st = A().stats(trades.map((t) => ({ r: t.r })));
    const se = trades.length > 1 ? sd(trades.map((t) => t.r)) / Math.sqrt(trades.length) : null;
    // Realised break-even win rate from the actual average win / loss (not the theoretical 1/(1+RR)).
    const beReal = st.n && st.avgWinR > 0 && st.avgLossR < 0 ? -st.avgLossR / (st.avgWinR - st.avgLossR) : null;
    const by = (f) => { const m = {}; trades.forEach((t) => { const k = f(t); (m[k] = m[k] || []).push({ r: t.r }); }); const o = {}; Object.keys(m).forEach((k) => (o[k] = A().stats(m[k]))); return o; };
    return {
      trades, stats: st, rr, breakevenWinRate: 1 / (1 + rr), beReal, se, z: se ? st.expR / se : null,
      ci: st.n ? A().winRateCI(st.winRate, st.n) : null,
      byDir: by((t) => t.option), byHour: by((t) => t.hour), byWhy: by((t) => t.why),
      equity: trades.reduce((a, t) => { a.push((a.length ? a[a.length - 1] : 0) + t.r); return a; }, []),
    };
  };

  // Money view: converts index-level R results into rupees for a given capital.
  // Assumptions (stated in the UI): ATM premium = premPct of the index level, option stop-loss = 25% of premium,
  // so 1R = one stop-loss = 0.25 x lot cost. Real option P&L will differ (theta, spread, delta).
  // If the risk budget does not fit even 1 lot but 1 lot is affordable, 1 lot is taken (flagged as "forced").
  BT.inr = function (trades, o) {
    const cap = o.capital, slPct = o.slPct || 0.25, premPct = o.premPct || 0.0045, lot = o.lotSize;
    const maxRisk = cap * (o.riskPct || 2) / 100;
    const out = { capital: cap, maxRisk, lotSize: lot, taken: 0, skipped: 0, forced: 0, gross: 0, charges: 0, net: 0, equity: [], used: [], best: null, worst: null, maxDD: 0, riskTaken: [] };
    let eq = 0, peak = 0, premSum = 0, premN = 0;
    trades.forEach((t) => {
      const premium = t.entry * premPct, lotCost = premium * lot, rpl = slPct * lotCost;
      premSum += premium; premN++;
      let lots = Math.floor(maxRisk / rpl), forced = false;
      if (lots < 1) { if (lotCost <= cap) { lots = 1; forced = true; } else { out.skipped++; return; } }
      lots = Math.min(lots, Math.floor(cap / lotCost));
      if (lots < 1) { out.skipped++; return; }
      const used = lots * lotCost, gross = t.r * lots * rpl;
      const chg = o.charges ? o.charges(used, Math.max(0, used + gross)) : 0, net = gross - chg;
      out.taken++; if (forced) out.forced++;
      out.gross += gross; out.charges += chg; out.net += net; out.used.push(used); out.riskTaken.push(lots * rpl);
      eq += net; peak = Math.max(peak, eq); out.maxDD = Math.max(out.maxDD, peak - eq);
      out.equity.push(eq);
      if (out.best == null || net > out.best) out.best = net;
      if (out.worst == null || net < out.worst) out.worst = net;
    });
    out.premium = premN ? premSum / premN : 0; out.lotCost = out.premium * lot;
    out.avgUsed = out.used.length ? out.used.reduce((a, b) => a + b, 0) / out.used.length : 0;
    out.peakUsed = out.used.length ? Math.max(...out.used) : 0;
    out.avgRisk = out.riskTaken.length ? out.riskTaken.reduce((a, b) => a + b, 0) / out.riskTaken.length : 0;
    out.retPct = cap > 0 ? out.net / cap * 100 : 0;
    out.avgNet = out.taken ? out.net / out.taken : 0;
    out.maxDDPct = cap > 0 ? out.maxDD / cap * 100 : 0;
    return out;
  };

  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / Math.max(1, a.length - 1)); };
  BT.VARIANTS = [
    { name: 'Baseline', flags: {} },
    { name: '+ Breakout confirm', flags: { confirm: true } },
    { name: '+ Sideways filter', flags: { regime: true } },
    { name: 'Both filters', flags: { confirm: true, regime: true } },
    { name: '+ Retest of opening range', flags: { retest: true } },
    { name: 'Minimum score 5', flags: { minScore: 5 } },
    { name: 'Start at 10:15 (not 9:30)', flags: {}, sim: { startMin: 615 } },
    { name: 'EMA9 trail after +1R (45 min)', flags: {}, sim: { trail: true } },
    { name: 'EMA9 trail after +1R (90 min)', flags: {}, sim: { trail: true, timeStopMin: 90 } },
    { name: '+ Strong breakout candle', flags: { strongC: true } },
    { name: '+ Rejection at EMA20 / range level', flags: { reject: true } },
    { name: '+ Engulfing near EMA20', flags: { engulf: true } },
    { name: 'Entry cutoff 3:00 PM', flags: {}, sim: { cutoffMin: 900 } },
    { name: 'Entry cutoff 2:00 PM', flags: {}, sim: { cutoffMin: 840 } },
    { name: 'Daily cap 3 signals', flags: {}, sim: { maxSignals: 3 } },
    { name: 'Daily cap 5 signals', flags: {}, sim: { maxSignals: 5 } },
  ];
  // Ablation: neutralise one droppable factor (EMA9/20, 15m trend, momentum) with the min score lowered by 1.
  BT.ABLATION = [
    { name: 'Baseline (5 index factors, min score 4)', flags: {} },
    { name: 'All factors, min score 3 (control)', flags: { minScore: 3 } },
    { name: 'Without EMA9/EMA20 alignment (min 3)', flags: { drop: 'ema9', minScore: 3 } },
    { name: 'Without 15m trend (min 3)', flags: { drop: 'trend15', minScore: 3 } },
    { name: 'Without 3-candle momentum (min 3)', flags: { drop: 'mom', minScore: 3 } },
  ];
  // Compare variants on the same days. First `split` fraction of days = in-sample, rest = out-of-sample.
  BT.compare = async function (days, opts, split, tick) {
    const W = (opts && opts.warm) || 0, pa = BT.prevAggs(days, W), nd = days.length - W;
    const cut = Math.max(1, Math.floor(nd * (split || 0.7)));
    const rows = [];
    for (const v of BT.VARIANTS) {
      const tin = [], tout = [];
      for (let i = 0; i < nd; i++) {
        (i < cut ? tin : tout).push(...BT.simulateDay(days[W + i], Object.assign({}, opts, v.sim || {}, { flags: v.flags, prevAgg: pa[W + i] })));
        if (tick && i % 4 === 0) await tick(v.name, i + 1, nd);
      }
      const f = (t) => { const st = A().stats(t.map((x) => ({ r: x.r }))); st.se = t.length > 1 ? sd(t.map((x) => x.r)) / Math.sqrt(t.length) : null; return st; };
      rows.push({ name: v.name, flags: v.flags, sim: v.sim, inS: f(tin), outS: f(tout) });
    }
    const base = rows[0];
    // Verdict must beat noise: out-of-sample expectancy has to be > 2 standard errors above zero,
    // and better than baseline in BOTH halves. (3 variants are tried, so the bar is stricter than 1.65.)
    const zBar = rows.length > 6 ? 2.5 : 2; // many variants are tried, so the bar is stricter (more chances to get lucky)
    rows.forEach((r, i) => {
      if (!i) { r.verdict = 'Reference'; return; }
      const z = r.outS.se ? r.outS.expR / r.outS.se : 0;
      r.z = z;
      if (r.outS.n < 25) r.verdict = 'Out-of-sample sample is small (' + r.outS.n + '). Not conclusive.';
      else if (r.inS.expR > base.inS.expR && r.outS.expR > base.outS.expR && z >= zBar) r.verdict = 'Better in both halves and above the noise. Worth keeping.';
      else if (r.inS.expR > base.inS.expR && r.outS.expR > base.outS.expR) r.verdict = 'Looks better, but within the ±error (could be noise). Not conclusive, needs more data.';
      else if (r.inS.expR > base.inS.expR) r.verdict = 'Better only on the older data. Likely overfit, do not use.';
      else r.verdict = 'Not better than the baseline.';
    });
    return { rows, cut, nDays: nd };
  };

  // Which factors matter? Full-sample stats per variant, with the difference vs baseline and its noise level.
  BT.ablation = async function (days, opts, tick) {
    const W = (opts && opts.warm) || 0, pa = BT.prevAggs(days, W), nd = days.length - W, rows = [];
    for (const v of BT.ABLATION) {
      const tr = [];
      for (let i = 0; i < nd; i++) {
        tr.push(...BT.simulateDay(days[W + i], Object.assign({}, opts, { flags: v.flags, prevAgg: pa[W + i] })));
        if (tick && i % 4 === 0) await tick(v.name, i + 1, nd);
      }
      const st = A().stats(tr.map((x) => ({ r: x.r })));
      st.se = tr.length > 1 ? sd(tr.map((x) => x.r)) / Math.sqrt(tr.length) : null;
      rows.push({ name: v.name, flags: v.flags, st });
    }
    const b = rows[0].st;
    rows.forEach((r, i) => {
      if (!i) { r.note = 'Reference'; return; }
      if (!r.st.n || !b.n || r.st.se == null || b.se == null) { r.note = 'Not enough trades to compare.'; return; }
      const d = r.st.expR - b.expR, noise = Math.sqrt(r.st.se * r.st.se + b.se * b.se);
      r.delta = d; r.noise = noise;
      r.note = Math.abs(d) < 2 * noise ? 'Within noise of the baseline: this change makes no provable difference.' : (d > 0 ? 'Clearly better than the baseline.' : 'Clearly worse than the baseline: this factor helps.');
    });
    return { rows, nDays: nd };
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
