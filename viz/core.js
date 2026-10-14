// Viz toolkit: lazy-loaded, self-cleaning interactive visualizations.
//
// Each visualization lives in viz/<chapter>/<name>.js and registers itself:
//
//   Viz.register("ch5/quorum", {
//     title: "Quorum reads & writes",
//     mount(root, ctx) { ... build DOM/SVG into root, wire controls ... }
//   });
//
// The app renders <figure class="viz" data-viz="ch5/quorum"> frames; Viz.mountAll()
// lazy-loads the script when the frame scrolls near the viewport and calls mount().
// Every timer/animation created through `ctx` is paused while off-screen and torn
// down automatically on unmount, so visualizations never leak work.
//
// Full API reference with examples: docs/AUTHORING.md
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const registry = Object.create(null);
  const waiters = Object.create(null);
  const loading = Object.create(null);
  const instances = new Set();
  let uidCounter = 0;

  const reducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function reportError(id, err) {
    const msg = (err && (err.stack || err.message)) || String(err);
    (window.__DDIA_ERRORS = window.__DDIA_ERRORS || []).push({ viz: id, error: msg });
    console.error("[viz " + id + "]", err);
  }

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------
  function applyProps(el, props, isSvg) {
    if (!props) return;
    for (const k in props) {
      const v = props[k];
      if (v === null) { // null removes (handy with ctx.attr); harmless when creating
        if (isSvg) el.style.removeProperty(k);
        el.removeAttribute(k === "className" ? "class" : k);
        continue;
      }
      if (v === undefined || v === false) continue;
      if (k === "class" || k === "className") {
        if (isSvg) el.setAttribute("class", v); else el.className = v;
      } else if (k === "style") {
        if (typeof v === "string") el.style.cssText += ";" + v;
        else Object.assign(el.style, v);
      } else if (k === "on") {
        for (const ev in v) el.addEventListener(ev, v[ev]);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "html") {
        el.innerHTML = v;
      } else if (k === "text") {
        el.textContent = v;
      } else if (k === "dataset") {
        Object.assign(el.dataset, v);
      } else if (isSvg && typeof v === "string" && v.indexOf("var(") !== -1) {
        // CSS custom properties are only reliable through style, not presentation attrs.
        el.style.setProperty(k, v);
      } else if (!isSvg && (k === "value" || k === "checked" || k === "disabled" || k === "selected")) {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
  }
  function appendKids(el, kids) {
    for (const c of kids) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) appendKids(el, c);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  /** h("div", {class: "x", onClick: fn}, child, "text", [more]) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    applyProps(el, props, false);
    appendKids(el, kids);
    return el;
  }
  /** s("circle", {cx: 10, cy: 10, r: 5, fill: "var(--viz-c1)"}) */
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    applyProps(el, attrs, true);
    appendKids(el, kids);
    return el;
  }
  /** Set attributes on an existing element (SVG-aware). */
  function attr(el, attrs) {
    applyProps(el, attrs, el instanceof SVGElement);
    return el;
  }

  // ------------------------------------------------------------------
  // Easing / math
  // ------------------------------------------------------------------
  const ease = {
    linear: t => t,
    inOut: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    out: t => 1 - Math.pow(1 - t, 3),
    in: t => t * t * t,
    back: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  /** Deterministic PRNG (mulberry32). Use instead of Math.random for reproducible demos. */
  function random(seed) {
    let a = (seed >>> 0) || 1;
    const next = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    next.pick = arr => arr[Math.floor(next() * arr.length)];
    next.chance = p => next() < p;
    next.normal = (mu = 0, sigma = 1) => {
      const u = 1 - next(), v = next();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    next.exp = mean => -Math.log(1 - next()) * mean;
    return next;
  }

  // ------------------------------------------------------------------
  // UI kit (returned controls are plain elements with small helper methods)
  // ------------------------------------------------------------------
  function makeUI(ctx) {
    const ui = {};

    ui.bar = (...kids) => h("div", { class: "viz-controls" }, ...kids);
    ui.row = (...kids) => h("div", { class: "viz-row" }, ...kids);
    ui.spacer = () => h("div", { class: "viz-spacer" });

    ui.button = (label, onClick, opts = {}) => {
      const b = h("button", {
        type: "button",
        class: "viz-btn" + (opts.kind ? " viz-btn--" + opts.kind : ""),
        title: opts.title,
        "aria-label": opts.ariaLabel || opts.title,
      });
      b.innerHTML = label;
      b.addEventListener("click", e => { if (ctx.alive) onClick(e); });
      b.setLabel = html => { b.innerHTML = html; return b; };
      b.disable = (on = true) => { b.disabled = !!on; return b; };
      b.setActive = (on = true) => { b.classList.toggle("is-active", !!on); return b; };
      return b;
    };

    ui.slider = ({ label, min = 0, max = 100, step = 1, value = min, format, onInput, width }) => {
      const fmt = format || (v => String(v));
      const out = h("span", { class: "viz-slider-val" }, fmt(value));
      const input = h("input", { type: "range", min, max, step, value, "aria-label": label });
      if (width) input.style.width = typeof width === "number" ? width + "px" : width;
      const el = h("label", { class: "viz-slider" },
        label ? h("span", { class: "viz-slider-label" }, label) : null, input, out);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        if (onInput && ctx.alive) onInput(v);
      });
      el.get = () => Number(input.value);
      el.set = (v, fire = false) => {
        input.value = v; out.textContent = fmt(Number(input.value));
        if (fire && onInput) onInput(Number(input.value));
        return el;
      };
      el.input = input;
      el.disable = (on = true) => { input.disabled = !!on; el.classList.toggle("is-disabled", !!on); return el; };
      Object.defineProperty(el, "value", { get: () => Number(input.value) });
      return el;
    };

    ui.toggle = ({ label, value = false, onChange }) => {
      const input = h("input", { type: "checkbox" });
      input.checked = !!value;
      const el = h("label", { class: "viz-toggle" }, input, h("span", { class: "viz-toggle-track" }), h("span", null, label));
      input.addEventListener("change", () => { if (onChange && ctx.alive) onChange(input.checked); });
      el.get = () => input.checked;
      el.set = (v, fire = false) => { input.checked = !!v; if (fire && onChange) onChange(!!v); return el; };
      el.disable = (on = true) => { input.disabled = !!on; el.classList.toggle("is-disabled", !!on); return el; };
      Object.defineProperty(el, "value", { get: () => input.checked });
      return el;
    };

    const normOpts = options => options.map(o => (typeof o === "object" ? o : { value: o, label: String(o) }));

    ui.select = ({ label, options, value, onChange }) => {
      const opts = normOpts(options);
      const sel = h("select", { "aria-label": label || "Choose an option" },
        ...opts.map(o => h("option", { value: String(o.value) }, o.label)));
      if (value !== undefined) sel.value = String(value);
      const el = h("label", { class: "viz-select" }, label ? h("span", null, label) : null, sel);
      const read = () => { const o = opts.find(o => String(o.value) === sel.value); return o ? o.value : sel.value; };
      sel.addEventListener("change", () => { if (onChange && ctx.alive) onChange(read()); });
      el.get = read;
      el.set = (v, fire = false) => { sel.value = String(v); if (fire && onChange) onChange(read()); return el; };
      el.disable = (on = true) => { sel.disabled = !!on; el.classList.toggle("is-disabled", !!on); return el; };
      Object.defineProperty(el, "value", { get: read });
      return el;
    };

    ui.segmented = ({ label, options, value, onChange }) => {
      const opts = normOpts(options);
      let current = value !== undefined ? value : opts[0].value;
      const btns = opts.map(o => {
        const b = h("button", { type: "button", class: "viz-seg-btn", title: o.title }, o.label);
        b.addEventListener("click", () => {
          if (!ctx.alive) return;
          current = o.value; sync();
          if (onChange) onChange(o.value);
        });
        b._value = o.value;
        return b;
      });
      const sync = () => btns.forEach(b => b.classList.toggle("is-active", b._value === current));
      sync();
      const el = h("div", { class: "viz-seg-wrap" },
        label ? h("span", { class: "viz-seg-label" }, label) : null,
        h("div", { class: "viz-seg", role: "group", "aria-label": label }, ...btns));
      el.get = () => current;
      el.set = (v, fire = false) => { current = v; sync(); if (fire && onChange) onChange(v); return el; };
      /** disable(true) disables all options; disable(true, value) just that option */
      el.disable = (on = true, value) => {
        btns.forEach(b => { if (value === undefined || b._value === value) b.disabled = !!on; });
        if (value === undefined) el.classList.toggle("is-disabled", !!on);
        return el;
      };
      Object.defineProperty(el, "value", { get: () => current });
      return el;
    };

    /** stats([{key, label, value, tone}]) -> el with .set(key, value, tone) */
    ui.stats = items => {
      const map = {};
      const el = h("div", { class: "viz-stats" }, ...items.map(it => {
        const v = h("div", { class: "viz-stat-value" });
        v.innerHTML = it.value === undefined ? "–" : String(it.value);
        const card = h("div", { class: "viz-stat" + (it.tone ? " tone-" + it.tone : "") },
          h("div", { class: "viz-stat-label" }, it.label), v);
        map[it.key] = { card, v };
        return card;
      }));
      el.set = (key, value, tone) => {
        const m = map[key]; if (!m) return el;
        m.v.innerHTML = String(value);
        if (tone !== undefined) m.card.className = "viz-stat" + (tone ? " tone-" + tone : "");
        return el;
      };
      return el;
    };

    /** Event log panel. add(html, tone) where tone in ok|bad|warn|info|muted */
    ui.log = ({ title = "Event log", max = 60, height } = {}) => {
      const list = h("div", { class: "viz-log-list" });
      if (height) list.style.maxHeight = height + "px";
      const el = h("div", { class: "viz-log" }, h("div", { class: "viz-log-title" }, title), list);
      el.add = (html, tone) => {
        const row = h("div", { class: "viz-log-row" + (tone ? " tone-" + tone : "") });
        row.innerHTML = html;
        list.appendChild(row);
        while (list.children.length > max) list.removeChild(list.firstChild);
        list.scrollTop = list.scrollHeight;
        return row;
      };
      el.clear = () => { list.innerHTML = ""; return el; };
      return el;
    };

    /** Explanatory note that you update as the user explores. tone: info|ok|bad|warn */
    ui.note = (html = "", tone) => {
      const el = h("div", { class: "viz-note" + (tone ? " tone-" + tone : "") });
      el.innerHTML = html;
      el.set = (html2, tone2) => {
        el.innerHTML = html2;
        el.className = "viz-note" + (tone2 ? " tone-" + tone2 : "");
        return el;
      };
      return el;
    };

    /** legend([{color: "var(--viz-c1)", label: "Leader", shape: "dot"|"square"|"line"|"dash"}]) */
    ui.legend = items => h("div", { class: "viz-legend" }, ...items.map(it => {
      const sw = h("span", { class: "viz-legend-swatch shape-" + (it.shape || "dot") });
      sw.style.setProperty("--sw", it.color);
      return h("span", { class: "viz-legend-item" }, sw, it.label);
    }));

    ui.panel = (title, ...kids) => h("div", { class: "viz-panel" },
      title ? h("div", { class: "viz-panel-title" }, title) : null, ...kids);

    /** Small inline pill/badge. tone: ok|bad|warn|info|muted|accent */
    ui.badge = (text, tone) => h("span", { class: "viz-badge-pill" + (tone ? " tone-" + tone : "") }, text);

    return ui;
  }

  // ------------------------------------------------------------------
  // SVG kit
  // ------------------------------------------------------------------
  function makeSvgKit(ctx) {
    /**
     * Responsive SVG root. svg({w: 640, h: 300}) — scales to container width.
     * Comes with arrow markers: svg.arrow(color) -> "url(#...)" for marker-end.
     */
    function svg({ w = 640, h: height = 320, class: cls, label, role } = {}) {
      const root = s("svg", {
        viewBox: `0 0 ${w} ${height}`,
        class: "viz-svg" + (cls ? " " + cls : ""),
        role: role || "img", // pass role: "group" when the drawing has clickable parts
        "aria-label": label || ctx.title || "Visualization",
        preserveAspectRatio: "xMidYMid meet",
      });
      const defs = s("defs");
      root.appendChild(defs);
      const markers = {};
      root.defs = defs;
      root.arrow = (color = "var(--viz-muted)") => {
        if (!markers[color]) {
          const id = "vz-arrow-" + ctx.uid + "-" + Object.keys(markers).length;
          const m = s("marker", {
            id, viewBox: "0 0 10 10", refX: 9, refY: 5,
            markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse",
          }, s("path", { d: "M0,0 L10,5 L0,10 z", fill: color }));
          defs.appendChild(m);
          markers[color] = `url(#${id})`;
        }
        return markers[color];
      };
      root.w = w; root.h = height;
      return root;
    }

    /** text(x, y, str, {size, anchor, weight, fill, baseline, mono, halo, class}); halo = outline in the
     *  background color so the label stays readable on top of lines */
    function text(x, y, str, o = {}) {
      const t = s("text", {
        x, y,
        "font-size": o.size || 13,
        "text-anchor": o.anchor || "middle",
        "dominant-baseline": o.baseline || "middle",
        "font-weight": o.weight || null,
        fill: o.fill || "var(--viz-ink)",
        class: (o.mono ? "viz-mono " : "") + (o.halo ? "viz-halo " : "") + (o.class || ""),
      });
      t.textContent = str;
      return t;
    }

    /** box({x, y, w, h, rx, fill, stroke, label, sub, size, dashed}) -> <g> with .rect/.label/.sub */
    function box(o) {
      const g = s("g", { class: o.class || null });
      // Opaque underlay so translucent "-soft" fills don't show edges drawn beneath.
      g.appendChild(s("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: o.rx === undefined ? 8 : o.rx, fill: "var(--viz-bg)" }));
      const rect = s("rect", {
        x: o.x, y: o.y, width: o.w, height: o.h, rx: o.rx === undefined ? 8 : o.rx,
        fill: o.fill || "var(--viz-node)",
        stroke: o.stroke || "var(--viz-node-stroke)",
        "stroke-width": o.strokeWidth || 1.5,
        "stroke-dasharray": o.dashed ? "5 4" : null,
      });
      g.appendChild(rect);
      g.rect = rect;
      if (o.label !== undefined) {
        const cy = o.sub ? o.y + o.h / 2 - 8 : o.y + o.h / 2;
        g.label = text(o.x + o.w / 2, cy, o.label, { size: o.size || 13, weight: o.weight || 600, fill: o.ink, mono: o.mono });
        g.appendChild(g.label);
      }
      if (o.sub !== undefined) {
        g.sub = text(o.x + o.w / 2, o.y + o.h / 2 + 10, o.sub, { size: (o.size || 13) - 2, fill: "var(--viz-muted)", mono: o.mono });
        g.appendChild(g.sub);
      }
      return g;
    }

    /** node({x, y, r, label, sub, fill, stroke}) — circle with centered label */
    function node(o) {
      const g = s("g", { class: o.class || null });
      g.appendChild(s("circle", { cx: o.x, cy: o.y, r: o.r || 22, fill: "var(--viz-bg)" }));
      g.circle = s("circle", {
        cx: o.x, cy: o.y, r: o.r || 22,
        fill: o.fill || "var(--viz-node)",
        stroke: o.stroke || "var(--viz-node-stroke)",
        "stroke-width": o.strokeWidth || 2,
      });
      g.appendChild(g.circle);
      if (o.label !== undefined) {
        g.label = text(o.x, o.y, o.label, { size: o.size || 13, weight: 700, fill: o.ink });
        g.appendChild(g.label);
      }
      if (o.sub !== undefined) {
        g.sub = text(o.x, o.y + (o.r || 22) + 14, o.sub, { size: 11, fill: "var(--viz-muted)" });
        g.appendChild(g.sub);
      }
      return g;
    }

    /** line/arrow({x1,y1,x2,y2,color,width,dashed,arrow:true, svg}) — pass svg root for arrowheads */
    function arrow(o) {
      const color = o.color || "var(--viz-muted)";
      const p = s("path", {
        d: o.curve
          ? `M${o.x1},${o.y1} Q${(o.x1 + o.x2) / 2 + (o.curve || 0)},${(o.y1 + o.y2) / 2 - (o.curve || 0)} ${o.x2},${o.y2}`
          : `M${o.x1},${o.y1} L${o.x2},${o.y2}`,
        fill: "none",
        stroke: color,
        "stroke-width": o.width || 1.8,
        "stroke-dasharray": o.dashed ? "6 5" : null,
        "marker-end": o.arrow !== false && o.svg ? o.svg.arrow(color) : null,
        class: o.class || null,
      });
      return p;
    }

    /**
     * Swimlane timeline: one horizontal lane per actor, time flows left -> right.
     * Ideal for replication lag, transaction interleavings, clocks, 2PC, linearizability.
     *
     *   const tl = lanes({ parent: svg, x: 0, y: 10, w: 640, h: 220, t0: 0, t1: 10,
     *                      lanes: [{ id: "a", label: "Client A", color: "c6" }, ...] });
     *   tl.op("a", 1, 3, { label: "write x=1", tone: "ok" });       // bar spanning [1, 3]
     *   tl.msg("a", 1, "db", 1.6, { label: "x=1" });                 // arrow between lanes
     *   tl.mark("db", 2, { label: "commit" });                      // dot on a lane
     *   tl.cursor(4)                                                 // vertical "now" line
     * Elements are returned so you can animate/restyle them; tl.clear() empties the content
     * layer but keeps lanes. tl.x(t), tl.y(laneId) map to SVG coordinates.
     */
    function lanes(o) {
      const parent = o.parent;
      const x0 = o.x || 0, y0 = o.y || 0, w = o.w, hgt = o.h;
      const gutter = o.labelWidth === undefined ? (ctx.compact ? 64 : 92) : o.labelWidth;
      const t0 = o.t0 || 0, t1 = o.t1 === undefined ? 10 : o.t1;
      const laneList = o.lanes;
      const laneH = hgt / laneList.length;
      const root = s("g", { class: "viz-lanes" });
      const bg = s("g"), content = s("g"), overlay = s("g");
      root.append(bg, content, overlay);
      parent.appendChild(root);
      const idx = {};
      laneList.forEach((ln, i) => { idx[ln.id] = i; });
      const X = t => x0 + gutter + ((t - t0) / (t1 - t0)) * (w - gutter - 8);
      const Y = id => y0 + laneH * idx[id] + laneH / 2;
      const col = c => (!c ? "var(--viz-line)" : c.startsWith("var(") ? c : `var(--viz-${c})`);
      const soft = c => (!c ? "var(--viz-node)" : c.startsWith("var(") ? c : `var(--viz-${c}-soft)`);
      const toneCol = t => ({ ok: "ok", bad: "bad", warn: "warn", info: "info" }[t] || t);

      laneList.forEach((ln, i) => {
        const y = Y(ln.id);
        if (i % 2 === 0) bg.appendChild(s("rect", { x: x0, y: y0 + laneH * i, width: w, height: laneH, fill: "var(--viz-grid)", opacity: 0.35, rx: 4 }));
        bg.appendChild(s("line", { x1: x0 + gutter, x2: x0 + w - 4, y1: y, y2: y, stroke: col(ln.color), "stroke-width": 1.5, opacity: 0.55 }));
        bg.appendChild(text(x0 + 6, y, ln.label, { size: o.labelSize || (ctx.compact ? 11 : 12), anchor: "start", weight: 700, fill: col(ln.color) }));
      });

      const api = {
        root, content, overlay,
        x: X, y: Y, laneHeight: laneH,
        op(id, ta, tb, opt = {}) {
          const c = toneCol(opt.tone || opt.color);
          const hh = Math.min(opt.height || 22, laneH * 0.62);
          const g = s("g");
          g.appendChild(s("rect", { x: X(ta), y: Y(id) - hh / 2, width: Math.max(4, X(tb) - X(ta)), height: hh, rx: 5, fill: "var(--viz-bg)" }));
          g.rect = s("rect", {
            x: X(ta), y: Y(id) - hh / 2, width: Math.max(4, X(tb) - X(ta)), height: hh, rx: 5,
            fill: soft(c), stroke: col(c), "stroke-width": 1.4, "stroke-dasharray": opt.dashed ? "4 3" : null,
          });
          g.appendChild(g.rect);
          if (opt.label) {
            g.label = text((X(ta) + X(tb)) / 2, Y(id), opt.label, { size: opt.size || 11, weight: 600, mono: opt.mono });
            g.appendChild(g.label);
          }
          content.appendChild(g);
          return g;
        },
        msg(fromId, tf, toId, tt, opt = {}) {
          const c = col(toneCol(opt.tone || opt.color) || "muted");
          const x1 = X(tf), y1 = Y(fromId), x2 = X(tt), y2 = Y(toId);
          const dir = y2 > y1 ? 1 : -1, pad = Math.min(10, laneH * 0.25);
          const g = s("g");
          const ya = y1 + dir * pad, yb = opt.lost ? (y1 + y2) / 2 : y2 - dir * pad;
          const xb = opt.lost ? (x1 + x2) / 2 : x2;
          g.line = s("path", {
            d: `M${x1},${ya} L${xb},${yb}`, fill: "none", stroke: c, "stroke-width": 1.6,
            "stroke-dasharray": opt.dashed || opt.lost ? "5 4" : null,
            "marker-end": opt.lost ? null : (parent.arrow ? parent.arrow(c) : (parent.ownerSVGElement && parent.ownerSVGElement.arrow ? parent.ownerSVGElement.arrow(c) : null)),
          });
          g.appendChild(g.line);
          if (opt.lost) g.appendChild(text(xb, yb, "✕", { size: 14, weight: 800, fill: "var(--viz-bad)" }));
          if (opt.label) {
            const lx = (x1 + xb) / 2, ly = (ya + yb) / 2;
            g.label = text(lx + (opt.labelDx || 0), ly - 8 + (opt.labelDy || 0), opt.label, { size: opt.size || 11, weight: 600, fill: c, mono: opt.mono, halo: true });
            g.appendChild(g.label);
          }
          content.appendChild(g);
          return g;
        },
        mark(id, t, opt = {}) {
          const c = col(toneCol(opt.tone || opt.color) || "c1");
          const g = s("g");
          g.dot = s("circle", { cx: X(t), cy: Y(id), r: opt.r || 5, fill: c, stroke: "var(--viz-bg)", "stroke-width": 1.5 });
          g.appendChild(g.dot);
          if (opt.label) {
            g.label = text(X(t), Y(id) + (opt.below ? 16 : -14), opt.label, { size: opt.size || 11, weight: 600, fill: c, mono: opt.mono, halo: true });
            g.appendChild(g.label);
          }
          content.appendChild(g);
          return g;
        },
        /** cursor(t, {label}) draws/moves the "now" line; cursor(null) hides it */
        cursor(t, opt = {}) {
          if (t === null || t === undefined) {
            if (api._cursor) { api._cursor.remove(); api._cursorLabel.remove(); api._cursor = null; }
            return null;
          }
          if (!api._cursor) {
            api._cursor = s("line", { stroke: opt.color ? col(opt.color) : "var(--viz-warn)", "stroke-width": 1.5, "stroke-dasharray": "3 3" });
            api._cursorLabel = text(0, y0 + 2, "", { size: opt.size || (ctx.compact ? 11 : 12), weight: 700, fill: opt.color ? col(opt.color) : "var(--viz-warn)", baseline: "hanging", halo: true });
            overlay.append(api._cursor, api._cursorLabel);
          }
          attr(api._cursor, { x1: X(t), x2: X(t), y1: y0, y2: y0 + hgt });
          attr(api._cursorLabel, { x: X(t) });
          api._cursorLabel.textContent = opt.label || "";
          return api._cursor;
        },
        clear() { content.innerHTML = ""; overlay.innerHTML = ""; api._cursor = null; },
      };
      return api;
    }

    return { svg, text, box, node, arrow, lanes };
  }

  // ------------------------------------------------------------------
  // Instance (one mounted visualization)
  // ------------------------------------------------------------------
  function createInstance(frame, id, def) {
    const body = frame.querySelector(".viz-body") || frame;
    const cleanups = [];
    const timers = [];
    const pendingSleeps = new Set();
    const pendingTweens = new Set();
    let alive = true;
    let visible = true;
    let fastForward = false;
    const resizeFns = [];
    const themeFns = [];

    const ctx = {
      id,
      uid: ++uidCounter,
      title: def.title,
      get alive() { return alive; },
      get visible() { return visible && !document.hidden; },
      /** True while the stepper replays steps instantly (back/fast-forward). */
      get instant() { return fastForward || reducedMotion(); },
      set instant(v) { fastForward = !!v; if (v) flushAnimations(); },
      speed: 1,
      h, s, attr, ease, lerp, clamp, random,
      onCleanup(fn) { cleanups.push(fn); },
      width() { return body.clientWidth || frame.clientWidth || 640; },
      get compact() { return ctx.width() < 560; },
      onResize(fn) { resizeFns.push(fn); },
      onTheme(fn) { themeFns.push(fn); },
      theme() { return document.body.classList.contains("light") ? "light" : "dark"; },
      /** Resolve a CSS variable to a concrete color (for canvas drawing). */
      color(name) {
        const v = name.startsWith("--") ? name : "--viz-" + name;
        return getComputedStyle(frame).getPropertyValue(v).trim() || "#888";
      },
      /** setInterval that pauses off-screen and auto-clears. */
      every(ms, fn) {
        const t = setInterval(() => { if (alive && ctx.visible) fn(); }, ms);
        timers.push(() => clearInterval(t));
        return () => clearInterval(t);
      },
      /** setTimeout that auto-clears. */
      after(ms, fn) {
        const t = setTimeout(() => { if (alive) fn(); }, ms);
        timers.push(() => clearTimeout(t));
        return () => clearTimeout(t);
      },
      /** await ctx.sleep(ms). Resolves immediately when ctx.instant. Never resolves after unmount. */
      sleep(ms) {
        if (!alive) return new Promise(() => {});
        if (ctx.instant || ms <= 0) return Promise.resolve();
        return new Promise(resolve => {
          const rec = { resolve };
          rec.t = setTimeout(() => { pendingSleeps.delete(rec); if (alive) resolve(); }, ms / (ctx.speed || 1));
          pendingSleeps.add(rec);
        });
      },
      /** requestAnimationFrame loop: fn(dtSeconds, tSeconds). Paused off-screen. Returns stop(). */
      raf(fn) {
        let last = performance.now(), t = 0, handle, stopped = false;
        const loop = now => {
          if (stopped || !alive) return;
          const dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          if (ctx.visible) { t += dt; fn(dt, t); }
          handle = requestAnimationFrame(loop);
        };
        handle = requestAnimationFrame(loop);
        const stop = () => { stopped = true; cancelAnimationFrame(handle); };
        timers.push(stop);
        return stop;
      },
      /**
       * Generic tween. await ctx.tween({ms: 600, ease: "inOut", onUpdate: t => ...}).
       * Jumps to the end when ctx.instant (stepper replay, reduced motion).
       */
      tween({ ms = 500, ease: e = "inOut", onUpdate }) {
        if (!alive) return new Promise(() => {});
        const f = typeof e === "function" ? e : (ease[e] || ease.inOut);
        if (ctx.instant || ms <= 0) { onUpdate(1); return Promise.resolve(); }
        return new Promise(resolve => {
          const start = performance.now();
          const rec = { finish: () => { onUpdate(1); resolve(); } };
          pendingTweens.add(rec);
          // rAF drives the animation; a slow timer keeps it moving where rAF is
          // throttled or absent (background tabs, headless test runs).
          let lastTick = start, fallback = null;
          const step = () => {
            if (!alive || !pendingTweens.has(rec)) { clearTimeout(fallback); return; }
            const now = performance.now();
            lastTick = now;
            const k = Math.min(1, ((now - start) * (ctx.speed || 1)) / ms);
            onUpdate(f(k));
            if (k < 1) {
              requestAnimationFrame(step);
              clearTimeout(fallback);
              fallback = setTimeout(() => { if (performance.now() - lastTick > 40) step(); }, 50);
            } else { clearTimeout(fallback); pendingTweens.delete(rec); resolve(); }
          };
          requestAnimationFrame(step);
          fallback = setTimeout(() => { if (performance.now() - lastTick > 40) step(); }, 50);
        });
      },
      /** Tween numeric SVG/HTML attributes: ctx.animate(el, {cx: 200, opacity: 0}, 400) */
      animate(el, to, ms = 400, e = "inOut") {
        const from = {};
        for (const k in to) {
          const cur = el.getAttribute(k);
          from[k] = cur === null ? (k === "opacity" ? 1 : 0) : parseFloat(cur);
        }
        return ctx.tween({ ms, ease: e, onUpdate: t => {
          for (const k in to) el.setAttribute(k, lerp(from[k], to[k], t));
        }});
      },
      /**
       * Animate a "message" dot flying between two points inside an SVG <g>/<svg>.
       * await ctx.fly(layer, {from:[x,y], to:[x,y], ms, r, fill, label, lost: 0.5, keep})
       * lost: fraction along the path where the packet is dropped (fades out). Resolves to
       * true if delivered, false if lost.
       */
      fly(layer, o) {
        const r = o.r || 7;
        const g = s("g", { class: "viz-packet" });
        const c = s("circle", { r, fill: o.fill || "var(--viz-c2)", stroke: "var(--viz-bg)", "stroke-width": 1.5 });
        g.appendChild(c);
        let label = null;
        if (o.label !== undefined) {
          label = ctx.text(0, -r - 8, o.label, { size: o.labelSize || 11, weight: 600, fill: o.labelFill || "var(--viz-ink)", halo: true });
          g.appendChild(label);
        }
        layer.appendChild(g);
        if (o.onCreate) o.onCreate(g, c);
        const [x1, y1] = o.from, [x2, y2] = o.to;
        const stopAt = o.lost === undefined || o.lost === false ? 1 : o.lost;
        const place = k => g.setAttribute("transform", `translate(${lerp(x1, x2, k)},${lerp(y1, y2, k)})`);
        place(0);
        return ctx.tween({ ms: (o.ms || 700) * stopAt, ease: o.ease || "inOut", onUpdate: t => place(t * stopAt) })
          .then(async () => {
            if (stopAt < 1) {
              attr(c, { fill: "var(--viz-bad)" }); // var() colors live in style, so go through attr()
              if (label) label.textContent = "✕ lost";
              await ctx.tween({ ms: 400, onUpdate: t => g.setAttribute("opacity", 1 - t) });
              g.remove();
              return false;
            }
            if (!o.keep) g.remove();
            return true;
          });
      },
      /**
       * Last-resort for diagrams that cannot reflow: keep a minimum drawing width and let the
       * diagram scroll sideways inside the frame on phones. Prefer a compact layout instead.
       * root.append(ctx.scroll(svg, 560))
       */
      scroll(el, minWidth = 560) {
        el.style.minWidth = minWidth + "px";
        const wrap = h("div", { class: "viz-scroll" }, el);
        const hint = h("div", { class: "viz-scroll-hint" }, "← scroll →");
        return h("div", null, wrap, hint);
      },
      /** Scenario player with play/pause/step/back/reset. See docs/AUTHORING.md. */
      stepper(opts) { return makeStepper(ctx, opts); },
    };

    function flushAnimations() {
      for (const rec of pendingSleeps) { clearTimeout(rec.t); rec.resolve(); }
      pendingSleeps.clear();
      for (const rec of Array.from(pendingTweens)) { pendingTweens.delete(rec); rec.finish(); }
    }

    ctx.ui = makeUI(ctx);
    const kit = makeSvgKit(ctx);
    ctx.svg = kit.svg;
    ctx.text = kit.text;
    ctx.box = kit.box;
    ctx.node = kit.node;
    ctx.arrow = kit.arrow;
    ctx.lanes = kit.lanes;

    // Visibility: pause timers/animation loops when the frame is off-screen.
    let io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(entries => { visible = entries[entries.length - 1].isIntersecting; });
      io.observe(frame);
    }
    let ro = null, lastW = 0;
    if ("ResizeObserver" in window) {
      // Callbacks run on the next frame, outside the observer, so a callback may rebuild the
      // whole layout without triggering "ResizeObserver loop" errors.
      let pending = 0;
      ro = new ResizeObserver(() => {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = 0;
          if (!alive) return;
          const w = ctx.width();
          if (Math.abs(w - lastW) < 2) return;
          lastW = w;
          resizeFns.forEach(fn => { try { fn(w); } catch (e) { reportError(id, e); } });
        });
      });
      ro.observe(body);
    }

    const inst = {
      id, frame, ctx,
      themeChanged() { themeFns.forEach(fn => { try { fn(ctx.theme()); } catch (e) { reportError(id, e); } }); },
      destroy() {
        if (!alive) return;
        alive = false;
        flushAnimations();
        timers.forEach(t => t());
        if (io) io.disconnect();
        if (ro) ro.disconnect();
        cleanups.forEach(fn => { try { fn(); } catch (e) { reportError(id, e); } });
        if (inst.api && typeof inst.api.destroy === "function") {
          try { inst.api.destroy(); } catch (e) { reportError(id, e); }
        }
        instances.delete(inst);
        body.innerHTML = "";
      },
    };

    body.innerHTML = "";
    body.classList.remove("is-loading");
    try {
      lastW = ctx.width();
      inst.api = def.mount(body, ctx) || null;
    } catch (e) {
      reportError(id, e);
      body.innerHTML = "";
      body.appendChild(h("div", { class: "viz-error" }, "This visualization failed to load: " + (e && e.message)));
    }
    instances.add(inst);
    frame._vizInstance = inst;
    return inst;
  }

  // ------------------------------------------------------------------
  // Stepper: scripted scenario player
  // ------------------------------------------------------------------
  /**
   * ctx.stepper({
   *   steps: [{ title: "Client sends write", run: async (state, ctx) => {...} }, ...],
   *   init: () => state,        // (re)build the scene; called on reset and before replays
   *   delay: 1200,              // pause between steps while playing
   *   autoplay: false,
   *   loop: false,
   *   onStep: (i, step) => {},  // after each step completes (i is 0-based, -1 after reset)
   * }) -> { el, reset(), next(), back(), play(), pause(), goto(i), get index() }
   *
   * Step functions use ctx.sleep / ctx.tween / ctx.fly for animation. "Back" resets and
   * replays the previous steps instantly (ctx.instant = true), so steps must be
   * deterministic given the state returned by init().
   */
  function makeStepper(ctx, o) {
    const steps = o.steps || [];
    let state = null, index = -1, playing = false, token = 0;
    let current = null; // promise of the step currently running
    const ui = ctx.ui;

    const caption = h("div", { class: "viz-step-caption", "aria-live": "polite" });
    const counter = h("span", { class: "viz-step-counter" });
    const bReset = ui.button("⟲", () => reset(), { title: "Reset", kind: "ghost" });
    const bBack = ui.button("◀", () => back(), { title: "Previous step", kind: "ghost" });
    const bPlay = ui.button("▶ Play", () => (playing ? pause() : play()), { title: "Play / pause", kind: "primary" });
    const bNext = ui.button("Step ▶", () => { if (playing) pause(); next(); }, { title: "Next step" });
    const el = h("div", { class: "viz-stepper" },
      h("div", { class: "viz-step-controls" }, bReset, bBack, bPlay, bNext, counter),
      caption);

    function render() {
      counter.textContent = `${Math.max(0, index + 1)} / ${steps.length}`;
      const st = steps[index];
      caption.innerHTML = index < 0
        ? (o.intro || "Press <b>Play</b> or <b>Step ▶</b> to walk through the scenario.")
        : `<span class="viz-step-num">${index + 1}</span><span class="viz-step-title">${st.title || ""}</span>${st.detail ? `<div class="viz-step-detail">${st.detail}</div>` : ""}`;
      bBack.disabled = index < 0;
      bNext.disabled = index >= steps.length - 1;
      bPlay.setLabel(playing ? "❚❚ Pause" : index >= steps.length - 1 ? "⟲ Replay" : "▶ Play");
    }

    function runStep(i) {
      current = Promise.resolve()
        .then(() => steps[i].run(state, ctx))
        .catch(e => reportError(ctx.id, e));
      return current;
    }

    async function next() {
      if (!ctx.alive) return;
      if (current) { ctx.instant = true; return; } // second click fast-forwards the running step
      if (index >= steps.length - 1) return;
      const my = token;
      index++;
      render();
      await runStep(index);
      current = null;
      if (my !== token) return; // a reset/back superseded this step
      ctx.instant = false;
      if (o.onStep) o.onStep(index, steps[index]);
      render();
    }

    async function replayTo(target) {
      const my = ++token;
      ctx.instant = true;
      if (current) { await current; current = null; } // let an in-flight step finish instantly
      if (my !== token) return;
      state = o.init ? o.init(state) : {};
      index = -1;
      for (let i = 0; i <= target; i++) {
        index = i;
        await runStep(i);
        current = null;
        if (my !== token) return;
      }
      ctx.instant = false;
      if (o.onStep) o.onStep(index, steps[index]);
      render();
    }

    function back() { if (index >= 0) { pause(); return replayTo(index - 1); } }
    function goto(i) { pause(); return replayTo(Math.max(-1, Math.min(steps.length - 1, i))); }
    function reset() { pause(); return replayTo(-1); }

    async function play() {
      if (playing) return;
      if (index >= steps.length - 1) await replayTo(-1);
      playing = true;
      render();
      const my = ++token;
      while (playing && my === token && ctx.alive && index < steps.length - 1) {
        // Hold while scrolled away so the viewer doesn't miss the scenario.
        while (ctx.alive && !ctx.visible && playing) await new Promise(r => setTimeout(r, 250));
        await next();
        if (!playing || my !== token) break;
        if (index < steps.length - 1) await ctx.sleep(o.delay || 1100);
      }
      if (my === token) {
        playing = false;
        render();
        if (o.loop && ctx.alive) { await ctx.sleep(1800); if (ctx.alive && my === token) play(); }
      }
    }
    function pause() { playing = false; render(); }

    state = o.init ? o.init(null) : {};
    render();
    if (o.autoplay) ctx.after(500, play);
    ctx.onCleanup(() => { playing = false; token++; });

    return {
      el, next, back, play, pause, reset, goto,
      get index() { return index; },
      get state() { return state; },
      get playing() { return playing; },
    };
  }

  // ------------------------------------------------------------------
  // Loading & mounting
  // ------------------------------------------------------------------
  const Viz = {
    base: "viz/",
    cacheBust: (document.currentScript && (document.currentScript.src.match(/[?&]v=([^&]+)/) || [])[1]) || "",
    h, s, attr, ease, random,

    register(id, def) {
      if (!def || typeof def.mount !== "function") throw new Error("Viz.register(" + id + "): def.mount is required");
      registry[id] = def;
      (waiters[id] || []).forEach(fn => fn(def));
      delete waiters[id];
    },

    get(id) { return registry[id]; },

    load(id) {
      if (registry[id]) return Promise.resolve(registry[id]);
      if (loading[id]) return loading[id];
      loading[id] = new Promise((resolve, reject) => {
        (waiters[id] = waiters[id] || []).push(resolve);
        const sc = document.createElement("script");
        sc.src = Viz.base + id + ".js" + (Viz.cacheBust ? "?v=" + Viz.cacheBust : "");
        sc.async = true;
        sc.onload = () => {
          if (!registry[id]) {
            delete loading[id];
            reject(new Error(`viz/${id}.js loaded but did not call Viz.register("${id}", ...)`));
          }
        };
        sc.onerror = () => { delete loading[id]; reject(new Error(`Could not load viz/${id}.js`)); };
        document.head.appendChild(sc);
      });
      return loading[id];
    },

    /** Mount a single frame now (loads the script if needed). */
    mount(frame) {
      const id = frame.dataset.viz;
      if (!id || frame._vizInstance || frame._vizPending) return;
      frame._vizPending = true;
      const body = frame.querySelector(".viz-body") || frame;
      body.classList.add("is-loading");
      return Viz.load(id).then(def => {
        frame._vizPending = false;
        if (!frame.isConnected) return;
        const t = frame.querySelector(".viz-title");
        if (t && !t.textContent.trim() && def.title) t.textContent = def.title;
        return createInstance(frame, id, def);
      }).catch(err => {
        frame._vizPending = false;
        reportError(id, err);
        body.classList.remove("is-loading");
        body.innerHTML = "";
        body.appendChild(h("div", { class: "viz-error" }, "Visualization unavailable: " + err.message));
      });
    },

    /** Lazily mount every [data-viz] frame inside root as it nears the viewport. */
    mountAll(root, { eager = false } = {}) {
      const frames = Array.from((root || document).querySelectorAll("figure.viz[data-viz]"));
      if (eager || !("IntersectionObserver" in window)) { frames.forEach(f => Viz.mount(f)); return; }
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) { io.unobserve(e.target); Viz.mount(e.target); }
        });
      }, { rootMargin: "600px 0px" });
      frames.forEach(f => io.observe(f));
      (root || document)._vizObserver = io;
    },

    /** Destroy every mounted instance inside root (call before replacing its HTML). */
    unmountAll(root) {
      if (root && root._vizObserver) { root._vizObserver.disconnect(); root._vizObserver = null; }
      for (const inst of Array.from(instances)) {
        if (!root || root.contains(inst.frame)) inst.destroy();
      }
    },

    /** Re-mount a frame from scratch (used by the frame's reset button). */
    remount(frame) {
      if (frame._vizInstance) { frame._vizInstance.destroy(); frame._vizInstance = null; }
      return Viz.mount(frame);
    },

    themeChanged() { instances.forEach(i => i.themeChanged()); },

    /** HTML for a frame; the app and the test harness both use this. */
    frameHTML({ id, title = "", caption = "", standalone = false }) {
      const esc = x => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      return `<figure class="viz${standalone ? " viz--standalone" : ""}" data-viz="${esc(id)}">
  <div class="viz-head">
    <span class="viz-chip">Interactive</span>
    <div class="viz-title">${title}</div>
    <div class="viz-actions">
      <button type="button" class="viz-icon-btn" data-viz-action="reset" title="Reset visualization" aria-label="Reset visualization">⟲</button>
      <button type="button" class="viz-icon-btn" data-viz-action="expand" title="Expand" aria-label="Expand visualization">⤢</button>
    </div>
  </div>
  <div class="viz-body is-loading"><div class="viz-skeleton"></div></div>
  ${caption ? `<figcaption class="viz-caption">${caption}</figcaption>` : ""}
</figure>`;
    },
  };

  // Frame-level buttons (reset / expand) via delegation.
  document.addEventListener("click", e => {
    const btn = e.target.closest && e.target.closest("[data-viz-action]");
    if (!btn) return;
    const frame = btn.closest("figure.viz");
    if (!frame) return;
    if (btn.dataset.vizAction === "reset") Viz.remount(frame);
    if (btn.dataset.vizAction === "expand") toggleExpand(frame);
  });
  function toggleExpand(frame) {
    const on = !frame.classList.contains("viz--expanded");
    frame.classList.toggle("viz--expanded", on);
    document.body.classList.toggle("viz-expanded-open", on);
    const b = frame.querySelector('[data-viz-action="expand"]');
    if (b) { b.textContent = on ? "✕" : "⤢"; b.title = on ? "Close" : "Expand"; }
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const open = document.querySelector("figure.viz.viz--expanded");
    if (open) { toggleExpand(open); e.stopPropagation(); }
  }, true);

  window.Viz = Viz;
})();
