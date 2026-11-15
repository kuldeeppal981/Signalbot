/* Live chart: 5-minute candles for the trading day (9:15-15:30 fixed x-scale), EMA9/EMA20,
   opening range, signal markers with invalidation line, paper-trade fill/exit markers.
   Model building is pure (testable in node); draw() only needs a 2D canvas context. */
(function (root) {
  const L = {};
  const E = () => root.SignalEngine || require('./engine.js');
  const SLOTS = 75; // 9:15..15:30 in 5-minute slots
  const C = { up: '#3DDC97', dn: '#FF6B6B', ema9: '#58A6FF', ema20: '#F2B84B', grid: '#262D36', mut: '#8B949E', tx: '#E6EDF3' };

  // 1-minute candles -> 5-minute candles, including the still-forming one.
  L.agg5 = function (c1, nowMs) {
    const e = E(), g = new Map();
    c1.forEach((x) => {
      const k = Math.floor((e.istMin(x.t) - 555) / 5);
      if (k < 0 || k >= SLOTS) return;
      const b = g.get(k);
      if (!b) g.set(k, { k, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c });
      else { b.h = Math.max(b.h, x.h); b.l = Math.min(b.l, x.l); b.c = x.c; }
    });
    const nowMin = e.istMin(nowMs);
    return [...g.values()].sort((a, b) => a.k - b.k).map((b) => Object.assign(b, { forming: 555 + (b.k + 1) * 5 > nowMin }));
  };
  const slotOf = (t) => Math.floor((E().istMin(t) - 555) / 5);

  // signals: [{tMs, option, dir, strike, entryLo, entryHi, sl, t1, t2, spot, inv, src}]
  // trades:  [{fillAt, closedAt, exitWhy, netPnl, fillSpot, exitSpot}]
  L.model = function (c1, nowMs, signals, trades, ltp) {
    const e = E(), bars = L.agg5(c1, nowMs);
    const lb = bars[bars.length - 1];
    if (ltp > 0 && lb && lb.forming) { lb.c = ltp; lb.h = Math.max(lb.h, ltp); lb.l = Math.min(lb.l, ltp); } // live price into the forming candle
    const closes = bars.map((b) => b.c);
    const ema9 = e.ema(closes, 9), ema20 = e.ema(closes, 20);
    const first15 = c1.filter((x) => { const m = e.istMin(x.t); return m >= 555 && m < 570; });
    const orDone = e.istMin(nowMs) >= 570;
    const or = first15.length && orDone ? { hi: Math.max(...first15.map((x) => x.h)), lo: Math.min(...first15.map((x) => x.l)) } : null;
    const priceAt = (t) => { const k = slotOf(t); const b = bars.find((x) => x.k === k); return b ? b.c : null; };
    const marks = [];
    (signals || []).forEach((s) => {
      const k = slotOf(s.tMs);
      if (k < 0 || k >= SLOTS) return;
      marks.push({ type: 'signal', k, price: s.spot != null ? s.spot : priceAt(s.tMs), dir: s.dir, label: s.option + ' ' + s.strike, sig: s });
    });
    (trades || []).forEach((t) => {
      if (t.fillAt) { const k = slotOf(t.fillAt), p = t.fillSpot != null ? t.fillSpot : priceAt(t.fillAt); if (p != null && k >= 0 && k < SLOTS) marks.push({ type: 'fill', k, price: p }); }
      if (t.closedAt) { const k = slotOf(t.closedAt), p = t.exitSpot != null ? t.exitSpot : priceAt(t.closedAt); if (p != null && k >= 0 && k < SLOTS) marks.push({ type: 'exit', k, price: p, win: t.netPnl > 0, why: t.exitWhy }); }
    });
    return { bars, ema9, ema20, or, marks, last: bars.length ? bars[bars.length - 1].c : null, nowMs };
  };

  L.draw = function (cv, m, opt) {
    opt = opt || {};
    const dpr = opt.dpr || 1, W = Math.round((opt.w || 340) * dpr), H = Math.round((opt.h || 320) * dpr);
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const padR = 54 * dpr, padB = 20 * dpr, padT = 8 * dpr, pw = W - padR, ph = H - padB - padT;
    const sigs = m.marks.filter((x) => x.type === 'signal');
    let lo = Infinity, hi = -Infinity;
    m.bars.forEach((b) => { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); });
    if (m.or) { lo = Math.min(lo, m.or.lo); hi = Math.max(hi, m.or.hi); }
    sigs.forEach((s) => { if (s.sig.inv) { lo = Math.min(lo, s.sig.inv); hi = Math.max(hi, s.sig.inv); } });
    if (!isFinite(lo)) { g.fillStyle = C.mut; g.font = (13 * dpr) + 'px system-ui'; g.fillText('Data nahi', 12 * dpr, 24 * dpr); return null; }
    const padP = (hi - lo) * 0.06 || 1; lo -= padP; hi += padP;
    const X = (k) => (k + 0.5) * pw / SLOTS, Y = (p) => padT + (hi - p) / (hi - lo) * ph, bw = Math.max(1, pw / SLOTS * 0.7);
    g.font = (10 * dpr) + 'px system-ui'; g.textBaseline = 'middle';
    // grid + price axis
    const step = niceStep((hi - lo) / 5);
    for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
      g.strokeStyle = C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(p)); g.lineTo(pw, Y(p)); g.stroke();
      g.fillStyle = C.mut; g.textAlign = 'left'; g.fillText(String(Math.round(p)), pw + 4 * dpr, Y(p));
    }
    // time axis (every hour)
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    for (let k = 0; k < SLOTS; k += 12) { g.fillStyle = C.mut; g.fillText(String(9 + Math.floor((15 + k * 5) / 60)) + ':' + String((15 + k * 5) % 60).padStart(2, '0'), X(k), H - 5 * dpr); }
    g.textBaseline = 'middle';
    // opening range
    if (m.or) {
      g.setLineDash([4 * dpr, 4 * dpr]); g.strokeStyle = '#6e7681'; g.lineWidth = 1;
      [m.or.hi, m.or.lo].forEach((p) => { g.beginPath(); g.moveTo(X(3), Y(p)); g.lineTo(pw, Y(p)); g.stroke(); });
      g.setLineDash([]); g.fillStyle = '#6e7681'; g.textAlign = 'left'; g.fillText('OR', 4 * dpr, Y(m.or.hi) - 7 * dpr);
    }
    // candles
    m.bars.forEach((b) => {
      const col = b.c >= b.o ? C.up : C.dn, x = X(b.k);
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(1, dpr);
      g.beginPath(); g.moveTo(x, Y(b.h)); g.lineTo(x, Y(b.l)); g.stroke();
      const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
      g.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    });
    // EMAs
    [[m.ema9, C.ema9], [m.ema20, C.ema20]].forEach(([arr, col]) => {
      g.strokeStyle = col; g.lineWidth = 1.5 * dpr; g.beginPath();
      m.bars.forEach((b, i) => { const x = X(b.k), y = Y(arr[i]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
      g.stroke();
    });
    // last price line
    if (m.last != null) {
      g.setLineDash([2 * dpr, 3 * dpr]); g.strokeStyle = C.tx; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(m.last)); g.lineTo(pw, Y(m.last)); g.stroke(); g.setLineDash([]);
      g.fillStyle = C.tx; g.fillRect(pw, Y(m.last) - 7 * dpr, padR, 14 * dpr);
      g.fillStyle = '#0E1116'; g.textAlign = 'left'; g.fillText(m.last.toFixed(1), pw + 3 * dpr, Y(m.last));
    }
    // markers
    m.marks.forEach((mk) => {
      const x = X(mk.k), y = Y(mk.price), s = 7 * dpr;
      if (mk.type === 'signal') {
        const col = mk.dir > 0 ? C.up : C.dn, ty = mk.dir > 0 ? y + 4 * dpr : y - 4 * dpr, dirv = mk.dir > 0 ? 1 : -1;
        if (mk.sig.inv) {
          g.setLineDash([5 * dpr, 3 * dpr]); g.strokeStyle = C.dn; g.lineWidth = 1; g.beginPath(); g.moveTo(x, Y(mk.sig.inv)); g.lineTo(pw, Y(mk.sig.inv)); g.stroke(); g.setLineDash([]);
          g.fillStyle = C.dn; g.textAlign = 'right'; g.fillText('index SL ' + Math.round(mk.sig.inv), pw - 4 * dpr, Y(mk.sig.inv) + (dirv > 0 ? 9 : -9) * dpr);
        }
        g.fillStyle = col; g.beginPath(); g.moveTo(x, ty); g.lineTo(x - s, ty + dirv * s * 1.6); g.lineTo(x + s, ty + dirv * s * 1.6); g.closePath(); g.fill();
        g.textAlign = x > pw * 0.7 ? 'right' : 'left'; g.fillStyle = col; g.font = 'bold ' + (11 * dpr) + 'px system-ui';
        g.fillText(mk.label, x + (x > pw * 0.7 ? -s : s), ty + dirv * s * 2.4);
        g.font = (10 * dpr) + 'px system-ui';
      } else {
        g.fillStyle = mk.type === 'fill' ? C.ema9 : (mk.win ? C.up : C.dn); g.strokeStyle = '#0E1116'; g.lineWidth = dpr;
        g.beginPath(); g.arc(x, y, 4 * dpr, 0, Math.PI * 2); g.fill(); g.stroke();
      }
    });
    return { pw, W, H, dpr, X, Y, SLOTS };
  };
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  L.slotAtX = (lay, x) => (lay ? Math.max(0, Math.min(lay.SLOTS - 1, Math.floor(x * lay.dpr / lay.pw * lay.SLOTS))) : 0);
  L.SLOTS = SLOTS;
  root.LiveChart = L;
  if (typeof module !== 'undefined') module.exports = L;
})(typeof window !== 'undefined' ? window : globalThis);
