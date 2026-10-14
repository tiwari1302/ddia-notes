#!/usr/bin/env node
// Validates chapter content files.
//
//   node scripts/validate.js            # all chapters
//   node scripts/validate.js ch5 ch6    # specific chapters
//   node scripts/validate.js ch5 --partial
//        while files are still being written in parallel: missing viz files and
//        concept/question -> section links that don't resolve yet are warnings, not errors
//
// Checks schema, id uniqueness, that legacy progress ids still exist (so saved progress
// survives), that every viz block points at an existing viz/<id>.js that registers that
// id, cross-references (section.concepts, concept.section, qa.section, connections), and
// that every HTML string has balanced tags. Exit code 1 on any error.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const BLOCK_TYPES = {
  text: ["html"], problem: ["html"], idea: ["html"], analogy: ["html"],
  callout: ["html"], viz: ["id", "title"], diagram: [], realworld: ["items"],
  tradeoffs: ["pros", "cons"], compare: ["items"], table: ["headers", "rows"],
  code: ["code"], steps: ["items"], list: ["items"], keypoints: ["items"],
  timeline: ["items"], quiz: ["q", "options", "answer", "explain"],
};
const CALLOUT_TONES = ["insight", "warning", "interview", "history", "modern", "tip", "mistake", "problem", "idea", "analogy"];
const VOID = new Set(["br", "hr", "img", "input", "wbr", "meta", "link", "source", "col", "area", "base", "embed", "param", "track"]);
const SVG_SELF = /\/\s*$/;

function loadAll() {
  const sandbox = { window: {}, console };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const run = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  run("core/registry.js");
  sandbox.DDIA = sandbox.window.DDIA;
  run("core/legacy.js");
  const files = fs.readdirSync(path.join(ROOT, "chapters")).filter(f => /^ch\d+(\.deep2?)?\.js$/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const loadErrors = [];
  for (const f of files) {
    try { run("chapters/" + f); } catch (e) { loadErrors.push(`${f}: ${e.message}`); }
  }
  return { DDIA: sandbox.window.DDIA, legacy: sandbox.window.DDIA_LEGACY_V1, loadErrors };
}

function checkHtml(html, where, errors) {
  if (typeof html !== "string") return;
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const full = m[0];
    if (VOID.has(tag) || SVG_SELF.test(full.slice(0, -1))) continue;
    if (full.startsWith("</")) {
      if (!stack.length) { errors.push(`${where}: stray closing </${tag}>`); return; }
      const top = stack.pop();
      if (top !== tag) { errors.push(`${where}: <${top}> closed by </${tag}>`); return; }
    } else stack.push(tag);
  }
  if (stack.length) errors.push(`${where}: unclosed <${stack.join(">, <")}>`);
  if (/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/.test(html.replace(/<[^>]*>/g, ""))) {
    // bare ampersands render fine in browsers; only warn
  }
}

function walkStrings(obj, where, fn) {
  if (typeof obj === "string") return fn(obj, where);
  if (Array.isArray(obj)) return obj.forEach((x, i) => walkStrings(x, `${where}[${i}]`, fn));
  if (obj && typeof obj === "object") for (const k of Object.keys(obj)) {
    if (k === "code" || k === "svg") { if (k === "svg") fn(obj[k], `${where}.svg`); continue; }
    walkStrings(obj[k], `${where}.${k}`, fn);
  }
}

function vizFileRegisters(id) {
  const f = path.join(ROOT, "viz", id + ".js");
  if (!fs.existsSync(f)) return `viz file missing: viz/${id}.js`;
  const src = fs.readFileSync(f, "utf8");
  if (!src.includes(`Viz.register("${id}"`) && !src.includes(`Viz.register('${id}'`)) return `viz/${id}.js does not call Viz.register("${id}", ...)`;
  try { new vm.Script(src, { filename: `viz/${id}.js` }); } catch (e) { return `viz/${id}.js syntax error: ${e.message}`; }
  return null;
}

let PARTIAL = false;

function validateChapter(ch, legacy, allIds) {
  const errors = [], warnings = [];
  const soft = msg => (PARTIAL ? warnings : errors).push(msg);
  const where = ch.id;
  for (const k of ["id", "part", "number", "title", "overview"]) if (ch[k] === undefined) errors.push(`${where}: missing ${k}`);

  // Concepts
  const cIds = new Set();
  (ch.concepts || []).forEach((c, i) => {
    const w = `${where}.concepts[${i}]`;
    if (!c.id) errors.push(`${w}: missing id`);
    else if (cIds.has(c.id)) errors.push(`${w}: duplicate id ${c.id}`);
    else cIds.add(c.id);
    if (!c.term) errors.push(`${w}: missing term`);
    if (!c.def) errors.push(`${w}: missing def`);
  });
  // Interview
  const qIds = new Set();
  (ch.interview || []).forEach((q, i) => {
    const w = `${where}.interview[${i}]`;
    if (!q.id) errors.push(`${w}: missing id`);
    else if (qIds.has(q.id)) errors.push(`${w}: duplicate id ${q.id}`);
    else qIds.add(q.id);
    if (!q.q || !q.a) errors.push(`${w}: needs q and a`);
    if (!["easy", "medium", "hard"].includes(q.diff)) errors.push(`${w}: diff must be easy|medium|hard`);
  });
  // Legacy ids must survive so existing users keep their progress.
  const lg = legacy[ch.id];
  if (lg) {
    lg.c.forEach(id => { if (!cIds.has(id)) errors.push(`${where}: legacy concept id "${id}" was removed or renamed (keep it so saved progress survives)`); });
    lg.q.forEach(id => { if (!qIds.has(id)) errors.push(`${where}: legacy question id "${id}" was removed or renamed`); });
  }
  // Cheatsheet
  (ch.cheatsheet || []).forEach((cs, i) => {
    const w = `${where}.cheatsheet[${i}]`;
    if (!cs.title) errors.push(`${w}: missing title`);
    if (cs.type === "table" && (!Array.isArray(cs.headers) || !Array.isArray(cs.rows))) errors.push(`${w}: table needs headers+rows`);
    if (cs.type === "table" && Array.isArray(cs.rows)) cs.rows.forEach((r, j) => { if (r.length !== cs.headers.length) errors.push(`${w}.rows[${j}]: ${r.length} cells but ${cs.headers.length} headers`); });
    if (cs.type === "list" && !Array.isArray(cs.items)) errors.push(`${w}: list needs items`);
    if (!["table", "list", "note"].includes(cs.type)) errors.push(`${w}: type must be table|list|note`);
  });

  // Deep dive
  const stats = { sections: 0, viz: 0, words: 0, realworld: 0, quizzes: 0, blocks: 0 };
  const dd = ch.deepDive;
  const sIds = new Set();
  const vizIds = new Set();
  if (dd) {
    if (!Array.isArray(dd.sections) || !dd.sections.length) errors.push(`${where}.deepDive: sections must be a non-empty array`);
    (dd.sections || []).forEach((s, i) => {
      const w = `${where}.deepDive.sections[${i}]`;
      if (!s.id || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) errors.push(`${w}: id must be a lowercase slug (got ${s.id})`);
      else if (sIds.has(s.id)) errors.push(`${w}: duplicate section id ${s.id}`);
      else sIds.add(s.id);
      if (s.id === "takeaways") errors.push(`${w}: "takeaways" is reserved`);
      if (!s.title) errors.push(`${w}: missing title`);
      if (!Array.isArray(s.blocks) || !s.blocks.length) errors.push(`${w}: blocks must be a non-empty array`);
      (s.concepts || []).forEach(cid => { if (!cIds.has(cid)) soft(`${w}: concepts references unknown concept id "${cid}"`); });
      (s.blocks || []).forEach((b, j) => {
        const bw = `${w}.blocks[${j}]`;
        stats.blocks++;
        if (!BLOCK_TYPES[b.type]) { errors.push(`${bw}: unknown block type "${b.type}"`); return; }
        BLOCK_TYPES[b.type].forEach(k => { if (b[k] === undefined) errors.push(`${bw} (${b.type}): missing "${k}"`); });
        if (b.type === "callout" && b.tone && !CALLOUT_TONES.includes(b.tone)) errors.push(`${bw}: unknown callout tone "${b.tone}"`);
        if (b.type === "diagram" && !b.svg && !b.html) errors.push(`${bw}: diagram needs svg or html`);
        if (b.type === "quiz") {
          if (!Array.isArray(b.options) || b.options.length < 2) errors.push(`${bw}: quiz needs >= 2 options`);
          else if (!(b.answer >= 0 && b.answer < b.options.length)) errors.push(`${bw}: quiz answer index out of range`);
          stats.quizzes++;
        }
        if (b.type === "table" && Array.isArray(b.rows)) b.rows.forEach((r, k) => { if (r.length !== b.headers.length) errors.push(`${bw}.rows[${k}]: ${r.length} cells but ${b.headers.length} headers`); });
        if (b.type === "realworld") {
          (b.items || []).forEach((it, k) => { if (!it.org || !it.html) errors.push(`${bw}.items[${k}]: realworld item needs org and html`); });
          stats.realworld += (b.items || []).length;
        }
        if (b.type === "viz") {
          stats.viz++;
          if (!/^ch\d+\/[a-z0-9][a-z0-9-]*$/.test(b.id || "")) errors.push(`${bw}: viz id must look like "${ch.id}/some-name" (got ${b.id})`);
          else if (!b.id.startsWith(ch.id + "/")) errors.push(`${bw}: viz id ${b.id} should live under ${ch.id}/`);
          else {
            if (vizIds.has(b.id)) warnings.push(`${bw}: viz ${b.id} is embedded more than once`);
            vizIds.add(b.id);
            const problem = vizFileRegisters(b.id);
            if (problem) (problem.startsWith("viz file missing") ? soft : m => errors.push(m))(`${bw}: ${problem}`);
          }
        }
        const txt = JSON.stringify(b).replace(/<[^>]+>/g, " ");
        stats.words += txt.split(/\s+/).length;
      });
    });
    stats.sections = sIds.size;
    (dd.connections || []).forEach((c, i) => { if (!allIds.has(c.to)) errors.push(`${where}.deepDive.connections[${i}]: unknown chapter "${c.to}"`); });
    if (dd.takeaways && !Array.isArray(dd.takeaways)) errors.push(`${where}.deepDive.takeaways must be an array`);
  }
  (ch.concepts || []).forEach(c => { if (c.section && !sIds.has(c.section)) soft(`${where}: concept ${c.id} has unknown section "${c.section}"`); });
  (ch.interview || []).forEach(q => { if (q.section && !sIds.has(q.section)) soft(`${where}: question ${q.id} has unknown section "${q.section}"`); });

  walkStrings(ch, where, (str, w) => checkHtml(str, w, errors));

  // Orphan viz files (exist on disk but are not embedded anywhere)
  const vdir = path.join(ROOT, "viz", ch.id);
  if (fs.existsSync(vdir)) fs.readdirSync(vdir).filter(f => f.endsWith(".js")).forEach(f => {
    const id = `${ch.id}/${f.replace(/\.js$/, "")}`;
    if (!vizIds.has(id)) warnings.push(`${where}: viz/${id}.js exists but is not embedded in any section`);
  });

  stats.concepts = cIds.size; stats.questions = qIds.size; stats.cheatsheet = (ch.cheatsheet || []).length;
  return { errors, warnings, stats };
}

function main() {
  const args = process.argv.slice(2);
  PARTIAL = args.includes("--partial");
  const want = args.filter(a => !a.startsWith("--"));
  const { DDIA, legacy, loadErrors } = loadAll();
  const allIds = new Set(DDIA.chapters.map(c => c.id));
  let failed = loadErrors.length > 0;
  loadErrors.forEach(e => console.log("LOAD ERROR " + e));
  const chs = DDIA.chapters.filter(c => !want.length || want.includes(c.id));
  if (want.length && !chs.length) { console.log("No such chapter: " + want.join(", ")); process.exit(1); }
  for (const ch of chs) {
    const { errors, warnings, stats } = validateChapter(ch, legacy, allIds);
    const s = stats;
    console.log(`${errors.length ? "✗" : "✓"} ${ch.id.padEnd(5)} sections=${s.sections} viz=${s.viz} words≈${s.words} realworld=${s.realworld} quizzes=${s.quizzes} concepts=${s.concepts} questions=${s.questions} cheatsheet=${s.cheatsheet}`);
    errors.forEach(e => console.log("   ERROR " + e));
    warnings.forEach(w => console.log("   warn  " + w));
    if (errors.length) failed = true;
  }
  // Every ?v= in index.html must be the same: lazy-loaded files inherit the version from it.
  const versions = [...new Set((fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/\?v=[0-9]+/g) || []))];
  if (versions.length !== 1) {
    console.log(`ERROR index.html uses several asset versions (${versions.join(", ")}): run  scripts/bump-version.sh  or make them equal`);
    failed = true;
  }

  // The lazy-loading manifest must match the deep-dive files.
  try {
    const { build, OUT } = require("./build-manifest.js");
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (cur !== build()) {
      console.log("ERROR core/manifest.js is out of date: run  node scripts/build-manifest.js");
      failed = true;
    }
  } catch (e) { console.log("ERROR could not check core/manifest.js: " + e.message); failed = true; }
  process.exit(failed ? 1 : 0);
}
main();
