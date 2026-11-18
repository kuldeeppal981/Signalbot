// SignalBot server-side scanner core. Pure logic with injected dependencies so it can be tested in node.
import E from './engine.mjs';

export const KEYS = { NIFTY: 'NSE_INDEX|Nifty 50', BANKNIFTY: 'NSE_INDEX|Nifty Bank', SENSEX: 'BSE_INDEX|SENSEX', VIX: 'NSE_INDEX|India VIX' };
export const INSTR = {
  NIFTY: { name: 'Nifty', q: 'nifty 50', lot: 65 },
  BANKNIFTY: { name: 'Bank Nifty', q: 'nifty bank', lot: 30 },
  SENSEX: { name: 'Sensex', q: 'sensex', lot: 20 },
};
const f2 = (x) => (x == null ? '-' : (Math.round(x * 100) / 100).toFixed(2));

// IST session gate: weekdays 09:50-15:00
export function inSession(nowMs) {
  const d = new Date(nowMs + 19800000), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd >= 1 && wd <= 5 && m >= 590 && m <= 915;
}

export async function loadLive(s, up, nowMs) {
  const key = KEYS[s], ek = encodeURIComponent(key), td = E.istDate(nowMs), D = 86400000;
  const base = Date.parse(td + 'T00:00:00+05:30');
  const [q, cd, ct, prev] = await Promise.all([
    up('/v2/market-quote/quotes?instrument_key=' + encodeURIComponent(key + ',' + KEYS.VIX)),
    up('/v2/historical-candle/intraday/' + ek + '/1minute'),
    up('/v2/option/contract?instrument_key=' + ek),
    up('/v2/historical-candle/' + ek + '/1minute/' + E.istDate(base - D) + '/' + E.istDate(base - 9 * D)).catch(() => null),
  ]);
  const quotes = Object.entries(q.data || {});
  const find = (n) => { const e = quotes.find(([k]) => k.toLowerCase().includes(n)); return e ? e[1].last_price : null; };
  const spot = find(INSTR[s].q), vix = find('vix');
  const contracts = ct.data || [];
  const exps = [...new Set(contracts.map((c) => c.expiry))].filter((d) => d >= td).sort();
  if (!exps.length) throw new Error('Expiry not found');
  const lotSize = (contracts.find((c) => c.expiry === exps[0]) || {}).lot_size;
  const ch = await up('/v2/option/chain?instrument_key=' + ek + '&expiry_date=' + exps[0]);
  const g = (r, side, f) => (r[side] && r[side].market_data ? r[side].market_data[f] : null);
  const gr = (r, side, f) => (r[side] && r[side].option_greeks ? r[side].option_greeks[f] : null);
  const chain = (ch.data || []).map((r) => ({
    strike: r.strike_price,
    ceKey: r.call_options && r.call_options.instrument_key, ceLtp: g(r, 'call_options', 'ltp'), ceOi: g(r, 'call_options', 'oi'),
    ceDelta: gr(r, 'call_options', 'delta'), ceIv: gr(r, 'call_options', 'iv'), ceBid: g(r, 'call_options', 'bid_price'), ceAsk: g(r, 'call_options', 'ask_price'),
    peKey: r.put_options && r.put_options.instrument_key, peLtp: g(r, 'put_options', 'ltp'), peOi: g(r, 'put_options', 'oi'),
    peDelta: gr(r, 'put_options', 'delta'), peIv: gr(r, 'put_options', 'iv'), peBid: g(r, 'put_options', 'bid_price'), peAsk: g(r, 'put_options', 'ask_price'),
  }));
  const prevCandles = prev ? E.parseCandles((prev.data && prev.data.candles) || []).filter((c) => E.istDate(c.t) < td) : [];
  return { symbol: s, spot, vix, chain, chainSpot: ((ch.data || [])[0] || {}).underlying_spot_price, lotSize: lotSize || INSTR[s].lot, expiry: exps[0],
    candles: E.parseCandles((cd.data && cd.data.candles) || []), nowMs, prevCandles };
}

// state: { signalsToday, tierBToday, recent: [{sym,dir,tMs,tier}] }
export async function scanOne(s, deps, state) {
  const d = await loadLive(s, deps.upstox, deps.now);
  const last = d.candles.length ? d.candles[d.candles.length - 1].t : 0;
  const ageMin = (deps.now - last) / 60000;
  if (!d.candles.length) return { sym: s, noTrade: true, reason: 'No candles yet' };
  if (ageMin > 5) return { sym: s, noTrade: true, reason: 'Stale data (last candle ' + ageMin.toFixed(0) + ' min old)' };
  const rec = (tier) => state.recent.filter((x) => x.sym === s && x.tier === tier).map((x) => ({ dir: x.dir, t: x.tMs }));
  const base = Object.assign({}, d, { maxSignals: deps.maxSignals || 2, cutoffMin: deps.cutoffMin || 870, maxRiskRs: deps.maxRiskRs || 0, openForSymbol: false, consecLosses: 0, dayPnl: 0, lastLossAgoMin: null });
  const rA = E.analyze(Object.assign({}, base, { signalsToday: state.signalsToday, recentSignals: rec('A'), flags: { tierB: false } }));
  if (!rA.noTrade && rA.signal && !rA.signal.indexOnly) return { sym: s, tier: 'A', r: rA, d, noTrade: false };
  if (deps.tierB) {
    const rB = E.analyze(Object.assign({}, base, { signalsToday: 0, tierBToday: state.tierBToday, recentSignals: rec('B'), flags: { tierB: true } }));
    const dirB = rB.signal && rB.signal.option === 'CE' ? 1 : -1;
    const dupA = state.recent.some((q) => q.sym === s && q.tier === 'A' && q.dir === dirB && deps.now - q.tMs < 30 * 60000); // same idea as a Tier A alert already sent
    if (!rB.noTrade && rB.signal && !rB.signal.indexOnly && !dupA) return { sym: s, tier: 'B', r: rB, d, noTrade: false };
  }
  return { sym: s, noTrade: true, reason: rA.reason, score: rA.score == null ? null : rA.score, view: rA.view, spot: rA.spot };
}

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const inr = (x) => 'Rs ' + Math.round(x).toLocaleString('en-IN');
// Telegram message (HTML parse mode): short, bold labels, one fact per line.
export function alertText(sym, g, r, tier) {
  const nm = INSTR[sym].name, ce = g.option === 'CE';
  const head = (ce ? '\u{1F7E2}' : '\u{1F534}') + ' <b>' + esc(nm.toUpperCase()) + ' ' + g.option + '</b>  ' + (tier === 'A' ? '\u2022 Tier A signal' : '\u2022 Tier B (paper only)');
  const lines = [
    head,
    '',
    '<b>Buy:</b> ' + g.strike + ' ' + g.option + ' (' + esc(g.strikeType) + ')',
    '<b>Entry:</b> ' + f2(g.entryLo) + ' - ' + f2(g.entryHi),
    '<b>Stop-loss:</b> ' + f2(g.sl) + '  (-25%)',
    '<b>Target 1:</b> ' + f2(g.t1) + '  (+50%)',
    '<b>Target 2:</b> ' + f2(g.t2) + '  (+75%)',
    '',
    '<b>Index:</b> ' + f2(r.spot) + '  |  exit if it closes ' + (ce ? 'below ' : 'above ') + f2(g.indexInvalidation),
    '<b>Score:</b> ' + r.score + '/6  |  <b>Strength:</b> ' + (g.strength == null ? '-' : g.strength) + '/100',
    '<b>Valid till:</b> ' + esc(g.validUntil) + '  |  exit if no move in 45 min',
    '<b>Risk:</b> 1 lot (' + g.lotSize + ') = about ' + inr(g.riskPerLot),
    '',
    '<i>Put the stop-loss order at your broker. Educational signal, not advice.</i>',
  ];
  return lines.join('\n');
}

// Main run. deps: { now, upstox(path), db:{ today(dayIso)->rows, insertSignal(row), logScan(row), lastScanTs() }, notify(text), maxRiskRs, tierB, syms, dry }
export async function runScan(deps) {
  const now = deps.now;
  if (!deps.force && !inSession(now)) return { skipped: 'outside session' };
  const last = await deps.db.lastScanTs();
  if (last && now - last < 150000) return { skipped: 'throttled' };
  const day = E.istDate(now);
  const rows = await deps.db.todayServerSignals(day);
  const state = {
    signalsToday: rows.filter((x) => x.tier === 'A').length,
    tierBToday: rows.filter((x) => x.tier === 'B').length,
    recent: rows.map((x) => ({ sym: x.sym, dir: x.option === 'CE' ? 1 : -1, tMs: Date.parse(x.ts), tier: x.tier })),
  };
  const out = [];
  for (const s of deps.syms) {
    try {
      const x = await scanOne(s, deps, state);
      if (x.noTrade) { out.push({ sym: s, noTrade: true, reason: x.reason, score: x.score, view: x.view, spot: x.spot }); continue; }
      const g = x.r.signal;
      if (x.tier === 'A' && state.signalsToday >= (deps.maxSignals || 2)) { out.push({ sym: s, noTrade: true, reason: 'Already ' + (deps.maxSignals || 2) + ' Tier A signals today' }); continue; }
      const row = { ts: new Date(now).toISOString(), sym: s, tier: x.tier, option: g.option, strike: g.strike, spot: x.r.spot, entry_lo: g.entryLo, entry_hi: g.entryHi, sl: g.sl, t1: g.t1, t2: g.t2,
        score: x.r.score, strength: g.strength == null ? null : g.strength, lots: g.lots,
        ctx: { checks: (x.r.checks || []).map((c) => [c.name, c.v, c.t]), snap: x.r.snap || {}, invalidation: g.indexInvalidation, delta: g.delta, spreadPct: g.spreadPct, riskPerLot: g.riskPerLot, lotSize: g.lotSize }, source: 'server' };
      // Alert first: if Telegram fails, nothing is saved, so the next scan tries again instead of treating the signal as done.
      if (x.tier === 'A' && !deps.dry) await deps.notify(alertText(s, g, x.r, 'A'));
      if (!deps.dry) await deps.db.insertSignal(row);
      state.recent.push({ sym: s, dir: g.option === 'CE' ? 1 : -1, tMs: now, tier: x.tier });
      if (x.tier === 'A') state.signalsToday++; else state.tierBToday++;
      out.push({ sym: s, signal: x.tier + ' ' + g.option + ' ' + g.strike });
    } catch (e) { out.push({ sym: s, error: String(e.message || e).slice(0, 160) }); }
  }
  if (!deps.dry) await deps.db.logScan({ ts: new Date(now).toISOString(), results: out });
  return { ok: true, results: out };
}
