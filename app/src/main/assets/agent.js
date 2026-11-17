/* AI second-opinion agent. ADVISORY ONLY: it reviews a signal that the rule engine already produced and answers
   TAKE / WAIT / SKIP with reasons. It never sets lots, SL or risk, and it never places orders.
   Every opinion is logged and later compared with the trade outcome, so we can see if it is better than the rules. */
(function (root) {
  const A = {};
  const E = () => root.SignalEngine;

  A.DEFAULTS = { claude: 'claude-haiku-5-5', gemini: 'gemini-2.5-flash' };
  A.HOSTS = ['api.anthropic.com', 'generativelanguage.googleapis.com'];

  A.SYSTEM = [
    'You are a cautious risk reviewer for a personal Indian index-options BUYING bot (Nifty / Bank Nifty, CE or PE buying only).',
    'A rule engine has ALREADY produced a signal. Your job is only to give a second opinion: TAKE, WAIT or SKIP.',
    'Rules for you:',
    '- Use ONLY the data given. Never invent prices, news or numbers. If the data is not enough, say so and prefer WAIT or SKIP.',
    '- Option buying loses money from theta and whipsaws. When unsure, choose SKIP or WAIT. Missing a trade is cheap; a bad trade is not.',
    '- You cannot change lots, stop-loss or risk. Do not suggest bigger size. Do not predict the market with certainty.',
    '- Look for things the rules cannot see: price already extended or stalling, momentum fading in the last candles, opening-range break that looks like a fake, expiry-day theta, conflict between factors, a known event note from the user.',
    '- "confidence" is how sure YOU are about your verdict (0-100), not a win probability. Never claim accuracy.',
    'Reply with ONLY a JSON object, no other text:',
    '{"verdict":"TAKE|WAIT|SKIP","confidence":0-100,"reasons":["max 3 short reasons"],"risks":["max 2 short risks"]}',
  ].join('\n');

  A.snapshot = function (r, d, extra) {
    const e = E(), s = r.signal, sn = r.snap || {}, nowMs = (extra && extra.nowMs) || Date.now();
    let c5 = [];
    try { c5 = e.aggregate(d.candles || [], 5, nowMs).slice(-12).map((c) => [e.hhmm(e.istMin(c.t)), c.o, c.h, c.l, c.c].map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)).join(' ')); } catch (x) {}
    const lines = [];
    lines.push('Index: ' + s.indexName + ' | time (IST): ' + e.hhmm(e.istMin(nowMs)) + ' | spot ' + r.spot + ' | India VIX ' + (sn.vix == null ? 'NA' : Number(sn.vix).toFixed(1)));
    lines.push('Expiry: ' + (d.expiry || 'NA') + ' | days to expiry ' + (sn.dte == null ? 'NA' : Number(sn.dte).toFixed(2)) + ' | tier ' + (s.tier || 'A'));
    lines.push('Rule signal: BUY ' + s.option + ' ' + s.strike + ' (' + s.strikeType + '), premium ' + s.ltp + ', SL ' + s.sl + ', T1 ' + s.t1 + ', T2 ' + s.t2 + ', index invalidation ' + s.indexInvalidation);
    lines.push('Score ' + r.score + '/6, setup strength ' + (s.strength == null ? 'NA' : s.strength) + '/100');
    lines.push('Factors: ' + (r.checks || []).map((c) => c.name + '=' + (c.v > 0 ? '+1' : c.v < 0 ? '-1' : '0') + ' (' + c.t + ')').join('; '));
    lines.push('Opening range ' + sn.orLow + ' - ' + sn.orHigh + ' | EMA9 ' + (sn.ema9 == null ? 'NA' : sn.ema9.toFixed(1)) + ' EMA20 ' + (sn.ema20 == null ? 'NA' : sn.ema20.toFixed(1)) + ' | day low/high ' + sn.dayLow + ' / ' + sn.dayHigh);
    lines.push('PCR ' + (sn.pcr == null ? 'NA' : sn.pcr.toFixed(2)) + ' | resistance (max Call OI) ' + (sn.resistance || 'NA') + ' | support (max Put OI) ' + (sn.support || 'NA'));
    if (s.delta != null) lines.push('Option delta ' + Number(s.delta).toFixed(2) + (s.spreadPct != null ? ', bid-ask spread ' + s.spreadPct.toFixed(1) + '%' : ''));
    if (c5.length) lines.push('Last 5-min candles (time open high low close):\n' + c5.join('\n'));
    if (extra && extra.note) lines.push('User note about today (events etc.): ' + String(extra.note).slice(0, 200));
    return lines.join('\n');
  };

  A.parse = function (text) {
    if (!text) return null;
    const m = /\{[\s\S]*\}/.exec(String(text).replace(/```json|```/g, ''));
    if (!m) return null;
    let j; try { j = JSON.parse(m[0]); } catch (e) { return null; }
    const v = String(j.verdict || '').toUpperCase();
    if (!['TAKE', 'WAIT', 'SKIP'].includes(v)) return null;
    const arr = (x) => (Array.isArray(x) ? x.slice(0, 3).map((t) => String(t).slice(0, 160)) : []);
    return { verdict: v, confidence: Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0))), reasons: arr(j.reasons), risks: arr(j.risks) };
  };

  A.request = function (prov, key, model, userText) {
    if (prov === 'gemini') {
      return { url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: A.SYSTEM + '\n\n' + userText }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 600, responseMimeType: 'application/json' } }) };
    }
    return { url: 'https://api.anthropic.com/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 600, temperature: 0.2, system: A.SYSTEM, messages: [{ role: 'user', content: userText }] }) };
  };

  A.extractText = function (prov, j) {
    try {
      if (prov === 'gemini') return j.candidates[0].content.parts.map((p) => p.text || '').join('');
      return j.content.map((c) => c.text || '').join('');
    } catch (e) { return ''; }
  };

  // send(url, headers, body) -> Promise<{status, body}>. Returns {ok, opinion} or {ok:false, error}.
  A.ask = async function (cfg, userText, send) {
    const prov = cfg.agProv === 'gemini' ? 'gemini' : 'claude';
    if (!cfg.agKey) return { ok: false, error: 'No API key. Add it in Settings.' };
    const model = (cfg.agModel || '').trim() || A.DEFAULTS[prov];
    const rq = A.request(prov, cfg.agKey.trim(), model, userText);
    let resp;
    try { resp = await send(rq.url, rq.headers, rq.body); } catch (e) { return { ok: false, error: e.message || 'Network error' }; }
    let j = null; try { j = JSON.parse(resp.body); } catch (e) {}
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'The API key was rejected (' + resp.status + '). Check the key and provider in Settings.' };
    if (resp.status === 429) return { ok: false, error: 'The AI provider says too many requests or no credit (429). Try later.' };
    if (resp.status < 200 || resp.status > 299) {
      const m = j && ((j.error && (j.error.message || j.error)) || j.message);
      return { ok: false, error: 'AI error ' + resp.status + (m ? ': ' + String(m).slice(0, 120) : '') };
    }
    const op = A.parse(A.extractText(prov, j));
    if (!op) return { ok: false, error: 'The AI reply could not be understood. Nothing was changed.' };
    op.model = model; op.prov = prov;
    return { ok: true, opinion: op };
  };

  // Summary of opinions vs paper outcomes (used by the Learning report). trades = closed Tier A paper trades that carry t.agent.
  A.compare = function (trades) {
    const g = {};
    trades.filter((t) => t.agent && t.agent.verdict && t.r != null && isFinite(t.r)).forEach((t) => { (g[t.agent.verdict] = g[t.agent.verdict] || []).push(t.r); });
    return ['TAKE', 'WAIT', 'SKIP'].filter((k) => g[k]).map((k) => ({ verdict: k, n: g[k].length, win: g[k].filter((r) => r > 0).length * 100 / g[k].length, avgR: g[k].reduce((a, b) => a + b, 0) / g[k].length }));
  };

  root.Agent = A;
  if (typeof module !== 'undefined') module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
