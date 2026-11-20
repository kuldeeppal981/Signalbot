/* Filter shadow. Every paper trade remembers which extra filters would ALSO have allowed it.
   Later, closed trades are split into "filter would have kept it" and "filter would have blocked it",
   so we can see on REAL option outcomes whether a filter helps. No extra trades, no extra risk.
   Only filters that are stricter than the baseline can be tested this way. */
(function (root) {
  const S = {};
  S.VARIANTS = [
    { key: 'confirm', name: 'Breakout confirm (2 closes outside range)', flags: { confirm: true } },
    { key: 'retest', name: 'Retest of opening range', flags: { retest: true } },
    { key: 'regime', name: 'Sideways filter', flags: { regime: true } },
    { key: 'score5', name: 'Minimum score 5', scoreMin: 5 },
    { key: 'strongC', name: 'Strong breakout candle', flags: { strongC: true } },
    { key: 'reject', name: 'Rejection at EMA20 / range level', flags: { reject: true } },
    { key: 'engulf', name: 'Engulfing near EMA20', flags: { engulf: true } },
    { key: 'oi', name: 'OI does not contradict the signal', oi: true },
  ];
  // inp = the exact input the app gave to E.analyze for this setup; sg = the signal it produced.
  S.evaluate = function (E, inp, sg) {
    const out = {};
    S.VARIANTS.forEach((v) => {
      if (v.oi) return; // OI is judged from the OI record on the trade, not by re-running the strategy
      try {
        const r = E.analyze(Object.assign({}, inp, { flags: Object.assign({}, inp.flags || {}, v.flags || {}) }));
        out[v.key] = !!(!r.noTrade && r.signal && r.signal.option === sg.option && (!v.scoreMin || Math.abs(r.score) >= v.scoreMin));
      } catch (e) { /* leave undefined */ }
    });
    return out;
  };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const se = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)) / Math.sqrt(a.length); };
  const st = (a) => ({ n: a.length, win: a.length ? a.filter((x) => x > 0).length / a.length : null, expR: a.length ? mean(a) : null, se: se(a) });
  S.MIN_TOTAL = 30;
  // trades: paper trades (any tier). Uses closed trades that carry a shadow record.
  S.table = function (trades) {
    const done = trades.filter((t) => t.fs && typeof t.r === 'number' && isFinite(t.r));
    const all = st(done.map((t) => t.r));
    const rows = S.VARIANTS.map((v) => {
      const have = done.filter((t) => t.fs[v.key] !== undefined);
      const kept = st(have.filter((t) => t.fs[v.key]).map((t) => t.r)), blocked = st(have.filter((t) => !t.fs[v.key]).map((t) => t.r));
      let verdict;
      if (have.length < S.MIN_TOTAL) verdict = 'Too few trades (' + have.length + '/' + S.MIN_TOTAL + ').';
      else if (kept.n < 8 || blocked.n < 8) verdict = 'Almost no trades differ (kept ' + kept.n + ', blocked ' + blocked.n + '). Not testable yet.';
      else {
        const d = kept.expR - blocked.expR, e = Math.sqrt((kept.se || 0) ** 2 + (blocked.se || 0) ** 2);
        verdict = Math.abs(d) < 2 * e ? 'Difference is within the error. Not conclusive.' : d > 0 ? 'Kept trades did better, beyond the error. Worth a closer look.' : 'Blocked trades did better. The filter would have hurt.';
      }
      return { key: v.key, name: v.name, kept, blocked, verdict };
    });
    return { n: done.length, all, rows };
  };
  root.FilterShadow = S;
  if (typeof module !== 'undefined') module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
