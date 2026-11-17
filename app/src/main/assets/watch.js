/* Trade Watcher for REAL trades logged in the Journal. It only watches and alerts. It never places or changes orders.
   Put a stop-loss order at your broker right after entry: that is the real protection. Alerts depend on your phone/internet. */
(function (root) {
  const W = {};
  const istMin = (ms) => { const d = new Date(ms + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const f2 = (x) => Number(x).toFixed(2);

  // x = journal trade {opt, entry, sl, t1, t2, inv, lots, createdAt|id, w}; q = {ltp, spot}. Returns {alerts:[{id, level, title, text}]}.
  W.step = function (x, q, now) {
    const w = x.w = x.w || { hist: [], fired: {}, t1: false, log: [] };
    const out = [];
    const fire = (id, level, title, text) => { if (w.fired[id]) return; w.fired[id] = now; out.push({ id, level, title, text }); w.log.push({ t: now, level, title }); };
    if (!(q.ltp > 0) || !(x.entry > 0)) return { alerts: out };
    w.hist.push([now, q.ltp]); w.hist = w.hist.filter((h) => now - h[0] <= 10 * 60000);
    w.ltp = q.ltp; w.at = now; w.spot = q.spot == null ? w.spot : q.spot;
    w.pct = (q.ltp / x.entry - 1) * 100;
    const dir = x.opt === 'CE' ? 1 : -1, age = (now - (x.createdAt || x.id)) / 60000;
    const stop = w.t1 ? x.entry : x.sl;
    if (q.ltp <= stop) {
      if (w.t1) fire('be', 'bad', 'BREAKEVEN STOP HIT', 'Premium is back at your entry (' + f2(x.entry) + ') after Target 1. Exit the rest.');
      else fire('sl', 'bad', 'STOP-LOSS HIT', 'Premium ' + f2(q.ltp) + ' is at or below your SL ' + f2(x.sl) + '. Exit now. Do not average down or move the stop.');
    }
    if (q.spot && x.inv && (dir > 0 ? q.spot < x.inv : q.spot > x.inv)) {
      fire('inv', 'bad', 'EXIT NOW: the index is going against you', 'Index ' + Math.round(q.spot) + ' crossed ' + Math.round(x.inv) + '. The trade idea is broken. Exit without waiting for the premium SL.');
    }
    const recent = w.hist.filter((h) => now - h[0] <= 5 * 60000), peak = Math.max.apply(null, recent.map((h) => h[1]));
    if (!w.t1 && peak > 0 && (peak - q.ltp) / peak >= 0.12) {
      fire('fast', 'warn', 'FAST DROP', 'Premium fell ' + ((peak - q.ltp) / peak * 100).toFixed(0) + '% in 5 minutes (' + f2(peak) + ' to ' + f2(q.ltp) + '). Decide now: exit early, or you are accepting the full SL.');
    }
    if (!w.t1 && x.t1 > 0 && q.ltp >= x.t1) {
      w.t1 = true;
      fire('t1', 'good', 'TARGET 1 REACHED', (x.lots >= 2 ? 'Sell half (whole lots) and move your stop to entry ' + f2(x.entry) + '.' : 'With 1 lot, exit fully (plan).') + ' Premium ' + f2(q.ltp) + '.');
    }
    if (w.t1 && x.t2 > 0 && q.ltp >= x.t2) fire('t2', 'good', 'TARGET 2 REACHED', 'Book the rest. Premium ' + f2(q.ltp) + '.');
    if (!w.t1 && age >= 40 && w.pct < 10) fire('time40', 'warn', 'NO PROGRESS in 40 minutes', 'The trade is only ' + (w.pct >= 0 ? '+' : '') + w.pct.toFixed(0) + '%. Theta is eating the premium. Exit by 45 minutes if nothing changes.');
    if (!w.t1 && age >= 45) fire('time45', 'warn', 'TIME EXIT (45 min)', 'Plan says exit now if neither SL nor Target 1 was hit.');
    if (istMin(now) >= 915) fire('eod', 'warn', 'MARKET CLOSING', 'Close intraday option positions before 3:30 PM.');
    return { alerts: out };
  };

  W.status = function (x, now) {
    const w = x.w; if (!w || !w.ltp) return 'Not checked yet.';
    return 'LTP ' + f2(w.ltp) + ' (' + (w.pct >= 0 ? '+' : '') + w.pct.toFixed(1) + '% vs entry)' + (w.t1 ? ' | T1 done, stop at entry' : '') + ' | checked ' + Math.max(0, Math.round((now - w.at) / 60000)) + ' min ago';
  };

  root.Watch = W;
  if (typeof module !== 'undefined') module.exports = W;
})(typeof window !== 'undefined' ? window : globalThis);
