# DDIA Interactive Notes

An interactive, visual companion to Martin Kleppmann's *Designing Data-Intensive Applications*.

Every chapter has:

- **Deep Dive**: a long-form explanation that starts from *why each idea was needed*, then shows how it works with **interactive visualizations** you can poke at (kill a leader, partition the network, skew a clock, tune a quorum), real-world systems and incidents, trade-offs, interview angles, and self-check quizzes.
- **Concepts**: every key term with its definition, the problem it solved, why it matters and an example. Mark them as learned.
- **Cheatsheet**: comparison tables and lists for fast revision (all chapters on one printable page at `#/cheatsheet`).
- **Interview Q&A**: model answers with follow-ups and pitfalls, graded easy / medium / hard.
- **Flashcards**: concepts and questions as flip cards.

The Concepts, Interview Q&A and Flashcards tabs have study tools built in: filter concepts (or switch to *definitions only* for fast review), filter questions by difficulty or hide the ones you've reviewed, and mark flashcards *Got it* (this marks the concept as learned or the question as reviewed) with a real shuffle and swipe on phones.

Across the book:

- **Dashboard** (`#/`): a *Next up* card that points at the first section you haven't marked as understood in the chapter you're reading, plus practice shortcuts and a map of the book.
- **Visualization lab** (`#/viz`): every interactive in one place, filterable by chapter (`#/viz/ch5`) or by text. Each visualization has its own page (`#/viz/ch5/quorum`) with "try this" instructions, previous / next, and a link to the section that explains it.
- **Quiz mode** (`#/quiz`): every "check yourself" question, shuffled. Pick chapters (or a whole part) and a round length; answer with the keyboard; the results list what you missed with links back to the text, and misses are saved for a retry round.
- **Glossary** (`#/glossary`): every term A–Z, filterable by text and by chapter.
- **Printable cheat sheet** (`#/cheatsheet`): all chapters on one page; printing uses a compact, ink-friendly layout (small type, ruled tables whose headers repeat across pages, two-column lists).
- **Five looks**, each with light and dark modes, switchable from the **◐ Look** menu (or the ⋯ menu on phones): *Editorial* (the default, paper & ink, set like a textbook), *Blueprint* (an engineer's drafting sheet), *Swiss* (bold poster type, hard edges), *Ops console* (tmux meets Grafana) and *Classic* (the original violet). The choice is remembered per browser; `?skin=<name>` previews one.
- Full-text search (`/`), light/dark themes, and progress tracking that persists in your browser (Export / Import to move it between devices). Works on phones: one-row top bar with search behind the magnifier, a chapter drawer, and 40px+ touch targets.

### Keyboard

| Key | Where | Does |
| --- | --- | --- |
| `/` | anywhere | search (`↑` `↓` to pick a result, `Enter` to open, `Esc` to close) |
| `j` / `k` | Deep Dive | next / previous section |
| `Space`, `←` `→`, `G` | Flashcards | flip, previous / next, got it |
| `A`–`D` or `1`–`4`, `Enter` | Quiz mode | answer, next question |

## Run it

It's a static site with no build step and no dependencies:

```bash
python3 scripts/serve.py        # http://127.0.0.1:8765
```

(Any static file server works; `serve.py` just disables caching so edits show up immediately.)

## Deploying (GitHub Pages)

The site deploys as-is from the repository root with GitHub Pages ("Deploy from a branch"): no build step, hash-based routing, and only relative URLs, so it works under a project path like `https://<user>.github.io/ddia-notes/`. The empty `.nojekyll` file tells Pages to serve every file untouched (no Jekyll processing).

When you publish changes:

```bash
node scripts/build-manifest.js && node scripts/validate.js   # content is consistent
scripts/check-site.sh                                        # every page and visualization runs
scripts/bump-version.sh                                      # new ?v= so browsers fetch fresh files
git add -A && git commit -m "Update notes" && git push
```

`git add -A` matters: most of the site lives in folders (`chapters/`, `core/`, `viz/`, `skins/`), and committing only the modified top-level files would leave `index.html` pointing at files that aren't on the branch. Pages caches files for up to 10 minutes; the version bump makes returning visitors load the new files.

## Project layout

```
index.html, styles.css, app.js   the shell, design system (the "Classic" look) and app logic
skins/*.css                      the other looks: each overrides the design tokens + components
core/registry.js                 chapter registry + lazy loading of deep dives
core/manifest.js                 GENERATED index of the deep dives (sections, viz list, reading time)
core/legacy.js                   frozen map for migrating progress saved by the old site
chapters/chN.js                  study material (concepts, cheatsheet, Q&A), loaded up front
chapters/chN.deep.js, .deep2.js  the Deep Dive (sections built from content blocks), loaded on demand
viz/core.js                      the visualization toolkit
viz/chN/*.js                     one file per interactive visualization (lazy-loaded)
docs/AUTHORING.md                how to write content and build visualizations
scripts/                         validator, headless test runners, dev server
test/viz.html                    harness for testing one visualization
```

## Checks

```bash
node scripts/build-manifest.js        # regenerate core/manifest.js after editing a deep dive
node scripts/validate.js              # content schema, ids, cross-links, balanced HTML, fresh manifest
scripts/check-site.sh                 # renders every page and mounts every visualization
scripts/check-viz.sh ch5/quorum       # one visualization: clicks every control, phone legibility, screenshots
scripts/check-all-viz.sh              # the above for all 72 visualizations
scripts/shoot.sh ch5 [--phone]        # screenshot a chapter's deep dive (or any '#/route') as readable tiles
scripts/bump-version.sh               # bump the ?v= asset version before deploying
```

The headless checks use the locally installed Google Chrome.

## Progress data

Progress is stored in `localStorage` under `ddia_notes_progress_v2`, keyed by stable concept, question and section ids. Progress saved by the older version of the site (`ddia_notes_progress_v1`, keyed by position) is migrated automatically on first load, and old export files can still be imported.

View preferences that aren't progress (definitions-only concepts, quiz round length) live separately under `ddia_notes_ui_v1`, and the chosen look under `ddia_skin`, so the progress format and export files are unaffected.
