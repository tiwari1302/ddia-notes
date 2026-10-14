// Avro schema resolution. The bytes carry only values in the writer's field order, so the reader
// decodes them with the writer's schema, then matches fields to its own schema by name (or alias):
// writer-only fields are skipped, reader-only fields take their default, and anything else fails.
// Swapping the two schemas shows that compatibility has a direction.
Viz.register("ch4/avro-resolution", {
  title: "Writer's schema meets reader's schema",
  mount(root, ctx) {
    const { s, h, ui } = ctx;

    // ---------------------------------------------------------------- model (pure)
    const VALUES = {
      userName: "Martin", name: "Martin", favoriteNumber: 1337,
      interests: ["daydreaming", "hacking"], photoUrl: "m.png", email: "m@x.io",
    };
    // def present = the field declares a default (null is a real default).
    const F = {
      userName: { name: "userName", type: "string" },
      name: { name: "name", type: "string", aliases: ["userName"] },
      fav: { name: "favoriteNumber", type: ["null", "long"], def: null },
      fav3: { name: "favoriteNumber", type: ["null", "long", "string"], def: null, value: "forty-two" },
      favInt: { name: "favoriteNumber", type: "int" },
      favLong: { name: "favoriteNumber", type: "long" },
      interests: { name: "interests", type: { array: "string" }, def: [] },
      photoUrl: { name: "photoUrl", type: ["null", "string"], def: null },
      email: { name: "email", type: "string" },
    };
    const BASE = [F.userName, F.fav, F.interests];
    // w/r = writer/reader schema, wv/rv = their versions (v2 is the newer schema).
    const PRESETS = [
      { id: "a", label: "a. Identical schemas", short: "a. Identical schemas", w: BASE, r: BASE, wv: 1, rv: 1 },
      { id: "b", label: "b. Reader adds a field with a default", short: "b. New field with default", w: BASE, r: [...BASE, F.photoUrl], wv: 1, rv: 2 },
      { id: "c", label: "c. Reader adds a field without a default", short: "c. New field, no default", w: BASE, r: [...BASE, F.email], wv: 1, rv: 2 },
      { id: "d", label: "d. Fields in a different order", short: "d. Different field order", w: BASE, r: [F.interests, F.userName, F.fav], wv: 1, rv: 2 },
      { id: "e", label: "e. Rename with an alias", short: "e. Rename with an alias", w: BASE, r: [F.name, F.fav, F.interests], wv: 1, rv: 2 },
      { id: "f", label: "f. Promote int to long", short: "f. Promote int to long", w: [F.userName, F.favInt, F.interests], r: [F.userName, F.favLong, F.interests], wv: 1, rv: 2 },
      { id: "g", label: "g. Writer uses a new union branch", short: "g. New union branch", w: [F.userName, F.fav3, F.interests], r: BASE, wv: 2, rv: 1 },
    ];
    const isUnion = Array.isArray;
    const hasDef = f => "def" in f;
    const valueOf = f => ("value" in f ? f.value : VALUES[f.name]);
    const tKey = t => (isUnion(t) ? t.map(tKey).join("|") : t.array ? `array<${t.array}>` : t);
    const PROMOTE = { int: ["long", "float", "double"], long: ["float", "double"], float: ["double"], string: ["bytes"], bytes: ["string"] };
    const promotes = (a, b) => (PROMOTE[a] || []).includes(b);
    const NUMERIC = ["int", "long", "float", "double"];

    // Index of the union branch a value is written with (the writer picks it from the value).
    function branchOf(u, v) {
      const kind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? "number" : "string";
      return u.findIndex(b => (kind === "number" ? NUMERIC.includes(b) : kind === "array" ? !!b.array : b === kind));
    }
    // Resolve the concrete type the writer actually used (wb) against the reader's type.
    function matchType(wb, rt) {
      if (isUnion(rt)) {
        if (rt.some(b => tKey(b) === tKey(wb))) return { kind: "writer" };
        const p = rt.find(b => promotes(wb, b));
        return p ? { kind: "promoted", tag: `${wb}→${p}` } : {
          kind: "error", msg: `branch '${tKey(wb)}' not in reader's union`,
          hint: `A ${rt.map(tKey).join(" or ")} value would have decoded fine.`,
        };
      }
      if (tKey(wb) === tKey(rt)) return { kind: "writer" };
      if (promotes(wb, rt)) return { kind: "promoted", tag: `${wb}→${rt}` };
      if (promotes(rt, wb)) return { kind: "error", msg: `${wb} can't be narrowed to ${rt}`, hint: `Avro only widens: ${rt}→${wb} works, ${wb}→${rt} doesn't.` };
      return { kind: "error", msg: `${tKey(wb)} can't be read as ${tKey(rt)}`, hint: "" };
    }
    // Field order is never consulted: every reader field looks up its writer field by name, then alias.
    function resolve(W, R) {
      const wMap = new Map();
      const reader = R.map((r, idx) => {
        const w = W.find(x => x.name === r.name) || W.find(x => (r.aliases || []).includes(x.name));
        if (!w) {
          return hasDef(r) ? { idx, r, kind: "default", value: r.def }
            : { idx, r, kind: "error", msg: `no value for '${r.name}' and no default`, hint: `Declaring a default for '${r.name}' would fix it.` };
        }
        const v = valueOf(w), wb = isUnion(w.type) ? w.type[branchOf(w.type, v)] : w.type;
        const e = { idx, r, w, alias: w.name !== r.name, value: v, ...matchType(wb, r.type) };
        wMap.set(w, e);
        return e;
      });
      const skipped = W.filter(w => !wMap.has(w));
      // The decoder walks the writer's fields first, then fills reader-only fields: first error wins.
      const order = [...W.map(w => wMap.get(w)).filter(Boolean), ...reader.filter(e => !e.w)];
      const fail = order.find(e => e.kind === "error") || null;
      return { reader, wMap, skipped, fail, ok: !fail, defaults: reader.filter(e => e.kind === "default").length };
    }

    // Avro binary encoding; every byte carries a role so the strip can show text bytes as letters.
    const zz = n => (n >= 0 ? 2 * n : -2 * n - 1);
    function varint(n, role) {
      const out = [];
      do { const b = n % 128; n = Math.floor(n / 128); out.push({ b: n > 0 ? b | 128 : b, role }); } while (n > 0);
      return out;
    }
    const utf8 = str => Array.from(new TextEncoder().encode(str));
    function encode(t, v) {
      if (isUnion(t)) { const i = branchOf(t, v); return [...varint(zz(i), "branch"), ...encode(t[i], v)]; }
      if (t === "null") return [];
      if (t === "int" || t === "long") return varint(zz(v), "num");
      if (t === "string") { const b = utf8(v); return [...varint(zz(b.length), "len"), ...b.map(x => ({ b: x, role: "text" }))]; }
      if (t.array) {
        if (!v.length) return [{ b: 0, role: "end" }];
        return [...varint(zz(v.length), "count"), ...v.flatMap(x => encode(t.array, x)), { b: 0, role: "end" }];
      }
      throw new Error("unsupported type " + tKey(t));
    }
    // One-line account of how the decoder reads a value with the writer's type.
    function describe(t, v) {
      if (isUnion(t)) { const i = branchOf(t, v); return `branch ${i} (${tKey(t[i])})` + (t[i] === "null" ? "" : ", " + describe(t[i], v)); }
      if (t === "string") return `len ${utf8(v).length} + "${v}"`;
      if (t.array) return `block of ${v.length} strings, then 00`;
      return `zigzag varint → ${v}`;
    }
    const payloadBytes = W => W.reduce((n, w) => n + encode(w.type, valueOf(w)).length, 0);
    // ---------------------------------------------------------------- end model

    const MUTED = "var(--viz-muted)", INK = "var(--viz-ink)", OK = "var(--viz-ok)", BAD = "var(--viz-bad)";
    const INFO = "var(--viz-info)", WARN = "var(--viz-warn)";
    // Field colors avoid c3/c4/c6, which already mean prefix/ok/info here.
    const FIELD_COLOR = { userName: "c1", name: "c1", favoriteNumber: "c5", interests: "c8", photoUrl: "c7", email: "c7" };
    const MODES = [
      { value: "file", label: "File header" },
      { value: "version", label: "Version prefix" },
      { value: "registry", label: "Registry ID" },
    ];
    const hex = b => b.toString(16).padStart(2, "0");
    const fmtVal = (v, phone) => (v === null ? "null" : typeof v === "string" ? `"${v}"`
      : Array.isArray(v) ? "[" + v.map(x => `"${x}"`).join(phone ? "," : ", ") + "]" : String(v));

    let presetId = "b", swapped = false, mode = "registry", token = 0, compact = ctx.compact, view = null;
    const preset = () => PRESETS.find(p => p.id === presetId);
    function cfg() {
      const p = preset();
      return swapped ? { W: p.r, R: p.w, wv: p.rv, rv: p.wv } : { W: p.w, R: p.r, wv: p.wv, rv: p.rv };
    }

    // ---------------------------------------------------------------- layout
    function layout(phone) {
      const L = phone
        ? { W: 360, wx: 4, rx: 206, cw: 150, rowH: 38, nameFs: 12, fs: 11, titleY: 13, cardY: 24,
          strip: { x: 4, w: 352, cell: 34, ch: 24, gap: 6, rowH: 46 } }
        : { W: 640, wx: 8, rx: 382, cw: 250, rowH: 36, nameFs: 13, fs: 12, titleY: 13, cardY: 24,
          strip: { x: 8, w: 624, cell: 32, ch: 24, gap: 6, rowH: 48 } };
      L.phone = phone;
      L.stripY = L.cardY + 4 * L.rowH + 8 + 22;
      // Reserve room for the most strip rows any scenario/direction/mode needs, so nothing jumps.
      L.strip.maxRows = 1;
      for (const p of PRESETS) for (const sw of [false, true]) for (const m of MODES) {
        const c = sw ? { W: p.r, wv: p.rv } : { W: p.w, wv: p.wv };
        L.strip.maxRows = Math.max(L.strip.maxRows, placeStrip(stripGroups(c, m.value, phone), L.strip, 0).rows);
      }
      L.objY = L.stripY + 14 + L.strip.maxRows * L.strip.rowH + 16;
      L.lineH = phone ? 17 : 18;
      L.H = L.objY + 12 + 4 * L.lineH + 6;
      return L;
    }

    // Strip groups: the schema prefix, then one group of bytes per writer field in writer order.
    function stripGroups(c, m, phone) {
      const pre = { label: "", color: "c3", cells: [] };
      if (m === "file") Object.assign(pre, { label: "header: once per file", cells: [{ t: "Obj 01 + schema", u: 5, dashed: true }] });
      else if (m === "version") Object.assign(pre, { label: `version ${c.wv}`, cells: [{ t: hex(c.wv), bold: true }] });
      else Object.assign(pre, { label: `magic + schema id ${41 + c.wv}`, cells: [0, 0, 0, 0, 41 + c.wv].map(b => ({ t: hex(b), bold: true })) });
      const fields = c.W.map(w => {
        const bytes = encode(w.type, valueOf(w));
        const cap = phone ? 9 : 12;   // keeps every group on one strip row
        const cells = bytes.slice(0, cap).map(x => (x.role === "text" ? { t: String.fromCharCode(x.b) } : { t: hex(x.b), bold: true }));
        if (bytes.length > cap) cells.push({ t: "+" + (bytes.length - cap), more: true });
        return { field: w, label: w.name, color: FIELD_COLOR[w.name], cells };
      });
      return [pre, ...fields];
    }
    // Flow groups into rows. Keep each group on one row when the reserved rows allow it,
    // otherwise split groups across rows (maxRows 0 = as few rows as possible).
    function placeStrip(groups, S, maxRows) {
      const run = split => {
        const segs = [];
        let row = 0, x = S.x;
        const right = S.x + S.w;
        groups.forEach((g, gi) => {
          const units = g.cells.map(c => c.u || 1), total = units.reduce((a, b) => a + b, 0);
          const room = Math.floor((right - x + 0.5) / S.cell);
          if (x > S.x && (split ? room < Math.min(2, total) : room < total)) { row++; x = S.x; }
          let i = 0;
          while (i < g.cells.length) {
            let take = 0, w = 0;
            while (i + take < g.cells.length && x + w + units[i + take] * S.cell <= right + 0.5) { w += units[i + take] * S.cell; take++; }
            if (!take) { row++; x = S.x; continue; }
            segs.push({ gi, row, x, w, cells: g.cells.slice(i, i + take), first: i === 0 });
            i += take; x += w;
            if (i < g.cells.length) { row++; x = S.x; }
          }
          x += S.gap;
        });
        return { segs, rows: row + 1 };
      };
      const whole = run(false);
      return maxRows && whole.rows <= maxRows ? whole : run(true);
    }

    // ---------------------------------------------------------------- build
    function build() {
      root.innerHTML = "";
      token++;
      compact = ctx.compact;
      const L = layout(compact);
      const select = ui.select({
        label: "Scenario", value: presetId,
        options: PRESETS.map(p => ({ value: p.id, label: compact ? p.short : p.label })),
        onChange: v => { presetId = v; render(); },
      });
      const swapBtn = ui.button("⇄ Swap writer and reader", () => { swapped = !swapped; render(); }, { kind: "ghost" });
      const badge = ui.badge("swapped", "warn");
      const decodeBtn = ui.button("▶ Decode", () => decode(), { kind: "primary" });
      const seg = ui.segmented({ label: "Writer's schema travels in", options: MODES, value: mode, onChange: v => { mode = v; render(); } });
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Writer's and reader's schemas matched by field name, the encoded bytes, and the object the reader gets" });
      const layer = s("g");
      svg.appendChild(layer);
      const legend = ui.legend([
        { color: OK, label: "matched by name", shape: "line" },
        { color: OK, label: "matched via alias", shape: "dash" },
        { color: INFO, label: "type promoted", shape: "line" },
        { color: BAD, label: "incompatible", shape: "line" },
      ]);
      const caption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin:0 0 4px" },
        "Bold hex cells are lengths, zigzag-varint numbers, union branch indexes and array block counts; " +
        "letter cells are UTF-8 text bytes. Nothing marks where a field starts or what type it is: " +
        "only the writer's schema can make sense of these bytes.");
      const stats = ui.stats([
        { key: "bytes", label: "Payload bytes" },
        { key: "prefix", label: "Schema cost per record" },
        { key: "dir", label: "Checks" },
        { key: "defaults", label: "Defaults used" },
        { key: "skipped", label: "Skipped" },
        { key: "result", label: "Result" },
      ]);
      const note = ui.note("");
      root.append(ui.bar(select, swapBtn, badge, decodeBtn), ui.bar(seg), svg, legend, caption, stats, note);
      view = { L, layer, swapBtn, badge, stats, note };
      render();
    }

    // ---------------------------------------------------------------- scene
    function render() {
      token++;
      const c = cfg(), res = resolve(c.W, c.R);
      view.layer.innerHTML = "";
      // Skipped writer rows are dimmed; reader rows that can't be resolved turn red.
      const wRows = drawCard(view.L.wx, "Writer's schema", "c6", c.wv, c.rv, c.W, f => (res.wMap.has(f) ? "" : "dim"));
      const rRows = drawCard(view.L.rx, "Reader's schema", "c2", c.rv, c.wv, c.R, (f, i) => (res.reader[i].kind === "error" ? "bad" : ""));
      view.scene = { c, res, wRows, rRows, links: drawLinks(c, res, wRows, rRows), strip: drawStrip(c), obj: drawObject(c, res) };
      updateHud(c, res);
    }
    const add = el => { view.layer.appendChild(el); return el; };

    function drawCard(x, title, color, v, other, fields, styleOf) {
      const L = view.L, col = `var(--viz-${color})`;
      add(ctx.text(x, L.titleY, title, { size: 12, weight: 700, fill: col, anchor: "start" }));
      const tag = v === other || L.phone ? `v${v}` : `v${v} · ${v > other ? "new" : "old"}`;
      add(ctx.text(x + L.cw, L.titleY, tag, { size: L.fs, weight: 600, fill: MUTED, anchor: "end" }));
      add(s("rect", { x, y: L.cardY, width: L.cw, height: fields.length * L.rowH + 8, rx: 8, fill: "var(--viz-panel)", stroke: col, "stroke-width": 1.5 }));
      return fields.map((f, i) => {
        const y0 = L.cardY + 4 + i * L.rowH;
        if (i) add(s("line", { x1: x + 8, x2: x + L.cw - 8, y1: y0, y2: y0, stroke: "var(--viz-grid)" }));
        const hl = add(s("rect", { x: x + 3, y: y0 + 2, width: L.cw - 6, height: L.rowH - 4, rx: 5, fill: "var(--viz-warn-soft)", stroke: WARN, opacity: 0 }));
        const st = styleOf(f, i), g = add(s("g", { opacity: st === "dim" ? 0.5 : 1 }));
        const tx = x + (L.phone ? 12 : 15);
        g.append(s("rect", { x: x + (L.phone ? 5 : 6), y: y0 + 8, width: 3, height: L.rowH - 16, rx: 1.5, fill: `var(--viz-${FIELD_COLOR[f.name]})` }));
        g.append(ctx.text(tx, y0 + L.rowH * 0.34, f.name, { size: L.nameFs, weight: 700, mono: true, anchor: "start", fill: st === "bad" ? BAD : INK }));
        g.append(ctx.text(tx, y0 + L.rowH * 0.73, typeLine(f, L.phone), { size: L.fs, mono: true, anchor: "start", fill: MUTED }));
        return { y: y0 + L.rowH / 2, hl };
      });
    }
    function typeLine(f, phone) {
      const t = phone ? tKey(f.type).replace(/string/g, "str") : tKey(f.type);
      if (f.aliases) return `${t}, alias${phone ? "" : ":"} ${f.aliases[0]}`;
      if (hasDef(f)) return `${t} = ${fmtVal(f.def)}`;
      return phone ? `${t}, no default` : `${t} (no default)`;
    }

    // Lines in the gap between the cards: writer row (right edge) -> reader row (left edge).
    function drawLinks(c, res, wRows, rRows) {
      const L = view.L, x1 = L.wx + L.cw, x2 = L.rx, k = (x2 - x1) * 0.45, fs = L.fs;
      const byWriter = new Map();
      const dot = (x, y, fill, hollow) => add(s("circle", { cx: x, cy: y, r: 3.2, fill: hollow ? "var(--viz-panel)" : fill, stroke: fill, "stroke-width": 1.5 }));
      res.reader.forEach((e, i) => {
        if (!e.w) return;
        const y1 = wRows[c.W.indexOf(e.w)].y, y2 = rRows[i].y;
        const col = e.kind === "error" ? BAD : e.kind === "promoted" ? INFO : OK;
        const path = add(s("path", {
          d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`, fill: "none", stroke: col,
          "stroke-width": 1.8, "stroke-dasharray": e.alias ? "6 4" : null,
        }));
        dot(x1, y1, col); dot(x2, y2, col);
        const tag = e.kind === "error" ? "✕" : e.kind === "promoted" ? e.tag : e.alias ? "alias" : "";
        if (tag) add(ctx.text((x1 + x2) / 2, (y1 + y2) / 2, tag, { size: e.kind === "error" ? 14 : fs, weight: 700, fill: col, halo: true }));
        byWriter.set(e.w, path);
      });
      // Writer-only rows say "skip"; reader-only rows say "default" or "no default!". When both sit
      // on the same row height, nudge them apart vertically.
      const readerOnly = new Set(res.reader.filter(e => !e.w).map(e => e.idx));
      res.skipped.forEach(w => {
        const i = c.W.indexOf(w), y = wRows[i].y, dy = readerOnly.has(i) ? -8 : 0;
        dot(x1, y, MUTED, true);
        add(ctx.text(x1 + 7, y + dy, "skip", { size: fs, weight: 700, fill: MUTED, anchor: "start", halo: true }));
      });
      res.reader.forEach((e, i) => {
        if (e.w) return;
        const y = rRows[i].y, dy = res.skipped.some(w => c.W.indexOf(w) === i) ? 8 : 0;
        const col = e.kind === "default" ? INFO : BAD;
        dot(x2, y, col, true);
        const label = e.kind === "default" ? "default" : L.phone ? "none!" : "no default!";
        add(ctx.text(x2 - 7, y + dy, label, { size: fs, weight: 700, fill: col, anchor: "end", halo: true }));
      });
      return { byWriter };
    }

    function drawStrip(c) {
      const L = view.L, S = L.strip, fs = L.fs;
      const header = add(ctx.text(S.x, L.stripY, "", { size: fs, weight: 700, anchor: "start" }));
      const groups = stripGroups(c, mode, L.phone), { segs } = placeStrip(groups, S, S.maxRows);
      const outlines = groups.map(() => []);
      const lastEnd = {};
      segs.forEach(sg => {
        const g = groups[sg.gi], col = `var(--viz-${g.color})`, top = L.stripY + 14 + sg.row * S.rowH;
        const cy = top + 16;
        let x = sg.x;
        sg.cells.forEach(cell => {
          const w = (cell.u || 1) * S.cell;
          add(s("rect", {
            x: x + 1, y: cy, width: w - 2, height: S.ch, rx: 3, fill: cell.more ? "none" : `var(--viz-${g.color}-soft)`,
            stroke: cell.more ? MUTED : col, "stroke-width": 1, "stroke-dasharray": cell.dashed || cell.more ? "4 3" : null,
          }));
          add(ctx.text(x + w / 2, cy + S.ch / 2 + 0.5, cell.t, { size: fs, mono: true, weight: cell.bold ? 700 : 400, fill: cell.more ? MUTED : INK }));
          x += w;
        });
        outlines[sg.gi].push(add(s("rect", { x: sg.x - 1, y: cy - 3, width: sg.w + 2, height: S.ch + 6, rx: 5, fill: "none", stroke: WARN, "stroke-width": 2.5, opacity: 0 })));
        if (!sg.first) return;
        // Field label above the group; long labels push the next label right instead of colliding.
        const lw = g.label.length * fs * 0.6;
        let lx = Math.max(sg.x + 1, (lastEnd[sg.row] || -99) + 14);
        lx = Math.min(lx, S.x + S.w - lw);
        lastEnd[sg.row] = lx + lw;
        add(ctx.text(lx, top + 6, g.label, { size: fs, mono: true, weight: 700, fill: col, anchor: "start" }));
      });
      const strip = { header, outlines };
      setStatus(strip, null);
      return strip;
    }
    function setStatus(strip, text, tone) {
      const L = view.L;
      strip.header.textContent = text || (L.phone ? "Bytes on the wire, in the writer's order" : "Bytes on the wire, in the writer's field order (no names, no tags)");
      ctx.attr(strip.header, { fill: text ? tone || WARN : INK });
    }

    function drawObject(c, res) {
      const L = view.L, x = L.phone ? 4 : 8, fs = L.fs, cw = fs * 0.6;
      const head = add(ctx.text(x, L.objY, "Reader's object", { size: 12, weight: 700, anchor: "start" }));
      head.appendChild(s("tspan", { fill: MUTED, "font-weight": 400 }, L.phone ? " (reader's order)" : "  fields in the reader's order"));
      const rows = res.reader.filter(e => e.kind !== "error").map(e => {
        const why = e.kind === "default" ? (L.phone ? "← default" : "← reader's default")
          : e.kind === "promoted" ? (L.phone ? `← ${e.tag}` : `← writer, promoted ${e.tag}`)
            : e.alias ? (L.phone ? "← alias" : `← writer, via alias ${e.w.name}`) : (L.phone ? "← writer" : "← from writer");
        return { key: e.idx, left: `${e.r.name} = ${fmtVal(e.value, L.phone)}`, why, tone: e.kind === "default" ? INFO : OK };
      });
      res.skipped.forEach(w => rows.push({ key: w, left: `${w.name}: skipped`, why: "", tone: MUTED }));
      const col2 = x + 10 + Math.max(...rows.map(r => r.left.length)) * cw + 14;
      const lines = new Map();
      rows.forEach((r, i) => {
        const y = L.objY + 12 + L.lineH * (i + 0.5);
        const g = add(s("g", { opacity: res.ok ? 1 : 0 }));
        g.append(s("circle", { cx: x + 3, cy: y, r: 2.6, fill: r.tone }));
        g.append(ctx.text(x + 10, y, r.left, { size: fs, mono: true, anchor: "start", fill: r.tone === MUTED ? MUTED : INK }));
        if (r.why) g.append(ctx.text(col2, y, r.why, { size: fs, mono: true, weight: 600, anchor: "start", fill: r.tone }));
        lines.set(r.key, g);
      });
      // On failure the reader gets no object at all: the error replaces it.
      const err = add(s("g", { opacity: res.ok ? 0 : 1 }));
      if (res.fail) {
        const y = i => L.objY + 12 + L.lineH * (i + 0.6);
        err.append(ctx.text(x, y(0), "✕ Decoding fails, the reader gets no object", { size: fs, weight: 700, anchor: "start", fill: BAD }));
        err.append(ctx.text(x + 14, y(1), res.fail.msg, { size: fs, mono: true, weight: 700, anchor: "start", fill: BAD }));
        err.append(ctx.text(x + 14, y(2), res.fail.hint, { size: fs, anchor: "start", fill: MUTED }));
      }
      return { lines, err };
    }

    // ---------------------------------------------------------------- stats + note
    const NOTES = {
      a: ["Writer and reader use the same schema, so every field resolves to itself by name. The 32 bytes hold only values: no field names, no tags, no types."],
      b: ["The writer never wrote <b>photoUrl</b>, so the reader fills in its default (<code>null</code>). Swap roles: a reader that doesn't know photoUrl just skips it. Compatible both ways.",
        "The newer writer includes <b>photoUrl</b>; this older reader decodes those bytes with the writer's schema and drops them. Adding a field <em>with</em> a default is compatible both ways."],
      c: ["The reader needs <b>email</b>, the writer's data doesn't have it, and there's no default to fall back on, so decoding fails. Adding a field without a default breaks backward compatibility.",
        "Now the writer has <b>email</b> and the older reader simply skips it. Compatibility is directional."],
      d: ["Order doesn't matter: the bytes are decoded in the writer's order, then matched to the reader's fields by name."],
      e: ["The reader's alias maps old <b>userName</b> data onto <b>name</b>, so new readers can read old data.",
        "Old readers look for <b>userName</b>, find only <b>name</b>, and have no default. Aliases give backward compatibility, not forward."],
      f: ["An <b>int</b> written by the writer is promoted to the reader's <b>long</b>.",
        "Avro never narrows a <b>long</b> into an <b>int</b>, so this direction fails."],
      g: ["The writer picked union branch 2 (<b>string</b>), which the reader's union lacks. Adding a union branch is backward compatible but not forward compatible.",
        "This old writer only ever picks <b>null</b> or <b>long</b>, and the new reader's union still has both, so new readers read old data: adding a union branch is backward compatible."],
    };
    const MODE_NOTE = {
      file: "In an object container file the schema sits once in the header, so per-record cost is essentially zero.",
      version: "Each record starts with a schema version number that the reader looks up, as LinkedIn's Espresso does.",
      registry: "Each Kafka message starts with magic byte 0 and a 4-byte schema ID; consumers fetch that schema from the registry once and cache it.",
    };
    const small = t => `<div class="muted" style="font-size:12px;font-weight:600">${t}</div>`;
    function updateHud(c, res) {
      const { stats, note, badge, swapBtn } = view;
      badge.style.display = swapped ? "" : "none";
      swapBtn.setActive(swapped);
      stats.set("bytes", String(payloadBytes(c.W)));
      stats.set("prefix", { file: "≈ 0" + small("once per file"), version: "1 byte", registry: "5 bytes" }[mode]);
      const dir = c.wv === c.rv ? ["–", ""] : c.wv < c.rv ? ["backward", "new reads old"] : ["forward", "old reads new"];
      stats.set("dir", dir[0] + (dir[1] ? small(dir[1]) : ""), dir[1] ? "info" : "");
      stats.set("defaults", String(res.defaults), res.defaults ? "info" : "");
      stats.set("skipped", String(res.skipped.length));
      stats.set("result", res.ok ? "OK" : "ERROR", res.ok ? "ok" : "bad");
      const texts = NOTES[presetId], body = swapped && texts[1] ? texts[1] : texts[0];
      note.set(`${body} ${MODE_NOTE[mode]}`, res.ok ? "ok" : "bad");
    }

    // ---------------------------------------------------------------- decode animation
    // Walks the writer's fields in byte order: highlight the group, pulse its link and rows,
    // then reveal where the value landed. Any control change bumps the token and redraws.
    async function decode() {
      render();
      const my = token, { c, res, wRows, rRows, links, strip, obj } = view.scene;
      const live = () => my === token && ctx.alive;
      obj.lines.forEach(g => g.setAttribute("opacity", 0));
      obj.err.setAttribute("opacity", 0);
      const pulse = (els, ms) => ctx.tween({
        ms, ease: "linear", onUpdate: t => {
          const p = Math.sin(Math.PI * t);
          els.forEach(([el, kind]) => {
            if (kind === "line") el.setAttribute("stroke-width", 1.8 + 3 * p);
            else el.setAttribute("opacity", kind === "row" ? 0.9 * p : t < 1 ? 1 : 0);
          });
        },
      });
      const reveal = el => el && ctx.tween({ ms: 220, onUpdate: t => el.setAttribute("opacity", t) });
      const pre = { file: "file header", version: `version ${c.wv}`, registry: `schema id ${41 + c.wv}` }[mode];
      setStatus(strip, `${pre} → writer's schema v${c.wv}${mode === "registry" ? " (from the registry)" : ""}`);
      await pulse([...strip.outlines[0].map(o => [o, "box"]), ...wRows.map(r => [r.hl, "row"])], 800);
      for (const w of c.W) {
        if (!live()) return;
        const e = res.wMap.get(w), i = c.W.indexOf(w);
        setStatus(strip, `${w.name}: ${describe(w.type, valueOf(w))}${e ? "" : " → skip"}`);
        const els = [...strip.outlines[i + 1].map(o => [o, "box"]), [wRows[i].hl, "row"]];
        if (e) els.push([links.byWriter.get(w), "line"], [rRows[e.idx].hl, "row"]);
        await pulse(els, 700);
        if (!live()) return;
        if (e && e.kind === "error") return fail(e);
        await reveal(obj.lines.get(e ? e.idx : w));
      }
      for (const e of res.reader.filter(x => !x.w)) {
        if (!live()) return;
        setStatus(strip, `${e.r.name}: not in the writer's data → ${e.kind === "default" ? "default " + fmtVal(e.r.def) : "no default"}`, e.kind === "default" ? INFO : BAD);
        await pulse([[rRows[e.idx].hl, "row"]], 700);
        if (!live()) return;
        if (e.kind === "error") return fail(e);
        await reveal(obj.lines.get(e.idx));
      }
      await ctx.sleep(600);
      if (live()) render();

      async function fail(e) {
        setStatus(strip, `${e.r.name}: ${e.msg}`, BAD);
        obj.lines.forEach(g => g.setAttribute("opacity", 0));
        await reveal(obj.err);
        await ctx.sleep(1400);
        if (live()) render();
      }
    }

    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
