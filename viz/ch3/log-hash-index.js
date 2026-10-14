// Bitcask-style storage (DDIA ch3): writes append 16-byte records to the active segment file and an
// in-RAM hash map keeps each key's newest byte offset, so a read is one seek. Stale values pile up
// until compaction merges the closed segments; a crash wipes the map, and recovery rebuilds it by
// scanning every record or from per-segment hint files, rejecting the torn final record by its CRC.
(function () {
  "use strict";

  const KEYS = ["cat", "dog", "emu", "fox"];
  const CAP = 6, MAX_SEGS = 4, REC = 16;   // records per segment, segment slots, bytes per record

  // ---------------- Model (pure, no DOM) ----------------
  const active = st => st.segs[st.segs.length - 1];
  const recordCount = st => st.segs.reduce((n, g) => n + g.records.length, 0);
  const recordsOf = (st, key) => st.segs.reduce((n, g) => n + g.records.filter(r => r.key === key).length, 0);
  const garbageShare = st => { const n = recordCount(st); return n ? (n - st.index.size) / n : 0; };

  function openSeg(st) {
    st.segs.push({ id: "S" + st.nextS++, records: [], closed: false, merged: false });
    return active(st);
  }
  function roll(st) { active(st).closed = true; return openSeg(st); }

  function lookup(st, key) {
    const loc = st.index.get(key), seg = loc && st.segs.find(g => g.id === loc.seg);
    return loc ? { seg, off: loc.off, rec: seg.records[loc.off / REC] } : null;
  }
  const valueOf = (st, key) => { const l = lookup(st, key); return l ? l.rec.val : null; };
  const nextVal = (st, key) => (valueOf(st, key) || 0) + 1;
  const isLive = (st, seg, i) => { const l = st.index.get(seg.records[i].key); return !!l && l.seg === seg.id && l.off === i * REC; };

  /** Appends to the active segment (val null = tombstone); commit() then updates the index. */
  function append(st, key, val, torn = false) {
    const seg = active(st), rec = { id: ++st.rid, key, val, torn };
    seg.records.push(rec);
    return { seg, rec, off: (seg.records.length - 1) * REC };
  }
  const setLoc = (index, key, seg, off) => (off === null ? index.delete(key) : index.set(key, { seg, off }));
  const commit = (st, a) => setLoc(st.index, a.rec.key, a.seg.id, a.rec.val === null ? null : a.off);

  function newStore() {
    const st = { segs: [], index: new Map(), nextS: 1, nextM: 1, rid: 0 };
    const put = k => commit(st, append(st, k, nextVal(st, k)));
    openSeg(st);
    ["cat", "dog", "cat", "emu", "cat", "dog"].forEach(put);
    roll(st);
    ["cat", "fox", "emu"].forEach(put);
    return st;
  }

  /** "grep the whole log, keep the last match": a read without an index. */
  function scan(st, key) {
    const visited = st.segs.flatMap(g => g.records);
    const hit = visited.filter(r => r.key === key && !r.torn).pop() || null;
    return { visited, hit, val: hit ? hit.val : null };
  }

  /** Survivors are the records the index points to. Every older file is in the merge, so a
   *  tombstone and everything it shadows can be dropped together. */
  function compactPlan(st) {
    const closed = st.segs.filter(g => g.closed), survivors = [], dropped = [];
    closed.forEach(g => g.records.forEach((r, i) => (isLive(st, g, i) ? survivors : dropped).push(r)));
    return { closed, survivors, dropped };
  }
  function applyCompact(st, plan) {
    st.segs = [active(st)];
    if (!plan.survivors.length) return null;
    const m = { id: "M" + st.nextM++, records: plan.survivors.slice(), closed: true, merged: true };
    m.records.forEach((r, i) => st.index.set(r.key, { seg: m.id, off: i * REC }));
    st.segs.unshift(m);
    return m;
  }

  /** Restart: one step per record read; with hint files, one step per closed segment instead. */
  function recoveryPlan(st, hints) {
    return st.segs.flatMap(g => {
      if (!hints || !g.closed) return g.records.map((rec, i) => ({ hint: false, seg: g, rec, off: i * REC }));
      const entries = new Map();   // newest entry per key in this file; null = tombstone
      g.records.forEach((r, i) => entries.set(r.key, r.val === null ? null : i * REC));
      return [{ hint: true, seg: g, entries }];
    });
  }
  function applyStep(index, step) {
    if (step.hint) step.entries.forEach((off, key) => setLoc(index, key, step.seg.id, off));
    else if (!step.rec.torn) setLoc(index, step.rec.key, step.seg.id, step.rec.val === null ? null : step.off);
  }
  const dropTorn = st => { const g = active(st); g.records = g.records.filter(r => !r.torn); };

  // ---------------- View ----------------
  const cv = c => `var(--viz-${c})`;
  const OK = cv("ok"), BAD = cv("bad"), WARN = cv("warn"), MUTED = cv("muted");
  const CELL = {   // [fill, stroke, text]
    live: [cv("c2-soft"), cv("c2"), cv("ink")],
    old: [cv("grid"), cv("line"), MUTED],
    tomb: [cv("bad-soft"), BAD, BAD],
    torn: ["none", BAD, BAD],
    unknown: [cv("node"), cv("node-stroke"), cv("ink")],   // not re-read yet after a crash
  };
  const ROW = {
    live: [cv("c1-soft"), cv("c1"), cv("ink")],
    deleted: [cv("grid"), cv("line"), MUTED],
    lost: [cv("bad-soft"), BAD, BAD],
    blank: ["none", cv("line"), MUTED],
  };
  const INTRO = "Writes only ever <b>append</b> to the active segment; nothing on disk is overwritten. " +
    "The RAM hash map (one map for all segments here, like Bitcask's) stores the segment and byte offset of each key's " +
    "newest value, so a read is one seek. " +
    "Try <b>Write</b> a few times, then <b>Read without index</b>, then <b>Compact &amp; merge</b>.";
  const BACKGROUND = "A real engine does this in a background thread while reads and writes continue.";
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const listNames = a => (a.length < 3 ? a.join(" and ") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  const paint = (el, o) => { for (const k in o) el.style.setProperty(k, o[k]); return el; };
  const outline = (stroke, dash = "none", w = "1.5px") => ({ fill: "none", stroke, "stroke-width": w, "stroke-dasharray": dash });

  function geometry(compact) {
    return compact ? {
      W: 360, H: 342, fs: 11, rowFs: 12, cellFs: 11,
      idxTitle: [8, 14], idxRow: i => ({ x: 8 + i * 87, y: 24, w: 83, h: 40 }),
      idxCenter: [180, 44], diskTitle: [8, 88], diskCap: [352, 88], cap: "16 B / record",
      segY: j => 100 + j * 62, labelX: 8, labelDy: 14, subDy: 30,
      cellX: k => 46 + k * 52, cw: 50, ch: 32, offDy: 44,
    } : {
      W: 640, H: 284, fs: 12, rowFs: 13, cellFs: 12,
      idxTitle: [12, 18], idxRow: i => ({ x: 12, y: 38 + i * 34, w: 176, h: 28 }),
      idxCenter: [100, 102], diskTitle: [210, 18], diskCap: [630, 18], cap: "16 B per record",
      segY: j => 38 + j * 62, labelX: 210, labelDy: 12, subDy: 28,
      cellX: k => 260 + k * 61, cw: 57, ch: 32, offDy: 44,
    };
  }

  Viz.register("ch3/log-hash-index", {
    title: "Append-only log with a hash index",
    mount(root, ctx) {
      const { s, ui } = ctx;
      const box = (x, y, w, h, rx, style) => paint(s("rect", { x, y, width: w, height: h, rx }), style);
      // State lives outside build() so a phone/desktop switch keeps it.
      let st = newStore(), key = "cat", hints = false;
      let mode = "ok";      // index display: ok | lost (just crashed) | rebuild (recovering)
      let known = null;     // while recovering: ids of records re-read so far (null = all known)
      let busy = false, rebuildLater = false, compact = ctx.compact;
      let lastOp = "–", call = null, noteArgs = [INTRO, "info"];
      let G, v;             // geometry and DOM handles, recreated by build()

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        G = geometry(compact);
        const svg = ctx.svg({ w: G.W, h: G.H, label: "RAM hash index pointing at records in append-only segment files" });
        const layers = {};
        ["frame", "idx", "out", "segs", "cells", "fx"].forEach(n => svg.appendChild(layers[n] = s("g")));
        v = { svg, layers, rows: {}, cells: {}, segRows: {} };
        drawFrame(layers.frame);

        const btn = (label, fn, kind) => ui.button(label, () => act(fn), kind ? { kind } : {});
        const keySeg = ui.segmented({ label: "Key", options: KEYS, value: key, onChange: k => { key = k; } });
        const hintToggle = ui.toggle({ label: "Hint files", value: hints, onChange: on => { hints = on; } });
        hintToggle.title = "Restart from per-segment snapshots of key -> offset instead of scanning every record";
        const reset = ui.button("Reset", doReset, { kind: "ghost" });
        v.btns = [
          btn("Write", () => doWrite(key), "primary"), btn("Read", () => doRead(key)),
          btn("Read without index", () => doScan(key), "ghost"), btn("Delete", () => doDelete(key), "ghost"),
          btn("Compact &amp; merge", doCompact), btn("Crash &amp; restart", () => doCrash(key, hints), "danger"), reset,
        ];
        v.inputs = [...keySeg.querySelectorAll("button"), hintToggle.querySelector("input")];
        v.stats = ui.stats([
          { key: "records", label: "Records on disk" }, { key: "live", label: "Live keys" },
          { key: "garbage", label: "Garbage" }, { key: "op", label: "Last op" },
        ]);
        v.note = ui.note(...noteArgs);
        root.append(
          ui.bar(keySeg, ...v.btns.slice(0, 4)),
          ui.bar(...v.btns.slice(4, 6), hintToggle, reset),
          svg,
          ui.legend([
            { color: cv("c1"), label: "RAM index", shape: "square" },
            { color: cv("c2"), label: "live record", shape: "square" },
            { color: MUTED, label: "superseded", shape: "square" },
            { color: BAD, label: "tombstone", shape: "square" },
            { color: WARN, label: "active segment", shape: "dash" },
          ]),
          v.note, v.stats);
        render();
      }

      function drawFrame(layer) {
        const t = (xy, str, o) => layer.appendChild(ctx.text(xy[0], xy[1], str, { size: G.fs, anchor: "start", ...o }));
        t(G.idxTitle, "Hash index (RAM)", { weight: 700 });
        t(G.diskTitle, "Disk: segment files (append-only)", { weight: 700 });
        t(G.diskCap, G.cap, { anchor: "end", fill: MUTED });
        if (!compact) t([12, 188], "Last call", { weight: 700 });
      }

      function render() { drawRows(); drawDisk(); drawCall(); updateStats(); }

      function drawRows() {
        v.layers.idx.innerHTML = "";
        KEYS.forEach((k, i) => {
          const r = G.idxRow(i), loc = st.index.get(k);
          const kind = mode === "lost" ? "lost" : loc ? "live" : mode === "rebuild" ? "blank" : "deleted";
          const [fill, stroke, ink] = ROW[kind];
          const g = s("g", { opacity: kind === "lost" ? 0.5 : 1 });
          const rect = box(r.x, r.y, r.w, r.h, 6, { ...outline(stroke, kind === "blank" ? "4 3" : "none"), fill });
          const where = { live: loc && `${loc.seg} @ ${loc.off}`, deleted: "(deleted)", lost: "lost", blank: "" }[kind];
          const txt = (x, y, str, anchor) => g.appendChild(ctx.text(x, y, str, { size: G.rowFs, mono: true, anchor, fill: ink }));
          g.appendChild(rect);
          if (compact) { txt(r.x + r.w / 2, r.y + 13, k); txt(r.x + r.w / 2, r.y + 29, where); }
          else { txt(r.x + 12, r.y + r.h / 2, k, "start"); txt(r.x + 84, r.y + r.h / 2, (kind === "live" ? "→ " : "") + where, "start"); }
          v.layers.idx.appendChild(g);
          v.rows[k] = { rect, kind };
        });
      }

      function drawDisk() {
        const S = v.layers.segs, C = v.layers.cells;
        S.innerHTML = ""; C.innerHTML = "";
        v.cells = {}; v.segRows = {};
        st.segs.forEach((g, j) => {
          const y = G.segY(j), row = s("g", { transform: `translate(0,${y})` });
          const sub = !g.closed ? "active" : g.merged && !compact ? "merged" : "closed";
          row.appendChild(ctx.text(G.labelX, G.labelDy, g.id, { size: G.rowFs, weight: 700, anchor: "start" }));
          row.appendChild(ctx.text(G.labelX, G.subDy, sub, { size: G.fs, anchor: "start", fill: g.closed ? MUTED : WARN }));
          if (!g.closed) drawActiveFrame(row, g.records.length);
          S.appendChild(row);
          v.segRows[g.id] = row;
          g.records.forEach((rec, k) => drawCell(C, rec, k, y, isLive(st, g, k)));
        });
        // Unused segment slots: a 5th file would trigger compaction first.
        const x0 = G.cellX(0), x1 = G.cellX(CAP - 1) + G.cw;
        for (let j = st.segs.length; j < MAX_SEGS; j++) {
          const y = G.segY(j), label = j === st.segs.length ? `free slot (max ${MAX_SEGS} segment files)` : "free slot";
          S.appendChild(box(x0, y, x1 - x0, G.ch, 6, { ...outline(cv("line"), "4 4"), opacity: 0.6 }));
          S.appendChild(ctx.text((x0 + x1) / 2, y + G.ch / 2, label, { size: G.fs, fill: MUTED }));
        }
      }

      // Dashed outline around the file being appended to, its free slots, and the next offset.
      function drawActiveFrame(row, n) {
        const x0 = G.cellX(0) - 3, x1 = G.cellX(CAP - 1) + G.cw + 3;
        row.appendChild(box(x0, -3, x1 - x0, G.ch + 6, 7, outline(WARN, "5 4", "1.2px")));
        for (let k = n; k < CAP; k++) row.appendChild(box(G.cellX(k), 0, G.cw, G.ch, 5, outline(cv("line"), "3 3")));
        if (n < CAP) row.appendChild(ctx.text(G.cellX(n) + G.cw / 2, G.offDy, "@" + n * REC, { size: G.fs, fill: WARN }));
      }

      function drawCell(C, rec, k, y, live) {
        const x = G.cellX(k), { cw, ch } = G;
        const g = s("g", { transform: `translate(${x},${y})` });
        g._x = x; g._y = y;
        g.kind = rec.torn ? "torn" : known && !known.has(rec.id) ? "unknown" : rec.val === null ? "tomb" : live ? "live" : "old";
        // A torn record only got its first bytes to disk: fill just the left half.
        if (rec.torn) g.appendChild(paint(s("path", { d: `M5,0 H${cw / 2} V${ch} H5 Q0,${ch} 0,${ch - 5} V5 Q0,0 5,0 Z` }), { fill: cv("bad-soft") }));
        g.rect = s("rect", { width: cw, height: ch, rx: 5 });
        const str = `${rec.key}:${rec.torn ? "?" : rec.val === null ? "DEL" : rec.val}`, half = str.length * G.cellFs * 0.3 + 2;
        g.label = ctx.text(cw / 2, ch / 2, str, { size: G.cellFs, mono: true });
        g.strike = s("line", { x1: cw / 2 - half, x2: cw / 2 + half, y1: ch / 2, y2: ch / 2, stroke: MUTED, "stroke-width": 1 });
        g.append(g.rect, g.label, g.strike, ctx.text(cw / 2, G.offDy, "@" + k * REC, { size: G.fs, fill: MUTED }));
        styleCell(g);
        C.appendChild(g);
        v.cells[rec.id] = g;
      }

      function styleCell(c, stroke, width = stroke ? "2.5px" : "1.5px") {
        const [fill, line, ink] = CELL[c.kind];
        paint(c.rect, { fill, stroke: stroke || line, "stroke-width": width, "stroke-dasharray": c.kind === "torn" ? "4 3" : "none" });
        paint(c.label, { fill: ink });
        c.strike.style.display = c.kind === "old" ? "" : "none";
      }

      // "Last call" readout: the API call that just ran and what it returned.
      function drawCall() {
        const L = v.layers.out, c = call || { name: "", value: "none yet", tone: "muted" }, fill = cv(c.tone);
        L.innerHTML = "";
        if (compact) {
          if (call) L.appendChild(ctx.text(352, 14, `${c.name} ${c.value}`, { size: 11, anchor: "end", mono: true, weight: 700, fill }));
          return;
        }
        const line = (y, str, o) => L.appendChild(ctx.text(12, y, str, { size: 13, anchor: "start", mono: true, ...o }));
        if (c.name) line(210, c.name);
        line(c.name ? 232 : 210, c.value, { weight: 700, fill });
      }

      function updateStats() {
        const ok = mode === "ok", g = garbageShare(st);
        v.stats.set("records", recordCount(st));
        v.stats.set("live", ok ? st.index.size : "?", ok ? "" : "bad");
        v.stats.set("garbage", ok ? Math.round(g * 100) + "%" : "?", ok ? (g < 0.4 ? "ok" : g < 0.7 ? "warn" : "bad") : "");
        v.stats.set("op", lastOp, "info");
      }

      const note = (html, tone) => { noteArgs = [html, tone]; v.note.set(html, tone); };
      const report = (op, name, value, tone) => { lastOp = op; call = { name, value, tone }; drawCall(); updateStats(); };
      const fade = (els, from, to, ms = 300) =>
        ctx.tween({ ms, onUpdate: t => els.forEach(e => e.setAttribute("opacity", ctx.lerp(from, to, t))) });
      const ring = (k, color) => paint(v.rows[k].rect, { stroke: color, "stroke-width": "2.5px" });
      async function flashRows(keys, bad = false) {
        keys.forEach(k => paint(v.rows[k].rect, { fill: cv(bad ? "bad-soft" : "ok-soft"), stroke: bad ? BAD : OK }));
        await ctx.sleep(600);
        drawRows();
      }

      // Runs one animated action with every control disabled; a layout switch waits until it ends.
      async function act(fn) {
        if (busy) return;
        setBusy(true);
        try { await fn(); } finally { setBusy(false); if (rebuildLater) { rebuildLater = false; build(); } }
      }
      function setBusy(on) { busy = on; v.btns.forEach(b => b.disable(on)); v.inputs.forEach(el => { el.disabled = on; }); }

      // Rolls the full active segment over, compacting first if all segment slots are in use.
      async function makeRoom() {
        if (active(st).records.length < CAP) return "";
        let pre = "";
        if (st.segs.length >= MAX_SEGS) {
          await compaction(`All ${MAX_SEGS} segment slots are in use, so compaction runs first. `);
          pre = `All ${MAX_SEGS} segment slots were in use, so compaction ran before the write. `;
        }
        const full = active(st).id;
        roll(st);
        render();
        await ctx.sleep(350);
        return pre + `${full} was full (${CAP} records), so it was closed and ${active(st).id} was opened at offset 0. `;
      }

      // New record fades in with an amber (in-flight) outline, then the index row is repointed.
      async function appendAnimated(k, val) {
        const a = append(st, k, val);
        render();
        const c = v.cells[a.rec.id];
        styleCell(c, WARN);
        await fade([c], 0, 1, 300);
        await ctx.sleep(200);
        commit(st, a);
        render();
        await flashRows([k], val === null);
        return a;
      }

      async function doWrite(k) {
        const pre = await makeRoom();
        const prev = st.index.has(k), val = nextVal(st, k), older = recordsOf(st, k);
        const a = await appendAnimated(k, val), at = `${a.seg.id} @ ${a.off}`;
        report("1 append", `set(${k}, ${val})`, `→ ${at}`, "ok");
        const head = `Appended <b>${k}=${val}</b> at <b>${at}</b>`;
        let msg = !prev && !older ? `${head} and added ${k} to the index.`
          : !prev ? `${head} and put ${k} back in the index. Its older records, tombstone included, are garbage until compaction.`
          : `${head} and repointed the index. ` + (older === 1
            ? `The old ${k} value is still on disk, but nothing points at it: it is garbage until compaction.`
            : `The old ${k} values are still on disk, but nothing points at them: they are garbage until compaction.`);
        if (garbageShare(st) >= 0.7) msg += " Garbage is piling up: try <b>Compact &amp; merge</b>.";
        note(pre + msg, "info");
      }

      async function doDelete(k) {
        if (!st.index.has(k)) {
          report("0 appends", `delete(${k})`, "not found", "muted");
          return note(`Nothing to delete: <b>${k}</b> is not in the index.`, "warn");
        }
        const pre = await makeRoom();
        const a = await appendAnimated(k, null), at = `${a.seg.id} @ ${a.off}`;
        report("1 append", `delete(${k})`, `→ ${at}`, "bad");
        note(pre + `Deletes are appends too: a tombstone record (<b>${k}:DEL</b> at ${at}). ` +
          "The key leaves the index; compaction will drop the tombstone and every older value.", "info");
      }

      async function doRead(k) {
        const l = lookup(st, k);
        if (!l) {
          report("0 disk reads", `get(${k})`, "not found", "muted");
          return note(`<b>${k}</b> is not in the index, so get(${k}) answers <b>not found</b> without touching the disk.`, "info");
        }
        const cell = v.cells[l.rec.id];
        note(`Hash lookup: <b>${k}</b> lives at <b>${l.seg.id} @ ${l.off}</b>, so we did exactly one disk read and got ` +
          `<b>${l.rec.val}</b>. That stays true at any data size, as long as every key fits in RAM.`, "ok");
        ring(k, OK);
        await drawLookup(k, cell);
        styleCell(cell, OK);
        report("1 disk read", `get(${k})`, `= ${l.rec.val}`, "ok");
        await ctx.sleep(1200);
        v.layers.fx.innerHTML = "";
        render();
      }

      // Arrow from the key's index row to the record it points at, drawn on over 350 ms. On desktop it
      // runs down the gap between the panels, then along the free channel just above the target row.
      async function drawLookup(k, cell) {
        const r = G.idxRow(KEYS.indexOf(k)), x2 = cell._x + G.cw / 2, y2 = cell._y - 1, cy = cell._y - 8;
        let d;
        if (compact) {
          const x1 = r.x + r.w / 2, y1 = r.y + r.h, ym = (y1 + y2) / 2;
          d = `M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2}`;
        } else {
          const x1 = r.x + r.w, y1 = r.y + r.h / 2, gx = 199, q = 6, dir = cy > y1 ? 1 : -1;
          d = (Math.abs(cy - y1) < 2 * q ? `M${x1},${y1} C${gx},${y1} ${gx},${cy} ${gx + q},${cy}`
            : `M${x1},${y1} H${gx - q} Q${gx},${y1} ${gx},${y1 + dir * q} V${cy - dir * q} Q${gx},${cy} ${gx + q},${cy}`) +
            ` H${x2 - q} Q${x2},${cy} ${x2},${y2}`;
        }
        const paths = [["var(--viz-bg)", "5px"], [OK, "1.6px"]].map(([stroke, w]) =>
          v.layers.fx.appendChild(paint(s("path", { d }), { fill: "none", stroke, "stroke-width": w })));
        const len = paths[1].getTotalLength ? paths[1].getTotalLength() : 0;
        if (len) {
          paths.forEach(e => paint(e, { "stroke-dasharray": `${len} ${len}`, "stroke-dashoffset": len + "px" }));
          await ctx.tween({ ms: 350, onUpdate: t => paths.forEach(e => paint(e, { "stroke-dashoffset": (1 - t) * len + "px" })) });
        }
        paths[1].setAttribute("marker-end", v.svg.arrow(OK));
      }

      async function doScan(k) {
        const res = scan(st, k), n = res.visited.length;
        let cand = null;   // newest match so far: a later one replaces it; every read cell keeps a thin amber outline
        for (const r of res.visited) {
          const c = v.cells[r.id];
          styleCell(c, WARN);
          await ctx.sleep(90);
          if (r.key !== k) { styleCell(c, WARN, "1.5px"); continue; }
          if (cand) styleCell(cand, WARN, "1.5px");
          styleCell(cand = c, OK);
        }
        const found = res.val !== null;
        if (cand) styleCell(cand, found ? OK : BAD);
        report(`${n} disk reads`, `get(${k})`, found ? `= ${res.val}` : "not found", "warn");
        const what = found ? `the newest <b>${k}</b> (= ${res.val})` : res.hit
          ? `the newest <b>${k}</b>: a tombstone, so <b>not found</b>` : `any <b>${k}</b>: <b>not found</b>`;
        note(`Without an index we scanned all <b>${n}</b> records to find ${what}. That is O(n): instant here, ` +
          "but about 100 seconds per read on a 50 GB log at 500 MB/s.", "warn");
        await ctx.sleep(1200);
        render();
      }

      // Garbage turns red and fades, survivors slide into a merged file, the active file moves up.
      async function compaction(why = "") {
        const plan = compactPlan(st), act = active(st), cells = rs => rs.map(r => v.cells[r.id]);
        note(why + `Compacting ${listNames(plan.closed.map(g => g.id))}: keeping the ${plural(plan.survivors.length, "record")} ` +
          `the index points to and dropping ${plan.dropped.length} superseded values and tombstones (red).`, "info");
        cells(plan.dropped).forEach(c => paint(c.rect, { fill: cv("bad-soft"), stroke: BAD }));
        await ctx.sleep(300);
        await fade(cells(plan.dropped), 1, 0, 300);
        const yAct0 = G.segY(st.segs.length - 1), yAct1 = G.segY(plan.survivors.length ? 1 : 0);
        const moves = cells(plan.survivors).map((c, i) => [c, G.cellX(i), G.segY(0)])
          .concat(cells(act.records).map(c => [c, c._x, yAct1]));
        const actRow = v.segRows[act.id], oldRows = plan.closed.map(g => v.segRows[g.id]);
        await ctx.tween({ ms: 500, onUpdate: t => {
          moves.forEach(([c, x, y]) => c.setAttribute("transform", `translate(${ctx.lerp(c._x, x, t)},${ctx.lerp(c._y, y, t)})`));
          actRow.setAttribute("transform", `translate(0,${ctx.lerp(yAct0, yAct1, t)})`);
          oldRows.forEach(r => r.setAttribute("opacity", 1 - t));
        } });
        const merged = applyCompact(st, plan);
        render();
        await flashRows(plan.survivors.map(r => r.key));
        return { plan, merged };
      }

      async function doCompact() {
        const closed = st.segs.filter(g => g.closed);
        if (!closed.length) {
          return note("Nothing to compact yet: only the active segment exists. " +
            `Write until it fills (${CAP} records) and rolls over.`, "warn");
        }
        if (closed.length === 1 && !compactPlan(st).dropped.length) {
          return note(`${closed[0].id} is already compact: every record in it is live. New garbage reaches the closed segments ` +
            "once the active segment fills up and rolls over.", "info");
        }
        const { plan, merged } = await compaction();
        const Y = plan.survivors.length, X = Y + plan.dropped.length;
        const what = `${plan.closed.length === 1 ? "Compacted" : "Merged"} ${listNames(plan.closed.map(g => g.id))}`;
        report(`${X} → ${Y} records`, "compact()", `${X} → ${Y} records`, "ok");
        note(merged ? `${what}: <b>${plural(X, "record")} became ${Y}</b>. Superseded values and tombstones are gone and ` +
          `the index points into ${merged.id}. ${BACKGROUND}`
          : `${what}: all ${X} records were superseded values or tombstones, so ` +
            `${plan.closed.length === 1 ? "the file was" : "the files were"} simply deleted. ${BACKGROUND}`, "ok");
      }

      async function doCrash(k, useHints) {
        await makeRoom();
        const val = nextVal(st, k), torn = append(st, k, val, true).rec;
        mode = "lost"; known = new Set();
        render();
        await fade([v.cells[torn.id]], 0, 1, 300);
        report("power cut", "crash", "RAM index lost", "bad");
        note(`Power lost while writing <b>${k}:${val}</b>. The hash map lived only in RAM, so it is gone.`, "bad");
        await ctx.sleep(900);

        st.index = new Map(); mode = "rebuild";
        note("Restarting with an empty hash map: " + (useHints
          ? "load each closed segment's <b>hint file</b> (its keys and offsets), then replay the active segment, " +
            "which has no hint file yet because it was still being written."
          : "read every record from the oldest segment to the newest and replay it (newer offsets overwrite older " +
            "ones, tombstones remove the key). Records not re-read yet are plain."), "warn");
        render();
        const steps = recoveryPlan(st, useHints), total = recordCount(st), files = steps.filter(x => x.hint).length;
        let reads = 0;
        for (const step of steps) {
          call = { name: "restart", value: `rebuilding: ${plural(++reads, "read")}`, tone: "warn" };
          drawCall();
          await (step.hint ? replayHint(step) : replayRecord(step));
        }
        dropTorn(st); mode = "ok"; known = null;
        v.layers.fx.innerHTML = "";
        render();
        report(`${reads} disk reads`, "restart", `rebuilt: ${plural(reads, "read")}`, files ? "ok" : "warn");
        const tornMsg = `The torn <b>${k}:${val}</b> failed its checksum and was discarded`;
        if (files) {
          note(`Rebuilt the index from <b>${plural(files, "hint file")}</b> plus the active segment's records ` +
            `(<b>${reads} reads</b> instead of ${total}). ${tornMsg}. (Bitcask writes hint files when it merges; ` +
            "here every closed segment has one.)", "ok");
        } else {
          note(`Rebuilt the index by reading all <b>${total}</b> records on disk` + (useHints ? " (no segment is closed yet, so " +
            "there were no hint files to use). " : ". At millions of keys this makes restarts slow; Bitcask stores a hint " +
            "file (a snapshot of each segment's keys and offsets) to avoid it. ") +
            `${tornMsg}; it was never acknowledged, so nothing promised was lost.`, "warn");
        }
      }

      async function replayRecord(step) {
        const { rec } = step;
        known.add(rec.id);
        applyStep(st.index, step);
        render();
        const c = v.cells[rec.id];
        if (!rec.torn) {
          styleCell(c, WARN);
          ring(rec.key, rec.val === null ? BAD : OK);
          return ctx.sleep(120);
        }
        paint(c.rect, { fill: cv("bad-soft"), stroke: BAD, "stroke-width": "2.5px" });
        // Put the label in the free slots to the right if it fits there, else under the cell.
        const x = c._x + G.cw + 6, fits = G.cellX(CAP - 1) + G.cw - x >= 12 * G.fs * 0.62;
        const label = v.layers.fx.appendChild(ctx.text(fits ? x : c._x + G.cw, c._y + (fits ? G.ch / 2 : G.offDy),
          "CRC mismatch", { size: G.fs, weight: 700, fill: BAD, anchor: fits ? "start" : "end", halo: true }));
        await ctx.sleep(800);
        await fade([c, label], 1, 0, 250);
      }

      async function replayHint(step) {
        const y = G.segY(st.segs.indexOf(step.seg)), x0 = G.cellX(0) - 3, x1 = G.cellX(step.seg.records.length - 1) + G.cw + 3;
        v.layers.fx.appendChild(box(x0, y - 3, x1 - x0, G.ch + 6, 7, outline(cv("c1"), "none", "2px")));
        await ctx.fly(v.layers.fx, { from: [G.labelX + 10, y + G.ch / 2], to: G.idxCenter, ms: 650,
          label: "hint", labelSize: G.fs, fill: cv("c1") });
        step.seg.records.forEach(r => known.add(r.id));
        applyStep(st.index, step);
        render();
        step.entries.forEach((off, k) => ring(k, off === null ? BAD : OK));
        await ctx.sleep(350);
        v.layers.fx.innerHTML = "";
      }

      function doReset() {
        st = newStore(); mode = "ok"; known = null; lastOp = "–"; call = null;
        v.layers.fx.innerHTML = "";
        note(INTRO, "info");
        render();
      }

      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint (after any animation).
      ctx.onResize(() => { if (ctx.compact !== compact) { if (busy) rebuildLater = true; else build(); } });
    },
  });
})();
