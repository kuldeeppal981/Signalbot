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


  /* ---------- News / event agent (Claude + web search). Context only: it never creates or blocks a trade by itself. ---------- */
  A.NEWS_SYSTEM = [
    'You are a news checker for an Indian index-options trader (Nifty, Bank Nifty, Sensex).',
    'Use web search to find, for TODAY only: scheduled events in India (RBI policy or speeches, major results of index heavyweights, macro data releases, weekly expiry), overnight US and Asian market cues, big moves in crude oil, the US dollar or INR, and any major breaking news (policy, geopolitics) that could move the Indian index today.',
    'Rules: use ONLY what you found in search results. If you did not find something, write "unknown". Never invent event times, numbers or headlines. Do not predict index prices.',
    'Reply with ONLY a JSON object, no other text:',
    '{"global":"1-2 short sentences","india":"1-2 short sentences","events":[{"time":"HH:MM IST or unknown","title":"short","impact":"high|medium|low"}],"bias":"risk-on|risk-off|mixed|unknown","caution":["max 3 short items"]}',
  ].join('\n');

  A.newsRequest = function (key, model, dateStr) {
    return { url: 'https://api.anthropic.com/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1500, system: A.NEWS_SYSTEM,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
        messages: [{ role: 'user', content: 'Today is ' + dateStr + ' (India, IST). Give me the market context for today.' }] }) };
  };

  A.parseNews = function (j) {
    const blocks = (j && j.content) || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
    const sources = [], seen = {};
    const add = (u, t) => { if (u && !seen[u]) { seen[u] = 1; sources.push({ url: u, title: String(t || u).slice(0, 90) }); } };
    blocks.forEach((b) => {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((r) => add(r.url, r.title));
      if (b.type === 'text' && Array.isArray(b.citations)) b.citations.forEach((c) => add(c.url, c.title));
    });
    const m = /\{[\s\S]*\}/.exec(text.replace(/```json|```/g, ''));
    if (!m) return null;
    let o; try { o = JSON.parse(m[0]); } catch (e) { return null; }
    const str = (x, n) => (x == null ? 'unknown' : String(x).slice(0, n || 220));
    const bias = ['risk-on', 'risk-off', 'mixed', 'unknown'].includes(String(o.bias)) ? o.bias : 'unknown';
    const events = (Array.isArray(o.events) ? o.events : []).slice(0, 8).map((e) => ({ time: str(e.time, 20), title: str(e.title, 120), impact: ['high', 'medium', 'low'].includes(String(e.impact)) ? e.impact : 'low' }));
    return { global: str(o.global), india: str(o.india), events, bias, caution: (Array.isArray(o.caution) ? o.caution : []).slice(0, 3).map((c) => str(c, 140)), sources: sources.slice(0, 6) };
  };

  A.askNews = async function (cfg, dateStr, send) {
    if (cfg.agProv === 'gemini') return { ok: false, error: 'The news agent needs the Claude provider (it uses Claude web search). Switch the provider in Settings.' };
    if (!cfg.agKey) return { ok: false, error: 'No API key. Add it in Settings.' };
    const model = (cfg.agModel || '').trim() || A.DEFAULTS.claude;
    const rq = A.newsRequest(cfg.agKey.trim(), model, dateStr);
    let resp;
    try { resp = await send(rq.url, rq.headers, rq.body, 75000); } catch (e) { return { ok: false, error: e.message || 'Network error' }; }
    let j = null; try { j = JSON.parse(resp.body); } catch (e) {}
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'The API key was rejected (' + resp.status + ').' };
    if (resp.status === 429) return { ok: false, error: 'Too many requests or no credit (429). Try later.' };
    if (resp.status < 200 || resp.status > 299) {
      const m = j && j.error && (j.error.message || j.error);
      return { ok: false, error: 'AI error ' + resp.status + (m ? ': ' + String(m).slice(0, 160) : '') + '. If web search is not enabled for your Anthropic account, enable it in the Console, or choose a model that supports web search.' };
    }
    const err = ((j && j.content) || []).find((b) => b.type === 'web_search_tool_result' && b.content && b.content.type === 'web_search_tool_result_error');
    const n = A.parseNews(j);
    if (!n) return { ok: false, error: err ? 'Web search failed (' + err.content.error_code + '). Try again later.' : 'The reply could not be understood. Nothing was changed.' };
    n.model = model; n.t = Date.now();
    return { ok: true, news: n };
  };

  A.newsSummary = function (n) {
    if (!n) return '';
    const ev = (n.events || []).map((e) => e.time + ' ' + e.title + ' (' + e.impact + ')').join('; ');
    return 'News check (AI + web, unverified): global: ' + n.global + ' | India: ' + n.india + ' | bias ' + n.bias + (ev ? ' | events: ' + ev : '') + ((n.caution || []).length ? ' | caution: ' + n.caution.join('; ') : '');
  };

  // Soft warning only: a high/medium impact event whose time is within +/- windowMin of now.
  A.eventNear = function (n, nowMs, windowMin) {
    if (!n || !n.events) return null;
    const d = new Date(nowMs + 330 * 60000), nm = d.getUTCHours() * 60 + d.getUTCMinutes(), w = windowMin || 20;
    for (const e of n.events) {
      if (e.impact === 'low') continue;
      const m = /(\d{1,2})[:.](\d{2})/.exec(e.time || ''); if (!m) continue;
      const em = +m[1] * 60 + +m[2];
      if (Math.abs(em - nm) <= w) return e;
    }
    return null;
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
