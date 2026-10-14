// Chapter 2 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch2", {
  sections: [
    // ------------------------------------------------------------------
    {
      id: "locality-and-convergence",
      title: "Locality, simpler code, and why the two models are converging",
      kicker: "Relational vs document",
      concepts: ["data-locality", "shredding", "document-model"],
      blocks: [
        {
          type: "problem",
          html: `<p>So far locality has looked like a free win. The profile that a normalized schema spreads over <code>users</code>, <code>positions</code>, <code>education</code> and <code>contact_info</code> (see <a href="#/ch2/learn/impedance-mismatch">the object-relational mismatch</a>) comes back from a document store in one lookup instead of four.</p>
<p>Then the analytics team starts appending every click to the profile document, because it's convenient. A year later each profile read drags megabytes of click history along, each click rewrites a document that never stops growing, and the most active users are nearing MongoDB's hard limit of <strong>16 MB per document</strong>. Locality is a bet that you will read and write the unit as a whole. When the bet is wrong, you pay on every access.</p>`,
        },
        {
          type: "idea",
          html: `<p>Pick the layout whose natural unit matches how you access the data: documents win when you read and write whole trees, relations win when you slice across many records. Because each camp has borrowed the other's best features, the decision is less about which product to install than about how to lay out each piece of data.</p>`,
        },
        {
          type: "text",
          html: `<h3>The simpler-code test</h3>
<p>If your data is genuinely document-shaped, meaning a tree of one-to-many relationships that you usually load all at once, the document model tends to give the simplest application code. A résumé fits: a user owns their positions, their schools and their contact links, and nobody else does. The relational alternative is <strong>shredding</strong>: cutting the tree into one table per kind of child, then reassembling it with joins or several queries on every read. It works, but you get more tables, more mapping code and more ways to get the reassembly wrong.</p>
<p>Documents have their own awkward spots. You can't point directly at something nested inside one; you have to describe how to get there ("the second entry in the positions array of user 251"), much like an access path in the old hierarchical databases. That's fine while documents stay shallow. Weak join support may not matter either: an app that records timestamped events may never need many-to-many relationships. But for highly interconnected data, documents get awkward, relational joins cope acceptably, and graph models (see <a href="#/ch2/learn/property-graphs">property graphs</a>) fit most naturally.</p>
<h3>Why one document is one read</h3>
<p>A document database usually stores each document as one contiguous value: JSON or XML text, or a binary encoding such as MongoDB's <strong>BSON</strong>. That gives it <strong>data locality</strong>. When the application needs the whole profile, the database finds one key and reads one run of bytes, instead of probing an index per table and seeking to wherever each table keeps its rows.</p>`,
        },
        {
          type: "diagram",
          title: "Where a profile's bytes live",
          svg: `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A document is one value on one disk page and needs one lookup; the same profile normalized into four tables needs four lookups on four pages; Spanner interleaves child rows next to their parent row">
<defs><marker id="ch2d2-loc-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="16" y="22" font-size="13" font-weight="700">Document</text>
<text x="304" y="22" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-ok)">1 lookup</text>
<text x="168" y="44" font-size="12" style="fill: var(--viz-muted)">read</text>
<rect x="16" y="58" width="288" height="88" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="26" y="70" width="268" height="46" rx="10" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<line x1="160" y1="30" x2="160" y2="69" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch2d2-loc-arr)"/>
<text x="160" y="89" font-size="12" text-anchor="middle">user 251 { name, positions[…],</text>
<text x="160" y="106" font-size="12" text-anchor="middle">education[…], contact }</text>
<text x="160" y="137" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">disk page 7</text>
<text x="336" y="22" font-size="13" font-weight="700">Normalized rows</text>
<text x="628" y="22" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-bad)">4 index lookups</text>
<rect x="336" y="58" width="67" height="88" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="411" y="58" width="67" height="88" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="486" y="58" width="67" height="88" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="561" y="58" width="67" height="88" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="338" y="70" width="63" height="46" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="413" y="70" width="63" height="46" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="488" y="70" width="63" height="46" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="563" y="70" width="63" height="46" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<circle cx="482" cy="32" r="3" style="fill: var(--viz-muted)"/>
<line x1="482" y1="32" x2="371" y2="69" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch2d2-loc-arr)"/>
<line x1="482" y1="32" x2="446" y2="69" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch2d2-loc-arr)"/>
<line x1="482" y1="32" x2="518" y2="69" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch2d2-loc-arr)"/>
<line x1="482" y1="32" x2="593" y2="69" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch2d2-loc-arr)"/>
<text x="369.5" y="89" font-size="12" text-anchor="middle">users</text>
<text x="369.5" y="106" font-size="12" text-anchor="middle">251</text>
<text x="444.5" y="89" font-size="12" text-anchor="middle">positions</text>
<text x="444.5" y="106" font-size="12" text-anchor="middle">251 (×2)</text>
<text x="519.5" y="89" font-size="12" text-anchor="middle">education</text>
<text x="519.5" y="106" font-size="12" text-anchor="middle">251 (×2)</text>
<text x="594.5" y="89" font-size="12" text-anchor="middle">contact</text>
<text x="594.5" y="106" font-size="12" text-anchor="middle">251</text>
<text x="369.5" y="137" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">page 7</text>
<text x="444.5" y="137" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">page 19</text>
<text x="519.5" y="137" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">page 42</text>
<text x="594.5" y="137" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">page 88</text>
<line x1="16" y1="162" x2="628" y2="162" style="stroke: var(--viz-line)"/>
<text x="16" y="184" font-size="13" font-weight="700">Interleaved tables (Spanner)</text>
<text x="628" y="184" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">relational schema, document-like layout</text>
<rect x="16" y="194" width="117" height="32" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<rect x="139" y="194" width="117" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="262" y="194" width="117" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="385" y="194" width="117" height="32" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<rect x="508" y="194" width="117" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="74.5" y="214" font-size="12" font-weight="700" text-anchor="middle">Singer 1</text>
<text x="197.5" y="214" font-size="12" text-anchor="middle">Album 1-1</text>
<text x="320.5" y="214" font-size="12" text-anchor="middle">Album 1-2</text>
<text x="443.5" y="214" font-size="12" font-weight="700" text-anchor="middle">Singer 2</text>
<text x="566.5" y="214" font-size="12" text-anchor="middle">Album 2-1</text>
<path d="M18,232 v6 h359 v-6 M197.5,238 v5" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.2"/>
<path d="M387,232 v6 h236 v-6 M505,238 v5" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.2"/>
<text x="197.5" y="256" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">stored together</text>
<text x="505" y="256" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">stored together</text>
</svg>`,
          caption: "Top: the document is one value on one page, so a page view costs one lookup, while the normalized profile is spread over four tables, each with its own index probe and page read. Bottom: Spanner's interleaved tables give a relational schema the same physical grouping.",
        },
        {
          type: "text",
          html: `<h3>What locality costs</h3>
<p>The win only holds if you need most of the document at once. Reading a single field still makes the database fetch and decode the whole thing, which is wasteful when documents are large. Writes are worse: changing one field usually means writing a new copy of the entire document, because rewriting in place is only easy when the change leaves the encoded document the same size. Hence the standard advice: keep documents fairly small, and avoid write patterns that make a document grow without bound.</p>
<p>Growth also has a hard edge: at the 16 MB cap, "append every event to the user" stops being slow and starts failing. The usual fix is to give events their own collection, keyed by user ID and timestamp, and to embed only a bounded summary (say, the last ten actions) in the user, which MongoDB's guidance calls the <em>subset pattern</em>.</p>
<p>Putting JSON in a relational column doesn't escape the trade-off. PostgreSQL compresses and/or moves large field values out of the main table once a row would exceed about 2 kB, a mechanism called <strong>TOAST</strong>. A big <code>jsonb</code> value therefore behaves like a blob: reading one key means fetching and decompressing the whole value.</p>
<h3>Locality without documents</h3>
<p>Grouping related data physically is a storage decision, not something only the document model can do. Google's <strong>Spanner</strong> lets a relational schema declare a child table <code>INTERLEAVE IN PARENT</code>, so a singer's album rows are stored right after the singer's own row. Oracle's multi-table index cluster tables do something similar, and the <em>column families</em> of Bigtable's data model, also used by Cassandra and HBase, group the data that is read together. Column-oriented storage for analytics is a different kind of locality again, one that Chapter 3 covers.</p>
<h3>The two models are converging</h3>
<p>Through the 2010s each side quietly adopted the other's best ideas. Relational databases learned to store, index and query JSON: PostgreSQL from 9.2 (with the indexable <code>jsonb</code> in 9.4), MySQL from 5.7, IBM DB2 from 10.5, and the SQL standard from SQL:2016. Document databases moved the other way. RethinkDB supported relational-style joins, and some MongoDB drivers resolve a reference to another document automatically, though by sending a second query from the client: a join, performed slowly and with an extra round-trip. MongoDB later added an in-database join, <code>$lookup</code>, and schema validation.</p>
<p>The upshot is that a <strong>hybrid</strong> suits many applications: a relational schema for the entities and relationships you query across, plus a JSON column for the genuinely variable part, such as product attributes or user preferences.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "MongoDB",
              title: "Unbounded arrays are an anti-pattern",
              tag: "Schema design",
              html: "MongoDB's manual lists unbounded arrays as a schema-design anti-pattern, warning that they can push a document past the 16 MB limit. Its fixes are the two from this section: embed a small subset (a book's newest reviews) and keep the rest in their own collection, or reference every child by ID.",
            },
            {
              org: "Google Spanner",
              title: "Parent and child rows stored together",
              tag: "Interleaving",
              html: "A schema can declare a child table <code>INTERLEAVE IN PARENT</code>, storing child rows physically next to their parent (a singer's albums next to the singer): document-like locality inside a relational schema.",
            },
            {
              org: "PostgreSQL",
              title: "Big JSON values live out of line",
              tag: "TOAST",
              html: "Field values that would push a row past roughly 2 kB are compressed and/or stored out of line, so a large <code>jsonb</code> document must be fetched and decompressed in full to read one key.",
            },
            {
              org: "Azure Cosmos DB",
              title: "One service, many models",
              tag: "Multi-model",
              html: "Microsoft pitches its managed database as one service for document, key-value, graph, table and vector data, reached through several APIs: a product built on the convergence trend.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book was published, the convergence has kept going. MongoDB gained schema validation and multi-document ACID transactions (the table below has the versions). On the relational side, PostgreSQL 17 (2024) implemented the standard <code>JSON_TABLE</code>, and SQL:2023 added a native JSON data type. Multi-model services go further still. "Document or relational?" is now mostly a question of how you model each piece of data, not which database you install.</p>`,
        },
        {
          type: "table",
          title: "Each camp borrowed the other's features",
          headers: ["Feature", "Borrowed by", "Arrived in"],
          rows: [
            ["PostgreSQL <code>json</code>, then indexable <code>jsonb</code>", "Relational side", "9.2 (2012), 9.4 (2014)"],
            ["MySQL native JSON type", "Relational side", "5.7 (2015)"],
            ["JSON functions in the SQL standard (<code>JSON_VALUE</code>, <code>JSON_TABLE</code>)", "Relational side", "SQL:2016"],
            ["MongoDB in-database join, <code>$lookup</code>", "Document side", "3.2 (2015)"],
            ["MongoDB recursive lookup, <code>$graphLookup</code>", "Document side", "3.4 (2016)"],
            ["MongoDB schema validation, then <code>$jsonSchema</code>", "Document side", "3.2 (2015), 3.6 (2017)"],
            ["MongoDB multi-document ACID transactions", "Document side", "4.0 (2018), sharded in 4.2 (2019)"],
          ],
          note: "Versions are first releases of each feature; most have grown considerably since.",
        },
        {
          type: "compare",
          title: "Embed in one document, or split into rows?",
          items: [
            {
              title: "Embed (locality wins)",
              tone: "ok",
              html: `<ul>
<li>The page or API call needs the whole tree at once: a profile, an order with its line items, an article with its sections.</li>
<li>Children belong to exactly one parent and their number is bounded.</li>
<li>The tree is read far more often than its parts are updated.</li>
<li>You want the unit to live on one shard and be written atomically (single-document writes are atomic).</li>
</ul>`,
            },
            {
              title: "Split into rows or collections",
              tone: "info",
              html: `<ul>
<li>A child list grows without bound: events, comments, followers.</li>
<li>You often read or update one small part of a large document.</li>
<li>The nested items are shared facts (companies, regions, tags), which makes them many-to-one: store an ID, as <a href="#/ch2/learn/many-to-one">IDs, not strings</a> explains.</li>
<li>Most queries slice across many parents ("all positions at Acme, newest first") rather than load one. An index on an array field helps, but a separate table is often the more natural home.</li>
</ul>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Expect "Would you store user profiles in MongoDB or PostgreSQL?" A weak answer picks a camp. A strong one starts from access patterns. <em>What unit do we read and write?</em> If it's the whole profile, embed the one-to-many parts for locality. <em>What grows?</em> Unbounded lists (activity, followers) get their own collection or table, because an ever-growing document gets slower to rewrite and eventually hits the 16 MB limit. <em>What's shared?</em> Employers and schools are many-to-one, so reference them by ID. Then note that PostgreSQL with a <code>jsonb</code> column, or MongoDB with <code>$lookup</code> and transactions, can both implement that design, and that a large <code>jsonb</code> value is TOASTed, so the locality trade-off exists inside PostgreSQL too.</p>`,
        },
        {
          type: "quiz",
          q: "A 'user' document embeds an ever-growing array of activity events, one appended per click. What goes wrong as the array grows?",
          options: [
            "Reads get faster thanks to locality.",
            "Each append rewrites an ever-larger document, every profile read drags the whole history along, and eventually the document hits the size limit (16 MB in MongoDB). Events belong in their own collection keyed by user.",
            "JSON arrays can't hold more than 1,000 elements.",
            "The collection silently becomes schema-on-write.",
          ],
          answer: 1,
          explain: "Locality pays off only when you need most of the document at once. An unbounded array turns every small write into a rewrite of a growing document and every profile read into a large read, and MongoDB will eventually reject the document at 16 MB. A is the tempting half-truth: locality helps the first few reads, then the growth makes every access more expensive. There is no 1,000-element limit on arrays (C), and adding data doesn't change how a database enforces schemas (D).",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "declarative-queries",
      title: "Say what, not how: why declarative queries won",
      kicker: "Query languages",
      concepts: ["declarative-vs-imperative-query", "query-optimizer"],
      blocks: [
        {
          type: "problem",
          html: `<p>Before relational databases, applications queried IMS and CODASYL with <strong>imperative code</strong>: a program that walked through records in a particular order and decided at each step what to do next (<a href="#/ch2/learn/repeating-history">Document databases are repeating history</a> describes those systems). Code like that freezes one strategy forever. If someone adds an index next year, the program doesn't use it. If the server grows to 32 cores, the program still runs on one. And if the database moves records around to reclaim space, a program that quietly relied on their order can start returning wrong answers without raising any error.</p>
<p>The trap is just as easy to fall into today. Here is about the most ordinary query there is, find the sharks in a list of animals, written both ways:</p>`,
        },
        {
          type: "code",
          title: "Find the sharks: imperative vs declarative",
          lang: "JavaScript / SQL",
          code: `// Imperative (JavaScript): spell out HOW to find them
function getSharks() {
  const sharks = [];
  for (const animal of animals) {     // visit every element, in order
    if (animal.family === "Sharks") {
      sharks.push(animal);
    }
  }
  return sharks;
}

-- Declarative (SQL): describe WHAT you want
SELECT * FROM animals WHERE family = 'Sharks';`,
        },
        {
          type: "idea",
          html: `<p>A declarative query states the pattern the result must match, not the algorithm that finds it. That leaves the database free to choose, and later change, the indexes, join methods, ordering and parallelism, without anyone touching the query.</p>`,
        },
        {
          type: "text",
          html: `<h3>Two ways to ask</h3>
<p>The loop is <strong>imperative</strong>: it spells out each operation and the order to run them in. You could step through it in a debugger, watching it test each animal and update its variables. The SQL statement is <strong>declarative</strong>: it states the conditions the result must satisfy (and, if you ask, how to sort, group or aggregate it) and says nothing about how to get there. When Codd proposed the relational model, he wrote queries in relational algebra, where this one is a <em>selection</em>:</p>
<span class="formula">sharks = σ<sub>family = 'Sharks'</sub>(animals)</span>
<p>SQL followed that algebra fairly closely, and that is what makes it optimizable: the expression describes a set of rows, so any algorithm that produces that set is a valid way to run it.</p>
<h3>What the database gains by not being told how</h3>
<ul>
<li><strong>Conciseness.</strong> One line instead of a function, with nothing to get subtly wrong.</li>
<li><strong>Freedom to improve.</strong> The query hides the implementation, so the database can introduce a new index, a faster join algorithm or a smarter cache, and existing queries speed up unchanged.</li>
<li><strong>Freedom to reorganize.</strong> The database may move records to reclaim unused space. SQL promises no order unless you write <code>ORDER BY</code>, so no correct query can depend on it, whereas imperative code that walks storage depends on order without saying so.</li>
<li><strong>Parallelism.</strong> Chips now gain speed mostly by adding cores rather than by running each core faster. The loop prescribes a single sequence of steps, which is hard to split across cores or machines; a declarative query describes only a pattern, so the engine can divide the work among workers.</li>
<li><strong>Room to optimize.</strong> SQL is deliberately less expressive than a general-purpose language, and that restriction is exactly what lets the optimizer rearrange the work.</li>
</ul>
<p>The sandbox below makes these benefits concrete. Both programs search the same 24-row table stored on four pages. You can change the world underneath them (add an index, add cores, reorganize storage) and also "hand-optimize" the loop so it stops as soon as it stops seeing sharks, a shortcut that works only while the sharks happen to be stored next to each other.</p>`,
        },
        {
          type: "viz",
          id: "ch2/query-planner",
          title: "Say what, not how",
          caption: "Try running both programs, then turn on the index or pick 4 cores and run them again. Next, turn on <em>Hand-optimize the loop</em>, run it, press <em>Reorganize storage</em> and run it once more. Notice that the SQL text never changes while its plan does, and that after the reorganization the early-exit loop silently returns 2 of 6 sharks.",
        },
        {
          type: "text",
          html: `<h3>What you just saw</h3>
<p>Every improvement landed on the SQL side for free: the index cut the work from 24 rows to 6, four cores cut the time from 24 ticks to 6, and reorganizing storage didn't change its answer at all. The loop got none of it, because its text <em>is</em> its plan. The hand-optimization is the instructive failure. On the original layout it looked like a pure win. After the reorganization it silently lost four sharks: no error, just a shorter list. That class of bug is exactly what data independence was invented to prevent.</p>
<h3>How the optimizer actually chooses</h3>
<p>A database doesn't use every index it can find. A <strong>cost-based optimizer</strong> estimates the cost of several candidate plans from <strong>statistics</strong> it keeps about each table (row counts, how values are distributed) and picks the cheapest. An index pays off for selective predicates, the ones that match a small fraction of rows. When a predicate matches a large share of the table, reading it sequentially (or using a bitmap scan) is usually cheaper than thousands of random index lookups, so the optimizer ignores the index. Sharks are 25% of the toy table, and a real planner might well choose a sequential scan for them. "Declarative" means the database makes that choice from the data as it is today, not that every index always gets used.</p>
<h3>The same idea in the browser</h3>
<p>Suppose a site's navigation menu should give the title of the selected item a blue background. CSS needs one rule; the alternative is to walk the DOM yourself:</p>`,
        },
        {
          type: "code",
          title: "Styling the selected menu item",
          lang: "CSS / JavaScript",
          code: `/* Declarative: CSS */
li.selected > p { background-color: blue; }

// Imperative: walk the DOM by hand
for (const item of document.getElementsByTagName("li")) {
  if (item.className !== "selected") continue;
  for (const node of item.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "P") {
      node.setAttribute("style", "background-color: blue");
    }
  }
}`,
        },
        {
          type: "text",
          html: `<p>The script is longer, but length is the smaller problem. When the user selects another item and the <code>selected</code> class moves, the CSS rule follows automatically, while the script leaves the old item blue until somebody writes more code to undo it. And when browsers shipped faster primitives such as <code>getElementsByClassName</code> and <code>querySelectorAll</code>, hand-written traversal code had to be rewritten to benefit, whereas browser vendors could speed up CSS matching underneath every existing stylesheet. For XML documents, XSL with XPath expressions plays the same declarative role.</p>
<p>Keep this distinction in mind for the rest of the chapter. Cypher, SPARQL and Datalog are declarative too; MapReduce, next, sits somewhere in between.</p>`,
        },
        {
          type: "analogy",
          title: "An address, or turn-by-turn directions",
          html: `<p>Give a taxi driver the address and you've been declarative; read out turn-by-turn directions and you've been imperative. On a normal day both get you there. When a road closes, only the driver who knows the destination can find another route. The one following your directions drives straight into the roadblock.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "IBM System R",
              title: "Cost-based plan selection",
              year: "1979",
              tag: "Optimizer",
              html: "Selinger et al.'s SIGMOD paper introduced cost-based access-path selection: estimate the cost of alternative plans from table statistics and pick the cheapest. Most SQL optimizers since build on that idea.",
            },
            {
              org: "PostgreSQL 9.6",
              title: "Old queries, new cores",
              year: "2016",
              tag: "Parallelism",
              html: "Introduced parallel query (parallel sequential scans, joins and aggregates), so existing SQL could run on several cores with no change to the query text.",
            },
            {
              org: "Apache Spark SQL",
              title: "An optimizer for DataFrames",
              year: "2015",
              tag: "Catalyst",
              html: "The Catalyst optimizer rewrites declarative DataFrame and SQL queries, for example pushing filters down into the data source, which hand-written RDD code could not get automatically.",
            },
            {
              org: "React",
              title: "Declarative user interfaces",
              year: "2013",
              tag: "Declarative UI",
              html: "Open-sourced by Facebook, React popularized describing what the UI should look like for a given state and letting the library compute the DOM changes: the same bargain as CSS versus manual DOM manipulation.",
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "Declarative queries",
          prosLabel: "What declarative buys you",
          consLabel: "What it costs, and the escape hatches",
          pros: [
            "Queries get faster as the database improves: new indexes, join algorithms, parallel execution.",
            "Storage can be reorganized, compacted or repartitioned without breaking applications.",
            "Short queries that state intent, easier to read and review than loops.",
            "The engine can spread the work across cores and machines.",
          ],
          cons: [
            "Less direct control: you influence the plan rather than write it.",
            "Plan regressions: fresh statistics or a version upgrade can make the optimizer pick a worse plan for a query that didn't change.",
            "Diagnose with <code>EXPLAIN</code> / <code>EXPLAIN ANALYZE</code>; fix with up-to-date statistics or better indexes first.",
            "Force when you must: optimizer hints (Oracle, MySQL; the <code>pg_hint_plan</code> extension for PostgreSQL) and plan pinning (Oracle SQL Plan Management, SQL Server Query Store).",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Why does it matter that SQL is declarative?" is a common warm-up, and "the database figures it out" is a weak answer. A strong answer names the mechanism: the query describes a result set, so a <strong>cost-based optimizer</strong> can choose access paths and join orders from current statistics, and storage, indexes and parallelism can change underneath without touching application code. That is data independence, Codd's original argument. Then show you know the price: optimizers misestimate, plans can regress after upgrades or statistics changes, and you respond with <code>EXPLAIN ANALYZE</code>, statistics, indexes and, as a last resort, hints or pinned plans. If asked where imperative code still wins, mention logic the query language can't express, which is why databases also run user-defined functions.</p>`,
        },
        {
          type: "quiz",
          q: "You add an index on animals.family. Which programs get faster without code changes?",
          options: [
            "Both the SQL query and the JavaScript loop.",
            "Only the SQL query: the optimizer can switch to an index scan, while the loop literally iterates over every element.",
            "Only the loop, because it runs in the application.",
            "Neither: SQL needs a query hint to use a new index.",
          ],
          answer: 1,
          explain: "A declarative query leaves the access path to the optimizer, so a new index is considered automatically (and used whenever the statistics say it's cheaper). The loop's code says 'visit every element in order', and nothing can change that without editing it, which rules out A and C. D is a common misconception: hints exist as escape hatches, but optimizers pick up suitable indexes on their own.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "mapreduce-querying",
      title: "MapReduce: a powerful runtime, an awkward query language",
      kicker: "Query languages",
      concepts: ["mapreduce-querying", "aggregation-pipeline"],
      blocks: [
        {
          type: "problem",
          html: `<p>Early document stores such as MongoDB and CouchDB shipped without SQL, yet their users still needed aggregate questions answered. Picture a marine biologist who logs every sighting as a document (date, species, family, number of animals) and wants a monthly report: how many sharks were seen each month? The data may be spread over several machines, so the computation has to travel to where the data lives and run in parallel.</p>
<p>Google's <strong>MapReduce</strong> model (2004) offered a recipe: write a <code>map</code> function and a <code>reduce</code> function, and the system runs them everywhere. It works, with a catch and a cost. The catch: the functions must be pure, or retries and parallel execution corrupt the result. The cost: two carefully coordinated JavaScript functions are much harder to write, and to optimize, than one <code>GROUP BY</code>.</p>`,
        },
        {
          type: "idea",
          html: `<p>MapReduce sits between imperative and declarative. You write snippets of code, but because <code>map</code> and <code>reduce</code> are pure functions of their input, the database decides where and in what order to run them, and can simply run them again after a failure. Their awkwardness as an interface is why systems built on MapReduce kept growing declarative, SQL-like languages on top.</p>`,
        },
        {
          type: "text",
          html: `<p>This section treats MapReduce as a <em>query interface</em> inside a database, the way MongoDB and CouchDB offered it. MapReduce as a distributed batch-processing engine, with its shuffle, sort and join strategies, is the subject of Chapter 10. Here is the report in SQL first, as the yardstick for everything that follows:</p>`,
        },
        {
          type: "code",
          title: "Monthly shark report in PostgreSQL",
          lang: "SQL",
          code: `SELECT date_trunc('month', observed_at) AS month,
       sum(num_animals)                AS total_animals
FROM   observations
WHERE  family = 'Sharks'
GROUP  BY month;`,
        },
        {
          type: "code",
          title: "The same report as a MongoDB mapReduce",
          lang: "JavaScript (MongoDB)",
          code: `// One document per sighting, e.g.
// { observedAt: ISODate("1995-12-25T09:30:00Z"), family: "Sharks",
//   species: "Carcharodon carcharias", numAnimals: 3 }

db.observations.mapReduce(
  function map() {                   // called once per matching document
    const d = this.observedAt;
    emit(d.getFullYear() + "-" + (d.getMonth() + 1), this.numAnimals);
  },
  function reduce(month, counts) {   // called with all values for one key
    return Array.sum(counts);
  },
  {
    query: { family: "Sharks" },     // declarative filter, applied before map
    out: "monthlySharkReport"        // collection that receives the results
  }
);`,
        },
        {
          type: "text",
          html: `<h3>What happens when it runs</h3>
<ol>
<li><strong>Filter.</strong> The <code>query</code> option, <code>{family: "Sharks"}</code>, is the declarative part of the request: the database selects matching documents before any of your code runs.</li>
<li><strong>Map.</strong> <code>map</code> is called once per matching document, with the document available as <code>this</code>. It calls <code>emit(key, value)</code>; here the key is the year and month as a string, such as <code>"1995-12"</code>, and the value is the number of animals.</li>
<li><strong>Group.</strong> The database collects the emitted pairs by key, across every machine that ran <code>map</code>.</li>
<li><strong>Reduce.</strong> <code>reduce</code> is called with one key and all of its values. If four December sightings emitted 3, 4, 1 and 2, the call is <code>reduce("1995-12", [3, 4, 1, 2])</code>, which returns 10.</li>
<li><strong>Output.</strong> One result per key lands in the <code>monthlySharkReport</code> collection.</li>
</ol>
<h3>The rule that makes it work: purity</h3>
<p><code>map</code> and <code>reduce</code> may look only at the data handed to them. They may not query the database for more, and they may not change anything outside themselves, such as writing a file or bumping a counter somewhere else. In exchange, the database is free to run them on any machine, in any order, as many times as it needs. If a node dies halfway through, its partial output is thrown away and the work is redone; because the same input always gives the same output, nobody can tell.</p>
<p>Within that rule the functions are still powerful. They're arbitrary code, so <code>map</code> can parse a messy date string, call a library function or compute a derived value that would be awkward to express in a query language.</p>
<p>The demo below plays the shark report across three shards. It models what the purity rule permits rather than tracing MongoDB's internals: shard B's mapper crashes once and is simply run again. You can then switch to an <em>impure</em> mapper that also bumps a global counter, exactly what the rule forbids (MongoDB doesn't even give these functions database access).</p>`,
        },
        {
          type: "viz",
          id: "ch2/mapreduce-purity",
          title: "Why map and reduce must be pure",
          caption: "Try pressing Play with the pure mapper and shard B's crash turned on, then switch <em>Mapper</em> to <em>Impure</em> and play again. Notice that the reduce output is 10 · 9 · 6 both times, but the side-effect counter ends at 31 instead of 25: the dead attempt's pairs were discarded, its side effect couldn't be.",
        },
        {
          type: "text",
          html: `<h3>Why the impure version lies</h3>
<p>The database could discard shard B's first attempt because its only output was emitted pairs that never reached a bucket. The global counter is different: the increments happened in the outside world the moment <code>map</code> ran, and nothing can take them back. A side effect inside a retried function runs once per <em>attempt</em>, not once per input, and shows only when something crashes, which makes it hard to catch in testing. The same reasoning returns for batch and stream processors in Chapters 10 and 11.</p>
<h3>Reduce can run more than once</h3>
<p>MongoDB adds a subtlety. For a key with many values it may reduce them in batches, then call <code>reduce</code> again with earlier results mixed in among new values (a <em>re-reduce</em>). It also skips <code>reduce</code> entirely for a key that has only one value. So <code>reduce</code> must return the same kind of value that <code>map</code> emits, and it must give the same answer however the values are grouped and ordered: associative, commutative and idempotent under re-reduction. Summing is safe. Averaging is the classic bug: <code>reduce</code> on <code>[3, 4]</code> returns 3.5, a later call on <code>[3.5, 1, 2]</code> returns about 2.17, but the true average of 3, 4, 1 and 2 is 2.5. The fix is to emit <code>{sum, count}</code> pairs, add both up in <code>reduce</code>, and divide once at the end (MongoDB's <code>finalize</code> option exists for that last step).</p>
<h3>A runtime, not a query language</h3>
<p>MapReduce is a low-level model for spreading computation across a cluster, and higher-level languages can compile down to it: Facebook's Hive turned SQL-like queries into pipelines of MapReduce jobs. But the two aren't tied together. Nothing about SQL confines it to one machine, and many distributed SQL engines never used MapReduce at all; Spark SQL, for instance, compiles queries into Spark's own execution stages.</p>
<p>Running your own code inside a query isn't unique to MapReduce either: SQL databases run user-defined functions in PL/pgSQL, PL/Python or (with the plv8 extension) JavaScript. The difference is that in MapReduce the code <em>is</em> the query, so the database can see and optimize far less of it, and two carefully coordinated functions are harder to write than one query. MongoDB's answer, in version 2.2, was the <strong>aggregation pipeline</strong>: a declarative query language expressed as a list of JSON stages. The shark report becomes:</p>`,
        },
        {
          type: "code",
          title: "The same report as an aggregation pipeline",
          lang: "JavaScript (MongoDB)",
          code: `db.observations.aggregate([
  { $match: { family: "Sharks" } },
  { $group: {
      _id: { year:  { $year:  "$observedAt" },
             month: { $month: "$observedAt" } },
      totalAnimals: { $sum: "$numAnimals" }
  } }
]);`,
          caption: "Each stage is a declarative operator, much like a clause of SQL: <code>$match</code> plays <code>WHERE</code> and <code>$group</code> plays <code>GROUP BY</code>. A NoSQL system had, in effect, reinvented SQL with JSON syntax, and because the stages are visible, the database can reorder them and use an index for a leading <code>$match</code>.",
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google MapReduce",
              title: "Retries that rely on purity",
              year: "2004",
              tag: "OSDI paper",
              html: "Dean and Ghemawat's <em>MapReduce: Simplified Data Processing on Large Clusters</em> popularized the model. Re-executing failed tasks is its core fault-tolerance mechanism, which works only because map and reduce are deterministic functions of their input.",
            },
            {
              org: "MongoDB",
              title: "From map-reduce to pipelines",
              year: "2012 / 2021",
              tag: "Aggregation",
              html: "Version 2.2 introduced the aggregation framework (pipeline). Version 5.0 deprecated map-reduce and told users to rewrite map-reduce operations as aggregation pipelines.",
            },
            {
              org: "Apache CouchDB",
              title: "Map functions as indexes",
              tag: "Views",
              html: "CouchDB views are JavaScript map functions (with optional reduce functions) stored in design documents. Their results live in a B-tree index that is updated incrementally as documents change.",
            },
            {
              org: "Apache Hive",
              title: "SQL compiled to MapReduce",
              year: "2008",
              tag: "Facebook",
              html: "Built at Facebook and open-sourced in 2008, Hive let analysts write SQL-like HiveQL that was compiled into Hadoop MapReduce jobs: MapReduce as the runtime, SQL as the interface.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>MongoDB's own deprecation of map-reduce (above) matches the wider industry: even for very large data, SQL won as the interface while the engines underneath kept changing. Hive and Spark SQL on clusters, Presto/Trino and BigQuery for interactive analytics, and Flink SQL and ksqlDB for streams all let users write declarative queries and leave execution to the engine.</p>`,
        },
        {
          type: "tradeoffs",
          title: "MapReduce as a query interface",
          prosLabel: "What MapReduce does well",
          consLabel: "Where it hurts as a query interface",
          pros: [
            "Arbitrary code per record: parsing, library calls and custom math a query language can't express.",
            "Runs where the data lives, in parallel across shards.",
            "Purity makes failure handling trivial: discard the failed attempt and run it again.",
          ],
          cons: [
            "Two functions that must agree on key and value formats, instead of one query.",
            "Re-reduce rules (same type, associative, commutative) are easy to violate, and the bug may surface only at scale.",
            "The optimizer can't see inside the functions, so it can't reorder them, push filters into them or pick indexes for them.",
            "No natural place for joins; the aggregation pipeline (with <code>$lookup</code>) or SQL handles them better.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A typical prompt: "Why must map and reduce be side-effect-free?" Answer with the mechanism. The framework gets fault tolerance and parallelism by running tasks wherever it likes and re-executing failed (or slow) ones, so a task must produce the same output every time and must not touch the outside world. Then say what breaks otherwise: counters double-count, emails go out twice, external writes duplicate. A strong candidate adds the re-reduce constraint (averages are computed from sums and counts, never by averaging averages) and separates <strong>interface from runtime</strong>: MapReduce is an execution model, and today most people express the same jobs in SQL or a DataFrame API and let an engine such as Spark plan them.</p>`,
        },
        {
          type: "quiz",
          q: "Why is it safe for the database to re-run a map function after a node fails mid-job?",
          options: [
            "It checkpoints the function's local variables and resumes from them.",
            "Because map is a pure function of its input document: re-running it emits the same pairs and has no side effects, so the failed attempt's output can simply be discarded.",
            "Because reduce removes duplicate emitted pairs.",
            "Because a mapReduce job always runs on a single machine.",
          ],
          answer: 1,
          explain: "Determinism plus no side effects make retries invisible: the system throws away the failed attempt's output and runs map again. C is the tempting one, but reduce doesn't deduplicate anything; if both attempts' pairs were kept, the sums would be double-counted. That is why the failed attempt's output is discarded, and why side effects, which can't be discarded, are forbidden.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "property-graphs",
      title: "When everything connects: property graphs and variable-depth queries",
      kicker: "Graph models",
      concepts: ["graph-model", "property-graph", "recursive-cte"],
      blocks: [
        {
          type: "problem",
          html: `<p>As many-to-many relationships come to dominate (who follows whom, which page links to which, which accounts share a phone number), a relational schema sprouts join tables, and some questions need a number of joins that nobody can predict. Take "who was born in the United States and now lives in Europe?" It sounds like two lookups. But one person's birthplace is recorded as a city, another's as a state and a third's as the country itself, so the path from a person to "United States" is 0, 1 or 2 hops long, and the path to "Europe" can be 3.</p>
<p>A SQL query with a fixed number of joins answers correctly for the depths you planned for and silently drops everyone deeper. When someone later inserts a level into the location hierarchy, it drops even more people, still without an error.</p>`,
        },
        {
          type: "idea",
          html: `<p>Model entities as <strong>vertices</strong> and relationships as labeled <strong>edges</strong> that carry their own properties. A graph query can then follow edges for as many hops as it takes (<code>:WITHIN*0..</code> in Cypher), which is natural in a graph language and possible, though clumsy, in SQL with recursion.</p>`,
        },
        {
          type: "text",
          html: `<h3>Vertices and edges</h3>
<p>A graph has two kinds of object: <strong>vertices</strong> (nodes, entities) and <strong>edges</strong> (relationships, arcs). Classic examples are a social graph of people who know each other, the web graph of pages linking to pages (which PageRank uses to rank search results), and road or rail networks, where routing is a shortest-path search. The vertices needn't be one kind of thing: Facebook keeps a single graph of people, locations, events, check-ins and comments, with edges for friendships, check-ins, comments and attendance.</p>
<p>Our running example is small. Lucy was born in Idaho; Alain was born in Beaune, France; they are married and live in London. Places nest through <code>WITHIN</code> edges: Idaho within the United States within North America; Beaune within Burgundy within France within Europe; London within England within the United Kingdom within Europe.</p>
<h3>The property graph model</h3>
<p>In a <strong>property graph</strong> (the model of Neo4j, among others), every vertex has a unique identifier, a set of outgoing edges, a set of incoming edges and a collection of properties (key-value pairs). Every edge has a unique identifier, a <strong>tail</strong> vertex where it starts, a <strong>head</strong> vertex where it ends, a label describing the relationship, and its own properties. (In Neo4j a node can carry several labels; each relationship has exactly one type.) Edges are directed, but queries can follow them either way. Two relational tables can store exactly that:</p>`,
        },
        {
          type: "diagram",
          title: "A property graph as two tables",
          svg: `<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A vertices table and an edges table whose tail_vertex and head_vertex columns reference vertex_id; on the right, Lucy BORN_IN Idaho WITHIN United States, with the BORN_IN edge shown as one row of the edges table">
<defs>
<marker id="ch2d2-pg-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
<marker id="ch2d2-pg-arr7" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c7)"/></marker>
</defs>
<rect x="40" y="16" width="196" height="72" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="52" y="34" font-size="13" font-weight="700">vertices</text>
<line x1="40" y1="42" x2="236" y2="42" style="stroke: var(--viz-line)"/>
<text x="52" y="60" font-size="12" style="font-family: var(--font-mono)">vertex_id</text>
<text x="226" y="60" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-muted)">PK</text>
<text x="52" y="78" font-size="12" style="font-family: var(--font-mono)">properties</text>
<text x="226" y="78" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">JSON</text>
<rect x="40" y="104" width="196" height="128" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="52" y="122" font-size="13" font-weight="700">edges</text>
<line x1="40" y1="130" x2="236" y2="130" style="stroke: var(--viz-line)"/>
<text x="52" y="148" font-size="12" style="font-family: var(--font-mono)">edge_id</text>
<text x="226" y="148" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-muted)">PK</text>
<text x="52" y="166" font-size="12" style="font-family: var(--font-mono)">tail_vertex</text>
<rect x="148" y="154" width="46" height="16" rx="4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="171" y="166" font-size="12" text-anchor="middle">index</text>
<text x="226" y="166" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-muted)">FK</text>
<text x="52" y="184" font-size="12" style="font-family: var(--font-mono)">head_vertex</text>
<rect x="148" y="172" width="46" height="16" rx="4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="171" y="184" font-size="12" text-anchor="middle">index</text>
<text x="226" y="184" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-muted)">FK</text>
<text x="52" y="202" font-size="12" style="font-family: var(--font-mono)">label</text>
<text x="52" y="220" font-size="12" style="font-family: var(--font-mono)">properties</text>
<text x="226" y="220" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">JSON</text>
<path d="M40,162 C18,162 18,57 38,57" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.4" marker-end="url(#ch2d2-pg-arr)"/>
<path d="M40,180 C6,180 6,63 38,63" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.4" marker-end="url(#ch2d2-pg-arr)"/>
<rect x="284" y="26" width="96" height="44" rx="22" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="332" y="44" font-size="12" font-weight="700" text-anchor="middle">Lucy</text>
<text x="332" y="61" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">{name}</text>
<rect x="476" y="26" width="152" height="44" rx="22" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="552" y="44" font-size="12" font-weight="700" text-anchor="middle">Idaho</text>
<text x="552" y="61" font-size="12" text-anchor="middle">{name, type: state}</text>
<line x1="380" y1="48" x2="473" y2="48" style="stroke: var(--viz-c7); stroke-width: 2" marker-end="url(#ch2d2-pg-arr7)"/>
<text x="427" y="40" font-size="12" font-weight="700" text-anchor="middle">BORN_IN</text>
<rect x="476" y="118" width="152" height="44" rx="22" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="552" y="136" font-size="12" font-weight="700" text-anchor="middle">United States</text>
<text x="552" y="153" font-size="12" text-anchor="middle">{name, type: country}</text>
<line x1="552" y1="70" x2="552" y2="115" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch2d2-pg-arr)"/>
<text x="544" y="98" font-size="12" font-weight="700" text-anchor="end">WITHIN</text>
<line x1="427" y1="54" x2="427" y2="182" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<text x="436" y="182" font-size="12" style="fill: var(--viz-muted)">stored as one row of edges</text>
<text x="328" y="198" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">edge_id</text>
<text x="394" y="198" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">tail</text>
<text x="460" y="198" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">head</text>
<text x="526" y="198" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">label</text>
<rect x="295" y="204" width="66" height="26" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="361" y="204" width="66" height="26" rx="4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<rect x="427" y="204" width="66" height="26" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="493" y="204" width="66" height="26" rx="4" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="328" y="221" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">e1</text>
<text x="394" y="221" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">Lucy</text>
<text x="460" y="221" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">Idaho</text>
<text x="526" y="221" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">born_in</text>
</svg>`,
          caption: "Every edge is one row in <code>edges</code> that points at two rows in <code>vertices</code>. The indexes on <code>tail_vertex</code> and <code>head_vertex</code> are what make it cheap to find a vertex's outgoing and incoming edges. (The row shows names for readability; the real columns hold vertex IDs.)",
        },
        {
          type: "code",
          title: "A property graph in two tables (PostgreSQL)",
          lang: "SQL",
          code: `CREATE TABLE vertices (
  vertex_id   integer PRIMARY KEY,
  properties  jsonb
);

CREATE TABLE edges (
  edge_id     integer PRIMARY KEY,
  tail_vertex integer REFERENCES vertices (vertex_id),
  head_vertex integer REFERENCES vertices (vertex_id),
  label       text,
  properties  jsonb
);

-- Find a vertex's outgoing and incoming edges efficiently
CREATE INDEX edges_by_tail ON edges (tail_vertex);
CREATE INDEX edges_by_head ON edges (head_vertex);`,
        },
        {
          type: "text",
          html: `<h3>Three properties that make graphs flexible</h3>
<ol>
<li><strong>Anything can connect to anything.</strong> No schema restricts which kinds of vertex may be associated, so a person can be linked to a city, a company, an allergen or another person.</li>
<li><strong>Traversal works in both directions.</strong> Given a vertex, the two indexes find its outgoing and incoming edges efficiently, so a query can walk forward (where was Lucy born?) or backward (who was born in Idaho?).</li>
<li><strong>Labels keep many relationships in one graph.</strong> <code>BORN_IN</code>, <code>LIVES_IN</code>, <code>WITHIN</code> and <code>MARRIED</code> share the same tables, yet the model stays clean because every edge says what it means.</li>
</ol>
<p>Together these make graphs good at absorbing messy, changing data. Real geography is irregular: France is divided into régions and départements while the US uses states and counties, a country can sit inside another country (England within the United Kingdom), and one record names a city where another names only a state (Lucy's home is a city, her birthplace a state). A graph takes all of it without schema changes. Need food allergies later? Add allergen vertices and an edge from each person to what they're allergic to, and a query can find which foods are safe for whom.</p>
<h3>Cypher: asking with a picture</h3>
<p><strong>Cypher</strong> is the declarative query language created for Neo4j. Its name comes from a character in <em>The Matrix</em>, not from cryptography. Patterns are drawn with arrows, so <code>(lucy) -[:BORN_IN]-&gt; (idaho)</code> reads exactly like the edge it creates or matches:</p>`,
        },
        {
          type: "code",
          title: "Building and querying the graph in Cypher",
          lang: "Cypher",
          code: `CREATE
  (namerica:Location {name: 'North America',  type: 'continent'}),
  (usa:Location      {name: 'United States',  type: 'country'}),
  (idaho:Location    {name: 'Idaho',          type: 'state'}),
  (europe:Location   {name: 'Europe',         type: 'continent'}),
  (uk:Location       {name: 'United Kingdom', type: 'country'}),
  (england:Location  {name: 'England',        type: 'country'}),
  (london:Location   {name: 'London',         type: 'city'}),
  (lucy:Person       {name: 'Lucy'}),
  (idaho)  -[:WITHIN]-> (usa) -[:WITHIN]-> (namerica),
  (london) -[:WITHIN]-> (england) -[:WITHIN]-> (uk) -[:WITHIN]-> (europe),
  (lucy)   -[:BORN_IN]->  (idaho),
  (lucy)   -[:LIVES_IN]-> (london);
// (Alain, Beaune, Burgundy and France are created the same way.)

// Who was born in the United States and now lives in Europe?
MATCH
  (person) -[:BORN_IN]->  () -[:WITHIN*0..]-> (:Location {name: 'United States'}),
  (person) -[:LIVES_IN]-> () -[:WITHIN*0..]-> (:Location {name: 'Europe'})
RETURN person.name;`,
        },
        {
          type: "text",
          html: `<p>The <code>MATCH</code> clause describes two paths that start at the same person. <code>[:WITHIN*0..]</code> means "follow a <code>WITHIN</code> edge zero or more times", so it doesn't matter whether the birthplace is the United States itself (0 hops), a state (1) or a city (2). Because the query is declarative, the optimizer picks the strategy: start from every person and climb, or use an index on <code>name</code> to find the two named locations, walk their incoming <code>WITHIN</code> edges downward to collect every place inside them, and intersect the people attached to both sets. Same query text, different plans.</p>
<p>The visualization asks that question of a five-person graph in three query styles. Add a level to the hierarchy and watch what each one does.</p>`,
        },
        {
          type: "viz",
          id: "ch2/graph-traversal",
          title: "Born in the US, living in Europe",
          caption: "Pick a query and press <em>▶ Run query</em>: <em>Cypher *0..</em> first, then <em>SQL, fixed joins</em> with k from 1 up to 3, then turn on <em>Add a level: Greater London</em> and run k = 3 again. Notice that the fixed-join query never raises an error; it just finds fewer people, while Cypher and <em>SQL WITH RECURSIVE</em> find Lucy, Sam and Maya at any depth.",
        },
        {
          type: "text",
          html: `<h3>The same question in SQL</h3>
<p>The fixed-join query encodes a fixed path length: with k = 3 it finds all three people, until Greater London pushes Lucy four levels below Europe and the answer silently shrinks. SQL can follow paths of unknown length with a <strong>recursive common table expression</strong>, written <code>WITH RECURSIVE</code> in PostgreSQL, MySQL 8.0 and SQLite (IBM DB2, Oracle and SQL Server spell it without <code>RECURSIVE</code>). Over the two tables, the emigrants query becomes:</p>`,
        },
        {
          type: "code",
          title: "The emigrants query with WITH RECURSIVE (PostgreSQL)",
          lang: "SQL",
          code: `WITH RECURSIVE
  -- every location inside the United States, at any depth
  in_usa(vertex_id) AS (
      SELECT vertex_id FROM vertices
      WHERE properties->>'name' = 'United States'
    UNION
      SELECT e.tail_vertex
      FROM edges e JOIN in_usa ON e.head_vertex = in_usa.vertex_id
      WHERE e.label = 'within'
  ),
  -- every location inside Europe, at any depth
  in_europe(vertex_id) AS (
      SELECT vertex_id FROM vertices
      WHERE properties->>'name' = 'Europe'
    UNION
      SELECT e.tail_vertex
      FROM edges e JOIN in_europe ON e.head_vertex = in_europe.vertex_id
      WHERE e.label = 'within'
  ),
  -- people born somewhere in the US
  born_in_usa(vertex_id) AS (
    SELECT e.tail_vertex
    FROM edges e JOIN in_usa ON e.head_vertex = in_usa.vertex_id
    WHERE e.label = 'born_in'
  ),
  -- people living somewhere in Europe
  lives_in_europe(vertex_id) AS (
    SELECT e.tail_vertex
    FROM edges e JOIN in_europe ON e.head_vertex = in_europe.vertex_id
    WHERE e.label = 'lives_in'
  )
SELECT v.properties->>'name' AS name
FROM vertices v
JOIN born_in_usa     ON v.vertex_id = born_in_usa.vertex_id
JOIN lives_in_europe ON v.vertex_id = lives_in_europe.vertex_id;`,
        },
        {
          type: "text",
          html: `<p>Read it from the top. <code>in_usa</code> starts with the vertex named United States, and each iteration adds every vertex whose <code>within</code> edge points at something already in the set, until an iteration adds nothing; <code>in_europe</code> does the same from Europe. Two plain CTEs then find who was born in a US place and who lives in a European one, and the final <code>SELECT</code> intersects them. It is correct at any depth, and over 30 lines long against Cypher's four (the book makes the same point with 29 lines to 4). Neither model is wrong; each was designed for a different shape of question.</p>
<h3>Cycles, cost and other graph languages</h3>
<p>Real graphs have cycles, so does an unbounded traversal ever end? Within one <code>MATCH</code>, Cypher never traverses the same relationship twice, so <code>*0..</code> terminates even on cyclic data. Terminating isn't the same as cheap: on a large, dense graph an unbounded pattern can explore an enormous number of paths, so production queries usually bound the depth (<code>*1..4</code>). In SQL, <code>UNION</code> (unlike <code>UNION ALL</code>) discards rows already produced, which also stops a recursive CTE like this one from looping, and PostgreSQL 14 added <code>SEARCH</code> and <code>CYCLE</code> clauses for explicit cycle detection.</p>
<p>Not every graph language is declarative: <strong>Gremlin</strong> (Apache TinkerPop) is an imperative traversal language. Large-scale graph algorithms such as PageRank, run Pregel-style across a cluster, belong to Chapter 10.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Facebook TAO",
              title: "One graph for a social network",
              year: "2013",
              tag: "Social graph",
              html: "TAO stores the social graph as typed objects (vertices) and associations (directed, typed edges). The USENIX ATC paper reports about a billion reads and millions of writes per second, over many petabytes of data.",
            },
            {
              org: "ICIJ Panama Papers",
              title: "Following offshore ownership chains",
              year: "2016",
              tag: "Investigation",
              html: "Journalists loaded the people, companies and intermediaries from 11.5 million leaked documents into a Neo4j graph and explored it with Linkurious, following offshore ownership chains by traversal.",
            },
            {
              org: "Google Knowledge Graph",
              title: "Entities instead of keywords",
              year: "2012",
              tag: "Search",
              html: "Launched under the slogan \"things, not strings\", it lets search answer questions about entities (people, places, things) and the relationships between them rather than only matching words.",
            },
            {
              org: "ISO GQL and SQL/PGQ",
              title: "Graph queries get a standard",
              year: "2023 / 2024",
              tag: "Standards",
              html: "SQL:2023 introduced SQL/PGQ for property-graph queries over relational tables, and in April 2024 ISO published GQL (ISO/IEC 39075), the first new ISO database query language standard since SQL.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Graph queries are being folded into SQL itself. <strong>SQL:2023</strong> added SQL/PGQ (Part 16), a standard way to declare a property-graph view over existing relational tables and query it with <code>MATCH</code> patterns. In April 2024 ISO published <strong>GQL</strong> (ISO/IEC 39075), a dedicated graph query language strongly influenced by Cypher, which Neo4j had opened up as openCypher in 2015. Managed services hedge across models: Amazon Neptune accepts Gremlin, openCypher and SPARQL queries.</p>`,
        },
        {
          type: "tradeoffs",
          title: "The graph model",
          prosLabel: "The graph model shines when",
          consLabel: "Think twice when",
          pros: [
            "Relationships are the point: social networks, fraud rings, recommendations, network topology, knowledge graphs, permission hierarchies.",
            "Paths have variable or unknown length, and new kinds of relationship keep arriving.",
            "Queries start at a vertex and explore its neighborhood a few hops out, instead of scanning everything.",
          ],
          cons: [
            "The workload is mostly whole-record reads or big aggregations: documents or column stores fit better.",
            "Multi-hop queries aren't free: unbounded traversals on dense graphs can be very expensive, and at shallow depth a well-indexed SQL query can compete.",
            "Graphs are notoriously hard to partition across machines (Chapter 10), because any vertex may link to any other.",
            "Fewer people and tools know graph query languages than SQL, though GQL and SQL/PGQ are narrowing that gap.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design friend-of-friend recommendations" or "find accounts linked to a known fraudster" are graph questions in disguise. Name the shape first: variable-depth traversal over many-to-many relationships. Then weigh options honestly: a graph database (Neo4j, Neptune) with Cypher or Gremlin, or an <code>edges</code> table indexed on both endpoints plus <code>WITH RECURSIVE</code>, often enough when depth is shallow and bounded. Mention cycles, depth limits and <em>supernodes</em> (a celebrity with millions of edges) that blow up every traversal through them. Don't claim graph databases are always faster than joins; it depends on depth, fan-out and indexes.</p>`,
        },
        {
          type: "quiz",
          q: "A SQL query uses exactly two self-joins to walk city → state → country. Next month the data team inserts 'county' between city and state. What happens to the query's results?",
          options: [
            "The database raises an error because the hierarchy changed.",
            "It silently returns fewer rows: people whose path is now three hops are missed, with no error.",
            "It adapts automatically because SQL is declarative.",
            "It returns duplicate rows for the new county level.",
          ],
          answer: 1,
          explain: "A fixed number of joins encodes a fixed path length. The query is still valid SQL, so there's no error (A); it simply stops one level short of the country for everyone whose path grew. Declarative doesn't mean depth-agnostic (C): you have to ask for variable-length traversal explicitly, with WITH RECURSIVE in SQL or *0.. in Cypher.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "triples-and-datalog",
      title: "Graphs as facts: triple-stores, SPARQL and Datalog",
      kicker: "Graph models",
      concepts: ["triple-store-rdf-sparql", "datalog", "codasyl-network-model"],
      blocks: [
        {
          type: "problem",
          html: `<p>Two organizations decide to merge their knowledge graphs. Both use a predicate called <code>name</code>, but one means legal name and the other display name. Both have a vertex called <code>lucy</code>, and they are different people. Merge naively and you silently fuse two people into one and blend two meanings of the same word.</p>
<p>A second pain lives inside a single dataset: the "is X somewhere inside Y?" recursion from the previous section is restated in every query that needs it (<code>*0..</code> in Cypher, a 30-line CTE in SQL), with no way to define it once, name it and reuse it. Triple-stores attack the first problem by reducing every statement to <em>(subject, predicate, object)</em> and naming things with globally unique URIs. Datalog attacks the second by treating data as facts and queries as named rules that derive new facts, rules that can call other rules, including themselves.</p>`,
        },
        {
          type: "idea",
          html: `<p>Any graph can be flattened into three-part facts. Once data is facts, a query can be a set of <strong>rules</strong> that derive new facts, and a recursive rule handles variable depth by being applied round after round until a round adds nothing new.</p>`,
        },
        {
          type: "text",
          html: `<h3>Everything is a triple</h3>
<p>A <strong>triple-store</strong> holds all information as statements of the form <em>(subject, predicate, object)</em>, such as <em>(Jim, likes, bananas)</em>. The subject plays the role of a vertex. The object is one of two things:</p>
<ul>
<li>A <strong>primitive value</strong>, such as a string or a number. Then predicate and object together are a property of the subject: <em>(lucy, age, 33)</em> is like a vertex with the property <code>{age: 33}</code>.</li>
<li><strong>Another vertex</strong>. Then the triple is an edge: <em>(lucy, marriedTo, alain)</em> has <code>lucy</code> as its tail, <code>marriedTo</code> as its label and <code>alain</code> as its head.</li>
</ul>
<p>Properties and edges are the same mechanism, which is a large part of why triples are easy to store and easy to merge. The same fact can be drawn as a property-graph edge, written as an RDF triple, or written as a Datalog fact:</p>`,
        },
        {
          type: "diagram",
          title: "One fact, three notations",
          svg: `<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lucy BORN_IN Idaho drawn as a graph edge, as an RDF triple of subject, predicate and object, and as the Datalog fact born_in(lucy, idaho)">
<defs><marker id="ch2d2-tr-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c3)"/></marker></defs>
<text x="16" y="47" font-size="12" font-weight="700">Property graph</text>
<text x="16" y="108" font-size="12" font-weight="700">RDF triple (Turtle)</text>
<text x="16" y="164" font-size="12" font-weight="700">Datalog fact</text>
<circle cx="240" cy="42" r="24" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="240" y="46" font-size="12" font-weight="700" text-anchor="middle">Lucy</text>
<circle cx="540" cy="42" r="24" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="540" y="46" font-size="12" font-weight="700" text-anchor="middle">Idaho</text>
<line x1="264" y1="42" x2="514" y2="42" style="stroke: var(--viz-c3); stroke-width: 2" marker-end="url(#ch2d2-tr-arr)"/>
<text x="390" y="34" font-size="12" font-weight="700" text-anchor="middle">BORN_IN</text>
<line x1="240" y1="66" x2="240" y2="88" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<line x1="390" y1="47" x2="390" y2="88" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<line x1="540" y1="66" x2="540" y2="88" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<rect x="170" y="88" width="140" height="30" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<rect x="320" y="88" width="140" height="30" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<rect x="470" y="88" width="140" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="240" y="108" font-size="12" text-anchor="middle">subject: _:lucy</text>
<text x="390" y="108" font-size="12" text-anchor="middle">predicate: :bornIn</text>
<text x="540" y="108" font-size="12" text-anchor="middle">object: _:idaho</text>
<line x1="240" y1="118" x2="380" y2="146" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<line x1="390" y1="118" x2="302" y2="146" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<line x1="540" y1="118" x2="460" y2="146" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 4 3"/>
<rect x="262" y="146" width="76" height="26" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<rect x="354" y="146" width="56" height="26" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<rect x="426" y="146" width="64" height="26" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="300" y="164" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">born_in</text>
<text x="346" y="164" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">(</text>
<text x="382" y="164" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">lucy</text>
<text x="418" y="164" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">,</text>
<text x="458" y="164" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">idaho</text>
<text x="502" y="164" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">).</text>
</svg>`,
          caption: "The subject is the edge's tail vertex, the predicate is its label and the object is its head. Datalog writes the predicate first, but the three parts are the same.",
        },
        {
          type: "code",
          title: "Part of the example graph in Turtle",
          lang: "Turtle (RDF)",
          code: `@prefix : <http://my-company.example/ns#> .

_:lucy     a :Person ;
           :name      "Lucy" ;
           :bornIn    _:idaho ;
           :livesIn   _:london ;
           :marriedTo _:alain .
_:alain    a :Person ;
           :name      "Alain" ;
           :bornIn    _:beaune ;
           :livesIn   _:london .
_:idaho    a :Location ; :name "Idaho" ;          :within _:usa .
_:usa      a :Location ; :name "United States" ;  :within _:namerica .
_:namerica a :Location ; :name "North America" .
_:london   a :Location ; :name "London" ;         :within _:england .
_:england  a :Location ; :name "England" ;        :within _:uk .
_:uk       a :Location ; :name "United Kingdom" ; :within _:europe .
_:europe   a :Location ; :name "Europe" .
# (Beaune, Burgundy and France follow the same pattern.)`,
        },
        {
          type: "text",
          html: `<p><strong>Turtle</strong> is a compact text format for triples and a subset of Notation3 (N3). Names such as <code>_:lucy</code> are blank-node labels that only mean something inside this file; <code>a</code> is shorthand for "is of type"; and a semicolon lets several predicate-object pairs share one subject. RDF can also be written as RDF/XML, which says the same thing far more verbosely.</p>
<h3>The semantic web, and why triples outlived it</h3>
<p>Triples are the data model of <strong>RDF</strong> (the Resource Description Framework), designed for the <em>semantic web</em>: the early-2000s idea that websites would publish machine-readable data alongside their pages, so data from many sites could combine into one "web of data". That vision was overhyped and never arrived at the scale imagined, but triples work fine as an application's internal data model regardless.</p>
<p>RDF's answer to the merge problem is its naming. Predicates (and often subjects) are <strong>URIs</strong>, such as <code>&lt;http://my-company.example/ns#within&gt;</code>, so your <code>within</code> can't collide with somebody else's when datasets are combined. The URI needn't resolve to anything; it's just a globally unique name under a domain you control, shortened with a <code>PREFIX</code> declaration.</p>
<h3>SPARQL</h3>
<p><strong>SPARQL</strong> (pronounced "sparkle") is the query language for RDF triple-stores. It predates Cypher, and Cypher borrowed its pattern matching from SPARQL, which is why the two look alike. Here is the emigrants question once more:</p>`,
        },
        {
          type: "code",
          title: "The emigrants query in SPARQL",
          lang: "SPARQL",
          code: `PREFIX : <http://my-company.example/ns#>

SELECT ?personName WHERE {
  ?person :name ?personName .
  ?person :bornIn  / :within* ?us .
  ?us     :name "United States" .
  ?person :livesIn / :within* ?eu .
  ?eu     :name "Europe" .
}`,
          caption: "<code>:bornIn / :within*</code> is a <em>property path</em>: one <code>bornIn</code> edge followed by zero or more <code>within</code> edges, the same idea as Cypher's <code>*0..</code>. There's no separate syntax for properties: <code>?us :name \"United States\"</code> matches a property exactly the way <code>:within</code> matches an edge, because in RDF both are just predicates.",
        },
        {
          type: "text",
          html: `<p>A graph of records joined by links may sound like the CODASYL network model from <a href="#/ch2/learn/repeating-history">Document databases are repeating history</a>. It isn't, and the differences are precisely the lessons CODASYL taught:</p>`,
        },
        {
          type: "compare",
          title: "Graph databases are not CODASYL again",
          items: [
            {
              title: "CODASYL network model (1970s)",
              tone: "bad",
              html: `<ul>
<li>The schema dictated which record type could be nested within which.</li>
<li>The only way to reach a record was to navigate an access path to it.</li>
<li>Children formed an ordered set that the database maintained, so applications had to care about position when inserting.</li>
<li>Queries were imperative and broke when the schema changed.</li>
</ul>`,
            },
            {
              title: "Graph databases",
              tone: "ok",
              html: `<ul>
<li>Any vertex can have an edge to any other vertex.</li>
<li>Any vertex can be fetched directly by its unique ID or found through an index.</li>
<li>Vertices and edges are unordered; you sort the results when you query.</li>
<li>Declarative languages (Cypher, SPARQL) are available alongside imperative traversal APIs.</li>
</ul>`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Datalog: queries as rules</h3>
<p><strong>Datalog</strong> predates both SPARQL and Cypher by decades: it was a major database research topic in the 1980s, and it is a subset of Prolog, the logic-programming language. Most engineers never write it, yet later query languages build on its ideas, and it has practical users: Datomic uses Datalog as its query language, and Cascalog brought a Datalog-style language to Hadoop.</p>
<p>Datalog's data model is the triple again, written <code>predicate(subject, object)</code>. The difference lies in how you query. Instead of writing one big pattern, you define <strong>rules</strong> that derive new facts from existing ones. Read <code>:-</code> as "if" and commas as "and"; capitalized words are variables and lowercase words are constants.</p>`,
        },
        {
          type: "code",
          title: "Facts, rules and a query in Datalog",
          lang: "Datalog",
          code: `% Facts: predicate(subject, object)
name(namerica, 'North America').
name(usa, 'United States').       within(usa, namerica).
name(idaho, 'Idaho').             within(idaho, usa).
name(europe, 'Europe').
name(uk, 'United Kingdom').       within(uk, europe).
name(london, 'London').           within(london, uk).
% (Simplified: London sits directly within the UK, as in the scenario below.)
name(lucy, 'Lucy').
born_in(lucy, idaho).
lives_in(lucy, london).

% Rule 1: every location is within its own name
within_recursive(Loc, Name) :- name(Loc, Name).

% Rule 2: if Loc is directly within Via, and Via is within Name,
%         then Loc is within Name too
within_recursive(Loc, Name) :- within(Loc, Via),
                               within_recursive(Via, Name).

% Rule 3: someone named Name was born in BornIn and lives in LivingIn
migrated(Name, BornIn, LivingIn) :-
    name(Person, Name),
    born_in(Person, BornLoc),    within_recursive(BornLoc, BornIn),
    lives_in(Person, LivingLoc), within_recursive(LivingLoc, LivingIn).

% The query
?- migrated(Who, 'United States', 'Europe').
% Who = 'Lucy'.`,
        },
        {
          type: "text",
          html: `<p>Rules 1 and 2 define, once and under a name, the "somewhere inside" relationship that the Cypher and SQL versions each had to restate; Rule 3 then uses it twice, the way code calls a function. (As written, Rule 1 also fires for people, deriving facts such as <code>within_recursive(lucy, 'Lucy')</code>. That's harmless, because Rule 3 only asks about birthplaces and residences.)</p>
<h3>Evaluation: rounds until nothing changes</h3>
<p>Evaluation runs bottom-up. A rule fires whenever facts matching its right-hand side exist, and the facts it derives can make rules fire again, including the rule that produced them. Each round pushes knowledge one level further up the hierarchy. When a round derives nothing new, evaluation has reached a <strong>fixpoint</strong> and stops. No depth limit is needed: pure Datalog has no function symbols, so it can't invent new values, and the set of derivable facts is finite. Predicates are evaluated in dependency order, so <code>within_recursive</code> reaches its fixpoint before <code>migrated</code>, which depends on it, is computed. The scenario below plays this one round at a time, for two people, Lucy and Sam.</p>`,
        },
        {
          type: "viz",
          id: "ch2/datalog-fixpoint",
          title: "Datalog rules reach a fixpoint",
          caption: "Try pressing Play and watching the staircase: round 1 gives each place its own name, every later round climbs one level, and round 5 derives nothing. Then turn on <em>Add a level: Ada County</em> and play again. Notice that it simply takes one more round; nothing in the rules mentions depth.",
        },
        {
          type: "text",
          html: `<h3>Smarter evaluation, and the bridge back to SQL</h3>
<p>The staircase you watched is <strong>semi-naive evaluation</strong>: each round applies the recursive rule only to facts that were new in the previous round, rather than re-deriving everything. Even so, pure bottom-up evaluation derives far more than the query needs (Lucy migrated from Idaho to London, from North America to the United Kingdom, and every other combination), so real engines use rewrites such as <strong>magic sets</strong> to push the query's constants into the rules and derive only facts that could contribute to the answer.</p>
<p>The same machinery explains the recursive CTE from the previous section. PostgreSQL documents <code>WITH RECURSIVE</code> as a loop over a <em>working table</em> holding only the previous iteration's rows: each step joins those rows (not the whole result so far) against the edges, and the loop stops when a step produces nothing. That is semi-naive fixpoint evaluation, in SQL.</p>
<p>The trade-off: for a quick one-off question, a single Cypher or SPARQL pattern is handier. Datalog pays off as the logic grows, because rules compose like functions: once <code>within_recursive</code> exists, every later query can build on it.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Wikidata",
              title: "A public SPARQL endpoint",
              tag: "RDF + SPARQL",
              html: "Wikidata exposes its whole knowledge graph as RDF and runs a public SPARQL endpoint, the Wikidata Query Service, where queries routinely use property paths such as \"subclass of*\" for variable-depth traversal.",
            },
            {
              org: "schema.org and JSON-LD",
              title: "Triples embedded in web pages",
              year: "2011",
              tag: "Search engines",
              html: "Google, Microsoft (Bing) and Yahoo launched schema.org in 2011, and Yandex joined later that year. Sites embed its vocabulary, often as JSON-LD (a W3C Recommendation since 2014), so search engines can read structured facts about products, events and recipes.",
            },
            {
              org: "Datomic",
              title: "Datalog in production",
              year: "2012",
              tag: "Datalog",
              html: "Datomic, created by Rich Hickey's team, uses Datalog as its query language over a database of immutable facts. Its maker, Cognitect, was acquired by Nubank in 2020.",
            },
            {
              org: "GitHub CodeQL",
              title: "Code as a database of facts",
              year: "2019",
              tag: "Code analysis",
              html: "After acquiring Semmle, GitHub offers CodeQL, which treats source code as a database of facts and queries it with QL, a logic language descended from Datalog, to find vulnerability patterns.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Both ideas outlived their hype in narrower forms. Datalog found a second home in program analysis: besides CodeQL, <strong>Soufflé</strong> is a Datalog engine built for static analysis, because "which values can flow to this call?" is a recursive question over facts extracted from code. The semantic web never became one web of data, but schema.org markup and Wikidata made triples routine. RDF is still evolving, too: the W3C is standardizing statements about statements (RDF-star) as part of RDF 1.2.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Triple-stores and Datalog",
          prosLabel: "Triples and Datalog shine when",
          consLabel: "What they cost",
          pros: [
            "Data from many independent sources must be merged: URIs keep names from colliding.",
            "Properties and relationships keep changing: every fact has the same shape, so there is no schema to migrate.",
            "Recursive logic is defined once as a named rule and reused across queries.",
          ],
          cons: [
            "Everything is a triple, so a record with 20 attributes is 20 facts: verbose to store and to query.",
            "Simple one-off lookups are clumsier than a single pattern match or <code>SELECT</code>.",
            "A smaller ecosystem and talent pool than SQL, and RDF's family of standards has a reputation for complexity.",
            "Naive bottom-up evaluation derives far more than needed; performance depends on the engine's optimizations.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Triple-stores and Datalog are rarely the expected answer, but they show depth when the prompt is "build a knowledge graph" or "merge entity data from several sources". Mention that RDF names things with URIs so independent datasets merge without clashes, that SPARQL property paths (<code>:within*</code>) handle variable depth, and that property graphs and RDF are two encodings of one idea, differing mainly in how conveniently edges carry properties and how names are scoped. If recursion comes up, explain fixpoint evaluation (apply rules until a round adds nothing), which is also how <code>WITH RECURSIVE</code> runs.</p>`,
        },
        {
          type: "quiz",
          q: "In the Datalog rules, within_recursive refers to itself. Why does evaluation terminate?",
          options: [
            "The engine imposes a maximum recursion depth.",
            "Rules are applied round after round only while they derive new facts; the hierarchy is finite, so eventually a round adds nothing (a fixpoint) and evaluation stops.",
            "Each rule is evaluated exactly once.",
            "The query engine times out after a fixed number of seconds.",
          ],
          answer: 1,
          explain: "Datalog evaluation stops when a round derives no new facts. Because pure Datalog has no function symbols that create new values, the set of possible facts is finite, so a fixpoint always exists. A is the tempting answer, but a depth limit would reintroduce the fixed-join bug from the previous section: anything deeper than the limit would silently go missing. C can't be right either, since the staircase needs one round per level.",
        },
      ],
    },
  ],
  takeaways: [
    "Choose the data model by the <strong>shape of your relationships</strong>: trees of one-to-many data fit documents, many-to-one and many-to-many fit relational joins, and variable-depth, anything-to-anything connections fit graphs.",
    "Document <strong>locality</strong> is a win only when you read and write whole trees; shared, changeable facts (employers, regions) belong in one place behind an ID, which pulls you back toward joins.",
    "<strong>Schemaless means schema-on-read</strong>: the schema moves from the database into every reader. Schema changes get cheap, but bad and old shapes surface late and far away.",
    "<strong>Declarative queries</strong> let the database change how without you changing what: new indexes, more cores and reorganized storage help SQL automatically, while imperative code is frozen and can silently break.",
    "MapReduce is a good <strong>runtime</strong> and an awkward <strong>interface</strong>; map and reduce must be pure so retries are safe, and the systems that offered it grew declarative languages on top.",
    "Graph languages (Cypher's <code>*0..</code>, SPARQL property paths, Datalog recursive rules) handle <strong>unknown-depth traversal</strong> natively; SQL can with <code>WITH RECURSIVE</code>, but a fixed number of joins silently misses deeper paths.",
    "History rhymes: document databases repeat IMS's nesting, and graph databases avoid CODASYL's mistakes. The lasting lesson is that the <strong>system, not the programmer, should choose access paths</strong>.",
    "The models are <strong>converging</strong> (JSON in PostgreSQL, joins and transactions in MongoDB, graph queries in SQL:2023), so ask how you'll query the data, not which camp you belong to.",
  ],
  connections: [
    { to: "ch1", html: "Evolvability and simplicity: schema-on-read vs schema-on-write and declarative queries are maintainability tools, and the data model is the main abstraction for managing complexity." },
    { to: "ch3", html: "How each model is laid out on disk: B-trees and LSM-trees, secondary and clustered indexes, indexes on JSON fields, and column-oriented storage for analytics (a different kind of locality)." },
    { to: "ch4", html: "Schema evolution one layer down: JSON vs binary encodings, backward and forward compatibility, and Avro's writer's and reader's schemas, which mirror schema-on-write vs schema-on-read." },
    { to: "ch6", html: "Partitioning documents by key keeps a tree on one node, but denormalized copies and secondary indexes span partitions." },
    { to: "ch7", html: "Denormalized copies need atomic multi-record updates: multi-document transactions, ACID and isolation levels are covered there." },
    { to: "ch10", html: "MapReduce as a distributed batch engine (shuffle, joins, fault tolerance) and large-scale graph processing (Pregel, PageRank), where graphs prove hard to partition: hash placement sends most messages across the network." },
    { to: "ch11", html: "Keeping polyglot stores in sync with change data capture and event logs instead of dual writes." },
    { to: "ch12", html: "Denormalized views as derived data, and the \"unbundled database\" that composes specialized stores: the logical conclusion of polyglot persistence." },
  ],
  furtherReading: [
    {
      title: "E. F. Codd, \"A Relational Model of Data for Large Shared Data Banks\" (CACM, 1970)",
      url: "https://dl.acm.org/doi/10.1145/362384.362685",
      note: "The paper that started it all; its opening argument for data independence is exactly this chapter's access-path lesson.",
    },
    {
      title: "Charles Bachman, \"The Programmer as Navigator\" (1973 Turing Award lecture)",
      url: "https://dl.acm.org/doi/10.1145/355611.362534",
      note: "The navigational worldview in its own words, worth reading next to Codd.",
    },
    {
      title: "Stonebraker and Hellerstein, \"What Goes Around Comes Around\" (2005)",
      note: "A review of some 35 years of data-model proposals, arguing that most of them recycled old ideas: this chapter's history section in long form.",
    },
    {
      title: "Stonebraker and Pavlo, \"What Goes Around Comes Around... And Around...\" (SIGMOD Record, 2024)",
      url: "https://dl.acm.org/doi/10.1145/3685980.3685984",
      note: "The sequel, covering MapReduce, key-value, document, graph and vector systems, and why SQL and the relational model kept absorbing them.",
    },
    {
      title: "Selinger et al., \"Access Path Selection in a Relational Database Management System\" (SIGMOD 1979)",
      url: "https://dl.acm.org/doi/10.1145/582095.582099",
      note: "The System R optimizer paper: how \"say what, not how\" became practical.",
    },
    {
      title: "Bronson et al., \"TAO: Facebook's Distributed Data Store for the Social Graph\" (USENIX ATC 2013)",
      url: "https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson",
      note: "A heterogeneous graph of objects and associations served at about a billion reads per second.",
    },
    {
      title: "PostgreSQL documentation: JSON types",
      url: "https://www.postgresql.org/docs/current/datatype-json.html",
      note: "json vs jsonb, containment, and indexing documents inside a relational database.",
    },
    {
      title: "PostgreSQL documentation: WITH queries (common table expressions)",
      url: "https://www.postgresql.org/docs/current/queries-with.html",
      note: "How WITH RECURSIVE evaluates with a working table, including cycle detection.",
    },
    {
      title: "Neo4j Cypher Manual",
      url: "https://neo4j.com/docs/cypher-manual/current/",
      note: "Pattern syntax, variable-length relationships and query planning.",
    },
    {
      title: "W3C SPARQL 1.1 Query Language",
      url: "https://www.w3.org/TR/sparql11-query/",
      note: "Property paths (:within*) and the full query language for RDF.",
    },
    {
      title: "gh-ost: GitHub's online schema migration for MySQL",
      url: "https://github.com/github/gh-ost",
      note: "The README and its linked design docs explain why GitHub replaced trigger-based migration tools with one that tails the binary log.",
    },
    {
      title: "Wikidata Query Service",
      url: "https://query.wikidata.org/",
      note: "Try SPARQL with property paths on a real, very large knowledge graph.",
    },
    {
      title: "MongoDB manual: data modeling (embedding vs references, schema validation)",
      url: "https://www.mongodb.com/docs/manual/data-modeling/",
      note: "The vendor's own embed-or-reference guidance; its schema-design anti-patterns pages include the warning about unbounded arrays.",
    },
  ],
});
