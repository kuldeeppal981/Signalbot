/* Analytics: trade statistics, option charges, market-data health. Pure functions. */
(function (root) {
  const A = {};

  // Approximate NSE options charges. Rates change: verify with your broker's charge calculator.
  A.defaultCharges = { brokerage: 20, sttPct: 0.15, txnPct: 0.03503, sebiPct: 0.0001, stampPct: 0.003, gstPct: 18 };
  A.charges = function (x, c) {
    c = Object.assign({}, A.defaultCharges, c || {});
    const brokerage = c.brokerage * (x.orders || 2);
    const stt = (x.ts * c.sttPct) / 100;
    const txn = ((x.tb + x.ts) * c.txnPct) / 100;
    const sebi = ((x.tb + x.ts) * c.sebiPct) / 100;
    const stamp = (x.tb * c.stampPct) / 100;
    const gst = ((brokerage + txn + sebi) * c.gstPct) / 100;
    const total = brokerage + stt + txn + sebi + stamp + gst;
    return { brokerage, stt, txn, sebi, stamp, gst, total };
  };

  // list items: { r: R multiple, pnl: net Rs (optional) }
  A.stats = function (list) {
    const o = { n: list.length, wins: 0, losses: 0, winRate: null, avgR: null, avgWinR: null, avgLossR: null,
      profitFactor: null, expR: null, totalR: 0, totalPnl: 0, maxDDR: 0, maxDDPnl: 0, maxLossStreak: 0 };
    if (!o.n) return o;
    let gw = 0, gl = 0, cumR = 0, peakR = 0, cumP = 0, peakP = 0, streak = 0;
    list.forEach((t) => {
      const r = t.r || 0, p = t.pnl || 0;
      if (r > 0) { o.wins++; gw += r; streak = 0; } else if (r < 0) { o.losses++; gl += -r; streak++; o.maxLossStreak = Math.max(o.maxLossStreak, streak); }
      cumR += r; cumP += p;
      peakR = Math.max(peakR, cumR); peakP = Math.max(peakP, cumP);
      o.maxDDR = Math.max(o.maxDDR, peakR - cumR);
      o.maxDDPnl = Math.max(o.maxDDPnl, peakP - cumP);
    });
    o.totalR = cumR; o.totalPnl = cumP;
    o.winRate = o.wins / o.n;
    o.avgR = cumR / o.n; o.expR = o.avgR;
    o.avgWinR = o.wins ? gw / o.wins : 0;
    o.avgLossR = o.losses ? -gl / o.losses : 0;
    o.profitFactor = gl > 0 ? gw / gl : null; // null = no losses
    return o;
  };

  // 95% Wilson-ish half width for win rate (normal approx) so small samples look small.
  A.winRateCI = (p, n) => (n > 0 ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 1);

  /* Market data health. Input: candles (asc 1-min, today), nowMs, spot, chainSpot, altSpot, vix, chain */
  A.health = function (inp) {
    const E = root.SignalEngine;
    const issues = [], m = {};
    let block = null;
    const bad = (t) => { issues.push({ level: 'bad', text: t }); if (!block) block = t; };
    const warn = (t) => issues.push({ level: 'warn', text: t });
    const nm = E.istMin(inp.nowMs);
    const c = inp.candles || [];
    if (!c.length) { bad('No candles for today.'); return { ok: false, block, issues, metrics: m }; }
    const lastT = c[c.length - 1].t;
    m.lastCandleAgeMin = Math.max(0, (inp.nowMs - (lastT + 60000)) / 60000);
    if (nm >= 560 && nm <= 935) {
      if (m.lastCandleAgeMin > 3) bad('Data is stale: last candle is ' + m.lastCandleAgeMin.toFixed(1) + ' min old.');
      else if (m.lastCandleAgeMin > 2) warn('Data slightly delayed: ' + m.lastCandleAgeMin.toFixed(1) + ' min.');
    }
    let missing = 0, missingRecent = 0;
    for (let i = 1; i < c.length; i++) {
      const g = Math.round((c[i].t - c[i - 1].t) / 60000) - 1;
      if (g > 0) { missing += g; if (inp.nowMs - c[i].t < 30 * 60000) missingRecent += g; }
    }
    m.missing = missing; m.missingRecent = missingRecent;
    if (missingRecent >= 3) bad(missingRecent + ' candles missing in the last 30 min.');
    else if (missing > 5) warn(missing + ' candles missing today.');
    const lastClose = c[c.length - 1].c;
    if (inp.spot) {
      m.spotVsCandle = Math.abs(inp.spot - lastClose) / inp.spot;
      if (m.spotVsCandle > 0.003) bad('Spot differs from last candle close by ' + (m.spotVsCandle * 100).toFixed(2) + '%.');
      else if (m.spotVsCandle > 0.0015) warn('Spot differs from candle close by ' + (m.spotVsCandle * 100).toFixed(2) + '%.');
    }
    if (inp.chainSpot && inp.spot) {
      m.chainVsSpot = Math.abs(inp.chainSpot - inp.spot) / inp.spot;
      if (m.chainVsSpot > 0.002) bad('Option chain spot looks stale (' + (m.chainVsSpot * 100).toFixed(2) + '% difference).');
    }
    if (inp.altSpot && inp.spot) {
      m.brokerDiff = Math.abs(inp.altSpot - inp.spot) / inp.spot;
      if (m.brokerDiff > 0.001) bad('Upstox and Angel spot prices do not match (' + (m.brokerDiff * 100).toFixed(2) + '%).');
      else if (m.brokerDiff > 0.0005) warn('Small spot difference between brokers (' + (m.brokerDiff * 100).toFixed(2) + '%).');
    }
    if (inp.vix == null) warn('India VIX not available.');
    if (inp.chain && inp.chain.length && inp.spot) {
      const near = inp.chain.filter((r) => Math.abs(r.strike - inp.spot) / inp.spot < 0.01);
      const zero = near.filter((r) => !(r.ceLtp > 0) || !(r.peLtp > 0)).length;
      m.zeroLtp = zero;
      if (near.length && zero / near.length > 0.4) warn('Several nearby strikes have LTP 0 (illiquid or a data issue).');
    }
    return { ok: !block, block, issues, metrics: m };
  };

  root.Analytics = A;
  if (typeof module !== 'undefined') module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
