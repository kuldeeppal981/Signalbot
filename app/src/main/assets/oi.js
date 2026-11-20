/* Option Chain OI Intelligence. A CONFIRMATION layer only: it never creates a signal and, in shadow mode,
   never changes or blocks one. Pure functions, no DOM, no network. All thresholds are in OI.DEFAULTS
   and can be overridden with cfg.oiCfg.
   Change in OI / premium needs a reference point. Two are supported, never a single bare snapshot:
   (1) an earlier timestamped snapshot of the same expiry (preferred, "snapshot" basis), or
   (2) the broker's own previous-day OI and previous close ("day" basis).
   With neither, buildup is reported as UNKNOWN and does not score. */
(function (root) {
  const OI = {};
  OI.DEFAULTS = {
    atmWindow: 6,        // strikes on each side of ATM used for buildup
    oiChgPct: 1.5,       // aggregate OI change (%) needed to count as a real build-up / unwinding
    premChgPct: 1.0,     // OI-weighted premium change (%) needed to count as up / down
    pcrBull: 1.2, pcrBear: 0.8, pcrChgMin: 0.03, // PCR interpretation + minimum change for a trend
    proxPct: 0.4,        // spot within this % of a level counts as "at" the level
    strongRatio: 2.0, modRatio: 1.4, // level OI / average OI of the window
    staleMs: 5 * 60000,  // chain older than this is not used with the current spot
    snapGapMin: 15, snapMaxMin: 120, // earlier snapshot must be 15 to 120 min old
    maxSpreadPct: 8, minPremium: 15, minVol: 2000, // expiry-day option checks
    expiryDte: 1,        // days to expiry below this = expiry-day rules
    blockOn: 'strong',   // what would be blocked once active filtering is allowed: 'strong' | 'any' | 'never'
    confCut: { CONTRADICTS: 20, CONFLICT: 10 }, // confidence points a contradiction would remove (display only in shadow)
  };
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
  const pos = (x) => { const v = num(x); return v != null && v >= 0 ? v : null; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cfgOf = (c) => Object.assign({}, OI.DEFAULTS, c || {});
  const na = (reason, missing) => ({ status: 'DATA_UNAVAILABLE', direction: 'DATA_UNAVAILABLE', score: 0, reason, missing: missing || [], conflict: false, warnings: [reason] });

  OI.classify = function (oiPct, premPct, c) { // generic buildup type for one side
    const k = cfgOf(c);
    if (oiPct == null || premPct == null) return 'UNKNOWN';
    const oiUp = oiPct >= k.oiChgPct, oiDn = oiPct <= -k.oiChgPct, pUp = premPct >= k.premChgPct, pDn = premPct <= -k.premChgPct;
    if (oiUp && pUp) return 'LONG_BUILDUP';
    if (oiUp && pDn) return 'SHORT_BUILDUP';
    if (oiDn && pUp) return 'SHORT_COVERING';
    if (oiDn && pDn) return 'LONG_UNWINDING';
    return 'NEUTRAL';
  };
  // direction each type implies, per side (calls and puts are mirror images)
  const CALL_DIR = { LONG_BUILDUP: 1, SHORT_COVERING: 1, SHORT_BUILDUP: -1, LONG_UNWINDING: -1 };
  const PUT_DIR = { LONG_BUILDUP: -1, SHORT_COVERING: -1, SHORT_BUILDUP: 1, LONG_UNWINDING: 1 };

  OI.snap = function (chain, spot, ts) { // compact timestamped snapshot
    const rows = {}; let tc = 0, tp = 0;
    (chain || []).forEach((r) => { const co = pos(r.ceOi), po = pos(r.peOi); tc += co || 0; tp += po || 0; rows[r.strike] = [co, po, num(r.ceLtp), num(r.peLtp)]; });
    return { t: ts, spot, tc, tp, rows };
  };
  OI.pickPrev = function (list, nowMs, c) {
    const k = cfgOf(c); let best = null;
    (list || []).forEach((s) => { const a = (nowMs - s.t) / 60000; if (a >= k.snapGapMin && a <= k.snapMaxMin && (!best || s.t > best.t)) best = s; });
    return best;
  };

  // inp: { chain, spot, nowMs, chainTs, prevSnap, dte }
  OI.analyze = function (inp, cfg) {
    const k = cfgOf(cfg), now = inp.nowMs || Date.now(), spot = num(inp.spot), warnings = [];
    if (!Array.isArray(inp.chain) || !inp.chain.length) return na('No option chain data', ['chain']);
    if (spot == null || spot <= 0) return na('No valid spot price', ['spot']);
    if (inp.chainTs && now - inp.chainTs > k.staleMs) return na('Option chain is stale (' + Math.round((now - inp.chainTs) / 60000) + ' min old)', ['fresh chain']);
    const rows = inp.chain.filter((r) => num(r.strike) != null && r.strike > 0).sort((a, b) => a.strike - b.strike);
    const haveOi = rows.filter((r) => pos(r.ceOi) != null && pos(r.peOi) != null);
    if (rows.length < 6 || haveOi.length < 6) return na('Partial option chain (' + haveOi.length + ' strikes with OI)', ['strike-wise OI']);
    const totC = haveOi.reduce((s, r) => s + r.ceOi, 0), totP = haveOi.reduce((s, r) => s + r.peOi, 0);
    if (totC + totP <= 0) return na('Open interest is zero everywhere', ['OI']);
    const steps = []; for (let i = 1; i < rows.length; i++) steps.push(rows[i].strike - rows[i - 1].strike);
    const step = steps.length ? Math.min.apply(null, steps.filter((x) => x > 0)) : 50;
    const atm = rows.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a)).strike;
    const win = haveOi.filter((r) => Math.abs(r.strike - atm) <= k.atmWindow * step);

    // PCR (open-interest based) and its change from the earlier snapshot
    let pcr = null; if (totC > 0) pcr = totP / totC; else warnings.push('Call OI is zero, PCR not defined');
    const ps = inp.prevSnap; let pcrPrev = null, pcrChange = null, pcrTrend = 'UNKNOWN';
    if (ps && ps.tc > 0 && pcr != null) { pcrPrev = ps.tp / ps.tc; pcrChange = pcr - pcrPrev; pcrTrend = pcrChange > k.pcrChgMin ? 'INCREASING' : pcrChange < -k.pcrChgMin ? 'DECREASING' : 'FLAT'; }
    const pcrInterp = pcr == null ? 'UNKNOWN' : pcr >= k.pcrBull ? 'BULLISH' : pcr <= k.pcrBear ? 'BEARISH' : 'NEUTRAL';

    // buildup per side over the ATM window
    let basis = 'none';
    const side = (isCall) => {
      const oi = isCall ? 'ceOi' : 'peOi', lt = isCall ? 'ceLtp' : 'peLtp', po = isCall ? 'cePrevOi' : 'pePrevOi', pc = isCall ? 'cePrevClose' : 'pePrevClose', ix = isCall ? 2 : 3, io = isCall ? 0 : 1;
      let d = 0, b = 0, wp = 0, w = 0, used = 0, mode = null;
      win.forEach((r) => {
        let oiRef = null, pRef = null;
        if (ps && ps.rows[r.strike] && ps.rows[r.strike][io] != null) { oiRef = ps.rows[r.strike][io]; pRef = ps.rows[r.strike][ix]; mode = 'snapshot'; }
        else if (!ps && pos(r[po]) != null && num(r[pc]) != null) { oiRef = r[po]; pRef = r[pc]; mode = 'day'; }
        const l = num(r[lt]);
        if (oiRef == null || l == null || !(pRef > 0)) return;
        d += r[oi] - oiRef; b += oiRef; used += 1;
        wp += (l - pRef) / pRef * 100 * r[oi]; w += r[oi];
      });
      if (used < 3 || b <= 0 || w <= 0) return { type: 'UNKNOWN', oiPct: null, premPct: null };
      basis = mode;
      const oiPct = d / b * 100, premPct = wp / w;
      return { type: OI.classify(oiPct, premPct, k), oiPct, premPct };
    };
    const cs = side(true), pu = side(false);
    const buildScore = clamp((CALL_DIR[cs.type] || 0) + (PUT_DIR[pu.type] || 0), -1, 1);

    // support / resistance from OI, ranked, with strength
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const avgC = avg(win.map((r) => r.ceOi)), avgP = avg(win.map((r) => r.peOi));
    const mkLevel = (r, isCall) => {
      const v = isCall ? r.ceOi : r.peOi, ratio = (isCall ? avgC : avgP) > 0 ? v / (isCall ? avgC : avgP) : 0;
      const ref = ps && ps.rows[r.strike] ? ps.rows[r.strike][isCall ? 0 : 1] : (pos(r[isCall ? 'cePrevOi' : 'pePrevOi']));
      const growing = ref == null ? null : v > ref;
      return { strike: r.strike, oi: v, ratio, growing, strength: ratio >= k.strongRatio ? 'STRONG' : ratio >= k.modRatio ? 'MODERATE' : 'WEAK', score: Math.round(clamp(ratio / 3, 0, 1) * 100), distancePct: (r.strike - spot) / spot * 100 };
    };
    const sup = haveOi.filter((r) => r.strike <= spot).sort((a, b) => b.peOi - a.peOi).slice(0, 2).map((r) => mkLevel(r, false));
    const res = haveOi.filter((r) => r.strike >= spot).sort((a, b) => b.ceOi - a.ceOi).slice(0, 2).map((r) => mkLevel(r, true));
    const near = (l) => l && Math.abs(l.distancePct) <= k.proxPct && l.strength !== 'WEAK';
    let levelScore = 0;
    if (near(sup[0]) && !near(res[0])) levelScore = 1; else if (near(res[0]) && !near(sup[0])) levelScore = -1;
    // breakout / breakdown past the biggest wall, and whether the wall is being unwound (real) or still built (trap)
    const wallC = haveOi.reduce((a, b) => (b.ceOi > a.ceOi ? b : a)), wallP = haveOi.reduce((a, b) => (b.peOi > a.peOi ? b : a));
    let breakout = null;
    if (spot > wallC.strike && (spot - wallC.strike) / spot * 100 <= 1.5) {
      const unwinding = cs.type === 'SHORT_COVERING' || cs.type === 'LONG_UNWINDING';
      breakout = { dir: 1, level: wallC.strike, confirmed: unwinding };
      if (unwinding) levelScore = 1; else warnings.push('Spot is above the biggest Call OI strike (' + wallC.strike + ') but call OI is not unwinding: possible breakout trap');
    } else if (spot < wallP.strike && (wallP.strike - spot) / spot * 100 <= 1.5) {
      const unwinding = pu.type === 'SHORT_COVERING' || pu.type === 'LONG_UNWINDING';
      breakout = { dir: -1, level: wallP.strike, confirmed: unwinding };
      if (unwinding) levelScore = -1; else warnings.push('Spot is below the biggest Put OI strike (' + wallP.strike + ') but put OI is not unwinding: possible breakdown trap');
    }

    // score: three independent components, each -1..+1 (PCR, buildup, levels), so nothing is counted twice
    let pcrScore = pcrInterp === 'BULLISH' ? 1 : pcrInterp === 'BEARISH' ? -1 : 0;
    if ((pcrScore > 0 && pcrTrend === 'DECREASING') || (pcrScore < 0 && pcrTrend === 'INCREASING')) pcrScore = 0; // trend disagrees with the level
    const comps = [pcrScore, buildScore, levelScore];
    const conflict = comps.some((x) => x > 0) && comps.some((x) => x < 0);
    const score = clamp(comps.reduce((s, x) => s + x, 0), -2, 2);
    const direction = conflict ? 'CONFLICT' : score >= 2 ? 'STRONG_BULLISH' : score === 1 ? 'BULLISH' : score === 0 ? 'NEUTRAL' : score === -1 ? 'BEARISH' : 'STRONG_BEARISH';
    if (basis === 'none') warnings.push('No earlier snapshot or previous-day OI: buildup not scored');
    return {
      status: 'AVAILABLE', direction, score, conflict, basis, components: { pcr: pcrScore, buildup: buildScore, levels: levelScore },
      pcr: { value: pcr, previous: pcrPrev, change: pcrChange, trend: pcrTrend, interpretation: pcrInterp },
      buildup: { call: cs.type, put: pu.type, callOiPct: cs.oiPct, putOiPct: pu.oiPct, callPremPct: cs.premPct, putPremPct: pu.premPct },
      support: { primary: sup[0] ? sup[0].strike : null, secondary: sup[1] ? sup[1].strike : null, strength: sup[0] ? sup[0].strength : null, score: sup[0] ? sup[0].score : null, distancePct: sup[0] ? sup[0].distancePct : null },
      resistance: { primary: res[0] ? res[0].strike : null, secondary: res[1] ? res[1].strike : null, strength: res[0] ? res[0].strength : null, score: res[0] ? res[0].score : null, distancePct: res[0] ? res[0].distancePct : null },
      breakout, totals: { call: totC, put: totP, strikes: haveOi.length }, atm, warnings, lastUpdated: new Date(inp.chainTs || now).toISOString(),
    };
  };

  // How the OI view relates to the strategy's signal (dir +1 = CE buy, -1 = PE buy). Shadow: informational.
  OI.confirm = function (res, dir, cfg) {
    const k = cfgOf(cfg);
    if (!res || res.status !== 'AVAILABLE') return { status: 'UNAVAILABLE', confidenceDelta: 0, wouldBlock: false, note: res && res.reason ? res.reason : 'OI data unavailable' };
    let status;
    if (res.conflict) status = 'CONFLICT'; else if (res.score * dir >= 1) status = 'CONFIRMED'; else if (res.score === 0) status = 'NEUTRAL'; else status = 'CONTRADICTS';
    const strong = res.score * dir <= -2;
    const wouldBlock = status === 'CONTRADICTS' && (k.blockOn === 'any' || (k.blockOn === 'strong' && strong));
    return { status, confidenceDelta: -(k.confCut[status] || 0), wouldBlock, strong, note: status === 'CONTRADICTS' ? 'OI points the other way' : status === 'CONFLICT' ? 'OI signals disagree with each other' : status === 'CONFIRMED' ? 'OI agrees' : 'OI has no clear view' };
  };

  // Expiry-day option checks on the contract the signal would buy. Warnings only; nothing is blocked here.
  OI.expiryRisk = function (row, option, dte, cfg) {
    const k = cfgOf(cfg), out = [];
    if (dte == null || dte >= k.expiryDte || !row) return out;
    out.push('Expiry day: fast theta decay and sudden premium collapse are possible. Use faster exits, no averaging.');
    const ce = option === 'CE', ltp = num(row[ce ? 'ceLtp' : 'peLtp']), bid = num(row[ce ? 'ceBid' : 'peBid']), ask = num(row[ce ? 'ceAsk' : 'peAsk']), vol = num(row[ce ? 'ceVol' : 'peVol']);
    if (ltp != null && ltp < k.minPremium) out.push('Very cheap option (Rs ' + ltp.toFixed(2) + '), usually poor liquidity');
    if (bid != null && ask != null && ask > 0 && bid >= 0) { const sp = (ask - bid) / ask * 100; if (sp > k.maxSpreadPct) out.push('Wide bid-ask spread (' + sp.toFixed(1) + '%)'); }
    if (vol != null && vol < k.minVol) out.push('Low volume (' + vol + ')');
    return out;
  };

  // short record stored on a paper trade, so shadow results can be compared later
  OI.brief = function (res, dir, row, option, dte, cfg) {
    const c = OI.confirm(res, dir, cfg), ex = OI.expiryRisk(row, option, dte, cfg);
    return { st: res ? res.status : 'DATA_UNAVAILABLE', dir: res ? res.direction : null, score: res ? res.score : 0, conf: c.status, wb: c.wouldBlock, pcr: res && res.pcr ? res.pcr.value : null, basis: res ? res.basis || null : null, ex: ex.length };
  };
  root.OI = OI;
  if (typeof module !== 'undefined') module.exports = OI;
})(typeof window !== 'undefined' ? window : globalThis);
