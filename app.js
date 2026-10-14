// DDIA Interactive Notes - App logic
// Depends on: core/registry.js (DDIA), chapters/*.js, viz/core.js (Viz), core/legacy.js

// ============================================================
// STATE & STORAGE
// ============================================================
const STORAGE_KEY = "ddia_notes_progress_v2";
const LEGACY_STORAGE_KEY = "ddia_notes_progress_v1";
const MOBILE_BREAKPOINT = 900; // below this the sidebar becomes a drawer (matches styles.css)

const PART_NAMES = {
  1: "Part I · Foundations of Data Systems",
  2: "Part II · Distributed Data",
  3: "Part III · Derived Data",
};
const PART_SHORT = { 1: "Foundations", 2: "Distributed Data", 3: "Derived Data" };
const ROMAN = ["", "I", "II", "III"];

const TABS = [
  { id: "learn", label: "Deep Dive", short: "Deep dive" },
  { id: "concepts", label: "Concepts", short: "Concepts" },
  { id: "cheatsheet", label: "Cheatsheet", short: "Cheatsheet" },
  { id: "interview", label: "Interview Q&amp;A", short: "Q&amp;A" },
  { id: "flashcards", label: "Flashcards", short: "Cards" },
];

// Per-viewer view preferences (compact concepts, quiz round size…). Kept apart from the progress
// key so the ddia_notes_progress_v2 format stays exactly as it was.
const UI_KEY = "ddia_notes_ui_v1";
let ui = {};
function loadUi() { try { ui = JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {}; } catch (e) { ui = {}; } }
function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} }

let state = {
  route: { view: "dashboard" },
  flashIndex: 0,
  flashFlipped: false,
  flashOrder: null, // shuffled card order for the current deck (null = book order)
  theme: null,
  last: null, // last chapter route, for "continue reading"
  progress: {}, // chapterId => { concepts: {id: true}, qa: {id: true}, sections: {id: true} }
};

function chapters() { return DDIA.chapters; }
function getChapter(id) { return DDIA.chapter(id); }
// Screenshot mode (scripts/shoot.sh): static layout, every viz mounted, scroll offset via ?y=.
const SHOOT_MODE = /[?&](only|shoot)=/.test(location.search);

// Deep dives are lazy-loaded (DDIA.loadDeep). Until then, core/manifest.js supplies section ids,
// titles and the viz list, so navigation, progress and the Visualization lab work immediately.
const MANIFEST = window.DDIA_MANIFEST || {};
function hasDeepContent(ch) { return !!(ch.deepDive && ch.deepDive.sections && ch.deepDive.sections.length); }
function sectionsOf(ch) {
  if (hasDeepContent(ch)) return ch.deepDive.sections;
  return (MANIFEST[ch.id] && MANIFEST[ch.id].sections) || [];
}

function emptyProgress() { return { concepts: {}, qa: {}, sections: {} }; }

/** Convert a v1 (index-keyed) progress object into v2 (id-keyed). */
function migrateV1Progress(v1) {
  const legacy = window.DDIA_LEGACY_V1 || {};
  const out = {};
  Object.keys(v1 || {}).forEach(chId => {
    const old = v1[chId] || {};
    const map = legacy[chId] || { c: [], q: [] };
    const p = emptyProgress();
    Object.keys(old.conceptsLearned || {}).forEach(i => {
      if (old.conceptsLearned[i] && map.c[+i]) p.concepts[map.c[+i]] = true;
    });
    Object.keys(old.qaReviewed || {}).forEach(i => {
      if (old.qaReviewed[i] && map.q[+i]) p.qa[map.q[+i]] = true;
    });
    out[chId] = p;
  });
  return out;
}

/** Accepts v2 progress or v1 progress (detected by its keys) and returns v2. */
function normalizeProgress(progress) {
  const looksV1 = Object.values(progress || {}).some(p => p && (p.conceptsLearned || p.qaReviewed));
  if (looksV1) return migrateV1Progress(progress);
  const out = {};
  Object.keys(progress || {}).forEach(chId => {
    const p = progress[chId] || {};
    out[chId] = { concepts: p.concepts || {}, qa: p.qa || {}, sections: p.sections || {} };
  });
  return out;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) {
      state.progress = normalizeProgress(saved.progress);
      state.theme = saved.theme || null;
      state.last = saved.last || null;
      state.quiz = saved.quiz || null;
    } else {
      const v1 = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
      if (v1) {
        state.progress = migrateV1Progress(v1.progress);
        state.theme = v1.theme || null;
        saveState(); // v1 key is left untouched as a backup
      }
    }
  } catch (e) { console.warn("Could not load state", e); }
  applyTheme();
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2, progress: state.progress, theme: state.theme, last: state.last, quiz: state.quiz,
    }));
  } catch (e) {}
}
function getChapterProgress(chId) {
  if (!state.progress[chId]) state.progress[chId] = emptyProgress();
  return state.progress[chId];
}

function currentTheme() {
  const forced = (location.search.match(/[?&]theme=(light|dark)/) || [])[1]; // test/screenshot override
  if (forced) return forced;
  if (state.theme) return state.theme;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme() {
  const t = currentTheme();
  document.body.classList.toggle("light", t === "light");
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.textContent = t === "light" ? "☾ Dark" : "☀ Light";
    btn.setAttribute("aria-label", t === "light" ? "Switch to the dark theme" : "Switch to the light theme");
  }
  const mbtn = document.getElementById("themeMenuBtn");
  if (mbtn) mbtn.textContent = t === "light" ? "☾ Dark theme" : "☀ Light theme";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(document.body).getPropertyValue("--bg").trim() || (t === "light" ? "#f7f8fc" : "#0b1020"));
  if (window.Viz) Viz.themeChanged();
}

// ============================================================
// LOOKS (skins): skins/<id>.css restyles the whole site through the design tokens; "classic"
// is the base stylesheet alone. The loader in index.html applies the saved look before first
// paint; the Look menu switches it live.
// ============================================================
const SKIN_KEY = "ddia_skin";
const DEFAULT_SKIN = (window.DDIA_LOOKS && DDIA_LOOKS.default) || "editorial"; // set in index.html
const SKINS = [
  { id: "editorial", name: "Editorial", note: "Paper & ink, set like a textbook", sw: ["#f7f3ea", "#24211c", "#c2371d"] },
  { id: "blueprint", name: "Blueprint", note: "An engineer's drafting sheet", sw: ["#0d2c56", "#e8f1fc", "#7fdcff"] },
  { id: "brutalist", name: "Swiss", note: "Bold poster type, hard edges", sw: ["#f4f1e8", "#111111", "#ffd60a"] },
  { id: "terminal", name: "Ops console", note: "tmux meets Grafana", sw: ["#0b0d0c", "#d3dbd5", "#4be38a"] },
  { id: "classic", name: "Classic", note: "The original violet look", sw: ["#0b1020", "#e2e8f0", "#8b5cf6"] },
];
let activeSkin = document.documentElement.getAttribute("data-skin") || "classic";

function applySkin(id) {
  if (!SKINS.some(x => x.id === id) || id === activeSkin) return;
  const fontUrl = window.DDIA_LOOKS && DDIA_LOOKS.fonts && DDIA_LOOKS.fonts[id];
  try { localStorage.setItem(SKIN_KEY, id); } catch (e) {}
  const html = document.documentElement;
  const old = document.getElementById("skinCss");
  const finish = () => {
    // Swap the data-skin attribute only once the new stylesheet is in, so the page never
    // flashes the base look in between.
    if (id === "classic") html.removeAttribute("data-skin"); else html.setAttribute("data-skin", id);
    if (old) old.remove();
    // Swap the look's web fonts (async; system fallbacks show until they arrive).
    const oldFonts = document.getElementById("skinFonts");
    if (oldFonts) oldFonts.remove();
    if (fontUrl) {
      const f = document.createElement("link");
      f.rel = "stylesheet"; f.id = "skinFonts"; f.href = fontUrl;
      document.head.appendChild(f);
    }
    activeSkin = id;
    applyTheme();
    renderLookMenus();
    const sk = SKINS.find(x => x.id === id);
    showToast(`Look: ${sk.name}`);
  };
  if (id === "classic") { finish(); return; }
  const v = ((document.querySelector('link[href*="styles.css"]') || {}).href || "").match(/[?&]v=[^&]+/);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `skins/${id}.css${v ? "?" + v[0].slice(1) : ""}`;
  link.onload = () => { link.id = "skinCss"; finish(); };
  link.onerror = () => { link.remove(); showToast("Couldn't load that look. Check your connection.", true); };
  document.head.appendChild(link);
}

function lookOptionsHtml() {
  return SKINS.map(x => `
    <button type="button" class="look-opt ${x.id === activeSkin ? "is-active" : ""}" data-skin="${x.id}" role="menuitemradio" aria-checked="${x.id === activeSkin}">
      <span class="look-sw" aria-hidden="true">${x.sw.map(c => `<i style="background:${c}"></i>`).join("")}</span>
      <span class="look-txt"><b>${x.name}</b><small>${x.note}</small></span>
      <span class="look-check" aria-hidden="true">✓</span>
    </button>`).join("");
}
function renderLookMenus() {
  const menu = document.getElementById("lookMenu");
  const list = document.getElementById("lookMenuMobile");
  if (menu) menu.innerHTML = `<div class="look-title">Look</div>${lookOptionsHtml()}<div class="look-foot">Light and dark work in every look.</div>`;
  if (list) list.innerHTML = lookOptionsHtml();
  document.querySelectorAll(".look-opt").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    closeLookMenu();
    closeMoreMenu();
    applySkin(b.dataset.skin);
  }));
}
function closeLookMenu() {
  const m = document.getElementById("lookMenu");
  if (m) m.classList.remove("open");
  const t = document.getElementById("lookToggle");
  if (t) t.setAttribute("aria-expanded", "false");
}
function toggleLookMenu() {
  const m = document.getElementById("lookMenu");
  const open = m.classList.toggle("open");
  document.getElementById("lookToggle").setAttribute("aria-expanded", String(open));
  if (open) { const cur = m.querySelector(".look-opt.is-active") || m.querySelector(".look-opt"); if (cur) cur.focus(); }
}

let _toastTimer;
function showToast(msg, isError) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.style.borderColor = isError ? "var(--bad)" : "var(--accent)";
  t.style.opacity = "1";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.style.opacity = "0"; }, 4500);
}

function isMobile() { return window.innerWidth <= MOBILE_BREAKPOINT; }

// ------------------------------------------------------------
// Progress math
// ------------------------------------------------------------
function countTrue(obj, validIds) {
  return validIds.filter(id => obj && obj[id]).length;
}
function chapterCounts(ch) {
  const p = getChapterProgress(ch.id);
  const cIds = ch.concepts.map(c => c.id);
  const qIds = ch.interview.map(q => q.id);
  const sIds = sectionsOf(ch).map(s => s.id);
  return {
    c: countTrue(p.concepts, cIds), cTotal: cIds.length,
    q: countTrue(p.qa, qIds), qTotal: qIds.length,
    s: countTrue(p.sections, sIds), sTotal: sIds.length,
  };
}
function computeChapterPct(ch) {
  const k = chapterCounts(ch);
  const total = k.cTotal + k.qTotal + k.sTotal;
  return total ? Math.round(((k.c + k.q + k.s) / total) * 100) : 0;
}
function computeOverall() {
  return chapters().reduce((acc, ch) => {
    const k = chapterCounts(ch);
    acc.c += k.c; acc.cTotal += k.cTotal;
    acc.q += k.q; acc.qTotal += k.qTotal;
    acc.s += k.s; acc.sTotal += k.sTotal;
    return acc;
  }, { c: 0, cTotal: 0, q: 0, qTotal: 0, s: 0, sTotal: 0 });
}
function computeOverallPct() {
  const k = computeOverall();
  const total = k.cTotal + k.qTotal + k.sTotal;
  return total ? Math.round(((k.c + k.q + k.s) / total) * 100) : 0;
}

// ============================================================
// ROUTING  (#/  #/ch5  #/ch5/learn/quorums  #/viz  #/viz/ch5/quorum  #/glossary  #/cheatsheet)
// ============================================================
function parseHash() {
  const h = (location.hash || "").replace(/^#\/?/, "");
  let raw;
  try { raw = decodeURIComponent(h); } catch (e) { raw = ""; } // e.g. a truncated %E0 in a pasted link
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return { view: "dashboard" };
  if (parts[0] === "viz") {
    if (parts.length >= 3) return { view: "viz", vizId: parts.slice(1).join("/") };
    if (parts[1] && getChapter(parts[1])) return { view: "gallery", filter: parts[1] }; // #/viz/ch5
    return { view: "gallery" };
  }
  if (parts[0] === "glossary") return { view: "glossary" };
  if (parts[0] === "quiz") return { view: "quiz" };
  if (parts[0] === "cheatsheet") return { view: "allcheats" };
  const ch = getChapter(parts[0]);
  if (!ch) return { view: "dashboard" };
  const tab = TABS.some(t => t.id === parts[1]) ? parts[1] : defaultTab(ch);
  return { view: "chapter", chapterId: ch.id, tab, target: parts[2] || null };
}
function defaultTab(ch) { return sectionsOf(ch).length ? "learn" : "concepts"; }

function routeHash(r) {
  if (r.view === "dashboard") return "#/";
  if (r.view === "gallery") return "#/viz" + (r.filter ? "/" + r.filter : "");
  if (r.view === "viz") return "#/viz/" + r.vizId;
  if (r.view === "glossary") return "#/glossary";
  if (r.view === "quiz") return "#/quiz";
  if (r.view === "allcheats") return "#/cheatsheet";
  return "#/" + r.chapterId + "/" + r.tab + (r.target ? "/" + r.target : "");
}
function navigate(r) {
  const h = routeHash(r);
  if (location.hash === h) onRoute(); else location.hash = h;
}

function onRoute() {
  const prev = state.route;
  const next = parseHash();
  state.route = next;
  if (next.view === "chapter") {
    state.last = { chapterId: next.chapterId, tab: next.tab };
    saveState();
  }
  const samePage = prev && prev.view === next.view && prev.chapterId === next.chapterId &&
    prev.tab === next.tab && prev.vizId === next.vizId && prev.filter === next.filter &&
    document.getElementById("main").dataset.rendered;
  if (samePage) {
    scrollToTarget(next);
    renderSidebar();
    return;
  }
  if (next.view !== "quiz") quizSession = null;
  if (!prev || prev.chapterId !== next.chapterId || prev.tab !== next.tab) {
    state.flashIndex = 0; state.flashFlipped = false; state.flashOrder = null;
  }
  closeSearch();
  render();
  if (next.target) scrollToTarget(next);
  else window.scrollTo(0, 0);
}

function scrollToTarget(r) {
  if (!r.target) return;
  if (SHOOT_MODE) { // screenshots shift the page themselves; just open/highlight the target
    const t = document.getElementById(targetDomId(r));
    if (t && r.tab === "interview" && t.classList.contains("qa-item")) t.classList.add("open");
    return;
  }
  const el = document.getElementById(targetDomId(r));
  if (!el) return;
  if (r.tab === "interview" && el.classList.contains("qa-item")) setQaOpen(el, true);
  requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  // Visualizations above the target mount (and grow) while we scroll, pushing the target down.
  // Re-align a couple of times unless the reader has started scrolling on their own.
  let userMoved = false;
  const stop = () => { userMoved = true; };
  ["wheel", "touchmove", "keydown"].forEach(ev => window.addEventListener(ev, stop, { once: true, passive: true }));
  [900, 1800, 3000].forEach(t => setTimeout(() => {
    if (userMoved || !el.isConnected) return;
    const want = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    if (Math.abs(el.getBoundingClientRect().top - want) > 30) el.scrollIntoView({ behavior: "auto", block: "start" });
  }, t));
  el.classList.add("flash-target");
  setTimeout(() => el.classList.remove("flash-target"), 1800);
}
function targetDomId(r) {
  if (r.tab === "learn") return "sec-" + r.target;
  if (r.tab === "concepts") return "concept-" + r.target;
  if (r.tab === "interview") return "qa-" + r.target;
  return r.target;
}

// ============================================================
// MOBILE DRAWER / MORE MENU
// ============================================================
function openDrawer() {
  const sb = document.getElementById("sidebar");
  sb.classList.add("open");
  document.getElementById("backdrop").classList.add("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "true");
  // Put keyboard focus where the reader is (the current chapter), not at the top of the list.
  const here = sb.querySelector(".chapter-item.active") || sb.querySelector("a");
  if (here) here.focus({ preventScroll: true });
  if (here && here.scrollIntoView) here.scrollIntoView({ block: "center" });
}
function closeDrawer() {
  const sb = document.getElementById("sidebar");
  const wasOpen = sb.classList.contains("open");
  sb.classList.remove("open");
  document.getElementById("backdrop").classList.remove("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
  if (wasOpen && sb.contains(document.activeElement)) document.getElementById("menuToggle").focus({ preventScroll: true });
}
function toggleDrawer() {
  const sb = document.getElementById("sidebar");
  if (sb.classList.contains("open")) closeDrawer(); else openDrawer();
}
function closeMoreMenu() {
  const m = document.getElementById("moreMenu");
  if (m) m.classList.remove("open");
  const t = document.getElementById("moreToggle");
  if (t) t.setAttribute("aria-expanded", "false");
}
function toggleMoreMenu() {
  const open = document.getElementById("moreMenu").classList.toggle("open");
  document.getElementById("moreToggle").setAttribute("aria-expanded", String(open));
}

// Phone: the search box lives in a row that slides out below the top bar.
function openSearch() {
  document.getElementById("topbar").classList.add("search-open");
  document.getElementById("searchToggle").setAttribute("aria-expanded", "true");
  document.getElementById("searchBox").focus();
}
function closeSearch() {
  const bar = document.getElementById("topbar");
  if (!bar) return;
  bar.classList.remove("search-open");
  const t = document.getElementById("searchToggle");
  if (t) t.setAttribute("aria-expanded", "false");
  const res = document.getElementById("searchResults");
  if (res) res.classList.remove("open");
}

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttr(s) { return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←", harr: "↔", times: "×", le: "≤", ge: "≥", ne: "≠" };
function stripTags(s) {
  return String(s || "")
    .replace(/<\/?(b|strong|em|i|code|span|a|sup|sub|kbd|mark|small|u)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITIES[e.toLowerCase()] || " "))
    .replace(/\s+/g, " ").trim();
}
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n * 0.6)).replace(/[,.;:\s]+$/, "") + "…";
}
function ringSvg(pct, size = 18) {
  const r = 8, c = 2 * Math.PI * r, off = c - (pct / 100) * c;
  if (pct >= 100) return `<div class="chapter-ring done" style="width:${size}px;height:${size}px"><div class="check">✓</div></div>`;
  return `<div class="chapter-ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 20 20"><circle class="bg" cx="10" cy="10" r="${r}"/><circle class="fg" cx="10" cy="10" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg></div>`;
}
function vizBlocks(ch) {
  if (hasDeepContent(ch)) {
    const out = [];
    sectionsOf(ch).forEach(sec => (sec.blocks || []).forEach(b => {
      if (b.type === "viz") out.push({ ...b, section: sec, chapter: ch });
    }));
    return out;
  }
  const m = MANIFEST[ch.id];
  if (!m) return [];
  const secById = Object.fromEntries(m.sections.map(x => [x.id, x]));
  return m.viz.map(v => ({ type: "viz", id: v.id, title: v.title, caption: v.caption, section: secById[v.section] || { id: v.section, title: "" }, chapter: ch }));
}
function allVizBlocks() { return chapters().flatMap(vizBlocks); }

/**
 * Where the reader should go next: the first section not yet marked as understood, starting from
 * the chapter they were last reading (wrapping around the book). Null once everything is done.
 */
function nextUp() {
  const list = chapters();
  if (!list.length) return null;
  const lastIdx = state.last ? list.findIndex(c => c.id === state.last.chapterId) : -1;
  const start = Math.max(0, lastIdx);
  for (let n = 0; n < list.length; n++) {
    const ch = list[(start + n) % list.length];
    const secs = sectionsOf(ch);
    const p = getChapterProgress(ch.id);
    const idx = secs.findIndex(s => !p.sections[s.id]);
    if (idx >= 0) {
      const done = secs.filter(s => p.sections[s.id]).length;
      // The first section opens at the top of the chapter so the hook isn't skipped.
      const href = idx === 0 && !done ? `#/${ch.id}/learn` : `#/${ch.id}/learn/${secs[idx].id}`;
      return { ch, sec: secs[idx], idx, total: secs.length, done, href, started: lastIdx >= 0 || done > 0 };
    }
  }
  return null;
}
function readingMinutes(ch) {
  if (MANIFEST[ch.id] && MANIFEST[ch.id].minutes) return MANIFEST[ch.id].minutes;
  const words = sectionsOf(ch).reduce((n, s) =>
    n + (s.blocks || []).reduce((m, b) => m + stripTags(blockText(b)).split(" ").length, 0), 0);
  return Math.max(1, Math.round(words / 220));
}
function blockText(b) {
  switch (b.type) {
    case "realworld": return (b.items || []).map(i => `${i.org || ""} ${i.title || ""} ${i.html || ""}`).join(" ");
    case "tradeoffs": return (b.pros || []).concat(b.cons || []).join(" ");
    case "steps": case "list": case "keypoints": return (b.items || []).join(" ");
    case "timeline": return (b.items || []).map(i => `${i.year} ${i.html}`).join(" ");
    case "table": return (b.rows || []).map(r => r.join(" ")).join(" ");
    case "compare": return (b.items || []).map(i => `${i.title} ${i.html}`).join(" ");
    case "quiz": return `${b.q} ${(b.options || []).join(" ")} ${b.explain || ""}`;
    case "viz": return `${b.title || ""} ${b.caption || ""}`;
    case "code": return "";
    default: return `${b.title || ""} ${b.html || ""}`;
  }
}

// ============================================================
// RENDER: sidebar
// ============================================================
function renderSidebar() {
  const sb = document.getElementById("sidebar");
  const r = state.route;
  const nav = (view, icon, label, active) =>
    `<a class="chapter-item ${active ? "active" : ""}" href="${routeHash({ view })}"${active ? ' aria-current="page"' : ""}><div class="chapter-num" aria-hidden="true">${icon}</div><div class="chapter-title">${label}</div></a>`;
  let html = `<div class="nav-group">
    ${nav("dashboard", "✦", "Dashboard", r.view === "dashboard")}
    ${nav("gallery", "▶", "Visualization lab", r.view === "gallery" || r.view === "viz")}
    ${nav("quiz", "?", "Quiz mode", r.view === "quiz")}
    ${nav("glossary", "A–Z", "Glossary", r.view === "glossary")}
    ${nav("allcheats", "≡", "Printable cheat sheet", r.view === "allcheats")}
  </div>`;
  [1, 2, 3].forEach(pNum => {
    const list = chapters().filter(c => c.part === pNum);
    if (!list.length) return;
    html += `<div class="part-header" title="${PART_NAMES[pNum]}">Part ${ROMAN[pNum]} · ${PART_SHORT[pNum]}</div>`;
    list.forEach(ch => {
      const pct = computeChapterPct(ch);
      const active = r.view === "chapter" && r.chapterId === ch.id;
      html += `<a class="chapter-item ${active ? "active" : ""}" href="#/${ch.id}" data-chapter="${ch.id}"${active ? ' aria-current="page"' : ""} title="${pct}% complete">
        <div class="chapter-num">${ch.number}</div>
        <div class="chapter-title">${ch.title}</div>
        ${ringSvg(pct)}
      </a>`;
      if (active && r.tab === "learn" && sectionsOf(ch).length) {
        const p = getChapterProgress(ch.id);
        html += `<div class="side-sections">` + sectionsOf(ch).map(s =>
          `<a class="side-section ${p.sections[s.id] ? "done" : ""} ${r.target === s.id ? "current" : ""}" href="#/${ch.id}/learn/${s.id}" data-sec-link="${s.id}">${s.title}</a>`
        ).join("") + `</div>`;
      }
    });
  });
  sb.innerHTML = html;
  sb.querySelectorAll("a").forEach(a => a.addEventListener("click", () => { if (isMobile()) closeDrawer(); }));
}

// ============================================================
// RENDER: main dispatch
// ============================================================
function renderMain() {
  const m = document.getElementById("main");
  if (window.Viz) Viz.unmountAll(m);
  const r = state.route;
  m.dataset.rendered = "";
  m.className = "main view-" + r.view;
  if (r.view === "dashboard") renderDashboard(m);
  else if (r.view === "gallery") renderGallery(m);
  else if (r.view === "viz") renderStandaloneViz(m, r.vizId);
  else if (r.view === "glossary") renderGlossary(m);
  else if (r.view === "quiz") renderQuiz(m);
  else if (r.view === "allcheats") renderAllCheatsheets(m);
  else renderChapter(m, getChapter(r.chapterId), r.tab);
  m.dataset.rendered = "1";
  enhanceDiagrams(m);
  centerActiveTab(m);
  if (window.Viz) Viz.mountAll(m, { eager: SHOOT_MODE });
}

/** On a phone the tab strip scrolls sideways: make sure the current tab is the one in view. */
function centerActiveTab(root) {
  const nav = root.querySelector(".tabs");
  const tab = nav && nav.querySelector(".tab.active");
  if (!tab || nav.scrollWidth <= nav.clientWidth) return;
  nav.scrollLeft = Math.max(0, tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2);
}

/**
 * Static diagrams are inline SVGs drawn for a ~640px-wide viewBox. On a phone they would shrink
 * until their labels are unreadable, so wide ones keep a minimum drawing width (~88% of the
 * viewBox, i.e. labels stay ≥ ~10.5px) and scroll sideways inside their frame instead.
 */
function enhanceDiagrams(root) {
  root.querySelectorAll(".dd-diagram-body > svg").forEach(svg => {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width || vb.width <= 420) return;
    svg.style.minWidth = Math.round(vb.width * 0.88) + "px";
    const body = svg.parentElement;
    body.classList.add("is-scrollable");
    const hint = () => body.classList.toggle("has-overflow", body.scrollWidth > body.clientWidth + 4);
    hint();
    if ("ResizeObserver" in window) new ResizeObserver(hint).observe(body);
  });
}

function render() {
  renderSidebar();
  renderMain();
  updateProgressUI();
}

/** Update every progress indicator in place (no re-render, so live visualizations survive). */
function updateProgressUI() {
  const pct = computeOverallPct();
  document.getElementById("overallProgressText").textContent = pct + "%";
  document.getElementById("overallProgressFill").style.width = pct + "%";
  const r = state.route;
  if (r.view === "chapter") {
    const ch = getChapter(r.chapterId);
    const k = chapterCounts(ch);
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    if (k.sTotal) set("tabcount-learn", `${k.s}/${k.sTotal}`);
    set("tabcount-concepts", `${k.c}/${k.cTotal}`);
    set("tabcount-interview", `${k.q}/${k.qTotal}`);
    const bar = document.getElementById("chapterPctFill");
    if (bar) {
      bar.style.width = computeChapterPct(ch) + "%";
      bar.parentElement.setAttribute("aria-valuenow", computeChapterPct(ch));
    }
    set("chapterPctText", computeChapterPct(ch) + "% complete");
  }
  renderSidebar();
}

// ============================================================
// RENDER: chapter
// ============================================================
function renderChapter(m, ch, tab) {
  if (!ch) { m.innerHTML = "<p>Chapter not found.</p>"; return; }
  const k = chapterCounts(ch);
  const hasDeep = sectionsOf(ch).length > 0;
  const counts = {
    learn: hasDeep ? `${k.s}/${k.sTotal}` : "soon",
    concepts: `${k.c}/${k.cTotal}`,
    cheatsheet: String(ch.cheatsheet.length),
    interview: `${k.q}/${k.qTotal}`,
    flashcards: String(ch.concepts.length + ch.interview.length),
  };
  const tabsHtml = `<nav class="tabs" aria-label="Chapter sections">` + TABS.map(t =>
    `<a class="tab ${tab === t.id ? "active" : ""}" href="#/${ch.id}/${t.id}"${tab === t.id ? ' aria-current="page"' : ""}><span class="tab-label">${t.label}</span><span class="tab-label-short" aria-hidden="true">${t.short}</span> <span class="tab-count" id="tabcount-${t.id}">${counts[t.id]}</span></a>`
  ).join("") + `</nav>`;

  let bodyHtml = "";
  const deepPending = tab === "learn" && !hasDeepContent(ch) && sectionsOf(ch).length > 0;
  if (tab === "learn") bodyHtml = deepPending ? loadingHtml("Loading the deep dive…") : renderDeepDive(ch);
  else if (tab === "concepts") bodyHtml = renderConcepts(ch);
  else if (tab === "cheatsheet") bodyHtml = renderCheatsheet(ch);
  else if (tab === "interview") bodyHtml = renderInterview(ch);
  else if (tab === "flashcards") bodyHtml = renderFlashcards(ch);

  const idx = chapters().findIndex(c => c.id === ch.id);
  const prev = idx > 0 ? chapters()[idx - 1] : null;
  const next = idx < chapters().length - 1 ? chapters()[idx + 1] : null;
  const pct = computeChapterPct(ch);
  const vizCount = vizBlocks(ch).length;

  m.innerHTML = `
    <header class="chapter-header">
      <div class="chapter-label">Chapter ${ch.number} · Part ${ROMAN[ch.part]} · ${PART_SHORT[ch.part]}</div>
      <h1>${ch.title}</h1>
      ${ch.tagline ? `<p class="chapter-tagline">${ch.tagline}</p>` : ""}
      <div class="chapter-meta">
        ${hasDeep ? `<span class="meta-chip">⏱ ${readingMinutes(ch)} min read</span>` : ""}
        ${vizCount ? `<span class="meta-chip">▶ ${vizCount} visualization${vizCount > 1 ? "s" : ""}</span>` : ""}
        <span class="meta-chip">${ch.concepts.length} concepts · ${ch.interview.length} questions</span>
        <span class="meta-progress"><span class="meta-progress-bar" role="progressbar" aria-label="Chapter progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span id="chapterPctFill" style="width:${pct}%"></span></span><span id="chapterPctText">${pct}% complete</span></span>
      </div>
      ${ch.overview ? `<details class="overview-details" ${hasDeep ? "" : "open"}>
        <summary>Chapter overview</summary>
        <div class="overview-text">${ch.overview}</div>
      </details>` : ""}
    </header>
    ${tabsHtml}
    <div id="tabBody" class="tab-body tab-${tab}">${bodyHtml}</div>
    <div class="chapter-footer">
      ${prev ? `<a class="nav-btn" href="#/${prev.id}"><div class="nav-btn-label">← Previous</div>Ch ${prev.number}: ${prev.title}</a>` : "<div></div>"}
      ${next ? `<a class="nav-btn right" href="#/${next.id}"><div class="nav-btn-label">Next →</div>Ch ${next.number}: ${next.title}</a>` : "<div></div>"}
    </div>
  `;
  wireChapter(m, ch, tab);
  if (deepPending) {
    DDIA.loadDeep(ch.id).then(() => {
      const r = state.route;
      if (r.view === "chapter" && r.chapterId === ch.id && r.tab === "learn") {
        renderMain();
        updateProgressUI();
        if (r.target) scrollToTarget(r);
      }
    }).catch(err => {
      const body = document.getElementById("tabBody");
      if (!body) return;
      body.innerHTML = `<div class="empty-tab" role="alert"><p>Couldn't load this deep dive (${escapeHtml(err.message)}).</p><button type="button" class="btn-ghost" id="ddRetry">Try again</button></div>`;
      body.querySelector("#ddRetry").addEventListener("click", () => renderMain());
    });
  } else if (!hasDeepContent(ch) && sectionsOf(ch).length) {
    // Warm the cache so switching to the Deep Dive tab is instant.
    (window.requestIdleCallback || setTimeout)(() => DDIA.loadDeep(ch.id).catch(() => {}));
  }
}

function wireChapter(m, ch, tab) {
  // Concept "learned" toggles
  m.querySelectorAll(".learn-toggle").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.id;
      const p = getChapterProgress(ch.id);
      p.concepts[id] = !p.concepts[id];
      saveState();
      const on = !!p.concepts[id];
      btn.classList.toggle("on", on);
      btn.textContent = on ? "✓" : "";
      btn.setAttribute("aria-pressed", String(on));
      btn.title = on ? "Learned (click to undo)" : "Mark as learned";
      const card = btn.closest(".concept-card");
      if (card) card.classList.toggle("learned", on);
      const learned = ch.concepts.filter(c => p.concepts[c.id]).length;
      const set = (id2, v) => { const el = document.getElementById(id2); if (el) el.textContent = v; };
      set("conceptDoneCount", learned);
      set("conceptTodoCount", ch.concepts.length - learned);
      updateProgressUI();
    });
  });
  // Concepts toolbar: filter, show, compact
  const cf = m.querySelector("#conceptFilter");
  if (cf) {
    cf.addEventListener("input", () => applyConceptFilter(m));
    m.querySelectorAll(".tab-toolbar .seg-btn[data-show]").forEach(b => b.addEventListener("click", () => {
      m.querySelectorAll(".tab-toolbar .seg-btn[data-show]").forEach(x => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      applyConceptFilter(m);
    }));
    const cc = m.querySelector("#conceptCompact");
    cc.addEventListener("change", () => {
      ui.conceptsCompact = cc.checked; saveUi();
      m.querySelector(".concepts-grid").classList.toggle("is-compact", cc.checked);
    });
  }
  // Q&A expand + reviewed
  m.querySelectorAll(".qa-header").forEach(hd => {
    const item = hd.parentElement;
    hd.addEventListener("click", () => setQaOpen(item, !item.classList.contains("open")));
    hd.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQaOpen(item, !item.classList.contains("open")); } });
  });
  m.querySelectorAll(".review-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const p = getChapterProgress(ch.id);
      p.qa[id] = !p.qa[id];
      saveState();
      const on = !!p.qa[id];
      btn.classList.toggle("on", on);
      btn.textContent = on ? "✓ Reviewed" : "Mark reviewed";
      btn.setAttribute("aria-pressed", String(on));
      const item = btn.closest(".qa-item");
      item.classList.toggle("reviewed", on);
      const hd = item.querySelector(".qa-header");
      const mark = hd.querySelector(".qa-done");
      if (on && !mark) hd.querySelector(".qa-chevron").insertAdjacentHTML("beforebegin", `<span class="qa-done" title="Reviewed" aria-label="Reviewed">✓</span>`);
      if (!on && mark) mark.remove();
      updateProgressUI();
    });
  });
  // Q&A toolbar
  if (m.querySelector("#qaHideReviewed")) {
    m.querySelectorAll(".tab-toolbar .seg-btn[data-diff]").forEach(b => b.addEventListener("click", () => {
      m.querySelectorAll(".tab-toolbar .seg-btn[data-diff]").forEach(x => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      applyQaFilter(m);
    }));
    m.querySelector("#qaHideReviewed").addEventListener("change", () => applyQaFilter(m));
    const ex = m.querySelector("#qaExpandAll");
    ex.addEventListener("click", () => {
      const open = ex.getAttribute("aria-pressed") !== "true";
      m.querySelectorAll(".qa-item:not([hidden])").forEach(it => setQaOpen(it, open));
      ex.setAttribute("aria-pressed", String(open));
      ex.textContent = open ? "Collapse all" : "Expand all";
    });
  }
  // Deep-dive section "understood" toggles
  m.querySelectorAll(".section-done-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const p = getChapterProgress(ch.id);
      p.sections[id] = !p.sections[id];
      saveState();
      syncSectionButton(btn, !!p.sections[id]);
      m.querySelectorAll(`.toc-link[data-sec="${id}"]`).forEach(a => a.classList.toggle("done", !!p.sections[id]));
      const sec = document.getElementById("sec-" + id);
      if (sec) sec.classList.toggle("is-done", !!p.sections[id]);
      updateProgressUI();
      syncInlineToc(m, ch);
      if (p.sections[id]) {
        const secs = sectionsOf(ch);
        const nextSec = secs.slice(secs.findIndex(s => s.id === id) + 1).find(s => !p.sections[s.id]);
        showToast(nextSec ? `Section marked as understood ✓  Next up: ${stripTags(nextSec.title)}` : "Section marked as understood ✓");
      }
    });
  });
  // Inline quizzes
  m.querySelectorAll(".quiz").forEach(q => {
    q.querySelectorAll(".quiz-opt").forEach(opt => {
      opt.addEventListener("click", () => {
        if (q.classList.contains("answered")) return;
        q.classList.add("answered");
        const correct = opt.dataset.correct === "1";
        opt.classList.add(correct ? "is-correct" : "is-wrong");
        q.querySelectorAll('.quiz-opt[data-correct="1"]').forEach(o => o.classList.add("is-correct"));
        const ex = q.querySelector(".quiz-explain");
        if (ex) {
          ex.hidden = false; ex.classList.add(correct ? "tone-ok" : "tone-bad");
          const verdict = ex.querySelector(".quiz-verdict");
          if (verdict) verdict.textContent = correct ? "Correct." : "Not quite.";
        }
      });
    });
    const retry = q.querySelector(".quiz-retry");
    if (retry) retry.addEventListener("click", () => {
      q.classList.remove("answered");
      q.querySelectorAll(".quiz-opt").forEach(o => o.classList.remove("is-correct", "is-wrong"));
      const ex = q.querySelector(".quiz-explain");
      if (ex) { ex.hidden = true; ex.classList.remove("tone-ok", "tone-bad"); }
    });
  });
  // Phone contents list: close it once a section is picked.
  m.querySelectorAll(".dd-toc-inline a").forEach(a => a.addEventListener("click", () => { a.closest("details").open = false; }));
  // Flashcards
  wireFlashcards(m, ch);
  // Scroll-spy for the deep-dive TOC
  if (tab === "learn") setupScrollSpy(m, ch);
}

function syncSectionButton(btn, done) {
  btn.classList.toggle("on", done);
  btn.setAttribute("aria-pressed", String(done));
  btn.innerHTML = done ? "✓ Understood" : "Mark section as understood";
}

let _spyObserver = null;
function setupScrollSpy(m, ch) {
  if (_spyObserver) _spyObserver.disconnect();
  if (!("IntersectionObserver" in window)) return;
  const links = m.querySelectorAll(".toc-link");
  if (!links.length) return;
  _spyObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const id = e.target.id.replace(/^sec-/, "");
      links.forEach(a => a.classList.toggle("current", a.dataset.sec === id));
      document.querySelectorAll(".side-section").forEach(a => a.classList.toggle("current", a.dataset.secLink === id));
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  m.querySelectorAll(".dd-section").forEach(s => _spyObserver.observe(s));
}

// ============================================================
// RENDER: Deep Dive (block-based long-form content)
// ============================================================
const CALLOUT_META = {
  problem: { icon: "⚠", label: "The problem" },
  idea: { icon: "💡", label: "The key idea" },
  analogy: { icon: "🔁", label: "Analogy" },
  insight: { icon: "✦", label: "Insight" },
  warning: { icon: "⚡", label: "Watch out" },
  interview: { icon: "🎯", label: "Interview angle" },
  history: { icon: "🕰", label: "History" },
  modern: { icon: "🚀", label: "Modern landscape" },
  tip: { icon: "✓", label: "Rule of thumb" },
  mistake: { icon: "✗", label: "Common misconception" },
};

function renderBlock(b, ctx) {
  switch (b.type) {
    case "text":
      return `<div class="dd-text">${b.html}</div>`;
    case "problem": case "idea": case "analogy":
      return calloutHtml(b.type, b.title, b.html);
    case "callout":
      return calloutHtml(b.tone || "insight", b.title, b.html);
    case "viz":
      return Viz.frameHTML({ id: b.id, title: b.title || "", caption: b.caption || "" });
    case "diagram":
      return `<figure class="dd-diagram">${b.title ? `<div class="dd-diagram-title">${b.title}</div>` : ""}<div class="dd-diagram-body">${b.svg || b.html || ""}</div>${b.caption ? `<figcaption>${b.caption}</figcaption>` : ""}</figure>`;
    case "realworld":
      return `<div class="dd-realworld">
        <div class="dd-block-title"><span class="dd-icon">🌍</span>${b.title || "In the real world"}</div>
        <div class="rw-grid">${(b.items || []).map(it => `
          <div class="rw-card">
            <div class="rw-head">
              <span class="rw-org">${it.org || ""}</span>
              ${it.year ? `<span class="rw-year">${it.year}</span>` : ""}
              ${it.tag ? `<span class="rw-tag">${it.tag}</span>` : ""}
            </div>
            ${it.title ? `<div class="rw-title">${it.title}</div>` : ""}
            <div class="rw-body">${it.html || ""}</div>
          </div>`).join("")}
        </div></div>`;
    case "tradeoffs":
      return `<div class="dd-tradeoffs">
        ${b.title ? `<div class="dd-block-title"><span class="dd-icon">⚖</span>${b.title}</div>` : ""}
        <div class="to-grid">
          <div class="to-col to-pros"><div class="to-head">${b.prosLabel || "Strengths"}</div><ul>${(b.pros || []).map(x => `<li>${x}</li>`).join("")}</ul></div>
          <div class="to-col to-cons"><div class="to-head">${b.consLabel || "Costs"}</div><ul>${(b.cons || []).map(x => `<li>${x}</li>`).join("")}</ul></div>
        </div></div>`;
    case "compare":
      return `<div class="dd-compare">
        ${b.title ? `<div class="dd-block-title"><span class="dd-icon">⇄</span>${b.title}</div>` : ""}
        <div class="cmp-grid" style="--cols:${Math.min(4, (b.items || []).length)}">${(b.items || []).map(it => `
          <div class="cmp-card ${it.tone ? "tone-" + it.tone : ""}">
            <div class="cmp-title">${it.title}</div>
            <div class="cmp-body">${it.html}</div>
          </div>`).join("")}</div></div>`;
    case "table":
      return `<div class="dd-table">${b.title ? `<div class="dd-block-title"><span class="dd-icon">▦</span>${b.title}</div>` : ""}${tableHtml(b.headers, b.rows)}${b.note ? `<div class="cs-note">${b.note}</div>` : ""}</div>`;
    case "code":
      return `<div class="dd-code">${b.title || b.lang ? `<div class="dd-code-head">${b.title || ""}<span class="dd-code-lang">${b.lang || ""}</span></div>` : ""}<pre><code>${escapeHtml(b.code || "")}</code></pre>${b.caption ? `<div class="dd-code-caption">${b.caption}</div>` : ""}</div>`;
    case "steps":
      return `<div class="dd-steps">${b.title ? `<div class="dd-block-title"><span class="dd-icon">☰</span>${b.title}</div>` : ""}<ol>${(b.items || []).map(x => `<li>${x}</li>`).join("")}</ol></div>`;
    case "list":
      return `<div class="dd-list">${b.title ? `<div class="dd-block-title">${b.title}</div>` : ""}<${b.ordered ? "ol" : "ul"}>${(b.items || []).map(x => `<li>${x}</li>`).join("")}</${b.ordered ? "ol" : "ul"}></div>`;
    case "keypoints":
      return `<div class="dd-keypoints"><div class="dd-block-title"><span class="dd-icon">★</span>${b.title || "Key points"}</div><ul>${(b.items || []).map(x => `<li>${x}</li>`).join("")}</ul></div>`;
    case "timeline":
      return `<div class="dd-timeline">${b.title ? `<div class="dd-block-title"><span class="dd-icon">🕰</span>${b.title}</div>` : ""}<ol class="tl">${(b.items || []).map(it =>
        `<li><span class="tl-year">${it.year}</span><div class="tl-body">${it.html}</div></li>`).join("")}</ol></div>`;
    case "quiz":
      return `<div class="quiz">
        <div class="quiz-head"><span class="quiz-chip">Check yourself</span><div class="quiz-q">${b.q}</div></div>
        <div class="quiz-opts">${(b.options || []).map((o, i) =>
          `<button type="button" class="quiz-opt" data-correct="${i === b.answer ? 1 : 0}"><span class="quiz-letter">${"ABCDEF"[i]}</span><span>${o}</span></button>`).join("")}</div>
        <div class="quiz-explain" hidden><strong class="quiz-verdict"></strong> ${b.explain || ""}<button type="button" class="quiz-retry">Try again</button></div>
      </div>`;
    default:
      return b.html ? `<div class="dd-text">${b.html}</div>` : "";
  }
}
function calloutHtml(tone, title, html) {
  const meta = CALLOUT_META[tone] || CALLOUT_META.insight;
  return `<aside class="callout callout-${tone}">
    <div class="callout-head"><span class="callout-icon">${meta.icon}</span><span class="callout-label">${title || meta.label}</span></div>
    <div class="callout-body">${html || ""}</div>
  </aside>`;
}
function tableHtml(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${(headers || []).map(hd => `<th>${hd}</th>`).join("")}</tr></thead><tbody>${(rows || []).map(r =>
    `<tr>${r.map((c, i) => `<td data-label="${escapeAttr(stripTags((headers || [])[i] || ""))}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function inlineTocMeta(ch) {
  const k = chapterCounts(ch);
  return `${k.s} of ${k.sTotal} understood`;
}
function syncInlineToc(m, ch) {
  const el = m.querySelector("#inlineTocMeta");
  if (el) el.textContent = inlineTocMeta(ch);
}
function loadingHtml(msg) {
  return `<div class="dd-loading" role="status"><div class="skeleton-lines" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><div class="muted">${msg}</div></div>`;
}

function renderDeepDive(ch) {
  const dd = ch.deepDive;
  const secs = sectionsOf(ch);
  if (!secs.length) {
    return `<div class="empty-tab">The deep dive for this chapter is being written. Meanwhile, see <a href="#/${ch.id}/concepts">Concepts</a>.</div>`;
  }
  const p = getChapterProgress(ch.id);
  const conceptById = Object.fromEntries(ch.concepts.map(c => [c.id, c]));
  const toc = `<nav class="dd-toc" aria-label="On this page">
    <div class="dd-toc-title">On this page</div>
    ${secs.map((s, i) => `<a class="toc-link ${p.sections[s.id] ? "done" : ""}" data-sec="${s.id}" href="#/${ch.id}/learn/${s.id}"><span class="toc-num">${i + 1}</span><span>${s.title}</span></a>`).join("")}
    ${dd.takeaways ? `<a class="toc-link toc-extra" href="#/${ch.id}/learn/takeaways"><span class="toc-num">★</span><span>Takeaways</span></a>` : ""}
  </nav>`;
  // Phones and narrow windows have neither the rail nor the sidebar: a collapsible contents list.
  const inlineToc = `<details class="dd-toc-inline">
    <summary><span>Contents</span><span class="dd-toc-inline-meta" id="inlineTocMeta">${inlineTocMeta(ch)}</span></summary>
    <ol>${secs.map((s, i) => `<li><a class="toc-link ${p.sections[s.id] ? "done" : ""}" data-sec="${s.id}" href="#/${ch.id}/learn/${s.id}"><span class="toc-num">${i + 1}</span><span>${s.title}</span></a></li>`).join("")}
    ${dd.takeaways ? `<li><a class="toc-link toc-extra" href="#/${ch.id}/learn/takeaways"><span class="toc-num">★</span><span>Takeaways</span></a></li>` : ""}</ol>
  </details>`;

  // ?only=<section-id|hook|takeaways> renders a single part (used by scripts/shoot.sh for screenshots)
  const only = (location.search.match(/[?&]only=([^&]+)/) || [])[1];
  const sectionsHtml = secs.map((s, i) => {
    if (only && only !== s.id) return "";
    const done = !!p.sections[s.id];
    const conceptChips = (s.concepts || []).filter(id => conceptById[id]).map(id =>
      `<a class="concept-chip" href="#/${ch.id}/concepts/${id}" title="${escapeAttr(stripTags(conceptById[id].def))}">${conceptById[id].term}</a>`).join("");
    return `<section class="dd-section ${done ? "is-done" : ""}" id="sec-${s.id}">
      <div class="dd-section-head">
        <div class="dd-section-num">${String(i + 1).padStart(2, "0")}</div>
        <div>
          ${s.kicker ? `<div class="dd-kicker">${s.kicker}</div>` : ""}
          <h2>${s.title}</h2>
        </div>
      </div>
      ${(s.blocks || []).map(b => renderBlock(b, { ch, section: s })).join("\n")}
      <div class="dd-section-foot">
        ${conceptChips ? `<div class="concept-chips"><span class="chips-label">Concepts</span>${conceptChips}</div>` : "<div></div>"}
        <button type="button" class="section-done-btn ${done ? "on" : ""}" data-id="${s.id}" aria-pressed="${done}">${done ? "✓ Understood" : "Mark section as understood"}</button>
      </div>
    </section>`;
  }).join("");

  const takeaways = dd.takeaways && dd.takeaways.length && (!only || only === "takeaways") ? `
    <section class="dd-section dd-takeaways" id="sec-takeaways">
      <div class="dd-section-head"><div class="dd-section-num">★</div><div><h2>Takeaways</h2></div></div>
      <ol class="takeaway-list">${dd.takeaways.map(t => `<li>${t}</li>`).join("")}</ol>
      ${dd.connections && dd.connections.length ? `<div class="dd-connections"><div class="dd-block-title"><span class="dd-icon">🔗</span>How this connects</div>
        <div class="conn-grid">${dd.connections.map(c => {
          const target = getChapter(c.to);
          return `<a class="conn-card" href="#/${c.to}"><div class="conn-ch">${target ? `Ch ${target.number} · ${target.title}` : c.to}</div><div class="conn-body">${c.html.replace(/<\/?a\b[^>]*>/gi, "")}</div></a>`; // card is itself a link
        }).join("")}</div></div>` : ""}
      ${dd.furtherReading && dd.furtherReading.length ? `<div class="dd-further"><div class="dd-block-title"><span class="dd-icon">📚</span>Go deeper</div><ul>${dd.furtherReading.map(f =>
        `<li>${f.url ? `<a href="${escapeAttr(f.url)}" target="_blank" rel="noopener">${f.title}</a>` : `<strong>${f.title}</strong>`}${f.note ? ` — <span class="muted">${f.note}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
    </section>` : "";

  return `<div class="dd-layout">
    <article class="dd-article">
      ${!only ? inlineToc : ""}
      ${dd.hook && (!only || only === "hook") ? `<div class="dd-hook">${dd.hook}</div>` : ""}
      ${sectionsHtml}
      ${takeaways}
    </article>
    <aside class="dd-rail">${toc}</aside>
  </div>`;
}

// ============================================================
// RENDER: concepts / cheatsheet / interview / flashcards
// ============================================================
function renderConcepts(ch) {
  if (!ch.concepts.length) return '<div class="empty-tab">No concepts yet.</div>';
  const prog = getChapterProgress(ch.id);
  const secById = Object.fromEntries(sectionsOf(ch).map(s => [s.id, s]));
  const vizSections = new Set(vizBlocks(ch).map(v => v.section.id));
  // Map concept -> first section that lists it, for "deep dive" links.
  const secForConcept = {};
  sectionsOf(ch).forEach(s => (s.concepts || []).forEach(id => { if (!secForConcept[id]) secForConcept[id] = s.id; }));
  const learned = ch.concepts.filter(c => prog.concepts[c.id]).length;
  const compact = !!ui.conceptsCompact;
  let html = `<div class="tab-toolbar" role="group" aria-label="Filter concepts">
    <input type="search" class="tool-filter" id="conceptFilter" placeholder="Filter ${ch.concepts.length} concepts…" aria-label="Filter concepts" autocomplete="off">
    <div class="seg" role="group" aria-label="Show">
      <button type="button" class="seg-btn is-active" data-show="all" aria-pressed="true">All</button>
      <button type="button" class="seg-btn" data-show="todo" aria-pressed="false">To learn <span class="seg-count" id="conceptTodoCount">${ch.concepts.length - learned}</span></button>
      <button type="button" class="seg-btn" data-show="done" aria-pressed="false">Learned <span class="seg-count" id="conceptDoneCount">${learned}</span></button>
    </div>
    <label class="tool-switch"><input type="checkbox" id="conceptCompact" ${compact ? "checked" : ""}><span class="tool-switch-track" aria-hidden="true"></span>Definitions only</label>
  </div>
  <div class="concepts-grid ${compact ? "is-compact" : ""}">`;
  ch.concepts.forEach(c => {
    const on = !!prog.concepts[c.id];
    const secId = c.section || secForConcept[c.id];
    const sec = secId && secById[secId];
    const hasViz = sec && vizSections.has(sec.id);
    const label = escapeAttr(stripTags(c.term));
    html += `
      <article class="concept-card ${on ? "learned" : ""}" id="concept-${c.id}" data-text="${escapeAttr(stripTags(c.term + " " + c.def).toLowerCase())}">
        <button type="button" class="learn-toggle ${on ? "on" : ""}" data-id="${c.id}" aria-pressed="${on}" title="${on ? "Learned (click to undo)" : "Mark as learned"}" aria-label="${label}: learned">${on ? "✓" : ""}</button>
        <h3 class="concept-term">${c.term}</h3>
        <div class="concept-def">${c.def}</div>
        ${c.problem ? `<div class="concept-problem">${c.problem}</div>` : ""}
        ${c.why ? `<div class="concept-why">${c.why}</div>` : ""}
        ${c.ex ? `<div class="concept-example">${c.ex}</div>` : ""}
        ${sec ? `<a class="concept-deeplink" href="#/${ch.id}/learn/${sec.id}">${hasViz ? "▶ See it interactively" : "Read the deep dive"} → <span class="muted">${sec.title}</span></a>` : ""}
      </article>`;
  });
  html += `</div><div class="empty-tab filter-empty" id="conceptEmpty" hidden></div>`;
  return html;
}

/** Shared by the Concepts tab: text filter + All / To learn / Learned. */
function applyConceptFilter(m) {
  const f = m.querySelector("#conceptFilter");
  if (!f) return;
  const q = f.value.toLowerCase().trim();
  const showBtn = m.querySelector(".tab-toolbar .seg-btn.is-active");
  const show = showBtn ? showBtn.dataset.show : "all";
  let visible = 0;
  m.querySelectorAll(".concept-card").forEach(card => {
    const learned = card.classList.contains("learned");
    const ok = (!q || card.dataset.text.includes(q)) && (show === "all" || (show === "done") === learned);
    card.hidden = !ok;
    if (ok) visible++;
  });
  const empty = m.querySelector("#conceptEmpty");
  if (empty) {
    empty.hidden = visible > 0;
    empty.textContent = show === "done" && !q ? "Nothing marked as learned yet. Tick the circle on a card once you could explain it to someone."
      : show === "todo" && !q ? "Every concept in this chapter is marked as learned. Nice work."
      : `No concepts match “${f.value.trim()}”.`;
  }
}

function renderCheatsheetBlock(cs) {
  let html = `<div class="cheatsheet-block"><h3>${cs.title}</h3>`;
  if (cs.type === "table") html += tableHtml(cs.headers, cs.rows);
  else if (cs.type === "list") html += "<ul>" + cs.items.map(it => `<li>${it}</li>`).join("") + "</ul>";
  else if (cs.type === "note") html += `<div>${cs.body}</div>`;
  if (cs.note) html += `<div class="cs-note">${cs.note}</div>`;
  return html + "</div>";
}
function renderCheatsheet(ch) {
  if (!ch.cheatsheet.length) return '<div class="empty-tab">No cheatsheet entries yet.</div>';
  return `<div class="cheatsheet-actions"><a class="iconbtn" href="#/cheatsheet">≡ All chapters, printable</a></div>` +
    ch.cheatsheet.map(renderCheatsheetBlock).join("");
}

function renderInterview(ch) {
  if (!ch.interview.length) return '<div class="empty-tab">No questions yet.</div>';
  const prog = getChapterProgress(ch.id);
  const counts = { easy: 0, medium: 0, hard: 0 };
  ch.interview.forEach(q => { counts[q.diff || "medium"] = (counts[q.diff || "medium"] || 0) + 1; });
  let html = `<div class="tab-toolbar" role="group" aria-label="Filter questions">
    <div class="seg" role="group" aria-label="Difficulty">
      <button type="button" class="seg-btn is-active" data-diff="all" aria-pressed="true">All <span class="seg-count">${ch.interview.length}</span></button>
      ${counts.easy ? `<button type="button" class="seg-btn" data-diff="easy" aria-pressed="false"><span class="dot dot-easy" aria-hidden="true"></span>Easy <span class="seg-count">${counts.easy}</span></button>` : ""}
      ${counts.medium ? `<button type="button" class="seg-btn" data-diff="medium" aria-pressed="false"><span class="dot dot-med" aria-hidden="true"></span>Medium <span class="seg-count">${counts.medium}</span></button>` : ""}
      ${counts.hard ? `<button type="button" class="seg-btn" data-diff="hard" aria-pressed="false"><span class="dot dot-hard" aria-hidden="true"></span>Hard <span class="seg-count">${counts.hard}</span></button>` : ""}
    </div>
    <label class="tool-switch"><input type="checkbox" id="qaHideReviewed"><span class="tool-switch-track" aria-hidden="true"></span>Hide reviewed</label>
    <button type="button" class="btn-ghost btn-sm" id="qaExpandAll" aria-pressed="false">Expand all</button>
  </div>
  <p class="tab-tip">Answer out loud first, then open the model answer and compare.</p>`;
  ch.interview.forEach(qa => {
    const reviewed = !!prog.qa[qa.id];
    const diff = qa.diff === "easy" || qa.diff === "hard" ? qa.diff : "medium";
    const diffCls = diff === "easy" ? "diff-easy" : diff === "hard" ? "diff-hard" : "diff-med";
    html += `
      <div class="qa-item ${reviewed ? "reviewed" : ""}" id="qa-${qa.id}" data-diff="${diff}">
        <div class="qa-header" tabindex="0" role="button" aria-expanded="false" aria-controls="qa-body-${qa.id}">
          <span class="diff-badge ${diffCls}">${diff}</span>
          <div class="qa-q">${qa.q}</div>
          ${reviewed ? `<span class="qa-done" title="Reviewed" aria-label="Reviewed">✓</span>` : ""}
          <span class="qa-chevron" aria-hidden="true"></span>
        </div>
        <div class="qa-body" id="qa-body-${qa.id}">
          <div class="qa-body-inner">${qa.a}
            ${qa.followups && qa.followups.length ? `<div class="qa-followups"><div class="qa-sub">Likely follow-ups</div><ul>${qa.followups.map(f => `<li>${f}</li>`).join("")}</ul></div>` : ""}
            ${qa.pitfalls && qa.pitfalls.length ? `<div class="qa-pitfalls"><div class="qa-sub">Don't say</div><ul>${qa.pitfalls.map(f => `<li>${f}</li>`).join("")}</ul></div>` : ""}
          </div>
          <div class="qa-footer">
            ${qa.section ? `<a class="qa-deeplink" href="#/${ch.id}/learn/${qa.section}">Deep dive →</a>` : "<span></span>"}
            <button type="button" class="review-btn ${reviewed ? "on" : ""}" data-id="${qa.id}" aria-pressed="${reviewed}">${reviewed ? "✓ Reviewed" : "Mark reviewed"}</button>
          </div>
        </div>
      </div>`;
  });
  html += `<div class="empty-tab filter-empty" id="qaEmpty" hidden>No questions left with these filters.</div>`;
  return html;
}
function applyQaFilter(m) {
  const active = m.querySelector(".tab-toolbar .seg-btn.is-active");
  const diff = active ? active.dataset.diff : "all";
  const hide = !!(m.querySelector("#qaHideReviewed") || {}).checked;
  let visible = 0;
  m.querySelectorAll(".qa-item").forEach(it => {
    const ok = (diff === "all" || it.dataset.diff === diff) && !(hide && it.classList.contains("reviewed"));
    it.hidden = !ok;
    if (ok) visible++;
  });
  const empty = m.querySelector("#qaEmpty");
  if (empty) empty.hidden = visible > 0;
}
function setQaOpen(item, open) {
  item.classList.toggle("open", open);
  const hd = item.querySelector(".qa-header");
  if (hd) hd.setAttribute("aria-expanded", String(open));
}

function buildFlashDeck(ch) {
  const deck = [];
  ch.concepts.forEach(c => deck.push({
    front: c.term,
    back: c.def + (c.why ? "<br><br><em>Why:</em> " + c.why : "") + (c.ex ? "<br><em>Example:</em> " + c.ex : ""),
    kind: "concept", id: c.id,
  }));
  ch.interview.forEach(q => deck.push({ front: q.q, back: q.a, kind: "qa", id: q.id }));
  return deck;
}
/** Position in the deck -> card index (the deck may be shuffled). */
function flashCardAt(deck, pos) {
  const order = state.flashOrder && state.flashOrder.length === deck.length ? state.flashOrder : null;
  return deck[order ? order[pos] : pos];
}
function isFlashKnown(ch, card) {
  const p = getChapterProgress(ch.id);
  return card.kind === "qa" ? !!p.qa[card.id] : !!p.concepts[card.id];
}
function renderFlashcards(ch) {
  const deck = buildFlashDeck(ch);
  if (!deck.length) return '<div class="empty-tab">No flashcards yet.</div>';
  const idx = Math.max(0, Math.min(state.flashIndex, deck.length - 1));
  const card = flashCardAt(deck, idx);
  const known = isFlashKnown(ch, card);
  const knownCount = deck.filter(c => isFlashKnown(ch, c)).length;
  const kindLabel = card.kind === "qa" ? "Question" : "Concept";
  return `
    <div class="fc-top">
      <span class="fc-counter" aria-live="polite">Card ${idx + 1} of ${deck.length}${state.flashOrder ? " · shuffled" : ""}</span>
      <span class="fc-known">${knownCount} / ${deck.length} known</span>
    </div>
    <div class="meta-progress-bar fc-progress" aria-hidden="true"><span style="width:${((idx + 1) / deck.length) * 100}%"></span></div>
    <div class="fc-stage">
      <div class="flashcard ${state.flashFlipped ? "flipped" : ""}" role="button" tabindex="0" aria-label="${kindLabel} card. ${state.flashFlipped ? "Showing the answer" : "Showing the front"}; press to flip.">
        <div class="fc-face fc-front" aria-hidden="${state.flashFlipped}">
          <div class="fc-label">${kindLabel}${known ? ` <span class="fc-known-badge">✓ known</span>` : ""}</div>
          <div class="fc-content">${card.front}</div>
          <div class="fc-hint">Tap to see the answer</div>
        </div>
        <div class="fc-face fc-back" aria-hidden="${!state.flashFlipped}">
          <div class="fc-label">Answer</div>
          <div class="fc-content">${card.back}</div>
        </div>
      </div>
    </div>
    <div class="fc-nav">
      <button type="button" class="iconbtn" data-fc-nav="prev" aria-label="Previous card">← Prev</button>
      <button type="button" class="iconbtn fc-gotit ${known ? "on" : ""}" data-fc-nav="known" title="Marks this ${card.kind === "qa" ? "question as reviewed" : "concept as learned"} and moves on">✓ ${known ? "Known" : "Got it"}</button>
      <button type="button" class="iconbtn" data-fc-nav="next" aria-label="Next card">Next →</button>
    </div>
    <div class="fc-nav fc-nav-secondary">
      <button type="button" class="btn-link" data-fc-nav="shuffle">⇌ ${state.flashOrder ? "Reshuffle" : "Shuffle deck"}</button>
      ${state.flashOrder ? `<button type="button" class="btn-link" data-fc-nav="unshuffle">↺ Book order</button>` : ""}
    </div>
    <p class="kbd-tip">Keys: <kbd>Space</kbd> flip · <kbd>←</kbd> <kbd>→</kbd> move · <kbd>G</kbd> got it</p>
  `;
}
function rerenderFlashcards() {
  const ch = getChapter(state.route.chapterId);
  const body = document.getElementById("tabBody");
  if (!ch || !body) return;
  const hadFocus = body.contains(document.activeElement) && document.activeElement.dataset.fcNav;
  body.innerHTML = renderFlashcards(ch);
  wireFlashcards(body, ch);
  // Keep keyboard users on the button they pressed.
  if (hadFocus) { const b = body.querySelector(`[data-fc-nav="${hadFocus}"]`); if (b) b.focus({ preventScroll: true }); }
}
function wireFlashcards(root, ch) {
  const fcCard = root.querySelector(".flashcard");
  if (!fcCard) return;
  fcCard.addEventListener("click", () => flipCard());
  fcCard.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); flipCard(); } });
  root.querySelectorAll("[data-fc-nav]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    moveCard(b.dataset.fcNav);
  }));
  // Swipe left / right on touch screens; a tap still flips.
  const stage = root.querySelector(".fc-stage");
  let x0 = null, y0 = null;
  stage.addEventListener("touchstart", e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
  stage.addEventListener("touchend", e => {
    if (x0 === null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { e.preventDefault(); moveCard(dx < 0 ? "next" : "prev"); }
  });
}
function flipCard() {
  state.flashFlipped = !state.flashFlipped;
  const card = document.querySelector(".flashcard");
  if (!card) return;
  card.classList.toggle("flipped", state.flashFlipped);
  const front = card.querySelector(".fc-front"), back = card.querySelector(".fc-back");
  if (front) front.setAttribute("aria-hidden", String(state.flashFlipped));
  if (back) back.setAttribute("aria-hidden", String(!state.flashFlipped));
}
function moveCard(dir) {
  const ch = getChapter(state.route.chapterId);
  const deck = buildFlashDeck(ch);
  if (!deck.length) return;
  if (dir === "prev") state.flashIndex = (state.flashIndex - 1 + deck.length) % deck.length;
  else if (dir === "next") state.flashIndex = (state.flashIndex + 1) % deck.length;
  else if (dir === "shuffle") { state.flashOrder = shuffle(deck.map((_, i) => i)); state.flashIndex = 0; }
  else if (dir === "unshuffle") { state.flashOrder = null; state.flashIndex = 0; }
  else if (dir === "known") {
    // Mark the card's concept as learned (or question as reviewed): same progress as the other tabs.
    const card = flashCardAt(deck, Math.min(state.flashIndex, deck.length - 1));
    const p = getChapterProgress(ch.id);
    const bucket = card.kind === "qa" ? p.qa : p.concepts;
    if (bucket[card.id]) { bucket[card.id] = false; saveState(); updateProgressUI(); state.flashFlipped = false; rerenderFlashcards(); return; }
    bucket[card.id] = true;
    saveState();
    updateProgressUI();
    state.flashIndex = (state.flashIndex + 1) % deck.length;
  }
  state.flashFlipped = false;
  rerenderFlashcards();
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard(m) {
  const k = computeOverall();
  const overall = computeOverallPct();
  const vizTotal = allVizBlocks().length;
  const up = nextUp();
  const qs = state.quiz || { right: {}, wrong: {} };
  const toRevisit = Object.keys(qs.wrong || {}).filter(key => qs.wrong[key]).length;

  const partCols = [1, 2, 3].map(pNum => {
    const list = chapters().filter(c => c.part === pNum);
    return `<div class="map-col part-${pNum}">
      <div class="map-part">${PART_NAMES[pNum]}</div>
      ${list.map(ch => {
        const pct = computeChapterPct(ch);
        const nViz = vizBlocks(ch).length;
        const isNext = up && up.ch.id === ch.id;
        return `<a class="map-ch ${isNext ? "is-next" : ""}" href="#/${ch.id}" aria-label="Chapter ${ch.number}: ${escapeAttr(stripTags(ch.title))}, ${pct}% complete">
          <div class="map-ch-top"><span class="map-ch-num">${ch.number}</span><span class="map-ch-title">${ch.title}</span>${ringSvg(pct, 20)}</div>
          ${ch.tagline ? `<div class="map-ch-tag">${ch.tagline}</div>` : ""}
          <div class="map-ch-meta">${isNext ? `<span class="map-ch-badge">Up next</span> ` : ""}${sectionsOf(ch).length ? `${sectionsOf(ch).length} sections · ` : ""}${nViz ? `${nViz} viz · ` : ""}${ch.concepts.length} concepts · ${ch.interview.length}&nbsp;Q&amp;A</div>
        </a>`;
      }).join("")}
    </div>`;
  }).join("");

  // "Next up": the first section of the current chapter that isn't marked as understood yet.
  let nextHtml = "";
  if (up) {
    const secs = sectionsOf(up.ch);
    const p = getChapterProgress(up.ch.id);
    const pctSecs = up.total ? Math.round((up.done / up.total) * 100) : 0;
    const upcoming = secs.slice(up.idx + 1).filter(s => !p.sections[s.id]).slice(0, 3);
    nextHtml = `<section class="next-up" aria-labelledby="nextUpTitle">
      <div class="next-up-main">
        <div class="next-up-label">${up.started ? "Next up" : "Start here"} · Chapter ${up.ch.number}</div>
        <h2 id="nextUpTitle" class="next-up-title"><a href="${up.href}">${up.sec.title}</a></h2>
        <div class="next-up-meta">${up.ch.title} · section ${up.idx + 1} of ${up.total}</div>
        <div class="next-up-progress"><span class="meta-progress-bar" role="progressbar" aria-label="Sections understood in chapter ${up.ch.number}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pctSecs}"><span style="width:${pctSecs}%"></span></span><span>${up.done} / ${up.total} understood</span></div>
        ${up.started ? `<div class="next-up-actions"><a class="btn-primary btn-sm" href="${up.href}">Continue reading →</a></div>` : ""}
        ${upcoming.length ? `<div class="next-up-then">Then</div><ul class="next-up-list">${upcoming.map(s => `<li><a href="#/${up.ch.id}/learn/${s.id}">${s.title}</a></li>`).join("")}</ul>` : ""}
      </div>
      <div class="next-up-side">
        <div class="next-up-label">Practice chapter ${up.ch.number}</div>
        <a class="practice-link" href="#/${up.ch.id}/flashcards"><span class="practice-icon" aria-hidden="true">⧉</span><span><strong>Flashcards</strong><small>${up.ch.concepts.length + up.ch.interview.length} cards</small></span></a>
        <a class="practice-link" href="#/${up.ch.id}/interview"><span class="practice-icon" aria-hidden="true">?</span><span><strong>Interview Q&amp;A</strong><small>${chapterCounts(up.ch).q} / ${up.ch.interview.length} reviewed</small></span></a>
        <a class="practice-link" href="#/quiz"><span class="practice-icon" aria-hidden="true">✓</span><span><strong>Quiz mode</strong><small>${toRevisit ? `${toRevisit} to revisit` : "All chapters, shuffled"}</small></span></a>
      </div>
    </section>`;
  } else if (chapters().length) {
    nextHtml = `<section class="next-up next-up-done"><div class="next-up-main"><div class="next-up-label">All sections understood</div><h2 class="next-up-title">You've worked through every deep dive.</h2><div class="next-up-meta">Keep it fresh with <a href="#/quiz">Quiz mode</a>${toRevisit ? ` (${toRevisit} to revisit)` : ""} and the <a href="#/cheatsheet">printable cheat sheet</a>.</div></div></section>`;
  }

  const stat = (label, val, total) => {
    const pct = total ? Math.round((val / total) * 100) : 0;
    return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${val}<span class="small"> / ${total}</span></div><div class="stat-bar" aria-hidden="true"><span style="width:${pct}%"></span></div></div>`;
  };
  // Returning readers get "Continue reading" in the Next-up card above, so the hero offers the extras.
  const cta = !up ? `<a class="btn-primary" href="#/quiz">Test yourself in Quiz mode →</a>`
    : up.started ? `<a class="btn-ghost" href="#/quiz">✓ Quiz mode</a>`
    : `<a class="btn-primary" href="${up.href}">Start with Chapter ${up.ch.number} →</a>`;

  const returning = up && up.started;
  m.innerHTML = `
    ${returning ? nextHtml : ""}
    <div class="dash-hero ${returning ? "is-compact" : ""}">
      <div class="dash-hero-text">
        <div class="chapter-label">Interactive companion · Martin Kleppmann's DDIA</div>
        <h1>Designing Data-Intensive Applications</h1>
        <p>Every big idea in the book, explained from first principles: <strong>why it was needed</strong>, <strong>how it works</strong> (with visualizations you can play with), and <strong>where you'll meet it in production</strong>. Then drill it with cheat sheets, interview questions and flashcards.</p>
        <div class="dash-cta">
          ${cta}
          <a class="btn-ghost" href="#/viz">▶ Visualization lab${vizTotal ? ` (${vizTotal})` : ""}</a>
        </div>
      </div>
      <div class="dash-hero-art" aria-hidden="true">${heroArt()}</div>
    </div>
    ${returning ? "" : nextHtml}
    <div class="dash-stats">
      <div class="stat-card stat-overall"><div class="stat-label">Overall</div><div class="stat-value">${overall}%</div><div class="stat-bar" aria-hidden="true"><span style="width:${overall}%"></span></div></div>
      ${stat(`Sections<span class="hide-sm"> understood</span>`, k.s, k.sTotal)}
      ${stat(`Concepts<span class="hide-sm"> learned</span>`, k.c, k.cTotal)}
      ${stat(`Q&amp;A<span class="hide-sm"> reviewed</span>`, k.q, k.qTotal)}
    </div>
    <h2 class="dash-h2">The map of the book</h2>
    <p class="dash-sub">Part I is about a single machine, Part II spreads data across many, and Part III builds systems out of other systems.</p>
    <div class="book-map">${partCols}</div>
    <div class="dash-howto">
      <strong>How to use this:</strong> Start each chapter with the <em>Deep Dive</em> (story → problem → idea → interactive visualization → real-world → trade-offs). Mark sections as understood, then lock it in with <em>Concepts</em>, the <em>Cheatsheet</em>, <em>Interview Q&amp;A</em> and <em>Flashcards</em>. Progress saves in this browser; use <strong>Export</strong>/<strong>Import</strong> (in the ⋯ menu on small screens) to move it between devices.<span class="touch-hide"> Press <kbd>/</kbd> to search anywhere, and <kbd>j</kbd>/<kbd>k</kbd> to jump between deep-dive sections.</span>
    </div>
  `;
}

function heroArt() {
  // Small decorative diagram: a log feeding replicas and derived views.
  return `<svg viewBox="0 0 284 180" class="hero-svg">
    <defs><marker id="ha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="ha-fill"/></marker></defs>
    <g class="hero-log">${[0, 1, 2, 3, 4, 5, 6].map(i => `<rect x="${14 + i * 24}" y="76" width="20" height="28" rx="4" style="animation-delay:${i * 0.35}s"/>`).join("")}</g>
    <text x="14" y="66" class="hero-lbl">append-only log</text>
    <path d="M186 90 C205 90 205 40 222 40" class="hero-edge" marker-end="url(#ha)"/>
    <path d="M186 90 L222 90" class="hero-edge" marker-end="url(#ha)"/>
    <path d="M186 90 C205 90 205 140 222 140" class="hero-edge" marker-end="url(#ha)"/>
    <circle cx="238" cy="40" r="14" class="hero-node n1"/><circle cx="238" cy="90" r="14" class="hero-node n2"/><circle cx="238" cy="140" r="14" class="hero-node n3"/>
    <text x="238" y="166" class="hero-lbl" text-anchor="middle">derived views</text>
  </svg>`;
}

// ============================================================
// VISUALIZATION LAB (gallery) + standalone viz page
// ============================================================
function renderGallery(m) {
  const allGroups = chapters().map(ch => ({ ch, items: vizBlocks(ch) })).filter(g => g.items.length);
  const total = allGroups.reduce((n, g) => n + g.items.length, 0);
  const filter = state.route.filter || null;
  const groups = filter ? allGroups.filter(g => g.ch.id === filter) : allGroups;
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const fch = filter && getChapter(filter);
  const chip = (href, label, active, title, n) =>
    `<a class="chip ${active ? "is-active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}${title ? ` title="${escapeAttr(title)}"` : ""}>${label}${n != null ? ` <span class="chip-count">${n}</span>` : ""}</a>`;
  m.innerHTML = `
    <header class="chapter-header">
      <div class="chapter-label">Visualization lab</div>
      <h1>Play with the ideas</h1>
      <p class="chapter-tagline">${total} interactive visualizations across the book. Each one opens on its own page, and links back to the section that explains it.</p>
    </header>
    ${allGroups.length ? `<div class="lab-toolbar">
      <nav class="chip-row" aria-label="Filter by chapter">
        ${chip("#/viz", "All", !filter, "", total)}
        ${allGroups.map(g => chip(`#/viz/${g.ch.id}`, `Ch ${g.ch.number}`, filter === g.ch.id, `Chapter ${g.ch.number}: ${stripTags(g.ch.title)}`)).join("")}
      </nav>
      <input type="search" class="tool-filter" id="vizFilter" placeholder="Filter ${shown} visualizations…" aria-label="Filter visualizations" autocomplete="off">
    </div>` : ""}
    ${groups.length ? groups.map(g => `
      <section class="gallery-group">
        <h2 class="gallery-h2"><span class="chapter-num">${g.ch.number}</span><span>${g.ch.title}</span><a class="gallery-h2-link" href="#/${g.ch.id}">Read the chapter →</a></h2>
        <div class="gallery-grid">${g.items.map(v => `
          <a class="gallery-card" href="#/viz/${v.id}" data-text="${escapeAttr(stripTags(`${v.title || v.id} ${v.caption || ""} ${v.section.title || ""}`).toLowerCase())}">
            <div class="gallery-title"><span class="gallery-play" aria-hidden="true">▶</span><span>${v.title || v.id}</span></div>
            ${v.caption ? `<div class="gallery-cap">${escapeHtml(truncate(stripTags(v.caption), 200))}</div>` : ""}
            <div class="gallery-sec">§ ${v.section.title}</div>
          </a>`).join("")}</div>
      </section>`).join("") : `<div class="empty-tab">${filter && fch ? `No visualizations in Chapter ${fch.number} yet.` : "Visualizations are on their way."}</div>`}
    <div class="empty-tab filter-empty" id="vizEmpty" hidden></div>
  `;
  const f = m.querySelector("#vizFilter");
  if (f) f.addEventListener("input", () => {
    const q = f.value.toLowerCase().trim();
    let visible = 0;
    m.querySelectorAll(".gallery-card").forEach(c => { c.hidden = !!q && !c.dataset.text.includes(q); if (!c.hidden) visible++; });
    m.querySelectorAll(".gallery-group").forEach(g => { g.hidden = !g.querySelector(".gallery-card:not([hidden])"); });
    const empty = m.querySelector("#vizEmpty");
    empty.hidden = visible > 0;
    empty.innerHTML = `No visualizations match “${escapeHtml(f.value.trim())}”${filter ? ` in Chapter ${fch.number}. <a href="#/viz">Search all chapters</a>` : ""}.`;
  });
}

function renderStandaloneViz(m, vizId) {
  const all = allVizBlocks();
  const i = all.findIndex(v => v.id === vizId);
  const block = i >= 0 ? all[i] : null;
  const ch = block ? block.chapter : getChapter(vizId.split("/")[0]);
  const prev = i > 0 ? all[i - 1] : null;
  const next = i >= 0 && i < all.length - 1 ? all[i + 1] : null;
  const title = block && block.title ? block.title : escapeHtml(vizId); // vizId comes from the URL
  m.innerHTML = `
    <header class="chapter-header viz-page-header">
      <nav class="chapter-label crumbs" aria-label="Breadcrumb"><a href="#/viz">Visualization lab</a>${ch ? ` <span aria-hidden="true">›</span> <a href="#/viz/${ch.id}">Chapter ${ch.number}: ${ch.title}</a>` : ""}${i >= 0 ? ` <span class="crumb-count">${i + 1} of ${all.length}</span>` : ""}</nav>
      <h1>${title}</h1>
      ${block && block.caption ? `<div class="viz-try"><div class="viz-try-label">Try this</div><div class="viz-try-body">${block.caption}</div></div>` : ""}
    </header>
    ${block ? Viz.frameHTML({ id: vizId, title: block.title || "", caption: "", standalone: true }) : ""}
    ${block ? `<div class="standalone-links"><a class="btn-ghost" href="#/${ch.id}/learn/${block.section.id}">Read the explanation: ${block.section.title} →</a></div>` : ""}
    ${block ? `<div class="chapter-footer">
      ${prev ? `<a class="nav-btn" href="#/viz/${prev.id}"><div class="nav-btn-label">← Previous visualization</div>${prev.title || prev.id}</a>` : "<div></div>"}
      ${next ? `<a class="nav-btn right" href="#/viz/${next.id}"><div class="nav-btn-label">Next visualization →</div>${next.title || next.id}</a>` : "<div></div>"}
    </div>` : `<div class="empty-tab">This visualization isn't listed in any chapter. <a href="#/viz">Browse the lab</a>.</div>`}
  `;
}

// ============================================================
// GLOSSARY + PRINTABLE CHEAT SHEET
// ============================================================
// ============================================================
// QUIZ MODE: every "check yourself" question across the book, shuffled
// ============================================================
let quizSession = null; // { deck: [...], i, score, answered, missed: [] }

function allQuizzes() {
  const out = [];
  chapters().forEach(ch => sectionsOf(ch).forEach(sec => (sec.blocks || []).forEach((b, bi) => {
    if (b.type === "quiz") out.push({ ...b, ch, sec, key: `${ch.id}/${sec.id}/${bi}` });
  })));
  return out;
}
function quizStats() {
  if (!state.quiz) state.quiz = { right: {}, wrong: {} };
  return state.quiz;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const QUIZ_SIZES = [10, 20, 0]; // 0 = every selected question
function quizHeader(extra) {
  return `<header class="chapter-header"><div class="chapter-label">Practice</div><h1>Quiz mode</h1>${extra || ""}</header>`;
}
function renderQuiz(m) {
  if (!DDIA.allDeepLoaded()) {
    m.innerHTML = quizHeader() + loadingHtml("Gathering questions from every chapter…");
    DDIA.loadAllDeep().then(() => { if (state.route.view === "quiz") renderQuiz(m); })
      .catch(err => {
        const box = m.querySelector(".dd-loading");
        if (!box) return;
        box.outerHTML = `<div class="empty-tab" role="alert"><p>Couldn't load the quizzes (${escapeHtml(err.message)}).</p><button type="button" class="btn-ghost" id="quizRetryLoad">Try again</button></div>`;
        m.querySelector("#quizRetryLoad").addEventListener("click", () => renderQuiz(m));
      });
    return;
  }
  const all = allQuizzes();
  const qs = quizStats();
  if (!all.length) {
    m.innerHTML = quizHeader() + `<div class="empty-tab">Quizzes appear here as deep dives are added.</div>`;
    return;
  }
  if (!quizSession) return renderQuizSetup(m, all, qs);
  const S = quizSession;
  if (S.i >= S.deck.length) return renderQuizResults(m, S);

  const q = S.deck[S.i];
  m.innerHTML = `
    <header class="chapter-header quiz-run-header">
      <div class="quiz-run-top">
        <div class="chapter-label">Question ${S.i + 1} of ${S.deck.length} · ${S.score} right</div>
        <button type="button" class="btn-link" id="quizQuit">End round</button>
      </div>
      <div class="meta-progress-bar quiz-progress" role="progressbar" aria-label="Round progress" aria-valuemin="0" aria-valuemax="${S.deck.length}" aria-valuenow="${S.i}"><span style="width:${(S.i / S.deck.length) * 100}%"></span></div>
    </header>
    <div class="quiz quiz-solo">
      <div class="quiz-head"><span class="quiz-chip">Ch ${q.ch.number} · ${q.sec.title}</span><div class="quiz-q" id="quizQ">${q.q}</div></div>
      <div class="quiz-opts" role="group" aria-labelledby="quizQ">${q.options.map((o, i) => `<button type="button" class="quiz-opt" data-i="${i}"><span class="quiz-letter">${"ABCDEF"[i]}</span><span>${o}</span></button>`).join("")}</div>
      <div class="quiz-explain" hidden aria-live="polite"><strong class="quiz-verdict"></strong> ${q.explain || ""}
        <div class="quiz-actions"><a href="#/${q.ch.id}/learn/${q.sec.id}" class="quiz-retry">Read the section →</a><button type="button" class="btn-primary" id="quizNext">${S.i + 1 < S.deck.length ? "Next question →" : "See results"}</button></div>
      </div>
    </div>
    <p class="kbd-tip quiz-keys">Keys: <kbd>A</kbd>–<kbd>${"ABCDEF"[q.options.length - 1]}</kbd> or <kbd>1</kbd>–<kbd>${q.options.length}</kbd> to answer · <kbd>Enter</kbd> next</p>`;
  const box = m.querySelector(".quiz");
  m.querySelectorAll(".quiz-opt").forEach(btn => btn.addEventListener("click", () => {
    if (box.classList.contains("answered")) return;
    box.classList.add("answered");
    const ok = +btn.dataset.i === q.answer;
    btn.classList.add(ok ? "is-correct" : "is-wrong");
    m.querySelector(`.quiz-opt[data-i="${q.answer}"]`).classList.add("is-correct");
    m.querySelectorAll(".quiz-opt").forEach(o => o.setAttribute("aria-disabled", "true"));
    const ex = m.querySelector(".quiz-explain");
    ex.hidden = false; ex.classList.add(ok ? "tone-ok" : "tone-bad");
    ex.querySelector(".quiz-verdict").textContent = ok ? "Correct." : "Not quite.";
    if (ok) { S.score++; qs.right[q.key] = true; delete qs.wrong[q.key]; } else { qs.wrong[q.key] = true; S.missed.push(q); }
    saveState();
    S.answered = true;
    const nextBtn = m.querySelector("#quizNext");
    nextBtn.focus({ preventScroll: true });
    // On a phone the explanation lands below the fold: bring it (and the Next button) into view.
    const r = ex.getBoundingClientRect();
    if (r.bottom > window.innerHeight) ex.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }));
  m.querySelector("#quizNext").addEventListener("click", () => { S.i++; S.answered = false; renderQuiz(m); window.scrollTo(0, 0); });
  m.querySelector("#quizQuit").addEventListener("click", () => { S.deck = S.deck.slice(0, S.i + (S.answered ? 1 : 0)); S.i = S.deck.length; renderQuiz(m); window.scrollTo(0, 0); });
}

function renderQuizSetup(m, all, qs) {
  const byCh = chapters().map(ch => {
    const list = all.filter(q => q.ch.id === ch.id);
    return { ch, n: list.length, right: list.filter(q => qs.right[q.key] && !qs.wrong[q.key]).length };
  }).filter(x => x.n);
  const mastered = all.filter(q => qs.right[q.key] && !qs.wrong[q.key]).length;
  const missed = all.filter(q => qs.wrong[q.key]).length;
  const size = QUIZ_SIZES.includes(ui.quizSize) ? ui.quizSize : 10;
  m.innerHTML = quizHeader(`<p class="chapter-tagline">${all.length} questions from every deep dive, shuffled. They test understanding, not recall: read the explanation even when you get one right.</p>`) + `
    <div class="dash-stats stats-3">
      <div class="stat-card"><div class="stat-label">Questions</div><div class="stat-value">${all.length}</div></div>
      <div class="stat-card"><div class="stat-label">Got right</div><div class="stat-value">${mastered}</div></div>
      <div class="stat-card"><div class="stat-label">To revisit</div><div class="stat-value">${missed}</div></div>
    </div>
    <div class="quiz-setup">
      <div class="quiz-setup-row">
        <div class="dd-block-title" id="quizChLabel">Chapters</div>
        <div class="quiz-quick" role="group" aria-label="Quick select">
          <button type="button" class="btn-link" data-pick="all">All</button>
          <button type="button" class="btn-link" data-pick="none">None</button>
          ${[1, 2, 3].map(pn => `<button type="button" class="btn-link" data-pick="part${pn}">Part ${ROMAN[pn]}</button>`).join("")}
        </div>
      </div>
      <div class="quiz-chips" role="group" aria-labelledby="quizChLabel">${byCh.map(x => `<label class="quiz-chip-toggle" title="Chapter ${x.ch.number}: ${escapeAttr(stripTags(x.ch.title))} (${x.right} of ${x.n} answered right)"><input type="checkbox" value="${x.ch.id}" data-part="${x.ch.part}" checked><span class="qct-num">${x.ch.number}</span><span class="qct-title">${x.ch.title}</span><span class="qct-count">${x.right}/${x.n}</span></label>`).join("")}</div>
      <div class="quiz-setup-row quiz-setup-go">
        <div class="seg" role="group" aria-label="Round length">${QUIZ_SIZES.map(n => `<button type="button" class="seg-btn ${n === size ? "is-active" : ""}" data-size="${n}" aria-pressed="${n === size}">${n ? n + " questions" : "All"}</button>`).join("")}</div>
        <button class="btn-primary" id="quizStart"></button>
        ${missed ? `<button class="btn-ghost" id="quizMissed">Retry the ${missed} I missed</button>` : ""}
      </div>
    </div>`;
  let curSize = size;
  const selected = () => Array.from(m.querySelectorAll(".quiz-chips input:checked")).map(i => i.value);
  const pool = () => all.filter(q => selected().includes(q.ch.id));
  const startBtn = m.querySelector("#quizStart");
  const sync = () => {
    const n = pool().length;
    const take = curSize ? Math.min(curSize, n) : n;
    startBtn.disabled = !n;
    startBtn.textContent = n ? `Start: ${take} question${take === 1 ? "" : "s"} →` : "Pick at least one chapter";
  };
  sync();
  m.querySelectorAll(".quiz-chips input").forEach(i => i.addEventListener("change", sync));
  m.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
    const pick = b.dataset.pick;
    m.querySelectorAll(".quiz-chips input").forEach(i => { i.checked = pick === "all" || (pick !== "none" && pick === "part" + i.dataset.part); });
    sync();
  }));
  m.querySelectorAll("[data-size]").forEach(b => b.addEventListener("click", () => {
    curSize = +b.dataset.size;
    ui.quizSize = curSize; saveUi();
    m.querySelectorAll("[data-size]").forEach(x => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
    sync();
  }));
  const start = (deck) => {
    if (!deck.length) { showToast("Pick at least one chapter."); return; }
    quizSession = { deck, i: 0, score: 0, answered: false, missed: [] };
    renderQuiz(m);
    window.scrollTo(0, 0);
  };
  startBtn.addEventListener("click", () => { const d = shuffle(pool()); start(curSize ? d.slice(0, curSize) : d); });
  const mb = m.querySelector("#quizMissed");
  if (mb) mb.addEventListener("click", () => start(shuffle(all.filter(q => qs.wrong[q.key]))));
}

function renderQuizResults(m, S) {
  const n = S.deck.length;
  if (!n) { quizSession = null; return renderQuiz(m); }
  const pct = Math.round((S.score / n) * 100);
  const verdict = pct >= 80 ? "Excellent" : pct >= 50 ? "Good progress" : "Keep going";
  m.innerHTML = quizHeader(`<p class="chapter-tagline">${verdict}: <strong>${S.score} of ${n}</strong> right (${pct}%). ${S.missed.length ? "The ones you missed are saved, so you can drill them later from the quiz start page." : "Nothing missed this round."}</p>`).replace("<h1>Quiz mode</h1>", "<h1>Round complete</h1>") + `
    <div class="meta-progress-bar quiz-progress quiz-score" aria-hidden="true"><span style="width:${pct}%"></span></div>
    ${S.missed.length ? `<h2 class="dash-h2">Review what you missed</h2>
    <ol class="quiz-missed">${S.missed.map(q => `<li><div class="quiz-missed-q">${q.q}</div><div class="quiz-missed-a"><span class="muted">Answer:</span> ${q.options[q.answer]}</div><a href="#/${q.ch.id}/learn/${q.sec.id}">Ch ${q.ch.number} · ${q.sec.title} →</a></li>`).join("")}</ol>` : ""}
    <div class="dash-cta">
      ${S.missed.length ? `<button class="btn-primary" id="quizRetryRound">Retry these ${S.missed.length}</button>` : ""}
      <button class="${S.missed.length ? "btn-ghost" : "btn-primary"}" id="quizAgain">New round</button>
    </div>`;
  m.querySelector("#quizAgain").addEventListener("click", () => { quizSession = null; renderQuiz(m); window.scrollTo(0, 0); });
  const rr = m.querySelector("#quizRetryRound");
  if (rr) rr.addEventListener("click", () => { quizSession = { deck: shuffle(S.missed), i: 0, score: 0, answered: false, missed: [] }; renderQuiz(m); window.scrollTo(0, 0); });
}

function renderGlossary(m) {
  const all = chapters().flatMap(ch => ch.concepts.map(c => ({ c, ch })));
  all.sort((a, b) => stripTags(a.c.term).localeCompare(stripTags(b.c.term), undefined, { sensitivity: "base" }));
  const groups = {};
  all.forEach(x => {
    const L = (stripTags(x.c.term)[0] || "#").toUpperCase();
    const key = /[A-Z]/.test(L) ? L : "#";
    (groups[key] = groups[key] || []).push(x);
  });
  const letters = Object.keys(groups).sort();
  const learnedTotal = all.filter(({ c, ch }) => getChapterProgress(ch.id).concepts[c.id]).length;
  m.innerHTML = `
    <header class="chapter-header">
      <div class="chapter-label">Reference</div>
      <h1>Glossary</h1>
      <p class="chapter-tagline">${all.length} terms from across the book, A–Z. Click any term to jump to it in its chapter.</p>
      <div class="glossary-tools">
        <input type="search" class="tool-filter glossary-filter" id="glossaryFilter" placeholder="Filter terms and definitions…" aria-label="Filter glossary" autocomplete="off" />
        <select class="tool-select" id="glossaryChapter" aria-label="Only show terms from one chapter">
          <option value="">All chapters</option>
          ${chapters().filter(ch => ch.concepts.length).map(ch => `<option value="${ch.id}">Ch ${ch.number} · ${escapeHtml(stripTags(ch.title))}</option>`).join("")}
        </select>
        <span class="glossary-count muted" id="glossaryCount" aria-live="polite">${all.length} terms · ${learnedTotal} learned</span>
      </div>
    </header>
    <nav class="glossary-letters" aria-label="Jump to letter">${letters.map(L => `<a href="#gl-${L}" data-letter="${L}">${L}</a>`).join("")}</nav>
    <div class="glossary">${letters.map(L => `
      <div class="gl-group" id="gl-${L}"><div class="gl-letter">${L}</div>
      ${groups[L].map(({ c, ch }) => {
        const learned = !!getChapterProgress(ch.id).concepts[c.id];
        return `
        <a class="gl-item ${learned ? "is-learned" : ""}" href="#/${ch.id}/concepts/${c.id}" data-ch="${ch.id}" data-text="${escapeAttr(stripTags(c.term + " " + c.def).toLowerCase())}">
          <div class="gl-term"><span>${c.term.replace(/<\/?a\b[^>]*>/gi, "")}</span><span class="gl-ch" title="${escapeAttr(stripTags(ch.title))}">Ch ${ch.number}</span>${learned ? `<span class="gl-learned" title="Learned" aria-label="learned">✓</span>` : ""}</div>
          <div class="gl-def">${c.def.replace(/<\/?a\b[^>]*>/gi, "")}</div>
        </a>`;
      }).join("")}</div>`).join("")}
    </div>
    <div class="empty-tab filter-empty" id="glossaryEmpty" hidden></div>`;
  m.querySelectorAll(".glossary-letters a").forEach(a => a.addEventListener("click", e => {
    e.preventDefault();
    if (a.classList.contains("is-empty")) return;
    const el = document.getElementById("gl-" + a.dataset.letter);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  const f = document.getElementById("glossaryFilter");
  const sel = document.getElementById("glossaryChapter");
  const apply = () => {
    const q = f.value.toLowerCase().trim();
    const chId = sel.value;
    let n = 0;
    m.querySelectorAll(".gl-item").forEach(it => {
      it.hidden = (q && !it.dataset.text.includes(q)) || (chId && it.dataset.ch !== chId);
      if (!it.hidden) n++;
    });
    m.querySelectorAll(".gl-group").forEach(g => {
      g.hidden = !g.querySelector(".gl-item:not([hidden])");
      const link = m.querySelector(`.glossary-letters a[data-letter="${g.id.slice(3)}"]`);
      if (link) { link.classList.toggle("is-empty", g.hidden); link.setAttribute("aria-disabled", String(g.hidden)); }
    });
    document.getElementById("glossaryCount").textContent = q || chId ? `${n} of ${all.length} terms` : `${all.length} terms · ${learnedTotal} learned`;
    const empty = document.getElementById("glossaryEmpty");
    empty.hidden = n > 0;
    empty.textContent = `No terms match “${f.value.trim()}”${chId ? " in this chapter" : ""}. Try a shorter word, or search the whole site with /.`;
  };
  f.addEventListener("input", apply);
  sel.addEventListener("change", apply);
}

function renderAllCheatsheets(m) {
  const list = chapters().filter(ch => ch.cheatsheet.length);
  m.innerHTML = `
    <header class="chapter-header allcs-header">
      <div class="chapter-label">Reference</div>
      <h1>The whole book, cheat-sheet style</h1>
      <p class="chapter-tagline">Every chapter's cheat sheet in one place. Print it (or save it as a PDF) for a compact, ink-friendly version.</p>
      <div class="allcs-actions">
        <button type="button" class="btn-primary" id="printBtn">🖨 Print / save as PDF</button>
        <span class="muted allcs-hint">or press ⌘/Ctrl + P</span>
      </div>
    </header>
    <nav class="chip-row allcs-jump" aria-label="Jump to chapter">${list.map(ch => `<a class="chip" href="#cs-${ch.id}" data-jump="${ch.id}" title="Chapter ${ch.number}: ${escapeAttr(stripTags(ch.title))}">Ch ${ch.number}</a>`).join("")}</nav>
    ${list.length ? list.map(ch => `
      <section class="allcs-chapter" id="cs-${ch.id}">
        <h2 class="allcs-h2"><span class="chapter-num">${ch.number}</span><span>${ch.title}</span><a class="allcs-open" href="#/${ch.id}/cheatsheet">Open in chapter →</a></h2>
        ${ch.cheatsheet.map(renderCheatsheetBlock).join("")}
      </section>`).join("") : `<div class="empty-tab">No cheat sheets yet.</div>`}`;
  m.querySelector("#printBtn").addEventListener("click", () => window.print());
  m.querySelectorAll("[data-jump]").forEach(a => a.addEventListener("click", e => {
    e.preventDefault();
    const el = document.getElementById("cs-" + a.dataset.jump);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

// ============================================================
// SEARCH
// ============================================================
let _searchIndex = null;
function buildSearchIndex() {
  const idx = [];
  chapters().forEach(ch => {
    ch.concepts.forEach(c => idx.push({
      ch, kind: "Concept", title: c.term, snippet: stripTags(c.def),
      hay: stripTags(`${c.term} ${c.def} ${c.why || ""} ${c.ex || ""} ${c.problem || ""}`).toLowerCase(),
      href: `#/${ch.id}/concepts/${c.id}`,
    }));
    sectionsOf(ch).forEach(s => {
      const text = stripTags((s.blocks || []).map(blockText).join(" "));
      idx.push({ ch, kind: "Deep dive", title: s.title, snippet: text.slice(0, 140), hay: (s.title + " " + text).toLowerCase(), href: `#/${ch.id}/learn/${s.id}`, boost: 1 });
      (s.blocks || []).filter(b => b.type === "viz").forEach(b => idx.push({
        ch, kind: "Visualization", title: b.title || b.id, snippet: stripTags(b.caption || ""),
        hay: `${b.title || ""} ${stripTags(b.caption || "")}`.toLowerCase(), href: `#/viz/${b.id}`, boost: 1,
      }));
    });
    ch.interview.forEach(x => idx.push({
      ch, kind: "Q&A", title: x.q, snippet: stripTags(x.a).slice(0, 120) + "…",
      hay: stripTags(x.q + " " + x.a).toLowerCase(), href: `#/${ch.id}/interview/${x.id}`,
    }));
    ch.cheatsheet.forEach(cs => idx.push({
      ch, kind: "Cheatsheet", title: cs.title, snippet: "",
      hay: stripTags(cs.title + " " + JSON.stringify(cs.rows || cs.items || cs.body || "")).toLowerCase(), href: `#/${ch.id}/cheatsheet`,
    }));
  });
  return idx;
}
function runSearch(q) {
  const qq = q.toLowerCase().trim();
  if (qq.length < 2) return [];
  if (!_searchIndex) _searchIndex = buildSearchIndex();
  const terms = qq.split(/\s+/);
  const scored = [];
  _searchIndex.forEach(it => {
    if (!terms.every(t => it.hay.includes(t))) return;
    const titleL = stripTags(it.title).toLowerCase();
    let score = (it.boost || 0);
    if (titleL.includes(qq)) score += 5;
    if (titleL.startsWith(qq)) score += 3;
    scored.push({ it, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 30).map(x => x.it);
}
function highlight(text, q) {
  const safe = escapeHtml(stripTags(text));
  const t = q.trim();
  if (t.length < 2) return safe;
  const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
  return safe.replace(re, "<mark>$1</mark>");
}
let _deepForSearch = false;
function renderSearch(q) {
  if (!_deepForSearch && q.trim().length >= 2 && !DDIA.allDeepLoaded()) {
    _deepForSearch = true;
    DDIA.loadAllDeep().then(() => {
      _searchIndex = null;
      const box = document.getElementById("searchBox");
      if (box && box.value.trim().length >= 2 && document.activeElement === box) renderSearch(box.value);
    }).catch(() => { _deepForSearch = false; });
  }
  const box = document.getElementById("searchResults");
  const rs = runSearch(q);
  if (!rs.length) {
    box.classList.toggle("open", q.trim().length >= 2);
    box.innerHTML = q.trim().length >= 2 ? `<div class="sr-empty">No matches for “${escapeHtml(q)}”</div>` : "";
    return;
  }
  box.innerHTML = `<div class="sr-count">${rs.length === 30 ? "Top 30" : rs.length} result${rs.length === 1 ? "" : "s"}<span class="sr-keys"> · <kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open</span></div>` + rs.map((r, i) => `
    <a class="sr-item ${i === 0 ? "is-active" : ""}" href="${r.href}" role="option" id="sr-${i}" aria-selected="${i === 0}">
      <div class="sr-label">Ch ${r.ch.number} · ${r.kind}</div>
      <div class="sr-title">${highlight(r.title, q)}</div>
      ${r.snippet ? `<div class="sr-snippet">${highlight(r.snippet, q)}</div>` : ""}
    </a>`).join("");
  box.classList.add("open");
  document.getElementById("searchBox").setAttribute("aria-activedescendant", "sr-0");
  box.querySelectorAll(".sr-item").forEach(el => el.addEventListener("click", () => {
    document.getElementById("searchBox").value = "";
    closeSearch();
  }));
}
function moveSearchSelection(delta) {
  const items = Array.from(document.querySelectorAll("#searchResults .sr-item"));
  if (!items.length) return;
  let i = items.findIndex(el => el.classList.contains("is-active"));
  i = (i + delta + items.length) % items.length;
  items.forEach((el, j) => { el.classList.toggle("is-active", j === i); el.setAttribute("aria-selected", String(j === i)); });
  items[i].scrollIntoView({ block: "nearest" });
  document.getElementById("searchBox").setAttribute("aria-activedescendant", items[i].id);
}

// ============================================================
// EXPORT / IMPORT / THEME / RESET
// ============================================================
function doExport() {
  const payload = { app: "ddia-notes", version: 2, exportedAt: new Date().toISOString(), progress: state.progress, quiz: state.quiz, theme: state.theme };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ddia-progress-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Progress exported. Transfer this file to your other device and use ⬆ Import there.");
}
function doImportPick() { document.getElementById("importFile").click(); }
function doToggleTheme() {
  state.theme = currentTheme() === "light" ? "dark" : "light";
  saveState();
  applyTheme();
}
function doReset() {
  if (confirm("Reset all progress? This cannot be undone.")) {
    state.progress = {};
    saveState();
    render();
  }
}
function mergeProgress(incoming) {
  Object.keys(incoming).forEach(chId => {
    const cur = getChapterProgress(chId);
    const inc = incoming[chId] || {};
    ["concepts", "qa", "sections"].forEach(k => { cur[k] = Object.assign({}, cur[k] || {}, inc[k] || {}); });
  });
}

// ============================================================
// INIT
// ============================================================
function init() {
  window.__DDIA_ERRORS = window.__DDIA_ERRORS || [];
  // ?w=390 lays the page out at that width inside a wider window (headless Chrome can't make
  // windows narrower than ~500px); used by scripts/shoot.sh for phone screenshots.
  const forcedW = +((location.search.match(/[?&]w=(\d+)/) || [])[1] || 0);
  if (forcedW) {
    document.documentElement.style.overflowX = "hidden";
    Object.assign(document.body.style, { width: forcedW + "px", maxWidth: forcedW + "px", margin: "0", overflowX: "hidden" });
  }
  window.addEventListener("error", e => window.__DDIA_ERRORS.push({ error: String(e.message), src: e.filename + ":" + e.lineno }));
  loadState();
  loadUi();

  document.getElementById("themeToggle").addEventListener("click", doToggleTheme);
  document.getElementById("resetBtn").addEventListener("click", doReset);
  document.getElementById("exportBtn").addEventListener("click", doExport);
  document.getElementById("importBtn").addEventListener("click", doImportPick);
  document.getElementById("importFile").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || typeof data !== "object" || !data.progress) throw new Error("File doesn't look like a DDIA progress export.");
        const incoming = normalizeProgress(data.progress);
        const merge = confirm("Import progress:\n\nOK = MERGE with your current progress (anything already marked stays marked)\nCancel = REPLACE your current progress with the file");
        if (merge) mergeProgress(incoming); else state.progress = incoming;
        if (data.quiz) {
          const qs = quizStats();
          if (merge) { Object.assign(qs.right, data.quiz.right || {}); Object.assign(qs.wrong, data.quiz.wrong || {}); }
          else state.quiz = { right: data.quiz.right || {}, wrong: data.quiz.wrong || {} };
        }
        if (data.theme) { state.theme = data.theme; applyTheme(); }
        saveState();
        render();
        showToast("Progress imported successfully.");
      } catch (err) {
        showToast("Import failed: " + err.message, true);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("menuToggle").addEventListener("click", e => { e.stopPropagation(); toggleDrawer(); });
  document.getElementById("backdrop").addEventListener("click", closeDrawer);
  document.getElementById("moreToggle").addEventListener("click", e => { e.stopPropagation(); toggleMoreMenu(); });
  renderLookMenus();
  document.getElementById("lookToggle").addEventListener("click", e => { e.stopPropagation(); toggleLookMenu(); });
  document.addEventListener("click", e => { if (!e.target.closest || !e.target.closest(".look-wrap")) closeLookMenu(); });
  document.addEventListener("keydown", e => {
    const m = document.getElementById("lookMenu");
    if (!m || !m.classList.contains("open")) return;
    if (e.key === "Escape") { closeLookMenu(); document.getElementById("lookToggle").focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const opts = Array.from(m.querySelectorAll(".look-opt"));
      const i = opts.indexOf(document.activeElement);
      opts[(i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length].focus();
    }
  });
  document.querySelectorAll("#moreMenu [data-action]").forEach(b => {
    b.addEventListener("click", e => {
      e.stopPropagation();
      const action = b.dataset.action;
      closeMoreMenu();
      if (action === "export") doExport();
      else if (action === "import") doImportPick();
      else if (action === "theme") doToggleTheme();
      else if (action === "reset") doReset();
    });
  });

  const sb = document.getElementById("searchBox");
  sb.addEventListener("input", () => renderSearch(sb.value));
  sb.addEventListener("focus", () => { if (sb.value) renderSearch(sb.value); });
  sb.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSearchSelection(e.key === "ArrowDown" ? 1 : -1); }
    if (e.key === "Enter") {
      const pick = document.querySelector("#searchResults .sr-item.is-active") || document.querySelector("#searchResults .sr-item");
      if (pick) { location.hash = pick.getAttribute("href"); sb.value = ""; sb.blur(); closeSearch(); }
    }
  });
  document.getElementById("searchToggle").addEventListener("click", e => {
    e.stopPropagation();
    if (document.getElementById("topbar").classList.contains("search-open")) closeSearch(); else openSearch();
  });
  document.getElementById("skipLink").addEventListener("click", e => {
    e.preventDefault(); // "#main" would be read as a route
    const main = document.getElementById("main");
    main.focus();
    main.scrollIntoView();
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrap") && !e.target.closest("#searchToggle")) {
      document.getElementById("searchResults").classList.remove("open");
      if (!sb.value) closeSearch();
    }
    if (!e.target.closest(".more-wrap")) closeMoreMenu();
  });

  document.addEventListener("keydown", e => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (e.key === "Escape") {
        e.target.blur();
        if (e.target === sb) { closeSearch(); if (document.getElementById("searchToggle").offsetParent) document.getElementById("searchToggle").focus(); }
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (document.getElementById("sidebar").classList.contains("open")) closeDrawer();
      closeMoreMenu();
      closeSearch();
    }
    if (e.key === "/") { e.preventDefault(); if (document.getElementById("searchToggle").offsetParent) openSearch(); else sb.focus(); }
    // Enter / Space on a focused button or link already activate it: don't act on them twice.
    const nativeActivation = (tag === "BUTTON" || tag === "A") && (e.key === "Enter" || e.key === " ");
    const r = state.route;
    if (r.view === "quiz" && quizSession && !nativeActivation) {
      const key = e.key.toLowerCase();
      const idx = /^[1-6]$/.test(key) ? +key - 1 : "abcdef".indexOf(key.length === 1 ? key : "?");
      const box = document.querySelector(".quiz-solo");
      if (box && !box.classList.contains("answered") && idx >= 0) {
        const opt = box.querySelector(`.quiz-opt[data-i="${idx}"]`);
        if (opt) { e.preventDefault(); opt.click(); }
      } else if (box && box.classList.contains("answered") && (e.key === "Enter" || e.key === "ArrowRight" || key === "n")) {
        const nb = document.getElementById("quizNext");
        if (nb) { e.preventDefault(); nb.click(); }
      }
    }
    if (r.view === "chapter" && r.tab === "learn" && (e.key === "j" || e.key === "k")) {
      const secs = Array.from(document.querySelectorAll(".dd-section"));
      const offset = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) + 70;
      const tops = secs.map(el => el.getBoundingClientRect().top - offset);
      const target = e.key === "j" ? secs[tops.findIndex(t => t > 4)] : secs[tops.map((t, i) => [t, i]).filter(([t]) => t < -4).map(([, i]) => i).pop()];
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (r.view === "chapter" && r.tab === "flashcards" && !nativeActivation) {
      if (e.key === " ") { e.preventDefault(); flipCard(); }
      if (e.key === "ArrowRight") moveCard("next");
      if (e.key === "ArrowLeft") moveCard("prev");
      if (e.key === "g" || e.key === "G") moveCard("known");
    }
  });

  window.addEventListener("resize", () => { if (!isMobile()) { closeDrawer(); closeSearch(); } });
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => { if (!state.theme) applyTheme(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
  }

  // Reading progress bar for long deep dives
  const bar = document.getElementById("readBar");
  window.addEventListener("scroll", () => {
    if (!bar) return;
    const show = state.route.view === "chapter" && state.route.tab === "learn";
    const h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = show && h > 0 ? Math.min(100, (window.scrollY / h) * 100) + "%" : "0%";
  }, { passive: true });

  window.addEventListener("hashchange", onRoute);
  state.route = null;
  onRoute();
}

// ============================================================
// SELF-TEST  (index.html?selftest=1 — used by scripts/check-site.sh)
// Renders every page and tab, mounts every visualization eagerly and reports errors.
// ============================================================
async function selfTest() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await DDIA.loadAllDeep();
  _searchIndex = null;
  const report = { pages: 0, vizMounted: 0, vizFailed: [], errors: [] };
  const routes = [{ view: "dashboard" }, { view: "gallery" }, { view: "gallery", filter: "ch5" }, { view: "glossary" }, { view: "allcheats" }, { view: "quiz" }];
  chapters().forEach(ch => TABS.forEach(t => routes.push({ view: "chapter", chapterId: ch.id, tab: t.id })));
  allVizBlocks().forEach(v => routes.push({ view: "viz", vizId: v.id }));
  for (const r of routes) {
    const before = window.__DDIA_ERRORS.length;
    state.route = r;
    try {
      render();
      const m = document.getElementById("main");
      const frames = Array.from(m.querySelectorAll("figure.viz[data-viz]"));
      await Promise.all(frames.map(f => Viz.mount(f)));
      await sleep(frames.length ? 600 : 50);
      frames.forEach(f => { if (f._vizInstance) report.vizMounted++; else report.vizFailed.push(f.dataset.viz); });
      if (r.view === "chapter" && r.tab === "interview") m.querySelectorAll(".qa-header").forEach(h => h.click());
      if (r.view === "chapter" && r.tab === "flashcards") { flipCard(); moveCard("next"); }
    } catch (e) {
      window.__DDIA_ERRORS.push({ error: "render threw: " + (e.stack || e.message) });
    }
    window.__DDIA_ERRORS.slice(before).forEach(e => report.errors.push({ route: routeHash(r), ...e }));
    report.pages++;
  }
  // Search smoke test
  ["quorum", "leader", "log", "zz-no-match"].forEach(q => { try { runSearch(q); } catch (e) { report.errors.push({ route: "search", error: e.message }); } });
  report.ok = report.errors.length === 0 && report.vizFailed.length === 0;
  const pre = document.createElement("pre");
  pre.id = "__result";
  pre.hidden = true;
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
  document.title = "DONE";
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  if (/[?&]selftest=1/.test(location.search)) selfTest();
  // Screenshot mode (scripts/shoot.sh): report the rendered page height through the title.
  // Screenshot mode: report the content height through the title (main itself stretches to the
  // window, so measure its children), then move to ?y= for this tile.
  if (SHOOT_MODE) {
    document.body.classList.add("shoot");
    setTimeout(() => {
      const kids = Array.from(document.getElementById("main").children);
      const bottom = Math.max(0, ...kids.map(k => k.getBoundingClientRect().bottom));
      document.title = "H:" + Math.ceil(bottom + window.scrollY + 48);
      const y = +((location.search.match(/[?&]y=(\d+)/) || [])[1] || 0);
      // Shift the page instead of scrolling: headless Chrome doesn't repaint after a scroll.
      if (y) document.body.style.marginTop = -y + "px";
    }, 2500);
  }
});
