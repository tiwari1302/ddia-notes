// Evolving a Protobuf schema (DDIA ch4). Pick a schema change and decode the bytes both ways:
// v2 code reading v1 bytes (backward) and v1 code reading v2 bytes (forward). A reader matches
// fields by tag number alone: unknown tags are skipped using the wire type, missing ones get
// defaults. That makes optional additions, deletions and renames safe, while a reused or
// renumbered tag, a narrowed integer, a closed enum or a 'required' field breaks loudly or silently.
Viz.register("ch4/tag-evolution", {
  title: "Evolving a Protobuf schema",
  mount(root, ctx) {
    const { s, h, ui } = ctx;

    // ---------------- Schemas and records (proto2) ----------------
    // `id` is a field's meaning: a rename keeps it, a field that reuses a tag gets a new one.
    const NAME = { tag: 1, type: "string", name: "user_name", id: "name", label: "req" };
    const FAV = { tag: 2, type: "int64", name: "favorite_number", id: "fav", label: "opt" };
    const INTS = { tag: 3, type: "string", name: "interests", id: "ints", label: "rep" };
    const BASE = [NAME, FAV, INTS];
    const REC = { name: "Martin", fav: 1337, ints: ["hacking"] };
    const PLAN = { tag: 4, type: "Plan", name: "plan", id: "plan", label: "opt" };
    const field = (base, more) => Object.assign({}, base, more);
    const added = fl => field(fl, { mark: "added", note: "new" });
    const deleted = fl => field(fl, { mark: "deleted", note: "deleted" });
    const changed = (fl, more, note) => field(fl, Object.assign({ mark: "changed", note }, more));
    const schema = (fields, extra = [], enums = {}) => ({ fields, extra, enums });

    const CHANGES = [
      { name: "Add optional field", tone: "ok",
        v1: schema(BASE),
        v2: schema([...BASE, added({ tag: 4, type: "string", name: "photo_url", id: "photo", label: "opt" })]),
        r1: REC, r2: { ...REC, photo: "m.png" },
        note: "Old code skipped tag 4 using its wire type (read the length, jump 5 bytes) and keeps it as an " +
          "<b>unknown field</b>; new code found no tag 4 and used the <b>default</b>. Safe both ways." },
      { name: "Add required field", tone: "bad",
        v1: schema(BASE),
        v2: schema([...BASE, added({ tag: 4, type: "string", name: "email", id: "email", label: "req" })]),
        r1: REC, r2: { ...REC, email: "m@x.io" },
        note: "New code <b>rejects every record written before the change</b>, because none of them can contain " +
          "email. Fields added later must be optional; proto3 dropped 'required' altogether." },
      { name: "Delete optional field", tone: "ok",
        v1: schema(BASE),
        v2: schema([NAME, deleted(FAV), INTS], [{ text: "reserved 2;", muted: true }]),
        r1: REC, r2: { name: "Martin", ints: ["hacking"] },
        note: "Deleting an optional field is safe as long as its number is <b>reserved</b> so nobody can reuse it. " +
          "Old code must cope with favorite_number being unset." },
      { name: "Delete required field", tone: "bad",
        v1: schema(BASE),
        v2: schema([deleted(NAME), FAV, INTS]),
        r1: REC, r2: { fav: 1337, ints: ["hacking"] },
        note: "Old code still insists user_name is present and <b>rejects every new record</b>. Required fields " +
          "can never be removed: 'required is forever'." },
      { name: "Reuse a deleted tag", tone: "bad",
        v1: schema(BASE),
        v2: schema([NAME, deleted(FAV), added({ tag: 2, type: "int64", name: "referrer_id", id: "ref", label: "opt" }), INTS]),
        r1: REC, r2: { name: "Martin", ref: 4242, ints: ["hacking"] },
        note: "<b>No error anywhere, and that's the problem:</b> tag 2 means two different things depending on who " +
          "wrote the bytes. 'reserved 2;' turns this into a compile error." },
      { name: "Rename a field", tone: "ok",
        v1: schema(BASE),
        v2: schema([changed(NAME, { name: "display_name" }, "renamed"), FAV, INTS]),
        r1: REC, r2: REC,
        note: "Names never appear in the binary encoding, so the rename is <b>invisible on the wire</b>. It does " +
          "break Protobuf's JSON mapping and code that refers to the old name." },
      { name: "Change a tag number", tone: "bad",
        v1: schema(BASE),
        v2: schema([NAME, FAV, changed(INTS, { tag: 5 }, "was #3")]),
        r1: REC, r2: REC,
        note: "To a parser, a new number is a <b>brand-new field</b>: data under the old tag is skipped in both " +
          "directions and interests silently vanish." },
      { name: "Widen int32 → int64", tone: "bad",
        v1: schema([NAME, field(FAV, { type: "int32" }), INTS]),
        v2: schema([NAME, changed(FAV, {}, "was int32"), INTS]),
        r1: REC, r2: { ...REC, fav: 5000000000 },
        note: "New code reads old 32-bit values fine, but old code squeezes 5,000,000,000 into 32 bits and gets " +
          "<b>705,032,704</b> with no error." },
      { name: "Single value → repeated", tone: "warn",
        v1: schema([...BASE, { tag: 4, type: "string", name: "email", id: "email", label: "opt" }]),
        v2: schema([...BASE, changed({ tag: 4, type: "string", name: "emails", id: "email", label: "rep" }, {}, "was opt")]),
        r1: { ...REC, email: "a@x.io" }, r2: { ...REC, email: ["a@x.io", "b@y.io"] },
        note: "Old code sees tag 4 twice and <b>keeps the last value</b>, so 'a@x.io' disappears if old code reads " +
          "and rewrites the record. This change is only allowed for string, bytes and message fields: repeated " +
          "numbers are packed by default in proto3, which a singular reader can't parse." },
      { name: "Add an enum value", tone: "warn",
        v1: schema([...BASE, PLAN], [{ text: "enum Plan {FREE=0 PRO=1}" }], { Plan: ["FREE", "PRO"] }),
        v2: schema([...BASE, PLAN], [{ text: "enum Plan {FREE=0 PRO=1 TEAM=2}", mark: "changed", note: "+TEAM" }],
          { Plan: ["FREE", "PRO", "TEAM"] }),
        r1: { ...REC, plan: "PRO" }, r2: { ...REC, plan: "TEAM" },
        foot: "proto3 (open enums) would keep 2; Java shows UNRECOGNIZED",
        note: "Old code has never heard of TEAM. A proto2 enum is <b>closed</b>, so the raw 2 is parked among the " +
          "unknown fields and the field reports its default, FREE: <b>a paying team is treated as a free user</b>, " +
          "with no error. Old code must map unknown enum values to an explicit 'unknown' case, and value 0 should " +
          "be an UNSPECIFIED sentinel." },
    ];

    // ---------------- Encoding and decoding (pure) ----------------
    const SEV = { OK: 0, LOSSY: 1, MISREAD: 2, CORRUPTS: 3, BREAKS: 4 };
    const TONE = { OK: "ok", LOSSY: "warn", MISREAD: "warn", CORRUPTS: "bad", BREAKS: "bad" };
    const live = sc => sc.fields.filter(fl => fl.mark !== "deleted");
    const varintLen = n => { let b = 1; while (n >= 128) { n = Math.floor(n / 128); b++; } return b; };
    const toInt32 = n => { const u = ((n % 2 ** 32) + 2 ** 32) % 2 ** 32; return u >= 2 ** 31 ? u - 2 ** 32 : u; };
    const show = (fl, v) => (fl.type === "string" ? `'${v}'` : String(v));

    /** One chunk per encoded field occurrence, in tag order (as Protobuf serializers write them). */
    function encode(sc, rec) {
      const out = [];
      live(sc).slice().sort((a, b) => a.tag - b.tag).forEach(fl => {
        const v = rec[fl.id];
        if (v === undefined) return;
        (Array.isArray(v) ? v : [v]).forEach(x => {
          const raw = sc.enums[fl.type] ? sc.enums[fl.type].indexOf(x) : x;
          const len = fl.type === "string";
          out.push({ tag: fl.tag, wire: len ? "LEN" : "VARINT", raw, bytes: len ? x.length : varintLen(raw), text: len ? `'${x}'` : String(raw) });
        });
      });
      return out;
    }

    const matchWhy = (r, w) =>
      r.label === "rep" && w.label !== "rep" ? `matched by tag ${r.tag}: one value → 1-item list`
        : w.name !== r.name ? `matched by tag ${r.tag} (written as ${w.name})`
        : w.type !== r.type ? `matched by tag ${r.tag}: ${w.type} value fits in ${r.type}`
        : `matched by tag ${r.tag}`;
    const defaultOf = (r, R) => (r.label === "rep" ? "[]" : R.enums[r.type] ? R.enums[r.type][0] : r.type === "string" ? "''" : "0");

    /**
     * Decode `chunks` (written with schema W) using reader schema R. Returns a replayable lane:
     * events (cursor targets), chunk states and append-only lines, each stamped with the event
     * index `at` where it appears or changes, plus the lane's overall status.
     */
    function decode(R, W, chunks, foot) {
      const rf = live(R), wf = live(W);
      const L = { chunks: chunks.map(c => ({ ...c, states: [] })), lines: [], events: [], status: "OK", rejectAt: null };
      const event = target => L.events.push(target) - 1;
      const line = (v, kind = "field") => { const ln = { kind, versions: [v] }; L.lines.push(ln); return ln; };
      const worse = st => { if (SEV[st] > SEV[L.status]) L.status = st; };
      const got = {};
      L.chunks.forEach((c, i) => {
        const r = rf.find(x => x.tag === c.tag), w = wf.find(x => x.tag === c.tag);
        const at = event({ chunk: i, row: r ? r.tag : null });
        if (!r) {
          c.states.push({ at, kind: "skip" });
          line({ at, tone: "muted", text: `tag ${c.tag} (unknown)`, why: c.wire === "LEN"
            ? `LEN prefix says ${c.bytes} B: skipped, kept as unknown field`
            : `skipped the ${c.bytes}-byte VARINT, kept as unknown field` }, "skip");
          return;
        }
        const names = R.enums[r.type];
        if (names && c.raw >= names.length) {   // proto2 enums are closed
          c.states.push({ at, kind: "parked" });
          got[r.name] = true;
          worse("MISREAD");
          line({ at, tone: "warn", text: `${r.name} = ${names[0]}`, why: `← was ${W.enums[w.type][c.raw]} (${c.raw}), parked as unknown field` });
          return;
        }
        const v = names ? names[c.raw] : r.type === "int32" ? toInt32(c.raw) : c.raw;
        let tone = "ok", why = matchWhy(r, w);
        if (w.id !== r.id) { tone = "bad"; why = `← was ${w.name}!`; }
        else if (!names && v !== c.raw) { tone = "bad"; why = `← truncated from ${c.raw}`; }
        if (tone === "bad") worse("CORRUPTS");
        c.states.push({ at, kind: tone });
        const prev = got[r.name];
        if (r.label === "rep") {
          const vals = prev ? prev.vals.concat(v) : [v];
          const ver = { at, tone, text: `${r.name} = [${vals.map(x => show(r, x)).join(", ")}]`, why };
          if (prev) { prev.vals = vals; prev.ln.versions.push(ver); } else got[r.name] = { vals, ln: line(ver) };
        } else if (prev) {   // a singular field seen twice: the last value wins
          worse("LOSSY");
          L.chunks[prev.chunk].states.push({ at, kind: "lost" });
          prev.ln.versions.push({ at, tone: "warn", text: `${r.name} = ${show(r, v)}`, why: `← ${show(r, prev.v)} overwritten: last value wins` });
        } else {
          got[r.name] = { v, chunk: i, ln: line({ at, tone, text: `${r.name} = ${show(r, v)}`, why }) };
        }
      });
      // After the bytes: required fields must be present, everything else falls back to its default.
      rf.forEach(r => {
        if (got[r.name]) return;
        const at = event({ row: r.tag });
        if (r.label === "req") {
          worse("BREAKS");
          line({ at, tone: "bad", text: `ERROR: missing required field ${r.name}` }, "error");
          return;
        }
        const moved = wf.find(w => w.id === r.id && w.tag !== r.tag && chunks.some(c => c.tag === w.tag));
        const dv = defaultOf(r, R);
        if (moved) {
          worse("CORRUPTS");
          line({ at, tone: "bad", text: `${r.name} = ${dv}`, why: `← data under tag ${moved.tag} ignored` });
        } else line({ at, tone: "info", text: `${r.name} = ${dv}`, why: `no tag ${r.tag} in the bytes → default` });
      });
      if (L.status === "BREAKS") {
        L.rejectAt = event(null);
        line({ at: L.rejectAt, tone: "bad", text: "record rejected: parse error, no User object" }, "error");
      }
      if (foot && L.status === "MISREAD") line({ at: event(null), tone: "muted", text: foot }, "foot");
      return L;
    }

    const buildModel = c => ({
      B: decode(c.v2, c.v1, encode(c.v1, c.r1), c.foot),
      F: decode(c.v1, c.v2, encode(c.v2, c.r2), c.foot),
    });

    // ---------------- Controls ----------------
    let idx = 0, token = 0, compact = ctx.compact, G = null, model = null, view = null;
    const select = ui.select({
      label: "Schema change",
      options: CHANGES.map((c, i) => ({ value: i, label: c.name })),
      value: 0,
      onChange: v => { idx = Number(v); drawScene(); },
    });
    const decodeBtn = ui.button("▶ Decode", () => runDecode(), { kind: "primary", title: "Decode both directions step by step" });
    const caption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin:-4px 0 10px" },
      "Each chunk is one encoded field: tag, wire type and value. Field names are not in the bytes, so a reader " +
      "matches fields by tag alone. Pick a change, then press Decode to watch both directions.");
    const svg = ctx.svg({ w: 640, h: 400, label: "Two Protobuf schema versions and how each decodes the other's bytes" });
    const scene = s("g");
    svg.appendChild(scene);
    const legend = ui.legend([
      { color: "var(--viz-c1)", label: "tag", shape: "square" },
      { color: "var(--viz-ok)", label: "matched" },
      { color: "var(--viz-info)", label: "default" },
      { color: "var(--viz-muted)", label: "skipped", shape: "dash" },
      { color: "var(--viz-bad)", label: "error / corrupted" },
      { color: "var(--viz-warn)", label: "lossy / misread" },
    ]);
    const stats = ui.stats([
      { key: "back", label: "Backward (new reads old)", value: "" },
      { key: "fwd", label: "Forward (old reads new)", value: "" },
      { key: "safe", label: "Safe to roll out?", value: "" },
    ]);
    const note = ui.note("");
    root.append(ui.bar(select, decodeBtn), caption, svg, legend, stats, note);

    // ---------------- Layout ----------------
    const COL = { ok: "var(--viz-ok)", info: "var(--viz-info)", muted: "var(--viz-muted)", bad: "var(--viz-bad)", warn: "var(--viz-warn)" };
    const NOTE_COL = { added: "var(--viz-info)", changed: "var(--viz-warn)", deleted: "var(--viz-muted)" };
    const ROW = 18, CHUNK_H = 38;
    const layoutFor = c => (c
      ? { W: 360, fs: 11, cw: 6.7, cards: [[8, 344], [8, 344]], stack: true, laneW: 344, perRow: 2, wrap: 54 }
      : { W: 640, fs: 12, cw: 7.3, cards: [[8, 304], [328, 304]], stack: false, laneW: 624, perRow: 5, whyX: 262 });
    const rowsOf = sc => [...sc.fields, ...sc.extra];
    const T = (layer, x, y, str, o) => layer.appendChild(ctx.text(x, y, str, { anchor: "start", ...o }));

    function drawRow(layer, x, cy, w, row) {
      const { fs, cw } = G;
      const dim = row.mark === "deleted" || row.muted;
      const ink = dim ? "var(--viz-muted)" : "var(--viz-ink)";
      if (row.mark === "added" || row.mark === "changed") {
        layer.appendChild(s("rect", { x: x + 4, y: cy - 9, width: w - 8, height: 18, rx: 4,
          fill: row.mark === "added" ? "var(--viz-info-soft)" : "var(--viz-warn-soft)" }));
      }
      let end;
      if (row.text) {
        T(layer, x + 10, cy, row.text, { size: fs, mono: true, fill: ink });
        end = x + 10 + row.text.length * cw;
      } else {
        layer.appendChild(s("rect", { x: x + 8, y: cy - 7.5, width: 26, height: 15, rx: 3, fill: dim ? "var(--viz-grid)" : "var(--viz-c1-soft)" }));
        T(layer, x + 21, cy, "#" + row.tag, { size: fs, mono: true, weight: 700, anchor: "middle", fill: dim ? ink : "var(--viz-c1)" });
        const typeX = x + 39, nameX = typeX + 8.7 * cw, labX = nameX + 15.6 * cw;
        T(layer, typeX, cy, row.type + (row.label === "rep" ? "[]" : ""), { size: fs, mono: true, fill: "var(--viz-muted)" });
        T(layer, nameX, cy, row.name, { size: fs, mono: true, fill: ink });
        T(layer, labX, cy, row.label, { size: fs, mono: true, fill: "var(--viz-muted)" });
        end = labX + 3 * cw;
      }
      if (row.mark === "deleted") layer.appendChild(s("line", { x1: x + 8, x2: end, y1: cy, y2: cy, stroke: "var(--viz-muted)", "stroke-width": 1.3 }));
      if (row.note) T(layer, x + w - 8, cy, row.note, { size: 11, weight: 600, anchor: "end", fill: NOTE_COL[row.mark] || "var(--viz-muted)" });
    }

    /** Schema card; returns {rows: tag -> row center y, box(tag)} for the decoding cursor. */
    function drawCard(x, y, w, hgt, title, sc) {
      scene.appendChild(s("rect", { x, y, width: w, height: hgt, rx: 10, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
      T(scene, x + 10, y + 15, title, { size: 12, weight: 700 });
      T(scene, x + w - 10, y + 15, "message User", { size: 11, mono: true, anchor: "end", fill: "var(--viz-muted)" });
      const rows = {};
      rowsOf(sc).forEach((row, i) => {
        const cy = y + 36 + i * ROW;
        drawRow(scene, x, cy, w, row);
        if (row.tag && row.mark !== "deleted") rows[row.tag] = cy;
      });
      return { rows, box: tag => ({ x: x + 3, y: rows[tag] - 10, w: w - 6, h: 20 }) };
    }

    const wrapText = (str, max) => {
      if (!max || str.length <= max) return [str];
      const out = [];
      let cur = "";
      str.split(" ").forEach(word => {
        if (cur && (cur + " " + word).length > max) { out.push(cur); cur = word; } else cur = cur ? cur + " " + word : word;
      });
      return cur ? out.concat(cur) : out;
    };
    // Phone lines put the explanation under the value; desktop lines use one row with two columns.
    const footRows = str => (G.stack ? str.split(/(?<=;) /) : [str]);
    const lineHeight = (ln, v) => {
      if (!G.stack) return ROW;
      if (ln.kind === "error") return ROW;
      if (ln.kind === "foot") return footRows(v.text).length * 14 + 4;
      return 16 + wrapText(v.why, G.wrap).length * 14 + 4;
    };

    function drawLane(key, y) {
      const m = model[key], x = 8, w = G.laneW;
      const g = s("g"), chunksG = s("g"), linesG = s("g"), over = s("g");
      const back = key === "B";
      const titleTxt = back ? "Backward" : "Forward";
      const sub = back ? "v2 code reads bytes written by v1" : "v1 code reads bytes written by v2";
      if (G.stack) {
        T(g, x + 10, y + 16, titleTxt + " compatibility", { size: 12, weight: 700 });
        T(g, x + 10, y + 33, sub, { size: 11, fill: "var(--viz-muted)" });
      } else T(g, x + 10, y + 16, `${titleTxt}: ${sub}`, { size: 12, weight: 700 });
      const stripY = y + (G.stack ? 44 : 30);
      const cw = (w - 16 - (G.perRow - 1) * 6) / G.perRow;
      const nRows = Math.ceil(m.chunks.length / G.perRow);
      const chunkBox = (i, pad = 0) => ({
        x: x + 8 + (i % G.perRow) * (cw + 6) - pad, y: stripY + Math.floor(i / G.perRow) * (CHUNK_H + 6) - pad,
        w: cw + 2 * pad, h: CHUNK_H + 2 * pad,
      });
      let ly = stripY + nRows * (CHUNK_H + 6) + 10;
      const lineY = m.lines.map(ln => {
        const top = ly;
        ly += Math.max(...ln.versions.map(v => lineHeight(ln, v)));
        return top + 9;
      });
      const hgt = ly + 4 - y;
      g.prepend(s("rect", { x, y, width: w, height: hgt, rx: 10, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
      const badge = s("g");
      const bw = m.status.length * 8.4 + 20, tone = COL[TONE[m.status]];
      badge.append(
        s("rect", { x: x + w - 8 - bw, y: y + 6, width: bw, height: 20, rx: 10, fill: `var(--viz-${TONE[m.status]}-soft)`, stroke: tone, "stroke-width": 1.5 }),
        ctx.text(x + w - 8 - bw / 2, y + 16.5, m.status, { size: 12, weight: 800, fill: tone }));
      const cursor = s("rect", { rx: 8, fill: "none", stroke: "var(--viz-warn)", "stroke-width": 2.4 });
      cursor.style.display = "none";
      over.appendChild(cursor);
      g.append(badge, chunksG, linesG, over);
      scene.appendChild(g);
      return { m, x, y, h: hgt, chunksG, linesG, badge, cursor, chunkBox, lineY };
    }

    const CHUNK_TOP = {
      skip: c => `skip ${c.bytes} B`, parked: () => "parked", lost: () => "overwritten",
    };
    function drawChunk(layer, c, b, kind) {
      const dashed = kind === "skip" || kind === "parked" || kind === "lost";
      const stroke = { ok: "ok", bad: "bad", skip: "muted", parked: "warn", lost: "warn" }[kind];
      layer.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: "var(--viz-bg)",
        stroke: stroke ? COL[stroke] : "var(--viz-node-stroke)", "stroke-width": 1.5, "stroke-dasharray": dashed ? "4 3" : null }));
      layer.appendChild(s("rect", { x: b.x + 4, y: b.y + 4, width: 26, height: b.h - 8, rx: 4, fill: "var(--viz-c1-soft)" }));
      T(layer, b.x + 17, b.y + b.h / 2, "#" + c.tag, { size: 12, mono: true, weight: 700, anchor: "middle", fill: "var(--viz-c1)" });
      const top = CHUNK_TOP[kind] ? CHUNK_TOP[kind](c) : `${c.wire} ${c.bytes} B`;
      T(layer, b.x + 36, b.y + 12, top, { size: 11, mono: true, weight: dashed ? 700 : null, fill: dashed ? COL[stroke] : "var(--viz-muted)" });
      const val = T(layer, b.x + 36, b.y + 27, c.text, { size: G.fs, mono: true });
      if (dashed) val.setAttribute("opacity", 0.55);
    }

    function drawLine(layer, lv, ln, v, y) {
      const g = s("g"), x = lv.x, col = COL[v.tone];
      if (ln.kind === "skip") g.appendChild(s("line", { x1: x + 10, x2: x + 19, y1: y, y2: y, stroke: col, "stroke-width": 2, "stroke-dasharray": "3 2" }));
      else if (ln.kind !== "foot") g.appendChild(s("circle", { cx: x + 14, cy: y, r: 4, fill: col }));
      if (ln.kind === "error") {
        T(g, x + 26, y, v.text, { size: G.fs, mono: true, weight: 700, fill: col });
      } else if (ln.kind === "foot") {
        footRows(v.text).forEach((t, k) => T(g, x + 26, y + k * 14, t, { size: 11, fill: col }));
      } else {
        T(g, x + 26, y, v.text, { size: G.fs, mono: true, fill: ln.kind === "skip" ? col : "var(--viz-ink)" });
        const whyCol = v.tone === "ok" ? "var(--viz-muted)" : col;
        if (G.stack) wrapText(v.why, G.wrap).forEach((t, k) => T(g, x + 26, y + 16 + k * 14, t, { size: 11, fill: whyCol }));
        else T(g, x + G.whyX, y, v.why, { size: 12, fill: whyCol });
      }
      layer.appendChild(g);
      return g;
    }

    const latest = (vs, k) => vs.reduce((r, v) => (v.at <= k ? v : r), null);
    /** Draw a lane as it looks after event `upto`; returns the groups that changed at event `fresh`. */
    function renderLane(lv, upto, fresh = -2) {
      const m = lv.m, fades = [];
      lv.chunksG.innerHTML = "";
      lv.linesG.innerHTML = "";
      m.chunks.forEach((c, i) => {
        const st = latest(c.states, upto);
        drawChunk(lv.chunksG, c, lv.chunkBox(i), st ? st.kind : "pending");
      });
      m.lines.forEach((ln, i) => {
        const v = latest(ln.versions, upto);
        if (!v) return;
        const g = drawLine(lv.linesG, lv, ln, v, lv.lineY[i]);
        if (m.rejectAt !== null && upto >= m.rejectAt && ln.kind !== "error") g.setAttribute("opacity", 0.35);
        if (v.at === fresh) { g.setAttribute("opacity", 0); fades.push(g); }
      });
      lv.badge.style.display = upto === Infinity ? "" : "none";   // the animation reveals it after the last event
      return fades;
    }

    function setLaneStat(key) {
      const st = model[key].status;
      stats.set(key === "B" ? "back" : "fwd", st, TONE[st]);
    }
    function setSafeStat() {
      const tones = [TONE[model.B.status], TONE[model.F.status]];
      const v = tones.includes("bad") ? ["No", "bad"] : tones.includes("warn") ? ["Careful", "warn"] : ["Yes", "ok"];
      stats.set("safe", v[0], v[1]);
    }

    /** Rebuild everything in the fully decoded state (cancels a running animation). */
    function drawScene() {
      token++;
      compact = ctx.compact;
      G = layoutFor(compact);
      const c = CHANGES[idx];
      model = buildModel(c);
      scene.innerHTML = "";
      // Side by side the cards share a height; stacked (phone) each fits its own rows.
      const cardH = n => 27 + (G.stack ? n : Math.max(rowsOf(c.v1).length, rowsOf(c.v2).length)) * ROW + 6;
      const h1 = cardH(rowsOf(c.v1).length), h2 = cardH(rowsOf(c.v2).length);
      const [[x1, w1], [x2, w2]] = G.cards;
      const y2 = G.stack ? 8 + h1 + 10 : 8;
      const v1 = drawCard(x1, 8, w1, h1, "v1 schema (old code)", c.v1);
      const v2 = drawCard(x2, y2, w2, h2, "v2 schema (new code)", c.v2);
      const rowCursor = s("rect", { rx: 6, fill: "none", stroke: "var(--viz-warn)", "stroke-width": 2.4 });
      rowCursor.style.display = "none";
      scene.appendChild(rowCursor);
      view = { v1, v2, rowCursor };
      view.B = drawLane("B", y2 + h2 + 14);
      view.F = drawLane("F", view.B.y + view.B.h + 12);
      svg.setAttribute("viewBox", `0 0 ${G.W} ${view.F.y + view.F.h + 2}`);
      renderLane(view.B, Infinity);
      renderLane(view.F, Infinity);
      setLaneStat("B");
      setLaneStat("F");
      setSafeStat();
      note.set(c.note, c.tone);
    }

    // ---------------- Decode animation ----------------
    function moveCursor(rect, box) {
      if (!box) { rect.style.display = "none"; return Promise.resolve(); }
      if (rect.style.display === "none") {
        ctx.attr(rect, { x: box.x, y: box.y, width: box.w, height: box.h, opacity: 0 });
        rect.style.display = "";
        return ctx.tween({ ms: 180, onUpdate: t => rect.setAttribute("opacity", t) });
      }
      const from = { x: +rect.getAttribute("x"), y: +rect.getAttribute("y"), w: +rect.getAttribute("width"), h: +rect.getAttribute("height") };
      return ctx.tween({ ms: 350, onUpdate: t => ctx.attr(rect, {
        x: ctx.lerp(from.x, box.x, t), y: ctx.lerp(from.y, box.y, t),
        width: ctx.lerp(from.w, box.w, t), height: ctx.lerp(from.h, box.h, t),
      }) });
    }

    async function runDecode() {
      drawScene();   // fresh elements, so a restarted run never fights an old tween
      const my = token;
      const stale = () => my !== token || !ctx.alive;
      renderLane(view.B, -1);
      renderLane(view.F, -1);
      ["back", "fwd", "safe"].forEach(k => stats.set(k, "…", ""));
      for (const key of ["B", "F"]) {
        const lv = view[key], card = key === "B" ? view.v2 : view.v1;
        for (let k = 0; k < lv.m.events.length; k++) {
          const e = lv.m.events[k] || {};
          const hasChunk = e.chunk !== undefined;
          await Promise.all([
            moveCursor(lv.cursor, hasChunk ? lv.chunkBox(e.chunk, 3) : null),
            moveCursor(view.rowCursor, e.row != null && card.rows[e.row] !== undefined ? card.box(e.row) : null),
          ]);
          if (stale()) return;
          const fades = renderLane(lv, k, k);
          await ctx.tween({ ms: 220, onUpdate: t => fades.forEach(g => g.setAttribute("opacity", t)) });
          if (stale()) return;
          await ctx.sleep(hasChunk ? 200 : 300);
          if (stale()) return;
        }
        moveCursor(lv.cursor, null);
        moveCursor(view.rowCursor, null);
        lv.badge.style.display = "";
        setLaneStat(key);
        await ctx.sleep(400);
        if (stale()) return;
      }
      setSafeStat();
    }

    drawScene();
    ctx.onResize(() => { if (ctx.compact !== compact) drawScene(); });
  },
});
