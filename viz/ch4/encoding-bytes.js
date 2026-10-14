// One record, six encodings: the book's example record (userName, favoriteNumber, interests)
// encoded byte by byte as JSON, MessagePack, Thrift Binary/Compact, Protocol Buffers and Avro.
// Each encoder returns bytes tagged with a role (colour) and a segment (explanation); the bars
// stack those roles so the shrinking overhead (names -> tags -> nothing) is visible at a glance.
(function () {
  "use strict";

  const INTERESTS = ["daydreaming", "hacking", "reading"];
  const F = [{ id: 1, name: "userName" }, { id: 2, name: "favoriteNumber" }, { id: 3, name: "interests" }];

  const ROLES = {
    user: { label: "userName value", c: "c2" },
    fav: { label: "favoriteNumber value", c: "c4" },
    int: { label: "interests values", c: "c6" },
    struct: { label: "structure", fill: "var(--viz-node)", stroke: "var(--viz-line)", bar: "var(--viz-node-stroke)" },
    tag: { label: "tags, types & lengths", c: "c1" },  // violet, as in ch4/tag-evolution (amber means "warning")
    name: { label: "field name", c: "c5" },
  };
  for (const k in ROLES) {
    const r = ROLES[k];
    if (r.c) { r.fill = `var(--viz-${r.c}-soft)`; r.stroke = r.bar = `var(--viz-${r.c})`; }
  }
  const VALUE_ROLES = ["user", "fav", "int"];
  const BAR_ORDER = ["user", "fav", "int", "struct", "tag", "name"]; // data first, overhead after
  const LEGEND_ORDER = ["name", "tag", "struct", "user", "fav", "int"];

  // ---------------------------------------------------------------- byte helpers
  const hex = b => b.toString(16).padStart(2, "0");
  const ascii = str => Array.from(str, c => c.charCodeAt(0));
  const bin = (v, n) => v.toString(2).padStart(n, "0");
  const code = str => `<span class="mono">${str}</span>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function varint(n) { // unsigned LEB128: 7 bits per byte, least significant group first
    let v = BigInt(n);
    const out = [];
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  }
  const zigzag = n => (n >= 0 ? 2n * BigInt(n) : -2n * BigInt(n) - 1n);
  function bigEndian(n, width) { // two's complement, most significant byte first
    let v = BigInt.asUintN(width * 8, BigInt(n));
    const out = [];
    for (let i = 0; i < width; i++) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
    return out;
  }

  // ---------------------------------------------------------------- explanations
  // "b9 = 1·0111001, 0a = 0·0001010; reversed, 0001010 0111001 = 1337"
  function varBits(bytes, value) {
    const each = bytes.map(b => `${code(hex(b))} = ${code(`<b>${b >> 7}</b>·${bin(b & 0x7f, 7)}`)}`).join(", ");
    const groups = bytes.map(b => bin(b & 0x7f, 7)).reverse().join(" ");
    return `${each}; reversed, ${code(groups)} = ${value}`;
  }
  function intWhy(v, bytes, zz) {
    const lead = zz ? `Zigzag first (${v} → ${zigzag(v)}) so small negatives stay small, then a varint` : `${v} as a varint`;
    if (bytes.length === 1) return `${lead}: it fits in 7 bits, so a single byte ${code(hex(bytes[0]))} (continuation bit 0).`;
    return `${lead}, 7 bits per byte, low group first: ${varBits(bytes, zz ? zigzag(v) : v)}. ` +
      "The bold first bit of each byte is the continuation bit: 1 = more bytes follow, 0 = last byte.";
  }
  const NEG_VARINT = "int64 -1 is a 10-byte varint: in two's complement it is 64 one-bits, sent 7 per byte as nine " +
    `${code("ff")} bytes (continuation bit set) and a final ${code("01")}. Declare it sint64 and zigzag makes it 1 byte.`;
  const USER_WHY = `${code('"Martin"')} as UTF-8: 6 bytes. Every format stores exactly these bytes; they differ only in what surrounds them.`;
  const interestWhy = (r, i) => `Interest ${i + 1} of ${r.interests.length}: ${code(`"${r.interests[i]}"`)} as UTF-8 (${r.interests[i].length} bytes).`;
  const nameWhy = i => e => `Field name ${code(`"${F[i].name}"`)} spelled out in every record: ${F[i].name.length} bytes. ` +
    `With no schema, names take ${e.count("name")} of these ${e.bytes.length} bytes.`;

  // An encoding: bytes [{b, role, seg, text}] and segments [{key, why, cells}]. Segment keys are
  // shared across formats ("f1.len", "f2.val", ...) so a pinned byte survives a format switch.
  function Enc() {
    const e = { bytes: [], segs: [], idx: {} };
    e.add = (key, role, arr, why, text = false) => {
      if (role === "len") role = "tag";   // lengths and counts share the violet "overhead" colour with tags and types
      if (!(key in e.idx)) { e.idx[key] = e.segs.length; e.segs.push({ key, why, cells: [] }); }
      const seg = e.idx[key];
      for (const b of arr) { e.segs[seg].cells.push(e.bytes.length); e.bytes.push({ b, role, seg, text }); }
    };
    e.count = role => e.bytes.filter(x => x.role === role).length;
    return e;
  }

  // ---------------------------------------------------------------- encoders
  function encJSON(r) {
    const e = Enc();
    let p = 0;
    const punct = str => e.add("p" + p++, "struct", ascii(str), en =>
      `Punctuation: quotes, colons, commas and brackets. ${en.count("struct")} of the ${en.bytes.length} bytes are pure syntax.`, true);
    const name = i => e.add(`f${i + 1}.name`, "name", ascii(F[i].name), nameWhy(i), true);
    punct('{"'); name(0); punct('":"');
    e.add("f1.val", "user", ascii("Martin"), USER_WHY, true);
    punct('","');
    if (r.fav !== null) {
      const t = String(r.fav);
      name(1); punct('":');
      e.add("f2.val", "fav", ascii(t), `${r.fav} spelled out as ${plural(t.length, "decimal character")}. ` +
        "JSON doesn't say whether a number is an integer or a float.", true);
      punct(',"');
    }
    name(2);
    if (!r.interests.length) punct('":[]}');
    else {
      punct('":["');
      r.interests.forEach((s, i) => { if (i) punct('","'); e.add(`f3.i${i}.val`, "int", ascii(s), interestWhy(r, i), true); });
      punct('"]}');
    }
    return e;
  }

  function encMsgPack(r) {
    const e = Enc(), n = r.fav === null ? 2 : 3, k = r.interests.length;
    const fixstr = (key, s) => e.add(key, "tag", [0xa0 | s.length],
      `fixstr: a ${s.length}-byte string follows (0xa0 | ${s.length}): type and length in one byte.`);
    const name = i => { fixstr(`f${i + 1}.nhdr`, F[i].name); e.add(`f${i + 1}.name`, "name", ascii(F[i].name), nameWhy(i), true); };
    e.add("rec.start", "tag", [0x80 | n], `fixmap with ${n} entries (0x80 | ${n}): type and size share one byte.`);
    name(0); fixstr("f1.len", "Martin"); e.add("f1.val", "user", ascii("Martin"), USER_WHY, true);
    if (r.fav !== null) {
      const v = r.fav;
      name(1);
      if (v >= -32 && v <= 127) {
        e.add("f2.val", "fav", [v & 0xff], v >= 0
          ? `Positive fixint ${code(hex(v))}: 0 to 127 fit in one byte that is both type and value.`
          : `Negative fixint ${code(hex(v & 0xff))} = ${v}: -32 to -1 fit in one byte that is both type and value.`);
      } else {
        const w = v <= 0xffff ? 2 : 4, t = w === 2 ? 0xcd : 0xce, ty = w === 2 ? "uint16" : "uint32";
        e.add("f2.type", "tag", [t], `Type byte 0x${hex(t)}: a ${ty} follows (${w} bytes, big-endian).`);
        e.add("f2.val", "fav", bigEndian(v, w), `${ty} ${v} = 0x${v.toString(16).padStart(2 * w, "0")} (big-endian).`);
      }
    }
    name(2);
    e.add("f3.hdr", "tag", [0x90 | k], `fixarray with ${plural(k, "element")} (0x90 | ${k}).`);
    r.interests.forEach((s, i) => { fixstr(`f3.i${i}.len`, s); e.add(`f3.i${i}.val`, "int", ascii(s), interestWhy(r, i), true); });
    return e;
  }

  const STOP = "Stop byte: end of struct. Optional fields may be missing, so the reader needs an end marker.";

  function encThriftBinary(r) {
    const e = Enc(), k = r.interests.length, T = { 11: "string", 10: "i64", 15: "list" };
    const header = (i, t) => e.add(`f${i + 1}.tag`, "tag", [t, 0, F[i].id],
      `Field header: type ${t} (${T[t]}), then field tag ${F[i].id} as a 2-byte integer. No name, but 3 bytes per field.`);
    const str = (pre, role, s, why) => {
      e.add(pre + ".len", "len", bigEndian(s.length, 4), `Fixed 4-byte length: ${s.length}. The Compact protocol needs 1 byte here.`);
      e.add(pre + ".val", role, ascii(s), why, true);
    };
    header(0, 11); str("f1", "user", "Martin", USER_WHY);
    if (r.fav !== null) {
      const v = r.fav;
      header(1, 10);
      e.add("f2.val", "fav", bigEndian(v, 8), v < 0
        ? "An i64 is always 8 bytes: -1 in two's complement is eight ff bytes."
        : `An i64 is always 8 bytes, even for ${v} (0x${v.toString(16)}, big-endian).`);
    }
    header(2, 15);
    e.add("f3.etype", "tag", [11], "List element type 11 (string): every item in the list is a string.");
    e.add("f3.count", "len", bigEndian(k, 4), `List size ${k} as a fixed 4-byte integer.`);
    r.interests.forEach((s, i) => str(`f3.i${i}`, "int", s, interestWhy(r, i)));
    e.add("rec.end", "struct", [0], STOP);
    return e;
  }

  function encThriftCompact(r) {
    const e = Enc(), k = r.interests.length, T = { 8: "binary/string", 6: "i64", 9: "list" };
    let last = 0;
    const header = (i, t) => {
      const d = F[i].id - last, b = (d << 4) | t;
      last = F[i].id;
      e.add(`f${i + 1}.tag`, "tag", [b], `Field header 0x${hex(b)} = ${code(bin(d, 4) + "·" + bin(t, 4))}: high nibble = field-id delta ${d}` +
        (d > 1 ? ` (field ${F[i].id - 1} is absent, so the id jumps by ${d})` : "") +
        `, low nibble = type ${t} (${T[t]}): tag and type in one byte.`);
    };
    const str = (pre, role, s, why) => {
      e.add(pre + ".len", "len", varint(s.length), `Length ${s.length} as a varint: 1 byte instead of Binary's 4.`);
      e.add(pre + ".val", role, ascii(s), why, true);
    };
    header(0, 8); str("f1", "user", "Martin", USER_WHY);
    if (r.fav !== null) {
      header(1, 6);
      const z = varint(zigzag(r.fav));
      e.add("f2.val", "fav", z, intWhy(r.fav, z, true));
    }
    header(2, 9);
    const lh = (k << 4) | 8; // sizes up to 14 share the byte with the element type
    e.add("f3.hdr", "tag", [lh], `List header 0x${hex(lh)}: ${plural(k, "element")} (high nibble) of type 8 (string, low nibble), in one byte.`);
    r.interests.forEach((s, i) => str(`f3.i${i}`, "int", s, interestWhy(r, i)));
    e.add("rec.end", "struct", [0], STOP);
    return e;
  }

  function encProtobuf(r) {
    const e = Enc(), k = r.interests.length, WT = { 0: "varint", 2: "length-delimited" };
    const key = (i, wt, extra) => {
      const b = (F[i].id << 3) | wt;
      e.add(`f${i + 1}.tag`, "tag", [b], `Key byte 0x${hex(b)} = ${code(bin(F[i].id, 5) + "·" + bin(wt, 3))}: ` +
        `(field ${F[i].id} &lt;&lt; 3) | wire type ${wt} (${WT[wt]}). ${extra}`);
    };
    const str = (pre, role, s, why) => {
      e.add(pre + ".len", "len", varint(s.length), `Length ${s.length} (varint): the next ${s.length} bytes are the string.`);
      e.add(pre + ".val", role, ascii(s), why, true);
    };
    key(0, 2, 'The name "userName" never appears; the schema maps tag 1 back to it. Tags 1–15 fit in one key byte.');
    str("f1", "user", "Martin", USER_WHY);
    if (r.fav !== null) {
      key(1, 0, "No length needed: the varint itself says where it ends.");
      const b = varint(BigInt.asUintN(64, BigInt(r.fav)));
      e.add("f2.val", "fav", b, r.fav < 0 ? NEG_VARINT : intWhy(r.fav, b, false));
    }
    r.interests.forEach((s, i) => {
      key(2, 2, `Protobuf has no list type: a repeated field just repeats its key, once per interest (${k}× here).`);
      str(`f3.i${i}`, "int", s, interestWhy(r, i));
    });
    return e;
  }

  function encAvro(r) {
    const e = Enc(), k = r.interests.length;
    const str = (pre, role, s, why, extra = "") => {
      const z = varint(zigzag(s.length));
      e.add(pre + ".len", "len", z, `Length ${s.length}, zigzag-encoded (${s.length} → ${2 * s.length} = 0x${hex(z[0])}).${extra}`);
      e.add(pre + ".val", role, ascii(s), why, true);
    };
    str("f1", "user", "Martin", USER_WHY, " No tag or type in front: the schema says the first field is a string.");
    if (r.fav === null) e.add("f2.union", "struct", [0], "Union branch 0 = null: the field is unset, but it still costs 1 byte.");
    else {
      e.add("f2.union", "struct", [2], `Union branch 1 (long), zigzag-encoded; ${code("00")} would mean null. Only the schema knows what branch 1 is.`);
      const z = varint(zigzag(r.fav));
      e.add("f2.val", "fav", z, intWhy(r.fav, z, true));
    }
    if (!k) e.add("f3.end", "struct", [0], "Empty array: just a block count of 0.");
    else {
      e.add("f3.count", "len", varint(zigzag(k)), `Array block of ${plural(k, "item")} (zigzag: ${k} → ${2 * k}); the final ${code("00")} ends the array.`);
      r.interests.forEach((s, i) => str(`f3.i${i}`, "int", s, interestWhy(r, i)));
      e.add("f3.end", "struct", [0], "Block count 0: the array ends here.");
    }
    return e;
  }

  const FORMATS = [
    { id: "json", label: "JSON", short: "JSON", enc: encJSON },
    { id: "msgpack", label: "MsgPack", short: "MsgPack", enc: encMsgPack },
    { id: "thriftb", label: "Thrift Binary", short: "Thrift Bin", enc: encThriftBinary,
      schema: ["struct Person {", "1: required string userName,", "2: optional i64 favoriteNumber,", "3: optional list&lt;string&gt; interests", "}"] },
    { id: "thriftc", label: "Thrift Compact", short: "Thrift Cmp", enc: encThriftCompact },
    { id: "proto", label: "Protobuf", short: "Protobuf", enc: encProtobuf,
      schema: ["message Person {", "required string user_name = 1;", "optional int64 favorite_number = 2;", "repeated string interests = 3;", "}"] },
    { id: "avro", label: "Avro", short: "Avro", enc: encAvro,
      schema: ["record Person {", "string userName;", "union { null, long } favoriteNumber = null;", "array&lt;string&gt; interests;", "}"] },
  ];
  FORMATS[3].schema = FORMATS[2].schema;
  const FAVS = ["1", "1337", "-1", "300000", "absent"];

  const listJoin = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  function summary(fmt, e, r) {
    const n = `<b>${e.bytes.length} bytes</b>`;
    const tags = F.filter(f => f.id === 1 || (f.id === 2 && r.fav !== null) || (f.id === 3 && r.interests.length)).map(f => f.id);
    let html = {
      json: `${n}, ${e.count("name")} of them spelling out field names that repeat in every record.`,
      msgpack: `${n}: binary, but it still carries every field name because there is no schema.`,
      thriftb: `${n}: names replaced by 2-byte tags, but fixed-width lengths and integers waste space.`,
      thriftc: `${n}: tag delta and type share one byte; lengths and integers are (zigzag) varints.`,
      proto: `${n}. Tag${tags.length > 1 ? "s" : ""} ${listJoin(tags)} (inside the violet key bytes) stand in for the names; the schema maps them back.`,
      avro: `${n} and not a single tag or type byte: the violet cells are only lengths and counts, the rest are values in schema order. ` +
        "Without the exact writer's schema these bytes are unreadable.",
    }[fmt];
    let tone = "info";
    if (r.fav === null) html += " Protobuf and Thrift simply omit an unset optional field; Avro still spends 1 byte (union branch 0 = null).";
    if (r.fav === -1 && fmt === "proto") {
      html += " int64 -1 is a 10-byte varint (two's complement). Declare it sint64 and zigzag makes it 1 byte.";
      tone = "warn";
    }
    return [html + ' <span class="muted">Hover or tap a byte to see what it means; click a bar to switch format.</span>', tone];
  }

  Viz.register("ch4/encoding-bytes", {
    title: "One record, six encodings",
    encode: (fmt, r) => FORMATS.find(f => f.id === fmt).enc(r), // pure; used by tests

    mount(root, ctx) {
      const { s, h, ui } = ctx;
      let fmt = "proto", favSel = "1337", nInt = 2;
      let pinned = null, hovered = null, compact = ctx.compact, view = null, encs = [], cur = null, epoch = 0;
      const record = () => ({ fav: favSel === "absent" ? null : Number(favSel), interests: INTERESTS.slice(0, nInt) });
      const fmtIndex = () => FORMATS.findIndex(f => f.id === fmt);

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const W = compact ? 360 : 640;
        const fmtOpts = FORMATS.map(f => ({ value: f.id, label: f.label }));
        const fmtCtl = compact
          ? ui.select({ label: "Format", options: fmtOpts, value: fmt, onChange: selectFormat })
          : ui.segmented({ label: "Format", options: fmtOpts, value: fmt, onChange: selectFormat });
        const favCtl = ui.segmented({ label: "favoriteNumber", options: FAVS, value: favSel, onChange: v => { favSel = v; update(); } });
        const intCtl = ui.slider({ label: "interests", min: 0, max: 3, value: nInt, onInput: v => { nInt = v; update(); } });
        const recordLine = h("div", { class: "mono", style: "font-size:12.5px;line-height:1.5;margin:-2px 0 4px;color:var(--text-muted)" });
        const bars = buildBars(W);
        const schemaLine = h("div", { style: "font-size:12.5px;line-height:1.7;margin:10px 0 6px;color:var(--text-muted)" });
        const grid = ctx.svg({ w: W, h: 100, label: "The encoded bytes, coloured by what each byte is for" });
        const layer = s("g");
        grid.appendChild(layer);
        const legend = ui.legend(LEGEND_ORDER.map(role => ({ color: ROLES[role].stroke, label: ROLES[role].label, shape: "square" })));
        const note = ui.note("", "info");
        const stats = ui.stats([
          { key: "bytes", label: "Bytes" },
          { key: "names", label: "Field-name bytes" },
          { key: "over", label: "Overhead" },
          { key: "vs", label: "vs JSON" },
        ]);
        root.append(ui.bar(fmtCtl), ui.bar(favCtl, intCtl), recordLine, bars.svg, legend, schemaLine, grid, note, stats);
        view = { W, fmtCtl, recordLine, bars, legend, schemaLine, grid, layer, note, stats, cells: [] };
        wireGrid();
        update(true);
      }

      // ---------------------------------------------------------- size bars
      function buildBars(W) {
        const pitch = compact ? 26 : 24, H = compact ? 170 : 156, top = (H - 6 * pitch) / 2;
        const x0 = compact ? 84 : 120, xMax = W - 56, bh = 16;
        const svg = ctx.svg({ w: W, h: H, label: "Encoded size of the same record in each format" });
        const rows = FORMATS.map((f, i) => {
          const cy = top + pitch * i + pitch / 2;
          const g = s("g", { style: "cursor:pointer" });
          const band = s("rect", { x: 1, y: cy - pitch / 2 + 1, width: W - 2, height: pitch - 2, rx: 6, fill: "var(--viz-grid)", stroke: "var(--viz-line)" });
          const label = ctx.text(8, cy, compact ? f.short : f.label, { size: compact ? 11 : 12, anchor: "start" });
          const chunks = BAR_ORDER.map(role => s("rect", {
            x: x0, y: cy - bh / 2, width: 0, height: bh, fill: ROLES[role].bar, "fill-opacity": 0.4, stroke: ROLES[role].bar, "stroke-width": 1,
          }));
          const count = ctx.text(x0, cy, "", { size: 12, weight: 700, anchor: "start" });
          const hit = s("rect", { x: 0, y: cy - pitch / 2, width: W, height: pitch, fill: "var(--viz-bg)", "fill-opacity": 0 });
          g.append(band, label, ...chunks, count, hit);
          g.addEventListener("click", () => { if (ctx.alive) selectFormat(f.id); });
          svg.appendChild(g);
          return { band, label, chunks, count };
        });
        return { svg, rows, x0, xMax };
      }

      function updateBars(instant) {
        const { rows, x0, xMax } = view.bars;
        const scale = (xMax - x0) / Math.max(...encs.map(e => e.bytes.length));
        const target = encs.map(e => {
          let x = x0;
          return BAR_ORDER.map(role => { const w = e.count(role) * scale, t = [x, w]; x += w; return t; });
        });
        const from = rows.map(row => row.chunks.map(c => [+c.getAttribute("x"), +c.getAttribute("width")]));
        const my = ++epoch;
        rows.forEach((row, i) => {
          const on = i === fmtIndex();
          row.band.style.display = on ? "" : "none";
          ctx.attr(row.label, { "font-weight": on ? 700 : 500, fill: on ? "var(--viz-ink)" : "var(--viz-muted)" });
          row.count.textContent = encs[i].bytes.length;
        });
        ctx.tween({ ms: instant ? 0 : 300, ease: "out", onUpdate: k => {
          if (my !== epoch) return;
          rows.forEach((row, i) => {
            let end = x0;
            row.chunks.forEach((c, j) => {
              const x = ctx.lerp(from[i][j][0], target[i][j][0], k), w = ctx.lerp(from[i][j][1], target[i][j][1], k);
              ctx.attr(c, { x, width: Math.max(0, w) });
              end = Math.max(end, x + w);
            });
            row.count.setAttribute("x", end + 6);
          });
        } });
      }

      // ---------------------------------------------------------- byte grid
      function drawGrid() {
        const { W, grid, layer } = view;
        const cols = compact ? 8 : 16, cw = compact ? 40 : 36, ch = 28, gap = 3;
        const x0 = (W - cols * cw - (cols - 1) * gap) / 2;
        // Desktop keeps JSON's footprint as dashed ghost cells (stable height, visible savings).
        const n = cur.bytes.length, J = compact ? n : encs[0].bytes.length, rows = Math.ceil(Math.max(n, J) / cols);
        const pos = i => [x0 + (i % cols) * (cw + gap), 5 + Math.floor(i / cols) * 31];
        grid.setAttribute("viewBox", `0 0 ${W} ${rows * 31 + 10}`);
        layer.innerHTML = "";
        const hidden = ghostLabel(n, J, cols, pos, cw + gap);
        for (let i = n; i < J; i++) {
          const [x, y] = pos(i);
          if (!hidden.has(i)) layer.appendChild(s("rect", { x, y, width: cw, height: ch, rx: 4, fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "3 3" }));
        }
        view.cells = cur.bytes.map((by, i) => {
          const [x, y] = pos(i), R = ROLES[by.role];
          const g = s("g", { "data-seg": by.seg, style: "cursor:pointer" });
          g.rect = s("rect", { x, y, width: cw, height: ch, rx: 4, fill: R.fill, stroke: R.stroke, "stroke-width": 1.2 });
          g.appendChild(g.rect);
          g.appendChild(ctx.text(x + cw / 2, y + ch / 2 + 1, by.text ? String.fromCharCode(by.b) : hex(by.b),
            { size: by.text && !compact ? 13 : 12, mono: true }));
          layer.appendChild(g);
          return g;
        });
      }

      // Writes "JSON needs N more bytes" in place of 5 ghost cells in the widest ghost run;
      // returns the indices of the cells it replaced.
      function ghostLabel(n, J, cols, pos, step) {
        let best = { len: 0 };
        for (let i = n; i < J;) {
          const end = Math.min(J, (Math.floor(i / cols) + 1) * cols);
          if (end - i > best.len) best = { i, len: end - i };
          i = end;
        }
        if (best.len < 6) return new Set();
        const first = best.i + Math.floor((best.len - 5) / 2), [x, y] = pos(first);
        view.layer.appendChild(ctx.text(x + (5 * step - 3) / 2, y + 15, `JSON needs ${J - n} more bytes`, { size: 12, fill: "var(--viz-muted)" }));
        return new Set([0, 1, 2, 3, 4].map(k => first + k));
      }

      function wireGrid() {
        const segOf = ev => {
          const c = ev.target.closest && ev.target.closest("[data-seg]");
          return c ? cur.segs[+c.dataset.seg].key : null;
        };
        view.grid.addEventListener("pointerover", ev => { hovered = segOf(ev); showActive(); });
        view.grid.addEventListener("pointerleave", () => { hovered = null; showActive(); });
        view.grid.addEventListener("click", ev => {
          const k = segOf(ev);
          pinned = k && k !== pinned ? k : null;
          showActive();
        });
      }

      // Outlines the hovered/pinned segment, explains it, and lights up its field in the schema.
      function showActive() {
        if (!ctx.alive) return;
        const key = hovered || pinned;
        const sg = key && key in cur.idx ? cur.segs[cur.idx[key]] : null;
        view.cells.forEach((c, i) => {
          const on = sg && sg.cells.includes(i), R = ROLES[cur.bytes[i].role];
          ctx.attr(c.rect, { stroke: on ? "var(--viz-ink)" : R.stroke, "stroke-width": on ? 2 : 1.2 });
          c.setAttribute("opacity", sg && !on ? 0.4 : 1);
        });
        const field = sg && /^f(\d)\./.test(sg.key) ? +sg.key[1] : 0;
        view.schemaLine.querySelectorAll("[data-f]").forEach(el => {
          el.style.cssText = "white-space:nowrap" + (+el.dataset.f === field
            ? ";background:var(--viz-c3-soft);box-shadow:0 0 0 1px var(--viz-c3);border-radius:4px;color:var(--viz-ink)" : "");
        });
        if (!sg) { view.note.set(...summary(fmt, cur, record())); return; }
        const bytes = sg.cells.map(i => hex(cur.bytes[i].b));
        const contiguous = sg.cells.every((c, j) => !j || c === sg.cells[j - 1] + 1);
        const shown = contiguous ? (bytes.length > 12 ? bytes.slice(0, 11).join(" ") + " …" : bytes.join(" ")) : bytes.join(" … ");
        const why = typeof sg.why === "function" ? sg.why(cur) : sg.why;
        view.note.set(`<b class="mono">${shown}</b> &nbsp;${why}`, why === NEG_VARINT ? "warn" : "info");
      }

      // ---------------------------------------------------------- text panels
      function drawText() {
        const r = record(), f = FORMATS[fmtIndex()];
        const col = (c, t) => `<span style="color:var(--viz-${c})">${t}</span>`;
        const nm = i => col("c5", F[i].name);
        const parts = [`${nm(0)}: ${col("c2", '"Martin"')}`];
        if (r.fav !== null) parts.push(`${nm(1)}: ${col("c4", r.fav)}`);
        parts.push(`${nm(2)}: [${r.interests.map(x => col("c6", `"${x}"`)).join(", ")}]`);
        view.recordLine.innerHTML = `record { ${parts.map(p => `<span style="white-space:nowrap">${p}</span>`).join(", ")} }`;
        view.schemaLine.innerHTML = f.schema
          ? `<b style="color:var(--viz-ink)">${f.label}</b> needs the schema to decode: <span class="mono">${f.schema[0]} ` +
            f.schema.slice(1, 4).map((p, i) => `<span data-f="${i + 1}" style="white-space:nowrap">${p}</span>`).join(" ") + ` ${f.schema[4]}</span>`
          : `<b style="color:var(--viz-ink)">${f.label}</b> has no schema, so every record carries its own field names.`;
        Array.from(view.legend.children).forEach((el, i) => { el.style.opacity = cur.count(LEGEND_ORDER[i]) ? "" : 0.35; });
      }

      function updateStats() {
        const n = cur.bytes.length, J = encs[0].bytes.length;
        const names = cur.count("name");
        const values = VALUE_ROLES.reduce((a, role) => a + cur.count(role), 0);
        const { stats } = view;
        stats.set("bytes", n);
        stats.set("names", names, names ? "warn" : "ok");
        stats.set("over", Math.round((100 * (n - values)) / n) + "%");
        const d = Math.round((100 * (n - J)) / J);
        stats.set("vs", fmt === "json" ? "baseline" : (d < 0 ? "−" + -d : "+" + d) + "%", d < 0 ? "ok" : "");
      }

      function update(instant) {
        const r = record();
        encs = FORMATS.map(f => f.enc(r));
        cur = encs[fmtIndex()];
        if (pinned && !(pinned in cur.idx)) pinned = null;
        hovered = null;
        updateBars(instant);
        drawGrid();
        drawText();
        updateStats();
        showActive();
      }

      function selectFormat(id) {
        fmt = id;
        view.fmtCtl.set(id);
        update();
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
