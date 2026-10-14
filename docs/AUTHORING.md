# Authoring guide

This site is a static, dependency-free companion to *Designing Data-Intensive Applications*.
No build step: plain HTML/CSS/JS, opened via any static server (`python3 scripts/serve.py`).

```
index.html            shell; loads everything below
styles.css            design system (tokens, deep-dive blocks, viz UI kit)
app.js                router, renderers, progress, search
core/registry.js      DDIA.registerChapter / DDIA.registerDeepDive
core/legacy.js        frozen map for migrating old saved progress (never edit)
chapters/chN.js       study material: overview, concepts, cheatsheet, interview Q&A
chapters/chN.deep.js  the long-form Deep Dive (sections made of blocks), first half + hook
chapters/chN.deep2.js second half of the Deep Dive sections + takeaways/connections/reading
viz/core.js           visualization toolkit (Viz.register, ctx helpers, stepper)
viz/chN/<name>.js     one interactive visualization per file, lazy-loaded
test/viz.html         harness that mounts one viz (used by scripts/check-viz.sh)
core/manifest.js      GENERATED index of the deep dives (node scripts/build-manifest.js)
scripts/validate.js   content validator        → node scripts/validate.js ch5
scripts/check-viz.sh  headless viz smoke test  → scripts/check-viz.sh ch5/quorum
scripts/check-site.sh whole-site smoke test    → scripts/check-site.sh
```

Routes: `#/ch5` (chapter, Deep Dive tab), `#/ch5/learn/<section-id>`, `#/ch5/concepts/<concept-id>`,
`#/ch5/interview/<qid>`, `#/viz` (gallery), `#/viz/ch5/quorum` (one viz full-page), `#/glossary`, `#/cheatsheet`.

---

## 1. The teaching model

Every idea is taught in the same order, because that is how understanding sticks:

1. **The problem**: what broke, or what was impossible, before this idea existed? Make the reader *feel* the pain with a concrete scenario (a user, a number, an outage).
2. **The key idea**: the one-sentence insight that solves it.
3. **How it works**: mechanism, step by step, with precise vocabulary.
4. **See it**: an interactive visualization (or a static diagram) where the reader can *cause* the interesting behaviour, including the failure modes.
5. **In the real world**: named systems and companies that use it, and well-documented incidents where it mattered.
6. **Trade-offs**: what you pay; when not to use it; what the alternatives are.
7. **Interview angle**: how this shows up in a system-design interview and what a strong answer sounds like.
8. **Check yourself**: one quiz question that tests understanding, not recall.

Not every section needs all eight, but every section needs 1–3 and at least one of 4–6.

### Voice and accuracy rules

- Write original explanations. **Never copy sentences from the book.** Quotations, if any, ≤ 15 words with attribution. Numbers and facts from the book (e.g. Twitter's 4.6k vs 300k req/s) are fine.
- Be concrete: real numbers, real systems, real failure stories. Prefer "Cassandra lets you pick W and R per query" over "some systems allow tuning".
- **No fabrication.** Only cite incidents, numbers, dates and product behaviour you are confident are true and publicly documented (postmortems, papers, official docs). If unsure of a detail, describe it at the level you are sure of, or leave it out. Never invent quotes, figures or outages.
- Teach the *why*: what constraint forces this design? What would go wrong with the naive approach?
- Prefer short paragraphs (2–4 sentences). Use `<strong>` for the 1–2 terms that matter in a paragraph.
- When something changed since the book (2017), say so in a `callout` with `tone: "modern"`, e.g. Kafka removing ZooKeeper (KRaft), S3 becoming strongly consistent (2020), Raft becoming the default consensus algorithm. Don't make claims about the book's 2nd edition contents.
- American English, sentence-case headings, no emoji in prose (icons come from the block styles).

---

## 2. Study material: `chapters/chN.js`

```js
// Chapter 5: Replication
DDIA.registerChapter({
  id: "ch5", part: 2, number: 5,
  title: "Replication",
  tagline: "Keeping copies of the same data on several machines, and everything that goes wrong when they disagree.",
  overview: `<p>…</p>`,
  concepts: [
    {
      id: "single-leader-replication",          // stable slug; NEVER rename existing ids
      term: "Single-leader replication",
      def: "One-sentence-to-short-paragraph definition (HTML allowed).",
      problem: "Why it was needed in the first place (what broke without it).",   // new field
      why: "Why it matters / the key trade-off.",
      ex: "Concrete real-world example.",
      section: "leaders-and-followers",          // optional: deep-dive section id
    },
  ],
  cheatsheet: [
    { title: "…", type: "table", headers: ["", "A", "B"], rows: [["row", "…", "…"]], note: "optional" },
    { title: "…", type: "list", items: ["…"] },
    { title: "…", type: "note", body: "<p>…</p>" },
  ],
  interview: [
    {
      id: "q01",                                  // existing ids q01..qNN must stay
      q: "Question?", diff: "easy" | "medium" | "hard",
      a: `<p>Model answer…</p>`,
      followups: ["Likely follow-up question?"],  // optional
      pitfalls: ["Thing a weak candidate says"],  // optional
      section: "leaders-and-followers",           // optional deep-dive link
    },
  ],
});
```

**Progress compatibility:** saved progress is keyed by concept `id` and question `id`.
`core/legacy.js` lists the ids that existed before; every one of them must still exist
(the validator enforces this). You may improve their text, reorder them, and add new
entries with new ids (new question ids: descriptive slugs like `q-quorum-math`).

## 3. Deep dive: `chapters/chN.deep.js`

```js
// Chapter 5 deep dive. Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch5", {
  hook: `<p>A short, vivid opening scenario that makes the chapter's core problem felt.</p>`,
  sections: [
    {
      id: "why-replicate",                 // lowercase slug, unique within the chapter
      title: "Why keep copies at all?",
      kicker: "Motivation",                // optional small label above the title
      concepts: ["why-replicate"],         // concept ids covered (shown as chips)
      blocks: [ /* see block reference */ ],
    },
  ],
  takeaways: ["…", "…"],                               // 5–8 crisp lessons (HTML)
  connections: [{ to: "ch9", html: "How this links to consensus…" }],
  furtherReading: [{ title: "Dynamo paper (2007)", url: "https://…", note: "why read it" }],
});
```

A deep dive may be split across `chN.deep.js` and `chN.deep2.js`: each file calls
`DDIA.registerDeepDive("chN", {...})`; sections are appended in load order and the first
non-empty `hook` / `takeaways` / `connections` / `furtherReading` wins.

Use template literals (backticks) for long HTML. Only link URLs you are certain exist
(canonical paper pages, official docs); otherwise omit `url`.

### Block reference

| type | fields | renders as |
|---|---|---|
| `text` | `html` | prose (p, ul, ol, h3, h4, code, strong, em, a, sup) |
| `problem` | `html`, `title?` | orange "The problem" callout. Use at the top of a section |
| `idea` | `html`, `title?` | violet "The key idea" callout |
| `analogy` | `html`, `title?` | cyan analogy callout |
| `callout` | `tone`, `html`, `title?` | tone ∈ `insight` `warning` `interview` `history` `modern` `tip` `mistake` |
| `viz` | `id`, `title`, `caption` | interactive visualization frame (`id` = `chN/name`, file `viz/chN/name.js`) |
| `diagram` | `svg` (string), `title?`, `caption?` | static inline SVG figure (see §5 for colors) |
| `realworld` | `items: [{org, title?, year?, tag?, html}]`, `title?` | grid of real-world cards |
| `tradeoffs` | `pros[]`, `cons[]`, `prosLabel?`, `consLabel?`, `title?` | two columns |
| `compare` | `items: [{title, html, tone?}]`, `title?` | 2–4 side-by-side cards; tone ∈ ok bad warn info |
| `table` | `headers[]`, `rows[][]`, `title?`, `note?` | table (becomes cards on phones) |
| `code` | `code`, `lang?`, `title?`, `caption?` | code block (plain text, escaped for you) |
| `steps` | `items[]`, `title?` | numbered step cards (algorithms, protocols) |
| `list` | `items[]`, `ordered?`, `title?` | plain list |
| `keypoints` | `items[]`, `title?` | "Key points" box |
| `timeline` | `items: [{year, html}]`, `title?` | history timeline |
| `quiz` | `q`, `options[]`, `answer` (index), `explain` | self-check with instant feedback |

Handy inline classes inside HTML: `<span class="hl">`, `hl-good`, `hl-bad`, `hl-warn`
(highlights), `<code>`, `<span class="mono">`, `<span class="formula">` (block formula),
`<span class="tag">`.

A good section is roughly: `problem` → 2–4 `text` blocks interleaved with a `viz` or
`diagram` → `realworld` → `tradeoffs`/`compare` → `callout(interview)` → `quiz`.
Target 400–900 words of prose per section and 6–10 sections per chapter.

---

## 4. Visualizations: `viz/chN/<name>.js`

One file per visualization. It must call `Viz.register` with exactly the id `chN/<name>`:

```js
Viz.register("ch5/quorum", {
  title: "Quorum reads and writes",
  mount(root, ctx) {
    // Build DOM/SVG inside `root`. Use ctx for EVERYTHING timed (timers, animation),
    // so it pauses off-screen and is cleaned up on unmount/reset.
  },
});
```

### What makes a great visualization

- **It teaches one idea**, and the reader can *cause* the interesting behaviour: kill a node,
  partition the network, skew a clock, add a hot key, change W and R, inject a concurrent write.
- **The first frame is already meaningful**: it shows a populated, labelled scene, never a blank canvas.
- **It explains itself as you use it**: a `ui.note` (or stepper caption) that says, in one or two
  sentences, *what just happened and why*, updated after every interaction. Show failure states
  in red (`--viz-bad`) and success in green (`--viz-ok`).
- **It shows the failure mode**, not just the happy path: stale reads, lost updates, split brain,
  data loss on failover. That's where the insight is.
- **Two shapes work well:**
  - *Scenario* (`ctx.stepper`): a scripted, step-by-step story with Play / Step / Back / Reset
    (for protocols: 2PC, Raft election, replication lag anomalies).
  - *Sandbox* (`ui.slider`, `ui.button`, `ui.segmented`): free play with live metrics
    (for quantitative ideas: quorums, partitioning skew, percentiles, LSM compaction).
  - Many great vizzes combine both: presets that set up a scenario, then free play.
- Labels on everything; a legend if colors carry meaning; numbers as `ui.stats`.
- Keep it under ~400 lines. No external libraries, no network, no `localStorage`.

### ctx reference

```js
ctx.h(tag, props, ...children)      // HTML element. props: class, style, on:{click}, onClick, html, text, dataset
ctx.s(tag, attrs, ...children)      // SVG element; attrs containing "var(--…)" are applied as styles
ctx.attr(el, attrs)                  // set attributes (SVG aware); null removes an attribute
ctx.svg({w, h, label})              // responsive <svg viewBox="0 0 w h"> with .arrow(color) marker helper
ctx.text(x, y, str, {size, anchor, weight, fill, mono, baseline, halo})   // halo: readable on top of lines
ctx.box({x, y, w, h, label, sub, fill, stroke, rx, dashed, mono})   // <g> with .rect .label .sub
ctx.node({x, y, r, label, sub, fill, stroke})                        // <g> with .circle .label .sub
ctx.arrow({x1, y1, x2, y2, color, dashed, curve, width, svg})       // path; pass svg for arrowhead
ctx.lanes({parent: svg, x, y, w, h, t0, t1, lanes: [{id, label, color: "c1"}], labelWidth})
   // swimlane timeline (time → right, one lane per actor). Returns
   // .op(lane, tA, tB, {label, tone|color, dashed}) bar · .msg(fromLane, tA, toLane, tB, {label, color, dashed, lost})
   // .mark(lane, t, {label, tone, below}) · .cursor(t, {label}) · .clear() · .x(t) .y(lane)
   // Use it for replication lag, transaction interleavings, clocks, 2PC, linearizability histories.
   // Reference: viz/_demo/lanes.js

ctx.ui.bar(...els)                  // wrapping row of controls
ctx.ui.row(...els)                  // responsive columns (panels side by side, stacks on phones)
ctx.ui.button(html, onClick, {kind: "primary"|"ghost"|"danger"|"ok", title}) → .disable(bool) .setLabel(html) .setActive(bool)
ctx.ui.slider({label, min, max, step, value, format, onInput}) → .get() .set(v) .disable(bool)
ctx.ui.toggle({label, value, onChange}) → .get() .set(v) .disable(bool)
ctx.ui.select({label, options, value, onChange}) → .get() .set(v) .disable(bool)
ctx.ui.segmented({label, options: [{value, label}], value, onChange}) → .get() .set(v) .disable(bool[, value])
ctx.ui.stats([{key, label, value, tone}]) → .set(key, value, tone)   // tone: ok|bad|warn|info|""
ctx.ui.log({title, height}) → .add(html, tone) .clear()
ctx.ui.note(html, tone) → .set(html, tone)                           // the explanation line
ctx.ui.legend([{color, label, shape: "dot"|"square"|"line"|"dash"}])
ctx.ui.panel(title, ...els)
ctx.ui.badge(text, tone)

ctx.every(ms, fn)        // interval; paused off-screen; auto-cleared
ctx.after(ms, fn)        // timeout; auto-cleared
await ctx.sleep(ms)      // honours ctx.instant (instant during stepper replay/fast-forward)
ctx.raf((dt, t) => …)    // animation loop; paused off-screen; returns stop()
await ctx.tween({ms, ease, onUpdate: k => …})   // ease: linear|inOut|out|in|back
await ctx.animate(el, {cx: 100, opacity: 0}, ms)
await ctx.fly(layer, {from: [x,y], to: [x,y], label, fill, ms, lost: 0.5, onCreate: g => …}) // message packet; lost → dropped midway, resolves false
ctx.random(seed)         // deterministic PRNG: r(), r.int(a,b), r.pick(arr), r.chance(p), r.normal(), r.exp(mean)
ctx.stepper({...})       // scenario player (below)
ctx.compact              // true when the frame is narrower than 560px → use the phone layout
ctx.width()              // current frame width in px
ctx.onResize(fn)         // called (on the next frame) when the width changes; safe to rebuild inside
ctx.scroll(el, minWidth) // last resort: horizontal scroll wrapper for a diagram that can't reflow
ctx.onCleanup(fn)        // run on unmount
ctx.alive                // false after unmount; check after awaits in long async loops
ctx.color("c1")          // resolved CSS color string (only needed for <canvas>)
ctx.onTheme(fn)          // theme switched (only needed for <canvas>)
```

### Stepper (scenario player)

```js
const player = ctx.stepper({
  init(prevState) {          // must FULLY rebuild the scene; Back = init() + instant replay
    layer.innerHTML = "";
    return { leader: drawNode(...), log: [] };
  },
  steps: [
    { title: "Client writes <b>x=1</b>", detail: "optional second line",
      run: async (st, ctx) => { await ctx.fly(packets, {...}); st.leader.value.textContent = "x=1"; } },
    // …
  ],
  delay: 1100,               // pause between steps while playing
  intro: "Press Play to …",  // caption before step 1
  onStep: (i, step) => {},   // after each step (i = -1 after reset)
});
root.append(svg, player.el);
```

Steps must be deterministic given `init()`'s state (use `ctx.random(seed)` created inside
`init`, not `Math.random`). Use `ctx.sleep/tween/fly` for every pause so Back/fast-forward work.
Reference example: `viz/_demo/stepper.js`. Sandbox example: `viz/ch1/tail-latency.js`.

### Layout, color and legibility rules (the checker enforces some of these)

- **Phones are first-class.** Frames are ~330–360px wide on phones and 600–860px on desktop.
  Build two layouts: `const W = ctx.compact ? 360 : 640;` and position things for each.
  For complex scenes rebuild on breakpoint changes:
  `ctx.onResize(() => { if (ctx.compact !== wasCompact) build(); })` (see `ch1/tail-latency`).
- **SVG text must render ≥ 10px on a phone.** With a 360-wide viewBox use font sizes ≥ 11;
  with a 640-wide viewBox use ≥ 12. `check-viz.sh` fails anything under 9px.
- **No horizontal overflow** at 358px. Controls wrap automatically inside `ui.bar`.
- **Colors only via CSS variables** so both themes work:
  `--viz-c1 … --viz-c8` (violet, cyan, amber, green, pink, blue, orange, lime), each with a
  `-soft` translucent fill (`--viz-c3-soft`); semantic `--viz-ok --viz-bad --viz-warn --viz-info`
  (+ `-soft`); neutrals `--viz-ink` (text), `--viz-muted`, `--viz-line`, `--viz-grid`,
  `--viz-node`, `--viz-node-stroke`, `--viz-bg`, `--viz-panel`. Never hard-code hex colors.
  Typical node: `fill: "var(--viz-c2-soft)", stroke: "var(--viz-c2)"`; text on soft fills: `--viz-ink`.
- Consistent semantics across the book: **leader/primary = c1 (violet)**, **followers/replicas = c2 (cyan)**,
  **clients = c6 (blue)**, **ok/committed = ok (green)**, **failure/stale/conflict = bad (red)**,
  **in-flight/pending = warn (amber)**.
- Animations: 300–900ms; respect `ctx.instant`. Don't loop forever unless the user pressed Play.
- Determinism: initial state must be identical on every load (seeded `ctx.random`).

### Static diagrams (`diagram` blocks)

Inline SVG strings with a `viewBox` and no fixed width. Text inherits the theme's ink color
by default (don't hard-code black or white). Use the same CSS variables via
`style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"` and `font-size` ≥ 12 in a
viewBox ≤ 640 wide (≥ 11 if ≤ 400 wide). Keep them simple; anything with state belongs in a viz.

---

## 5. Testing checklist

Deep dives are lazy-loaded; `core/manifest.js` (sections, viz list, reading time) lets the
app work before they arrive. **After editing any `chapters/chN.deep*.js`, regenerate it:**

```bash
node scripts/build-manifest.js                  # regenerate core/manifest.js after deep-dive edits
node scripts/validate.js ch5                    # schema, ids, cross-refs, balanced HTML, viz files exist, manifest fresh
scripts/check-viz.sh ch5/quorum --steps 3       # monkey-clicks every control; phone legibility; screenshots
scripts/check-site.sh                           # renders every page/tab + mounts every viz
scripts/check-all-viz.sh ch5                    # check-viz for every viz in a chapter (or all)
scripts/shoot.sh ch5 [--phone] [--only <section>]  # the deep dive as a reader sees it, as image tiles
python3 scripts/serve.py                        # then open http://127.0.0.1:8765/#/ch5
```

Static `diagram` blocks aren't covered by any automated check: look at them with `shoot.sh`
(desktop and `--phone`). On phones, diagrams wider than 420 viewBox units keep ~88% of their
width and scroll sideways; for important diagrams consider a narrow phone-specific version.

`check-viz.sh` prints screenshot paths: **look at them** (desktop dark, phone light, and
after N steps). A viz is done when it passes and the screenshots look clear, uncluttered
and correct in both themes.

---

## 6. Looks (skins)

`styles.css` is the base design system (the *Classic* look). Every other look is one file,
`skins/<name>.css`, loaded after it by a small script in `index.html`'s `<head>` (before first
paint) and switchable live from the **Look** menu (`SKINS` in `app.js`). The default look is
`editorial` (`DEFAULT_SKIN` in `app.js` and the loader in `index.html`; keep them in sync).

Rules for a skin:

- Scope every rule under `:root[data-skin="<name>"]`; light mode is `:root[data-skin="<name>"] body.light`.
- Override the tokens first: surface/text/accent colors, every `--viz-*` color and its `-soft`
  variant (visualizations only use these, so they re-skin automatically), `--font-sans`,
  `--font-display`, `--font-reading`, `--font-mono`, `--round` (0 = square corners, 1 = default),
  `--shadow`, `--accent-grad-end`. Then restyle components as needed.
- Keep the visualization color *meanings* (leader / follower / client / ok / bad / pending)
  distinguishable, and body text contrast ≥ 4.5:1 in both themes.
- Google Fonts may be `@import`ed (with system fallbacks); nothing else external.
- Check it: `scripts/shoot.sh '#/' --skin <name> [--theme light] [--phone]`,
  `scripts/shoot.sh ch5 --only leaderless-quorums --skin <name>`, and
  `SKIN=<name> scripts/check-all-viz.sh`. `check-viz.sh` defaults to the site's default look;
  pass `--skin classic` to test the base stylesheet.

