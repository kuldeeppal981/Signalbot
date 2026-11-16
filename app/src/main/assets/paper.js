/* Paper trading state machine. States: PENDING -> OPEN -> PARTIAL -> CLOSED, or PENDING -> MISSED.
   Fills at ask (or ltp + slippage), exits at bid (or ltp - slippage). Charges via Analytics. */
(function (root) {
  const P = {};
  const SLIP_PCT = 0.3; // fallback slippage when no bid/ask is available
  const E = () => root.SignalEngine, A = () => root.Analytics;
  P.ACTIVE = ['PENDING', 'OPEN', 'PARTIAL'];

  P.create = function (sig, meta, nowMs) {
    const e = E();
    const validUntilMs = Date.parse(e.istDate(nowMs) + 'T' + sig.validUntil + ':00+05:30');
    return {
      id: nowMs, date: e.istDate(nowMs), sym: meta.sym, idxName: sig.indexName, option: sig.option, strike: sig.strike, key: sig.key,
      dir: sig.option === 'CE' ? 1 : -1, lots: Math.max(1, sig.lots || 1), lotSize: sig.lotSize, qty: Math.max(1, sig.lots || 1) * sig.lotSize,
      signalPrice: sig.ltp, entryLo: sig.entryLo, entryHi: sig.entryHi, sl: sig.sl, t1: sig.t1, t2: sig.t2,
      invalidation: sig.indexInvalidation, state: 'PENDING', createdAt: nowMs, validUntilMs, fillPrice: null, fillAt: null,
      slCur: sig.sl, qtyOpen: 0, legs: [], log: [{ t: nowMs, m: 'Signal created, waiting for entry' }],
    };
  };

  const note = (t, now, m) => t.log.push({ t: now, m });
  const sell = (t, qty, price, now, why) => { t.legs.push({ qty, price, t: now, why }); t.qtyOpen -= qty; note(t, now, why + ' ' + qty + ' @ ' + price.toFixed(2)); };

  function finish(t, now, why, cfg) {
    t.state = 'CLOSED'; t.closedAt = now; t.exitWhy = why;
    const gross = t.legs.reduce((s, l) => s + (l.price - t.fillPrice) * l.qty, 0);
    const ts = t.legs.reduce((s, l) => s + l.price * l.qty, 0);
    const ch = A().charges({ tb: t.fillPrice * t.qty, ts, orders: 1 + t.legs.length }, cfg);
    t.grossPnl = gross; t.charges = ch; t.netPnl = gross - ch.total;
    const riskPer = t.fillPrice - t.sl > 0 ? t.fillPrice - t.sl : t.fillPrice * 0.25;
    t.r = t.netPnl / (riskPer * t.qty);
    t.slippage = t.fillPrice - t.signalPrice;
  }

  // q = { ltp, bid, ask, spot }. Returns a list of event strings.
  P.onQuote = function (t, q, now, cfg) {
    const ev = [], e = E();
    if (!P.ACTIVE.includes(t.state) || !(q.ltp > 0)) return ev;
    const nm = e.istMin(now);
    const exitPx = (q.bid > 0 ? Math.min(q.bid, q.ltp) : q.ltp * (1 - SLIP_PCT / 100));
    if (t.state === 'PENDING') {
      if (now > t.validUntilMs) { t.state = 'MISSED'; note(t, now, 'Validity expired, entry missed'); ev.push('MISSED'); return ev; }
      if (q.ltp <= t.sl) { t.state = 'MISSED'; note(t, now, 'Fell to the SL before entry'); ev.push('MISSED'); return ev; }
      if (q.ltp > t.entryHi * 1.05) { t.state = 'MISSED'; note(t, now, 'Price ran away, not chasing'); ev.push('MISSED'); return ev; }
      if (q.ltp <= t.entryHi) {
        t.fillPrice = q.ask > 0 ? Math.max(q.ask, q.ltp) : q.ltp * (1 + SLIP_PCT / 100);
        t.fillAt = now; t.state = 'OPEN'; t.qtyOpen = t.qty; t.slCur = t.sl;
        note(t, now, 'FILL @ ' + t.fillPrice.toFixed(2) + ' (signal ' + t.signalPrice.toFixed(2) + ')');
        ev.push('FILLED');
      }
      return ev;
    }
    // OPEN or PARTIAL
    if (q.spot && t.invalidation && (t.dir > 0 ? q.spot < t.invalidation : q.spot > t.invalidation)) {
      sell(t, t.qtyOpen, exitPx, now, 'INDEX-EXIT'); finish(t, now, 'INDEX', cfg); ev.push('CLOSED'); return ev;
    }
    if (q.ltp <= t.slCur) {
      sell(t, t.qtyOpen, exitPx, now, t.state === 'PARTIAL' ? 'BE-STOP' : 'SL'); finish(t, now, t.state === 'PARTIAL' ? 'BE' : 'SL', cfg); ev.push('CLOSED'); return ev;
    }
    if (t.state === 'OPEN' && q.ltp >= t.t1) {
      if (t.lots >= 2) {
        const half = Math.floor(t.lots / 2) * t.lotSize;
        sell(t, half, exitPx, now, 'T1'); t.state = 'PARTIAL'; t.slCur = t.fillPrice; ev.push('T1');
      } else { sell(t, t.qtyOpen, exitPx, now, 'T1'); finish(t, now, 'T1', cfg); ev.push('CLOSED'); }
      return ev;
    }
    if (t.state === 'PARTIAL' && q.ltp >= t.t2) { sell(t, t.qtyOpen, exitPx, now, 'T2'); finish(t, now, 'T2', cfg); ev.push('CLOSED'); return ev; }
    if (t.state === 'OPEN' && now - t.fillAt >= 45 * 60000) { sell(t, t.qtyOpen, exitPx, now, 'TIME'); finish(t, now, 'TIME', cfg); ev.push('CLOSED'); return ev; }
    if (nm >= 915) { sell(t, t.qtyOpen, exitPx, now, 'EOD'); finish(t, now, 'EOD', cfg); ev.push('CLOSED'); return ev; }
    return ev;
  };

  // Execution validation summary over closed trades.
  P.execution = function (closed) {
    const n = closed.length;
    if (!n) return { n: 0 };
    const sum = (f) => closed.reduce((s, t) => s + f(t), 0);
    const slipPct = closed.map((t) => (t.slippage / t.signalPrice) * 100);
    return {
      n, avgSlipPct: slipPct.reduce((a, b) => a + b, 0) / n, worstSlipPct: Math.max(...slipPct),
      gross: sum((t) => t.grossPnl), charges: sum((t) => t.charges.total), net: sum((t) => t.netPnl),
      chargesPctOfGross: sum((t) => t.grossPnl) > 0 ? (sum((t) => t.charges.total) / sum((t) => t.grossPnl)) * 100 : null,
    };
  };

  root.Paper = P;
  if (typeof module !== 'undefined') module.exports = P;
})(typeof window !== 'undefined' ? window : globalThis);
