// SignalBot scanner: runs every 5 minutes (pg_cron). Reads market data from Upstox (read-only Analytics Token),
// runs the same rules engine as the app, saves signals and sends Telegram alerts. It never places orders.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { runScan } from './core.mjs';
import E from './engine.mjs';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const J = { 'Content-Type': 'application/json' };
const reply = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: J });

async function upstox(path: string) {
  const token = Deno.env.get('UPSTOX_ANALYTICS_TOKEN');
  if (!token) throw new Error('UPSTOX_ANALYTICS_TOKEN secret is not set');
  const r = await fetch('https://api.upstox.com' + path, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  if (r.status === 401) throw new Error('Upstox token invalid or expired (401)');
  if (!r.ok) throw new Error('Upstox error ' + r.status + (j && j.errors && j.errors[0] ? ': ' + j.errors[0].message : ''));
  return j;
}

async function notify(text: string) {
  const tok = Deno.env.get('TELEGRAM_BOT_TOKEN'), chat = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!tok || !chat) throw new Error('Telegram secrets are not set');
  const r = await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', { method: 'POST', headers: J, body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!r.ok) throw new Error('Telegram error ' + r.status);
}

const db = {
  async lastScanTs() {
    const { data } = await sb.from('scan_log').select('ts').order('ts', { ascending: false }).limit(1);
    return data && data[0] ? Date.parse(data[0].ts) : null;
  },
  async todayServerSignals(day: string) {
    const from = new Date(Date.parse(day + 'T00:00:00+05:30')).toISOString();
    const { data } = await sb.from('signals').select('ts,sym,tier,option').eq('source', 'server').gte('ts', from);
    return data || [];
  },
  async insertSignal(row: Record<string, unknown>) { const { error } = await sb.from('signals').insert(row); if (error) throw new Error('db: ' + error.message); },
  async logScan(row: Record<string, unknown>) { await sb.from('scan_log').insert(row); },
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const keyOk = !!Deno.env.get('INGEST_KEY') && req.headers.get('x-app-key') === Deno.env.get('INGEST_KEY');
  if (url.searchParams.get('status')) { // last scan summary, no secrets
    const { data } = await sb.from('scan_log').select('ts,results').order('ts', { ascending: false }).limit(1);
    return reply(200, { ok: true, last: data && data[0] ? data[0] : null });
  }
  const debug = keyOk; // dry / force only for callers that know the app key
  const syms = (Deno.env.get('SCAN_SYMS') || 'NIFTY,BANKNIFTY,SENSEX').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const out = await runScan({
      now: Date.now(), upstox, notify, db, syms,
      maxRiskRs: parseFloat(Deno.env.get('MAX_RISK_RS') || '0') || 0,
      tierB: (Deno.env.get('TIER_B') || '1') !== '0',
      dry: debug && url.searchParams.get('dry') === '1',
      force: debug && url.searchParams.get('force') === '1',
    });
    return reply(200, out);
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 200);
    await db.logScan({ ts: new Date().toISOString(), results: [{ error: msg }] });
    return reply(200, { ok: false, error: msg });
  }
});
