/* SignalBot rules engine: Nifty / Bank Nifty options BUYING, max 2 signals/day.
   Pure functions, no network. Works in WebView and in node. */
(function (root) {
  const E = {};
  const r05 = (x) => Math.round(x * 20) / 20;
  E.r05 = r05;
  E.ema = function (a, n) {
    const k = 2 / (n + 1);
    let p;
    return a.map((v, i) => (p = i === 0 ? v : v * k + p * (1 - k)));
  };
  E.istMin = (t) => { const d = new Date(t + 19800000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  E.istDate = (t) => new Date(t + 19800000).toISOString().slice(0, 10);
  E.hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  // Upstox candle rows: [timestamp, o, h, l, c, v, oi] (newest first)
  E.parseCandles = (raw) =>
    raw.map((r) => ({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 }))
       .filter((x) => !isNaN(x.t)).sort((a, b) => a.t - b.t);

  // Aggregate 1-minute candles into m-minute candles, closed candles only.
  E.aggregate = function (c, m, nowMs) {
    const g = new Map();
    c.forEach((x) => {
      const k = Math.floor((E.istMin(x.t) - 555) / m);
      const b = g.get(k);
      if (!b) g.set(k, { k, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c });
      else { b.h = Math.max(b.h, x.h); b.l = Math.min(b.l, x.l); b.c = x.c; }
    });
    const nowMin = E.istMin(nowMs);
    return [...g.values()].sort((a, b) => a.k - b.k).filter((b) => 555 + (b.k + 1) * m <= nowMin);
  };

  E.analyze = function (inp) {
    const { symbol, spot, candles, vix, chain, lotSize, nowMs } = inp;
    const signalsToday = inp.signalsToday || 0;
    const maxRiskRs = inp.maxRiskRs || 0;
    const res = { symbol, spot, view: 'Sideways', reason: '', signal: null, noTrade: true, checks: [], notes: [], snap: {} };
    const stop = (why) => { res.noTrade = true; res.signal = null; res.reason = why; return res; };

    if (!candles || !candles.length) return stop('No intraday data for today. The market may be closed.');
    const nm = E.istMin(nowMs);
    const c5 = E.aggregate(candles, 5, nowMs);
    const c15 = E.aggregate(candles, 15, nowMs);
    const orC = candles.filter((x) => { const m = E.istMin(x.t); return m >= 555 && m < 570; });
    const orHigh = orC.length ? Math.max(...orC.map((x) => x.h)) : null;
    const orLow = orC.length ? Math.min(...orC.map((x) => x.l)) : null;
    const dayHigh = Math.max(...candles.map((x) => x.h));
    const dayLow = Math.min(...candles.map((x) => x.l));

    let pcr = null, resistance = null, support = null;
    if (chain && chain.length) {
      const co = chain.reduce((s, r) => s + (r.ceOi || 0), 0);
      const po = chain.reduce((s, r) => s + (r.peOi || 0), 0);
      pcr = co > 0 ? po / co : null;
      const above = chain.filter((r) => r.strike > spot);
      const below = chain.filter((r) => r.strike < spot);
      if (above.length) resistance = above.reduce((a, b) => ((b.ceOi || 0) > (a.ceOi || 0) ? b : a)).strike;
      if (below.length) support = below.reduce((a, b) => ((b.peOi || 0) > (a.peOi || 0) ? b : a)).strike;
    }
    let dte = inp.expiry ? (Date.parse(inp.expiry + 'T15:30:00+05:30') - nowMs) / 86400000 : 7;
    if (isNaN(dte)) dte = 7;
    dte = Math.max(0, dte);
    let atmIv = null;
    if (chain && chain.length) {
      const ar = chain.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
      const ivs = [ar.ceIv, ar.peIv].filter((x) => x > 0);
      if (ivs.length) atmIv = ivs.reduce((a, b) => a + b) / ivs.length;
    }
    Object.assign(res.snap, { orHigh, orLow, dayHigh, dayLow, pcr, resistance, support, vix, atmIv, dte });

    if (c5.length < 8) return stop('Not enough data. Need at least 40 minutes of closed candles (check after 9:55).');
    const closes5 = c5.map((x) => x.c);
    const e9 = E.ema(closes5, 9);
    const e20 = E.ema(closes5, 20);
    const ema9 = e9[e9.length - 1];
    const ema20 = e20[e20.length - 1];
    const closes15 = c15.map((x) => x.c);
    const e15 = closes15.length >= 3 ? E.ema(closes15, 20) : null;
    Object.assign(res.snap, { ema9, ema20 });

    const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const n = closes5.length;
    const mom = closes5[n - 1] > closes5[n - 2] && closes5[n - 2] > closes5[n - 3] ? 1
      : closes5[n - 1] < closes5[n - 2] && closes5[n - 2] < closes5[n - 3] ? -1 : 0;
    const orb = orHigh == null ? 0 : spot > orHigh * 1.0003 ? 1 : spot < orLow * 0.9997 ? -1 : 0;
    const trendEma = sgn(spot - ema20);
    const comps = [
      { name: 'Spot vs 5m EMA20', v: trendEma, t: spot > ema20 ? 'Above' : 'Below' },
      { name: '5m EMA9 vs EMA20', v: sgn(ema9 - ema20), t: ema9 > ema20 ? 'EMA9 above' : 'EMA9 below' },
      { name: 'Opening range (9:15-9:30)', v: orb, t: orb > 0 ? 'Broke high' : orb < 0 ? 'Broke low' : 'Inside range' },
      { name: '15m trend', v: e15 ? sgn(closes15[closes15.length - 1] - e15[e15.length - 1]) : 0, t: e15 ? '15m close vs EMA' : 'Not enough data' },
      { name: 'PCR', v: pcr == null ? 0 : pcr > 1.1 ? 1 : pcr < 0.8 ? -1 : 0, t: pcr == null ? 'NA' : pcr.toFixed(2) },
      { name: 'Momentum (3 candle)', v: mom, t: mom > 0 ? 'Higher closes' : mom < 0 ? 'Lower closes' : 'Mixed' },
    ];
    res.checks = comps;
    const score = comps.reduce((s, c) => s + c.v, 0);
    res.score = score;
    res.view = score >= 2 ? 'Bullish' : score <= -2 ? 'Bearish' : 'Sideways';
    const dir = sgn(score);

    // Gates, in order. First failure = No Trade.
    if (nm < 570) return stop('No signals before 9:30. The opening range is still forming.');
    if (nm > 870) return stop('No new entries after 2:30 PM (theta and reversal risk).');
    if (signalsToday >= 2) return stop('Already 2 signals today. Quality over quantity, try again tomorrow.');
    if (inp.health && inp.health.block) return stop('Data health: ' + inp.health.block + ' Signal blocked.');
    if (inp.openForSymbol) return stop('There is already an open/pending trade on this index. No new signal (no stacking).');
    if (inp.lastLossAgoMin != null && inp.lastLossAgoMin < 15) return stop('Less than 15 minutes since the last loss. Cooling off to avoid revenge trading.');
    if ((inp.consecLosses || 0) >= 2) return stop('2 losses in a row today. Stopping for the day to avoid overtrading.');
    if (maxRiskRs > 0 && (inp.dayPnl || 0) <= -2 * maxRiskRs) return stop('Daily loss limit (2x risk) reached. Trading stopped for today.');
    if (inp.expiry && inp.expiry === E.istDate(nowMs) && nm >= 810) return stop('No fresh buys after 1:30 PM on expiry day. Theta decay is very fast.');
    if (vix != null && vix > 24) return stop('India VIX ' + vix.toFixed(1) + ' is too high. Premiums are expensive and whipsaws are more likely.');
    if (inp.altSpot) {
      res.snap.altSpot = inp.altSpot;
      if (Math.abs(inp.altSpot - spot) / spot > 0.001) {
        return stop('Upstox and Angel One spot prices do not match (' + spot.toFixed(1) + ' vs ' + inp.altSpot.toFixed(1) + '). Data cannot be trusted, No Trade.');
      }
    }
    if (Math.abs(score) < 4 || orb !== dir || trendEma !== dir) {
      return stop('Setup is unclear (score ' + score + '/6). Trend, opening range and EMA do not all agree.');
    }
    const rs = inp.recentSignals || [];
    if (rs.some((x) => x.dir === dir && nowMs - x.t < 30 * 60000)) return stop('A signal in the same direction came in the last 30 min. No duplicates.');
    if (rs.some((x) => x.dir === -dir && nowMs - x.t < 20 * 60000)) return stop('An opposite-direction signal appeared in the last 20 min. Whipsaw risk, wait.');
    // Optional filters (default off until validated by A/B backtest + paper trading).
    const fl = inp.flags || {};
    if (fl.confirm) {
      const l2 = c5.slice(-2);
      const ok = l2.length === 2 && l2.every((x) => (dir > 0 ? x.c > orHigh : x.c < orLow));
      if (!ok) return stop('Breakout not confirmed: the last 2 closed 5-min candles did not close outside the opening range (fake breakout risk).');
    }
    if (fl.regime) {
      const w = closes5.slice(-13);
      let path = 0;
      for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
      const er = path > 0 ? Math.abs(w[w.length - 1] - w[0]) / path : 0;
      res.snap.er = er;
      if (er < (fl.erMin || 0.3)) return stop('Market is choppy/sideways (trend efficiency ' + er.toFixed(2) + '). No clear trend.');
    }
    const extLimit = symbol === 'BANKNIFTY' ? 0.007 : 0.005;
    if (Math.abs(spot - ema20) / spot > extLimit) {
      return stop('Price is too far from EMA20 (extended). Wait for a pullback, do not chase.');
    }
    if (inp.indexOnly) {
      const l3 = c5.slice(-3);
      const inv = dir > 0 ? Math.min(ema20, ...l3.map((x) => x.l)) : Math.max(ema20, ...l3.map((x) => x.h));
      res.noTrade = false; res.reason = 'Index-level setup (score ' + score + '/5).';
      res.signal = { indexOnly: true, option: dir > 0 ? 'CE' : 'PE', dir, spot, invalidation: inv };
      return res;
    }
    if (!chain || !chain.length) return stop('Option chain data not available.');
    const roomLevel = dir > 0 ? resistance : support;
    if (roomLevel != null && Math.abs(roomLevel - spot) / spot < 0.003) {
      return stop((dir > 0 ? 'Resistance ' : 'Support ') + roomLevel + ' is too close. No room for the target.');
    }

    if (dte < 1) {
      const pin = chain.reduce((a, b) => ((b.ceOi || 0) + (b.peOi || 0) > (a.ceOi || 0) + (a.peOi || 0) ? b : a));
      if (Math.abs(pin.strike - spot) / spot < 0.0008) {
        return stop('On expiry, spot is near ' + pin.strike + ' (highest OI). Pin risk: price may get stuck there.');
      }
    }
    const ivh = (inp.ivHistory || []).filter((x) => x > 0);
    if (atmIv != null && ivh.length >= 10) {
      const pct = Math.round((ivh.filter((x) => x < atmIv).length / ivh.length) * 100);
      res.snap.ivPct = pct;
      if (pct >= 90) return stop('ATM IV is at the ' + pct + 'th percentile of its recent history. Premium is expensive and an IV drop can cause losses.');
    }
    // Strike selection: ATM, or 1 strike OTM if ATM risk is above capital limit.
    const strikes = chain.map((r) => r.strike).sort((a, b) => a - b);
    let ai = 0;
    strikes.forEach((s, i) => { if (Math.abs(s - spot) < Math.abs(strikes[ai] - spot)) ai = i; });
    const rowOf = (s) => chain.find((r) => r.strike === s);
    const build = (strike, type) => {
      const r = rowOf(strike);
      if (!r) return null;
      const ltp = dir > 0 ? r.ceLtp : r.peLtp;
      const key = dir > 0 ? r.ceKey : r.peKey;
      if (!ltp || ltp <= 0) return null;
      const delta = dir > 0 ? r.ceDelta : r.peDelta;
      const bid = dir > 0 ? r.ceBid : r.peBid, ask = dir > 0 ? r.ceAsk : r.peAsk;
      const spreadPct = ask > 0 && bid > 0 ? ((ask - bid) / ask) * 100 : null;
      if (delta != null && Math.abs(delta) < (dte <= 1 ? 0.45 : 0.4)) return null; // buyers need real delta
      if (spreadPct != null && spreadPct > 5) return null; // wide spread eats the SL
      const riskPerLot = 0.25 * ltp * lotSize;
      const lots = maxRiskRs > 0 ? Math.floor(maxRiskRs / riskPerLot) : 0;
      return { option: dir > 0 ? 'CE' : 'PE', strike, strikeType: type, key, ltp, riskPerLot, lots, delta: delta == null ? null : Math.abs(delta), spreadPct };
    };
    const atm = build(strikes[ai], 'ATM');
    const otmStrike = dir > 0 ? strikes[ai + 1] : strikes[ai - 1];
    const otm = otmStrike != null ? build(otmStrike, '1 Strike OTM') : null;
    let pick = atm;
    if ((!atm || atm.lots === 0) && otm && otm.lots > 0) pick = otm;
    if (!pick) return stop('No strike passed the filters (low delta, wide spread, or no premium data).');

    const p = pick.ltp;
    const last3 = c5.slice(-3);
    const invalid = dir > 0 ? Math.min(ema20, ...last3.map((x) => x.l)) : Math.max(ema20, ...last3.map((x) => x.h));
    res.noTrade = false;
    res.reason = 'Setup is clear (score ' + score + '/6).';
    res.signal = Object.assign(pick, {
      indexName: symbol === 'BANKNIFTY' ? 'Bank Nifty' : 'Nifty',
      entryLo: r05(p), entryHi: r05(p * 1.02),
      sl: r05(p * 0.75), t1: r05(p * 1.5), t2: r05(p * 1.75),
      rr: '1:2 (T1), 1:3 (T2)',
      lotSize, indexInvalidation: Math.round(invalid),
      validUntil: E.hhmm(Math.min(nm + 30, 885)),
      lotCost: pick.ltp * lotSize,
    });
    if (vix != null && vix > 18) res.notes.push('VIX ' + vix.toFixed(1) + ' is high. Use half size.');
    if (pick.lots === 0 && maxRiskRs > 0) res.notes.push('Not even 1 lot fits your risk limit. For information only, do not take this trade.');
    res.notes.push('If the index closes ' + (dir > 0 ? 'below' : 'above') + ' ' + Math.round(invalid) + ', exit without waiting for the premium SL.');
    res.notes.push('If there is no move or T1 within 45 minutes, exit (theta).');
    res.notes.push('Book half the profit at T1 and move the stop-loss to entry for the rest.');
    return res;
  };

  // Expiry-day "zero to hero": cheap far-OTM lottery. High risk, separate from normal signals.
  E.zeroHero = function (inp) {
    const { spot, candles, chain, lotSize, nowMs, expiry } = inp;
    const budget = inp.budget || 0, doneToday = inp.doneToday || 0;
    const res = { noTrade: true, reason: '', signal: null };
    const stop = (w) => { res.reason = w; return res; };
    if (!expiry || expiry !== E.istDate(nowMs)) return stop('Not an expiry day. Zero-Hero is for expiry day only.');
    const nm = E.istMin(nowMs);
    if (nm < 780 || nm > 885) return stop('Zero-Hero window is 1:00 to 2:45 PM. Outside it right now.');
    if (doneToday >= 1) return stop('Today\'s one Zero-Hero trade is already done. Only one per day.');
    if (!candles || !candles.length || !chain || !chain.length) return stop('No data available.');
    const c5 = E.aggregate(candles, 5, nowMs);
    if (c5.length < 20) return stop('Not enough data.');
    const closes = c5.map((x) => x.c), n = closes.length;
    const e9 = E.ema(closes, 9), e20 = E.ema(closes, 20);
    const ema9 = e9[n - 1], ema20 = e20[n - 1];
    const dayHigh = Math.max(...candles.map((x) => x.h)), dayLow = Math.min(...candles.map((x) => x.l));
    const move = (closes[n - 1] - closes[n - 4]) / spot;
    let dir = 0;
    if (spot > ema20 && ema9 > ema20 && spot >= dayHigh * (1 - 0.0007) && move >= 0.002) dir = 1;
    else if (spot < ema20 && ema9 < ema20 && spot <= dayLow * (1 + 0.0007) && move <= -0.002) dir = -1;
    if (!dir) return stop('No strong momentum at the day high/low. The lottery needs a breakout; not now.');
    const strikes = chain.map((r) => r.strike).sort((a, b) => a - b);
    let ai = 0;
    strikes.forEach((k, i) => { if (Math.abs(k - spot) < Math.abs(strikes[ai] - spot)) ai = i; });
    let best = null;
    for (let k = 2; k <= 7; k++) {
      const st = strikes[ai + dir * k];
      const row = st == null ? null : chain.find((r) => r.strike === st);
      if (!row) continue;
      const ltp = dir > 0 ? row.ceLtp : row.peLtp, delta = dir > 0 ? row.ceDelta : row.peDelta;
      if (!ltp || ltp < 4 || ltp > 25) continue;
      if (delta != null && (Math.abs(delta) < 0.03 || Math.abs(delta) > 0.30)) continue;
      if (!best || Math.abs(ltp - 10) < Math.abs(best.ltp - 10)) best = { strike: st, ltp, key: dir > 0 ? row.ceKey : row.peKey, steps: k };
    }
    if (!best) return stop('No suitable lottery strike found (premium between Rs 4 and Rs 25).');
    const costLot = best.ltp * lotSize, lots = Math.floor(budget / costLot);
    if (lots < 1) return stop('Budget Rs ' + Math.round(budget) + ' cannot buy 1 lot (Rs ' + Math.round(costLot) + '). Increase the budget or skip.');
    res.noTrade = false;
    res.reason = 'Expiry momentum breakout.';
    res.signal = Object.assign(best, {
      option: dir > 0 ? 'CE' : 'PE', indexName: inp.symbol === 'BANKNIFTY' ? 'Bank Nifty' : 'Nifty',
      entryLo: r05(best.ltp), entryHi: r05(best.ltp * 1.1), sl: r05(best.ltp * 0.5), t1: r05(best.ltp * 2), t2: r05(best.ltp * 4),
      lots, lotSize, maxLoss: lots * costLot, validUntil: E.hhmm(Math.min(nm + 15, 900)), expiry,
    });
    return res;
  };

  root.SignalEngine = E;
  if (typeof module !== 'undefined') module.exports = E;
})(typeof window !== 'undefined' ? window : globalThis);
