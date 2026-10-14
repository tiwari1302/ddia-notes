// Chapter 10 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch10", {
  sections: [
    // ───────────────────────────────────────────────────────────── 6
    {
      id: "batch-outputs",
      title: "Batch outputs: build it offline, swap it in whole",
      kicker: "Outputs and workflows",
      concepts: ["output-of-batch-jobs", "workflow-engine", "immutable-output-swap", "human-fault-tolerance"],
      blocks: [
        {
          type: "problem",
          html: `<p>Back at Pebble, the joins are done: tonight's job has computed fresh "people you may know" lists for all 300 million users. The website must answer each lookup in a few milliseconds, so the results have to land in a serving database. The obvious plan: inside every reduce task, open a client to the production database and insert each row as soon as it's computed.</p>
<p>Count what goes wrong. Every insert is a network round trip, so a task that could stream records as fast as its disk reads them now crawls at the database's pace. Five hundred tasks writing at batch speed swamp a database that is also serving live traffic, and pages slow down for everyone. While the job runs, half the users see tonight's lists and half see last night's. A task that dies and is retried writes its first rows twice. And if tonight's code has a bug, it has already overwritten last night's good data: rolling back the code doesn't roll back the damage.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat a batch job as a pure function. Never modify its inputs or any external system; write a complete new output to a fresh location, <strong>publish it atomically</strong>, and keep the previous version so a bad run can be undone by switching back.</p>`,
        },
        {
          type: "text",
          html: `<h3>What batch jobs actually produce</h3>
<p>Reports for analysts are the smaller part. Much batch output is a <strong>derived dataset</strong> that another system serves. Search indexes are the classic case: as the first section mentioned, Google rebuilt its production web-search index as a sequence of five to ten MapReduce jobs. A Lucene or Solr index can be built the same way: mappers partition the documents, each reducer builds the index files for one partition, and the files land in the distributed filesystem. The index is immutable once written: when documents change, rebuild it on the next run, or add new segments and merge them in the background as LSM-trees do (Chapter 3).</p>
<p>Other outputs: trained models such as spam classifiers, recommendation tables keyed by user or item ID, and aggregated warehouse tables.</p>
<h3>Why tasks shouldn't write into the live database</h3>
<ol>
<li><strong>Speed.</strong> A request per record, even batched, is orders of magnitude slower than a task's own throughput of sequential file I/O.</li>
<li><strong>Operational coupling.</strong> Hundreds of parallel tasks can overwhelm the database and degrade it for its other users, turning a background job into a production incident.</li>
<li><strong>Broken all-or-nothing.</strong> The framework promises that a job's output appears completely or not at all. External writes escape that promise: other systems see partial results mid-job, and retried or speculative attempts can write the same rows twice.</li>
</ol>`,
        },
        {
          type: "compare",
          title: "Two ways to publish tonight's results",
          items: [
            {
              title: "Write rows into the live DB from tasks",
              tone: "bad",
              html: "<p>Per-record round trips at the database's pace. Batch load competes with live reads. Readers see a mix of old and new rows for the whole run. Retries can duplicate rows. A buggy run overwrites good data, with no quick undo.</p>",
            },
            {
              title: "Build files, then swap",
              tone: "ok",
              html: "<p>Tasks write sorted files sequentially to the distributed filesystem. Serving traffic never notices the job. Readers flip from v41 to v42 in one step. Failed attempts leave no trace. Rollback means pointing readers back at v41.</p>",
            },
          ],
        },
        {
          type: "text",
          html: `<p>The visualization replays both strategies on one illustrative nightly job: four tasks, each computing recommendations for 50,000 users, while yesterday's v41 is still live. You can make a task fail halfway or make the new code buggy, then watch what the website's readers experience.</p>`,
        },
        {
          type: "viz",
          id: "ch10/batch-output",
          title: "Publishing batch output",
          caption: "Try the default first, Writing rows into the live DB with the task failure on, and press Play. Notice that half the users see v42 while the job is still running, the web app's p99 jumps from 12 to 85 ms, and T3's retry leaves 30,000 duplicate rows. Then switch to Building files, then swapping and replay: readers see nothing until one atomic switch, and the failed attempt leaves no trace. Finally turn on The new code has a bug in both modes and compare how long the undo takes (hours versus seconds). All numbers are illustrative.",
        },
        {
          type: "text",
          html: `<p>In the direct-write run, the harm happens <em>during</em> the job: readers watched v42 rows trickle in (100,000 of them by the halfway point), live reads slowed while the database absorbed batch writes, and the retry duplicated 30,000 rows. In the swap run, readers noticed nothing until a single switch.</p>
<h3>How the framework makes output all-or-nothing</h3>
<p>Hadoop's output committer gives every <strong>task attempt</strong> its own directory under <code>_temporary</code>, and only one attempt per task may commit. A finished attempt asks the application master for permission (Spark's driver does the same through its <code>OutputCommitCoordinator</code>); if a speculative twin already committed, the request is refused and its files are discarded. Committed output is moved into place by renaming, and once every task has committed, the job commit finalizes the directory and writes an empty <code>_SUCCESS</code> marker that downstream jobs wait for. On HDFS a rename is a cheap, atomic metadata operation. On object stores such as S3 a "rename" is a copy plus a delete, which is why special S3 committers and table formats exist.</p>
<h3>Build the database inside the job</h3>
<p>The clean way to feed a serving system is to have the job produce the database itself: files in the store's own format, sorted by key, written to the job's output directory and loaded in bulk by the serving nodes. Voldemort's read-only stores, Terrapin, ElephantDB and HBase bulk loading all work this way. It suits MapReduce perfectly, because extracting a key and sorting by it is exactly what the shuffle already does, the same work as building a search index.</p>
<p>Voldemort's swap is the pattern to remember: nodes keep serving the old files while copying the new version to local disk, switch atomically, and switch back if anything looks wrong, since the old files are untouched.</p>`,
        },
        {
          type: "diagram",
          title: "Build offline, copy in the background, switch atomically",
          svg: `<svg viewBox="0 0 400 354" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A nightly job writes version 42 into the distributed filesystem next to version 41. Each serving node copies v42 in the background while serving v41, then readers switch to v42 atomically; switching back is the rollback.">
<defs><marker id="ch10d2-swap-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="130" y="8" width="140" height="34" rx="8" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="200" y="30" text-anchor="middle" font-size="12" font-weight="700">nightly job v42</text>
<text x="262" y="60" font-size="12" style="fill: var(--viz-muted)">builds offline</text>
<rect x="10" y="72" width="380" height="64" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="20" y="89" font-size="12" style="fill: var(--viz-muted)">distributed filesystem</text>
<rect x="24" y="98" width="160" height="28" rx="6" stroke-width="1.6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="104" y="117" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">/recs/v41/</text>
<rect x="204" y="98" width="176" height="28" rx="6" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="292" y="117" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">/recs/v42/ + _SUCCESS</text>
<text x="332" y="157" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">background copy</text>
<rect x="10" y="170" width="380" height="104" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="20" y="188" font-size="12" font-weight="700">serving node (one of many)</text>
<rect x="24" y="198" width="160" height="38" rx="6" stroke-width="1.6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="104" y="214" text-anchor="middle" font-size="12" font-weight="700">v41 files</text>
<text x="104" y="230" text-anchor="middle" font-size="12">serving</text>
<rect x="216" y="198" width="160" height="38" rx="6" stroke-width="1.6" stroke-dasharray="5 3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="296" y="214" text-anchor="middle" font-size="12" font-weight="700">v42 files</text>
<text x="296" y="230" text-anchor="middle" font-size="12">copied, waiting</text>
<path d="M252,238 Q200,266 156,238" stroke-width="1.6" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#ch10d2-swap-arr)"/>
<text x="200" y="266" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">rollback = switch back</text>
<rect x="60" y="312" width="280" height="34" rx="8" stroke-width="1.6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="200" y="334" text-anchor="middle" font-size="12" font-weight="700">web app readers</text>
<path d="M104,312 L104,278" stroke-width="2" style="fill: none; stroke: var(--viz-c6)" marker-end="url(#ch10d2-swap-arr)"/>
<text x="96" y="300" text-anchor="end" font-size="12">serving now</text>
<path d="M296,312 L296,278" stroke-width="2" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-c6)" marker-end="url(#ch10d2-swap-arr)"/>
<text x="304" y="300" font-size="12">atomic switch</text>
<path d="M226,42 L286,95" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-swap-arr)"/>
<path d="M340,126 L340,196" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-swap-arr)"/>
</svg>`,
          caption: "The job writes v42 beside v41 and never touches it. Each serving node fetches v42 while still answering from v41, then readers move over in one step. Because v41 is still on disk, undoing a bad run is the same cheap operation as publishing a good one.",
        },
        {
          type: "text",
          html: `<h3>The philosophy: immutable inputs, output as the only effect</h3>
<p>This is the Unix discipline from earlier in the chapter, applied to whole datasets. A job never modifies its inputs and has no side effects beyond its output. That restriction buys a lot:</p>
<ul>
<li><strong>Human fault tolerance.</strong> Ship a bug and the output is wrong, but the inputs are intact: roll back the code and rerun, or point readers at yesterday's output. A database updated by read-write transactions has no such undo. Cheap undo also lets teams ship features faster.</li>
<li><strong>Safe retries.</strong> Automatic retries are only correct because inputs never change and failed attempts leave nothing behind.</li>
<li><strong>One input, many consumers.</strong> The same files feed many jobs, including checks that compare today's output with yesterday's and block publication if something collapses.</li>
<li><strong>Logic separated from wiring.</strong> A job only knows "read this directory, write that one", so one team writes it and another decides where and when it runs.</li>
</ul>
<h3>Workflows: chains of jobs and a scheduler on top</h3>
<p>One job rarely suffices; the book mentions recommendation systems built from 50 to 100 chained MapReduce jobs. Hadoop links jobs only by directory name: job 2's input directory is job 1's output directory, and that output counts only once job 1 has completed successfully. A <strong>workflow scheduler</strong> such as Oozie, Azkaban, Luigi, Airflow or Pinball manages the DAG: it starts each job when its inputs are ready, retries failures, alerts humans and runs backfills. Pig, Hive, Cascading, Crunch and FlumeJava go further, compiling one program into a multi-job workflow.</p>
<p>The rule that keeps workflows sane: make each task <strong>deterministic and idempotent</strong>, and have it overwrite a whole output partition (say <code>dt=2025-01-14/</code>) rather than append, so a rerun or backfill replaces exactly what it owns. Write self-describing, evolvable formats such as Avro or Parquet (Chapter 4). Two caveats: idempotent upserts into a live store prevent duplicates but not the half-updated view readers get mid-job; and truly external side effects, like emails or payment calls, belong in a separate idempotent step that runs after the output is committed.</p>`,
        },
        {
          type: "keypoints",
          items: [
            "Never mutate the input; write output to a new location.",
            "Publish atomically (rename, pointer swap, table commit); readers never see half a job.",
            "Keep the previous version: rollback means switching back.",
            "Make tasks deterministic and idempotent so retries and backfills are safe.",
            "Validate the new output against the last one before publishing it.",
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "LinkedIn Project Voldemort",
              year: "2012",
              tag: "read-only stores",
              html: "The FAST 2012 paper <em>Serving Large-scale Batch Computed Data with Project Voldemort</em> describes building store files in Hadoop, having servers fetch the new version in parallel while still serving the old one, swapping atomically and rolling back instantly. It served batch-computed features such as People You May Know.",
            },
            {
              org: "Apache HBase",
              tag: "bulk load",
              html: "A MapReduce or Spark job writes HFiles, HBase's own storage files, sorted by row key; the bulk-load tool (<code>completebulkload</code>) then moves them into the live regions, bypassing the normal write path entirely.",
            },
            {
              org: "Apache Hadoop",
              tag: "output committer",
              html: "<code>FileOutputCommitter</code> writes each task attempt under <code>_temporary</code>, commits successful attempts by renaming, and writes an empty <code>_SUCCESS</code> file when the job completes. Schedulers commonly wait for that marker before starting downstream work.",
            },
            {
              org: "Google Percolator",
              year: "2010",
              tag: "limits of rebuilding",
              html: "Google moved web indexing from batch MapReduce passes that reprocessed the whole repository to incremental processing with Percolator (OSDI 2010); the paper reports that the average age of documents in search results fell by 50%. Rebuilding everything stops being enough when freshness matters.",
            },
            {
              org: "Apache Airflow",
              year: "2014",
              tag: "functional data engineering",
              html: "Started at Airbnb by Maxime Beauchemin in 2014 and an Apache top-level project since 2019. His 2018 essay <em>Functional Data Engineering</em> argues for deterministic, idempotent tasks that overwrite immutable partitions, which makes reruns and backfills safe.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Table formats turned the swap into a commit",
          html: `<p>Open table formats, namely Apache Iceberg (started at Netflix), Delta Lake (from Databricks) and Apache Hudi (from Uber), turn "write new files, then switch atomically" into a table-level commit on object storage. Each commit creates a new snapshot, readers never see half a job, and time travel lets you query or roll back to an earlier snapshot. They exist partly because object stores have no atomic directory rename. Airflow and dbt made partition-overwrite and backfill workflows everyday practice.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "Build and swap gives you",
          consLabel: "What it costs",
          pros: [
            "Serving traffic isolated from batch load",
            "All-or-nothing visibility: no half-updated reads",
            "Rollback by switching versions, in seconds",
            "Retries and speculative tasks can't create duplicates",
          ],
          cons: [
            "Data is only as fresh as the last run (often hours)",
            "Rebuilding everything wastes work when little changed",
            "Storage for at least two full versions",
            "The serving store must support bulk loading of read-only files",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>In "design a recommendations pipeline", the publishing step is where many candidates hand-wave. A strong answer: build versioned, immutable output (per-partition files sorted by key), validate it against the previous version, bulk-load it into the serving tier, flip readers atomically, keep the last few versions for rollback, and never write to the live store from inside tasks.</p>`,
        },
        {
          type: "quiz",
          q: "A Spark job writes recommendations directly into a production Cassandra cluster through its client library, and one task fails and is retried. Which problems does this cause that \"write files, then swap\" avoids?",
          options: [
            "None worth worrying about: Cassandra writes are upserts, so a retry is harmless",
            "Readers see a mix of old and new results while the job runs, the retry can duplicate any writes that aren't full overwrites, and the job's write load competes with live traffic",
            "The retry fails, because Cassandra rejects writes to keys that already exist",
            "Only that the job takes a little longer to finish",
          ],
          answer: 1,
          explain: "Upserts make a retry harmless only if every write fully overwrites a row; appending to a list or incrementing a counter is not idempotent. Even then, readers see a mix of old and new data mid-job and the database absorbs batch-scale write load, which is why the first option is tempting but wrong. Cassandra doesn't reject existing keys: an insert simply overwrites. Building immutable output and switching atomically avoids all three problems.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 7
    {
      id: "hadoop-vs-mpp",
      title: "Why Hadoop spread alongside MPP databases (and why it loves disks)",
      kicker: "Context",
      concepts: ["mpp-database", "data-lake", "task-preemption"],
      blocks: [
        {
          type: "problem",
          html: `<p>It's 2008, and your company already owns an MPP warehouse that runs SQL joins across 100 nodes beautifully. But the data you most want to analyze doesn't fit it: clickstream JSON whose format changes every sprint, crawled HTML, images, the output of a C++ feature extractor. Each new source needs a schema, an import job and weeks of the data team's time, and the machine-learning and image code can't be written in SQL at all. Worse, the warehouse restarts a query from scratch when a node dies. That's fine for a five-minute query and hopeless for a six-hour job of 2,000 tasks on a shared cluster where low-priority tasks are routinely evicted.</p>
<p>Meanwhile, database pioneers were calling MapReduce "a major step backwards", and a 2009 benchmark found parallel databases faster on most analytic tasks. Both camps had a point. So what was Hadoop actually for, and why does it write everything to disk?</p>`,
        },
        {
          type: "idea",
          html: `<p>Hadoop is less a database than a general-purpose <strong>operating system for data</strong>: any file format, any code, many engines over the same files. Its disk-heavy, task-level fault tolerance was priced for shared clusters where low-priority batch tasks get killed all the time.</p>`,
        },
        {
          type: "text",
          html: `<h3>MPP databases: fast, integrated and picky</h3>
<p><strong>Massively parallel processing (MPP)</strong> databases such as Teradata, Greenplum and Vertica were already running analytic SQL across shared-nothing clusters when Hadoop appeared. Storage layout, query planner, scheduler and executor are one product, tuned together, so the queries they target run very fast, and SQL opens them to analysts and BI tools.</p>
<h3>Diversity of storage: dump first, model later</h3>
<p>A database insists that data fit its model (tables, documents) and its own storage format, so every source needs careful modeling and an import before anyone can query it. HDFS files are just bytes, in any encoding. Organizations could therefore copy raw data into one place first and decide how to interpret it later, an approach called a <strong>data lake</strong> or enterprise data hub. It moves the burden of interpretation from the producer to the consumer: schema-on-read, from Chapter 2. The argument, nicknamed the "sushi principle", is that raw data is better: you can't foresee every future question, and collecting data quickly beats waiting for a perfect warehouse schema.</p>
<p>In practice Hadoop often became the ETL stage in front of the warehouse: raw dumps land in HDFS, MapReduce jobs clean and reshape them, and the results are loaded into the MPP database.</p>`,
        },
        {
          type: "diagram",
          title: "A data lake: collect first, model later",
          svg: `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four kinds of sources flow unchanged into a raw zone on HDFS or object storage; batch ETL jobs read the raw zone and produce a warehouse, ML training data and a search index">
<defs><marker id="ch10d2-lake-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="12" y="8" width="88" height="40" rx="7" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="56" y="25" text-anchor="middle" font-size="12">OLTP DB</text>
<text x="56" y="41" text-anchor="middle" font-size="12">dumps</text>
<rect x="108" y="8" width="88" height="40" rx="7" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="152" y="25" text-anchor="middle" font-size="12">server</text>
<text x="152" y="41" text-anchor="middle" font-size="12">logs</text>
<rect x="204" y="8" width="88" height="40" rx="7" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="248" y="25" text-anchor="middle" font-size="12">user</text>
<text x="248" y="41" text-anchor="middle" font-size="12">events</text>
<rect x="300" y="8" width="88" height="40" rx="7" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="344" y="25" text-anchor="middle" font-size="12">third-party</text>
<text x="344" y="41" text-anchor="middle" font-size="12">files</text>
<path d="M56,48 L56,84" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<path d="M152,48 L152,84" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<path d="M248,48 L248,84" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<path d="M344,48 L344,84" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<rect x="12" y="86" width="376" height="54" rx="10" stroke-width="1.6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="200" y="108" text-anchor="middle" font-size="12" font-weight="700">raw zone: HDFS or object store</text>
<text x="200" y="127" text-anchor="middle" font-size="12">any format · stored as is · schema-on-read</text>
<path d="M200,140 L200,166" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<rect x="90" y="168" width="220" height="40" rx="8" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="200" y="185" text-anchor="middle" font-size="12" font-weight="700">batch ETL jobs</text>
<text x="200" y="201" text-anchor="middle" font-size="12">MapReduce, later Spark</text>
<path d="M150,208 L76,246" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<path d="M200,208 L200,246" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<path d="M250,208 L324,246" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-lake-arr)"/>
<rect x="12" y="248" width="116" height="44" rx="8" stroke-width="1.6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="70" y="266" text-anchor="middle" font-size="12" font-weight="700">MPP warehouse</text>
<text x="70" y="283" text-anchor="middle" font-size="12">SQL, BI tools</text>
<rect x="142" y="248" width="116" height="44" rx="8" stroke-width="1.6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="200" y="266" text-anchor="middle" font-size="12" font-weight="700">ML training</text>
<text x="200" y="283" text-anchor="middle" font-size="12">features, models</text>
<rect x="272" y="248" width="116" height="44" rx="8" stroke-width="1.6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="330" y="266" text-anchor="middle" font-size="12" font-weight="700">search index</text>
<text x="330" y="283" text-anchor="middle" font-size="12">built offline</text>
</svg>`,
          caption: "Producers dump data as is; nobody has to agree on a schema before it lands. Each consumer imposes its own interpretation when it reads, and the warehouse becomes one consumer among several.",
        },
        {
          type: "text",
          html: `<h3>Diversity of processing: not everything is SQL</h3>
<p>SQL covers a lot, but not ranking models, recommendation systems, full-text indexes with relevance scoring, or image analysis. Those need general-purpose code and libraries. MapReduce let engineers run arbitrary code over huge datasets, and SQL arrived on top later, when Hive compiled queries into MapReduce jobs. Because the storage layer was just files, other engines moved onto the same cluster and the same data: Spark, graph processors, HBase (a BigTable-style store for random reads and writes) and Impala (MPP-style SQL). Nobody had to copy petabytes between specialized systems.</p>`,
        },
        {
          type: "compare",
          title: "Two answers to large-scale analytics",
          items: [
            {
              title: "MPP database",
              tone: "info",
              html: "<ul><li>Data modeled and imported up front</li><li>SQL only; UDFs awkward</li><li>Tightly integrated and highly optimized</li><li>A node failure aborts the query</li><li>Keeps data in memory where it can</li></ul>",
            },
            {
              title: "Hadoop: HDFS, MapReduce and friends",
              tone: "info",
              html: "<ul><li>Any bytes, any format; schema-on-read</li><li>Arbitrary code, plus SQL engines on top</li><li>Many engines share one cluster and one copy of the files</li><li>A failure retries one task</li><li>Writes eagerly to disk</li></ul>",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Designing for frequent faults</h3>
<p>The two camps also fail differently. An MPP database that loses a node mid-query usually aborts and reruns the whole query, which is reasonable when queries take seconds or minutes, and it keeps as much as it can in memory (hash joins, for example). MapReduce retries individual tasks and writes intermediate data eagerly to disk, partly so retries are cheap and partly because it assumes the data won't fit in memory anyway.</p>
<p>But machines rarely crash, so why pay for all that I/O? The answer is the environment MapReduce was built for. Google's datacenters run production services and batch jobs on the same machines, isolated by containers and resource limits and ranked by <strong>priority</strong>. Batch work runs at low priority on whatever the services leave over, and it is <strong>preempted</strong> whenever a higher-priority task needs the resources. That lets the cluster overcommit and run at high utilization. According to the book, a MapReduce task running for an hour at Google had roughly a 5% chance of being killed this way, more than ten times the rate of failures from hardware faults and reboots.</p>
<p>Now multiply. At that rate a ten-minute task is killed with probability p ≈ 0.85%. A job finishes untouched only if every one of its n tasks survives, so the chance that at least one dies is 1 − (1 − p)<sup>n</sup>. It is the same formula as tail-latency amplification in Chapter 1, where one slow backend out of many slows the whole request.</p>`,
        },
        {
          type: "table",
          title: "How quickly \"some task gets killed\" becomes a certainty",
          headers: ["Tasks in job (10 min each, 5%/hour preemption)", "P(at least one task killed)"],
          rows: [
            ["1", "0.85%"],
            ["10", "8%"],
            ["100", "57%"],
            ["500", "99%"],
          ],
          note: "Per task, p = 1 − 0.95<sup>10/60</sup> ≈ 0.85%; for the job, P = 1 − (1 − p)<sup>n</sup>. Same formula as fan-out tail latency in Chapter 1.",
        },
        {
          type: "diagram",
          title: "The job-level kill probability",
          svg: `<svg viewBox="0 0 400 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Curve of the probability that at least one task is killed against the number of ten-minute tasks on a log scale: 8% at 10 tasks, 57% at 100 and 99% at 500, crossing 50% at about 80 tasks">
<text x="8" y="14" font-size="12" font-weight="700">P(at least one task killed)</text>
<line x1="56" y1="30" x2="380" y2="30" stroke-width="1" style="stroke: var(--viz-grid)"/>
<line x1="56" y1="130" x2="380" y2="130" stroke-width="1.4" stroke-dasharray="5 4" style="stroke: var(--viz-muted)"/>
<text x="62" y="123" font-size="12" style="fill: var(--viz-muted)">50%: more likely than not</text>
<line x1="56" y1="230" x2="380" y2="230" stroke-width="1.4" style="stroke: var(--viz-line)"/>
<line x1="56" y1="30" x2="56" y2="230" stroke-width="1.4" style="stroke: var(--viz-line)"/>
<text x="50" y="34" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">100%</text>
<text x="50" y="134" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">50%</text>
<text x="50" y="234" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">0%</text>
<line x1="176" y1="230" x2="176" y2="235" style="stroke: var(--viz-line)"/>
<line x1="296" y1="230" x2="296" y2="235" style="stroke: var(--viz-line)"/>
<line x1="380" y1="230" x2="380" y2="235" style="stroke: var(--viz-line)"/>
<text x="56" y="248" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">1</text>
<text x="176" y="248" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">10</text>
<text x="296" y="248" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">100</text>
<text x="380" y="248" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">500</text>
<text x="218" y="265" text-anchor="middle" font-size="12">tasks in the job (10 min each, log scale)</text>
<polyline points="56,228.3 92.1,226.6 139.9,221.6 176,213.6 212.2,198.6 233.3,184.8 260,160.4 277.5,139.9 296.1,115.1 317.2,85.5 332.2,66.2 353.4,45.4 380,32.8" stroke-width="2.4" style="fill: none; stroke: var(--viz-bad)"/>
<circle cx="176" cy="213.6" r="4" style="fill: var(--viz-bad); stroke: none"/>
<circle cx="296.1" cy="115.1" r="4" style="fill: var(--viz-bad); stroke: none"/>
<circle cx="380" cy="32.8" r="4" style="fill: var(--viz-bad); stroke: none"/>
<text x="168" y="205" text-anchor="end" font-size="12" font-weight="700">10 tasks: 8%</text>
<text x="304" y="121" font-size="12" font-weight="700">100 tasks: 57%</text>
<text x="372" y="22" text-anchor="end" font-size="12" font-weight="700">500 tasks: 99%</text>
</svg>`,
          caption: "The curve crosses 50% at about 80 tasks. A job that restarts from scratch whenever any task dies would rarely finish; one that retries only the killed task barely notices.",
        },
        {
          type: "text",
          html: `<p>With hundreds of tasks, some task almost certainly dies, so recovery must happen per task, and per-task recovery needs intermediate data to survive somewhere durable. That, more than hardware failure, is why MapReduce leans on disks. When the book was written, open-source schedulers preempted far less: YARN's CapacityScheduler preempted to rebalance queues, but general priority preemption wasn't supported in YARN, Mesos or Kubernetes. On clusters where tasks rarely die, MapReduce's caution is mostly wasted, which is the opening that the dataflow engines of the next section exploit.</p>
<h3>The great benchmark argument</h3>
<p>The debate got heated. DeWitt and Stonebraker's 2008 post attacked MapReduce for ignoring decades of database research. Pavlo and colleagues (SIGMOD 2009) benchmarked Hadoop against parallel databases: once data was loaded, the databases were faster on most tasks, but loading and tuning them took much longer. Dean and Ghemawat replied (CACM 2010) that MapReduce's value lay in flexibility, fault tolerance and working directly on raw, heterogeneous data. Each side was right about different things, and the systems have converged since: Impala, Presto/Trino, Hive LLAP and Spark SQL brought columnar storage and vectorized, pipelined execution into the Hadoop world, while MPP databases became more programmable. The last section of this chapter follows that story.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          html: `<p>MapReduce's "wasteful" disk writes are insurance, priced for a world where your tasks are routinely evicted. Change the eviction rate and the right design changes: that is why Spark could keep more in memory on dedicated clusters, and why clusters built on spot instances still value task-level recovery.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "The MapReduce vs. parallel DB debate",
              year: "2008–2010",
              html: "<em>MapReduce: A major step backwards</em> (DeWitt and Stonebraker, blog post, January 2008). <em>A Comparison of Approaches to Large-Scale Data Analysis</em> (Pavlo et al., SIGMOD 2009) found parallel databases such as Vertica faster than Hadoop on most tasks but much slower to load. Dean and Ghemawat answered with <em>MapReduce: A Flexible Data Processing Tool</em> (CACM, January 2010).",
            },
            {
              org: "Google Borg",
              year: "2015",
              tag: "priorities and preemption",
              html: "The EuroSys 2015 paper <em>Large-scale cluster management at Google with Borg</em> describes production (latency-sensitive) and non-production (batch) work sharing the same machines, with lower-priority tasks preempted to free resources for higher-priority ones.",
            },
            {
              org: "Facebook Hive",
              year: "2008",
              tag: "SQL on Hadoop",
              html: "Facebook built Hive to give analysts SQL over its Hadoop data and open-sourced it in 2008 (VLDB 2009 paper). In 2014 its engineering blog described scaling the Hive-based warehouse to about 300 PB.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Kubernetes added pod priority and preemption (GA in 1.14, 2019), and Spark runs natively on Kubernetes (GA in Spark 3.1). Meanwhile the Hadoop vendor market consolidated: Cloudera and Hortonworks merged in January 2019, and HPE bought MapR's business the same year, as workloads moved to cloud object storage, cloud warehouses (Snowflake, BigQuery) and "lakehouses" (Spark or Trino over Iceberg or Delta tables). The data-lake idea won; HDFS, mostly, did not. And preemption came back as a product: AWS Spot Instances get a two-minute interruption notice and Google Cloud preemptible VMs 30 seconds (and at most 24 hours of runtime), so batch engines on cheap capacity still depend on task-level retry.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "The Hadoop approach",
          consLabel: "What it costs",
          pros: [
            "Load raw data immediately; model it later",
            "Run arbitrary code (ML, indexing, image processing) as well as SQL",
            "One cluster, many engines, one copy of the data",
            "Survives frequent task kills, enabling high-utilization shared clusters",
          ],
          cons: [
            "Slower than a tuned MPP database for plain SQL analytics",
            "Schema-on-read pushes data-quality problems onto every consumer (the \"data swamp\")",
            "Eager disk writes cost I/O when failures are rare",
            "Many moving parts to operate",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Asked "why does MapReduce write intermediate data to disk?", don't stop at "fault tolerance". Explain the economics: tasks on shared clusters get preempted; with hundreds of tasks the chance that some task dies approaches 1, so recovery must be per task, and per-task recovery needs durable intermediate data. Then note that dataflow engines trade this for lineage-based recomputation, which pays off when failures are rare.</p>`,
        },
        {
          type: "quiz",
          q: "A job has 200 tasks of 30 minutes each, and every running task has a 4% chance per hour of being preempted. Roughly how likely is it that at least one task is killed?",
          options: [
            "About 2%: each task is exposed for only half an hour",
            "About 4%: that's the preemption rate",
            "About 50%",
            "About 98%",
          ],
          answer: 3,
          explain: "Per task, p = 1 − 0.96<sup>0.5</sup> ≈ 2%. For the job, 1 − 0.98<sup>200</sup> ≈ 1 − e<sup>−4</sup> ≈ 98%. The first two options confuse a single task's risk (or the hourly rate) with the job's: the risk compounds across every task. A design that restarts the whole job on any failure would almost never finish, so task-level retry is mandatory.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 8
    {
      id: "dataflow-engines",
      title: "Beyond MapReduce: stop writing every step to disk",
      kicker: "Dataflow engines",
      concepts: ["materialization-of-intermediate-state", "dataflow-engines", "lineage-recovery", "deterministic-operators", "narrow-wide-dependencies"],
      blocks: [
        {
          type: "problem",
          html: `<p>As the section on batch outputs noted, a recommendation workflow can be 50 to 100 chained MapReduce jobs. Each job writes its entire output to HDFS, replicated three times, only for the next job to read it straight back. Each job waits for the slowest task of the job before it. Many mappers do nothing but re-read a reducer's output and re-key it for the next shuffle, and every task starts a fresh JVM. For an iterative algorithm that loops dozens of times, this overhead dwarfs the useful work.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat the whole workflow as <strong>one job</strong>, a DAG of operators. Then the engine can pipeline data between steps, keep intermediate state in memory or on local disk, sort only where it's needed, and rebuild lost data by recomputing it from its recorded <strong>lineage</strong>.</p>`,
        },
        {
          type: "text",
          html: `<h3>The price of materialization</h3>
<p>Writing intermediate state out to files is called <strong>materialization</strong>. It's worth it when the output is a dataset other teams will reuse, and wasteful when the files exist only to feed the next job in the same workflow. Unix pipes take the opposite approach: they stream data through a small in-memory buffer and never materialize it. MapReduce's full materialization costs three things:</p>
<ol>
<li><strong>Hard barriers.</strong> A job can start only when every task of the job before it has finished, so one straggler delays the whole chain.</li>
<li><strong>Redundant mappers.</strong> A mapper often just reads back what a reducer wrote and prepares it for the next partition-and-sort, work the reducer could have done itself.</li>
<li><strong>Replicated temporary data.</strong> Intermediate files get three HDFS replicas, overkill for data deleted an hour later.</li>
</ol>`,
        },
        {
          type: "analogy",
          html: `<p>MapReduce is a shell pipeline in which every command writes its full output to a temporary file, the file is photocopied three times for safety, and the next command can't start until the copying is done. A dataflow engine is the real pipe: data flows to the next stage as it's produced.</p>`,
        },
        {
          type: "text",
          html: `<h3>Dataflow engines</h3>
<p><strong>Spark</strong>, <strong>Tez</strong> and <strong>Flink</strong>, inspired by the research systems Dryad and Nephele, handle an entire workflow as one job. Like MapReduce, they call a user function one record at a time on a single thread per partition, and move data across the network between functions. Unlike MapReduce, those functions, called <strong>operators</strong>, can be wired into any DAG instead of strict map-then-reduce alternation. One operator's output reaches the next in one of three ways:</p>
<ul>
<li><strong>Repartition and sort</strong> by key, as MapReduce always does: needed for sort-merge joins and sort-based grouping.</li>
<li><strong>Repartition without sorting</strong>: enough for partitioned hash joins and hash aggregation, since a hash table scrambles the order anyway.</li>
<li><strong>Broadcast</strong> the same output to every partition: the small side of a broadcast hash join.</li>
</ul>
<p>Spark names the same split by dependency type. With a <strong>narrow dependency</strong> (map, filter, union, a join of inputs already partitioned the same way), each output partition reads a bounded set of input partitions, usually one, so chains of narrow operators are fused into a single task. A <strong>wide dependency</strong> (groupByKey, reduceByKey, repartition, a join of inputs that aren't co-partitioned) needs a shuffle, and every shuffle is a <strong>stage boundary</strong>.</p>`,
        },
        {
          type: "diagram",
          title: "Two shapes of the same workflow",
          svg: `<svg viewBox="0 0 400 410" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: three chained MapReduce jobs, each map and reduce followed by a three-way replicated HDFS write and a map that re-reads it. Bottom: one dataflow DAG where scan, filter and map are fused, a hash aggregate and broadcast join follow, a global sort needs a sorted repartition, and only the final output is replicated.">
<defs><marker id="ch10d2-dag-arr" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="8" y="14" font-size="12" font-weight="700">MapReduce: three chained jobs</text>
<text x="49" y="32" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">job 1</text>
<text x="199" y="32" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">job 2</text>
<text x="349" y="32" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">job 3</text>
<rect x="8" y="40" width="36" height="32" rx="5" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="26" y="61" text-anchor="middle" font-size="13" font-weight="700">M</text>
<path d="M44,56 L53,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="54" y="40" width="36" height="32" rx="5" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="72" y="61" text-anchor="middle" font-size="13" font-weight="700">R</text>
<path d="M90,56 L99,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<path d="M100,46 L100,68 A24,6 0 0 0 148,68 L148,46" stroke-width="1.6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<ellipse cx="124" cy="46" rx="24" ry="6" stroke-width="1.6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="124" y="67" text-anchor="middle" font-size="12" font-weight="700">×3</text>
<path d="M148,56 L157,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="158" y="40" width="36" height="32" rx="5" stroke-width="1.6" stroke-dasharray="4 3" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="176" y="61" text-anchor="middle" font-size="13" font-weight="700">M</text>
<path d="M194,56 L203,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="204" y="40" width="36" height="32" rx="5" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="222" y="61" text-anchor="middle" font-size="13" font-weight="700">R</text>
<path d="M240,56 L249,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<path d="M250,46 L250,68 A24,6 0 0 0 298,68 L298,46" stroke-width="1.6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<ellipse cx="274" cy="46" rx="24" ry="6" stroke-width="1.6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="274" y="67" text-anchor="middle" font-size="12" font-weight="700">×3</text>
<path d="M298,56 L307,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="308" y="40" width="36" height="32" rx="5" stroke-width="1.6" stroke-dasharray="4 3" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="326" y="61" text-anchor="middle" font-size="13" font-weight="700">M</text>
<path d="M344,56 L353,56" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="354" y="40" width="36" height="32" rx="5" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="372" y="61" text-anchor="middle" font-size="13" font-weight="700">R</text>
<text x="124" y="90" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">HDFS</text>
<text x="176" y="90" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">re-read</text>
<text x="274" y="90" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">HDFS</text>
<text x="326" y="90" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">re-read</text>
<text x="200" y="110" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">each job waits for the slowest task of the one before</text>
<line x1="8" y1="124" x2="392" y2="124" stroke-width="1" stroke-dasharray="4 4" style="stroke: var(--viz-grid)"/>
<text x="8" y="146" font-size="12" font-weight="700">Dataflow engine: one job, one DAG</text>
<rect x="8" y="156" width="170" height="40" rx="7" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="93" y="173" text-anchor="middle" font-size="12" font-weight="700">scan → filter → map</text>
<text x="93" y="189" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">fused into one task</text>
<rect x="230" y="156" width="162" height="40" rx="7" stroke-width="1.6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="311" y="173" text-anchor="middle" font-size="12" font-weight="700">page titles</text>
<text x="311" y="189" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">small table</text>
<path d="M93,196 L93,230" stroke-width="1.6" style="fill: none; stroke: var(--viz-ink)" marker-end="url(#ch10d2-dag-arr)"/>
<path d="M311,196 L311,230" stroke-width="2.2" stroke-dasharray="1.5 4" stroke-linecap="round" style="fill: none; stroke: var(--viz-ink)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="8" y="232" width="170" height="40" rx="7" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="93" y="249" text-anchor="middle" font-size="12" font-weight="700">hash aggregate</text>
<text x="93" y="265" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">count per page</text>
<path d="M178,252 L228,252" stroke-width="1.2" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="230" y="232" width="162" height="40" rx="7" stroke-width="1.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="311" y="249" text-anchor="middle" font-size="12" font-weight="700">broadcast join</text>
<text x="311" y="265" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">adds titles</text>
<path d="M311,272 L311,306" stroke-width="3.4" style="fill: none; stroke: var(--viz-ink)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="230" y="308" width="162" height="40" rx="7" stroke-width="1.6" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="311" y="325" text-anchor="middle" font-size="12" font-weight="700">sort by count</text>
<text x="311" y="341" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">global ranking</text>
<path d="M230,328 L180,328" stroke-width="1.2" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-dag-arr)"/>
<rect x="8" y="308" width="170" height="40" rx="7" stroke-width="1.6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="93" y="325" text-anchor="middle" font-size="12" font-weight="700">output: HDFS ×3</text>
<text x="93" y="341" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">the only replicated write</text>
<line x1="8" y1="372" x2="32" y2="372" stroke-width="3.4" style="stroke: var(--viz-ink)"/>
<text x="38" y="376" font-size="12">repartition + sort</text>
<line x1="210" y1="372" x2="234" y2="372" stroke-width="1.6" style="stroke: var(--viz-ink)"/>
<text x="240" y="376" font-size="12">repartition only</text>
<line x1="8" y1="396" x2="32" y2="396" stroke-width="2.2" stroke-dasharray="1.5 4" stroke-linecap="round" style="stroke: var(--viz-ink)"/>
<text x="38" y="400" font-size="12">broadcast</text>
<line x1="210" y1="396" x2="234" y2="396" stroke-width="1.2" style="stroke: var(--viz-muted)"/>
<text x="240" y="400" font-size="12">local: no exchange</text>
</svg>`,
          caption: "Top: three chained jobs write two intermediate outputs to HDFS, each replicated three times, and spend two whole map phases (dashed) re-reading them. Bottom: the same work as one DAG. Narrow steps are fused, only the aggregate and the global sort repartition data, only the sort needs sorted input, the small table is broadcast, and only the final output is replicated.",
        },
        {
          type: "text",
          html: `<h3>What the whole-DAG view buys</h3>
<ul>
<li>Sorting happens only where an operator needs it, not after every map.</li>
<li>No redundant map stages: work that doesn't change the partitioning is fused into the previous operator.</li>
<li>The scheduler sees the whole DAG, so it can run a consumer on the same machine as its producer and hand data over in memory rather than across the network.</li>
<li>Intermediate state stays in memory or on local disk. MapReduce already did this for map output; dataflow engines do it everywhere.</li>
<li>Executor processes are reused across tasks instead of starting a JVM per task.</li>
<li>Operators can start as soon as their input is ready, with one caveat.</li>
</ul>
<p>The caveat: Spark pipelines operators <em>within</em> a stage, but across a shuffle the child stage starts only after the parent stage has written all its shuffle files to local disk. Flink can stream records across an exchange (pipelined exchanges), and Tez can start consumers early with slow start. Pipelining across exchanges has a price at recovery time, though: with nothing materialized in between, a failure restarts every task connected to the failed one through pipelined exchanges (Flink calls this set a <strong>pipelined region</strong>), and with all-to-all shuffles that can be the whole job. That is why Flink's batch execution mode materializes data at shuffle boundaries by default and reruns only the affected stages, while its streaming mode restarts from checkpoints. Either way, most of the win over chained MapReduce comes from skipping replicated intermediate writes, redundant map stages and per-job start-up. Since the engines implement the same operators, Pig, Hive and Cascading workflows could move from MapReduce to Tez or Spark with a configuration change. Tez is a thin library that relies on YARN's shuffle service; Spark and Flink are large frameworks with their own network layer, scheduler and APIs.</p>
<p>The visualization runs one workload, top URLs per country, through both kinds of engine on the same four machines plus a spare (illustrative minutes). The exchange switch compares Flink-style pipelining with Spark-style stage-by-stage execution; the toggles add a straggler, kill a machine and make one operator nondeterministic.</p>`,
        },
        {
          type: "viz",
          id: "ch10/materialize-vs-pipeline",
          title: "Materialize or pipeline?",
          caption: "Try the defaults first: compare the finish times (44 vs 26 minutes) and the GB written to HDFS ×3 stat (MR 603 vs DF 3). Switch the exchange to Stage by stage and notice the dataflow engine only slows to 29 minutes. Then turn on Machine W2 dies: MapReduce reruns 2 tasks from job 1's output in HDFS, while the stage-by-stage engine recomputes only W2's partition from the original input. Switch back to Pipelined: nothing was kept between operators, so all 12 tasks restart. Finally return to Stage by stage, turn on Count operator is nondeterministic, and watch three finished top-k tasks get discarded. All times are illustrative.",
        },
        {
          type: "text",
          html: `<h3>Fault tolerance without materialization</h3>
<p>The visualization shows the bargain: skipping materialization makes the happy path fast and recovery expensive. When a machine dies, the intermediate data it held is gone, so the engine rebuilds it from an earlier stage that is still available or, in the worst case, from the original input on HDFS. That requires knowing how every piece of data was produced. Spark's resilient distributed datasets (RDDs) record this <strong>lineage</strong>: which input partitions and operators produced each partition. A partition lost behind narrow dependencies is recomputed from its parent partition alone; lost shuffle output makes the parent stage's missing map tasks run again (Spark sees a fetch failure and resubmits them). Flink's batch mode similarly backtracks to the latest stage whose output still exists; its streaming mode instead restores periodic checkpoints of operator state.</p>
<p>Recomputation is safe only if it reproduces the same data. If the recomputed partition differs from the lost one and downstream operators already consumed the old version, the two contradict each other, so the engine must kill and rerun that downstream work too. Operators therefore need to be <strong>deterministic</strong>: same input, same output.</p>
<p>Recomputing isn't always the right call. If intermediate data is much smaller than its source, or expensive to compute, materializing it is cheaper, and long lineage chains in iterative jobs are checkpointed periodically for the same reason. Pipelining has a limit too: a sort can't emit anything until it has seen its last input record, which might have the smallest key, so sorting operators must accumulate state. Everything else can stream.</p>
<p>Some things stay the same. Final outputs are still written durably, usually to the distributed filesystem; inputs are still immutable; outputs are still replaced wholesale. All the savings are in the intermediate state. And Spark is not "in-memory only": shuffle output goes to local disk, as MapReduce's map output does, caching is opt-in, and data spills to disk when memory runs short.</p>`,
        },
        {
          type: "callout",
          tone: "warning",
          title: "Nondeterminism creeps in silently",
          html: `<p>Iterating over a hash map, sampling with an unseeded random generator, calling <code>now()</code>, or reading from an external service inside a transformation: any of these can make a recomputed partition differ from the original and corrupt results after a machine failure. Seed randomness per partition, sort before anything order-dependent, and pass timestamps in as parameters.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache Spark: the RDD paper",
              year: "2012",
              tag: "lineage",
              html: "<em>Resilient Distributed Datasets</em> (NSDI 2012) introduced lineage-based recovery: lost partitions are recomputed from the transformations that produced them instead of being replicated up front. The paper reports up to 20× speedups over Hadoop for iterative applications.",
            },
            {
              org: "Databricks: Sort Benchmark",
              year: "2014",
              html: "Spark sorted 100 TB in 23 minutes on 206 EC2 machines, against the previous Hadoop MapReduce record of 72 minutes on 2,100 machines: about 3× faster on a tenth of the machines. It tied for the 2014 Daytona GraySort record.",
            },
            {
              org: "Apache Hive on Tez",
              tag: "same query, new engine",
              html: "For years Hive's engine was a setting (<code>hive.execution.engine</code> = <code>mr</code>, <code>tez</code> or <code>spark</code>), so the same HiveQL moved from MapReduce to a dataflow engine without rewriting. Newer Hive releases focus on Tez: Hive-on-Spark was removed in Hive 4 and the MapReduce engine is deprecated.",
            },
            {
              org: "Apache Spark: SPARK-23207",
              tag: "nondeterminism bug",
              html: "A correctness bug: <code>repartition()</code> assigns rows round-robin, so its output depends on input order, and after a shuffle fetch failure the retried tasks could produce duplicated or missing rows. The fix made the partitioning deterministic by sorting first; later releases also track indeterminate stages and rerun everything downstream of them on retry.",
            },
            {
              org: "Google Cloud Dataflow and Apache Beam",
              year: "2014",
              html: "Google's internal successors to MapReduce (FlumeJava, MillWheel) became Cloud Dataflow, announced in 2014, when Google said it had largely moved on from MapReduce internally. Its SDK became Apache Beam in 2016.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The shuffle became a service of its own. LinkedIn's push-based shuffle (Magnet, VLDB 2020) ships in Spark 3.2, and remote shuffle services such as Apache Celeborn and Apache Uniffle keep shuffle data off executors, so losing a machine doesn't lose its shuffle files. Spark's adaptive query execution (added in 3.0, on by default since 3.2) treats each materialized shuffle as a natural point to re-optimize: the barrier MapReduce paid for becomes the moment to re-plan with real statistics.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "Dataflow engines gain",
          consLabel: "What they pay",
          pros: [
            "No replicated writes of intermediate data",
            "Sorting only where needed; fused operators; no redundant map stages",
            "Pipelining and executor reuse cut latency",
            "Cached datasets make iterative jobs practical",
          ],
          cons: [
            "One failure can trigger a recomputation cascade through the lineage, or restart a whole pipelined region",
            "Safe recovery requires deterministic operators",
            "Memory pressure: spills, out-of-memory errors and GC tuning become your problem",
            "Very long lineages need explicit checkpoints",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>For "why is Spark faster than MapReduce?", give mechanisms, not slogans: no replicated materialization between stages, DAG-wide planning (operator fusion, sorting only where needed), executor reuse, pipelining within stages, and opt-in caching for iteration. Then show depth with the cost side: recovery by lineage recomputation, and the determinism it requires. Saying "because Spark is in-memory" without these qualifications is a red flag.</p>`,
        },
        {
          type: "quiz",
          q: "A Spark stage samples 10% of rows using an unseeded random number generator. A machine dies after some downstream tasks have already consumed part of that stage's output. What is the risk, and what is the fix?",
          options: [
            "No risk: lineage recomputation reproduces exactly the rows that were lost",
            "The recomputed partition can hold a different sample than the one downstream tasks already used, so results become inconsistent; seed the generator deterministically per partition, or checkpoint the sampled data",
            "Spark refuses to recompute operators that use randomness, so the job fails",
            "Only a slower job: Spark restarts the whole application from the beginning",
          ],
          answer: 1,
          explain: "Lineage replays the operator, not its past output. An unseeded generator draws a different sample on the rerun, so downstream work built on the old sample now disagrees with the new data: the engine must rerun that work, or the results are silently corrupted. That's why the first option is tempting but wrong. Spark doesn't inspect your code for randomness, and it recomputes only the lost partitions and what depends on them, not the whole application.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 9
    {
      id: "graph-processing",
      title: "Graphs and iteration: think like a vertex",
      kicker: "Iterative processing",
      concepts: ["iterative-graph-processing"],
      blocks: [
        {
          type: "problem",
          html: `<p>PageRank needs dozens of passes over the web graph, each pushing every page's score along its outgoing links. Plain MapReduce has no loops, so an external driver launches one complete job per iteration. Every job reads the <em>entire</em> graph from HDFS and writes out a whole new copy, even if only a handful of vertices changed since the last round. Thirty iterations means thirty full read-and-write cycles over a graph that may have billions of edges.</p>`,
        },
        {
          type: "idea",
          html: `<p>Keep each vertex's state in memory across iterations, and let vertices exchange <strong>messages</strong> along edges in synchronized rounds called <strong>supersteps</strong>. The framework handles partitioning, message delivery, the barrier between rounds and checkpoints. This is the Pregel, or bulk synchronous parallel (BSP), model.</p>`,
        },
        {
          type: "text",
          html: `<h3>Batch processing over graphs</h3>
<p>The graph databases of Chapter 2 answer questions about a few vertices at a time, such as "who are Lucy's friends?" <strong>Batch graph processing</strong> instead analyzes the whole graph offline: ranking pages, recommending connections, finding connected components. The best-known example is PageRank (Brin and Page, 1998), which estimates a page's importance from the pages that link to it; it was one of the inputs to Google's search ranking.</p>
<p>Many graph algorithms share a shape: join each vertex with its neighbors, propagate some information, and repeat until a condition holds, such as no edges left to follow or changes below a threshold. Chapter 2's transitive closure (every location within North America, found by following "within" edges) is one example. On MapReduce you run such an algorithm as a loop <em>around</em> the framework: a scheduler runs one batch job for one step, checks the completion condition, and if it isn't met, runs the job again. That works, but each step rereads and rewrites the entire dataset.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Two different graphs",
          html: `<p>A Spark job's DAG and a graph-processing job are different kinds of graph. The first is the shape of the <em>computation</em>: operators and the data flowing between them. The second is the shape of the <em>data</em>: vertices and edges. Pregel-style systems are for the second.</p>`,
        },
        {
          type: "text",
          html: `<h3>The Pregel model</h3>
<p>Leslie Valiant described the <strong>bulk synchronous parallel</strong> model in 1990. Google's Pregel paper (2010) popularized it for graphs, and Apache Giraph, Spark's GraphX and Flink's Gelly implement it. In each superstep the framework calls your function once for every active vertex, passing in the messages sent to that vertex during the previous superstep. The vertex updates its own state, sends messages (usually along its edges) and may vote to halt.</p>
<p>That resembles MapReduce, where mappers "send messages" to reducers by key, with one crucial difference: a vertex <strong>remembers</strong> its state in memory between supersteps, so it only processes new messages, and parts of the graph that receive none do no work. It also resembles the actor model with vertices as actors, except that vertex state and messages are fault-tolerant and durable, and communication happens in fixed rounds: a message sent in superstep n is delivered in superstep n + 1, a timing guarantee actors don't give. The visualization below runs PageRank this way on eight pages split across two workers.</p>`,
        },
        {
          type: "steps",
          title: "One Pregel superstep, for PageRank",
          items: [
            "Superstep n: every active vertex receives the messages sent to it in superstep n − 1.",
            "It updates its own state: new rank = 0.15/N + 0.85 × (sum of incoming shares).",
            "It sends a message along each out-edge: its rank divided by its number of out-links.",
            "It may vote to halt; any incoming message wakes it up again.",
            "Barrier: every worker finishes and every message is delivered before superstep n + 1 begins.",
            "Every k supersteps, all vertex state is checkpointed; after a failure, the graph rolls back to it.",
          ],
        },
        {
          type: "viz",
          id: "ch10/pregel-pagerank",
          title: "PageRank, one superstep at a time",
          caption: "Try Step superstep a few times and watch ranks flow along the links: A, with five incoming links, grows, while H, with none, drops to the 0.15/8 baseline (0.019). Switch Partitioning to Link-aware and notice cross-worker messages fall from 11 to 5 per superstep while the final ranks stay identical. Then run with a checkpoint every 2 supersteps, crash worker 2, and compare how many supersteps are redone with checkpoints Off.",
        },
        {
          type: "text",
          html: `<p>Two lessons from the visualization generalize. Partitioning changes cost, not correctness: the ranks are identical under both placements, but hash placement sends most messages across the network. And convergence is a global question. A vertex's vote to halt is purely local, and any incoming message wakes it, so testing "the largest change anywhere is below 0.001" needs an <strong>aggregator</strong>, a global value every vertex can read in the next superstep. The Pregel paper's PageRank example sidesteps the question by running exactly 30 supersteps. Pregel also offers <strong>combiners</strong>, which merge messages bound for the same vertex before they cross the network; that's valid for PageRank because incoming shares are simply added. (Real PageRank must also handle pages without outgoing links, which would leak rank; the demo graph has none.)</p>
<h3>Fault tolerance</h3>
<p>Because vertices never read each other's state and talk only through messages, the framework can send messages in batches, and the only waiting happens at the barrier between supersteps. Even though the underlying network can lose, repeat or hold up packets, Pregel promises that every message is handled exactly once by the vertex it was sent to, in the next superstep. Recovery is coarse: at the end of a superstep, the framework periodically checkpoints every vertex's state to durable storage. When a worker fails, the whole graph rolls back to the last checkpoint and recomputes from there; if the algorithm is deterministic and messages are logged, only the lost partition needs recovering. Frequent checkpoints cost I/O on every run; rare ones throw away more work per crash.</p>
<h3>Parallel execution, and when not to bother</h3>
<p>Vertices are addressed by ID, and the framework decides where each lives, usually by hashing the ID, because finding a partitioning that keeps related vertices together is hard. So many messages cross machines, and message traffic can exceed the size of the graph itself. That overhead is real: when the whole graph fits in one machine's RAM, a single-machine program, sometimes even a single-threaded one, often outruns a distributed framework. If it fits on one machine's disks, systems such as GraphChi can process it there. Distribute only when you must.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Pregel",
              year: "2010",
              tag: "vertex-centric",
              html: "<em>Pregel: A System for Large-Scale Graph Processing</em> (SIGMOD 2010) introduced the superstep model with vote-to-halt, combiners, aggregators and checkpoint-based recovery. The name honors the river Pregel, crossed by Euler's Seven Bridges of Königsberg.",
            },
            {
              org: "Facebook and Apache Giraph",
              year: "2015",
              tag: "a trillion edges",
              html: "<em>One Trillion Edges: Graph Processing at Facebook-Scale</em> (VLDB 2015) describes Facebook's improvements to Apache Giraph to run algorithms such as PageRank on graphs with over a trillion edges.",
            },
            {
              org: "Twitter's Who to Follow",
              year: "2013",
              tag: "one big machine",
              html: "Twitter's first Who-to-Follow service (described at WWW 2013) deliberately kept the entire follow graph in memory on a single server, using its Cassovary library, instead of running a distributed graph system on Hadoop.",
            },
            {
              org: "Scalability! But at what COST?",
              year: "2015",
              tag: "single thread vs cluster",
              html: "McSherry, Isard and Murray (HotOS 2015) showed single-threaded laptop implementations of PageRank and connected components matching or beating published results from distributed graph systems running on many cores, and proposed COST: the cluster size needed to beat one thread.",
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "Pregel-style processing",
          consLabel: "What it costs",
          pros: [
            "Vertex state stays in memory across iterations",
            "Only active vertices do work; quiet regions cost nothing",
            "A simple \"think like a vertex\" programming model",
            "The framework handles message delivery, barriers and recovery",
          ],
          cons: [
            "Barriers make every superstep wait for the slowest worker",
            "Hash placement sends most messages across the network",
            "A failure rolls the whole graph back to a checkpoint",
            "Often slower than one big machine when the graph fits in RAM",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>For "compute PageRank on a huge graph", first ask whether it fits on one machine: adjacency lists for billions of edges can fit in a large server's RAM. If not, describe Pregel-style supersteps (GraphX, Giraph) with partitioning that keeps related vertices together, combiners that pre-sum messages per destination, and checkpoints every few supersteps. Then mention the convergence test (an aggregator or a fixed superstep count) and how dangling pages are handled.</p>`,
        },
        {
          type: "quiz",
          q: "Why does a Pregel job wait at a barrier until every worker has finished superstep n before any vertex starts superstep n + 1?",
          options: [
            "To save memory by running only one worker at a time",
            "So that in superstep n + 1 every vertex sees exactly the messages sent to it in superstep n, which makes results independent of timing and gives a consistent point to checkpoint",
            "Because the network is synchronous, so messages can only be delivered at fixed intervals",
            "To move vertices between workers and rebalance load after every superstep",
          ],
          answer: 1,
          explain: "The barrier defines what \"the messages from the previous superstep\" means. Without it, a vertex might compute with some messages still missing, and the result would depend on timing. It is also where a consistent checkpoint can be taken. The price is that every superstep waits for the slowest worker. The network is not synchronous: the barrier exists precisely to give a synchronous model on top of an asynchronous network. All workers run in parallel, and placement normally stays fixed.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 10
    {
      id: "high-level-apis",
      title: "High-level APIs: declarative where it helps, code where it must",
      kicker: "Convergence",
      concepts: ["high-level-apis", "vectorized-execution"],
      blocks: [
        {
          type: "problem",
          html: `<p>A join in raw MapReduce takes pages of code: tagging mappers, a composite key with a custom partitioner and grouping comparator for the secondary sort, a reducer that relies on the profile record arriving first, and a second job to aggregate. You also choose the join algorithm yourself, so when the "small" table quietly grows, your hand-coded broadcast join starts running out of memory. And because map and reduce functions are opaque callbacks, the engine can't see that you use two of fifty columns, or that the first line of your mapper throws away 99% of rows. It reads everything and calls your function on every record. Productivity and performance both suffer.</p>`,
        },
        {
          type: "idea",
          html: `<p>Express jobs with relational-style operators (join, group, filter, aggregate) so an <strong>optimizer</strong> can choose algorithms and push work down into storage, while keeping escape hatches for arbitrary code. That is what made batch frameworks and MPP databases converge.</p>`,
        },
        {
          type: "code",
          title: "Clicks per URL from New Zealand users, written by hand",
          lang: "pseudocode",
          code: `// Job 1: join clicks with users, keep clicks by NZ users
mapEvents(event):  emit(event.user_id, ("E", event.url))
mapUsers(user):    emit(user.id,       ("U", user.country))

// Needs a custom partitioner and grouping comparator on (user_id, tag)
// so the "U" record arrives first for each user id (secondary sort)
reduce(user_id, values):
    first = values.next()
    if first.tag != "U" or first.country != "NZ":
        return                      // unknown or non-NZ user: drop the clicks
    for v in values:                // everything after it is a click
        emit(v.url, 1)

// Job 2: its input directory is job 1's output directory
map(url, one):      emit(url, one)
reduce(url, ones):  emit(url, sum(ones))    // also valid as a combiner

// ...plus job configuration, input/output formats and a scheduler to chain them`,
        },
        {
          type: "code",
          title: "The same query in Spark",
          lang: "sql / python",
          code: `-- Spark SQL
SELECT url, COUNT(*) AS clicks
FROM events e JOIN users u ON e.user_id = u.id
WHERE u.country = 'NZ'
GROUP BY url

# The same thing with the PySpark DataFrame API
from pyspark.sql import functions as F
nz_users = spark.table("users").where("country = 'NZ'")
clicks = (spark.table("events")
          .join(nz_users, F.col("user_id") == F.col("id"))
          .groupBy("url").count())`,
          caption: "Neither version names a join algorithm, a partitioner or a sort order. Those become the optimizer's decisions.",
        },
        {
          type: "text",
          html: `<h3>From hand-written jobs to high-level languages</h3>
<p>Programming MapReduce directly was laborious enough that higher-level layers appeared almost at once: Hive (SQL), Pig (Pig Latin), Cascading and Crunch. Spark and Flink ship their own high-level dataflow APIs, inspired by Google's FlumeJava. All of them are built from relational building blocks (join on a field, group by key, filter, aggregate), implemented underneath with exactly the join and grouping algorithms from earlier in this chapter. Because they describe <em>what</em> to compute rather than how, they are what let Hive and Pig jobs switch engines without being rewritten, as the dataflow section described. They also made interactive work possible: in a Spark shell or notebook you write a step, run it, look at the output and refine, much like building a Unix pipeline one command at a time.</p>
<h3>Declarative joins let the optimizer choose</h3>
<p>Once a join is declared rather than coded, the engine can pick the algorithm (broadcast, partitioned hash or sort-merge) and the join <strong>order</strong> that keeps intermediate data small, using statistics about the inputs. Hive, Spark and Flink all have cost-based optimizers. You no longer need to memorize which join suits which data: this is Chapter 2's argument for declarative queries, applied to batch jobs. Spark, for example, broadcasts a join input automatically when it estimates its size at under 10 MB (<code>spark.sql.autoBroadcastJoinThreshold</code>).</p>`,
        },
        {
          type: "diagram",
          title: "From SQL to a physical plan",
          svg: `<svg viewBox="0 0 400 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A SQL query becomes a logical plan, the optimizer applies three rewrites (push the filter into the scan, read only needed columns, broadcast the small filtered table), and the result is a physical plan with a vectorized Parquet scan, a broadcast hash join and partial then final hash aggregation around an exchange">
<defs><marker id="ch10d2-plan-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="8" y="8" width="384" height="80" rx="8" stroke-width="1.6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="20" y="28" font-size="12" style="font-family: var(--font-mono)">SELECT url, COUNT(*)</text>
<text x="20" y="44" font-size="12" style="font-family: var(--font-mono)">FROM events e JOIN users u ON e.user_id = u.id</text>
<text x="20" y="60" font-size="12" style="font-family: var(--font-mono)">WHERE u.country = 'NZ'</text>
<text x="20" y="76" font-size="12" style="font-family: var(--font-mono)">GROUP BY url</text>
<path d="M200,88 L200,104" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-plan-arr)"/>
<rect x="8" y="106" width="384" height="106" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="20" y="124" font-size="12" font-weight="700">logical plan: what to compute</text>
<text x="20" y="142" font-size="12" style="font-family: var(--font-mono)">Aggregate: COUNT(*) BY url</text>
<text x="20" y="157" font-size="12" style="font-family: var(--font-mono)">└ Join: e.user_id = u.id</text>
<text x="34" y="172" font-size="12" style="font-family: var(--font-mono)">├ Scan events (all columns)</text>
<text x="34" y="187" font-size="12" style="font-family: var(--font-mono)">└ Filter: u.country = 'NZ'</text>
<text x="48" y="202" font-size="12" style="font-family: var(--font-mono)">└ Scan users (all columns)</text>
<path d="M200,212 L200,226" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-plan-arr)"/>
<rect x="8" y="228" width="384" height="80" rx="8" stroke-width="1.6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="20" y="246" font-size="12" font-weight="700">optimizer rewrites, using statistics</text>
<text x="20" y="264" font-size="12">1. push the filter down into the users scan</text>
<text x="20" y="280" font-size="12">2. read only the 4 columns the query needs</text>
<text x="20" y="296" font-size="12">3. filtered users table is tiny: broadcast it</text>
<path d="M200,308 L200,322" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch10d2-plan-arr)"/>
<rect x="8" y="324" width="384" height="150" rx="8" stroke-width="1.6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="20" y="342" font-size="12" font-weight="700">physical plan: how to run it</text>
<text x="20" y="360" font-size="12" style="font-family: var(--font-mono)">HashAggregate (final, by url)</text>
<text x="20" y="375" font-size="12" style="font-family: var(--font-mono)">└ Exchange: hash(url)</text>
<text x="34" y="390" font-size="12" style="font-family: var(--font-mono)">└ HashAggregate (partial)</text>
<text x="48" y="405" font-size="12" style="font-family: var(--font-mono)">└ <tspan font-weight="700" style="fill: var(--viz-c1)">BroadcastHashJoin</tspan></text>
<text x="62" y="420" font-size="12" style="font-family: var(--font-mono)">├ Scan events.parquet <tspan font-weight="700" style="fill: var(--viz-c1)">[url, user_id]</tspan></text>
<text x="62" y="435" font-size="12" style="font-family: var(--font-mono)">└ BroadcastExchange</text>
<text x="76" y="450" font-size="12" style="font-family: var(--font-mono)">└ Scan users.parquet <tspan font-weight="700" style="fill: var(--viz-c1)">[id, country]</tspan></text>
<text x="90" y="465" font-size="12" font-weight="700" style="font-family: var(--font-mono); fill: var(--viz-c1)">pushed filter: country = 'NZ'</text>
</svg>`,
          caption: "The query says what to compute; the optimizer decides how. Violet marks its three rewrites: the filter pushed into the users scan, only four columns read from Parquet, and a broadcast join because the filtered users table is small. The partial aggregate before the exchange does a combiner's job automatically.",
        },
        {
          type: "text",
          html: `<h3>Not fully declarative, on purpose</h3>
<p>MapReduce's heritage is the function callback, and that freedom matters: a user-defined function (UDF) can call any library for parsing, natural-language processing, image analysis or numerical work. For a long time this set batch frameworks apart from MPP databases, whose UDFs were awkward to write and poorly integrated with package managers such as Maven, npm or RubyGems.</p>
<p>But a callback that only filters rows or picks fields wastes effort: called once per record, it forces the engine to decode every column of every row. Expressed declaratively, the same logic lets the optimizer apply <strong>column pruning</strong> (read only the needed columns from a columnar format like Parquet or ORC, Chapter 3) and <strong>predicate pushdown</strong> (skip whole row groups whose min/max statistics rule out a match). It also opens the door to <strong>vectorized execution</strong>: processing a batch of values from one column in a tight, cache-friendly loop instead of making a function call per record. Some engines go further and generate code for each query: Spark generates JVM bytecode for whole stages, and Impala uses LLVM to generate native code.</p>
<p>The practical lesson: opaque UDFs block all of this. In PySpark, a row-at-a-time Python UDF also ships every row between the JVM and a Python worker process; built-in functions, or Arrow-based pandas UDFs that work on whole batches, avoid most of that cost.</p>
<h3>Convergence and specialization</h3>
<p>The result: batch frameworks gained MPP-like performance while keeping the ability to run arbitrary code over arbitrary formats, and MPP databases became more programmable. Both are now best described as systems for storing and processing data. The same layering supports reusable libraries for common heavy algorithms: machine learning (Mahout on MapReduce, Spark and Flink; MADlib inside MPP databases such as Apache HAWQ), spatial k-nearest-neighbor search, and approximate string matching for genome analysis.</p>`,
        },
        {
          type: "compare",
          title: "What the engine can see",
          items: [
            {
              title: "Declarative operators",
              tone: "ok",
              html: "<p>The optimizer chooses the join algorithm and order, prunes columns, pushes filters into Parquet, vectorizes and compiles inner loops. You get these improvements for free whenever the engine gets better.</p>",
            },
            {
              title: "Opaque callbacks (UDFs)",
              tone: "warn",
              html: "<p>Run any library code you like. But the engine can't see inside, so there's no pushdown or reordering across the function, and you pay per-record call overhead (plus serialization, for Python UDFs).</p>",
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Yahoo! Pig and Facebook Hive",
              year: "2008",
              html: "Pig Latin (SIGMOD 2008) came from Yahoo! Research; Hive came from Facebook and was open-sourced in 2008. Both compiled their languages into chains of MapReduce jobs and later gained Tez (and, for a while, Spark) back ends.",
            },
            {
              org: "Spark SQL and Project Tungsten",
              year: "2015",
              tag: "Catalyst",
              html: "Spark SQL (SIGMOD 2015) introduced the Catalyst optimizer, mostly rule-based at first, with predicate pushdown and column pruning into sources such as Parquet; a cost-based optimizer for join ordering arrived in Spark 2.2. Spark 2.0 (2016) added whole-stage code generation, compiling chains of operators into one generated function.",
            },
            {
              org: "Databricks Photon and Meta Velox",
              year: "2022",
              tag: "vectorized C++",
              html: "Both are vectorized C++ execution engines for analytics. Photon (SIGMOD 2022) accelerates Spark SQL and Delta Lake workloads; Velox is an open-source execution library used inside Presto- and Spark-based systems at Meta.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The convergence the book predicted happened. DataFrames and SQL are now the main Spark interface, and adaptive query execution re-optimizes plans at runtime. Columnar in-memory formats (Apache Arrow) and vectorized engines (Photon, Velox, DataFusion, DuckDB) are mainstream. Warehouses run user code: Snowflake supports Java and Python UDFs, and BigQuery supports JavaScript UDFs and remote functions. "Lakehouse" systems run SQL warehouses directly on open files, and Apache Beam (2016) offers one API for batch and streaming.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "High-level APIs give you",
          consLabel: "What to watch for",
          pros: [
            "Far less code, and analysts can write SQL",
            "The optimizer picks join strategies and order from statistics",
            "Column pruning, predicate pushdown, vectorization, code generation",
            "The same query can move to a new engine unchanged",
          ],
          cons: [
            "Opaque UDFs defeat the optimizer",
            "Bad statistics produce bad plans (for example, a broadcast that runs out of memory)",
            "Debugging means reading query plans",
            "Some algorithms (ML, graphs) still need specialized libraries",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Asked to speed up a slow Spark job, start at the plan (<code>EXPLAIN</code> or the SQL tab of the Spark UI): is the join a broadcast or a sort-merge? Is the filter pushed into the scan, and are only the needed columns read? Is one shuffle partition far larger than the rest (skew)? Are row-at-a-time Python UDFs blocking optimization? Working through that sequence shows you understand both the declarative layer and the physical algorithms underneath it.</p>`,
        },
        {
          type: "quiz",
          q: "Over the same Parquet files, why can Spark read far less data for df.filter(col('country') == 'NZ').select('url') than for rdd.filter(lambda r: r.country == 'NZ').map(lambda r: r.url)?",
          options: [
            "Python lambdas are simply slower than Scala code",
            "The DataFrame expression is declarative, so the optimizer sees which columns and predicates are used and pushes them into the Parquet reader (column pruning, skipping row groups by their statistics); a lambda is an opaque function that must be called on fully decoded rows",
            "RDDs cannot read Parquet files at all",
            "DataFrames always cache their data in memory first",
          ],
          answer: 1,
          explain: "The win is visibility: the optimizer can only push down what it can see. The RDD version must decode every row with every column and call the lambda once per record. Language speed (the tempting first option) is a smaller, separate effect that doesn't change how many bytes are read. RDDs can read Parquet, and DataFrames don't cache unless you ask them to.",
        },
      ],
    },
  ],

  takeaways: [
    "<strong>A batch job is a pure function</strong> over a bounded, immutable input that produces derived output. That discipline is what makes retries, reruns, backfills and rollbacks safe.",
    "<strong>MapReduce is <code>awk | sort | uniq -c</code> spread across a cluster.</strong> You write map and reduce; the framework partitions by key, sorts, moves every record to its reducer (the shuffle) and retries failed tasks.",
    "<strong>A batch join brings records with the same key together.</strong> Reduce-side sort-merge joins work on anything but shuffle everything; broadcast, partitioned and merge joins skip the shuffle when you know the inputs' size, partitioning and sort order, and break when those assumptions turn out to be wrong.",
    "<strong>A stage is only as fast as its slowest task.</strong> Speculative execution fixes slow machines, but hot keys must be split (salting, skewed joins, two-stage aggregation).",
    "<strong>Publish results by building a new immutable dataset and switching readers to it atomically</strong>, never by writing into production databases from inside tasks. The old version is your undo button.",
    "<strong>MapReduce's eager disk writes and task-level retries were priced for clusters where low-priority tasks are preempted constantly.</strong> Dataflow engines (Spark, Flink, Tez) plan the whole workflow as one DAG, skip replicated intermediate writes and redundant map stages, and pipeline where they can, paying instead with lineage recomputation that requires deterministic operators.",
    "<strong>Iterative graph algorithms fit the Pregel model</strong>: vertex state in memory, message-passing supersteps with barriers and checkpoints. But if the graph fits on one machine, one machine is often faster.",
    "<strong>Declarative APIs let optimizers</strong> choose join algorithms, push filters and column selection into storage, and vectorize execution. Batch frameworks and MPP databases have converged into systems for storing and processing data.",
  ],

  connections: [
    { to: "ch1", html: "Throughput versus response time. The job-level failure probability 1 − (1 − p)<sup>n</sup> is the same math as tail-latency amplification in fan-out requests." },
    { to: "ch2", html: "MapReduce as a query mechanism inside document databases, schema-on-read behind data lakes, declarative queries that enable optimizers, and graph data models versus batch graph processing." },
    { to: "ch3", html: "External merge sort, SSTables and LSM compaction are the same sorted-run-and-merge idea as the shuffle. Batch jobs build full-text indexes and fill column-oriented warehouses (Parquet, ORC)." },
    { to: "ch4", html: "Batch inputs and outputs are files, so Avro and Parquet schemas and schema evolution govern how jobs evolve independently: dataflow through files." },
    { to: "ch5", html: "HDFS replicates blocks for durability. Read-only stores swapped in from batch output are a simple, conflict-free kind of replication." },
    { to: "ch6", html: "Hash partitioning by key, hot spots and partition counts are exactly what the shuffle, skewed joins and bucketed map-side joins depend on." },
    { to: "ch7", html: "A batch job's all-or-nothing output commit plays the role of atomicity, and immutable inputs remove most isolation problems." },
    { to: "ch8", html: "Partial failure becomes routine at a thousand machines: task retries, stragglers, preemption, and the reason MapReduce writes to disk. Pregel's superstep barrier recovers a synchronous model on top of an asynchronous network." },
    { to: "ch9", html: "HDFS NameNode high availability relies on an active/standby pair with ZooKeeper-based failover, the kind of coordination service Chapter 9 describes." },
    { to: "ch11", html: "Stream processing is batch processing with an unbounded input. Change data capture feeds database snapshots into batch jobs, and Flink and Beam unify the two models." },
    { to: "ch12", html: "Derived data, reprocessing history, lambda versus kappa architectures, unbundling databases into batch and stream components, and human fault tolerance through immutable inputs." },
  ],

  furtherReading: [
    { title: "Dean and Ghemawat, \"MapReduce: Simplified Data Processing on Large Clusters\" (OSDI 2004)", note: "The original model, its fault-tolerance design, combiners and backup tasks. Short and very readable." },
    { title: "Ghemawat, Gobioff and Leung, \"The Google File System\" (SOSP 2003)", note: "The design HDFS copied: a single master, large chunks, replication and relaxed consistency." },
    { title: "HDFS Architecture (Apache Hadoop documentation)", url: "https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HdfsDesign.html", note: "NameNode and DataNode roles, block replication and rack-aware placement, from the official docs." },
    { title: "Zaharia et al., \"Resilient Distributed Datasets\" (NSDI 2012)", note: "Spark's lineage-based fault tolerance, and why in-memory reuse matters for iterative jobs." },
    { title: "Isard et al., \"Dryad: Distributed Data-Parallel Programs from Sequential Building Blocks\" (EuroSys 2007)", note: "The DAG-of-operators engine that inspired the dataflow generation." },
    { title: "Chambers et al., \"FlumeJava: Easy, Efficient Data-Parallel Pipelines\" (PLDI 2010)", note: "A high-level pipeline API and optimizer over MapReduce; an ancestor of Apache Beam." },
    { title: "Malewicz et al., \"Pregel: A System for Large-Scale Graph Processing\" (SIGMOD 2010)", note: "Vertex-centric supersteps, vote to halt, combiners, aggregators and checkpoint-based recovery." },
    { title: "McSherry, Isard and Murray, \"Scalability! But at what COST?\" (HotOS 2015)", note: "A sobering comparison of distributed graph systems with a single laptop thread." },
    { title: "Sumbaly et al., \"Serving Large-scale Batch Computed Data with Project Voldemort\" (FAST 2012)", note: "How LinkedIn built, shipped, swapped and rolled back batch-computed read-only stores." },
    { title: "Pavlo et al., \"A Comparison of Approaches to Large-Scale Data Analysis\" (SIGMOD 2009)", note: "The MapReduce versus parallel database benchmark; read it together with Dean and Ghemawat's CACM 2010 reply." },
    { title: "Verma et al., \"Large-scale cluster management at Google with Borg\" (EuroSys 2015)", note: "Mixed production and batch clusters, priorities and preemption: the environment MapReduce was designed for." },
    { title: "Spark SQL performance tuning (Apache Spark documentation)", url: "https://spark.apache.org/docs/latest/sql-performance-tuning.html", note: "Join strategy hints, broadcast thresholds and adaptive query execution, which switches join strategies and splits skewed partitions at runtime." },
    { title: "Beauchemin, \"Functional Data Engineering: a modern paradigm for batch data processing\" (2018)", note: "Idempotent, partition-overwriting tasks as the practical form of this chapter's output philosophy." },
  ],
});
