// Local vs global secondary indexes on a used-car table partitioned by car ID and indexed by
// color. Local: a write stays on one partition, but "find red cars" asks every partition and
// waits for the slowest. Global: the query asks one index partition, but a write can touch
// several, and with asynchronous index updates a read right after a write races the update.
Viz.register("ch6/secondary-index", {
  title: "Local vs global secondary indexes",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const START = [[112, "red", "Honda"], [247, "black", "Ford"], [388, "red", "Tesla"],
      [534, "silver", "Ford"], [671, "red", "Volvo"], [902, "silver", "Audi"],
      [1045, "black", "Honda"], [1260, "yellow", "Audi"], [1433, "silver", "Tesla"]];
    const ADDS = [[725, "red", "BMW"], [1311, "red", "Kia"], [460, "red", "Fiat"], [980, "red", "Mini"]];
    const REPAINTS = [[388, "silver"], [1045, "red"], [534, "yellow"]];
    const RANGES = ["0–499", "500–999", "1000–1499"];
    // Animation ms: one-way message, a partition's normal work, extra work on a slow P2.
    const FLY = 450, WORK = 120, SLOW_EXTRA = 900;
    const LATER = 1e15;   // "after every in-flight update has landed"
    const ABORT = {};     // thrown when a rebuild abandons a running request
    const partOf = id => Math.min(2, Math.floor(id / 500));
    const idxOf = color => (color < "s" ? 0 : 1);            // Index A: colors a–r, Index B: s–z
    const contact = i => 10 + (slow && i === 2 ? 100 : 10);   // simulated ms: round trip + work
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const partTone = n => (n === 1 ? "ok" : n === 2 ? "warn" : "bad");
    const latTone = ms => (ms <= 30 ? "ok" : ms <= 60 ? "warn" : "bad");
    const byId = (a, b) => a - b;
    const now = () => performance.now();

    // ---------- state (survives phone/desktop rebuilds) ----------
    let mode = "local", sync = "async", lag = 1.5, slow = false;
    let cars, addN, repN;   // the table, and how far the scripted queues have got
    let postings;           // global index entries {id, color, from, until} (animation-clock ms)
    let pending = null;     // async write whose index update is still in flight
    let op = null;          // write in progress
    let busy = false, epoch = 0;
    let marks, statVals, noteVal;
    let compact, L, v;

    function resetData() {
      cars = new Map(START.map(([id, color, make]) => [id, { id, color, make }]));
      addN = repN = 0;
    }
    // The global index as derived from the table (mode switch, reset, layout rebuild).
    function rebuildIndex() {
      if (op && !op.applied) applyCar(op);
      op = pending = null;
      postings = [...cars.values()].map(c => ({ id: c.id, color: c.color, from: -Infinity, until: Infinity }));
    }
    const clearTransient = () => Object.assign(marks, {
      tone: [null, null, null], idxTone: [null, null], partTag: [null, null, null], idxTag: [null, null], prepared: new Set(),
    });
    function resetView() {
      marks = { hl: [false, false, false], hlIdx: false, under: [null, null, null], write: null, query: null };
      clearTransient();
      statVals = {};
      noteVal = initialNote();
    }

    // ---------- index model ----------
    const carsIn = i => [...cars.values()].filter(c => partOf(c.id) === i).sort((a, b) => a.id - b.id);
    function byColor(list) {   // [[color, sortedIds]], colors sorted like index terms
      const m = new Map();
      list.forEach(({ id, color }) => m.set(color, (m.get(color) || []).concat(id)));
      return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([c, ids]) => [c, ids.sort(byId)]);
    }
    const entriesAt = (k, t) => byColor(postings.filter(p => idxOf(p.color) === k && p.from <= t && t < p.until));
    const redAt = t => (entriesAt(0, t).find(([c]) => c === "red") || [0, []])[1];
    const trueRed = () => [...cars.values()].filter(c => c.color === "red").map(c => c.id).sort(byId);
    function indexWrite(w, t) {
      if (w.old) postings.find(p => p.id === w.id && p.until === Infinity).until = t;
      postings.push({ id: w.id, color: w.color, from: t, until: Infinity });
    }
    function nextWrite(kind) {
      if (kind === "add") {
        const [id, color, make] = ADDS[addN++];
        return { id, color, make, p: partOf(id), idxParts: [idxOf(color)] };
      }
      const [id, color] = REPAINTS[repN++], car = cars.get(id);
      return { id, color, old: car.color, make: car.make, p: partOf(id), idxParts: [...new Set([idxOf(car.color), idxOf(color)])] };
    }
    function applyCar(w) {
      w.applied = true;
      if (w.old) cars.get(w.id).color = w.color;
      else cars.set(w.id, { id: w.id, color: w.color, make: w.make });
    }
    const targetColor = (w, k) => (idxOf(w.color) === k ? w.color : w.old);
    const writeLabel = w => (w.old
      ? (compact ? `#${w.id} → ${w.color}` : `repaint #${w.id} ${w.old} → ${w.color}`)
      : (compact ? `+#${w.id} → P${w.p}` : `add #${w.id} ${w.color} ${w.make} → P${w.p}`));
    function idxLabel(w, k) {
      const del = w.old && idxOf(w.old) === k, add = idxOf(w.color) === k;
      return "idx " + (del && add ? "±" : del ? "−" : "+") + w.id;
    }

    // ---------- layout ----------
    function layout() {
      const local = mode === "local";
      return compact ? {
        W: 360, H: local ? 258 : 272, app: [180, 20], r: 14, fs: 11, hdr: 12, pad: 7,
        parts: [6, 124, 242].map(x => ({ x, y: 44, w: 112, h: local ? 190 : 108 })),
        idx: [6, 183].map(x => ({ x, y: 164, w: 171, h: 100 })),
        hdrY: 15, docY: 33, divY: 104, lblY: 117, lixY: 133, line: 15, idxY: 38, idxLine: 16,
        docMax: 14, idxMax: 22, under: 248,
      } : {
        W: 640, H: local ? 272 : 300, app: [320, 24], r: 16, fs: 12, hdr: 13, pad: 12,
        parts: [10, 222, 434].map(x => ({ x, y: 56, w: 196, h: local ? 190 : 120 })),
        idx: [10, 326].map(x => ({ x, y: 190, w: 304, h: 100 })),
        hdrY: 17, docY: 36, divY: 106, lblY: 120, lixY: 136, line: 15, idxY: 40, idxLine: 16,
        docMax: 23, idxMax: 38, under: 262,
      };
    }
    const T = (x, y, str, o = {}) => ctx.text(x, y, str, { size: L.fs, anchor: "start", ...o });
    const appPt = () => [L.app[0], L.app[1] + L.r];
    const partTop = i => [L.parts[i].x + L.parts[i].w / 2, L.parts[i].y];
    const idxTop = k => [L.idx[k].x + L.idx[k].w / 2, L.idx[k].y];
    function docPt(w) {
      const b = L.parts[w.p], j = carsIn(w.p).findIndex(c => c.id === w.id);
      return [b.x + b.w - (compact ? 16 : 30), b.y + L.docY + j * L.line];
    }
    function entryPt(k, color) {   // where `color`'s entry sits once every update has landed
      const b = L.idx[k];
      let y = b.y + L.idxY;
      for (const [c, ids] of entriesAt(k, LATER)) { if (c === color) break; y += entryText(c, ids, false).length * L.idxLine; }
      return [b.x + b.w - (compact ? 22 : 40), y];
    }
    // "red → 112, 388" wrapped to the box; continuation lines are indented under the first ID.
    function entryText(color, ids, local) {
      const head = color + (compact ? (local ? ":" : ": ") : " → "), sep = compact ? "," : ", ";
      const max = local ? L.docMax : L.idxMax, lines = [];
      let cur = head;
      ids.forEach((id, k) => {
        const tok = id + (k < ids.length - 1 ? sep : "");
        if (cur !== head && cur.length + tok.trimEnd().length > (lines.length ? max - head.length : max)) { lines.push(cur.trimEnd()); cur = ""; }
        cur += tok;
      });
      lines.push(cur.trimEnd());
      lines.indent = head.length * L.fs * 0.6;
      return lines;
    }

    // ---------- drawing ----------
    const hlRect = (b, y, n, lh) => s("rect", { x: b.x + 5, y: y - lh / 2, width: b.w - 10, height: n * lh, rx: 3,
      fill: "var(--viz-c5-soft)", stroke: "var(--viz-c5)", "stroke-width": 1 });
    const tagText = (x, y, [str, tone]) => T(x, y, str, { anchor: "end", size: compact ? 11 : 12, weight: tone ? 700 : null,
      fill: tone ? `var(--viz-${tone})` : "var(--viz-muted)" });
    function drawEntry(g, b, y, color, ids, local, hl, key) {
      const lines = entryText(color, ids, local), lh = local ? L.line : L.idxLine;
      if (hl) g.appendChild(hlRect(b, y, lines.length, lh));
      lines.forEach((ln, j) => g.appendChild(T(b.x + L.pad + (j ? lines.indent : 0), y + j * lh, ln, { mono: true })));
      v.lines[key] = { x: b.x + 4, y: y - lh / 2, w: b.w - 8, h: lines.length * lh };
      return lines.length * lh;
    }
    function slowPill(b) {
      const w = compact ? 34 : 40, ph = compact ? 14 : 16, x = b.x + b.w - w - 8, y = b.y - ph / 2;
      const r = { x, y, width: w, height: ph, rx: ph / 2 };
      return s("g", null, s("rect", { ...r, fill: "var(--viz-bg)" }),
        s("rect", { ...r, fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)" }),
        ctx.text(x + w / 2, y + ph / 2 + 0.5, "slow", { size: compact ? 11 : 12, weight: 700, fill: "var(--viz-bad)" }));
    }
    function renderPart(i) {
      const g = v.parts[i], b = L.parts[i], tone = marks.tone[i], isSlow = slow && i === 2;
      g.innerHTML = "";
      g.appendChild(ctx.box({ x: b.x, y: b.y, w: b.w, h: b.h, dashed: isSlow && !tone, strokeWidth: tone || isSlow ? 2.2 : 1.5,
        stroke: tone ? `var(--viz-${tone})` : isSlow ? "var(--viz-bad)" : "var(--viz-node-stroke)" }));
      g.appendChild(T(b.x + L.pad, b.y + L.hdrY, compact ? `P${i} ${RANGES[i]}` : `P${i} · IDs ${RANGES[i]}`, { size: L.hdr, weight: 700 }));
      if (mode === "global" && !compact) g.appendChild(tagText(b.x + b.w - L.pad, b.y + L.hdrY, marks.partTag[i] || [`node ${i + 1}`]));
      if (i === 2) v.pill.replaceChildren(...(isSlow ? [slowPill(b)] : []));   // above the work pulse
      carsIn(i).forEach((c, j) => {
        const y = b.y + L.docY + j * L.line;
        if (marks.hl[i] && c.color === "red") g.appendChild(hlRect(b, y, 1, L.line));
        g.appendChild(T(b.x + L.pad, y, compact ? `#${c.id} ${c.color}` : `#${c.id} ${c.color} ${c.make}`,
          { mono: true, fill: marks.prepared.has(c.id) ? "var(--viz-warn)" : undefined }));
        v.lines["d" + c.id] = { x: b.x + 4, y: y - L.line / 2, w: b.w - 8, h: L.line };
      });
      if (mode !== "local") return;
      g.appendChild(s("line", { x1: b.x + 8, x2: b.x + b.w - 8, y1: b.y + L.divY, y2: b.y + L.divY, stroke: "var(--viz-line)" }));
      g.appendChild(T(b.x + L.pad, b.y + L.lblY, "local index", { fill: "var(--viz-muted)" }));
      let y = b.y + L.lixY;
      byColor(carsIn(i)).forEach(([color, ids]) => { y += drawEntry(g, b, y, color, ids, true, marks.hl[i] && color === "red", `l${i}${color}`); });
    }
    function renderIdx(k, t) {
      t = v.idxT[k] = Math.max(t, v.idxT[k]);   // never step the picture back in time
      const g = v.idx[k], b = L.idx[k], tone = marks.idxTone[k], name = "AB"[k], range = k ? "s–z" : "a–r";
      g.innerHTML = "";
      g.appendChild(ctx.box({ x: b.x, y: b.y, w: b.w, h: b.h, fill: "var(--viz-c1-soft)",
        stroke: tone ? `var(--viz-${tone})` : "var(--viz-c1)", strokeWidth: tone ? 2.2 : 1.5 }));
      g.appendChild(T(b.x + L.pad, b.y + 16, compact ? `Index ${name} (${range})` : `Index ${name} · colors ${range}`, { size: 12, weight: 700 }));
      g.appendChild(tagText(b.x + b.w - L.pad, b.y + 16, [compact ? `with P${k}` : `node ${k + 1}`]));
      // Status sits at the bottom so packets landing on the entries never cover it.
      if (marks.idxTag[k]) g.appendChild(T(b.x + L.pad, b.y + b.h - 12, marks.idxTag[k][0], { weight: 700, fill: `var(--viz-${marks.idxTag[k][1]})` }));
      let y = b.y + L.idxY;
      entriesAt(k, t).forEach(([color, ids]) => { y += drawEntry(g, b, y, color, ids, false, marks.hlIdx && color === "red", `i${k}${color}`); });
    }
    function renderUnder(i) {
      const u = marks.under[i];
      v.under[i].textContent = u ? u[0] : "";
      v.under[i].style.fill = u ? `var(--viz-${u[1]})` : "";
    }
    function drawApp() {
      const g = v.app, [x, y] = L.app;
      g.innerHTML = "";
      g.appendChild(ctx.node({ x, y, r: L.r, label: "App", size: L.fs, fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" }));
      if (marks.write) g.appendChild(T(x - L.r - 9, y, marks.write[0], { anchor: "end", weight: 600, fill: `var(--viz-${marks.write[1]})` }));
      if (!marks.query) return;
      const t = T(x + L.r + 9, y, "", { weight: 600, fill: `var(--viz-${marks.query[1]})` });
      marks.query[0].forEach(([str, strike]) => t.appendChild(s("tspan", { style: strike ? "text-decoration: line-through" : null }, str)));
      g.appendChild(t);
    }
    function drawScene() {
      [v.scene, v.pulses, v.pill, v.flashes, v.packets].forEach(g => { g.innerHTML = ""; });
      v.app = v.scene.appendChild(s("g"));
      v.parts = [0, 1, 2].map(() => v.scene.appendChild(s("g")));
      v.idx = mode === "global" ? [0, 1].map(() => v.scene.appendChild(s("g"))) : [];
      v.under = mode === "local" ? L.parts.map(b => v.scene.appendChild(T(b.x + b.w / 2, L.under, "", { anchor: "middle", weight: 600 }))) : [];
      v.pulse = L.parts.map(b => v.pulses.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, opacity: 0,
        fill: "var(--viz-warn-soft)", stroke: "var(--viz-warn)", "stroke-width": 2.5 })));
      drawApp();
      [0, 1, 2].forEach(renderPart);
      v.idx.forEach((g, k) => renderIdx(k, now()));
      v.under.forEach((u, i) => renderUnder(i));
    }
    function flash(key) {
      const r = v.lines[key];
      if (!r) return;
      const el = v.flashes.appendChild(s("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4, fill: "var(--viz-ok-soft)", stroke: "var(--viz-ok)" }));
      ctx.tween({ ms: 1200, ease: "in", onUpdate: k => el.setAttribute("opacity", 1 - k) }).then(() => el.remove());
    }
    const flashIdx = (w, k) => [w.color, w.old].forEach(c => { if (c && idxOf(c) === k) flash(`i${k}${c}`); });
    const fly = (from, to, label, color, ms = FLY, ease) =>
      ctx.fly(v.packets, { from, to, label, fill: `var(--viz-${color})`, ms, ease, r: compact ? 6 : 7, labelSize: L.fs });

    // ---------- requests ----------
    async function wait(my, ...ps) {
      await Promise.all(ps);
      if (my !== epoch || !ctx.alive) throw ABORT;
    }
    // A partition doing its work; a slow P2 pulses for the extra 900 ms.
    function work(i) {
      if (!(slow && i === 2)) return ctx.sleep(WORK);
      const el = v.pulse[i];
      return ctx.tween({ ms: WORK + SLOW_EXTRA, ease: "linear", onUpdate: k => el.setAttribute("opacity", 0.5 - 0.5 * Math.cos(k * Math.PI * 6)) });
    }
    const stat = (key, value, tone) => { statVals[key] = [value, tone]; v.stats.set(key, value, tone); };
    const setNote = ([html, tone]) => { noteVal = [html, tone]; v.note.set(html, tone); };
    const guard = fn => (...a) => fn(...a).catch(e => { if (e !== ABORT) throw e; });

    function startOp(isQuery) {
      busy = true;
      marks.hl = [false, false, false]; marks.hlIdx = false; marks.under = [null, null, null];
      if (!isQuery) marks.query = null;
      [0, 1, 2].forEach(renderPart);
      v.idx.forEach((g, k) => renderIdx(k, now()));
      v.under.forEach((u, i) => renderUnder(i));
      syncButtons();
    }

    const write = guard(async (kind, thenFind) => {
      if (busy || pending) return;
      const my = epoch, w = op = nextWrite(kind);
      startOp(false);
      stat("result", "–", "");
      marks.write = [writeLabel(w), "c6"]; drawApp();
      await wait(my, fly(appPt(), partTop(w.p), w.old ? `${w.id}→${w.color}` : "+" + w.id, "c6"));
      let lat = contact(w.p), touched = 1;
      if (mode === "global" && sync === "sync") {
        await twoPhase(w, my);
        lat *= 2; touched += w.idxParts.length;
      } else {
        await wait(my, work(w.p));
        applyCar(w); renderPart(w.p); flash("d" + w.id);
        if (mode === "local") flash(`l${w.p}${w.color}`);
        else asyncIndex(w, my);
      }
      await wait(my, fly(partTop(w.p), appPt(), "ack", "ok"));
      op = null; w.acked = true;
      if (w.rec && w.rec.landed) touched += w.idxParts.length;
      marks.write = [writeLabel(w) + " ✓", "ok"]; drawApp();
      stat("wTouch", plural(touched, "partition"), partTone(touched));
      stat("wLat", lat + " ms", latTone(lat));
      if (thenFind) {
        if (w.rec && !w.rec.landed) setNote([`Acknowledged after writing only P${w.p}, and the query leaves at once. The index update for #${w.id} ` +
          `is still in flight to Index A (${w.rec.lag.toFixed(1)} s): which one gets there first?`, "warn"]);
        return runFind(my, w.rec ? w.rec.ackAt : now(), w);
      }
      busy = false; syncButtons();
      setNote(w.rec ? asyncNote(w.rec) : mode === "local" ? localWriteNote(w) : w.old ? repaintNote(w, lat) : syncAddNote(lat));
    });

    // Async: the ack and the index update leave together; the entry exists from landAt on.
    function asyncIndex(w, my) {
      const t0 = now(), ms = Math.round(lag * 1000);
      indexWrite(w, t0 + ms);
      const rec = w.rec = pending = { w, landAt: t0 + ms, ackAt: t0 + FLY, lag, stale: false, landed: false };
      w.idxParts.forEach(k => {
        marks.idxTag[k] = [`update ${idxLabel(w, k).slice(4)} in flight`, "warn"];
        renderIdx(k, t0);
        fly(docPt(w), entryPt(k, targetColor(w, k)), idxLabel(w, k), "warn", ms, "linear");
      });
      ctx.after(ms, () => { if (my === epoch) landed(rec); });
    }
    function landed(rec) {
      const w = rec.w, n = 1 + w.idxParts.length;
      rec.landed = true; pending = null;
      w.idxParts.forEach(k => { marks.idxTag[k] = null; renderIdx(k, rec.landAt); flashIdx(w, k); });
      if (w.acked) stat("wTouch", plural(n, "partition"), partTone(n));
      if (!busy) setNote(asyncNote(rec));
      syncButtons();
    }

    // Sync: two-phase commit run by the car's partition; each round goes to all participants at once.
    async function twoPhase(w, my) {
      const ks = w.idxParts, pts = ks.map(k => entryPt(k, targetColor(w, k)));
      const lock = tone => {
        const tag = tone === "warn" ? ["locked", "warn"] : null;
        marks.tone[w.p] = tone; marks.partTag[w.p] = tag;
        ks.forEach(k => { marks.idxTone[k] = tone; marks.idxTag[k] = tag && [`${idxLabel(w, k).slice(4)} prepared (locked)`, "warn"]; });
        renderPart(w.p); ks.forEach(k => renderIdx(k, now()));
      };
      const round = async (req, resp, atIndex) => {
        await wait(my, work(w.p));
        await wait(my, ...ks.map((k, j) => fly(docPt(w), pts[j], req, "warn")));
        if (atIndex) atIndex();
        await wait(my, ctx.sleep(WORK));
        await wait(my, ...ks.map((k, j) => fly(pts[j], docPt(w), resp, "ok")));
      };
      applyCar(w); marks.prepared.add(w.id); lock("warn");
      await round("prepare", "yes");
      await round("commit", "done", () => {
        indexWrite(w, now()); marks.prepared.delete(w.id); lock("ok");
        flash("d" + w.id); ks.forEach(k => flashIdx(w, k));
      });
      lock(null);
    }

    const find = guard(async () => { if (!busy) await runFind(epoch, now(), null); });
    async function runFind(my, firedAt, w) {
      startOp(true);
      marks.query = [[["red cars?"]], "c6"]; drawApp();
      const r = mode === "local" ? await findLocal(my) : await findGlobal(my, firedAt);
      const truth = trueRed(), missing = truth.filter(id => !r.ids.includes(id)), extra = r.ids.filter(id => !truth.includes(id));
      showResult(r.ids, truth, missing, extra);
      stat("qAsk", plural(r.asked, "partition"), r.asked === 1 ? "ok" : "bad");
      stat("qLat", r.lat + " ms", latTone(r.lat));
      busy = false; syncButtons();
      setNote(mode === "local" ? localQueryNote(w, r) : r.rec && r.rec.stale ? staleNote(r.rec) : globalQueryNote(w));
    }
    async function findLocal(my) {
      const waiting = new Set([0, 1, 2]);
      const parts = await Promise.all([0, 1, 2].map(async i => {
        await wait(my, fly(appPt(), partTop(i), "red?", "c6"));
        marks.hl[i] = true; renderPart(i);
        await wait(my, work(i));
        const ids = carsIn(i).filter(c => c.color === "red").map(c => c.id);
        marks.under[i] = [`${ids.length} red · ${contact(i)} ms`, slow && i === 2 ? "bad" : "muted"]; renderUnder(i);
        await wait(my, fly(partTop(i), appPt(), ids.length + " red", "ok"));
        waiting.delete(i);
        if (waiting.size) { marks.query = [[[`waiting for ${[...waiting].map(j => "P" + j).join(", ")}…`]], "warn"]; drawApp(); }
        return ids;
      }));
      return { ids: [].concat(...parts).sort(byId), asked: 3, lat: Math.max(...[0, 1, 2].map(contact)), p2: parts[2].length };
    }
    // The index partition answers with its state at the moment the request lands (RACE RULE).
    async function findGlobal(my, firedAt) {
      await wait(my, fly(appPt(), idxTop(0), "red?", "c6"));
      const tLand = firedAt + FLY, ids = redAt(tLand), rec = pending;
      const stale = trueRed().join() !== ids.join();
      if (rec && stale) rec.stale = true;
      marks.hlIdx = true; renderIdx(0, tLand);
      await wait(my, ctx.sleep(WORK));
      await wait(my, fly(idxTop(0), appPt(), ids.length + " ids", stale ? "bad" : "ok"));
      return { ids, asked: 1, lat: 20, rec: stale ? rec : null };
    }
    function showResult(ids, truth, missing, extra) {
      if (missing.length) {
        const m = "#" + missing.join(", #");
        stat("result", `${ids.length} of ${truth.length}: <s>${m}</s> missing`, "bad");
        marks.query = [[[`${ids.length} of ${truth.length} · `], [m, true], [" missing"]], "bad"];
      } else if (extra.length) {
        const m = "#" + extra[0];
        stat("result", `stale: <s>${m}</s> not red`, "bad");
        marks.query = [[[`${plural(ids.length, "id")} · `], [m, true], [` is ${cars.get(extra[0]).color}`]], "bad"];
      } else {
        stat("result", plural(ids.length, "red car"), "ok");
        marks.query = [[[plural(ids.length, "red car") + " ✓"]], "ok"];
      }
      drawApp();
    }

    // ---------- notes ----------
    function initialNote() {
      return mode === "local"
        ? ['Each partition indexes only its own cars. Writes stay local, but "find red cars" must ask all 3 partitions and wait ' +
          "for the slowest. Try <b>Find red cars</b>, then turn on <b>P2 is slow</b>.", "info"]
        : ['The index is partitioned by color: every "red" entry lives in Index A, wherever the cars themselves live. ' +
          "Try <b>Add, then find at once</b>, then <b>Repaint a car</b>.", "info"];
    }
    const localWriteNote = w => ["One partition touched: the car and its index entry live together, so they change together." +
      (slow && w.p === 2 ? " P2 is slow, so even this one-partition write took 110 ms." : ""), "ok"];
    const slowSync = lat => (lat > 40 ? ` P2 is slow and runs both rounds, so this write took ${lat} ms.` : "");
    const syncAddNote = lat => ["The write updated the data partition and a remote index partition in one distributed transaction " +
      "(prepare, then commit), as Spanner and CockroachDB do: never stale, but every indexed write pays two extra rounds " +
      "and holds locks on every participant until commit." + slowSync(lat), "warn"];
    function repaintNote(w, lat) {
      if (w.idxParts.length === 2) {
        return [`Changing one field touched 3 partitions: the car's partition, Index A (remove from ${w.old}) and Index B (add to ${w.color}).` +
          (lat ? ` Prepare and commit went to all 3 in parallel, so the write still took ${lat} ms, but all 3 held locks until the commit.` : ""), "bad"];
      }
      return [`Changing ${w.old} to ${w.color} touched 2 partitions: the car's partition and Index ${"AB"[w.idxParts[0]]}, ` +
        "which holds both colors. A local index would have touched 1." + (lat ? slowSync(lat) : ""), "warn"];
    }
    function asyncNote(rec) {
      const w = rec.w;
      if (rec.stale) return staleNote(rec);
      if (rec.landed) {
        return w.old ? repaintNote(w) : [`Acknowledged after the data write; the index caught up ${rec.lag.toFixed(1)} s later ` +
          "(slow motion). Fine, unless someone reads in between.", "warn"];
      }
      const what = !w.old ? `The index update for #${w.id} is still in flight to Index A: a query that reaches Index A before it does will miss the car.`
        : w.idxParts.length === 2 ? `Two index updates are still in flight: remove ${w.id} from "${w.old}" (Index A) and add it to "${w.color}" (Index B).`
          : `The index update (move ${w.id} from "${w.old}" to "${w.color}" in Index ${"AB"[w.idxParts[0]]}) is still in flight.`;
      return [`Acknowledged after writing only P${w.p}. ${what}`, "warn"];
    }
    function staleNote(rec) {
      const w = rec.w, id = "#" + w.id, added = w.color === "red";
      const what = added ? `${id} was acknowledged, but its index entry was still in flight to Index A.`
        : `${id} was repainted ${w.color} and acknowledged, but its removal from Index A's "red" entry was still in flight.`;
      const later = rec.landed ? ` The index has caught up since: find again and ${id} ${added ? "is there" : "is gone"}.` : "";
      return [`<b>Stale read:</b> ${what} DynamoDB global secondary indexes behave like this: updated asynchronously, ` +
        `eventually consistent reads only.${later}`, "bad"];
    }
    function localQueryNote(w, r) {
      const slowP2 = slow ? " and waited 110 ms for the slow P2" : "";
      if (w) return [`Found #${w.id} at once: the car and its index entry were written together on P${w.p}. ` +
        `The price is on the read side: the query still asked all 3 partitions${slowP2}.`, slow ? "warn" : "ok"];
      if (slow) return [`The answer took 110 ms because P2 was slow${r.p2 ? "" : " (and P2 had no red cars at all)"}: ` +
        "a scatter-gather is only as fast as its slowest partition (tail latency, Chapter 1).", "bad"];
      return ["Scatter-gather: 3 requests, 3 partial answers merged. With 100 partitions this is 100 requests for every query. " +
        "Only a query that also names the partition key (say, red cars with IDs 0–499) can go to one partition.", "warn"];
    }
    function globalQueryNote(w) {
      if (w && w.rec) return [`<b>Lucky:</b> the index update (${w.rec.lag.toFixed(1)} s) ${w.rec.lag < 0.9 ? "beat" : "tied with"} the query (0.9 s), so the new car is there. ` +
        "With an asynchronous index, reading your own write is a race you do not control; in production the lag grows " +
        "exactly when the system is busiest.", "warn"];
      if (w) return [`Found #${w.id} at once: the write was acknowledged only after Index A had committed it, so a read right ` +
        `after it cannot miss it. The cost moved to the write: ${statVals.wLat[0]} and locks on 2 partitions until the commit.`, "ok"];
      return ["One request to Index A answers the query. (Fetching the full car records may still touch several data partitions " +
        "unless the index stores the fields you need.)" + (slow ? " P2's slowness no longer matters for this query." : ""), "ok"];
    }
    const syncNote = () => (sync === "sync"
      ? ["Sync: a write is acknowledged only after every index partition it touches has committed it too (two-phase commit).", "info"]
      : ['Async: a write is acknowledged as soon as its own partition has it; the index update lands after the "Index lag".', "info"]);
    const slowNote = () => (!slow ? ["P2 is back to normal speed: 10 ms of work per request.", "info"]
      : mode === "local" ? ["P2 is now slow: 100 ms of work per request instead of 10. Every scatter-gather query has to wait for it.", "warn"]
        : ["P2 is now slow: 100 ms per request instead of 10. Queries by color go to Index A on node 1, so they never wait " +
          "for it; writes of cars on P2 still do.", "info"]);

    // ---------- controls & build ----------
    function syncButtons() {   // enabled buttons, their tooltips, and which mode controls show
      if (!v) return;
      const free = !busy && !pending, addsLeft = addN < ADDS.length, repLeft = repN < REPAINTS.length;
      const nextAdd = addsLeft && ADDS[addN], nextRep = repLeft && REPAINTS[repN];
      v.bAdd.disable(!free || !addsLeft).title = addsLeft ? `Next: #${nextAdd[0]} red ${nextAdd[2]} → P${partOf(nextAdd[0])}` : "Reset to start over";
      v.bBoth.disable(!free || !addsLeft).title = v.bAdd.title;
      v.bRep.disable(!free || !repLeft).title = repLeft ? `Next: #${nextRep[0]} ${cars.get(nextRep[0]).color} → ${nextRep[1]}` : "Reset to start over";
      v.bFind.disable(busy);
      v.segs.forEach(b => { b.disabled = busy; });
      v.segSync.style.display = mode === "local" ? "none" : "";
      v.lag.style.display = mode === "global" && sync === "async" ? "" : "none";
    }
    const STATS = [["wTouch", "Write touched"], ["wLat", "Write latency"], ["qAsk", "Query asked"], ["qLat", "Query latency"], ["result", "Result"]];
    // Controls, stats and note: built on mount and when the frame crosses the phone breakpoint.
    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const segIndex = ui.segmented({ label: "Index", value: mode,
        options: [{ value: "local", label: "Local (by document)" }, { value: "global", label: "Global (by term)" }],
        // A mode switch starts over: fresh table and fresh scripted add/repaint queues.
        onChange: m => { if (m !== mode) { mode = m; op = null; resetData(); rebuildIndex(); resetView(); buildScene(); } } });
      const segSync = ui.segmented({ label: "Global index updates", value: sync,
        options: [{ value: "async", label: "Async" }, { value: "sync", label: "Sync (distributed txn)" }],
        onChange: x => { if (x !== sync) { sync = x; syncButtons(); setNote(syncNote()); } } });
      const lagSlider = ui.slider({ label: "Index lag (slow motion)", min: 0.3, max: 3, step: 0.1, value: lag,
        format: x => x.toFixed(1) + " s", onInput: x => { lag = x; } });
      if (compact) lagSlider.input.style.flex = "1 1 80px";
      v = { segSync, lag: lagSlider, wrap: h("div"),
        segs: [...segIndex.querySelectorAll("button"), ...segSync.querySelectorAll("button")],
        bAdd: ui.button("Add a red car", () => write("add"), { kind: "primary" }),
        bRep: ui.button("Repaint a car", () => write("repaint")),
        bFind: ui.button("Find red cars", () => find()),
        bBoth: ui.button("Add, then find at once", () => write("add", true), { kind: "danger" }),
        stats: ui.stats(STATS.map(([key, label]) => ({ key, label }))),
        note: ui.note(),
      };
      const slowToggle = ui.toggle({ label: "P2 is slow", value: slow, onChange: x => { slow = x; renderPart(2); setNote(slowNote()); } });
      const reset = ui.button("Reset", () => { op = null; resetData(); rebuildIndex(); resetView(); buildScene(); }, { kind: "ghost" });
      v.stats.style.gridTemplateColumns = compact ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr)) minmax(0, 1.7fr)";
      if (compact) v.stats.lastChild.style.gridColumn = "1 / -1";
      const caption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin-top:10px" },
        "Slow motion: each one-way message takes 0.45 s on screen, and the index lag is in the same on-screen seconds. " +
        "The stats show simulated time: 10 ms per round trip plus 10 ms of work per partition (100 ms on a slow P2).");
      root.append(ui.bar(segIndex, segSync, lagSlider),
        ui.bar(v.bAdd, v.bRep, v.bFind, v.bBoth, slowToggle, reset),
        v.wrap, v.stats, v.note, caption);
      buildScene();
    }
    // The drawing and legend for the current mode; abandons any request still animating.
    function buildScene() {
      epoch++; busy = false;
      if (op || pending) rebuildIndex();
      clearTransient();
      L = layout();
      const svg = ctx.svg({ w: L.W, h: L.H, label: "A used-car table in three partitions with a local or a global color index" });
      Object.assign(v, { lines: {}, idxT: [-Infinity, -Infinity], scene: s("g"), pulses: s("g"), pill: s("g"), flashes: s("g"), packets: s("g") });
      svg.append(v.scene, v.pulses, v.pill, v.flashes, v.packets);
      const items = [{ color: "var(--viz-c6)", label: "request" }, { color: "var(--viz-ok)", label: "response / applied" }];
      if (mode === "global") items.push({ color: "var(--viz-warn)", label: "index update in flight" },
        { color: "var(--viz-c1-soft)", label: "global index partition", shape: "square", edge: "c1" });
      items.push({ color: "var(--viz-c5-soft)", label: "matches the query", shape: "square", edge: "c5" });
      const legend = ui.legend(items);
      items.forEach((it, j) => { if (it.edge) legend.children[j].firstChild.style.border = `1px solid var(--viz-${it.edge})`; });
      v.wrap.replaceChildren(svg, legend);
      drawScene();
      STATS.forEach(([key]) => v.stats.set(key, ...(statVals[key] || ["–", ""])));
      v.note.set(...noteVal);
      syncButtons();
    }

    resetData(); rebuildIndex(); resetView();
    build();
    // Rebuild outside the ResizeObserver callback so the new layout doesn't re-trigger it.
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) build(); }));
  },
});
