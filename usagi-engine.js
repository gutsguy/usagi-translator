/*
 * 우사기어 엔진 (웹 / 안드로이드 / iOS 공용, 의존성 없음)
 *
 *   한국어 --(한국어 글자 모델로 산술부호화)--> [0,1) 위의 구간
 *         --(우사기 말투 모델로 그 구간 안을 가리키는 단어열 생성)--> 우사기어
 *   해독은 정확히 거꾸로. 비밀번호는 매 글자마다 한국어 글자의 배치 순서를 섞는다.
 *
 * 모든 기기에서 비트 단위로 같은 결과가 나와야 하므로
 *   - 확률 계산은 2^53 미만 정수만 쓰고 (나눗셈은 floor, 이 범위에선 정확)
 *   - 구간은 BigInt 이진 분수로 정확히 계산한다.
 *
 * 사용법:
 *   const engine = UsagiEngine.load(arrayBufferOfKoreanBin);
 *   engine.encode("뭐함", { password: "당근" })   // -> "우나 야하야하 ..."
 *   engine.decode("우나 야하야하 ...", { password: "당근" })
 */
(function (root) {
  'use strict';

  // ---------------- 우사기 단어 (실측 빈도 기반 가중치, 꾸밈 표기) ----------------
  // 순서와 숫자를 바꾸면 이전에 만든 우사기어를 풀 수 없게 된다 (FORMAT_VERSION 올릴 것)
  const USAGI = [
    ['야하', 143, { '야하': 111, '야하!': 16, '야하~': 9, '야-하': 4, '야하!!': 3 }],
    ['얏하', 23, { '얏하': 17, '얏하!': 3, '얏하~': 3 }],
    ['이야하', 23, { '이야하': 22, '이~야~하~': 1 }],
    ['이얏하', 11, { '이얏하': 6, '이얏하!': 5 }],
    ['야하야하', 53, { '야하야하': 44, '야하야하~': 6, '야하야하!': 3 }],
    ['우나', 107, { '우나': 78, '우나~': 13, '우나!': 8, '우-나': 4, '우~나': 3, '우~나~': 1 }],
    ['우나나', 36, { '우나나': 32, '우나나~': 2, '우나나!': 2 }],
    ['우나우나', 9, { '우나우나': 9 }],
    ['우라', 62, { '우라': 46, '우라~': 7, '우라!': 7, '우라?': 2 }],
    ['하아?', 45, { '하아?': 25, '하아~?': 12, '하아??': 2, '하아???': 4, '하아-?': 2 }],
    ['하?', 18, { '하?': 12, '하~?': 6 }],
    ['하!', 20, { '하!': 20 }],
    ['뿌릿', 78, { '뿌릿': 63, '뿌릿!': 11, '뿌릿~': 2, '쁘륏': 12 }],
    ['푸루', 14, { '푸루': 14 }],
    ['츠츠우라우라', 9, { '츠츠우라우라': 6, '쯔쯔우라우라': 3 }],
    ['이야', 40, { '이야': 30, '이~야': 8, '이-야': 6, '이~야~': 4, '이야~': 3, '이야!': 2 }],
    ['우!', 20, { '우!': 20 }],
    ['야!', 16, { '야!': 16 }],
    ['우!야!이!하!', 5, { '우!야!이!하!': 5 }],
    ['후웅', 3, { '후웅': 1, '후웅~': 1 }],
  ];
  const FORMAT_VERSION = 1;
  const WORDS = USAGI.map((u) => u[0]);
  const WORD_ID = new Map(WORDS.map((w, i) => [w, i]));
  const WORD_ORDER = WORDS.map((_, i) => i);
  const NORMAL = new Map(); // 꾸밈 표기 -> 단어 id
  USAGI.forEach(([, , variants], i) => {
    for (const v of Object.keys(variants)) {
      if (NORMAL.has(v)) throw new Error('꾸밈 표기 중복: ' + v);
      NORMAL.set(v, i);
    }
  });

  const K_BITS = 20;   // 한국어 글자 확률 총합 2^20
  const U_BITS = 12;   // 우사기 단어 확률 총합 2^12
  const CP_BITS = 21;  // 사전에 없는 글자의 코드포인트
  const WB_SCALE = 16777216; // 2^24, Witten-Bell 고정소수점
  const MAX_DECODE = 500;

  // 정수 가중치 g를 총합 2^bits인 정수 빈도로 (모두 1 이상)
  function normalize(g, bits) {
    const n = g.length, tot = 2 ** bits, avail = tot - n;
    let G = 0, best = 0, sum = 0;
    for (let a = 0; a < n; a++) G += g[a];
    const f = new Uint32Array(n);
    for (let a = 0; a < n; a++) {
      f[a] = 1 + Math.floor((g[a] * avail) / G);
      sum += f[a];
      if (g[a] > g[best]) best = a;
    }
    f[best] += tot - sum;
    return f;
  }

  // ---------------- 우사기 말투 모델 ----------------
  const uCache = new Map();
  function usagiFreqs(prev) { // prev: 이전 단어 id 또는 -1
    if (uCache.has(prev)) return uCache.get(prev);
    const g = USAGI.map((u) => u[1] * 10);
    if (prev === WORD_ID.get('우나')) g[WORD_ID.get('야하')] *= 4;      // 우나 다음엔 야하가 잘 옴
    if (prev === WORD_ID.get('우나나')) g[WORD_ID.get('야하야하')] *= 4;
    if (prev >= 0) g[prev] = Math.max(1, Math.floor(g[prev] / 3));     // 같은 단어 연속은 줄임
    const f = normalize(g, U_BITS);
    uCache.set(prev, f);
    return f;
  }

  // ---------------- 구간 (BigInt 이진 분수: [lo, lo+w) / 2^sh) ----------------
  function narrow(st, cum, f, bits) {
    st.lo = (st.lo << BigInt(bits)) + st.w * BigInt(cum);
    st.w = st.w * BigInt(f);
    st.sh += bits;
  }

  // 점 P/2^psh가 st 안에서 2^bits 칸 중 몇 번째 칸에 있는지
  function locate(st, P, psh, bits) {
    let lo = st.lo, w = st.w, p = P;
    if (psh > st.sh) { const d = BigInt(psh - st.sh); lo <<= d; w <<= d; }
    else if (psh < st.sh) p <<= BigInt(st.sh - psh);
    return Number(((p - lo) << BigInt(bits)) / w);
  }

  function within(u, k) {
    const s = Math.max(u.sh, k.sh);
    const du = BigInt(s - u.sh), dk = BigInt(s - k.sh);
    const ul = u.lo << du, kl = k.lo << dk;
    return ul >= kl && ul + (u.w << du) <= kl + (k.w << dk);
  }

  function findSym(f, order, v) {
    let cum = 0;
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      if (cum + f[s] > v) return [s, cum];
      cum += f[s];
    }
    throw new Error('locate 범위 오류');
  }

  function cumOf(f, order, sym) {
    let cum = 0;
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      if (s === sym) return cum;
      cum += f[s];
    }
    throw new Error('기호 없음');
  }

  // ---------------- SHA-256 / HMAC (비밀번호 섞기용) ----------------
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(bytes) {
    const len = bytes.length, padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const bitLen = len * 8, dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function utf8(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function hmacSha256(key, msg) {
    if (key.length > 64) key = sha256(key);
    const k = new Uint8Array(64); k.set(key);
    const inner = new Uint8Array(64 + msg.length), outer = new Uint8Array(96);
    for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
    inner.set(msg, 64);
    outer.set(sha256(inner), 64);
    return sha256(outer);
  }

  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return t >>> 0;
    };
  }

  // ---------------- 한국어 글자 모델 ----------------
  function parseModel(buf) {
    const b = new Uint8Array(buf);
    let p = 0;
    const rd = () => {
      let n = 0, mul = 1, x;
      do { x = b[p++]; n += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80);
      return n;
    };
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'USG1') throw new Error('모델 파일 형식이 아님');
    p = 4;
    const version = rd(), V = rd();
    const alpha = [];
    for (let i = 0; i < V; i++) alpha.push(String.fromCodePoint(rd()));
    const entries = () => {
      const n = rd(), syms = new Uint16Array(n), cnt = new Float64Array(n);
      let prev = 0, N = 0;
      for (let i = 0; i < n; i++) { prev += rd(); syms[i] = prev; cnt[i] = rd(); N += cnt[i]; }
      return { syms, cnt, N, T: n };
    };
    const table = () => {
      const m = new Map(), n = rd();
      let prev = 0;
      for (let i = 0; i < n; i++) { prev += rd(); m.set(prev, entries()); }
      return m;
    };
    const o0 = entries(), o1 = table(), o2 = table();
    return { version, V, alpha, o0, o1, o2 };
  }

  function Engine(model) {
    const { V, alpha, o0, o1, o2 } = model;
    const EOS = V - 2, ESC = V - 1, BOS = V;
    const charId = new Map();
    alpha.forEach((ch, i) => { if (i < V - 2) charId.set(ch, i); });
    const identity = new Uint16Array(V).map((_, i) => i);
    const kCache = new Map();

    function koreanFreqs(p1, p2) {
      const key = p1 * (V + 1) + p2;
      const hit = kCache.get(key);
      if (hit) return hit;
      let g = new Float64Array(V).fill(Math.floor(WB_SCALE / V));
      const num = new Float64Array(V);
      for (const tab of [o0, o1.get(p2), o2.get(key)]) {
        if (!tab) continue;
        const D = tab.N + tab.T;
        for (let a = 0; a < V; a++) num[a] = tab.T * g[a];
        for (let i = 0; i < tab.syms.length; i++) num[tab.syms[i]] += tab.cnt[i] * WB_SCALE;
        for (let a = 0; a < V; a++) g[a] = Math.floor(num[a] / D);
      }
      const f = normalize(g, K_BITS);
      if (kCache.size > 20000) kCache.clear();
      kCache.set(key, f);
      return f;
    }

    function order(pwKey, step, p1, p2) {
      if (!pwKey) return identity;
      const d = hmacSha256(pwKey, utf8(step + '|' + (p1 * (V + 1) + p2)));
      const dv = new DataView(d.buffer);
      const rnd = sfc32(dv.getUint32(0), dv.getUint32(4), dv.getUint32(8), dv.getUint32(12));
      for (let i = 0; i < 12; i++) rnd();
      const o = identity.slice();
      for (let i = V - 1; i > 0; i--) {
        const j = Math.floor((rnd() * (i + 1)) / 4294967296);
        const t = o[i]; o[i] = o[j]; o[j] = t;
      }
      return o;
    }

    const pwBytes = (pw) => (pw ? utf8(pw) : null);

    function koreanInterval(text, pw) {
      const key = pwBytes(pw);
      const st = { lo: 0n, w: 1n, sh: 0 };
      let p1 = BOS, p2 = BOS, step = 0;
      const put = (sym) => {
        const f = koreanFreqs(p1, p2);
        narrow(st, cumOf(f, order(key, step, p1, p2), sym), f[sym], K_BITS);
        step++;
      };
      for (const ch of text) {
        const id = charId.get(ch);
        if (id !== undefined) { put(id); p1 = p2; p2 = id; }
        else { put(ESC); narrow(st, ch.codePointAt(0), 1, CP_BITS); }
      }
      put(EOS);
      return st;
    }

    function koreanFromPoint(P, psh, pw) {
      const key = pwBytes(pw);
      const st = { lo: 0n, w: 1n, sh: 0 };
      let p1 = BOS, p2 = BOS, step = 0, out = '', n = 0, complete = false;
      while (n < MAX_DECODE) {
        const f = koreanFreqs(p1, p2), o = order(key, step, p1, p2);
        const [s, cum] = findSym(f, o, locate(st, P, psh, K_BITS));
        narrow(st, cum, f[s], K_BITS);
        step++;
        if (s === EOS) { complete = true; break; }
        if (s === ESC) {
          const cp = locate(st, P, psh, CP_BITS);
          narrow(st, cp, 1, CP_BITS);
          out += cp < 0x110000 && !(cp >= 0xd800 && cp < 0xe000) ? String.fromCodePoint(cp) : '?';
        } else {
          out += alpha[s]; p1 = p2; p2 = s;
        }
        n++;
      }
      return { text: out, complete };
    }

    function pickVariant(word, rng) {
      const vs = USAGI[word][2], keys = Object.keys(vs);
      let total = 0;
      for (const k of keys) total += vs[k];
      let r = rng() * total;
      for (const k of keys) { r -= vs[k]; if (r < 0) return k; }
      return keys[keys.length - 1];
    }

    // 우사기어 단어 id 배열 (꾸밈 전)
    function encodeWords(text, pw) {
      const k = koreanInterval(text, pw);
      const P = (k.lo << 1n) + k.w, psh = k.sh + 1; // 한국어 구간의 중점
      const u = { lo: 0n, w: 1n, sh: 0 };
      const words = [];
      let prev = -1;
      while (!within(u, k)) {
        const f = usagiFreqs(prev);
        const [wd, cum] = findSym(f, WORD_ORDER, locate(u, P, psh, U_BITS));
        narrow(u, cum, f[wd], U_BITS);
        words.push(wd);
        prev = wd;
      }
      return { words, bits: k.sh - log2Big(k.w) };
    }

    function parseUsagi(text) {
      const toks = text.trim().split(/\s+/).filter(Boolean);
      const ids = [], unknown = [];
      for (const t of toks) {
        const id = NORMAL.get(t);
        if (id === undefined) unknown.push(t); else ids.push(id);
      }
      return { ids, unknown };
    }

    return {
      model: { chars: V, version: model.version },

      /** 한국어 -> 우사기어. opts: { password, rng } */
      encode(text, opts = {}) {
        const rng = opts.rng || Math.random;
        const { words } = encodeWords(text, opts.password);
        return words.map((w) => pickVariant(w, rng)).join(' ');
      },

      /** 우사기어 -> 한국어. 우사기 단어가 아닌 토큰이 있으면 오류 */
      decode(usagi, opts = {}) {
        const r = this.decodeDetailed(usagi, opts);
        if (r.unknown.length) throw new Error('우사기어가 아닌 단어: ' + r.unknown.join(', '));
        return r.text;
      },

      /** { text, complete(문장 끝까지 정상 해독됐는지), unknown(모르는 토큰) } */
      decodeDetailed(usagi, opts = {}) {
        const { ids, unknown } = parseUsagi(usagi);
        if (unknown.length || !ids.length) return { text: '', complete: false, unknown };
        const u = { lo: 0n, w: 1n, sh: 0 };
        let prev = -1;
        for (const id of ids) {
          const f = usagiFreqs(prev);
          narrow(u, cumOf(f, WORD_ORDER, id), f[id], U_BITS);
          prev = id;
        }
        const r = koreanFromPoint((u.lo << 1n) + u.w, u.sh + 1, opts.password);
        return { text: r.text, complete: r.complete, unknown };
      },

      /** 입력이 전부 우사기 단어(꾸밈 포함)인지 */
      isUsagi(text) {
        const { ids, unknown } = parseUsagi(text);
        return ids.length > 0 && unknown.length === 0;
      },

      /** 원문의 정보량(bit)과 우사기 단어 수 */
      measure(text, opts = {}) {
        const r = encodeWords(text, opts.password);
        return { bits: r.bits, words: r.words.length };
      },
    };
  }

  function log2Big(x) {
    const s = x.toString(16);
    return (s.length - 1) * 4 + Math.log2(parseInt(s[0], 16) + (s.length > 1 ? parseInt(s.slice(1, 13).padEnd(12, '0'), 16) / 2 ** 48 : 0));
  }

  const api = {
    FORMAT_VERSION,
    WORDS,
    variants: (word) => Object.keys(USAGI[WORD_ID.get(word)][2]),
    load(buf) { return Engine(parseModel(buf)); },
    _internal: { sha256, hmacSha256, utf8, normalize },
  };
  root.UsagiEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
