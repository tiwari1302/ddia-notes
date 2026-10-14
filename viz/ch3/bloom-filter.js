// Bloom filter (DDIA ch3): every key sets k bits of an m-bit array and a lookup checks the same
// k bits. A single 0 proves the key is absent; all 1s only means "maybe", because other keys may
// have set those bits (a false positive). The reader inserts and queries keys, tunes m and k,
// compares the observed false-positive rate with (1 - e^(-kn/m))^k, and sees why a key can't be
// deleted: its bits may be shared with other keys.
(function () {
  "use strict";

  const VOCAB = ["apple", "banana", "cherry", "date", "fig", "grape", "kiwi", "lemon",
    "lime", "mango", "melon", "olive", "peach", "pear", "plum", "quince"];

  // ---------------- Pure model (no DOM) ----------------
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) + str.charCodeAt(i)) >>> 0;
    return h;
  }
  // murmur3's finalizer. With m <= 64 only the low bits survive "mod m", and these toy hashes have
  // weak low bits (djb2 mod 32 is just a sum of char codes): without mixing, keys land on runs like
  // 16, 17, 18 and the observed false-positive rate drifts far from the formula.
  function fmix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  /** Bit positions of a key: double hashing g_i = h1 + i*h2 (Kirsch–Mitzenmacher), mixed, mod m.
   *  As with independent hash functions, two of a key's k positions can coincide. */
  function positions(word, m, k) {
    const h1 = fnv1a(word), h2 = (djb2(word) | 1) >>> 0;
    return Array.from({ length: k }, (_, i) => fmix32((h1 + Math.imul(i, h2)) >>> 0) % m);
  }
  /** owners[p] = inserted keys that set bit p; bit p is 1 exactly when owners[p] is non-empty. */
  function ownersOf(words, m, k) {
    const own = Array.from({ length: m }, () => []);
    words.forEach(w => new Set(positions(w, m, k)).forEach(p => own[p].push(w)));
    return own;
  }
  /** "no" if any probed bit is 0, else "tp" for an inserted key and "fp" for an absent one. */
  function lookup(word, words, m, k, own = ownersOf(words, m, k)) {
    if (positions(word, m, k).some(p => !own[p].length)) return "no";
    return words.includes(word) ? "tp" : "fp";
  }
  const predictedFPR = (m, k, n) => (n ? Math.pow(1 - Math.exp((-k * n) / m), k) : 0);
  const bestK = (m, n) => Math.max(1, Math.round((m / n) * Math.LN2));
  function queryAll(words, m, k) {
    const own = ownersOf(words, m, k), fp = [], tn = [];
    VOCAB.filter(w => !words.includes(w)).forEach(w => (lookup(w, words, m, k, own) === "fp" ? fp : tn).push(w));
    return { fp, tn, tp: words.filter(w => lookup(w, words, m, k, own) === "tp").length };
  }

  // ---------------- Text helpers ----------------
  const uniq = a => [...new Set(a)];
  const list = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  const bitsPhrase = ps => (ps.length === 1 ? "bit " : "bits ") + list(ps.map(String));
  const cap = str => str[0].toUpperCase() + str.slice(1);
  // One decimal, but never "0.0%" for a rate that isn't zero.
  const pct = f => (f === 0 || f >= 0.001 ? (f * 100).toFixed(1) + "%" : f >= 0.0001 ? (f * 100).toFixed(2) + "%" : "< 0.01%");
  const toneFPR = f => (f < 0.05 ? "ok" : f < 0.2 ? "warn" : "bad");
  const b = w => `<b>${w}</b>`;
  const sub = t => `<div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:1px">${t}</div>`;
  const SATURATED = "The filter is saturated: most bits are 1, so nearly every query says “maybe”. " +
    "Give it more bits per key or fewer keys.";

  Viz.register("ch3/bloom-filter", {
    title: "Bloom filter: definitely not, or maybe",
    model: { VOCAB, positions, ownersOf, lookup, predictedFPR, bestK, queryAll },
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const V = c => `var(--viz-${c})`;
      const rng = ctx.random(11);
      // Default set: of the 12 absent words exactly one (lime) is a false positive at m = 32, k = 3, so
      // querying absent words one by one does turn one up, and Try to delete peach hits a shared bit.
      const S = { words: ["apple", "fig", "kiwi", "peach"], m: 32, k: 3, mode: "query", last: null, all: null, note: ["", "info"] };
      let compact, view, epoch = 0;

      // ---------------- What the current action shows ----------------
      function analyze(last, own) {
        const pos = positions(last.word, S.m, S.k);
        const groups = uniq(pos).sort((x, y) => x - y).map(p => ({
          p, hs: pos.map((x, i) => (x === p ? "h" + (i + 1) : "")).filter(Boolean).join(","),
          set: own[p].length > 0, others: own[p].filter(w => w !== last.word),
        }));
        const A = { type: last.type, word: last.word, dup: last.dup, groups };
        if (A.type === "query") A.result = groups.some(g => !g.set) ? "no" : S.words.includes(A.word) ? "tp" : "fp";
        if (A.type === "remove") A.shared = groups.filter(g => g.others.length);
        return A;
      }
      function styleOf(A, g) {
        if (A.type === "query") return g.set ? { c: "ok", w: 2 } : { c: "bad", w: 2.5 };
        if (A.type === "insert") return { c: "c6", w: 2, ring: g.others.length ? "warn" : "c6" };
        return g.others.length ? { c: "bad", w: 2.5, ringW: 3.5 } : { c: "c6", w: 2, dashed: true };
      }
      function verdictOf(A) {
        if (!A) return S.words.length ? null : { a: "Empty filter:", b: "every query says DEFINITELY NOT", tone: "muted" };
        const w = A.word;
        if (A.type === "query") return {
          no: { a: "DEFINITELY NOT", b: "in the set", tone: "ok" },
          tp: { a: "Maybe present:", b: "true positive", tone: "ok" },
          fp: { a: "FALSE POSITIVE:", b: "every bit was set by other keys", tone: "bad" },
        }[A.result];
        if (A.type === "insert") return A.dup ? { a: `${w} is already`, b: "in the set", tone: "info" }
          : { a: `Inserted ${w}:`, b: (A.groups.length > 1 ? "bits " : "bit ") + A.groups.map(g => g.p).join(", "), tone: "info" };
        if (!A.shared.length) return { a: `Deleting ${w} looks safe now,`, b: "but the filter can't know that", tone: "warn" };
        const sh = A.shared.map(g => g.p);
        return { a: `Can't delete ${w}:`, tone: "bad",
          b: `${bitsPhrase(sh)} ${sh.length > 1 ? "are" : "is"} shared with ${list(uniq(A.shared.flatMap(g => g.others)))}` };
      }
      function noteFor(A) {
        const w = b(A.word), k = S.k, G = A.groups;
        if (A.type === "query") {
          if (A.result === "no") {
            const zeros = G.filter(g => !g.set).map(g => g.p), ones = G.filter(g => g.set).map(g => g.p);
            return [`${cap(bitsPhrase(zeros))} ${zeros.length > 1 ? "are" : "is"} 0, so ${w} was never inserted` +
              (ones.length ? ` (${bitsPhrase(ones)} ${ones.length > 1 ? "are" : "is"} 1, but a single 0 is enough)` : "") +
              ". A Bloom filter's “no” is always right, which is what lets an LSM-tree skip an SSTable without touching disk.", "ok"];
          }
          if (A.result === "tp") {
            const all = G.length === 1 ? `Bit ${G[0].p} is set` : `All ${G.length === k ? k + " bits" : "its bits"} are set`;
            return [`${all} and ${w} really is in the set. The filter can't tell this apart from a coincidence, ` +
              "which is why the answer is only “maybe”.", "ok"];
          }
          return [`False positive: ${w} was never inserted, but other keys set every bit it checks (` +
            G.map(g => `bit ${g.p} by ${list(g.others.map(b))}`).join("; ") +
            "). An LSM-tree would read this SSTable for nothing: a wasted disk read, never a wrong answer.", "bad"];
        }
        if (A.type === "insert") {
          if (A.dup) return [`${w} is already in the set: inserting it again sets the same bits, so nothing changes.`, "info"];
          const shared = G.filter(g => g.others.length);
          return [`Inserted ${w}: ${k > 1 ? `its ${k} hash functions set` : "its hash function sets"} ` +
            `${bitsPhrase(G.map(g => g.p))} to 1${G.length < k ? " (some picked the same bit)" : ""}.` +
            (shared.length ? ` ${cap(bitsPhrase(shared.map(g => g.p)))} ${shared.length > 1 ? "were" : "was"} already 1 ` +
              `(set by ${list(uniq(shared.flatMap(g => g.others)).map(b))}), so ${shared.length > 1 ? "those bits now serve" : "that bit now serves"} more than one key.` : ""),
          "info"];
        }
        if (!A.shared.length) {
          return [`None of ${w}'s bits is used by another key right now, so clearing them would happen to be safe. ` +
            "But the filter stores only bits, not keys, so it can't tell this case from one that breaks another key. " +
            "Standard Bloom filters are add-only.", "warn"];
        }
        const victims = uniq(A.shared.flatMap(g => g.others)), vs = list(victims.map(b));
        return [`Clearing ${w}'s bits would also clear ${bitsPhrase(A.shared.map(g => g.p))}, which ${vs} ` +
          `${victims.length > 1 ? "need" : "needs"}, so ${vs} would get a “definitely not”: a false negative, which a Bloom ` +
          "filter must never produce. Standard Bloom filters are add-only (counting Bloom filters and cuckoo filters can delete, " +
          "at extra cost). LSM-trees don't care: SSTables are immutable, and compaction builds a fresh filter for each new file.", "bad"];
      }

      // ---------------- Actions ----------------
      const own = () => ownersOf(S.words, S.m, S.k);
      const say = (html, tone) => { S.note = [html, tone]; };
      const show = last => { S.last = last; say(...noteFor(analyze(last, own()))); };

      function clickWord(w) {
        if (S.mode === "insert") {
          const dup = S.words.includes(w);
          if (!dup) { S.words.push(w); S.all = null; }
          show({ type: "insert", word: w, dup });
        } else show({ type: "query", word: w });
        render(true);
      }
      function doQueryAll() {
        const r = queryAll(S.words, S.m, S.k), absent = r.fp.length + r.tn.length, n = S.words.length;
        if (!absent) return;
        S.all = r;
        S.last = { type: "query", word: r.fp.length ? r.fp[r.fp.length - 1] : r.tn[r.tn.length - 1] };
        const fp = r.fp.length;
        say(`Observed <b>${fp}</b> false positive${fp === 1 ? "" : "s"} out of ${absent} absent keys (${pct(fp / absent)}); ` +
          `the formula predicts ${pct(predictedFPR(S.m, S.k, n))}` + (fp ? " (a small sample, so expect a gap). " +
            `The <b>FP</b> keys are the false positives; the last one is drawn above.` : ".") +
          (n ? ` All ${n} inserted keys answered “maybe”, as they must.` : "") +
          (fp ? "" : " Add keys or shrink m to make false positives appear."), fp ? "warn" : "ok");
        render(true);
      }
      function insertRandom() {
        const pool = VOCAB.filter(w => !S.words.includes(w)), picked = [];
        while (picked.length < 4 && pool.length) picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
        if (!picked.length) return;
        S.words.push(...picked);
        S.all = null;
        S.last = { type: "insert", word: picked[picked.length - 1] };
        const n = S.words.length;
        say(`Inserted ${list(picked.map(b))} at random: now ${n} keys in ${S.m} bits (${(S.m / n).toFixed(1)} bits per key). ` +
          "Press <b>Query all keys</b> to count the false positives.", "info");
        render(true);
      }
      function tryDelete() {
        if (!S.words.length) return;
        show({ type: "remove", word: S.words[S.words.length - 1] });
        render(true);
      }
      function clearAll() {
        S.words = []; S.all = null; S.last = null;
        say("Cleared the filter: every bit is 0, so every query answers “definitely not”. Switch to <b>Insert</b> to add keys.", "info");
        render(false);
      }
      function setMode(v) {
        S.mode = v;
        const k = S.k, hs = k > 1 ? `its ${k} hash functions set ${k} bits` : "its hash function sets 1 bit";
        say(v === "insert" ? `Insert mode: click a key to add it; ${hs} to 1.`
          : `Query mode: click any key to check its bits. Highlighted keys are in the set; any other key that comes back “maybe” is a false positive.`, "info");
        render(false);
      }
      function rebuild(m, k) {
        S.m = m; S.k = k; S.all = null;
        const n = S.words.length;
        let html = `Rebuilt the filter with m = ${m}, k = ${k} from the ${n} key${n === 1 ? "" : "s"} (filters are sized when they are built).`;
        if (n) {
          const bk = bestK(m, n), bpk = (m / n).toFixed(1);
          html += k === bk ? ` k = ${k} is the best choice for ${bpk} bits per key.` : ` For ${bpk} bits per key the best k is ${bk}: ` +
            (k < bk ? "fewer hash functions mean fewer bits to check, so a coincidence is likelier."
              : "more hash functions set more bits per key, so the array fills up faster.");
        }
        say(html, "info");
        render(false);
      }

      // ---------------- Layout ----------------
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const mSl = ui.slider({ label: "Bits (m)", min: 8, max: 64, step: 8, value: S.m, onInput: v => rebuild(v, S.k) });
        const kSl = ui.slider({ label: "Hash functions (k)", min: 1, max: 6, value: S.k, onInput: v => rebuild(S.m, v) });
        if (compact) [mSl, kSl].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
        const modeSeg = ui.segmented({ label: "Mode", value: S.mode, onChange: setMode,
          options: [{ value: "query", label: "Query" }, { value: "insert", label: "Insert" }] });
        const words = VOCAB.map(w => {
          const btn = ui.button(w, () => clickWord(w));
          btn.style.padding = "6px 10px";
          return btn;
        });
        const wordBar = ui.bar(...words);
        wordBar.style.gap = "6px";
        const hint = h("div", { style: "font-size:12.5px;color:var(--text-muted);margin:0 0 6px" });
        const allB = ui.button("Query all keys", doQueryAll, { kind: "primary" });
        const rndB = ui.button("Insert 4 random", insertRandom, { kind: "ghost" });
        const delB = ui.button("Try to delete", tryDelete, { kind: "ghost" });
        const clrB = ui.button("Clear", clearAll, { kind: "ghost" });

        const svg = ctx.svg({ w: compact ? 360 : 640, h: 200, label: "Bloom filter bit array with the hash positions of the current key" });
        const layers = {};
        ["pulse", "lines", "cells", "rings", "idx", "labels", "top"].forEach(n => { layers[n] = s("g"); svg.append(layers[n]); });

        const legend = ui.legend([
          { color: V("c2"), label: "bit = 1", shape: "square" },
          { color: V("c6"), label: "insert sets a bit", shape: "line" },
          { color: V("ok"), label: "query finds a 1", shape: "line" },
          { color: V("bad"), label: "query finds a 0", shape: "line" },
          { color: V("warn"), label: "bit already set by another key", shape: "square" },
        ]);
        const note = ui.note("");
        const stats = ui.stats([
          { key: "n", label: "Keys (n)" }, { key: "set", label: "Bits set" }, { key: "bpk", label: "Bits per key" },
          { key: "pred", label: "Predicted FPR" }, { key: "obs", label: "Observed FPR" }, { key: "bestk", label: "Best k" },
          { key: "waste", label: "Wasted reads / 1,000 misses" },
        ]);
        const foot = h("p", { style: "font-size:12.5px;line-height:1.5;color:var(--text-muted);margin:0",
          html: "<b>Wasted reads</b>: of 1,000 lookups for keys this SSTable doesn't have, how many still read it from disk " +
            "(without a filter, all 1,000 would). At real scale: about 10 bits per key with k = 7 gives ≈ 0.8% false positives; " +
            "a 1% target needs 9.6 bits per key, so 1 billion keys need about 1.2 GB of filter." });
        root.append(ui.bar(modeSeg, mSl, kSl), hint, wordBar, ui.bar(allB, rndB, delB, clrB), svg, legend, note, stats, foot);
        view = { svg, layers, words, hint, allB, rndB, delB, clrB, note, stats };
        render(false);
      }

      function layout() {
        const m = S.m;
        if (compact) {
          const cols = Math.min(16, m), rows = Math.ceil(m / 16), pitch = 22, cw = 20, ch = 24, top = 76, rp = 54;
          const last = top + (rows - 1) * rp + ch;
          return { W: 360, fs: 11, vs: 12, probe: { x: 110, y: 8, w: 140, h: 32, fs: 13 }, cols, pitch, cw, ch, top, rp,
            x0: (360 - cols * pitch + (pitch - cw)) / 2, every: 4, below: 8, above0: 11, above: 9, verdict: [last + 32, last + 48], H: last + 58 };
        }
        const rows = Math.ceil(m / 32), cols = Math.ceil(m / rows);
        const pitch = Math.min(36, Math.floor(616 / cols)), cw = pitch - (pitch > 24 ? 3 : 1), ch = 26, top = 104, rp = 58;
        const last = top + (rows - 1) * rp + ch;
        return { W: 640, fs: 12, vs: 14, probe: { x: 250, y: 10, w: 140, h: 34, fs: 14 }, cols, pitch, cw, ch, top, rp,
          x0: (640 - cols * pitch + (pitch - cw)) / 2, every: pitch >= 30 ? 1 : pitch >= 24 ? 2 : 4, below: 9, above0: 13, above: 10,
          verdict: [last + 44], H: last + 60 };
      }
      const cellOf = (L, p) => {
        const r = Math.floor(p / L.cols), x = L.x0 + (p % L.cols) * L.pitch, y = L.top + r * L.rp;
        return { r, x, y, cx: x + L.cw / 2, bottom: y + L.ch };
      };
      // Label slots in the gap under a row: [below] index or owner label, [below + 13] a second owner
      // label or the next row's hash labels. Boxes are 13 tall so adjacent slots never collide.
      const boxAt = (x, y, w) => ({ x0: x - w / 2, x1: x + w / 2, y0: y - 6.5, y1: y + 6.5 });
      const hits = (boxes, a) => boxes.some(o => a.x0 < o.x1 && o.x0 < a.x1 && a.y0 < o.y1 && o.y0 < a.y1);
      const textW = (str, fs) => str.length * fs * 0.6 + 4;

      // ---------------- Rendering ----------------
      function render(anim) {
        const o = own(), set = o.filter(x => x.length).length;
        updateControls();
        updateStats(o, set);
        let [html, tone] = S.note;
        if (set / S.m > 0.8) { html += " " + SATURATED; if (tone !== "bad") tone = "warn"; }
        view.note.set(html, tone);
        drawScene(o, anim);
      }

      function updateControls() {
        const fp = new Set(S.all ? S.all.fp : []), tn = new Set(S.all ? S.all.tn : []);
        view.words.forEach((btn, i) => {
          const w = VOCAB[i];
          btn.setActive(S.words.includes(w));
          btn.classList.toggle("viz-btn--danger", fp.has(w));
          btn.classList.toggle("viz-btn--ok", tn.has(w));
          btn.setLabel(fp.has(w) ? "FP " + w : tn.has(w) ? "✓ " + w : w);
          btn.title = fp.has(w) ? "false positive" : tn.has(w) ? "correctly rejected" : S.words.includes(w) ? "in the set" : "";
        });
        view.hint.innerHTML = `Click a key to <b>${S.mode}</b> it. Highlighted keys are in the set.`;
        const n = S.words.length;
        view.allB.disable(n === VOCAB.length);
        view.rndB.disable(n === VOCAB.length);
        view.delB.disable(!n).setLabel(n ? `Try to delete ${S.words[n - 1]}` : "Try to delete");
        view.clrB.disable(!n);
      }

      function updateStats(o, set) {
        const { m, k } = S, n = S.words.length, f = set / m, p = predictedFPR(m, k, n), st = view.stats;
        st.set("n", n);
        st.set("set", `${set} / ${m}${sub(`${Math.round(f * 100)}% full`)}`, f > 0.8 ? "bad" : f > 0.6 ? "warn" : "");
        st.set("bpk", n ? (m / n).toFixed(1) : "–", "");
        st.set("pred", pct(p), toneFPR(p));
        if (S.all) {
          const a = S.all.fp.length + S.all.tn.length, obs = S.all.fp.length / a;
          st.set("obs", `${pct(obs)}${sub(`${S.all.fp.length} of ${a} absent`)}`, toneFPR(obs));
        } else st.set("obs", "–", "");
        const bk = n ? bestK(m, n) : 0;
        st.set("bestk", !n ? "–" : bk + sub(bk === k ? "= your k" : `gives ${pct(predictedFPR(m, bk, n))}`), n && bk === k ? "ok" : "");
        st.set("waste", n ? String(Math.round(1000 * p)) : "–", n ? toneFPR(p) : "");
      }

      function drawCells(L, o, hidden) {
        const g = view.layers.cells;
        g.innerHTML = "";
        for (let p = 0; p < S.m; p++) {
          const c = cellOf(L, p), on = o[p].length > 0 && !(hidden && hidden.has(p));
          g.append(s("g", null,
            s("title", null, on ? `bit ${p} = 1, set by ${list(o[p])}` : `bit ${p} = 0`),
            s("rect", { x: c.x, y: c.y, width: L.cw, height: L.ch, rx: 3, fill: V(on ? "c2" : "node"), stroke: V(on ? "c2" : "line") }),
            ctx.text(c.cx, c.y + L.ch / 2 + 1, on ? "1" : "0", { size: L.fs, mono: true, weight: on ? 700 : 400, fill: V(on ? "bg" : "muted") })));
        }
      }

      function drawProbe(L, A) {
        const P = L.probe, g = view.layers.top, cy = P.y + P.h / 2;
        g.append(ctx.box({ x: P.x, y: P.y, w: P.w, h: P.h, fill: V("c6-soft"), stroke: V("c6"),
          label: A ? A.word : `click a key to ${S.mode}`, mono: !!A, size: A ? P.fs : L.fs, weight: A ? 700 : 400, ink: A ? null : V("muted") }));
        if (A) {
          const verb = A.type === "remove" ? "delete?" : A.type;
          g.append(ctx.text(P.x - 10, cy, verb, { size: L.fs, anchor: "end", weight: 700, fill: V(A.type === "remove" ? "bad" : "c6") }));
        }
        g.append(ctx.text(P.x + P.w + 10, cy, `k = ${S.k} hash${S.k > 1 ? "es" : ""}`, { size: L.fs, anchor: "start", fill: V("muted") }));
      }

      // A label on a background pill, so lines passing under it never cut through the text.
      const tag = (L, x, y, str, w, fill) => s("g", null,
        s("rect", { x: x - w / 2, y: y - 6.5, width: w, height: 13, rx: 3, fill: V("bg") }),
        ctx.text(x, y + 0.5, str, { size: L.fs, weight: 700, fill }));

      // One line per distinct target bit, labelled with its hash function(s) just above the target row.
      function drawHashes(L, A, boxes, from) {
        const [fx, fy] = from, { rings, lines, labels } = view.layers;
        return A.groups.map(g => {
          const c = cellOf(L, g.p), st = styleOf(A, g), col = V(st.c), x2 = c.cx, y2 = c.y - 2.5;
          // Lines sit under the cells, so a line to a lower row passes behind the upper row's digits;
          // a background-colored casing keeps crossing lines apart.
          const casing = ctx.arrow({ x1: fx, y1: fy, x2, y2, color: V("bg"), width: st.w + 3 });
          const path = ctx.arrow({ x1: fx, y1: fy, x2, y2, color: col, width: st.w, dashed: st.dashed });
          lines.prepend(casing);
          lines.append(path);
          rings.append(s("rect", { x: c.x - 2.5, y: c.y - 2.5, width: L.cw + 5, height: L.ch + 5, rx: 4, fill: "none",
            stroke: V(st.ring || st.c), "stroke-width": st.ringW || 2.5 }));
          const w = textW(g.hs, L.fs), onLine = y => fx + ((x2 - fx) * (y - fy)) / (y2 - fy);
          // Row 0 can stack labels up into the open band under the probe; lower rows have a 2-slot gap.
          let y = c.y - (c.r ? L.above : L.above0);
          const minY = c.r ? y - 13 : fy + 8;
          while (hits(boxes, boxAt(onLine(y), y, w)) && y - 13 >= minY) y -= 13;
          boxes.push(boxAt(onLine(y), y, w));
          labels.append(tag(L, onLine(y), y, g.hs, w, col));
          return { path, casing, x2, y2 };
        });
      }

      // Under each probed bit of a false positive (or each shared bit of a delete): who set it.
      function drawOwners(L, A, boxes) {
        const shown = A.type === "query" && A.result === "fp" ? A.groups : A.type === "remove" ? A.shared : [];
        shown.forEach(g => {
          const c = cellOf(L, g.p), str = g.others.length > 2 ? `${g.others[0]} +${g.others.length - 1}` : g.others.join(", ");
          const w = textW(str, L.fs);
          let y = c.bottom + L.below;
          if (hits(boxes, boxAt(c.cx, y, w))) y += 13;
          if (hits(boxes, boxAt(c.cx, y, w))) return;   // no room: the note still names every owner
          boxes.push(boxAt(c.cx, y, w));
          view.layers.labels.append(tag(L, c.cx, y, str, w, V(A.type === "remove" ? "bad" : "ink")));
        });
      }

      function drawIndices(L, boxes) {
        for (let p = 0; p < S.m; p += L.every) {
          const c = cellOf(L, p), y = c.bottom + L.below;
          if (!hits(boxes, boxAt(c.cx, y, textW(String(p), L.fs)))) view.layers.idx.append(ctx.text(c.cx, y, String(p), { size: L.fs, fill: V("muted") }));
        }
      }

      function drawVerdict(L, A) {
        const v = verdictOf(A), g = view.layers.labels;
        if (!v) return;
        const o = { size: L.vs, weight: 700, fill: V(v.tone) };
        if (compact) g.append(ctx.text(180, L.verdict[0], v.a, o), ctx.text(180, L.verdict[1], v.b, o));
        else g.append(ctx.text(320, L.verdict[0], v.a + " " + v.b, o));
      }

      function pulse(L, A) {
        A.groups.forEach(g => {
          const tone = A.type === "insert" ? (g.others.length ? "warn" : "ok") : A.type === "query" ? (g.set ? "ok" : "bad")
            : g.others.length ? "bad" : null;
          if (!tone) return;
          const c = cellOf(L, g.p);
          const r = s("rect", { x: c.x - 6, y: c.y - 6, width: L.cw + 12, height: L.ch + 12, rx: 7,
            fill: V(tone + "-soft"), stroke: V(tone), "stroke-width": 1.5 });
          view.layers.pulse.append(r);
          ctx.tween({ ms: 900, ease: "in", onUpdate: t => r.setAttribute("opacity", 1 - t) }).then(() => r.remove());
        });
      }

      async function drawScene(o, anim) {
        const my = ++epoch, L = layout(), { layers } = view;
        view.svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
        Object.values(layers).forEach(g => { g.innerHTML = ""; g.removeAttribute("opacity"); });
        const A = S.last ? analyze(S.last, o) : null;
        const animate = anim && A && !ctx.instant;
        // A fresh insert shows its new bits as 0 until the hash lines reach them.
        const fresh = animate && A.type === "insert" && !A.dup ? new Set(A.groups.filter(g => !g.others.length).map(g => g.p)) : null;
        drawCells(L, o, fresh);
        drawProbe(L, A);
        const boxes = [], from = [L.probe.x + L.probe.w / 2, L.probe.y + L.probe.h];
        const lines = A ? drawHashes(L, A, boxes, from) : [];
        if (A) drawOwners(L, A, boxes);
        drawIndices(L, boxes);
        drawVerdict(L, A);
        if (!animate) return;
        const [fx, fy] = from, tip = t => lines.forEach(l => [l.casing, l.path].forEach(el =>
          el.setAttribute("d", `M${fx},${fy} L${fx + (l.x2 - fx) * t},${fy + (l.y2 - fy) * t}`)));
        [layers.rings, layers.labels].forEach(g => g.setAttribute("opacity", 0));
        tip(0.05);
        await ctx.tween({ ms: 340, ease: "out", onUpdate: tip });
        if (my !== epoch) return;
        if (fresh) drawCells(L, o, null);
        pulse(L, A);
        // The layers outlive this render, so stop fading them once a newer render has started.
        await ctx.tween({ ms: 220, onUpdate: t => my === epoch && [layers.rings, layers.labels].forEach(g => g.setAttribute("opacity", t)) });
      }

      // First frame: the first absent key that the filter rules out.
      show({ type: "query", word: VOCAB.find(w => !S.words.includes(w) && lookup(w, S.words, S.m, S.k) === "no") });
      S.note[0] += " Query the other words that aren't in the set until one of them comes back “maybe” anyway.";
      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
