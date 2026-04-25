// DDIA Interactive Notes - App logic
// Depends on `DATA` global from data.js

// ============================================================
// STATE & STORAGE
// ============================================================
const STORAGE_KEY = "ddia_notes_progress_v1";
const MOBILE_BREAKPOINT = 768;

let state = {
  currentChapter: "dashboard",
  currentTab: "concepts",
  flashIndex: 0,
  flashFlipped: false,
  theme: "dark",
  progress: {} // chapter_id => { conceptsLearned: {id: true}, qaReviewed: {id: true} }
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.progress) state.progress = saved.progress;
    if (saved.theme) state.theme = saved.theme;
  } catch(e) { console.warn("Could not load state", e); }
  applyTheme();
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({progress: state.progress, theme: state.theme}));
  } catch(e) {}
}
function getChapterProgress(chId) {
  if (!state.progress[chId]) state.progress[chId] = { conceptsLearned: {}, qaReviewed: {} };
  return state.progress[chId];
}
function applyTheme() {
  document.body.classList.toggle("light", state.theme === "light");
  const t = document.getElementById("themeToggle");
  if (t) t.textContent = state.theme === "light" ? "Dark" : "Light";
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

function isMobile() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

function computeChapterPct(ch) {
  const prog = getChapterProgress(ch.id);
  const totalC = ch.concepts.length;
  const totalQ = ch.interview.length;
  const doneC = Object.keys(prog.conceptsLearned).filter(k => prog.conceptsLearned[k]).length;
  const doneQ = Object.keys(prog.qaReviewed).filter(k => prog.qaReviewed[k]).length;
  if (totalC + totalQ === 0) return 0;
  return Math.round(((doneC + doneQ) / (totalC + totalQ)) * 100);
}
function computeOverallPct() {
  if (!DATA.chapters.length) return 0;
  const totals = DATA.chapters.reduce((acc, ch) => {
    const p = getChapterProgress(ch.id);
    acc.total += ch.concepts.length + ch.interview.length;
    acc.done += Object.keys(p.conceptsLearned).filter(k=>p.conceptsLearned[k]).length;
    acc.done += Object.keys(p.qaReviewed).filter(k=>p.qaReviewed[k]).length;
    return acc;
  }, {total: 0, done: 0});
  return totals.total === 0 ? 0 : Math.round((totals.done/totals.total)*100);
}

// ============================================================
// MOBILE DRAWER
// ============================================================
function openDrawer() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("backdrop").classList.add("open");
}
function closeDrawer() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("backdrop").classList.remove("open");
}
function toggleDrawer() {
  const sb = document.getElementById("sidebar");
  if (sb.classList.contains("open")) closeDrawer(); else openDrawer();
}

function closeMoreMenu() {
  const m = document.getElementById("moreMenu");
  if (m) m.classList.remove("open");
}
function toggleMoreMenu() {
  document.getElementById("moreMenu").classList.toggle("open");
}

// ============================================================
// RENDER: sidebar
// ============================================================
function renderSidebar() {
  const sb = document.getElementById("sidebar");
  let html = `
    <div class="chapter-item ${state.currentChapter === "dashboard" ? "active" : ""}" data-chapter="dashboard">
      <div class="chapter-num">✦</div>
      <div class="chapter-title">Dashboard</div>
    </div>
  `;
  const parts = {};
  DATA.chapters.forEach(ch => {
    if (!parts[ch.part]) parts[ch.part] = [];
    parts[ch.part].push(ch);
  });
  const partNames = {
    1: "Part I · Foundations",
    2: "Part II · Distributed Data",
    3: "Part III · Derived Data"
  };
  Object.keys(parts).sort().forEach(pNum => {
    html += `<div class="part-header">${partNames[pNum] || "Part "+pNum}</div>`;
    parts[pNum].forEach(ch => {
      const pct = computeChapterPct(ch);
      const done = pct === 100;
      const r = 8, c = 2 * Math.PI * r, off = c - (pct/100) * c;
      html += `
      <div class="chapter-item ${state.currentChapter === ch.id ? "active" : ""}" data-chapter="${ch.id}">
        <div class="chapter-num">${ch.number}</div>
        <div class="chapter-title">${ch.title}</div>
        <div class="chapter-ring ${done?'done':''}">
          ${done
            ? '<div class="check">✓</div>'
            : `<svg viewBox="0 0 20 20"><circle class="bg" cx="10" cy="10" r="${r}"/><circle class="fg" cx="10" cy="10" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg>`}
        </div>
      </div>`;
    });
  });
  sb.innerHTML = html;
  sb.querySelectorAll(".chapter-item").forEach(el => {
    el.addEventListener("click", () => {
      state.currentChapter = el.dataset.chapter;
      state.currentTab = "concepts";
      state.flashIndex = 0; state.flashFlipped = false;
      if (isMobile()) closeDrawer();
      render();
      window.scrollTo(0, 0);
    });
  });
}

// ============================================================
// RENDER: main
// ============================================================
function escapeHtml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

function renderMain() {
  const m = document.getElementById("main");
  if (state.currentChapter === "dashboard") { renderDashboard(); return; }
  const ch = DATA.chapters.find(c => c.id === state.currentChapter);
  if (!ch) { m.innerHTML = "<p>Chapter not found.</p>"; return; }

  const prog = getChapterProgress(ch.id);
  const doneC = ch.concepts.filter((_,i) => prog.conceptsLearned[i]).length;
  const doneQ = ch.interview.filter((_,i) => prog.qaReviewed[i]).length;

  let tabsHtml = `
    <div class="tabs">
      <button class="tab ${state.currentTab==='concepts'?'active':''}" data-tab="concepts">Core Concepts <span class="tab-count">${doneC}/${ch.concepts.length}</span></button>
      <button class="tab ${state.currentTab==='cheatsheet'?'active':''}" data-tab="cheatsheet">Cheatsheet <span class="tab-count">${ch.cheatsheet.length}</span></button>
      <button class="tab ${state.currentTab==='interview'?'active':''}" data-tab="interview">Interview Q&amp;A <span class="tab-count">${doneQ}/${ch.interview.length}</span></button>
      <button class="tab ${state.currentTab==='flashcards'?'active':''}" data-tab="flashcards">Flashcards <span class="tab-count">${ch.concepts.length + ch.interview.length}</span></button>
    </div>
  `;

  let bodyHtml = "";
  if (state.currentTab === "concepts") bodyHtml = renderConcepts(ch);
  else if (state.currentTab === "cheatsheet") bodyHtml = renderCheatsheet(ch);
  else if (state.currentTab === "interview") bodyHtml = renderInterview(ch);
  else if (state.currentTab === "flashcards") bodyHtml = renderFlashcards(ch);

  // prev/next nav
  const idx = DATA.chapters.findIndex(c=>c.id===ch.id);
  const prev = idx > 0 ? DATA.chapters[idx-1] : null;
  const next = idx < DATA.chapters.length-1 ? DATA.chapters[idx+1] : null;

  m.innerHTML = `
    <div class="chapter-header">
      <div class="chapter-label">Chapter ${ch.number} · Part ${['','I','II','III'][ch.part]}</div>
      <h1>${ch.title}</h1>
      <div class="overview-text">${ch.overview}</div>
    </div>
    ${tabsHtml}
    <div id="tabBody">${bodyHtml}</div>
    <div class="chapter-footer">
      ${prev ? `<button class="nav-btn" data-nav="${prev.id}"><div class="nav-btn-label">← Previous</div>Ch ${prev.number}: ${prev.title}</button>` : '<div></div>'}
      ${next ? `<button class="nav-btn right" data-nav="${next.id}"><div class="nav-btn-label">Next →</div>Ch ${next.number}: ${next.title}</button>` : '<div></div>'}
    </div>
  `;

  // wire tab clicks
  m.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      state.currentTab = t.dataset.tab;
      state.flashIndex = 0; state.flashFlipped = false;
      render();
    });
  });
  // wire nav
  m.querySelectorAll("[data-nav]").forEach(n => {
    n.addEventListener("click", () => {
      state.currentChapter = n.dataset.nav;
      state.currentTab = "concepts";
      render();
      window.scrollTo(0, 0);
    });
  });
  // wire concept learn toggles
  m.querySelectorAll(".learn-toggle").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = +btn.dataset.idx;
      const p = getChapterProgress(ch.id);
      p.conceptsLearned[i] = !p.conceptsLearned[i];
      saveState();
      render();
    });
  });
  // wire qa items
  m.querySelectorAll(".qa-header").forEach(h => {
    h.addEventListener("click", () => {
      h.parentElement.classList.toggle("open");
    });
  });
  m.querySelectorAll(".review-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = +btn.dataset.idx;
      const p = getChapterProgress(ch.id);
      p.qaReviewed[i] = !p.qaReviewed[i];
      saveState();
      render();
    });
  });
  // wire flashcards
  const fcCard = m.querySelector(".flashcard");
  if (fcCard) {
    fcCard.addEventListener("click", () => {
      state.flashFlipped = !state.flashFlipped;
      render();
    });
  }
  m.querySelectorAll("[data-fc-nav]").forEach(b => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const deck = buildFlashDeck(ch);
      if (b.dataset.fcNav === "prev") {
        state.flashIndex = (state.flashIndex - 1 + deck.length) % deck.length;
      } else if (b.dataset.fcNav === "next") {
        state.flashIndex = (state.flashIndex + 1) % deck.length;
      } else if (b.dataset.fcNav === "shuffle") {
        state.flashIndex = Math.floor(Math.random()*deck.length);
      }
      state.flashFlipped = false;
      render();
    });
  });
}

function renderConcepts(ch) {
  if (!ch.concepts.length) return '<div class="empty-tab">No concepts yet.</div>';
  const prog = getChapterProgress(ch.id);
  let html = '<div class="concepts-grid">';
  ch.concepts.forEach((c, i) => {
    const on = !!prog.conceptsLearned[i];
    html += `
      <div class="concept-card ${on?'learned':''}">
        <button class="learn-toggle ${on?'on':''}" data-idx="${i}" title="Mark as learned">${on?'✓':''}</button>
        <div class="concept-term">${c.term}</div>
        <div class="concept-def">${c.def}</div>
        ${c.why ? `<div class="concept-why">${c.why}</div>` : ''}
        ${c.ex ? `<div class="concept-example">${c.ex}</div>` : ''}
      </div>
    `;
  });
  html += "</div>";
  return html;
}

function escapeAttr(s){return String(s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

function renderCheatsheet(ch) {
  if (!ch.cheatsheet.length) return '<div class="empty-tab">No cheatsheet entries yet.</div>';
  let html = "";
  ch.cheatsheet.forEach(cs => {
    html += `<div class="cheatsheet-block"><h3>${cs.title}</h3>`;
    if (cs.type === "table") {
      html += "<table><thead><tr>";
      cs.headers.forEach(h => html += `<th>${h}</th>`);
      html += "</tr></thead><tbody>";
      cs.rows.forEach(r => {
        html += "<tr>";
        r.forEach((c, i) => {
          const label = escapeAttr(cs.headers[i] || "");
          html += `<td data-label="${label}">${c}</td>`;
        });
        html += "</tr>";
      });
      html += "</tbody></table>";
    } else if (cs.type === "list") {
      html += "<ul>";
      cs.items.forEach(it => html += `<li>${it}</li>`);
      html += "</ul>";
    } else if (cs.type === "note") {
      html += `<div>${cs.body}</div>`;
    }
    if (cs.note) html += `<div class="cs-note">${cs.note}</div>`;
    html += "</div>";
  });
  return html;
}

function renderInterview(ch) {
  if (!ch.interview.length) return '<div class="empty-tab">No questions yet.</div>';
  const prog = getChapterProgress(ch.id);
  let html = "";
  ch.interview.forEach((qa, i) => {
    const reviewed = !!prog.qaReviewed[i];
    const diffCls = qa.diff === "easy" ? "diff-easy" : qa.diff === "hard" ? "diff-hard" : "diff-med";
    html += `
      <div class="qa-item ${reviewed?'reviewed':''}">
        <div class="qa-header">
          <span class="diff-badge ${diffCls}">${qa.diff||"med"}</span>
          <div class="qa-q">${qa.q}</div>
          <span class="qa-chevron">▾</span>
        </div>
        <div class="qa-body">
          <div class="qa-body-inner">${qa.a}</div>
          <div class="qa-footer">
            <button class="review-btn ${reviewed?'on':''}" data-idx="${i}">${reviewed?'✓ Reviewed':'Mark reviewed'}</button>
          </div>
        </div>
      </div>
    `;
  });
  return html;
}

function buildFlashDeck(ch) {
  const deck = [];
  ch.concepts.forEach(c => deck.push({front: c.term, back: c.def + (c.why ? "<br><br><em>Why:</em> " + c.why : "") + (c.ex ? "<br><em>Example:</em> " + c.ex : ""), kind: "concept"}));
  ch.interview.forEach(q => deck.push({front: q.q, back: q.a, kind: "qa"}));
  return deck;
}
function renderFlashcards(ch) {
  const deck = buildFlashDeck(ch);
  if (!deck.length) return '<div class="empty-tab">No flashcards yet.</div>';
  const idx = Math.max(0, Math.min(state.flashIndex, deck.length-1));
  const card = deck[idx];
  const flipped = state.flashFlipped;
  return `
    <div class="fc-stage">
      <div class="flashcard ${flipped?'flipped':''}">
        <div class="fc-face fc-front">
          <div class="fc-label">${card.kind === "qa" ? "Question" : "Concept"} · Tap to flip</div>
          <div class="fc-content">${card.front}</div>
        </div>
        <div class="fc-face fc-back">
          <div class="fc-label">Answer · Tap to flip</div>
          <div class="fc-content">${card.back}</div>
        </div>
      </div>
    </div>
    <div class="fc-nav">
      <button class="iconbtn" data-fc-nav="prev">← Prev</button>
      <span class="fc-counter">${idx+1} / ${deck.length}</span>
      <button class="iconbtn" data-fc-nav="next">Next →</button>
      <button class="iconbtn" data-fc-nav="shuffle">⇌ Shuffle</button>
    </div>
    <div class="cs-note" style="text-align:center; margin-top:16px;">Tip: press <kbd>Space</kbd> to flip · <kbd>←</kbd> <kbd>→</kbd> to navigate</div>
  `;
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  const m = document.getElementById("main");
  const overall = computeOverallPct();
  const totalConcepts = DATA.chapters.reduce((s,c)=>s+c.concepts.length, 0);
  const totalQ = DATA.chapters.reduce((s,c)=>s+c.interview.length, 0);
  const totalCs = DATA.chapters.reduce((s,c)=>s+c.cheatsheet.length, 0);
  const doneConcepts = DATA.chapters.reduce((s,c)=>{
    const p = getChapterProgress(c.id);
    return s + Object.keys(p.conceptsLearned).filter(k=>p.conceptsLearned[k]).length;
  }, 0);
  const doneQ = DATA.chapters.reduce((s,c)=>{
    const p = getChapterProgress(c.id);
    return s + Object.keys(p.qaReviewed).filter(k=>p.qaReviewed[k]).length;
  }, 0);

  let chaptersHtml = DATA.chapters.map(ch => {
    const pct = computeChapterPct(ch);
    return `
      <div class="dash-chapter-card" data-chapter="${ch.id}">
        <div class="dcc-head">
          <div class="dcc-num">${ch.number}</div>
          <div class="dcc-title">${ch.title}</div>
        </div>
        <div class="dcc-meta">
          <span>${ch.concepts.length} concepts · ${ch.interview.length} Q&amp;A</span>
          <span>${pct}%</span>
        </div>
        <div class="dcc-prog-bar"><div class="dcc-prog-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");

  m.innerHTML = `
    <div class="dash-hero">
      <h1>Designing Data-Intensive Applications</h1>
      <p>Martin Kleppmann · Interactive interview prep notes · 12 chapters · All core ideas covered</p>
    </div>
    <div class="dash-stats">
      <div class="stat-card"><div class="stat-label">Overall Progress</div><div class="stat-value">${overall}%</div></div>
      <div class="stat-card"><div class="stat-label">Concepts Learned</div><div class="stat-value">${doneConcepts}<span class="small"> / ${totalConcepts}</span></div></div>
      <div class="stat-card"><div class="stat-label">Q&amp;A Reviewed</div><div class="stat-value">${doneQ}<span class="small"> / ${totalQ}</span></div></div>
      <div class="stat-card"><div class="stat-label">Cheatsheet Blocks</div><div class="stat-value">${totalCs}</div></div>
    </div>
    <h2 style="margin-bottom:14px;font-size:18px;">Chapters</h2>
    <div class="dash-chapters">${chaptersHtml}</div>
    <div class="chapter-footer" style="margin-top:32px;">
      <div style="color:var(--text-muted);font-size:13px;">
        <strong>How to use:</strong> Each chapter has Core Concepts, a Cheatsheet with tradeoff tables, Interview Q&amp;A with difficulty levels, and Flashcards. Mark concepts as learned (✓ circle on each card) and questions as reviewed — your progress saves automatically and persists in this browser. Use <strong>⬇ Export</strong> on one device and <strong>⬆ Import</strong> on another to keep them in sync.
      </div>
    </div>
  `;
  m.querySelectorAll("[data-chapter]").forEach(el => {
    el.addEventListener("click", () => {
      state.currentChapter = el.dataset.chapter;
      state.currentTab = "concepts";
      render();
      window.scrollTo(0, 0);
    });
  });
}

// ============================================================
// SEARCH
// ============================================================
function runSearch(q) {
  const results = [];
  const qq = q.toLowerCase().trim();
  if (qq.length < 2) return [];
  DATA.chapters.forEach(ch => {
    ch.concepts.forEach((c,i) => {
      const hay = (c.term + " " + c.def + " " + (c.why||"") + " " + (c.ex||"")).toLowerCase();
      if (hay.includes(qq)) {
        results.push({ chId: ch.id, chNum: ch.number, chTitle: ch.title, kind: "Concept", title: c.term, snippet: c.def, tab: "concepts" });
      }
    });
    ch.interview.forEach((x,i) => {
      const hay = (x.q + " " + x.a).toLowerCase();
      if (hay.includes(qq)) {
        results.push({ chId: ch.id, chNum: ch.number, chTitle: ch.title, kind: "Q&A", title: x.q, snippet: x.a.replace(/<[^>]+>/g,"").slice(0,120)+"…", tab: "interview" });
      }
    });
    ch.cheatsheet.forEach(cs => {
      if (cs.title.toLowerCase().includes(qq)) {
        results.push({ chId: ch.id, chNum: ch.number, chTitle: ch.title, kind: "Cheatsheet", title: cs.title, snippet: "", tab: "cheatsheet" });
      }
    });
  });
  return results.slice(0, 25);
}
function renderSearch(q) {
  const box = document.getElementById("searchResults");
  const rs = runSearch(q);
  if (rs.length === 0) {
    box.classList.remove("open");
    box.innerHTML = "";
    return;
  }
  box.innerHTML = rs.map((r,i) => `
    <div class="sr-item" data-sr-ch="${r.chId}" data-sr-tab="${r.tab}">
      <div class="sr-label">Ch ${r.chNum} · ${r.kind}</div>
      <div class="sr-title">${r.title}</div>
      ${r.snippet ? `<div class="sr-snippet">${r.snippet}</div>` : ""}
    </div>`).join("");
  box.classList.add("open");
  box.querySelectorAll(".sr-item").forEach(el => {
    el.addEventListener("click", () => {
      state.currentChapter = el.dataset.srCh;
      state.currentTab = el.dataset.srTab;
      document.getElementById("searchBox").value = "";
      box.classList.remove("open");
      render();
      window.scrollTo(0,0);
    });
  });
}

// ============================================================
// EXPORT / IMPORT
// ============================================================
function doExport() {
  const payload = {
    app: "ddia-notes",
    version: 1,
    exportedAt: new Date().toISOString(),
    progress: state.progress,
    theme: state.theme
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `ddia-progress-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Progress exported. Transfer this file to your other device and use ⬆ Import there.");
}
function doImportPick() {
  document.getElementById("importFile").click();
}
function doToggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
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

// ============================================================
// TOP LEVEL
// ============================================================
function render() {
  renderSidebar();
  renderMain();
  const pct = computeOverallPct();
  document.getElementById("overallProgressText").textContent = pct + "%";
  document.getElementById("overallProgressFill").style.width = pct + "%";
}

function init() {
  loadState();
  render();

  // Theme toggle (desktop button)
  document.getElementById("themeToggle").addEventListener("click", doToggleTheme);
  // Reset (desktop button)
  document.getElementById("resetBtn").addEventListener("click", doReset);
  // Export (desktop button)
  document.getElementById("exportBtn").addEventListener("click", doExport);
  // Import (desktop button)
  document.getElementById("importBtn").addEventListener("click", doImportPick);
  // File input change
  document.getElementById("importFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || typeof data !== "object" || !data.progress) {
          throw new Error("File doesn't look like a DDIA progress export.");
        }
        const mode = confirm("Import progress:\n\nOK = MERGE with your current progress (anything already marked stays marked)\nCancel = REPLACE your current progress with the file");
        if (mode) {
          // merge
          Object.keys(data.progress).forEach(chId => {
            const cur = state.progress[chId] || { conceptsLearned: {}, qaReviewed: {} };
            const incoming = data.progress[chId] || {};
            cur.conceptsLearned = Object.assign({}, cur.conceptsLearned || {}, incoming.conceptsLearned || {});
            cur.qaReviewed = Object.assign({}, cur.qaReviewed || {}, incoming.qaReviewed || {});
            state.progress[chId] = cur;
          });
        } else {
          state.progress = data.progress;
        }
        if (data.theme) { state.theme = data.theme; applyTheme(); }
        saveState();
        render();
        showToast("Progress imported successfully.");
      } catch (err) {
        showToast("Import failed: " + err.message, true);
      } finally {
        e.target.value = ""; // reset so re-picking the same file works
      }
    };
    reader.readAsText(file);
  });

  // Mobile: hamburger
  document.getElementById("menuToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDrawer();
  });
  // Mobile: backdrop close
  document.getElementById("backdrop").addEventListener("click", closeDrawer);

  // Mobile: more menu
  document.getElementById("moreToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMoreMenu();
  });
  document.querySelectorAll("#moreMenu [data-action]").forEach(b => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = b.dataset.action;
      closeMoreMenu();
      if (action === "export") doExport();
      else if (action === "import") doImportPick();
      else if (action === "theme") doToggleTheme();
      else if (action === "reset") doReset();
    });
  });

  // Search
  const sb = document.getElementById("searchBox");
  sb.addEventListener("input", () => renderSearch(sb.value));
  sb.addEventListener("focus", () => { if (sb.value) renderSearch(sb.value); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) {
      document.getElementById("searchResults").classList.remove("open");
    }
    if (!e.target.closest(".more-wrap")) {
      closeMoreMenu();
    }
  });

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      if (e.key === "Escape") {
        e.target.blur();
        document.getElementById("searchResults").classList.remove("open");
      }
      return;
    }
    if (e.key === "Escape") {
      if (document.getElementById("sidebar").classList.contains("open")) closeDrawer();
      closeMoreMenu();
    }
    if (e.key === "/") { e.preventDefault(); sb.focus(); }
    if (state.currentTab === "flashcards" && state.currentChapter !== "dashboard") {
      if (e.key === " ") { e.preventDefault(); state.flashFlipped = !state.flashFlipped; render(); }
      if (e.key === "ArrowRight") {
        const ch = DATA.chapters.find(c => c.id === state.currentChapter);
        const deck = buildFlashDeck(ch);
        state.flashIndex = (state.flashIndex + 1) % deck.length;
        state.flashFlipped = false; render();
      }
      if (e.key === "ArrowLeft") {
        const ch = DATA.chapters.find(c => c.id === state.currentChapter);
        const deck = buildFlashDeck(ch);
        state.flashIndex = (state.flashIndex - 1 + deck.length) % deck.length;
        state.flashFlipped = false; render();
      }
    }
  });

  // Window resize: close drawer if we go to desktop size
  window.addEventListener("resize", () => {
    if (!isMobile()) closeDrawer();
  });
}

document.addEventListener("DOMContentLoaded", init);
