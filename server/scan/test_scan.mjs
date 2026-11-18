import assert from 'node:assert';
import { runScan, inSession, alertText } from './core.mjs';

const T0 = Date.parse('2026-11-18T09:15:00+05:30');          // Wednesday
const NOW = Date.parse('2026-11-18T11:00:30+05:30');
const mkCandles = (drift, n) => { const rows = []; let p = 25300; for (let i = 0; i < n; i++) { const o = p; p += drift + (i % 3 === 0 ? -0.15 : 0.1); const t = new Date(T0 + i * 60000 + 19800000).toISOString().slice(0, 19) + '+05:30'; rows.push([t, o, Math.max(o, p) + 0.5, Math.min(o, p) - 0.5, p, 0, 0]); } return { rows: rows.reverse(), p }; };
function mkUpstox(drift, log, n = 105) {
  const c = mkCandles(drift, n), p = c.p, step = 50, ch = [];
  for (let k = Math.round(p / step) * step - 10 * step; k <= p + 10 * step; k += step) ch.push({ strike_price: k, underlying_spot_price: p,
    call_options: { instrument_key: 'C' + k, market_data: { ltp: Math.max(5, p - k + 110), oi: k === Math.round(p / step) * step + 8 * step ? 900000 : 200000, bid_price: Math.max(5, p - k + 110) - 0.3, ask_price: Math.max(5, p - k + 110) + 0.3 }, option_greeks: { delta: 0.5, iv: 14 } },
    put_options: { instrument_key: 'P' + k, market_data: { ltp: Math.max(5, k - p + 110), oi: k === Math.round(p / step) * step - 8 * step ? 900000 : 400000, bid_price: Math.max(5, k - p + 110) - 0.3, ask_price: Math.max(5, k - p + 110) + 0.3 }, option_greeks: { delta: -0.5, iv: 14 } } });
  return async (path) => {
    log.push(path);
    if (path.includes('market-quote')) return { data: { 'NSE_INDEX:Nifty 50': { last_price: p }, 'NSE_INDEX:India VIX': { last_price: 14.2 } } };
    if (path.includes('historical-candle/intraday')) return { data: { candles: c.rows } };
    if (path.includes('historical-candle')) return { data: { candles: [] } };
    if (path.includes('option/contract')) return { data: [{ expiry: '2026-11-18', lot_size: 65 }, { expiry: '2026-11-25', lot_size: 65 }] };
    if (path.includes('option/chain')) return { data: ch };
    throw new Error('unexpected ' + path);
  };
}
const mkDb = (rows = []) => ({ rows, logs: [], last: null, lastScanTs: async function () { return this.last; }, todayServerSignals: async function () { return this.rows; },
  insertSignal: async function (r) { this.rows.push(r); }, logScan: async function (r) { this.logs.push(r); this.last = Date.parse(r.ts); } });

assert(inSession(NOW) && !inSession(Date.parse('2026-11-18T08:00:00+05:30')) && !inSession(Date.parse('2026-11-21T11:00:00+05:30')) && !inSession(Date.parse('2026-11-18T16:00:00+05:30')));

// 1) strong uptrend -> Tier A CE alert, stored, telegram text sent once
let log = [], sent = [], db = mkDb();
let deps = { now: NOW, upstox: mkUpstox(0.42, log), db, notify: async (t) => sent.push(t), maxRiskRs: 0, tierB: true, syms: ['NIFTY'] };
let r = await runScan(deps);
console.log(JSON.stringify(r.results));
assert(r.ok && r.results[0].signal && /^A CE/.test(r.results[0].signal), JSON.stringify(r));
assert.strictEqual(sent.length, 1); assert(/NIFTY CE<\/b>  \u2022 Tier A signal/.test(sent[0]) && /Entry/.test(sent[0]) && /Stop-loss:/.test(sent[0]) && /stop-loss order at your broker/.test(sent[0]));
assert.strictEqual(db.rows.length, 1); assert(db.rows[0].source === 'server' && db.rows[0].tier === 'A' && db.rows[0].ctx.riskPerLot > 0); assert.strictEqual(db.logs.length, 1);
console.log(sent[0]);

// 2) throttle: immediate second call does nothing
r = await runScan(Object.assign({}, deps, { now: NOW + 60000 })); assert.strictEqual(r.skipped, 'throttled'); assert.strictEqual(sent.length, 1);
// 3) 5 min later: same direction is deduped by the engine (no second alert for same move)
r = await runScan(Object.assign({}, deps, { now: NOW + 300000, upstox: mkUpstox(0.42, [], 110) })); assert.strictEqual(sent.length, 1, 'no duplicate alert: ' + JSON.stringify(r.results));
assert(/same direction/.test(r.results[0].reason), 'dedupe must come from the engine, not stale data: ' + JSON.stringify(r.results));

// 4) flat market -> no trade, reason logged, no alert
log = []; sent = []; db = mkDb();
r = await runScan({ now: NOW, upstox: mkUpstox(0.0, log), db, notify: async (t) => sent.push(t), tierB: false, syms: ['NIFTY'] });
assert(r.results[0].noTrade && r.results[0].reason, JSON.stringify(r)); assert.strictEqual(sent.length, 0); assert.strictEqual(db.rows.length, 0); assert.strictEqual(db.logs[0].results[0].sym, 'NIFTY');
console.log('flat:', r.results[0].reason);

// 4b) weak setup with Tier B on: stored as Tier B for paper data, but NO Telegram alert
db = mkDb(); sent = [];
r = await runScan({ now: NOW, upstox: mkUpstox(0.0, []), db, notify: async (t) => sent.push(t), tierB: true, syms: ['NIFTY'] });
assert(r.results[0].signal && /^B /.test(r.results[0].signal), JSON.stringify(r)); assert.strictEqual(sent.length, 0); assert.strictEqual(db.rows[0].tier, 'B');

// 5) outside session -> skipped, no calls
log = []; r = await runScan({ now: Date.parse('2026-11-18T19:00:00+05:30'), upstox: mkUpstox(0.4, log), db: mkDb(), notify: async () => {}, syms: ['NIFTY'] }); assert.strictEqual(r.skipped, 'outside session'); assert.strictEqual(log.length, 0);

// 6) one symbol failing does not stop the others; error is reported
db = mkDb(); sent = [];
const up = mkUpstox(0.42, []);
r = await runScan({ now: NOW, upstox: async (p) => { if (p.includes('BSE_INDEX')) throw new Error('Upstox error 400: bad key'); return up(p); }, db, notify: async (t) => sent.push(t), tierB: false, syms: ['SENSEX', 'NIFTY'] });
assert(r.results[0].error && /400/.test(r.results[0].error) && r.results[1].signal, JSON.stringify(r)); assert.strictEqual(sent.length, 1);

// 7) 2 Tier A already today -> no third
db = mkDb([{ tier: 'A', sym: 'BANKNIFTY', option: 'PE', ts: new Date(NOW - 3600000).toISOString() }, { tier: 'A', sym: 'SENSEX', option: 'PE', ts: new Date(NOW - 3000000).toISOString() }]); sent = [];
r = await runScan({ now: NOW, upstox: mkUpstox(0.42, []), db, notify: async (t) => sent.push(t), syms: ['NIFTY'] }); assert.strictEqual(sent.length, 0); assert(/2/.test(r.results[0].reason), JSON.stringify(r));

// 8) dry run: nothing written, nothing sent
db = mkDb(); sent = [];
r = await runScan({ now: NOW, upstox: mkUpstox(0.42, []), db, notify: async (t) => sent.push(t), syms: ['NIFTY'], dry: true }); assert(r.results[0].signal); assert.strictEqual(sent.length + db.rows.length + db.logs.length, 0);
// 9) Telegram failing: error reported, nothing saved, next scan retries and succeeds
db = mkDb(); sent = []; let fail = true;
const flaky = async (t) => { if (fail) throw new Error('Telegram error 403'); sent.push(t); };
r = await runScan({ now: NOW, upstox: mkUpstox(0.42, []), db, notify: flaky, syms: ['NIFTY'] });
assert(r.results[0].error === 'Telegram error 403' && db.rows.length === 0 && sent.length === 0, JSON.stringify(r));
fail = false;
r = await runScan({ now: NOW + 300000, upstox: mkUpstox(0.42, [], 110), db, notify: flaky, syms: ['NIFTY'] });
assert(r.results[0].signal && sent.length === 1 && db.rows.length === 1, JSON.stringify(r));
console.log('SCAN TESTS OK');
