/* Request guard: keeps the app far below broker rate limits.
   - cache with per-call TTL (scan, chart and trade-manager share results)
   - in-flight dedupe (same URL asked twice at once = one network call)
   - minimum gap between real network sends (smooths bursts)
   - rolling budget (per minute and per 30 min); low-priority calls (chart) get only part of it
   - HTTP 429 / "too many requests": automatic pause with growing backoff
   Limits are deliberately set well under Upstox's published limits (verify on Upstox docs). */
(function (root) {
  const G = {};
  G.create = function (o) {
    const send = o.send, now = o.now || (() => Date.now()), sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const cfg = Object.assign({ minGapMs: 150, perMin: 90, per30: 1200, lowShare: 0.5, backoffStart: 20000, backoffMax: 300000 }, o.limits || {});
    const cache = new Map(), inflight = new Map(), stamps = [];
    let lastSend = 0, pausedUntil = 0, backoff = 0, n429 = 0, nCache = 0, nSent = 0;

    const prune = (t) => { while (stamps.length && t - stamps[0] > 1800000) stamps.shift(); };
    const used = (t, win) => { let c = 0; for (let i = stamps.length - 1; i >= 0 && t - stamps[i] <= win; i--) c++; return c; };
    const fail = (msg, code) => { const e = new Error(msg); e.guard = code; return e; };
    const is429 = (e) => e && (e.status === 429 || /\b429\b|too many requests|rate limit/i.test(e.message || ''));

    async function get(key, opt) {
      opt = opt || {};
      const t0 = now(), ttl = opt.ttl || 0, low = opt.prio === 'low';
      const hit = cache.get(key);
      if (hit && ttl > 0 && t0 - hit.t <= ttl) { nCache++; return hit.v; }
      if (inflight.has(key)) return inflight.get(key);
      if (t0 < pausedUntil) {
        if (hit && opt.staleOk) return hit.v;
        throw fail('Broker ne rok lagayi (rate limit). ' + Math.ceil((pausedUntil - t0) / 1000) + ' sec mein apne aap dobara try hoga.', 'paused');
      }
      prune(t0);
      const um = used(t0, 60000), u30 = used(t0, 1800000);
      const capM = low ? cfg.perMin * cfg.lowShare : cfg.perMin, cap30 = low ? cfg.per30 * cfg.lowShare : cfg.per30;
      if (um >= capM || u30 >= cap30) {
        if (hit && opt.staleOk) return hit.v;
        throw fail('Request budget poora (' + um + '/min). Thodi der baad apne aap chalega.', 'budget');
      }
      // reserve a send slot now, so parallel callers are spaced out
      const wait = Math.max(0, lastSend + cfg.minGapMs - t0);
      lastSend = t0 + wait;
      stamps.push(t0 + wait);
      const p = (async () => {
        await Promise.resolve(); // let inflight.set run before any synchronous failure
        if (wait) await sleep(wait);
        try {
          nSent++;
          const v = await send(key);
          backoff = 0;
          if (ttl > 0) cache.set(key, { t: now(), v });
          return v;
        } catch (e) {
          if (is429(e)) {
            n429++;
            backoff = backoff ? Math.min(backoff * 2, cfg.backoffMax) : cfg.backoffStart;
            pausedUntil = now() + backoff;
          }
          throw e;
        } finally { inflight.delete(key); }
      })();
      inflight.set(key, p);
      return p;
    }
    return {
      get,
      clear() { cache.clear(); },
      stats() {
        const t = now(); prune(t);
        return { perMin: used(t, 60000), per30: used(t, 1800000), capMin: cfg.perMin, cap30: cfg.per30, paused: t < pausedUntil, pausedSec: Math.max(0, Math.ceil((pausedUntil - t) / 1000)), n429, nCache, nSent };
      },
      _cfg: cfg,
    };
  };
  root.Guard = G;
  if (typeof module !== 'undefined') module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
