/* Pure-JS TOTP (RFC 6238, SHA-1). No crypto.subtle needed, so it works in file:// WebView. */
(function (root) {
  const T = {};
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  function sha1(msg) {
    const l = msg.length, ml = l * 8, padLen = ((l + 9 + 63) >> 6) << 6;
    const b = new Uint8Array(padLen); b.set(msg); b[l] = 0x80;
    const dv = new DataView(b.buffer);
    dv.setUint32(padLen - 8, Math.floor(ml / 4294967296)); dv.setUint32(padLen - 4, ml >>> 0);
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80);
    for (let i = 0; i < padLen; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
      for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let a = h0, bb = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (bb & c) | (~bb & d); k = 0x5A827999; }
        else if (j < 40) { f = bb ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = bb ^ c ^ d; k = 0xCA62C1D6; }
        const t = (rol(a, 5) + f + e + k + w[j]) >>> 0;
        e = d; d = c; c = rol(bb, 30) >>> 0; bb = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20), o = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => o.setUint32(i * 4, h));
    return out;
  }
  function hmac(key, msg) {
    if (key.length > 64) key = sha1(key);
    const k = new Uint8Array(64); k.set(key);
    const ip = new Uint8Array(64 + msg.length), op = new Uint8Array(64 + 20);
    for (let i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    ip.set(msg, 64); op.set(sha1(ip), 64);
    return sha1(op);
  }
  function b32(s) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    s = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, val = 0; const out = [];
    for (const ch of s) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    return new Uint8Array(out);
  }
  T.code = function (secret, nowMs, digits) {
    digits = digits || 6;
    const ctr = Math.floor((nowMs || Date.now()) / 30000);
    const m = new Uint8Array(8); const dv = new DataView(m.buffer);
    dv.setUint32(0, Math.floor(ctr / 4294967296)); dv.setUint32(4, ctr >>> 0);
    const h = hmac(b32(secret), m), off = h[19] & 15;
    const n = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % Math.pow(10, digits);
    return String(n).padStart(digits, '0');
  };
  root.TOTP = T;
  if (typeof module !== 'undefined') module.exports = T;
})(typeof window !== 'undefined' ? window : globalThis);
