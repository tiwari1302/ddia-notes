// Chapter 3 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch3", {
  sections: [
    // ------------------------------------------------------------------
    {
      id: "lsm-vs-btree",
      title: "LSM vs B-tree: choose which amplification you pay",
      kicker: "Trade-offs",
      concepts: ["write-amplification", "lsm-tree", "b-tree"],
      blocks: [
        {
          type: "problem",
          html: `<p>With both engine families on the table, the obvious question is which one to use. The folk rule says LSM-trees are for writes and B-trees are for reads. As a first guess it's fine; as a design decision it leads to surprises. One team picks an LSM store for its write rate, then watches p99 read latency jump every time a big compaction runs. Another keeps a B-tree under a stream of small random updates and discovers its SSDs are writing far more bytes than the application ever sent.</p>
<p>Benchmarks won't settle the argument either. Published comparisons regularly contradict each other because they differ in value sizes, key distributions, cache sizes and tuning. What you need to know is <strong>where each design spends</strong> its disk bandwidth, CPU and space, so you can match it to your own workload.</p>`,
        },
        {
          type: "idea",
          html: `<p>Every storage engine balances three costs: bytes written per byte stored (<strong>write amplification</strong>), work per query (<strong>read amplification</strong>) and bytes on disk per byte of live data (<strong>space amplification</strong>). B-trees pay with whole-page rewrites and partly empty pages; LSM-trees pay with compaction rewrites and reads that consult several files. Neither wins everywhere, so measure your workload.</p>`,
        },
        {
          type: "text",
          html: `<h3>Three kinds of amplification</h3>
<ul>
<li><strong>Write amplification</strong>: total bytes the engine writes to disk over a record's lifetime, divided by the bytes the application wrote. Logging, page rewrites and compaction all count.</li>
<li><strong>Read amplification</strong>: disk reads (or bytes read) per query. A cold B-tree lookup reads one page per level; an LSM lookup may check the memtable, several L0 files and one file per deeper level.</li>
<li><strong>Space amplification</strong>: bytes on disk divided by bytes of live data. Half-empty pages, obsolete versions waiting for compaction, and tombstones all inflate it.</li>
</ul>
<h3>Where a B-tree's writes go</h3>
<p>Every change is written at least twice: once to the write-ahead log, and again when the modified page is eventually flushed. The page is the unit of I/O, so changing 100 bytes still writes a whole page: 8 KB in PostgreSQL and SQL Server, 16 KB by default in InnoDB. A split writes both halves and the parent as well. And the torn-page defenses from the previous section add one more copy: InnoDB's doublewrite buffer writes every page twice, and PostgreSQL's full-page images put whole pages into the WAL.</p>
<h3>Where an LSM-tree's writes go</h3>
<p>An LSM-tree writes the record to its log and later flushes it with the rest of the memtable; both are cheap sequential writes. The expensive part comes afterward, because every compaction the record survives rewrites it. With <strong>leveled compaction</strong> the record moves down roughly once per level, and each move can rewrite up to about the size ratio between levels (10 by default in RocksDB) in the worst case, so reported totals of 10–30x are typical. <strong>Size-tiered</strong> compaction rewrites records fewer times and pays instead in temporary disk space and more files per read.</p>
<p>Why care? In a write-heavy system the disk's write bandwidth is often the bottleneck, so every amplified byte is throughput you don't get. And flash cells survive only a limited number of program/erase cycles, so write amplification directly shortens an SSD's life.</p>`,
        },
        {
          type: "diagram",
          title: "Bytes written for one 100-byte update",
          svg: `<svg viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bar chart. A B-tree that writes a whole 16 KB page for one 100-byte change writes about 165 times the data. With about 20 changes batched per page write it writes about 9 times. A leveled LSM-tree with size ratio 10 and three levels writes up to about 32 times.">
<text x="16" y="42" font-size="12" font-weight="700">B-tree, worst case</text>
<text x="16" y="58" font-size="12" style="fill: var(--viz-muted)">1 change per page write</text>
<rect x="200" y="28" width="2.6" height="32" style="fill: var(--viz-c3)"/>
<rect x="202.6" y="28" width="426" height="32" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="212" y="49" font-size="12">a whole 16 KB page for a 100-byte row</text>
<text x="620" y="49" font-size="12" font-weight="700" text-anchor="end">≈ 165x</text>
<text x="16" y="96" font-size="12" font-weight="700">B-tree, well cached</text>
<text x="16" y="112" font-size="12" style="fill: var(--viz-muted)">~20 changes per page write</text>
<rect x="200" y="82" width="2.6" height="32" style="fill: var(--viz-c3)"/>
<rect x="202.6" y="82" width="21.3" height="32" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="234" y="103" font-size="12"><tspan font-weight="700">≈ 9x</tspan>   WAL 1x + page ≈ 8x</text>
<text x="16" y="150" font-size="12" font-weight="700">Leveled LSM-tree</text>
<text x="16" y="166" font-size="12" style="fill: var(--viz-muted)">size ratio 10, 3 levels</text>
<rect x="200" y="136" width="2.6" height="32" style="fill: var(--viz-c3)"/>
<rect x="202.6" y="136" width="2.6" height="32" style="fill: var(--viz-c2)"/>
<rect x="205.2" y="136" width="26" height="32" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<rect x="231.2" y="136" width="26" height="32" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<rect x="257.2" y="136" width="26" height="32" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="218.2" y="157" font-size="12" text-anchor="middle">L1</text>
<text x="244.2" y="157" font-size="12" text-anchor="middle">L2</text>
<text x="270.2" y="157" font-size="12" text-anchor="middle">L3</text>
<text x="294" y="157" font-size="12"><tspan font-weight="700">up to ≈ 32x</tspan>   WAL 1 + flush 1 + ≤ 10 per level</text>
<line x1="200" y1="184" x2="630" y2="184" style="stroke: var(--viz-line)"/>
<line x1="200" y1="184" x2="200" y2="189" style="stroke: var(--viz-line)"/>
<line x1="330" y1="184" x2="330" y2="189" style="stroke: var(--viz-line)"/>
<line x1="460" y1="184" x2="460" y2="189" style="stroke: var(--viz-line)"/>
<line x1="590" y1="184" x2="590" y2="189" style="stroke: var(--viz-line)"/>
<text x="200" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">0</text>
<text x="330" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">50x</text>
<text x="460" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">100x</text>
<text x="590" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">150x</text>
<text x="16" y="224" font-size="12" style="fill: var(--viz-muted)">illustrative numbers</text>
<rect x="200" y="213" width="12" height="12" style="fill: var(--viz-c3)"/>
<text x="218" y="224" font-size="12">WAL</text>
<rect x="262" y="213" width="12" height="12" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="280" y="224" font-size="12">B-tree page writes</text>
<rect x="404" y="213" width="12" height="12" style="fill: var(--viz-c2)"/>
<text x="422" y="224" font-size="12">memtable flush</text>
<rect x="528" y="213" width="12" height="12" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="546" y="224" font-size="12">compaction</text>
</svg>`,
          caption: "Illustrative orders of magnitude, not measurements: real numbers depend heavily on caching, row size and configuration. Batching many changes into each page write shrinks the B-tree's page term, while leveled compaction's cost is roughly bounded by the size ratio per level.",
        },
        {
          type: "text",
          html: `<p>The worst-case B-tree bar is what happens when each flushed page carries a single change: random updates to a table much larger than the buffer pool, so a page is evicted before a second update lands on it. Give the cache room to batch twenty changes per page and the bar collapses to single digits. That sensitivity to cache size is one reason benchmark results swing so widely. The LSM bar barely depends on the access pattern, because compaction rewrites everything sooner or later.</p>
<p>A good way to hold all three costs in your head is the <strong>RUM conjecture</strong> (Athanassoulis et al., 2016): an access method can keep at most two of read overhead, update overhead and memory (space) overhead low, and pays for it with the third.</p>`,
        },
        {
          type: "diagram",
          title: "The RUM triangle",
          svg: `<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Triangle with corners low read cost at the top, low write cost at bottom left and low space cost at bottom right. B-tree sits near the read corner, hash log (Bitcask) on the edge between read and write, far from space because all keys are in RAM. Size-tiered LSM sits near the write corner; leveled LSM sits toward the space corner on the read-space edge.">
<polygon points="320,52 60,270 580,270" style="fill: var(--viz-node); stroke: var(--viz-line); stroke-width: 1.5"/>
<text x="628" y="22" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">closer to a corner = cheaper on that axis</text>
<text x="320" y="38" font-size="13" font-weight="700" text-anchor="middle">Low read cost</text>
<text x="70" y="292" font-size="13" font-weight="700" text-anchor="middle">Low write cost</text>
<text x="570" y="292" font-size="13" font-weight="700" text-anchor="middle">Low space cost</text>
<circle cx="320" cy="112" r="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 2"/>
<text x="320" y="136" font-size="12" font-weight="700" text-anchor="middle">B-tree</text>
<text x="320" y="151" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">one path per lookup</text>
<circle cx="204" cy="166" r="8" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7); stroke-width: 2"/>
<text x="180" y="162" font-size="12" font-weight="700" text-anchor="end">Hash log (Bitcask)</text>
<text x="180" y="178" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">all keys in RAM</text>
<circle cx="150" cy="236" r="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 2"/>
<text x="166" y="233" font-size="12" font-weight="700">Size-tiered LSM</text>
<text x="166" y="249" font-size="12" style="fill: var(--viz-muted)">fewest rewrites</text>
<circle cx="460" cy="200" r="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 2"/>
<text x="444" y="197" font-size="12" font-weight="700" text-anchor="end">Leveled LSM</text>
<text x="444" y="213" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">least space, good reads</text>
</svg>`,
          caption: "Optimize two corners, pay in the third (the RUM conjecture, 2016). Positions are qualitative: tuning moves every engine around the triangle. Bitcask is cheap to read and write because it keeps every key in memory; size-tiered compaction minimizes rewrites at the cost of space and read work; leveled compaction spends rewrites to keep space and reads low.",
        },
        {
          type: "text",
          html: `<h3>Where LSM-trees tend to win</h3>
<p><strong>Sustained write throughput.</strong> An LSM-tree writes large, compact files sequentially instead of overwriting scattered pages. Its write amplification is sometimes lower, as the bars show, but the access pattern helps even when it isn't: on spinning disks, sequential writes are dramatically faster than random ones.</p>
<p><strong>Smaller files on disk.</strong> Compaction rewrites SSTables end to end, so they pack data tightly and compress well, block by block. A B-tree leaves free space behind: pages are partly empty after splits, and a compressed page still occupies a fixed-size slot on disk.</p>
<p><strong>Even on SSDs.</strong> An SSD's firmware is itself log-structured (it remaps writes and garbage-collects internally), which softens the penalty for random writes. Compactness still pays: fewer bytes per record means more reads and writes fit in the same I/O bandwidth.</p>
<h3>Where B-trees tend to win</h3>
<p><strong>Reads touch one structure.</strong> A B-tree finds a key by walking one root-to-leaf path. An LSM-tree may consult the memtable, several L0 files and a file per deeper level; Bloom filters skip most of them for point reads, but a range scan must merge an iterator from every overlapping sorted run.</p>
<p><strong>Predictable latency.</strong> A B-tree pays its costs inline, each write doing its own page work. An LSM-tree defers work to background compaction, which competes with foreground reads and writes for the same disk bandwidth. The median barely notices; the high percentiles do.</p>
<p><strong>No compaction debt.</strong> In an LSM-tree the log, memtable flushes and compaction threads share the disk's write bandwidth, and the bigger the database, the more compaction work each new byte creates. When compaction falls behind, files pile up, reads slow down and, in RocksDB, writes eventually stall (the write-stall callout in the compaction section). A B-tree has no such backlog to watch.</p>
<p><strong>One place per key.</strong> Each key lives in exactly one leaf, so a transactional database can attach range locks directly to the index (the index-range locks of Chapter 7). In an LSM-tree, versions of one key may sit in several files at once.</p>
<p>B-trees are deeply entrenched and aren't going anywhere, while log-structured engines are increasingly common in new datastores. The honest rule is the boring one: test with your own data, value sizes and access pattern.</p>`,
        },
        {
          type: "table",
          title: "B-tree vs LSM-tree at a glance",
          headers: ["", "B-tree", "LSM-tree"],
          rows: [
            [`<span style="overflow-wrap:normal;word-break:normal">Write pattern</span>`, "Overwrite fixed-size pages in place, plus the WAL", "Append to the log; flush and merge sorted files sequentially"],
            [`<span style="overflow-wrap:normal;word-break:normal">Write amplification</span>`, "WAL plus a whole page per flushed change, more on splits; worst for small scattered updates", "WAL plus flush plus every compaction (leveled: up to about the size ratio per level; tiered: less)"],
            [`<span style="overflow-wrap:normal;word-break:normal">Point read</span>`, "One root-to-leaf path (3–4 pages, upper levels usually cached)", "Memtable, then sorted runs newest first; Bloom filters skip most files"],
            [`<span style="overflow-wrap:normal;word-break:normal">Range scan</span>`, "Walk adjacent leaves", "Merge an iterator per overlapping sorted run"],
            [`<span style="overflow-wrap:normal;word-break:normal">Space amplification</span>`, "Partly empty pages after splits; fixed-size slots limit compression", "Leveled about 1.1x in steady state; size-tiered can need about 2x during big merges"],
            [`<span style="overflow-wrap:normal;word-break:normal">Latency</span>`, "Costs paid inline on each write; steady tail", "Background compaction competes for bandwidth; watch p99"],
            [`<span style="overflow-wrap:normal;word-break:normal">Background debt</span>`, "No merge backlog (though PostgreSQL's VACUUM is background work of its own)", "Compaction can fall behind; RocksDB then slows or stops writes"],
            [`<span style="overflow-wrap:normal;word-break:normal">Locks and snapshots</span>`, "One place per key makes index-range locks easy", "Versions spread across files; snapshots via sequence numbers"],
            [`<span style="overflow-wrap:normal;word-break:normal">Examples</span>`, "PostgreSQL, InnoDB, SQL Server, Oracle, SQLite, MongoDB (WiredTiger), LMDB", "RocksDB, LevelDB, Cassandra, ScyllaDB, HBase, CockroachDB (Pebble), MyRocks"],
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>In the last decade the LSM camp has attacked its biggest cost head-on. <strong>Key-value separation</strong>, from the WiscKey paper (FAST 2016), keeps large values in a separate log and stores only keys and pointers in the LSM-tree, so compaction moves far fewer bytes. And LSM engines have taken over some high-profile deployments, replacing a B-tree engine at Facebook and an older LSM engine at Cockroach Labs. The cards below give the details.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Facebook MyRocks",
              tag: "space",
              html: "Facebook built MyRocks, MySQL with RocksDB as its storage engine, and migrated its main user database (UDB) to it from compressed InnoDB. Facebook engineers reported it used roughly half the space, with lower write amplification, which matters for flash endurance.",
            },
            {
              org: "CockroachDB",
              year: "2020",
              tag: "engine swap",
              html: "Cockroach Labs announced <strong>Pebble</strong>, a RocksDB-inspired LSM key-value store written in Go, and replaced RocksDB with it as CockroachDB's storage engine.",
            },
            {
              org: "WiscKey, Badger, Titan",
              year: "2016",
              tag: "key-value separation",
              html: "The WiscKey paper (FAST 2016) separates keys from values to cut LSM write amplification on SSDs. Dgraph's Badger is based on WiscKey, TiKV's Titan plugin applies the same idea to RocksDB, and RocksDB itself ships it as BlobDB (integrated blob files).",
            },
            {
              org: "MongoDB WiredTiger",
              tag: "B-tree",
              html: "MongoDB's default storage engine since 3.2 (2015) stores collections and indexes as B-trees. By default it compresses collection data with snappy block compression and index keys with prefix compression: a reminder that B-trees can compress too.",
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p><strong>What they probe:</strong> "We ingest 200,000 events per second and read them back by key. LSM-tree or B-tree?" A weak answer recites "LSM for writes". A strong answer first asks about the workload (read/write ratio, value sizes, key distribution, range scans, latency targets), then reasons in amplifications: an LSM-tree turns small random writes into large sequential ones and compresses well, but compaction has to keep pace with ingestion and can hurt p99; a B-tree gives steady reads but pays a page write per scattered update.</p>
<p>Then say how you'd check: benchmark with production-like data, and run it long enough for compaction to reach steady state. A short LSM benchmark looks wonderful because compaction hasn't started yet. Watch tail latency, pending compaction bytes and disk bytes written, not just throughput.</p>`,
        },
        {
          type: "quiz",
          q: "A workload updates random 100-byte rows at a high rate on SSDs, and reads are rare. Why might an LSM-tree beat a B-tree here, even though compaction rewrites data many times?",
          options: [
            "LSM-trees never rewrite data after the first write",
            "B-trees can't run on SSDs because SSDs don't support in-place overwrites",
            "A B-tree may rewrite a whole 4–16 KB page (plus the WAL) for each scattered 100-byte change, which can exceed the LSM-tree's compaction rewrites, and the LSM-tree's writes are sequential and compressed",
            "LSM-trees skip the write-ahead log, which halves their writes",
          ],
          answer: 2,
          explain: "Compare total bytes written per logical byte. A random update can force a full-page write in a B-tree, while an LSM-tree batches many small updates into large sequential files and rewrites each byte a bounded number of times. A contradicts the premise of the question: compaction is exactly a rewrite. B confuses the SSD's internals (its firmware remaps writes) with what the database sees; B-trees run on SSDs everywhere. D is false: LSM engines log every write so the memtable survives a crash.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "other-indexes",
      title: "Secondary indexes, many dimensions, and keeping it all in memory",
      kicker: "Beyond the primary key",
      concepts: ["clustered-vs-secondary-index", "heap-file", "covering-index", "multi-dimensional-index", "full-text-fuzzy-index", "in-memory-database"],
      blocks: [
        {
          type: "problem",
          html: `<p>Login looks users up by email, not by id. Without an index on <code>email</code>, every login scans all 50 million rows. Add one, and you must decide what its entries point to: the row's physical location (one hop, but every index needs fixing whenever the row moves) or its primary key (stable, but every lookup descends two trees).</p>
<p>Then product asks for "restaurants within 2 km". That's two range conditions at once, and a sorted index on latitude can narrow only one of them, returning a thin stripe that circles the planet. The search box receives "recieve" and must still find "receive", which no exact-match index can do. And the whole dataset might fit in a 256 GB server's RAM: is the disk-oriented machinery still worth its overhead?</p>`,
        },
        {
          type: "idea",
          html: `<p>A secondary index is just another key-to-reference structure. The design questions are where the row itself lives (a heap file, a clustered index, or partly copied into a covering index), how to index several dimensions or fuzzy matches, and whether to keep everything in RAM. Each answer trades read hops against write cost and memory.</p>`,
        },
        {
          type: "text",
          html: `<h3>Secondary indexes</h3>
<p>A <strong>secondary index</strong> (<code>CREATE INDEX</code>) maps a column other than the primary key to the rows that have it, which is what makes filters and joins fast. Its keys usually aren't unique (many orders share one customer). Engines cope in one of two ways: store all matching row ids under one entry, as a full-text postings list does, or tack the row id onto the key so every entry is distinct. Either a B-tree or an LSM-tree can hold the result.</p>
<p>So do hash indexes: PostgreSQL's have been WAL-logged and crash-safe since version 10 (2017), and MySQL's MEMORY engine uses them by default. B-trees remain the default because one structure serves equality, ranges, prefixes and <code>ORDER BY</code>.</p>
<h3>Where does the row live?</h3>
<p>An index entry can hold the row itself or a reference to it. That choice decides how many hops a read takes and how many structures each write touches.</p>`,
        },
        {
          type: "diagram",
          title: "Heap file vs clustered index",
          svg: `<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: in PostgreSQL, an index on id and an index on email both point to the same heap location, page 7 slot 3. Right: in InnoDB, the index on email stores primary key 42, and a second descent through the primary-key B-tree finds the full row stored in its leaf.">
<defs><marker id="ch3d2-hc-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="16" y="22" font-size="13" font-weight="700">PostgreSQL: heap file</text>
<rect x="16" y="44" width="132" height="46" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="82" y="63" font-size="12" font-weight="700" text-anchor="middle">index on id</text>
<text x="82" y="81" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">42 → (7, 3)</text>
<rect x="16" y="124" width="132" height="46" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="82" y="143" font-size="12" font-weight="700" text-anchor="middle">index on email</text>
<text x="82" y="161" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">alice@… → (7, 3)</text>
<rect x="192" y="40" width="116" height="176" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="250" y="58" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">heap, page 7</text>
<rect x="200" y="68" width="100" height="24" rx="3" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="250" y="85" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">17 | bob | …</text>
<rect x="200" y="96" width="100" height="24" rx="3" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="250" y="113" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">93 | eve | …</text>
<rect x="200" y="124" width="100" height="24" rx="3" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="250" y="141" font-size="12" font-weight="700" text-anchor="middle">42 | alice | …</text>
<rect x="200" y="152" width="100" height="24" rx="3" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="250" y="169" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">8 | kim | …</text>
<rect x="200" y="180" width="100" height="24" rx="3" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="250" y="197" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">61 | raj | …</text>
<line x1="148" y1="67" x2="198" y2="132" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-hc-arr)"/>
<line x1="148" y1="147" x2="198" y2="139" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-hc-arr)"/>
<text x="16" y="232" font-size="12" style="fill: var(--viz-muted)">any index: 1 descent + 1 heap fetch</text>
<line x1="320" y1="8" x2="320" y2="236" style="stroke: var(--viz-line); stroke-dasharray: 4 4"/>
<text x="336" y="22" font-size="13" font-weight="700">InnoDB: clustered index</text>
<rect x="336" y="44" width="150" height="46" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="411" y="63" font-size="12" font-weight="700" text-anchor="middle">index on email</text>
<text x="411" y="81" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">alice@… → PK 42</text>
<text x="628" y="63" font-size="12" text-anchor="end" style="fill: var(--viz-muted); font-family: var(--font-mono)">WHERE id = 42</text>
<line x1="590" y1="72" x2="590" y2="120" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-hc-arr)"/>
<line x1="411" y1="90" x2="411" y2="120" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-hc-arr)"/>
<text x="420" y="110" font-size="12" style="fill: var(--viz-muted)">2nd descent</text>
<rect x="336" y="122" width="292" height="94" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="482" y="141" font-size="12" font-weight="700" text-anchor="middle">primary-key B-tree = the table</text>
<rect x="348" y="150" width="268" height="26" rx="3" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="482" y="168" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">41 | dan | dan@… | …</text>
<rect x="348" y="182" width="268" height="26" rx="3" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="482" y="200" font-size="12" font-weight="700" text-anchor="middle">42 | alice | alice@… | …</text>
<text x="336" y="232" font-size="12" style="fill: var(--viz-muted)">by PK: 1 descent · by email: 2 descents</text>
</svg>`,
          caption: "Heap: every index is one hop from the row, but a row that moves needs every index fixed. Clustered: primary-key lookups land directly on the row, and secondary lookups descend twice, but secondary entries stay valid when the row moves.",
        },
        {
          type: "text",
          html: `<p><strong>Heap file.</strong> Rows live in a separate file in no particular order, and every index stores a location in it, so nothing is duplicated however many indexes there are. An update that fits can overwrite the row in place; a row that grows must move, and then every index must be updated or a forwarding pointer left at the old spot.</p>
<p>PostgreSQL is the big exception to "in place": its MVCC writes a new row version for every <code>UPDATE</code>, normally at a new location, so every index needs a new entry. The escape hatch is a <strong>HOT</strong> (heap-only tuple) update, possible when no indexed column changed and the new version fits on the same page.</p>
<p><strong>Clustered index.</strong> The row lives inside the index. InnoDB clusters each table on its primary key (or the first <code>UNIQUE NOT NULL</code> index, or a hidden 6-byte row id), and its secondary indexes store the primary key, so a lookup by email descends two trees. SQL Server lets you choose one clustered index per table.</p>
<p><strong>Covering index.</strong> A middle ground: the index also stores a few extra columns (<strong>included columns</strong>), so some queries never touch the table. SQL Server has had them since 2005; PostgreSQL gained index-only scans in 9.2 (2012) and <code>CREATE INDEX … INCLUDE</code> in 11 (2018).</p>
<p>Both clustered and covering indexes buy read speed with duplication: more disk space, more structures to update per write, and copies the database must keep transactionally consistent.</p>`,
        },
        {
          type: "compare",
          title: "Three places for the row",
          items: [
            {
              title: "Heap file (PostgreSQL)",
              tone: "info",
              html: "Every index points at a (page, slot). <strong>Reads:</strong> one descent plus one heap fetch, from any index. <strong>Writes:</strong> a new row version usually needs a new entry in every index, unless the update is HOT.",
            },
            {
              title: "Clustered (InnoDB)",
              tone: "ok",
              html: "The table is the primary-key B-tree. <strong>Reads:</strong> by primary key, one descent with the row included; by secondary key, two descents. <strong>Writes:</strong> a secondary index changes only when its own column or the primary key changes; random primary keys cause page splits.",
            },
            {
              title: "Covering index",
              tone: "warn",
              html: "The index carries extra columns. <strong>Reads:</strong> matching queries never touch the table. <strong>Writes:</strong> bigger index entries, and one more structure to update whenever those columns change.",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Several columns at once</h3>
<p>A <strong>concatenated index</strong> combines several columns into one key, like a phone book sorted by (last name, first name). It serves the last name, or both, but usually not the first name alone, because the Alices are scattered across every surname. Some engines soften this with <strong>skip scan</strong> (Oracle, MySQL 8.0.13+, PostgreSQL 18+) when the leading column has few distinct values.</p>
<p>Geography breaks the phone book. "Latitude between 51.49 and 51.52 and longitude between −0.14 and −0.10" needs two ranges at once, and an index on (latitude, longitude) narrows only the latitude, returning a stripe around the globe to filter. Two common fixes:</p>
<ul>
<li><strong>Space-filling curves</strong> map each point to one number that mostly preserves nearness (Z-order or geohash codes, or the Hilbert curve in Google's S2), indexed by an ordinary B-tree.</li>
<li><strong>Spatial indexes</strong> such as the <strong>R-tree</strong> group nearby points into nested bounding rectangles; PostGIS builds them on PostgreSQL's GiST framework.</li>
</ul>
<p>Any multi-column range has the same need: colors by (red, green, blue), or weather readings by (date, temperature).</p>`,
        },
        {
          type: "diagram",
          title: "A Z-order curve turns 2-D cells into 1-D keys",
          svg: `<svg viewBox="0 0 400 260" xmlns="http://www.w3.org/2000/svg" style="max-width: 460px; margin: 0 auto" role="img" aria-label="A 4 by 4 grid numbered 0 to 15 along a Z-shaped path. An aligned 2 by 2 box covers codes 12 to 15, one contiguous range. A shifted 2 by 2 box covers codes 3, 6, 9 and 12, which are four separate ranges.">
<text x="24" y="30" font-size="12" style="fill: var(--viz-muted)">x →</text>
<text x="12" y="132" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">y</text>
<text x="12" y="148" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">↓</text>
<rect x="112" y="128" width="88" height="88" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok); stroke-width: 2"/>
<rect x="68" y="84" width="88" height="88" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn); stroke-width: 2; stroke-dasharray: 5 3"/>
<path d="M24,40 H200 M24,84 H200 M24,128 H200 M24,172 H200 M24,216 H200 M24,40 V216 M68,40 V216 M112,40 V216 M156,40 V216 M200,40 V216" style="fill: none; stroke: var(--viz-line)"/>
<polyline points="46,62 90,62 46,106 90,106 134,62 178,62 134,106 178,106 46,150 90,150 46,194 90,194 134,150 178,150 134,194 178,194" style="fill: none; stroke: var(--viz-c1); stroke-width: 1.5"/>
<g font-size="12" font-weight="700">
<text class="viz-halo" x="29" y="55">0</text><text class="viz-halo" x="73" y="55">1</text><text class="viz-halo" x="117" y="55">4</text><text class="viz-halo" x="161" y="55">5</text>
<text class="viz-halo" x="29" y="99">2</text><text class="viz-halo" x="73" y="99">3</text><text class="viz-halo" x="117" y="99">6</text><text class="viz-halo" x="161" y="99">7</text>
<text class="viz-halo" x="29" y="143">8</text><text class="viz-halo" x="73" y="143">9</text><text class="viz-halo" x="117" y="143">12</text><text class="viz-halo" x="161" y="143">13</text>
<text class="viz-halo" x="29" y="187">10</text><text class="viz-halo" x="73" y="187">11</text><text class="viz-halo" x="117" y="187">14</text><text class="viz-halo" x="161" y="187">15</text>
</g>
<text x="216" y="56" font-size="12">Code = bits of y and x</text>
<text x="216" y="72" font-size="12" style="fill: var(--viz-muted)">interleaved (Morton code)</text>
<rect x="216" y="94" width="12" height="12" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="234" y="105" font-size="12" font-weight="700">Aligned box</text>
<text x="216" y="124" font-size="12">codes 12–15:</text>
<text x="216" y="140" font-size="12">one contiguous range</text>
<rect x="216" y="160" width="12" height="12" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="234" y="171" font-size="12" font-weight="700">Shifted box</text>
<text x="216" y="190" font-size="12">codes 3, 6, 9, 12: four</text>
<text x="216" y="206" font-size="12">ranges, or scan 3–12 and</text>
<text x="216" y="222" font-size="12">filter out 6 extra cells</text>
<text x="24" y="246" font-size="12" style="fill: var(--viz-muted)">cells 7 and 13 touch, but their codes are 6 apart</text>
</svg>`,
          caption: "A space-filling curve keeps most nearby cells close in the 1-D key, so an ordinary B-tree can serve area queries, at the price of extra ranges or filtering where a query crosses a cell boundary.",
        },
        {
          type: "text",
          html: `<p>The aligned box is the lucky case: four consecutive codes, one range scan. The shifted box, the same size, straddles the curve's jumps and becomes four ranges, or one wide range with six cells filtered out. Neighbors can get distant codes too: on a real grid with millions of cells, two cells on either side of a major boundary can be far apart in key space. That's why geohash searches also query the neighboring cells, then filter by exact distance.</p>
<h3>Fuzzy matching: full-text search</h3>
<p>Exact-match indexes can't match "recieve" to "receive". Full-text engines handle synonyms, grammatical variants, words near each other, and typos, on top of an <strong>inverted index</strong> that maps each term to a postings list of the documents containing it.</p>
<p>Lucene, the library inside Elasticsearch and Solr, keeps its term dictionary in sorted, immutable segment files, much like SSTables, with an in-memory <strong>finite-state transducer</strong> over the terms' characters, similar to a trie. Intersecting it with a <strong>Levenshtein automaton</strong>, which accepts every string within a given edit distance of the query, finds all terms within two typos of "recieve" by walking the dictionary instead of comparing against every term.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The newest kind of fuzzy index searches by meaning. Text, images and products become embedding vectors, and "similar" means "nearby in a space of hundreds of dimensions". Exact nearest-neighbor search there is too slow, so <strong>approximate nearest-neighbor</strong> indexes trade a little recall for a lot of speed: HNSW (a layered graph of neighbors) and IVF (cluster the vectors, then search only the closest clusters). The pgvector extension for PostgreSQL added HNSW indexes in version 0.5.0 (2023), next to its earlier IVFFlat index. Like fuzzy term search, it answers "close to" rather than "equal to"; unlike it, the answers themselves are approximate, with search parameters that trade speed against recall.</p>`,
        },
        {
          type: "text",
          html: `<h3>Keeping everything in memory</h3>
<p>Everything so far works around disks, which are slow for random access but cheap and durable. As RAM got cheaper, many datasets came to fit in memory, perhaps across a few machines. Caches such as Memcached can afford to lose everything on restart. Durable in-memory databases get their durability from battery-backed RAM, a change log, periodic snapshots or replicas, and reload from disk or a replica on restart. Disk then serves only as a place to append the log; every read is answered from RAM. Examples include VoltDB, MemSQL (now SingleStore), Oracle TimesTen and RAMCloud (log-structured in memory and on disk); Redis and Couchbase offer weaker durability by writing to disk asynchronously.</p>
<p>The counterintuitive part is <em>why</em> they're fast. It isn't mainly that they skip disk reads: a disk-based engine with enough RAM serves hot data from its buffer pool and the OS page cache anyway. They win because their data structures never have to be translated into an on-disk page format and back. That freedom also allows data models that are awkward on disk, such as Redis's sorted sets and priority queues.</p>
<p>For datasets bigger than RAM, <strong>anti-caching</strong> evicts the least recently used records to disk and loads them back on access: like OS swapping, but per record rather than per page. The indexes must still fit in memory.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The book expected <strong>non-volatile memory</strong> (byte-addressable memory that survives power loss) to reshape storage engines. Its most prominent product, Intel Optane persistent memory, was discontinued (announced in 2022), so that future hasn't arrived in mainstream hardware. Engines today are mostly tuned for fast NVMe SSDs and large DRAM caches.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Uber",
              year: "2016",
              tag: "index write amplification",
              html: "In \"Why Uber Engineering Switched from Postgres to MySQL\", Uber explained that because PostgreSQL's indexes point at physical row versions, an update that creates a new version must update every index on the table, while InnoDB's secondary indexes point at the primary key and are untouched unless an indexed column changes. HOT updates avoid this only in some cases.",
            },
            {
              org: "PostGIS, Redis GEO, Uber H3",
              tag: "spatial",
              html: "PostGIS spatial indexes are R-trees built on PostgreSQL's GiST framework. Redis GEO commands store each point's geohash as the score in a sorted set: a space-filling curve over an ordinary 1-D index. Uber open-sourced H3, a hexagonal hierarchical spatial index, in 2018.",
            },
            {
              org: "Apache Lucene",
              year: "2012",
              tag: "fuzzy search",
              html: "Lucene 4.0 introduced finite-state transducers for its in-memory term index and a FuzzyQuery based on Levenshtein automata, which made fuzzy term matching dramatically faster than the earlier brute-force walk over all terms.",
            },
            {
              org: "Redis",
              tag: "in-memory durability",
              html: "Redis keeps its dataset in memory and persists it with RDB snapshots and an append-only file (AOF). With AOF enabled, the default <code>appendfsync everysec</code> policy means up to about a second of writes can be lost in a crash.",
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p><strong>"Design 'restaurants near me'."</strong> A strong answer converts each location into a cell id (geohash, S2 or H3), indexes it with a B-tree or a Redis sorted set, queries the target cell plus its neighbors at a precision that matches the radius, then filters by exact distance. Alternatively, it names a spatial index such as PostGIS's GiST R-tree. Bonus points for noticing that dense cities make some cells hot, which argues for adaptive cell sizes.</p>
<p><strong>"This query uses an index, so why is it slow?"</strong> Ask what the index points to. A secondary lookup that matches 50,000 rows does 50,000 random heap or clustered-index reads; a covering index, or a concatenated index with the columns in the right order, removes them.</p>`,
        },
        {
          type: "quiz",
          q: "Uber found that in PostgreSQL, updating one non-indexed column of a row in a table with 10 indexes could cause writes to all 10 indexes. Why, and why is InnoDB different?",
          options: [
            "PostgreSQL indexes store a full copy of the row, so any change must be copied into every index",
            "PostgreSQL writes a new row version at a new physical location and its indexes point at physical locations, so each index needs a new entry (unless a HOT update applies); InnoDB secondary indexes store the primary key, which didn't change",
            "PostgreSQL has no clustered index, so it must rebuild every index after an update",
            "InnoDB doesn't support secondary indexes on large tables",
          ],
          answer: 1,
          explain: "What matters is what the index points at. A physical pointer goes stale whenever the row moves, and PostgreSQL's MVCC moves it on every update, while a logical pointer (the primary key) stays valid. InnoDB pays for this elsewhere: its secondary lookups need a second descent through the clustered index. C is tempting but wrong: nothing gets rebuilt; each index just gains one new entry. A is false because indexes store keys and locations, not whole rows, and D is simply untrue.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "oltp-vs-olap",
      title: "Two workloads, opposite needs: OLTP, analytics and the data warehouse",
      kicker: "Analytics",
      concepts: ["oltp-vs-olap", "data-warehouse", "etl", "star-snowflake-schema"],
      blocks: [
        {
          type: "problem",
          html: `<p>The business wants answers: revenue per store last January, whether last month's banana promotion lifted sales, which products customers tend to buy together. Each question reads years of history. Run it on the production database and it scans hundreds of millions of rows, competing for the same disk bandwidth, buffer pool and CPU that customer checkouts depend on. DBAs are right to refuse.</p>
<p>The data isn't even in one place. The web shop, the point-of-sale terminals, inventory, logistics and HR each have their own database with its own schema. And the indexes those systems are tuned with, built to fetch a few rows by key, don't help a query that has to look at most of the rows anyway.</p>`,
        },
        {
          type: "idea",
          html: `<p>Separate the workloads. Keep OLTP databases for low-latency reads and writes by key, and copy their data through <strong>ETL</strong> into a read-optimized <strong>data warehouse</strong>, organized as a star schema: one huge fact table of events surrounded by small dimension tables.</p>`,
        },
        {
          type: "table",
          title: "Two access patterns",
          headers: ["", "OLTP (transaction processing)", "OLAP (analytics)"],
          rows: [
            [`<span style="overflow-wrap:normal;word-break:normal">Typical read</span>`, "A few records, fetched by key through an index", "An aggregate (sum, count, average) over millions or billions of records"],
            [`<span style="overflow-wrap:normal;word-break:normal">Typical write</span>`, "Random-access, low-latency writes from user actions", "Bulk loads (ETL) or a stream of events"],
            [`<span style="overflow-wrap:normal;word-break:normal">Used by</span>`, "Customers, through the application", "Internal analysts and dashboards, for decision support"],
            [`<span style="overflow-wrap:normal;word-break:normal">What the data represents</span>`, "The current state of things", "A history of events over time"],
            [`<span style="overflow-wrap:normal;word-break:normal">Dataset size</span>`, "Gigabytes to terabytes", "Terabytes to petabytes"],
            [`<span style="overflow-wrap:normal;word-break:normal">Bottleneck</span>`, "Disk seek time: latency per lookup", "Disk bandwidth: bytes scanned per query"],
          ],
        },
        {
          type: "text",
          html: `<p>A note on words. "Transaction" first meant a commercial one, such as a sale or a payment, and came to mean a group of reads and writes that form a logical unit. <strong>Transaction processing</strong> here just means low-latency reads and writes, as opposed to batch jobs; it doesn't imply ACID guarantees (those are Chapter 7's subject).</p>
<h3>Why a separate warehouse</h3>
<p>SQL can express both kinds of query, and at first companies ran both on the same database. From the late 1980s and early 1990s they increasingly moved analytics to a separate one: the <strong>data warehouse</strong>, a read-only copy of the data from all of the company's OLTP systems, which analysts can query as hard as they like without slowing down operations.</p>
<p>Data reaches it through <strong>ETL</strong>. <em>Extract</em> it from the operational databases, by periodic dumps or a continuous stream of updates. <em>Transform</em> it into an analysis-friendly schema and clean it up along the way. <em>Load</em> it into the warehouse. Nearly every large enterprise has a warehouse; a small company with few systems may be fine querying an ordinary SQL database, or even a spreadsheet.</p>`,
        },
        {
          type: "diagram",
          title: "ETL: operational databases feed a warehouse",
          svg: `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three OLTP databases (web shop, point of sale, inventory) are extracted into a transform step that cleans, conforms and reshapes the data, which is loaded into a data warehouse with a star schema and columnar storage, queried by BI dashboards and analysts.">
<defs><marker id="ch3d2-etl-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="171" y="16" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">extract</text>
<rect x="16" y="24" width="130" height="40" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="81" y="49" font-size="12" text-anchor="middle">web shop DB</text>
<rect x="16" y="90" width="130" height="40" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="81" y="115" font-size="12" text-anchor="middle">point-of-sale DB</text>
<rect x="16" y="156" width="130" height="40" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="81" y="181" font-size="12" text-anchor="middle">inventory DB</text>
<line x1="146" y1="44" x2="194" y2="90" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-etl-arr)"/>
<line x1="146" y1="110" x2="194" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-etl-arr)"/>
<line x1="146" y1="176" x2="194" y2="130" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-etl-arr)"/>
<rect x="196" y="70" width="140" height="80" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="266" y="100" font-size="12" font-weight="700" text-anchor="middle">transform</text>
<text x="266" y="118" font-size="12" text-anchor="middle">clean, conform,</text>
<text x="266" y="134" font-size="12" text-anchor="middle">reshape</text>
<line x1="336" y1="110" x2="376" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-etl-arr)"/>
<text x="357" y="102" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">load</text>
<path d="M378,66 V154 A62,12 0 0 0 502,154 V66" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<ellipse cx="440" cy="66" rx="62" ry="12" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="440" y="104" font-size="12" font-weight="700" text-anchor="middle">data warehouse</text>
<text x="440" y="122" font-size="12" text-anchor="middle">star schema,</text>
<text x="440" y="138" font-size="12" text-anchor="middle">columnar</text>
<line x1="502" y1="96" x2="528" y2="82" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-etl-arr)"/>
<line x1="502" y1="124" x2="528" y2="142" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-etl-arr)"/>
<rect x="530" y="60" width="98" height="40" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="579" y="85" font-size="12" text-anchor="middle">BI dashboards</text>
<rect x="530" y="124" width="98" height="40" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="579" y="149" font-size="12" text-anchor="middle">analysts (SQL)</text>
<text x="81" y="214" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">OLTP databases</text>
<text x="440" y="196" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">read-only copy</text>
<text x="579" y="196" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">decision support</text>
</svg>`,
          caption: "OLTP stays fast; analysts query a copy. The transform step is where messy, inconsistent source schemas become one analysis-friendly model.",
        },
        {
          type: "text",
          html: `<h3>Same SQL, different internals</h3>
<p>Warehouses usually present a relational interface, because SQL suits analytic queries and business-intelligence tools generate it as you click: <strong>drill-down</strong> from a yearly total into months, <strong>slicing and dicing</strong> by region or product. Underneath the SQL, though, the storage engine and query executor are built for a completely different access pattern, which the next two sections explain.</p>
<p>That's why many vendors specialize in one workload or the other. A few products, such as SQL Server and SAP HANA, support both, increasingly as two separate storage and query engines behind one SQL interface. In the book's survey, commercial warehouses included Teradata, Vertica, SAP HANA and ParAccel (the basis of Amazon Redshift), and open-source SQL-on-Hadoop engines included Hive, Spark SQL, Impala, Presto, Tajo and Drill, several of them inspired by Google's Dremel.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The warehouse has moved to the cloud and changed shape. <strong>Cloud warehouses</strong> such as Snowflake, BigQuery, Redshift and Databricks SQL separate storage from compute, so each scales on its own, and engines like ClickHouse have made fast columnar analytics widely available. <strong>ELT</strong> has largely replaced ETL: load the raw data first, then transform it inside the warehouse with SQL, often managed by tools like dbt. <strong>Change data capture</strong> streams changes from OLTP logs (Chapter 11) instead of nightly dumps. <strong>Lakehouse</strong> table formats (Apache Iceberg, Delta Lake, Apache Hudi) put warehouse tables on open Parquet files in object storage. And <strong>HTAP</strong> systems (TiDB with TiFlash columnar replicas, SQL Server columnstore indexes, SingleStore) try to serve both workloads from one database.</p>`,
        },
        {
          type: "text",
          html: `<h3>Star and snowflake schemas</h3>
<p>OLTP schemas vary wildly from one application to the next; warehouse schemas are remarkably uniform. Most follow the <strong>star schema</strong>, also called dimensional modeling, popularized by Ralph Kimball's <em>The Data Warehouse Toolkit</em> (1996).</p>
<p>At the center is a <strong>fact table</strong>. Each row is one event, such as a sale, a page view or a click, recorded at the finest grain available so it can be sliced any way later. A basket of five products becomes five fact rows. Some columns are attributes of the event (quantity, net price, cost); the rest are foreign keys into <strong>dimension tables</strong>, which describe the who, what, where, when, how and why: the customer, product, store, promotion and date.</p>
<p>Even the date is usually a dimension, so attributes like "public holiday" or "weekend" are stored once per day and become easy to filter on, for example to compare holiday sales with ordinary days. The name comes from the diagram: the fact table sits in the middle with the dimension tables arranged around it like the points of a star.</p>`,
        },
        {
          type: "diagram",
          title: "A star schema, with one snowflaked dimension",
          svg: `<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A central fact_sales table with date_key, product_sk, store_sk, customer_sk, promotion_sk, quantity and net_price columns, linked to five dimension tables: dim_date, dim_store, dim_customer, dim_product and dim_promotion. dim_product is further normalized into dim_brand and dim_category, which makes it a snowflake schema.">
<line x1="174" y1="40" x2="240" y2="104" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="174" y1="150" x2="240" y2="140" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="174" y1="260" x2="240" y2="158" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="466" y1="40" x2="400" y2="122" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="466" y1="260" x2="400" y2="176" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="541" y1="64" x2="488" y2="106" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4"/>
<line x1="541" y1="64" x2="584" y2="106" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4"/>
<rect x="240" y="60" width="160" height="176" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="320" y="82" font-size="13" font-weight="700" text-anchor="middle">fact_sales</text>
<line x1="240" y1="90" x2="400" y2="90" style="stroke: var(--viz-c1)"/>
<g font-size="12" style="font-family: var(--font-mono)">
<text x="256" y="108">date_key</text>
<text x="256" y="126">product_sk</text>
<text x="256" y="144">store_sk</text>
<text x="256" y="162">customer_sk</text>
<text x="256" y="180">promotion_sk</text>
<text x="256" y="198">quantity</text>
<text x="256" y="216">net_price</text>
</g>
<rect x="24" y="16" width="150" height="48" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="99" y="36" font-size="12" font-weight="700" text-anchor="middle">dim_date</text>
<text x="99" y="54" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">weekday, is_holiday</text>
<rect x="24" y="126" width="150" height="48" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="99" y="146" font-size="12" font-weight="700" text-anchor="middle">dim_store</text>
<text x="99" y="164" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">city, floor_area</text>
<rect x="24" y="236" width="150" height="48" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="99" y="256" font-size="12" font-weight="700" text-anchor="middle">dim_customer</text>
<text x="99" y="274" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">name, birth_date</text>
<rect x="466" y="16" width="150" height="48" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="541" y="36" font-size="12" font-weight="700" text-anchor="middle">dim_product</text>
<text x="541" y="54" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sku, description</text>
<rect x="446" y="106" width="84" height="36" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-dasharray: 5 4"/>
<text x="488" y="129" font-size="12" text-anchor="middle">dim_brand</text>
<rect x="538" y="106" width="92" height="36" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-dasharray: 5 4"/>
<text x="584" y="129" font-size="12" text-anchor="middle">dim_category</text>
<text x="538" y="166" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">snowflake: normalized</text>
<text x="538" y="182" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sub-dimensions</text>
<rect x="466" y="236" width="150" height="48" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="541" y="256" font-size="12" font-weight="700" text-anchor="middle">dim_promotion</text>
<text x="541" y="274" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">name, ad_type</text>
</svg>`,
          caption: "Each fact row is one sale; its foreign keys point at the dimensions that describe it. Splitting dim_product into brand and category tables (dashed) turns this star into a snowflake.",
        },
        {
          type: "text",
          html: `<p>The fact table is where the volume is. The book cites enterprises such as Apple, Walmart and eBay with tens of petabytes of transaction history in their warehouses, most of it in fact tables. Fact tables are also wide, commonly with a hundred-plus columns, because every measure anyone might analyze gets its own column. Dimensions can be wide as well, since they carry any attribute that might be worth filtering on: for a store, its floor area, the services it offers, its opening date and its last remodel.</p>
<p>A <strong>snowflake schema</strong> normalizes the dimensions further into sub-dimensions: a product row references a brand table and a category table instead of repeating their names. It's tidier in the normalization sense of Chapter 2, but analysts usually prefer the star because there are fewer tables to join and reason about. Notice that the star deliberately breaks Chapter 2's advice: brand names repeat in every product row, trading update convenience for simpler queries.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Amazon Redshift",
              year: "2012",
              tag: "lineage",
              html: "Redshift, announced by AWS in 2012, is based on technology licensed from ParAccel, a column-oriented MPP data warehouse, the lineage the book mentions.",
            },
            {
              org: "Google BigQuery",
              tag: "Dremel",
              html: "BigQuery is the external product built on Dremel, Google's interactive query engine for nested columnar data described in a 2010 VLDB paper. Dremel's columnar encoding of nested records also inspired Apache Parquet.",
            },
            {
              org: "Snowflake",
              year: "2016",
              tag: "storage vs compute",
              html: "Snowflake's SIGMOD 2016 paper describes a cloud warehouse that keeps data as immutable columnar files in object storage such as S3 and runs queries on separate, elastic compute clusters (\"virtual warehouses\"), so heavy jobs don't compete for the same machines.",
            },
            {
              org: "TiDB and SQL Server",
              tag: "HTAP",
              html: "TiDB keeps optional columnar replicas of tables in TiFlash, fed through Raft, so analytic queries can avoid the row store. SQL Server's columnstore indexes arrived in 2012 (initially making the table read-only); SQL Server 2016 made nonclustered columnstore indexes updatable on row-store tables, so one table can serve OLTP and analytics.",
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "A separate warehouse",
          prosLabel: "What it buys",
          consLabel: "What it costs",
          pros: [
            "Analytic queries can't starve customer-facing transactions of disk, cache or CPU.",
            "Storage and schema built for scans: columnar files, star schemas, precomputed aggregates.",
            "One place that combines data from every operational system.",
            "History is kept: the warehouse holds every event long after the OLTP side has overwritten the current state.",
          ],
          cons: [
            "Freshness: data is only as recent as the last load (hours, with nightly batches) unless you stream changes.",
            "Pipelines to build and operate; an upstream schema change can silently break a transform.",
            "A second copy of the data to secure, govern and pay for.",
            "Two systems that can disagree, so \"which number is right?\" becomes a real question.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p><strong>Common prompt:</strong> "Product wants a dashboard of revenue by region, refreshed hourly. Where do those queries run?" The weak answer adds an index on the production database. A strong answer explains why the workloads collide (OLTP is seek-bound, analytics is bandwidth-bound, and both share one buffer pool), proposes copying data out through CDC or a batch pipeline into a columnar warehouse modeled as a star schema, and states the freshness this gives.</p>
<p>If asked "why not just a read replica?": a replica isolates the load from the primary, but it keeps the OLTP row layout, so big scans are still slow. It's a reasonable stopgap while the data is small.</p>`,
        },
        {
          type: "quiz",
          q: "Why does a 'revenue by region per week for the last two years' query on the production OLTP primary hurt checkout latency, even though there is an index on order date?",
          options: [
            "SQL can't aggregate efficiently, so the query should be rewritten in application code",
            "OLTP databases can't run GROUP BY on indexed columns",
            "Every read in an OLTP database takes exclusive locks, which block the checkout writes",
            "The query must read a large share of the table's rows (each a wide row), using disk bandwidth, buffer-pool space and CPU that small keyed transactions depend on; an index helps find rows, not avoid reading them",
          ],
          answer: 3,
          explain: "Two years of orders is most of the table, so the engine has to pull those rows, with all their columns, through the buffer pool, evicting the hot pages that checkouts rely on and saturating I/O. The index on date doesn't help when nearly every row matches. C is the tempting wrong answer, but in most modern OLTP databases plain reads don't block writers, thanks to MVCC (Chapter 7); the harm is resource contention. A and B are simply false.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "column-storage",
      title: "Read only what the query touches: column storage and compression",
      kicker: "Analytics storage",
      concepts: ["column-oriented-storage", "column-compression", "vectorized-processing", "sort-order-in-columns"],
      blocks: [
        {
          type: "problem",
          html: `<p>A warehouse fact table can reach trillions of rows and petabytes on disk, usually with more than 100 columns, yet a typical analytic query reads four or five of them. Most OLTP databases, and document stores too, lay data out <strong>row by row</strong>: all of one row's values sit next to each other on disk.</p>
<p>Indexes on the date or product columns tell the engine <em>which</em> rows match, but it still has to load each matching row in full, parse it, and throw most of it away. When a query scans billions of rows, the bottleneck is disk and memory bandwidth, and nearly all of it goes on columns nobody asked for.</p>`,
        },
        {
          type: "idea",
          html: `<p>Store all the values of each column together, with every column file holding the rows <strong>in the same order</strong>, so a query reads only the columns it uses. Values within a column repeat a lot, so they compress well (dictionaries, bitmaps, run-length encoding), especially when the rows are sorted, and they can be processed in tight loops over batches that fit in the CPU cache.</p>`,
        },
        {
          type: "code",
          lang: "sql",
          title: "A typical analytic query",
          code: `-- Weekend vs weekday revenue per store region, 2023
SELECT s.region, d.is_weekend,
       SUM(f.quantity * f.net_price) AS revenue
FROM fact_sales AS f
JOIN dim_date  AS d ON d.date_key = f.date_key
JOIN dim_store AS s ON s.store_sk = f.store_sk
WHERE d.year = 2023
GROUP BY s.region, d.is_weekend;`,
          caption: "It touches 4 of fact_sales's 100+ columns: date_key, store_sk, quantity and net_price.",
        },
        {
          type: "text",
          html: `<h3>Columns, not rows</h3>
<p>A row store has to read every column of <code>fact_sales</code> to answer that query. A <strong>column-oriented</strong> store keeps each column in its own file (or its own region of a file), so the query reads <code>date_key</code>, <code>store_sk</code>, <code>quantity</code> and <code>net_price</code> and never touches the rest.</p>
<p>The layout depends on one invariant: every column file lists the rows in the same order. To rebuild row <em>k</em>, take position <em>k</em> from each column file. Nothing ties a value to its row except its position.</p>
<p>Columnar storage isn't limited to flat relational tables. <strong>Parquet</strong> stores nested, document-like records column by column, using the encoding from Google's Dremel paper, which is why it's the common file format for analytics on data lakes.</p>
<p>The visualization below shows one small fact table three ways: as a logical table, as the bytes each layout puts on disk, and as the compressed encoding of one column. The stats scale the result up to a billion rows.</p>`,
        },
        {
          type: "viz",
          id: "ch3/column-store",
          title: "Row vs column storage",
          caption: "Try Q1 and compare how many cells each layout reads (60 vs 24), then switch the sort to \"product, date\" and watch each product bitmap's run-length encoding shrink to two numbers. Pick Q2 to see a WHERE clause become a bitwise AND, and Q3 to see the one case where the row store wins. Finally, choose \"product column only\": compression looks perfect, but the answers turn red, because the columns no longer line up.",
        },
        {
          type: "text",
          html: `<p>In Q1 the row file lights up completely, while the column layout reads two files out of five; on a real fact table that would be 2 columns out of 100, a 50-fold cut in I/O before any compression. Q3 flips the picture: fetching one whole row is a single read in a row store but one read per column file in a column store. That's why OLTP databases stay row-oriented.</p>
<h3>Compression: bitmaps and runs</h3>
<p>Values within one column are highly repetitive. A retailer might sell 100,000 distinct products across billions of sales, so <code>product_sk</code> has vastly fewer distinct values than rows. <strong>Bitmap encoding</strong> exploits this: for a column with <em>n</em> distinct values, keep <em>n</em> bitmaps, one per value, each with one bit per row. When <em>n</em> is small, store the bitmaps as they are. When <em>n</em> is large, nearly every bit is 0, so <strong>run-length encode</strong> them: <code>0 0 0 0 1 1 0 0 0 …</code> becomes "4 zeros, 2 ones, then zeros", stored as <code>4, 2</code>.</p>
<p>Bitmaps also answer <code>WHERE</code> clauses directly. <code>product_sk IN (12, 40, 41)</code> is a bitwise OR of three bitmaps, and <code>product_sk = 7 AND store_sk = 3</code> is a bitwise AND of two. Both work only because bit <em>k</em> means row <em>k</em> in every column: the same invariant again, and exactly what Q2 shows.</p>
<p>Bitmaps are one technique among several. <strong>Dictionary encoding</strong>, which replaces each value with a small integer code, is the most common in practice (Parquet and ORC use it heavily). Numbers are often stored as differences from their neighbor (delta encoding) or from a block's minimum (frame of reference), then bit-packed into as few bits as they need. How much all this saves depends heavily on the data: often several times over the raw size, and far more for sorted, low-cardinality columns.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Two things that aren't column storage",
          html: `<p><strong>Column families aren't columnar.</strong> Cassandra and HBase inherited "column families" from Bigtable, but within a column family they store all of a row's columns together with its row key, and they don't use column compression. The model is mostly row-oriented, so don't list them as column stores.</p>
<p><strong>Never sort one column on its own.</strong> Sorting each column independently would compress beautifully and destroy the data, because position is the only thing linking values to rows. Pick "product column only" in the visualization: the product column shrinks to four runs, and Q2's answer silently changes from 3 to 5. Sort orders always apply to whole rows.</p>`,
        },
        {
          type: "text",
          html: `<h3>Vectorized processing</h3>
<p>Once a scan reads only the bytes it needs, the next bottleneck is moving them from memory through the CPU. Analytic engines care about memory-to-cache bandwidth, branch mispredictions, pipeline stalls, and <strong>SIMD</strong> instructions that apply one operation to several values at once.</p>
<p>Column storage helps here too. Values of one column arrive as a dense array of a single type, so the engine can process a batch of them (often around a thousand, sized to stay in the L1 cache) in one tight loop, with no per-row function call or type check. A row-at-a-time executor does the opposite: each record passes through a chain of operator calls, with a conditional at every step. Compression puts more values in each cache line, and operators like the bitwise AND and OR above can run on compressed chunks directly. This style is called <strong>vectorized processing</strong>.</p>`,
        },
        {
          type: "diagram",
          title: "Vector at a time vs row at a time",
          svg: `<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: a chunk of 1,024 compressed values of the qty column fits in the L1 cache and is processed by a tight SIMD loop, 8 values per instruction. Bottom: rows are fetched one at a time through a next() call per row, with a branch per row and one value per iteration.">
<defs><marker id="ch3d2-vec-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="16" y="22" font-size="13" font-weight="700">Vector at a time</text>
<rect x="16" y="34" width="180" height="52" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="106" y="56" font-size="12" font-weight="700" text-anchor="middle">qty column chunk</text>
<text x="106" y="74" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">1,024 compressed values</text>
<line x1="196" y1="60" x2="228" y2="60" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-vec-arr)"/>
<rect x="232" y="34" width="120" height="52" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="292" y="56" font-size="12" font-weight="700" text-anchor="middle">L1 cache</text>
<text x="292" y="74" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">fits entirely</text>
<line x1="352" y1="60" x2="384" y2="60" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-vec-arr)"/>
<rect x="388" y="34" width="240" height="52" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="508" y="52" font-size="12" font-weight="700" text-anchor="middle">tight loop + SIMD</text>
<g style="fill: var(--viz-c4-soft); stroke: var(--viz-ok)">
<rect x="430" y="60" width="16" height="16" rx="2"/><rect x="450" y="60" width="16" height="16" rx="2"/><rect x="470" y="60" width="16" height="16" rx="2"/><rect x="490" y="60" width="16" height="16" rx="2"/>
<rect x="510" y="60" width="16" height="16" rx="2"/><rect x="530" y="60" width="16" height="16" rx="2"/><rect x="550" y="60" width="16" height="16" rx="2"/><rect x="570" y="60" width="16" height="16" rx="2"/>
</g>
<text x="508" y="104" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">8 values per instruction</text>
<text x="16" y="130" font-size="13" font-weight="700">Row at a time</text>
<rect x="16" y="142" width="180" height="52" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="106" y="164" font-size="12" font-weight="700" text-anchor="middle">row 1, row 2, … row N</text>
<text x="106" y="182" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">whole records, one by one</text>
<line x1="196" y1="168" x2="228" y2="168" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-vec-arr)"/>
<rect x="232" y="142" width="120" height="52" rx="6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="292" y="164" font-size="12" font-weight="700" text-anchor="middle">next() call</text>
<text x="292" y="182" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">for every row</text>
<line x1="352" y1="168" x2="384" y2="168" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-vec-arr)"/>
<rect x="388" y="142" width="240" height="52" rx="6" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="508" y="164" font-size="12" font-weight="700" text-anchor="middle">branch: year = 2023?</text>
<text x="508" y="182" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">one value per iteration</text>
</svg>`,
          caption: "Same work, far fewer instructions and cache misses per value. The vectorized path amortizes each call over a thousand values and lets the CPU apply one instruction to several at once.",
        },
        {
          type: "text",
          html: `<h3>Choosing a sort order</h3>
<p>The simplest column store keeps rows in insertion order, appending each new row to the end of every column file. But, as with SSTables, the rows can instead be kept sorted, and the sort order then works as an index. The administrator picks sort keys from the common queries. If most queries filter on date ranges, make <code>date_key</code> the first key, so a "last month" query reads only last month's rows. A second key such as <code>product_sk</code> groups each day's sales of one product together, which helps queries that filter or group by product within a date range.</p>
<p>Sorting also boosts compression. The first sort key forms long runs of identical values: a billion rows spanning three years of dates is only about 1,100 runs, which run-length encoding stores in a few kilobytes. The second key compresses less well, because its runs restart within every value of the first, and columns further down look essentially random. Sorting the first few columns is still a big win, and the visualization's "product, date" order shows it: each product's bitmap collapses to two numbers.</p>
<p>C-Store, the research system commercialized as Vertica, went a step further. Data is replicated to several machines for fault tolerance anyway, so why not store each copy <strong>sorted differently</strong> and let each query use the order that suits it best? It resembles keeping several secondary indexes, with one difference: a column store has no pointers to data elsewhere, so each sort order is a full copy of the column values.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Modern column stores keep metadata that lets them skip data without reading it. <strong>Zone maps</strong> record the minimum and maximum of each column block: Amazon Redshift keeps them per 1 MB block and relies on sort keys to make them selective, and Snowflake prunes its immutable columnar micro-partitions using per-partition metadata. ClickHouse sorts each table by its <code>ORDER BY</code> key and keeps a sparse primary index with one entry per granule (8,192 rows by default), much like an SSTable's sparse index. <strong>Apache Arrow</strong> standardized an in-memory columnar format, so engines and libraries can exchange column batches without converting them, and <strong>DuckDB</strong> packs a vectorized columnar engine into an embeddable library that runs inside your process.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "C-Store → Vertica",
              year: "2005",
              tag: "sort orders",
              html: "The C-Store paper (VLDB 2005, Stonebraker et al.) proposed a column store with compressed columns and multiple overlapping \"projections\" in different sort orders. It was commercialized as Vertica.",
            },
            {
              org: "Apache Parquet and ORC",
              year: "2013",
              tag: "file formats",
              html: "Parquet, created by Twitter and Cloudera, uses Dremel's repetition and definition levels to store nested records column by column, with dictionary, run-length and bit-packing encodings. ORC was developed for Apache Hive at about the same time.",
            },
            {
              org: "ClickHouse",
              year: "2016",
              tag: "sparse index",
              html: "Open-sourced by Yandex in 2016, ClickHouse stores each column of a MergeTree table separately, sorted by the table's <code>ORDER BY</code> key, with a sparse primary index holding one entry per granule (8,192 rows by default), and executes queries vectorized over blocks of column values.",
            },
            {
              org: "MonetDB/X100 → Vectorwise, DuckDB",
              tag: "vectorized execution",
              html: "The MonetDB/X100 paper (CIDR 2005) introduced vectorized execution over cache-sized batches of column values, later commercialized as Vectorwise. DuckDB, from the same research group at CWI and first released in 2019, applies the model as an in-process analytical database.",
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "Column-oriented storage",
          prosLabel: "Wins",
          consLabel: "Costs",
          pros: [
            "Scans read only the columns a query uses, often a few percent of the table's bytes.",
            "Repetitive, sorted values compress well: less I/O, and more data fits in memory.",
            "Bitmaps and vectorized loops make filters and aggregates CPU-efficient.",
            "The sort key acts as a coarse index, and zone maps let whole blocks be skipped.",
          ],
          cons: [
            "Fetching one full row touches every column file, which is bad for OLTP point lookups.",
            "Writes are hard: compressed, sorted files can't be updated in place (next section).",
            "Only one sort order per copy of the data; each extra order is a full extra copy.",
            "Reassembling wide rows (<code>SELECT *</code>) gives back much of the benefit.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p><strong>Typical probes:</strong> "Why is Redshift or BigQuery fast for this aggregate but slow for <code>SELECT * … WHERE id = ?</code>?" and "How would you choose a sort key?" A strong answer names the three multipliers: read only the needed columns (I/O falls by the ratio of columns used to columns stored), compress them (sorted, low-cardinality columns most of all), and process them vectorized. For sort keys, lead with the column most queries filter on, usually time, so range filters skip most blocks, then a frequently grouped column. Then state the cost plainly: point lookups and single-row updates are expensive, which is why this is an analytics layout and not an OLTP one.</p>`,
        },
        {
          type: "quiz",
          q: "A fact table is sorted by (date, product_id). Which column will compress best with run-length encoding?",
          options: [
            "date",
            "product_id",
            "customer_id",
            "All about equally, since sorting doesn't affect compression",
          ],
          answer: 0,
          explain: "The first sort key forms the longest runs: all of one day's rows are contiguous, so a billion rows over a few years compress to about a thousand runs. product_id is tempting because it's sorted too, but only within each day, so its runs restart every day and are much shorter. customer_id isn't a sort key, so it's effectively random. Sorting is exactly what makes run-length encoding effective, which rules out D.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "column-writes-and-cubes",
      title: "Writing to a column store, and precomputing the answers",
      kicker: "Analytics trade-offs",
      concepts: ["column-store-writes", "materialized-view-data-cube"],
      blocks: [
        {
          type: "problem",
          html: `<p>Everything that makes column files fast to read makes them hard to write. They're compressed, sorted, and rows are identified only by position, so nothing can be updated in place. Insert one row into the middle of a sorted table and every column file has to be rewritten from that point on, all of them consistently, or the positions stop lining up.</p>
<p>Yet warehouses ingest data continuously, and analysts expect new rows to appear in their next query. Meanwhile the same dashboards rerun the same <code>SUM</code> and <code>COUNT</code> over billions of rows every few minutes. Even a very fast columnar scan is wasted work when the answer has barely changed.</p>`,
        },
        {
          type: "idea",
          html: `<p>Borrow the LSM-tree's idea for writes: buffer them in memory, then merge them into new column files in bulk. For aggregates that are asked for again and again, store the results (<strong>materialized views</strong> and <strong>data cubes</strong>), trading write cost and flexibility for instant reads.</p>`,
        },
        {
          type: "text",
          html: `<h3>Writes: borrow the LSM-tree's trick</h3>
<p>Making writes harder is an acceptable price in a warehouse, where analysts' big read-only queries generate most of the work. Column storage, compression and sorting all speed those reads up, and the writes can be handled in bulk.</p>
<p>Update-in-place, the B-tree approach, is off the table. The way out is the one from the section on SSTables and LSM-trees. New writes land in an <strong>in-memory store</strong> that keeps them sorted; its own layout, rows or columns, is an implementation detail. Once it holds enough data, a background job merges it with the existing column files and writes a fresh set of files in one sequential pass, then deletes the ones they replace. Vertica's original design worked this way.</p>
<p>A query therefore reads two places, the column files on disk and the recent writes in memory, and merges the results. The engine does this behind the scenes, so an insert, update or delete shows up in the very next query without the analyst knowing where the row currently lives.</p>
<p>ClickHouse applies the same idea without the in-memory stage. Every <code>INSERT</code> into a MergeTree table writes a new immutable <strong>part</strong>, a small sorted set of column files, and background merges combine parts into bigger ones. That's why it wants inserts batched: thousands of one-row inserts create small parts faster than merges can absorb them, and ClickHouse eventually rejects inserts with a "too many parts" error. Asynchronous inserts, which buffer small inserts on the server, exist for exactly this reason.</p>`,
        },
        {
          type: "diagram",
          title: "The column-store write path",
          svg: `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Writes go into an in-memory write store that is sorted and may be row- or column-oriented. When enough writes accumulate they are merged in bulk into sorted, compressed column files for date, product, store, qty and price. A query reads both the write store and the column files and combines them.">
<defs><marker id="ch3d2-wp-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="56" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">writes</text>
<line x1="16" y1="34" x2="106" y2="40" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-wp-arr)"/>
<line x1="16" y1="48" x2="106" y2="48" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-wp-arr)"/>
<line x1="16" y1="62" x2="106" y2="56" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-wp-arr)"/>
<rect x="110" y="20" width="230" height="56" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="225" y="43" font-size="12" font-weight="700" text-anchor="middle">write store (in memory)</text>
<text x="225" y="62" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sorted; row or column layout</text>
<line x1="225" y1="76" x2="225" y2="126" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-wp-arr)"/>
<text x="235" y="98" font-size="12" style="fill: var(--viz-muted)">bulk merge, once</text>
<text x="235" y="114" font-size="12" style="fill: var(--viz-muted)">enough writes pile up</text>
<g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
<rect x="110" y="130" width="56" height="40" rx="4"/><rect x="172" y="130" width="56" height="40" rx="4"/><rect x="234" y="130" width="56" height="40" rx="4"/><rect x="296" y="130" width="56" height="40" rx="4"/><rect x="358" y="130" width="56" height="40" rx="4"/>
</g>
<text x="138" y="155" font-size="12" text-anchor="middle">date</text>
<text x="200" y="155" font-size="12" text-anchor="middle">product</text>
<text x="262" y="155" font-size="12" text-anchor="middle">store</text>
<text x="324" y="155" font-size="12" text-anchor="middle">qty</text>
<text x="386" y="155" font-size="12" text-anchor="middle">price</text>
<text x="262" y="192" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">read store: sorted, compressed column files</text>
<text x="262" y="208" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">merged into new files; old ones deleted</text>
<line x1="340" y1="48" x2="455" y2="97" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="414" y1="150" x2="455" y2="109" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<circle cx="466" cy="103" r="11" style="fill: var(--viz-panel); stroke: var(--viz-muted); stroke-width: 1.5"/>
<text x="466" y="108" font-size="14" font-weight="700" text-anchor="middle">+</text>
<line x1="477" y1="103" x2="498" y2="103" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch3d2-wp-arr)"/>
<rect x="500" y="78" width="128" height="50" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="564" y="100" font-size="12" font-weight="700" text-anchor="middle">query</text>
<text x="564" y="118" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sees both</text>
</svg>`,
          caption: "The same trick as an LSM-tree: never update compressed files in place. Recent writes live in memory until a bulk merge writes a new generation of column files, and every query combines the two.",
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Lakehouse formats face the same problem with files they can't modify at all: Parquet files in object storage. Apache Iceberg and Delta Lake keep table data in immutable files plus metadata, and handle row-level changes in one of two ways. <strong>Copy-on-write</strong> rewrites every file that contains a changed row, so reads stay simple and writes are expensive. <strong>Merge-on-read</strong> (for example, Iceberg's format v2 delete files) records the changed rows in small extra files that readers apply at query time, so writes are cheap and reads do a little more work. Either way, periodic compaction rewrites small files into big ones: the LSM pattern once more.</p>`,
        },
        {
          type: "text",
          html: `<h3>Precomputing answers: materialized views</h3>
<p>Dashboards and reports run the same handful of aggregates (<code>COUNT</code>, <code>SUM</code>, <code>AVG</code>, <code>MIN</code>, <code>MAX</code>) over the same facts again and again. Each run grinds through the raw rows to reach an answer that has barely changed since the last one. The obvious fix is to compute it once and keep it.</p>
<p>A <strong>virtual view</strong> is only a named query: when you select from it, the database splices the view's definition into your query and runs the whole thing. A <strong>materialized view</strong> keeps the result on disk, like a table. That makes it a denormalized copy that goes stale whenever the base tables change, so it must be refreshed or maintained, by hand or automatically. Either way, every change to the base data now costs extra work. In an OLTP database, where writes dominate, that rarely pays off; in a read-heavy warehouse it often does, though only measurement tells you whether a particular view earns its keep.</p>
<p>Implementations differ in how they refresh. PostgreSQL added <code>CREATE MATERIALIZED VIEW</code> in 9.3 (2013); the view changes only when you run <code>REFRESH MATERIALIZED VIEW</code>, which recomputes the whole result, and 9.4 added <code>REFRESH … CONCURRENTLY</code> so readers aren't blocked while it runs.</p>
<h3>Data cubes</h3>
<p>A common special case is the <strong>data cube</strong>, or OLAP cube: a grid of aggregates grouped by several dimensions. Picture two. One axis is the date, the other the product, and each cell holds <code>SUM(net_price)</code> for all sales of that product on that day. Adding along a row gives one day's total across products; adding down a column gives one product's total across days.</p>
<p>Real fact tables have more than two dimensions. Date, product, store, promotion and customer would make a five-dimensional hypercube: harder to draw, same principle. Each cell is the aggregate for one combination of dimension values, and you can roll up along any subset of the dimensions.</p>`,
        },
        {
          type: "diagram",
          title: "A two-dimensional data cube",
          svg: `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A grid of SUM(net_price) with dates January 1 to 4 as rows and products apple, banana, candy and dates as columns. The right column holds per-day totals 45, 40, 50, 45; the bottom row holds per-product totals 50, 22, 85, 23; the grand total is 180. The cube can't answer the share of sales from items over 100 dollars because price is not a dimension.">
<text x="236" y="16" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">product →</text>
<rect x="376" y="52" width="70" height="136" style="fill: var(--viz-c3-soft)"/>
<rect x="96" y="188" width="280" height="34" style="fill: var(--viz-c3-soft)"/>
<rect x="376" y="188" width="70" height="34" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3); stroke-width: 2"/>
<path d="M96,26 H446 M16,52 H446 M16,86 H446 M16,120 H446 M16,154 H446 M16,188 H446 M16,222 H446 M16,52 V222 M96,26 V222 M166,26 V222 M236,26 V222 M306,26 V222 M376,26 V222 M446,26 V222" style="fill: none; stroke: var(--viz-line)"/>
<text x="56" y="44" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">date ↓</text>
<g font-size="12" font-weight="700" text-anchor="middle">
<text x="131" y="44">apple</text><text x="201" y="44">banana</text><text x="271" y="44">candy</text><text x="341" y="44">dates</text><text x="411" y="44">total</text>
</g>
<g font-size="12" text-anchor="middle">
<text x="56" y="74">Jan 1</text><text x="56" y="108">Jan 2</text><text x="56" y="142">Jan 3</text><text x="56" y="176">Jan 4</text>
<text x="56" y="210" font-weight="700">total</text>
</g>
<g font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">
<text x="131" y="74">12</text><text x="201" y="74">5</text><text x="271" y="74">20</text><text x="341" y="74">8</text><text x="411" y="74">45</text>
<text x="131" y="108">15</text><text x="201" y="108">7</text><text x="271" y="108">18</text><text x="341" y="108">0</text><text x="411" y="108">40</text>
<text x="131" y="142">9</text><text x="201" y="142">6</text><text x="271" y="142">25</text><text x="341" y="142">10</text><text x="411" y="142">50</text>
<text x="131" y="176">14</text><text x="201" y="176">4</text><text x="271" y="176">22</text><text x="341" y="176">5</text><text x="411" y="176">45</text>
<text x="131" y="210">50</text><text x="201" y="210">22</text><text x="271" y="210">85</text><text x="341" y="210">23</text><text x="411" y="210" font-weight="700">180</text>
</g>
<text x="462" y="70" font-size="12" font-weight="700">← right column</text>
<text x="462" y="86" font-size="12" style="fill: var(--viz-muted)">sum across products</text>
<text x="462" y="102" font-size="12" style="fill: var(--viz-muted)">= sales per day</text>
<text x="462" y="196" font-size="12" font-weight="700">← bottom row</text>
<text x="462" y="212" font-size="12" style="fill: var(--viz-muted)">sum across days</text>
<text x="462" y="228" font-size="12" style="fill: var(--viz-muted)">= sales per product</text>
<text x="16" y="250" font-size="12" style="fill: var(--viz-bad)">Can't answer from this cube: share of sales from items over $100 (price isn't a dimension)</text>
</svg>`,
          caption: "Each cell is SUM(net_price) for one (date, product) pair. Totals by day or by product, and the grand total, are just sums of cells. Anything about an attribute that isn't a dimension was summed away.",
        },
        {
          type: "text",
          html: `<p>Rolling up only works for <strong>decomposable</strong> aggregates. <code>SUM</code>, <code>COUNT</code>, <code>MIN</code> and <code>MAX</code> combine from cells directly. <code>AVG</code> works only if you keep the sum and the count separately, since an average of daily averages isn't the monthly average. Medians and exact distinct counts don't roll up at all; sketches such as HyperLogLog give approximate distinct counts that do. Size grows fast as well: the number of cells is the product of the dimensions' cardinalities, and a cube over <em>d</em> dimensions has 2<sup><em>d</em></sup> possible group-by combinations.</p>
<p>The payoff is that certain queries become lookups. "Total sales per store yesterday" reads a handful of precomputed cells instead of scanning millions of rows. The price is flexibility. A cube can't answer anything about an attribute that isn't one of its dimensions: "what share of sales came from items priced over $100?" is unanswerable, because price was summed away. So cubes complement the raw facts rather than replace them: the warehouse keeps the detailed rows for open-ended questions and adds a cube only where a few known queries need to be fast.</p>
<p>The idea has a long history. Gray et al.'s data cube operator (1996) became SQL's <code>GROUP BY CUBE</code> and <code>ROLLUP</code>; MOLAP servers such as Essbase and SQL Server Analysis Services stored precomputed cubes; Apache Kylin precomputes cubes on Hadoop, and Apache Druid can roll rows up as they're ingested. Fast columnar engines have made many hand-built cubes unnecessary, and streaming systems such as Materialize and RisingWave maintain views incrementally as each change arrives, an idea Chapters 11 and 12 develop.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Vertica",
              tag: "write store + read store",
              html: "Vertica's classic architecture had an in-memory write-optimized store (WOS) and a read-optimized store (ROS) of sorted, compressed column files on disk; a background \"Tuple Mover\" moved and merged data from WOS into ROS, and queries read both. Later versions dropped the WOS and load data straight into ROS containers, which the Tuple Mover still merges in the background.",
            },
            {
              org: "ClickHouse",
              tag: "parts and merges",
              html: "Every <code>INSERT</code> into a MergeTree table creates a new immutable part that background merges combine, which is why ClickHouse recommends batching inserts (or asynchronous inserts) and fails with a \"too many parts\" error when small parts pile up. Its materialized views run on each inserted block and can maintain pre-aggregated tables.",
            },
            {
              org: "Apache Druid and Apache Kylin",
              tag: "pre-aggregation",
              html: "Druid can \"roll up\" raw events at ingestion into pre-aggregated rows keyed by truncated timestamp and dimension values. Kylin, originally developed at eBay and open-sourced in 2014, precomputes OLAP cubes on Hadoop so that SQL aggregate queries become lookups.",
            },
            {
              org: "Apache Iceberg and Delta Lake",
              tag: "immutable files",
              html: "Both keep table data in immutable Parquet files plus metadata. Row-level updates either rewrite the affected files (copy-on-write) or, in Iceberg's v2 format, write delete files that readers merge at query time (merge-on-read), with periodic compaction rewriting small files.",
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "Precompute or scan?",
          prosLabel: "Materialized views and cubes give you",
          consLabel: "What they cost",
          pros: [
            "Dashboard queries become lookups over a few cells instead of scans over billions of rows.",
            "Predictable, low latency for the queries you designed them for.",
            "Less compute per query, which matters when a warehouse bills per byte scanned or per second of compute.",
          ],
          cons: [
            "Every write or refresh must update the aggregates: more write work, or stale results between refreshes.",
            "Only the questions you anticipated: no non-dimension attributes, no non-decomposable aggregates.",
            "Storage grows with the product of the dimension cardinalities and with every extra rollup.",
            "One more derived copy that can drift from the source if a refresh fails.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p><strong>Typical prompt:</strong> "Build real-time analytics: event counts per minute per country, for billions of events a day." A strong answer uses both halves of this section. For ingestion: batch writes into the column store, or let it buffer them as Vertica and ClickHouse do; never one row per insert. For queries: pre-aggregate the hot dashboard metrics with a materialized view, a rollup at ingestion (Druid, ClickHouse) or a streaming job, while keeping the raw events for ad hoc questions.</p>
<p>Then show you know the limits: counts and sums roll up across minutes and countries, unique users don't (use HyperLogLog sketches), and each path gives a different freshness.</p>`,
        },
        {
          type: "quiz",
          q: "A data cube over (date, product, store) holds SUM(net_price). Which question can it answer without touching the raw facts?",
          options: [
            "Median order value per store",
            "Share of revenue from items priced above $100",
            "Total sales per store last week",
            "Number of distinct customers per product",
          ],
          answer: 2,
          explain: "Store and date are dimensions and SUM rolls up, so the answer is a few cells added together. B looks like a simple filter, but price isn't a dimension, so the cube has already summed it away. A needs a median, which can't be computed from sums. D needs distinct counts, which don't add up across cells (and customer isn't a dimension of this cube anyway). This inflexibility is why warehouses keep the raw facts.",
        },
      ],
    },
  ],
  takeaways: [
    "Every index is a trade: <strong>faster reads for slower writes and more space</strong>. That's why databases make you choose indexes rather than indexing everything.",
    "Log-structured engines turn random writes into <strong>sequential appends</strong> and pay later: in compaction (write amplification) and in reads that may check several files (read amplification), which Bloom filters keep small.",
    "B-trees update <strong>fixed-size pages in place</strong>: shallow (3–4 levels cover terabytes) and predictable, but one insert can rewrite several pages, so a write-ahead log is required for crash safety.",
    "There is no universally faster engine. B-trees and LSM-trees spend <strong>write, read and space amplification</strong> differently, so benchmark your own workload, long enough for compaction to reach steady state, and monitor compaction in production.",
    "<strong>Where the row lives</strong> (heap file, clustered index, covering index) decides how many hops a read takes and how many structures each write touches.",
    "OLTP is <strong>seek-bound</strong> (a few rows by key) and analytics is <strong>bandwidth-bound</strong> (billions of rows, a few columns). They need opposite storage layouts, which is why data warehouses and ETL exist.",
    "Column storage reads only the columns a query needs, <strong>compresses</strong> them with sort order, bitmaps and run-length encoding, and processes them in cache-sized vectors; writes go through an LSM-style buffer.",
    "<strong>Precomputation</strong> (materialized views, data cubes) trades flexibility and write cost for instant answers, so keep the raw facts too.",
  ],
  connections: [
    { to: "ch1", html: "Compaction and fsync stalls show up as <strong>tail latency</strong>, and p99 is how you notice an LSM store falling behind. Compaction debt, write stalls and tombstones are the kind of operability burden Chapter 1 asks you to plan for." },
    { to: "ch2", html: "Data models meet storage: document stores keep a whole document contiguous for locality, star schemas deliberately denormalize their dimensions against Chapter 2's normalization advice, and materialized views are denormalization the database maintains for you." },
    { to: "ch4", html: "How records are encoded on disk: length-prefixed binary formats, and Parquet and ORC as columnar encodings with their own schemas, where schema evolution matters once data lands in a warehouse." },
    { to: "ch5", html: "The write-ahead log is what WAL-shipping replication sends to followers, and logical (row-based) replication logs are derived from it. In leaderless systems, tombstones must survive until anti-entropy has propagated the delete (Cassandra's <code>gc_grace_seconds</code>)." },
    { to: "ch6", html: "Sorted SSTables make key-range partitioning natural (Bigtable's tablets are key ranges); sequential keys that give B-trees good locality become hot spots in range-partitioned clusters; and secondary indexes have to be partitioned too." },
    { to: "ch7", html: "The WAL provides atomicity and durability for transactions (redo plus undo in ARIES); a B-tree's one-place-per-key layout makes index-range locks easy; copy-on-write B-trees and LSM sequence numbers provide the consistent snapshots that snapshot isolation needs." },
    { to: "ch10", html: "Merging SSTables is mergesort's merge step, the same sort-merge pattern as MapReduce's shuffle. Parquet and ORC files on HDFS or object storage are the columnar inputs and outputs of batch jobs, which can also build read-only, SSTable-like indexes in bulk." },
    { to: "ch11", html: "Change data capture reads the database's log to keep warehouses fresh instead of relying on nightly dumps; Kafka's log compaction is Bitcask's merge applied to a message log; and stream processors keep their state in embedded LSM engines such as RocksDB." },
    { to: "ch12", html: "Indexes, materialized views and warehouses are all <strong>derived data</strong> maintained from a source of truth. \"Unbundling\" the database turns this chapter's internal structures into separate systems fed by a log." },
  ],
  furtherReading: [
    {
      title: "O'Neil, Cheng, Gawlick and O'Neil, \"The Log-Structured Merge-Tree (LSM-Tree)\" (Acta Informatica, 1996)",
      note: "The original LSM paper: why batching and merging sorted runs beats B-trees for insert-heavy workloads.",
    },
    {
      title: "Chang et al., \"Bigtable: A Distributed Storage System for Structured Data\" (OSDI 2006)",
      note: "Where memtables, SSTables, minor and major compactions and per-SSTable Bloom filters were described together; the ancestor of HBase, Cassandra's storage layer and LevelDB.",
    },
    {
      title: "Sheehy and Smith, \"Bitcask: A Log-Structured Hash Table for Fast Key/Value Data\" (Basho, 2010)",
      note: "A short, readable paper describing the hash-index design from the chapter's first section, including hint files and merging.",
    },
    {
      title: "RocksDB wiki",
      url: "https://github.com/facebook/rocksdb/wiki",
      note: "Practical documentation of leveled and universal compaction, write stalls, Bloom and Ribbon filters and tuning, from a heavily used LSM engine.",
    },
    {
      title: "Bayer and McCreight, \"Organization and Maintenance of Large Ordered Indices\" (1972), and Comer, \"The Ubiquitous B-Tree\" (1979)",
      note: "The B-tree's origin, and the survey that explained why it took over databases.",
    },
    {
      title: "Mohan et al., \"ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging\" (ACM TODS, 1992)",
      note: "The classic WAL recovery algorithm: page LSNs, redo, undo and checkpoints.",
    },
    {
      title: "PostgreSQL documentation: Write-Ahead Logging (WAL)",
      url: "https://www.postgresql.org/docs/current/wal-intro.html",
      note: "A concise, authoritative explanation of why the log comes first and what it buys.",
    },
    {
      title: "Atomic Commit In SQLite",
      url: "https://www.sqlite.org/atomiccommit.html",
      note: "A step-by-step walk through making multi-page writes crash-safe, including what disks actually guarantee.",
    },
    {
      title: "Athanassoulis et al., \"Designing Access Methods: The RUM Conjecture\" (EDBT 2016)",
      note: "A framework for read vs update vs memory overhead, useful for comparing any two storage engines.",
    },
    {
      title: "Lu et al., \"WiscKey: Separating Keys from Values in SSD-conscious Storage\" (FAST 2016)",
      note: "How key-value separation reduces LSM write amplification; the idea behind BlobDB, Titan and Badger.",
    },
    {
      title: "Stonebraker et al., \"C-Store: A Column-oriented DBMS\" (VLDB 2005), and Abadi et al., \"The Design and Implementation of Modern Column-Oriented Database Systems\" (2013)",
      note: "The column-store design behind Vertica, plus a survey of compression, late materialization and vectorized execution.",
    },
    {
      title: "Alex Petrov, Database Internals (O'Reilly, 2019)",
      note: "A whole book expanding the first half of this chapter: B-tree variants, LSM-trees, recovery and more.",
    },
    {
      title: "Use The Index, Luke",
      url: "https://use-the-index-luke.com/",
      note: "A practical guide to how B-tree indexes, concatenated indexes and covering indexes behave in real SQL databases.",
    },
    {
      title: "Melnik et al., \"Dremel: Interactive Analysis of Web-Scale Datasets\" (VLDB 2010)",
      note: "The columnar encoding of nested records behind BigQuery, and the inspiration for Parquet.",
    },
    {
      title: "Boncz, Zukowski and Nes, \"MonetDB/X100: Hyper-Pipelining Query Execution\" (CIDR 2005)",
      note: "Where vectorized execution over cache-sized batches of column values comes from.",
    },
  ],
});
