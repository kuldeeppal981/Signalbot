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

    if (!candles || !candles.length) return stop('Aaj ka intraday data nahi mila. Market band ho sakta hai.');
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

    if (c5.length < 8) return stop('Data kam hai. Kam se kam 40 minute ke closed candles chahiye (9:55 ke baad dekho).');
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
      { name: 'Spot vs 5m EMA20', v: trendEma, t: spot > ema20 ? 'Upar' : 'Neeche' },
      { name: '5m EMA9 vs EMA20', v: sgn(ema9 - ema20), t: ema9 > ema20 ? 'EMA9 upar' : 'EMA9 neeche' },
      { name: 'Opening range (9:15-9:30)', v: orb, t: orb > 0 ? 'High todi' : orb < 0 ? 'Low todi' : 'Range ke andar' },
      { name: '15m trend', v: e15 ? sgn(closes15[closes15.length - 1] - e15[e15.length - 1]) : 0, t: e15 ? '15m close vs EMA' : 'Data kam' },
      { name: 'PCR', v: pcr == null ? 0 : pcr > 1.1 ? 1 : pcr < 0.8 ? -1 : 0, t: pcr == null ? 'NA' : pcr.toFixed(2) },
      { name: 'Momentum (3 candle)', v: mom, t: mom > 0 ? 'Higher closes' : mom < 0 ? 'Lower closes' : 'Mixed' },
    ];
    res.checks = comps;
    const score = comps.reduce((s, c) => s + c.v, 0);
    res.score = score;
    res.view = score >= 2 ? 'Bullish' : score <= -2 ? 'Bearish' : 'Sideways';
    const dir = sgn(score);

    // Gates, in order. First failure = No Trade.
    if (nm < 570) return stop('9:30 se pehle signal nahi. Opening range abhi ban rahi hai.');
    if (nm > 870) return stop('2:30 PM ke baad naya entry nahi. Theta aur reversal ka risk.');
    if (signalsToday >= 2) return stop('Aaj ke 2 signals ho chuke. Quality over quantity, ab kal.');
    if (inp.lastLossAgoMin != null && inp.lastLossAgoMin < 15) return stop('Pichle loss ko 15 minute nahi hue. Cooldown, revenge trade se bacho.');
    if ((inp.consecLosses || 0) >= 2) return stop('Aaj lagataar 2 loss hue. Overtrading se bacho, aaj ke liye bas.');
    if (maxRiskRs > 0 && (inp.dayPnl || 0) <= -2 * maxRiskRs) return stop('Aaj ka loss limit (2x risk) hit ho gaya. Ab trade band.');
    if (inp.expiry && inp.expiry === E.istDate(nowMs) && nm >= 810) return stop('Expiry day 1:30 PM ke baad fresh buy nahi. Theta bahut tez hai.');
    if (vix != null && vix > 24) return stop('India VIX ' + vix.toFixed(1) + ' bahut high. Premium mehenga aur whipsaw zyada.');
    if (inp.altSpot) {
      res.snap.altSpot = inp.altSpot;
      if (Math.abs(inp.altSpot - spot) / spot > 0.001) {
        return stop('Upstox aur Angel One ka spot match nahi (' + spot.toFixed(1) + ' vs ' + inp.altSpot.toFixed(1) + '). Data pe bharosa nahi, No Trade.');
      }
    }
    if (Math.abs(score) < 4 || orb !== dir || trendEma !== dir) {
      return stop('Setup clear nahi (score ' + score + '/6). Trend, opening range aur EMA teeno ek taraf nahi.');
    }
    const extLimit = symbol === 'BANKNIFTY' ? 0.007 : 0.005;
    if (Math.abs(spot - ema20) / spot > extLimit) {
      return stop('Price EMA20 se bahut door hai (extended). Pullback ka wait karo, chase mat karo.');
    }
    if (!chain || !chain.length) return stop('Option chain data nahi mila.');
    const roomLevel = dir > 0 ? resistance : support;
    if (roomLevel != null && Math.abs(roomLevel - spot) / spot < 0.003) {
      return stop((dir > 0 ? 'Resistance ' : 'Support ') + roomLevel + ' bahut paas hai. Target ke liye jagah nahi.');
    }

    if (dte < 1) {
      const pin = chain.reduce((a, b) => ((b.ceOi || 0) + (b.peOi || 0) > (a.ceOi || 0) + (a.peOi || 0) ? b : a));
      if (Math.abs(pin.strike - spot) / spot < 0.0008) {
        return stop('Expiry par spot ' + pin.strike + ' ke paas (sabse zyada OI). Pin risk, price wahin atak sakta hai.');
      }
    }
    const ivh = (inp.ivHistory || []).filter((x) => x > 0);
    if (atmIv != null && ivh.length >= 10) {
      const pct = Math.round((ivh.filter((x) => x < atmIv).length / ivh.length) * 100);
      res.snap.ivPct = pct;
      if (pct >= 90) return stop('ATM IV apne recent history ke ' + pct + ' percentile par hai. Premium mehenga, IV girne par loss ho sakta hai.');
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
    if (!pick) return stop('Strike filter pass nahi hua (delta kam, spread chauda, ya premium data nahi).');

    const p = pick.ltp;
    const last3 = c5.slice(-3);
    const invalid = dir > 0 ? Math.min(ema20, ...last3.map((x) => x.l)) : Math.max(ema20, ...last3.map((x) => x.h));
    res.noTrade = false;
    res.reason = 'Setup clear hai (score ' + score + '/6).';
    res.signal = Object.assign(pick, {
      indexName: symbol === 'BANKNIFTY' ? 'Bank Nifty' : 'Nifty',
      entryLo: r05(p), entryHi: r05(p * 1.02),
      sl: r05(p * 0.75), t1: r05(p * 1.5), t2: r05(p * 1.75),
      rr: '1:2 (T1), 1:3 (T2)',
      lotSize, indexInvalidation: Math.round(invalid),
      validUntil: E.hhmm(Math.min(nm + 30, 885)),
      lotCost: pick.ltp * lotSize,
    });
    if (vix != null && vix > 18) res.notes.push('VIX ' + vix.toFixed(1) + ' high hai. Size aadha rakho.');
    if (pick.lots === 0 && maxRiskRs > 0) res.notes.push('Aapke risk limit mein 1 lot bhi fit nahi. Sirf dekhne ke liye, trade mat lo.');
    res.notes.push('Index ' + (dir > 0 ? 'neeche' : 'upar') + ' ' + Math.round(invalid) + ' close kare to premium SL ka wait mat karo, nikal jao.');
    res.notes.push('45 minute mein T1 ya move nahi mila to exit karo (theta).');
    res.notes.push('T1 pe aadha profit book karo, baaki ka SL entry pe laa do.');
    return res;
  };

  // Expiry-day "zero to hero": cheap far-OTM lottery. High risk, separate from normal signals.
  E.zeroHero = function (inp) {
    const { spot, candles, chain, lotSize, nowMs, expiry } = inp;
    const budget = inp.budget || 0, doneToday = inp.doneToday || 0;
    const res = { noTrade: true, reason: '', signal: null };
    const stop = (w) => { res.reason = w; return res; };
    if (!expiry || expiry !== E.istDate(nowMs)) return stop('Aaj expiry nahi hai. Zero-Hero sirf expiry din ke liye.');
    const nm = E.istMin(nowMs);
    if (nm < 780 || nm > 885) return stop('Zero-Hero window 1:00 se 2:45 PM hai. Abhi bahar hai.');
    if (doneToday >= 1) return stop('Aaj ka 1 Zero-Hero trade ho chuka. Din mein sirf ek.');
    if (!candles || !candles.length || !chain || !chain.length) return stop('Data nahi mila.');
    const c5 = E.aggregate(candles, 5, nowMs);
    if (c5.length < 20) return stop('Data kam hai.');
    const closes = c5.map((x) => x.c), n = closes.length;
    const e9 = E.ema(closes, 9), e20 = E.ema(closes, 20);
    const ema9 = e9[n - 1], ema20 = e20[n - 1];
    const dayHigh = Math.max(...candles.map((x) => x.h)), dayLow = Math.min(...candles.map((x) => x.l));
    const move = (closes[n - 1] - closes[n - 4]) / spot;
    let dir = 0;
    if (spot > ema20 && ema9 > ema20 && spot >= dayHigh * (1 - 0.0007) && move >= 0.002) dir = 1;
    else if (spot < ema20 && ema9 < ema20 && spot <= dayLow * (1 + 0.0007) && move <= -0.002) dir = -1;
    if (!dir) return stop('Din ke high/low par tez momentum nahi hai. Lottery ke liye breakout chahiye, abhi nahi.');
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
    if (!best) return stop('Sahi lottery strike nahi mila (premium Rs 4 se 25 ke beech).');
    const costLot = best.ltp * lotSize, lots = Math.floor(budget / costLot);
    if (lots < 1) return stop('Budget Rs ' + Math.round(budget) + ' mein 1 lot (Rs ' + Math.round(costLot) + ') nahi aata. Budget badhao ya skip karo.');
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
