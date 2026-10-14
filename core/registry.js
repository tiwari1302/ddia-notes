// Chapter registry. Each chapters/chN.js calls DDIA.registerChapter({...}).
// Load order: core/registry.js -> chapters/*.js -> app.js
(function () {
  const chapters = [];

  const pendingDeepDives = {};

  function registerChapter(ch) {
    if (!ch || !ch.id) throw new Error("registerChapter: chapter needs an id");
    ch.concepts = ch.concepts || [];
    ch.cheatsheet = ch.cheatsheet || [];
    ch.interview = ch.interview || [];
    if (pendingDeepDives[ch.id]) { ch.deepDive = pendingDeepDives[ch.id]; delete pendingDeepDives[ch.id]; }
    const existing = chapters.findIndex(c => c.id === ch.id);
    if (existing >= 0) chapters[existing] = ch; else chapters.push(ch);
    chapters.sort((a, b) => a.number - b.number);
  }

  // The long-form "Deep Dive" lives in its own files so it can be written independently of
  // the study material (concepts, cheatsheet, Q&A). It may be split across several files
  // (chN.deep.js, chN.deep2.js): each call appends its sections in load order, and the
  // first non-empty hook / takeaways / connections / furtherReading wins.
  function mergeDeepDive(a, b) {
    if (!a) return b;
    const out = Object.assign({}, a);
    const seen = new Set((a.sections || []).map(x => x.id));
    out.sections = (a.sections || []).concat((b.sections || []).filter(x => !seen.has(x.id)));
    ["hook", "takeaways", "connections", "furtherReading"].forEach(k => {
      const has = v => v && (!Array.isArray(v) || v.length);
      if (!has(out[k]) && has(b[k])) out[k] = b[k];
    });
    return out;
  }
  function registerDeepDive(chapterId, deepDive) {
    const ch = chapters.find(c => c.id === chapterId);
    if (ch) ch.deepDive = mergeDeepDive(ch.deepDive, deepDive);
    else pendingDeepDives[chapterId] = mergeDeepDive(pendingDeepDives[chapterId], deepDive);
  }

  // Deep dives are lazy-loaded: chN.deep.js then chN.deep2.js (order matters for merging).
  const deepPromises = {};
  const loadedDeep = {};
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = src;
      sc.onload = resolve;
      sc.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(sc);
    });
  }
  function assetVersion() {
    const me = document.querySelector('script[src*="core/registry.js"]');
    const m = me && me.getAttribute("src").match(/[?&]v=([^&]+)/);
    return m ? "?v=" + m[1] : "";
  }
  // Each file is fetched at most once; after a network failure a retry re-fetches only the
  // file that failed (re-running a loaded file would append its sections again).
  const filePromises = {};
  function loadOnce(src) {
    if (!filePromises[src]) {
      filePromises[src] = loadScript(src).catch(err => { delete filePromises[src]; throw err; });
    }
    return filePromises[src];
  }
  function loadDeep(chapterId) {
    if (loadedDeep[chapterId]) return Promise.resolve();
    if (!deepPromises[chapterId]) {
      const v = assetVersion();
      deepPromises[chapterId] = loadOnce(`chapters/${chapterId}.deep.js${v}`)
        .then(() => loadOnce(`chapters/${chapterId}.deep2.js${v}`))
        .then(() => { loadedDeep[chapterId] = true; })
        .catch(err => { delete deepPromises[chapterId]; throw err; });
    }
    return deepPromises[chapterId];
  }

  window.DDIA = {
    chapters,
    registerChapter,
    registerDeepDive,
    loadDeep,
    isDeepLoaded: id => !!loadedDeep[id],
    loadAllDeep: () => Promise.all(chapters.map(c => loadDeep(c.id))),
    allDeepLoaded: () => chapters.every(c => loadedDeep[c.id]),
    chapter(id) { return chapters.find(c => c.id === id); },
  };
  // Back-compat alias for code that still reads the old global.
  window.DATA = { chapters };
})();
