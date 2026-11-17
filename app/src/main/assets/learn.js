/* Learning report. Rule-based "coach": reads paper trades, journal tags and No-Trade counts, finds patterns,
   and writes a plain-text report you can paste to Claude. It NEVER changes the strategy by itself.
   Every suggestion carries its sample size and is meant to be tested in the Backtest A/B first. */
(function (root) {
  const L = {};
  const MIN_N = 8;        // minimum trades in a bucket before the app even mentions a pattern
  const SOLID_N = 30;     // trades needed before a suggestion is called "worth testing"
  const f1 = (x) => (x == null || !isFinite(x) ? '-' : Number(x).toFixed(1));
  const f2 = (x) => (x == null || !isFinite(x) ? '-' : Number(x).toFixed(2));
  const sign = (x) => (x >= 0 ? '+' : '') + f2(x);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
  const istHour = (ms) => new Date(ms + 330 * 60000).getUTCHours();
  const istMinOfDay = (ms) => { const d = new Date(ms + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

  function stat(g) {
    const rs = g.map((t) => t.r), n = g.length, w = g.filter((t) => t.netPnl > 0).length;
    return { n, win: n ? w * 100 / n : 0, avgR: mean(rs), se: n > 1 ? sd(rs) / Math.sqrt(n) : null, net: g.reduce((s, t) => s + t.netPnl, 0) };
  }
  function group(list, keyFn) {
    const m = {};
    list.forEach((t) => { const k = keyFn(t); if (k == null) return; (m[k] = m[k] || []).push(t); });
    return Object.keys(m).map((k) => Object.assign({ k }, stat(m[k])));
  }

  // data = { paper:[], journal:[], nt:{date:{reason:count}}, cfg:{}, now:ms, shadow:[25,33,40], shadowRet:fn }
  L.analyze = function (data) {
    const paper = data.paper || [], journal = data.journal || [], cfg = data.cfg || {};
    const okT = (t) => t.state === 'CLOSED' && t.r != null && isFinite(t.r) && t.fillAt;
    const closed = paper.filter((t) => okT(t) && t.tier !== 'B'); // Tier A only
    const closedB = paper.filter((t) => okT(t) && t.tier === 'B');
    const missed = paper.filter((t) => t.state === 'MISSED');
    const rep = { n: closed.length, missed: missed.length, created: paper.length, sections: [], suggestions: [], warnings: [] };
    const all = stat(closed);
    rep.all = all; rep.tierB = stat(closedB);
    rep.agent = root.Agent ? root.Agent.compare(closed) : [];

    // break-even from realised winners/losers (same idea as the backtest verdict)
    const wins = closed.filter((t) => t.r > 0), loss = closed.filter((t) => t.r <= 0);
    const aw = mean(wins.map((t) => t.r)), al = mean(loss.map((t) => -t.r));
    rep.be = wins.length && loss.length ? al / (aw + al) * 100 : null;
    rep.aw = aw; rep.al = al;

    // breakdowns
    const bucket = (t) => { const m = istMinOfDay(t.fillAt); return m < 600 ? '09:30-10:00' : m < 660 ? '10:00-11:00' : m < 720 ? '11:00-12:00' : m < 780 ? '12:00-13:00' : '13:00-14:30'; };
    const exits = (t) => t.exitWhy || '?';
    const ctx = (t) => t.ctx || {};
    rep.by = {
      hour: group(closed, bucket),
      side: group(closed, (t) => t.option),
      index: group(closed, (t) => t.idxName),
      exit: group(closed, exits),
      expiry: group(closed, (t) => (ctx(t).dte < 1 ? 'Expiry day' : ctx(t).dte == null ? null : 'Other days')),
      score: group(closed, (t) => (ctx(t).score == null ? null : 'score ' + Math.abs(ctx(t).score))),
      vix: group(closed, (t) => (ctx(t).vix == null ? null : ctx(t).vix < 14 ? 'VIX < 14' : ctx(t).vix <= 18 ? 'VIX 14-18' : 'VIX > 18')),
      pcr: group(closed, (t) => (ctx(t).pcrAgree == null ? null : ctx(t).pcrAgree ? 'PCR agreed' : 'PCR neutral/against')),
    };

    // execution
    const slip = closed.filter((t) => t.signalPrice > 0 && t.slippage != null).map((t) => t.slippage / t.signalPrice * 100);
    rep.exec = {
      avgSlip: slip.length ? mean(slip) : null,
      missedPct: paper.length ? missed.length * 100 / paper.length : 0,
      charges: closed.reduce((s, t) => s + (t.charges ? t.charges.total : 0), 0),
      gross: closed.reduce((s, t) => s + (t.grossPnl || 0), 0),
      timeExitPct: closed.length ? closed.filter((t) => t.exitWhy === 'TIME' || t.exitWhy === 'EOD').length * 100 / closed.length : 0,
    };

    // shadow stops
    const sh = paper.filter((t) => t.shDone && t.fillPrice && t.shLast > 0);
    rep.shadow = (data.shadow || []).map((v) => ({ v, n: sh.length, avg: sh.length ? mean(sh.map((t) => data.shadowRet(t, v))) : null, hit: sh.filter((t) => t.sh && t.sh[v]).length }));
    // "SL hit, then price came back above entry" = stop-hunt style losses
    const slHit = closed.filter((t) => t.exitWhy === 'SL' && t.shDone && t.shLast > 0);
    rep.slThenUp = { n: slHit.length, up: slHit.filter((t) => t.shLast >= t.fillPrice).length };

    // journal (real trades) and mistakes
    const jd = journal.filter((x) => x.exit != null && x.entry > 0);
    const jnet = (x) => (data.journalNet ? data.journalNet(x) : (x.exit - x.entry) * x.lots * x.lotSize);
    const tagged = jd.filter((x) => x.tags && x.tags.length);
    const mistakeTags = {};
    tagged.forEach((x) => x.tags.forEach((tg) => { if (tg === 'Followed the plan') return; const o = mistakeTags[tg] = mistakeTags[tg] || { n: 0, pnl: 0 }; o.n++; o.pnl += jnet(x); }));
    rep.journal = { n: jd.length, tagged: tagged.length, mistakes: mistakeTags, net: jd.reduce((s, x) => s + jnet(x), 0) };
    const losersJ = jd.filter((x) => jnet(x) < 0);
    rep.journal.lossWithMistake = losersJ.filter((x) => (x.tags || []).some((tg) => tg !== 'Followed the plan')).length;
    rep.journal.losses = losersJ.length;

    // No-Trade reasons over the stored days
    const reasons = {};
    let scans = 0, days = 0;
    Object.keys(data.nt || {}).forEach((d) => { days++; Object.keys(data.nt[d]).forEach((r) => { reasons[r] = (reasons[r] || 0) + data.nt[d][r]; scans += data.nt[d][r]; }); });
    rep.nt = { days, scans, top: Object.keys(reasons).map((r) => ({ r, n: reasons[r] })).sort((a, b) => b.n - a.n).slice(0, 6) };

    /* ---------- suggestions (evidence gated) ---------- */
    const S = rep.suggestions;
    const add = (title, why, test, n) => S.push({ title, why, test, n, strength: n >= SOLID_N ? 'worth testing' : 'weak (small sample), only watch' });
    if (rep.n < SOLID_N) rep.warnings.push('Only ' + rep.n + ' closed paper trades. Under ' + SOLID_N + ' trades, most patterns below are luck. Do NOT change the strategy yet. Keep collecting.');

    const worst = (arr) => arr.filter((g) => g.n >= MIN_N).sort((a, b) => a.avgR - b.avgR)[0];
    const best = (arr) => arr.filter((g) => g.n >= MIN_N).sort((a, b) => b.avgR - a.avgR)[0];
    const hw = worst(rep.by.hour), hb = best(rep.by.hour);
    if (hw && hb && hw.k !== hb.k && hw.avgR < -0.1 && hb.avgR - hw.avgR > 0.3) add('Weak time window: ' + hw.k, hw.k + ' averages ' + sign(hw.avgR) + 'R over ' + hw.n + ' trades, while ' + hb.k + ' averages ' + sign(hb.avgR) + 'R (' + hb.n + ' trades).', 'Backtest A/B: add a variant that starts entries later (10:00 / 10:15) and compare.', hw.n + hb.n);
    const ce = rep.by.side.find((g) => g.k === 'CE'), pe = rep.by.side.find((g) => g.k === 'PE');
    if (ce && pe && ce.n >= MIN_N && pe.n >= MIN_N && Math.abs(ce.avgR - pe.avgR) > 0.3) add((ce.avgR < pe.avgR ? 'CE' : 'PE') + ' trades are weaker', 'CE ' + sign(ce.avgR) + 'R (' + ce.n + ') vs PE ' + sign(pe.avgR) + 'R (' + pe.n + ').', 'Check in Backtest breakdown (CE vs PE) over 20+ days. Do not drop one side from a single month.', ce.n + pe.n);
    const sc = rep.by.score.filter((g) => g.n >= MIN_N).sort((a, b) => a.k.localeCompare(b.k));
    if (sc.length >= 2 && sc[sc.length - 1].avgR - sc[0].avgR > 0.3) add('Higher score does better', sc.map((g) => g.k + ': ' + sign(g.avgR) + 'R (' + g.n + ')').join(', ') + '.', 'Backtest A/B: variant with minimum score 5.', sc.reduce((s, g) => s + g.n, 0));
    const vx = rep.by.vix.filter((g) => g.n >= MIN_N);
    const vh = vx.find((g) => g.k === 'VIX > 18');
    if (vh && vh.avgR < -0.15) add('High VIX trades lose', 'VIX > 18 averages ' + sign(vh.avgR) + 'R over ' + vh.n + ' trades.', 'Lower the VIX limit in the engine from 24 to 18 only after checking more trades. Note: VIX is not in the backtest, so only paper trading can test this.', vh.n);
    const ex = rep.by.expiry.filter((g) => g.n >= MIN_N);
    if (ex.length === 2 && Math.abs(ex[0].avgR - ex[1].avgR) > 0.35) add('Expiry day behaves differently', ex.map((g) => g.k + ' ' + sign(g.avgR) + 'R (' + g.n + ')').join(' vs ') + '.', 'Consider a stricter rule on expiry days. Paper trading only (needs more data).', ex[0].n + ex[1].n);
    if (rep.exec.avgSlip != null && closed.length >= MIN_N && rep.exec.avgSlip > 3) add('Entry slippage is high', 'Average fill is ' + f1(rep.exec.avgSlip) + '% above the signal price.', 'Check spread filter (5%) and consider entering only when the spread is small. Use limit orders in real trading.', closed.length);
    if (paper.length >= MIN_N && rep.exec.missedPct > 40) add('Many signals are missed', rep.exec.missedPct.toFixed(0) + '% of paper trades never filled (price ran away or expired).', 'Signal arrives late versus the move. Check scan frequency (auto-scan on, battery unrestricted) before touching the strategy.', paper.length);
    if (rep.exec.gross > 0 && rep.exec.charges / rep.exec.gross > 0.4 && closed.length >= MIN_N) add('Charges eat the profit', 'Charges are ' + (rep.exec.charges / rep.exec.gross * 100).toFixed(0) + '% of gross profit.', 'Trade only the best setups (min score 5) and avoid tiny-premium or 1-lot trades with low reward.', closed.length);
    if (closed.length >= MIN_N && rep.exec.timeExitPct > 50) add('Most trades end on the time exit', rep.exec.timeExitPct.toFixed(0) + '% exit by time (45 min / end of day), not by stop or target. Targets may be too far.', 'Backtest: compare a 1.5R target vs 2R. In real trading, consider booking at T1 sooner.', closed.length);
    const s33 = rep.shadow.find((x) => x.v === 33), s25 = rep.shadow.find((x) => x.v === 25);
    if (s33 && s25 && s25.n >= 15 && s33.avg - s25.avg > 3) add('A wider stop may be better', 'Over ' + s25.n + ' trades, a 33% stop averages ' + sign(s33.avg) + '% vs ' + sign(s25.avg) + '% for the 25% stop.', 'A wider stop means fewer lots (risk per lot grows). Test in paper before changing the 25% default.', s25.n);
    if (rep.slThenUp.n >= 10 && rep.slThenUp.up / rep.slThenUp.n > 0.4) add('Stops are often hit, then price recovers', rep.slThenUp.up + ' of ' + rep.slThenUp.n + ' stop-outs recovered above entry within 45 min.', 'Look at index-based exit (EMA20) instead of premium % stop. Needs more data.', rep.slThenUp.n);
    if (rep.journal.losses >= 5 && rep.journal.lossWithMistake / rep.journal.losses > 0.3) add('Mistakes, not the strategy, cause many real losses', rep.journal.lossWithMistake + ' of ' + rep.journal.losses + ' real-trade losses have a mistake tag (early exit, moved SL, revenge...).', 'Fix discipline first: follow the SL and T1 exactly. No strategy change needed for this.', rep.journal.losses);
    if (rep.nt.scans > 50) {
      const top = rep.nt.top[0];
      if (top && top.n / rep.nt.scans > 0.5) add('One gate blocks most scans', '"' + top.r + '" caused ' + Math.round(top.n * 100 / rep.nt.scans) + '% of all No-Trade scans.', 'This is normal for a selective bot. Only loosen a gate if paper trades show the blocked setups would have worked, which we cannot see yet.', rep.nt.scans);
    }
    if (rep.tierB.n >= SOLID_N && rep.n >= 10 && rep.tierB.avgR > 0.1 && rep.tierB.avgR + 0.05 >= rep.all.avgR) add('Tier B setups perform like Tier A', 'Tier B ' + sign(rep.tierB.avgR) + 'R over ' + rep.tierB.n + ' trades vs Tier A ' + sign(rep.all.avgR) + 'R over ' + rep.n + '.', 'Backtest A/B: lower the minimum score to 3 and compare. Only then consider more signals per day.', rep.tierB.n);
    if (rep.tierB.n >= SOLID_N && rep.tierB.avgR < 0) add('Tier B setups lose', 'Tier B averages ' + sign(rep.tierB.avgR) + 'R over ' + rep.tierB.n + ' trades.', 'Do not lower the threshold. Keep Tier B as watch-only.', rep.tierB.n);
    const ak = (rep.agent || []).find((g) => g.verdict === 'TAKE'), as = (rep.agent || []).filter((g) => g.verdict !== 'TAKE'), asn = as.reduce((a, g) => a + g.n, 0);
    if (ak && ak.n >= 15 && asn >= 15) { const sa = as.reduce((a, g) => a + g.avgR * g.n, 0) / asn; if (ak.avgR - sa > 0.3) add('AI SKIP/WAIT calls avoided weaker trades', 'TAKE ' + sign(ak.avgR) + 'R (' + ak.n + ') vs SKIP/WAIT ' + sign(sa) + 'R (' + asn + ').', 'Consider following the AI veto in paper first, then in real trades. Keep size rules unchanged.', ak.n + asn); }
    if (!S.length) S.push({ title: 'No clear pattern yet', why: 'Nothing in the data passes the minimum-sample checks.', test: 'Keep paper trading. Re-run this report weekly.', n: rep.n, strength: 'n/a' });

    rep.text = L.toText(rep, data);
    return rep;
  };

  L.toText = function (r, data) {
    const cfg = data.cfg || {}, o = [];
    const line = (s) => o.push(s);
    line('SIGNALBOT LEARNING REPORT');
    line('Generated: ' + new Date((data.now || Date.now()) + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16) + ' IST');
    line('Settings: capital Rs ' + (cfg.capital || '-') + ', risk ' + (cfg.riskPct || '-') + '%, breakout-confirm ' + (cfg.flConfirm ? 'on' : 'off') + ', sideways-filter ' + (cfg.flRegime ? 'on' : 'off') + ', retest-filter ' + (cfg.flRetest ? 'on' : 'off'));
    line('');
    line('1) OVERALL (paper trades)');
    line('Created ' + r.created + ' | closed ' + r.n + ' | missed ' + r.missed);
    if (r.n) {
      line('Win rate ' + f1(r.all.win) + '% | avg R ' + sign(r.all.avgR) + (r.all.se != null ? ' +/- ' + f2(r.all.se) : '') + ' | net P&L Rs ' + Math.round(r.all.net));
      if (r.be != null) line('Avg win ' + f2(r.aw) + 'R, avg loss ' + f2(r.al) + 'R -> realised break-even win rate ' + f1(r.be) + '%');
      line('Charges Rs ' + Math.round(r.exec.charges) + ' vs gross Rs ' + Math.round(r.exec.gross) + ' | avg slippage ' + f2(r.exec.avgSlip) + '% | time/EOD exits ' + f1(r.exec.timeExitPct) + '%');
    }
    r.warnings.forEach((w) => line('WARNING: ' + w));
    line('');
    const sec = (title, arr) => { if (!arr.length) return; line(title); arr.forEach((g) => line('  ' + g.k + ': n=' + g.n + ', win ' + f1(g.win) + '%, avg ' + sign(g.avgR) + 'R, net Rs ' + Math.round(g.net) + (g.n < MIN_N ? '  (too few)' : ''))); };
    line('Tier B (weaker setups, paper only): closed ' + r.tierB.n + (r.tierB.n ? ', win ' + f1(r.tierB.win) + '%, avg ' + sign(r.tierB.avgR) + 'R, net Rs ' + Math.round(r.tierB.net) : ''));
    line('');
    line('2) BREAKDOWNS (Tier A)');
    sec('By entry time:', r.by.hour); sec('By side:', r.by.side); sec('By index:', r.by.index); sec('By exit reason:', r.by.exit);
    sec('By expiry day:', r.by.expiry); sec('By score:', r.by.score); sec('By VIX:', r.by.vix); sec('By PCR:', r.by.pcr);
    line('');
    line('3) SHADOW STOPS (45 min after fill)');
    if (r.shadow.length && r.shadow[0].n) r.shadow.forEach((s) => line('  SL ' + s.v + '%: hit ' + s.hit + '/' + s.n + ', avg ' + sign(s.avg) + '%'));
    else line('  No data yet.');
    if (r.slThenUp.n) line('  Stop-outs that recovered above entry: ' + r.slThenUp.up + '/' + r.slThenUp.n);
    line('');
    line('4) REAL TRADES (journal) AND MISTAKES');
    line('Closed ' + r.journal.n + ' | net Rs ' + Math.round(r.journal.net) + ' | losses with a mistake tag ' + r.journal.lossWithMistake + '/' + r.journal.losses);
    Object.keys(r.journal.mistakes).forEach((k) => line('  ' + k + ': ' + r.journal.mistakes[k].n + ' trades, Rs ' + Math.round(r.journal.mistakes[k].pnl)));
    line('');
    line('4b) AI AGENT OPINION vs RESULT (Tier A paper trades; the paper trade runs whatever the AI said)');
    if (r.agent && r.agent.length) r.agent.forEach((g) => line('  ' + g.verdict + ': n=' + g.n + ', win ' + f1(g.win) + '%, avg ' + sign(g.avgR) + 'R' + (g.n < MIN_N ? '  (too few)' : '')));
    else line('  No AI opinions with closed trades yet.');
    line('');
    line('5) WHY THE APP SAID NO TRADE (' + r.nt.days + ' days, ' + r.nt.scans + ' scans)');
    r.nt.top.forEach((x) => line('  ' + x.n + 'x ' + x.r));
    line('');
    line('6) SUGGESTIONS (not applied automatically; test first)');
    r.suggestions.forEach((s, i) => { line((i + 1) + '. ' + s.title + ' [' + s.strength + ', n=' + s.n + ']'); line('   Evidence: ' + s.why); line('   How to test: ' + s.test); });
    line('');
    const rows = (data.paper || []).filter((t) => t.state === 'CLOSED' && t.fillAt).slice(0, 60);
    line('7) RAW CLOSED TRADES (latest ' + rows.length + '): date tier idx opt entryTime score vix R exit slip%');
    rows.forEach((t) => { const c = t.ctx || {}; line([t.date, t.tier || 'A', t.idxName, t.option, new Date(t.fillAt + 330 * 60000).toISOString().slice(11, 16), c.score == null ? '-' : c.score, c.vix == null ? '-' : f1(c.vix), f2(t.r), t.exitWhy, t.signalPrice > 0 ? f2(t.slippage / t.signalPrice * 100) : '-'].join(' ')); });
    line('');
    line('Educational tool. Patterns from small samples are mostly luck. No accuracy is claimed.');
    return o.join('\n');
  };

  root.Learn = L;
  if (typeof module !== 'undefined') module.exports = L;
})(typeof window !== 'undefined' ? window : globalThis);
