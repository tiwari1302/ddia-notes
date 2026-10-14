// JSON numbers vs 64-bit IDs. JSON.parse decodes every JSON number as an IEEE-754 double, whose
// 53-bit significand holds every integer only up to 2^53. Above that, neighboring integers share
// one double, so 64-bit IDs come back silently changed; sending the ID as a string is the fix.
// All arithmetic here is BigInt, so the viz itself never loses precision.
Viz.register("ch4/json-numbers", {
  title: "JSON numbers vs 64-bit IDs",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const SAFE = 2n ** 53n, INT64_MAX = 2n ** 63n - 1n;
    const PRESETS = [
      { value: "small", label: "Small id: 1337", id: 1337n },
      { value: "safe", label: "Largest safe: 2⁵³ − 1", id: SAFE - 1n },
      { value: "unsafe", label: "First unsafe: 2⁵³ + 1", id: SAFE + 1n },
      { value: "tweet", label: "Tweet-style 19-digit id", id: 1050118621198921728n },
      { value: "max", label: "Max int64: 2⁶³ − 1", id: INT64_MAX },
    ];
    const MINUS = "\u2212", NBSP = "\u00a0";
    const C = { ink: "var(--viz-ink)", muted: "var(--viz-muted)", bad: "var(--viz-bad)", ok: "var(--viz-ok)", c2: "var(--viz-c2)", c6: "var(--viz-c6)" };

    // ---- pure helpers (BigInt only) ----
    const bitLen = v => (v === 0n ? 1 : v.toString(2).length);
    // Distance from v up to the next integer a double can hold (1 below 2^53, then 2, 4, 8, ...).
    const gapAt = v => (bitLen(v) > 53 ? 2n ** BigInt(bitLen(v) - 53) : 1n);
    const nextUp = d => d + gapAt(d);
    const nextDown = d => (d === 0n ? null : d - gapAt(d - 1n));
    const isPow2 = v => v > 0n && (v & (v - 1n)) === 0n;
    const pow2 = k => "2" + String(k).replace(/\d/g, c => "⁰¹²³⁴⁵⁶⁷⁸⁹"[c]);
    const abs = v => (v < 0n ? -v : v);
    const signed = v => (v > 0n ? "+" : v < 0n ? MINUS : "") + abs(v);
    const clampId = v => (v < 0n ? 0n : v > INT64_MAX ? INT64_MAX : v);

    function derive(v) {
      const n = JSON.parse(String(v));   // exactly what a JavaScript client does with the wire text
      return { id: v, stored: BigInt(n), printed: String(n), err: BigInt(String(n)) - v, bits: bitLen(v), gap: gapAt(v) };
    }
    // "= 2⁵³ + 1" when the id sits right next to a power of two (that's how the slider builds ids).
    function nearPow(v) {
      for (const k of [bitLen(v) - 1, bitLen(v)]) {
        const d = v - 2n ** BigInt(k);
        if (k >= 50 && abs(d) <= 99999n) return "= " + pow2(k) + (d === 0n ? "" : (d > 0n ? " + " : " " + MINUS + " ") + abs(d));
      }
      return "";
    }
    const tickText = v => (isPow2(v) && v >= SAFE ? pow2(bitLen(v) - 1) : v < 10000n ? String(v) : "…" + String(v).slice(-4));

    // ---- state (outside build() so a phone <-> desktop rebuild keeps it) ----
    let id = PRESETS[3].id, sendStr = true;
    let center = null, centerGap = 0n;   // number line window: the double at its middle, and its scale
    let markerX = null, tweenToken = 0;
    let compact = ctx.compact, view = null;

    function layout(c) {
      return c ? {
        compact: true, W: 360, H: 388, fs: 11,
        wire: { labelY: 11, y: 20, h: 48, size: 12 },
        rows: { y0: 88, pitch: 38, mono: 13 },
        bits: { titleY: 245, y: 254, h: 12 },
        line: { capY: 297, labelY: 314, markY: 330, axisY: 360 },
      } : {
        compact: false, W: 640, H: 354, fs: 12,
        wire: { labelY: 13, y: 22, h: 36, size: 13 },
        rows: { y0: 80, pitch: 26, mono: 14 },
        bits: { titleY: 186, y: 196, h: 14 },
        line: { capY: 249, labelY: 267, markY: 284, axisY: 316 },
      };
    }

    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const L = layout(compact);
      center = null;
      markerX = null;

      const preset = ui.select({
        label: "Preset", options: PRESETS, value: "tweet",
        onChange: v => { const p = PRESETS.find(p => p.value === v); if (p) setId(p.id, "jump"); },
      });
      // Shown (but not pickable) once +1/-1 or the slider moves away from every preset.
      preset.querySelector("select").appendChild(ctx.h("option", { value: "custom", disabled: true }, "Custom id"));
      const minus = ui.button(MINUS + "1", () => setId(id - 1n, "step"), { title: "Previous id" });
      const plus = ui.button("+1", () => setId(id + 1n, "step"), { title: "Next id" });
      const slider = ui.slider({
        label: "ID size (bits)", min: 11, max: 63, value: bitLen(id),
        onInput: b => setId(b === 11 ? 1337n : 2n ** BigInt(b - 1) + 1337n, "jump"),
      });
      if (compact) slider.input.style.flex = "1 1 80px";
      const toggle = ui.toggle({ label: "Also send id_str", value: sendStr, onChange: v => { sendStr = v; update("keep"); } });

      const svg = ctx.svg({ w: L.W, h: L.H, label: "A 64-bit ID on the wire, what JSON.parse stores, what JavaScript prints, and where the ID falls among representable doubles" });
      const layers = {};
      ["wire", "rows", "bitsG", "lineG", "markG"].forEach(k => { layers[k] = s("g"); svg.appendChild(layers[k]); });

      const legend = ui.legend([
        { color: C.c6, label: compact ? "true id" : "true id (server's int64)", shape: "dot" },
        { color: C.c2, label: compact ? "doubles" : "integers a double can hold", shape: "dot" },
        { color: C.bad, label: compact ? "changed / lost" : "changed digits / rounded-off bits", shape: "square" },
        { color: C.ok, label: compact ? "id_str" : "id_str (string copy)", shape: "square" },
      ]);
      const stats = ui.stats([
        { key: "bits", label: "Bits", value: "" },
        { key: "gap", label: "Gap between doubles", value: "" },
        { key: "share", label: "Integers per double (avg)", value: "" },
        { key: "err", label: "Round-trip error", value: "" },
      ]);
      const note = ui.note("");

      root.append(ui.bar(preset, minus, plus), ui.bar(slider, toggle), svg, legend, stats, note);
      view = { L, svg, ...layers, preset, minus, plus, slider, stats, note };
      update("jump");
    }

    // mode: "jump" (preset, slider) re-centers the number line, "step" (+1/-1) walks the marker,
    // "keep" (toggle) leaves it alone.
    function setId(v, mode) {
      id = clampId(v);
      update(mode);
    }

    function update(mode) {
      const d = derive(id);
      const p = PRESETS.find(p => p.id === id);
      view.preset.set(p ? p.value : "custom");
      view.slider.set(Math.max(11, d.bits));
      view.minus.disable(id <= 0n);
      view.plus.disable(id >= INT64_MAX);

      drawWire(d);
      drawRows(d);
      drawBits(d);
      drawLine(d, mode);

      const { stats } = view;
      stats.set("bits", d.bits);
      stats.set("gap", d.gap, d.gap > 1n ? "warn" : "ok");
      stats.set("share", d.gap, d.gap > 1n ? "bad" : "ok");
      stats.set("err", d.err === 0n ? "0" : signed(d.err), d.err === 0n ? "ok" : "bad");
      view.note.set(...noteFor(d));
    }

    // ---- (a) the JSON text on the wire ----
    function drawWire(d) {
      const { L, wire } = view, Wp = L.wire;
      wire.innerHTML = "";
      wire.appendChild(ctx.text(12, Wp.labelY, "On the wire (server, int64)", { size: L.fs, anchor: "start", fill: C.muted }));
      if (!compact) wire.appendChild(ctx.text(L.W - 12, Wp.labelY, "the JSON text carries every digit", { size: 12, anchor: "end", fill: C.muted }));
      wire.appendChild(s("rect", { x: 4, y: Wp.y, width: L.W - 8, height: Wp.h, rx: 8, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
      const num = String(d.id), str = `"${num}"`;
      const head = [[`{"id": `, C.muted], [num, C.ink, 700]];
      const tail = [[`"id_str": `, C.muted], [str, C.ok, 600], ["}", C.muted]];
      let lines;
      if (!sendStr) lines = [head.concat([["}", C.muted]])];
      else if (compact) lines = [head.concat([[",", C.muted]]), tail];
      else lines = [head.concat([[", ", C.muted]], tail)];
      const midY = Wp.y + Wp.h / 2, lh = Wp.size * 1.45;
      lines.forEach((parts, i) => {
        const y = midY + (i - (lines.length - 1) / 2) * lh;
        // The phone's second line is indented two characters, like pretty-printed JSON.
        const t = ctx.text(compact ? 12 + (i ? 2 * Wp.size * 0.6 : 0) : 20, y, "", { size: Wp.size, anchor: "start", mono: true });
        parts.forEach(([txt, fill, weight]) => t.appendChild(s("tspan", { fill, "font-weight": weight || null }, txt.replace(/ /g, NBSP))));
        wire.appendChild(t);
      });
    }

    // ---- (b) value rows: what each side ends up holding ----
    // Fills `el` with `str`, painting every character that differs from `ref` (aligned from the right) red.
    function paintDigits(el, str, ref, fill) {
      const n = Math.max(str.length, ref.length);
      const a = str.padStart(n, NBSP), b = ref.padStart(n, NBSP);
      let run = "", bad = false;
      const flush = () => {
        if (run) el.appendChild(s("tspan", bad ? { fill: C.bad, "font-weight": 700 } : { fill }, run));
        run = "";
      };
      for (let i = 0; i < n; i++) {
        const diff = a[i] !== b[i] && a[i] !== NBSP;
        if (diff !== bad) { flush(); bad = diff; }
        run += a[i];
      }
      flush();
    }

    function drawRows(d) {
      const { L, rows } = view, R = L.rows, W = L.W;
      rows.innerHTML = "";
      const idS = String(d.id);
      const offBy = v => (v === 0n ? ["exact", C.ok] : ["off by " + signed(v), C.bad]);
      const list = [
        { label: "Server sent (int64)", value: idS, fill: C.ink, note: [nearPow(d.id), C.muted] },
        { label: "JSON.parse stores (double)", value: String(d.stored), fill: C.ink, note: offBy(d.stored - d.id) },
        { label: "JS prints / sends back", value: d.printed, fill: C.ink, note: offBy(d.err) },
        sendStr ? { label: "id_str (string)", value: idS, fill: C.ok, note: ["exact", C.ok] }
                : { label: "id_str (string)", missing: true, note: ["", C.muted] },
      ];
      list.forEach((r, i) => {
        const y = R.y0 + i * R.pitch;
        const top = compact ? y - 11 : y - 12, hh = compact ? 34 : 24;
        if (i % 2 === 0) rows.appendChild(s("rect", { x: 4, y: top, width: W - 8, height: hh, rx: 5, fill: "var(--viz-grid)", opacity: 0.45 }));
        rows.appendChild(ctx.text(12, y, r.label, { size: L.fs, anchor: "start", fill: C.muted }));
        const vy = compact ? y + 16 : y, vx = compact ? 12 : W - 12;
        if (r.missing) {
          rows.appendChild(ctx.text(vx, vy, "(not sent)", { size: L.fs + 1, anchor: compact ? "start" : "end", fill: C.muted }));
        } else {
          const t = ctx.text(vx, vy, "", { size: R.mono, anchor: compact ? "start" : "end", mono: true });
          paintDigits(t, r.value, idS, r.fill);
          rows.appendChild(t);
        }
        if (r.note[0]) {
          // Desktop: just left of the value column. Phone: right end of the label line.
          const nx = compact ? W - 12 : W - 12 - 19 * R.mono * 0.61 - 14;
          rows.appendChild(ctx.text(nx, y, r.note[0], { size: L.fs, anchor: "end", fill: r.note[1], weight: r.note[1] === C.muted ? null : 600 }));
        }
      });
    }

    // ---- bit strip: why the gap is 2^(bits - 53) ----
    function drawBits(d) {
      const { L, bitsG } = view, B = L.bits, W = L.W;
      bitsG.innerHTML = "";
      const cw = (W - 24) / 64, x = i => 12 + (63 - i) * cw;   // left edge of bit i (0 = least significant)
      const lo = Math.max(0, d.bits - 53);   // the double keeps bits [lo, bits-1]; the lo bits below are rounded off
      bitsG.appendChild(ctx.text(12, B.titleY, "The same id in binary (64-bit int)", { size: L.fs, anchor: "start", fill: C.muted }));
      if (!compact) bitsG.appendChild(ctx.text(W - 12, B.titleY, "a double = 53-bit significand × 2ᵉ", { size: 12, anchor: "end", fill: C.muted }));
      for (let i = 63; i >= 0; i--) {
        const one = ((d.id >> BigInt(i)) & 1n) === 1n;
        const zone = i >= d.bits ? null : i >= lo ? "c2" : "bad";
        bitsG.appendChild(s("rect", {
          x: x(i) + 0.5, y: B.y, width: cw - 1, height: B.h, rx: Math.min(2, cw / 4),
          fill: !zone ? "var(--viz-grid)" : `var(--viz-${zone}${one ? "" : "-soft"})`,
          stroke: zone && !one ? `var(--viz-${zone})` : null, "stroke-width": 0.7,
        }));
      }
      const by = B.y + B.h + 5, ly = by + 12;
      const bracket = (x1, x2, color) => bitsG.appendChild(s("path", {
        d: `M${x1 + 0.5},${by - 3} V${by} H${x2 - 0.5} V${by - 3}`, fill: "none", stroke: color, "stroke-width": 1.4,
      }));
      bracket(x(d.bits - 1), x(lo) + cw, C.c2);
      let lostLeft = W;
      if (lo) {
        bracket(x(lo - 1), x(0) + cw, C.bad);
        const zeros = d.id % d.gap === 0n, bitsWord = `${lo} low bit${lo > 1 ? "s" : ""}`;
        const txt = compact ? (zeros ? `low ${lo} are 0` : `${lo} rounded off`)
          : `${bitsWord} ${lo > 1 ? "don't" : "doesn't"} fit: ${zeros ? (lo > 1 ? "all 0 here" : "it's 0 here") + ", so no loss" : "rounded off"}`;
        const t = ctx.text(W - 12, ly, txt, { size: L.fs, anchor: "end", fill: C.bad, weight: 600 });
        bitsG.appendChild(t);
        lostLeft = W - 12 - textWidth(t, txt, L.fs);
      }
      const kept = d.bits <= 53
        ? (compact ? `all ${d.bits} bits fit` : `all ${d.bits} bits fit in the 53-bit significand: stored exactly`)
        : (compact ? "53 bits kept" : "top 53 bits fit in the significand");
      const kt = ctx.text(0, ly, kept, { size: L.fs, fill: C.c2, weight: 600 });
      bitsG.appendChild(kt);
      const kw = textWidth(kt, kept, L.fs);
      const kx = Math.max(12 + kw / 2, Math.min((x(d.bits - 1) + x(lo) + cw) / 2, lostLeft - 10 - kw / 2, W - 12 - kw / 2));
      kt.setAttribute("x", kx);
    }

    function textWidth(el, str, size) {
      const w = el.getComputedTextLength ? el.getComputedTextLength() : 0;
      return w || str.length * size * 0.56;
    }

    // ---- (c) number line: the doubles near the id, and where the id lands ----
    function drawLine(d, mode) {
      const { L, lineG } = view, N = L.line, W = L.W, mid = W / 2, sp = (W - 48) / 9;
      // Keep the window still while +1/-1 walk the marker; re-center on jumps and scale changes.
      const off = center === null ? Infinity : Math.abs(Number(d.id - center) / Number(d.gap));
      const recenter = mode === "jump" || d.gap !== centerGap || off > 1.6;
      if (recenter) { center = d.stored; centerGap = d.gap; }
      const X = v => mid + (Number(v - center) / Number(centerGap)) * sp;
      lineG.innerHTML = "";

      // Every double inside the axis: walk outward from the one at the center.
      const dots = [center];
      for (let v = nextUp(center); X(v) <= W - 26 && dots.length < 40; v = nextUp(v)) dots.push(v);
      for (let v = nextDown(center); v !== null && X(v) >= 26 && dots.length < 60; v = nextDown(v)) dots.unshift(v);

      const cap = captionFor(d, dots);
      lineG.appendChild(ctx.text(12, N.capY, cap, { size: L.fs, anchor: "start", fill: C.muted }));
      const ay = N.axisY;
      lineG.appendChild(s("line", { x1: 24, x2: W - 24, y1: ay, y2: ay, stroke: "var(--viz-line)", "stroke-width": 1.5 }));

      // Rounding basin of the stored double: every integer in it decodes to that one value.
      const si = dots.findIndex(v => v === d.stored);
      if (si >= 0 && d.gap > 1n) {
        const a = si > 0 ? (X(dots[si - 1]) + X(d.stored)) / 2 : X(d.stored) - sp / 2;
        const b = si < dots.length - 1 ? (X(dots[si + 1]) + X(d.stored)) / 2 : X(d.stored) + sp / 2;
        lineG.appendChild(s("rect", { x: a, y: ay - 6, width: b - a, height: 12, rx: 6, fill: "var(--viz-c2-soft)", stroke: C.c2, "stroke-width": 0.8, "stroke-dasharray": "3 3" }));
      }
      dots.forEach(v => {
        const big = v === d.stored, past = v > INT64_MAX;
        lineG.appendChild(s("circle", {
          cx: X(v), cy: ay, r: big ? 6 : 4,
          fill: past ? "var(--viz-bg)" : C.c2, stroke: past ? C.bad : big ? "var(--viz-bg)" : null, "stroke-width": past ? 1.6 : 2,
        }));
      });

      // Tick labels: the stored double always; desktop also about two steps out; powers of two.
      const xs = X(d.stored), labeled = [];
      const want = [d.stored];
      if (!compact) [-2, 2].forEach(k => {
        const v = dots.reduce((best, u) => (Math.abs(X(u) - (xs + k * sp)) < Math.abs(X(best) - (xs + k * sp)) ? u : best), dots[0]);
        if (Math.abs(X(v) - xs) > sp * 1.4) want.push(v);
      });
      dots.filter(v => isPow2(v) && v >= SAFE).forEach(v => want.push(v));
      want.forEach(v => {
        if (labeled.some(u => Math.abs(X(u) - X(v)) < (compact ? 46 : 54))) return;
        labeled.push(v);
        const main = v === d.stored, txt = tickText(v);
        lineG.appendChild(ctx.text(X(v), ay + 18, txt, {
          size: L.fs, mono: !txt.startsWith("2"), fill: v > INT64_MAX ? C.bad : main ? C.c2 : C.muted, weight: main ? 700 : null,
        }));
      });

      const target = X(d.id);
      const my = ++tweenToken;
      if (mode === "step" && !recenter && markerX !== null && !ctx.instant) {
        const from = markerX;
        ctx.tween({ ms: 300, ease: "out", onUpdate: k => { if (my === tweenToken) drawMarker(d, ctx.lerp(from, target, k), xs); } });
      } else drawMarker(d, target, xs);
      markerX = target;
    }

    function captionFor(d, dots) {
      const p = dots.find(v => isPow2(v) && v >= SAFE);   // the gap doubles at every power of two from 2^53 up
      if (d.gap === 1n) {
        if (!p) return "Every integer here has its own double";
        return compact ? "Every integer below 2⁵³ is a double; above, every 2nd"
                       : "Every integer below 2⁵³ has its own double; above it, only every second one";
      }
      const gap = `${pow2(d.bits - 53)} = ${d.gap}`;   // 2^(dropped bits): ties the gap to the bit strip
      let cap = compact ? `Doubles here are ${gap} apart` : `Adjacent doubles here are ${gap} apart: about ${d.gap} IDs round to each`;
      if (p) {
        const other = gapAt(p) === d.gap ? gapAt(p - 1n) : gapAt(p);
        cap += ` (${other}${compact ? "" : " apart"} ${other > d.gap ? "above" : "below"} ${pow2(bitLen(p) - 1)})`;
      }
      return cap;
    }

    function drawMarker(d, xm, xs) {
      const { L, markG } = view, N = L.line, my = N.markY, ay = N.axisY, W = L.W;
      markG.innerHTML = "";
      const rounds = d.stored !== d.id, near = Math.abs(xs - xm) < 10;
      if (!rounds || !near) {
        markG.appendChild(s("line", { x1: xm, x2: xm, y1: my + 6, y2: ay - (rounds ? 0 : 6), stroke: C.c6, "stroke-width": 1.2, "stroke-dasharray": "3 2" }));
      }
      if (rounds) {
        const dir = xs < xm ? -1 : 1;
        const path = near
          ? `M${xm},${my + 7} L${xs},${ay - 9}`
          : `M${xm + dir * 7},${my} Q${xs},${my} ${xs},${ay - 9}`;
        markG.appendChild(s("path", { d: path, fill: "none", stroke: C.bad, "stroke-width": 1.3, "marker-end": view.svg.arrow(C.bad) }));
      }
      markG.appendChild(s("circle", { cx: xm, cy: my, r: 6, fill: "var(--viz-c6-soft)", stroke: C.c6, "stroke-width": 1.8 }));
      const txt = rounds ? "id rounds to the nearest double" : d.gap > 1n ? "id lands exactly on a double" : "id is exactly a double";
      const t = ctx.text(0, N.labelY, txt, { size: L.fs, fill: rounds ? C.bad : C.c6, weight: 600, halo: true });
      markG.appendChild(t);
      const w = textWidth(t, txt, L.fs);
      t.setAttribute("x", Math.max(12 + w / 2, Math.min(W - 12 - w / 2, xm)));
    }

    // ---- the explanation ----
    function noteFor(d) {
      const b = v => `<b class="mono">${v}</b>`;
      const sup53 = "2<sup>53</sup>";
      if (d.id <= SAFE) {
        const hint = d.id === SAFE ? ` It's the last one: above ${sup53} doubles are 2 apart. Press <b>+1</b> and watch neighbors collapse.`
          : d.id >= SAFE - 3n ? ` Press <b>+1</b> to cross ${sup53} and watch neighbors collapse.`
          : ` Pick <b>Largest safe</b> and press <b>+1</b> to cross ${sup53}.`;
        return [`Every integer up to ${sup53} (9,007,199,254,740,992) has its own double, so <span class="mono">JSON.parse</span> returns exactly ${b(d.id)}.` + hint, "ok"];
      }
      const about = `about ${d.gap} neighboring IDs`, About = "A" + about.slice(1);
      let html, tone = "bad";
      if (d.stored === d.id && d.printed !== String(d.id)) {
        html = `This ID happens to land exactly on a double, yet JavaScript prints it as ${b(d.printed)}: it shows the shortest decimal that maps to the same double. ` +
          `A client that requests <span class="mono">/items/${d.printed}</span> asks for a different record. ${About} decode to each double at this size.`;
      } else if (d.stored === d.id) {
        tone = "warn";
        html = `${b(d.id)} is a multiple of ${d.gap}, so it is exactly a double and even prints back unchanged. That's luck, not safety: ${about} share each double here. Press <b>+1</b>.`;
      } else if (d.err === 0n) {
        tone = "warn";
        html = `No double equals ${b(d.id)}, so <span class="mono">JSON.parse</span> stores ${b(d.stored)}. It still prints as ${b(d.printed)}, the shortest decimal for that double, ` +
          `but so do its neighbors: ${about} collapse into this one value.`;
      } else {
        const shown = d.printed !== String(d.stored) ? `, which prints as ${b(d.printed)}` : "";
        html = `No double equals ${b(d.id)}, so <span class="mono">JSON.parse</span> silently rounds it to ${b(d.stored)} (off by ${signed(d.stored - d.id)})${shown}. ` +
          `No exception, no warning. ${About} share each double here.`;
      }
      if (d.stored > INT64_MAX) {
        html += ` It even rounds up to 2<sup>63</sup>, which doesn't fit in a signed 64-bit integer, so sending it back can overflow on the server.`;
      }
      if (sendStr && (d.err !== 0n || d.stored !== d.id)) {
        html += ` The <span class="mono">id_str</span> copy is just text, so it survives untouched. That's why Twitter's API sent both.`;
      } else if (d.err !== 0n) {
        html += " With no string copy, the client has no way to recover the real ID.";
      } else if (d.stored !== d.id) {
        html += " With no string copy, the client can't tell this ID from its neighbors.";
      }
      return [html, tone];
    }

    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint. Deferred so the
    // rebuild's own height change doesn't land inside the ResizeObserver callback (loop warning).
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) build(); }));
  },
});
