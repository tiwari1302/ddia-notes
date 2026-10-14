// Chapter 10 deep dive, part 1 (hook + why batch through map-side joins).
// Part 2 lives in ch10.deep2.js. Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch10", {
  hook: `<p>It is 1 a.m. at Pebble, a made-up social app with 300 million users. Before the morning traffic peak, the data team has to rebuild two things: the "people you may know" suggestions and a ranking of yesterday's most-viewed pages. The inputs are yesterday's click logs, about <strong>2 TB</strong> of new files, plus a snapshot of the users table.</p>
<p>Do the arithmetic before designing anything. One server streaming from disk at a healthy 200 MB/s needs 2,000,000 MB ÷ 200 MB/s = <strong>10,000 seconds, roughly 2.8 hours</strong>, just to read the logs once. Nothing has been sorted, joined or counted yet, and if the machine reboots at hour two, the clock starts over. Spread the same files across 1,000 machines and each one reads its 2 GB share in about <strong>10 seconds</strong>.</p>
<p>So parallelism isn't an optimization here; it is the only way the job fits into one night. But a thousand machines bring three problems that a single machine never had. How do all the clicks for one user, or one URL, end up on the same machine so they can be counted or joined (<strong>partitioning and the shuffle</strong>)? What happens when machine #617 dies, or is preempted by a more important job, 40 minutes in (<strong>fault tolerance</strong>)? And how do you publish tonight's results without half-written data leaking into the live site (<strong>immutable outputs</strong>)?</p>
<p>The chapter's surprising answer is that the blueprint comes from the 1970s. A Unix one-liner such as <code>awk '{print $7}' | sort | uniq -c</code> already contains the whole design: pull out a key, bring equal keys together by sorting, then aggregate. MapReduce, Spark and Flink are, at heart, ways of running that pipeline on a thousand computers that keep failing.</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "why-batch",
      title: "Batch jobs trade latency for throughput",
      kicker: "Motivation",
      concepts: ["batch-processing"],
      blocks: [
        {
          type: "problem",
          html: `<p>Online systems are tuned to answer one small question quickly: render this profile, add this item to the cart, all within about 50 milliseconds. But many of the most valuable questions need <em>all</em> of the data at once. Which pages were most popular yesterday, broken down by age group? What should tonight's search index over a billion pages contain? Which features go into tomorrow's model training run?</p>
<p>The naive answer is to run these as queries against the production database, or to compute them on demand inside a request. A full scan of several terabytes takes hours, competes with live users for the same disks and CPUs, and gives a slightly different answer every time because rows keep changing underneath it. And if the machine running that scan crashes at hour two, all of that work is lost.</p>`,
        },
        {
          type: "idea",
          html: `<p>Separate whole-dataset computation from live serving. Run a <strong>job</strong> over a <strong>bounded, immutable snapshot</strong> of the input, judge it by <strong>throughput</strong> (how long it takes to crunch a dataset of a given size), and publish what it produces as <strong>derived data</strong> for other systems to read.</p>`,
        },
        {
          type: "text",
          html: `<h3>Three kinds of systems</h3>
<p>It helps to sort data systems by how they meet their inputs:</p>
<ul>
<li><strong>Services (online systems)</strong> wait for a request and answer it as fast as they can. A person or another program is waiting, so they are judged by <strong>response time</strong> and availability. Example: the API behind a product page.</li>
<li><strong>Batch processing systems (offline systems)</strong> take a large input that already exists, run a job over all of it, and produce an output. A job may take minutes or days, nobody waits on any single record, and it usually runs on a schedule, such as nightly or hourly. They are judged by <strong>throughput</strong>. Example: rebuilding a search index every night.</li>
<li><strong>Stream processors (near-real-time systems)</strong> sit in between. Like batch jobs, they consume inputs and produce outputs instead of answering requests, but they handle each event shortly after it happens, and their input never ends. Example: flagging a suspicious card payment seconds after the swipe. Streams are Chapter 11's subject.</li>
</ul>`,
        },
        {
          type: "diagram",
          title: "Three ways to meet your input",
          svg: `<svg viewBox="0 0 400 336" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three rows: an online service answering client requests, a batch job turning bounded input files into derived output, and a stream processor consuming an endless flow of events">
  <defs>
    <marker id="c10d-tk-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="12" y="22" font-size="13" font-weight="700">Online service</text>
  <rect x="12" y="34" width="96" height="40" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="60" y="59" font-size="13" text-anchor="middle">client</text>
  <rect x="236" y="34" width="150" height="40" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="311" y="59" font-size="13" text-anchor="middle">service</text>
  <line x1="110" y1="46" x2="232" y2="46" stroke-width="1.5" marker-end="url(#c10d-tk-m)" style="stroke: var(--viz-muted)"/>
  <text x="172" y="40" font-size="12" text-anchor="middle">request</text>
  <line x1="234" y1="64" x2="112" y2="64" stroke-width="1.5" marker-end="url(#c10d-tk-m)" style="stroke: var(--viz-muted)"/>
  <text x="172" y="84" font-size="12" text-anchor="middle">response in ms</text>
  <text x="12" y="102" font-size="12" style="fill: var(--viz-muted)">judged by response time and availability</text>
  <line x1="12" y1="114" x2="388" y2="114" style="stroke: var(--viz-grid)"/>
  <text x="12" y="136" font-size="13" font-weight="700">Batch job</text>
  <rect x="20" y="146" width="116" height="44" rx="4" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="16" y="150" width="116" height="44" rx="4" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="12" y="154" width="116" height="44" rx="4" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="70" y="172" font-size="12" font-weight="600" text-anchor="middle">bounded input</text>
  <text x="70" y="189" font-size="12" text-anchor="middle">yesterday's logs</text>
  <line x1="138" y1="176" x2="166" y2="176" stroke-width="1.5" marker-end="url(#c10d-tk-m)" style="stroke: var(--viz-muted)"/>
  <rect x="170" y="154" width="86" height="44" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="213" y="181" font-size="13" text-anchor="middle">batch job</text>
  <line x1="258" y1="176" x2="280" y2="176" stroke-width="1.5" marker-end="url(#c10d-tk-m)" style="stroke: var(--viz-muted)"/>
  <rect x="284" y="154" width="104" height="44" rx="6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <text x="336" y="172" font-size="12" font-weight="600" text-anchor="middle">output</text>
  <text x="336" y="189" font-size="12" text-anchor="middle">derived data</text>
  <text x="12" y="216" font-size="12" style="fill: var(--viz-muted)">judged by throughput · runs e.g. nightly</text>
  <line x1="12" y1="228" x2="388" y2="228" style="stroke: var(--viz-grid)"/>
  <text x="12" y="250" font-size="13" font-weight="700">Stream processor</text>
  <text x="84" y="276" font-size="12" text-anchor="middle">unbounded events</text>
  <line x1="12" y1="290" x2="164" y2="290" stroke-width="2" stroke-dasharray="2 6" marker-end="url(#c10d-tk-m)" style="stroke: var(--viz-muted)"/>
  <circle cx="26" cy="290" r="4" style="fill: var(--viz-c7); stroke: none"/>
  <circle cx="58" cy="290" r="4" style="fill: var(--viz-c7); stroke: none"/>
  <circle cx="90" cy="290" r="4" style="fill: var(--viz-c7); stroke: none"/>
  <circle cx="122" cy="290" r="4" style="fill: var(--viz-c7); stroke: none"/>
  <rect x="170" y="268" width="86" height="44" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="213" y="286" font-size="12" text-anchor="middle">stream</text>
  <text x="213" y="303" font-size="12" text-anchor="middle">processor</text>
  <line x1="258" y1="290" x2="280" y2="290" stroke-width="1.5" marker-end="url(#c10d-tk-m)" style="stroke: var(--viz-muted)"/>
  <rect x="284" y="268" width="104" height="44" rx="6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <text x="336" y="286" font-size="12" text-anchor="middle">continuous</text>
  <text x="336" y="303" font-size="12" text-anchor="middle">output</text>
  <text x="12" y="330" font-size="12" style="fill: var(--viz-muted)">near-real-time: seconds after each event (Ch 11)</text>
</svg>`,
          caption: "The batch row is the only one whose input has an end. That single fact is what lets a batch job know it has finished, and what lets you rerun it and get the same answer.",
        },
        {
          type: "text",
          html: `<h3>Bounded in, derived out</h3>
<p>The defining property of batch input is that it is <strong>bounded</strong>: a known, finite set of files such as yesterday's logs or last night's database snapshot. Because the job can see where its input ends, it knows when it has read everything, and therefore when it is done. A stream processor gives this up. Its input never ends, so it has to decide for itself when a result is complete enough to emit.</p>
<p>The output is <strong>derived data</strong>, computed from the systems of record where each fact is first written: anything the job writes can be produced again from the same inputs. That one property makes batch work forgiving. Found a bug in last month's revenue report? Fix the code and rerun it over the same files. Need a new column for the past two years? Run a <strong>backfill</strong> over the archived inputs. The section on batch outputs and Chapter 12 build on this.</p>
<h3>A batch job is not just a big query</h3>
<p>An analytic (OLAP) query from Chapter 3 also scans huge amounts of data, so where is the line? An analyst types a query and waits a few seconds for a table on a screen. A batch job is a scheduled <strong>program</strong>, often arbitrary code rather than SQL, that runs for minutes or hours and whose output is a dataset that other systems consume: a search index, a table of recommendations, a training set and the model trained on it, a pre-aggregated report, an ETL load into a data warehouse, or a migration that rewrites every record into a new format. The hardware can be identical; the contract is different.</p>
<h3>Why it has to be parallel</h3>
<p>The opening arithmetic drives the rest of the chapter: nearly three hours just to read 2 TB on one machine, about 10 seconds when 1,000 machines share the work. But with a thousand machines, something is <em>always</em> broken, so the partial failures of Chapter 8 stop being rare events and become part of the everyday design.</p>
<p>So "batch" is not a polite word for legacy, or for slow by accident. It is a deliberate trade: give up latency to gain throughput, reproducibility and simplicity. Even stream-first teams usually fall back on a batch-style rerun when they need to recompute history after a bug fix.</p>
<p>The idea is also far older than computers. Herman Hollerith's punched-card tabulating machines processed the 1890 US Census, and for decades afterwards IBM card sorters and tabulators sorted and summarized decks of punched cards. As the MapReduce section shows, the sort-then-aggregate structure of a modern batch job is strikingly close to how those machines worked.</p>`,
        },
        {
          type: "timeline",
          title: "From punched cards to cloud batch",
          items: [
            { year: "1890", html: "Hollerith's tabulating machines process the US Census." },
            { year: "1964", html: "Doug McIlroy's memo asks for programs that can be coupled together like a garden hose." },
            { year: "1973", html: "Pipes are added to Unix." },
            { year: "1980s", html: "Parallel (MPP) databases such as Teradata and the Gamma research system run SQL joins across many machines." },
            { year: "2003–04", html: "Google publishes the Google File System paper (2003) and the MapReduce paper (2004)." },
            { year: "2006", html: "Hadoop (HDFS + MapReduce) is split out of the Nutch search project and adopted by Yahoo!." },
            { year: "2008", html: "Hive (from Facebook) and Pig (from Yahoo!) put higher-level languages, HiveQL and Pig Latin, on top of Hadoop." },
            { year: "2010", html: "Google publishes the Pregel (graph processing) and FlumeJava (pipeline API) papers." },
            { year: "2012–14", html: "Spark's RDD paper appears at NSDI (2012); Spark and Flink become Apache top-level projects (2014)." },
            { year: "2016", html: "Google's Dataflow SDK enters the Apache incubator as Beam: one API for batch and streaming." },
            { year: "2017", html: "Hadoop 3.0 adds erasure coding to HDFS." },
            { year: "2020", html: "Amazon S3 becomes strongly read-after-write consistent; Spark 3.0 ships adaptive query execution." },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "US Census Bureau",
              year: "1890",
              tag: "pre-computer batch",
              html: `Herman Hollerith's electromechanical tabulators read punched cards, one per person, to count the 1890 census: a bounded input processed in bulk to produce aggregate output, which is exactly the shape of a batch job.`,
            },
            {
              org: "Google",
              year: "2004",
              tag: "MapReduce paper",
              html: `Jeffrey Dean and Sanjay Ghemawat's OSDI paper, <em>MapReduce: Simplified Data Processing on Large Clusters</em>, reports that Google rewrote the indexing system behind its production web search as a sequence of MapReduce operations.`,
            },
            {
              org: "Yahoo!",
              year: "2008",
              tag: "Hadoop in production",
              html: `In February 2008 Yahoo! announced that its Search Webmap, which produced data used in every Yahoo! web search query, was running as a Hadoop application on a Linux cluster with more than 10,000 cores.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Batch did not die with Hadoop. Nightly and hourly batch jobs are still everywhere; they just look different now: SQL running on Spark, Trino, BigQuery or Snowflake over files in cloud object storage, scheduled by orchestrators such as Airflow or Dagster (often with dbt managing the SQL), and writing to open table formats such as Apache Iceberg, Delta Lake or Apache Hudi. The principles in this chapter (bounded inputs, derived outputs, rerunnable jobs) carry over unchanged.</p>`,
        },
        {
          type: "keypoints",
          items: [
            "Online services are judged by response time, batch jobs by throughput; stream processors sit in between, with input that never ends.",
            "Bounded input lets a batch job know when it is finished.",
            "Batch output is derived data, so reruns, bug fixes and backfills are cheap.",
            "A batch job is a scheduled program whose output feeds other systems, not an analyst's interactive query.",
            "At terabyte scale the job must run on many machines, which makes partial failure an everyday event.",
          ],
        },
        {
          type: "quiz",
          q: "A batch job and a stream processor both compute 'daily active users'. After you fix a bug, why is it easy to trust a rerun of the batch job?",
          options: [
            "Batch frameworks run every job inside a serializable database transaction",
            "Its input is a bounded, immutable set of files, so rerunning deterministic code over the same files recomputes the correct answer from scratch",
            "Batch jobs run on more reliable hardware than stream processors",
            "Stream processors can't be redeployed with new code",
          ],
          answer: 1,
          explain: "Bounded, immutable input plus deterministic code means the rerun rebuilds the answer from scratch and simply replaces the old, wrong output. Option A is tempting because 'trustworthy' sounds like 'transactional', but batch frameworks don't wrap jobs in database transactions; their safety comes from never modifying the input. Hardware (C) has nothing to do with it, and stream processors can be redeployed (D); the hard part for them is reprocessing an input that never ends.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "unix-pipelines",
      title: "The Unix pipeline: the first batch framework",
      kicker: "Origins",
      concepts: ["unix-philosophy", "uniform-interface", "external-sort"],
      blocks: [
        {
          type: "problem",
          html: `<p>You want the five most-requested pages in a 50 GB nginx access log. The obvious approach is a short script that loops over the lines and counts URLs in an in-memory hash map. It works until the number of <em>distinct</em> URLs outgrows RAM; then the process swaps itself to a crawl or gets killed for running out of memory.</p>
<p>Even when it works, it is a one-off. You can't reuse half of it for tomorrow's question, combine it with other tools, or peek at what it has computed so far, and if it dies 90% of the way through, you start again from the first line.</p>`,
        },
        {
          type: "idea",
          html: `<p>Compose small, single-purpose programs through one <strong>uniform interface</strong> (a stream of newline-separated records on stdin and stdout), and let <code>sort</code> handle data larger than memory by writing sorted runs to disk and merging them: an <strong>external merge sort</strong>.</p>`,
        },
        {
          type: "code",
          lang: "bash",
          title: "Top five pages, one stage per line",
          code: `cat /var/log/nginx/access.log |  # read the log, one request per line
  awk '{print $7}' |             # keep field 7: the request path
  sort             |             # put identical paths next to each other
  uniq -c          |             # collapse adjacent duplicates, prefixing a count
  sort -r -n       |             # order by that count, highest first
  head -n 5                      # keep the top five`,
          caption: "Each stage reads the previous stage's stdout as its stdin. Stop the pipeline after any stage, or pipe it into <code>less</code>, to see exactly what flows between them.",
        },
        {
          type: "diagram",
          title: "What flows through the pipe",
          svg: `<svg viewBox="0 0 400 466" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Six pipeline stages stacked vertically with sample records flowing out of each, and an inset showing sort splitting a large input into sorted runs on disk and merging them">
  <defs>
    <marker id="c10d-px-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="12" y="16" font-size="12" style="fill: var(--viz-muted)">stage</text>
  <text x="180" y="16" font-size="12" style="fill: var(--viz-muted)">what flows out (sample records)</text>
  <rect x="12" y="28" width="150" height="32" rx="5" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="87" y="49" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">access.log</text>
  <text x="180" y="49" font-size="12" style="font-family: var(--font-mono)">… "GET /home HTTP/1.1" …</text>
  <line x1="87" y1="61" x2="87" y2="77" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <rect x="12" y="80" width="150" height="32" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="87" y="101" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">awk '{print $7}'</text>
  <text x="180" y="101" font-size="12" style="font-family: var(--font-mono)">/home · /docs · /home</text>
  <line x1="87" y1="113" x2="87" y2="129" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <rect x="12" y="132" width="150" height="32" rx="5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="87" y="153" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle" font-weight="700">sort</text>
  <text x="180" y="153" font-size="12" style="font-family: var(--font-mono)">/docs · /home · /home</text>
  <line x1="87" y1="165" x2="87" y2="181" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <rect x="12" y="184" width="150" height="32" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="87" y="205" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">uniq -c</text>
  <text x="180" y="205" font-size="12" style="font-family: var(--font-mono)">1 /docs · 2 /home</text>
  <line x1="87" y1="217" x2="87" y2="233" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <rect x="12" y="236" width="150" height="32" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="87" y="257" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">sort -r -n</text>
  <text x="180" y="257" font-size="12" style="font-family: var(--font-mono)">2 /home · 1 /docs</text>
  <line x1="87" y1="269" x2="87" y2="285" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <rect x="12" y="288" width="150" height="32" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="87" y="309" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">head -n 5</text>
  <text x="180" y="309" font-size="12" style="font-family: var(--font-mono)">2 /home · 1 /docs</text>
  <rect x="12" y="336" width="376" height="122" rx="8" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-c3)"/>
  <text x="24" y="356" font-size="12" font-weight="600">zoom into the first sort: input bigger than RAM</text>
  <rect x="24" y="370" width="76" height="26" rx="4" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="62" y="387" font-size="12" text-anchor="middle">chunk 1</text>
  <rect x="24" y="408" width="76" height="26" rx="4" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="62" y="425" font-size="12" text-anchor="middle">chunk 2</text>
  <line x1="102" y1="383" x2="138" y2="383" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <line x1="102" y1="421" x2="138" y2="421" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <text x="120" y="406" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sort</text>
  <rect x="142" y="370" width="100" height="26" rx="4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="192" y="387" font-size="12" text-anchor="middle">sorted run 1</text>
  <rect x="142" y="408" width="100" height="26" rx="4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="192" y="425" font-size="12" text-anchor="middle">sorted run 2</text>
  <text x="192" y="450" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">temp files on disk</text>
  <line x1="244" y1="383" x2="281" y2="401" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <line x1="244" y1="421" x2="281" y2="413" stroke-width="1.5" marker-end="url(#c10d-px-m)" style="stroke: var(--viz-muted)"/>
  <rect x="284" y="394" width="94" height="26" rx="4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <text x="331" y="411" font-size="12" text-anchor="middle">merge → out</text>
</svg>`,
          caption: "uniq -c only sees neighbors, so the sort before it is what turns 'count runs' into 'count totals'. When the input is bigger than its memory buffer, sort writes sorted runs to disk and merges them, so memory never limits how much data the pipeline can handle.",
        },
        {
          type: "text",
          html: `<h3>What each stage does</h3>
<p><code>awk '{print $7}'</code> splits each line on whitespace and prints the seventh field, which in nginx's default "combined" log format is the request path. <code>sort</code> puts identical paths next to each other. That matters because <code>uniq -c</code> only collapses <strong>adjacent</strong> duplicate lines, prefixing each survivor with how many it absorbed; on unsorted input it would count runs, not totals. <code>sort -r -n</code> orders those lines numerically by count, largest first, and <code>head -n 5</code> keeps the top five.</p>
<h3>Hash map or sort?</h3>
<p>The script and the pipeline use different strategies. The hash map keeps one counter per distinct URL, so its memory grows with the number of <strong>distinct keys</strong>, not the number of lines. Two billion lines spread over 50,000 URLs is a few megabytes of counters and one fast pass; 500 million distinct URLs might not fit at all. When the keys fit, the hash map wins.</p>
<p>The sort-based pipeline never needs all the keys in memory at once. GNU <code>sort</code> fills a memory buffer (sized with <code style="white-space:nowrap">-S</code>), sorts that chunk, writes it to a temporary file as a sorted <strong>run</strong>, and repeats; at the end it merges the runs into one sorted stream. Both phases read and write the disk sequentially, which disks do well, and <code style="white-space:nowrap">--parallel</code> spreads the in-memory sorting across cores. Often the real bottleneck is just reading the input file. This sorted-runs-then-merge pattern is the same one behind Chapter 3's <a href="#/ch3/learn/sstables-and-lsm-trees">SSTables and LSM-tree compaction</a>, and it is about to reappear as the core of MapReduce.</p>`,
        },
        {
          type: "compare",
          title: "Two ways to count",
          items: [
            {
              title: "Hash map in a script",
              tone: "ok",
              html: `<p>Memory grows with the number of <strong>distinct</strong> keys. One pass and no disk spills, so it is the fastest option when the keys fit. It swaps or runs out of memory when they don't, and the code is a one-off.</p>`,
            },
            {
              title: "sort | uniq -c",
              tone: "info",
              html: `<p>Memory is capped by sort's buffer. Sorted runs spill to disk and are merged, so it handles inputs far larger than RAM, uses several cores, and every stage is reusable in other pipelines.</p>`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>The Unix philosophy</h3>
<p>This style was designed on purpose. In a 1964 memo Doug McIlroy argued that programs should be connectable like lengths of garden hose, and pipes arrived in Unix in 1973. In 1978 McIlroy and his Bell Labs colleagues wrote down the principles that became known as the <strong>Unix philosophy</strong>. Paraphrased:</p>
<ol>
<li>Make each program do one job well. For a new job, write a new program instead of bolting features onto an old one.</li>
<li>Assume your output will become the input of some other program you haven't met yet: no decorative output, no interactive prompts.</li>
<li>Build things so they can be tried early, and don't hesitate to throw away and rebuild the clumsy parts.</li>
<li>Automate with tools, even throwaway ones you write for the occasion, instead of doing tedious work by hand.</li>
</ol>
<h3>One interface for everything</h3>
<p>Composition works because every program speaks the same <strong>uniform interface</strong>: a file descriptor, a plain stream of bytes with no structure imposed on it. By convention those bytes are ASCII text, one record per line (ended by <code>\\n</code>, byte 0x0A), with fields separated by whitespace or tabs. It isn't elegant: <code>{print $7}</code> is cryptic, and parsing breaks as soon as a field contains a stray space. But any program can feed any other. Compare that with today's databases and SaaS tools, most of which can't be connected to each other at all without custom export and import code.</p>
<h3>Logic separate from wiring</h3>
<p>A Unix tool reads stdin and writes stdout without knowing where its data came from or where it is going; the shell does the wiring. That is <strong>loose coupling</strong> (you will also hear late binding or inversion of control): the same <code>sort</code> works on a log file, a network capture or the output of a program written yesterday. The model has limits. Programs with several inputs or outputs are awkward to wire up, you can't pipe output straight into a network connection, and a program that opens its own files gives up the flexibility.</p>
<h3>Safe to experiment</h3>
<p>Pipelines also make experiments cheap. The input file is treated as <strong>immutable</strong>, so you can rerun the pipeline as often as you like. You can cut it off after any stage and pipe into <code>less</code> to see what is flowing. You can save one stage's output to a file and restart the later stages from it instead of recomputing everything, an idea that returns as <em>materializing intermediate state</em> in the section on dataflow engines.</p>
<p>There is one big limitation: everything runs on <strong>one machine</strong>. A pipeline can use every core and disk in the box, but no more. That gap is exactly what MapReduce fills.</p>`,
        },
        {
          type: "analogy",
          title: "A kitchen line",
          html: `<p>A pipeline works like a restaurant kitchen line. Each cook does one thing to every plate and slides it to the next station. Nobody needs to know who is upstream or downstream, you can swap one cook for another without retraining the rest, and you can pull a plate off the line at any station to taste it.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Knuth vs McIlroy",
              year: "1986",
              tag: "Programming Pearls",
              html: `Jon Bentley's CACM column asked Donald Knuth to demonstrate literate programming on a small task: print the <em>k</em> most common words in a text. Knuth delivered several pages of carefully documented code built around a custom data structure. Doug McIlroy's review answered with a six-stage shell pipeline (<code>tr | tr | sort | uniq -c | sort -rn | sed</code>) that did the same job.`,
            },
            {
              org: "Bell Labs Unix",
              year: "1964–1978",
              tag: "origins",
              html: `McIlroy's 1964 memo asked for programs that could be coupled like garden hoses; Ken Thompson added pipes to Unix in 1973; and the 1978 Bell System Technical Journal foreword by McIlroy, Pinson and Tague wrote down what became known as the Unix philosophy.`,
            },
            {
              org: "Adam Drake (blog post)",
              year: "2014",
              tag: "right-sizing",
              html: `<em>Command-line Tools can be 235x Faster than your Hadoop Cluster</em> summarized about 3.5 GB of chess game records with a shell pipeline (<code>find | xargs | mawk</code>) on a laptop in roughly 12 seconds. An earlier blog post had run a similar job, on about half as much data, as Hadoop on a 7-node Amazon EMR cluster in about 26 minutes. The lesson: data that fits on one machine is often best processed on one machine.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          pros: [
            "Small tools compose into new programs without writing new code",
            "sort keeps memory bounded however large the input is",
            "Immutable input: rerun the pipeline as often as you like",
            "Any intermediate stage can be inspected with less or saved to a file",
          ],
          cons: [
            "Runs on a single machine",
            "Untyped text records: parsing breaks on unexpected characters",
            "Awkward for programs with several inputs or outputs",
            "No recovery from a crash except rerunning from the start or from a saved stage",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A classic warm-up: "find the top 10 URLs in a 1 TB log on one machine." Weak answers jump straight to "use Hadoop". A strong answer first asks how many <strong>distinct</strong> URLs there are. If the counters fit in memory, one hash-map pass plus a size-10 heap is hard to beat. If not, split the log into, say, 256 files by <code>hash(url) mod 256</code> so every URL lands in exactly one file, count each file with a hash map, and merge the per-file top 10s (or use an external sort). If approximate answers are acceptable, a heavy-hitters sketch such as Count-Min plus a heap uses fixed memory. Then point out that hash-partition-then-aggregate is exactly what MapReduce does across machines.</p>`,
        },
        {
          type: "quiz",
          q: "Your log has 2 billion lines but only 50,000 distinct URLs, and your laptop has 16 GB of RAM. Which is likely faster for counting hits per URL?",
          options: [
            "sort | uniq -c, because sorting is always faster than hashing",
            "A hash map in a script, because the working set (50,000 counters) fits easily in memory",
            "Neither: 2 billion lines needs a cluster",
            "sort | uniq -c, because hash maps can't use more than one CPU core",
          ],
          answer: 1,
          explain: "In-memory aggregation needs memory proportional to the number of distinct keys, not lines: 50,000 counters is a few megabytes, so a hash map does one pass with no disk spills. Option A is the tempting one, but sorting 2 billion lines costs O(n log n) comparisons and writes temporary files; it only pays off when the distinct keys (or the data itself) don't fit in RAM. A laptop can stream 2 billion lines (C), and core count isn't what decides this (D).",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "mapreduce-and-hdfs",
      title: "MapReduce: a Unix pipeline spread across a thousand machines",
      kicker: "Mechanism",
      concepts: ["hdfs-distributed-filesystem", "mapreduce", "shuffle", "data-locality", "combiner"],
      blocks: [
        {
          type: "problem",
          html: `<p>The pipeline stops at the edge of one machine. You could spread it by hand: ssh scripts that split the log into chunks, copy them to a hundred servers, run awk everywhere and collect the results. But then every job author has to solve the same hard problems from scratch. Where does each piece of data live? How do all the records for one URL end up on the same machine to be counted? What happens when machine #617 dies at minute 40?</p>
<p>Storage is the other wall. A shared storage appliance (NAS or SAN) that every server reads from becomes the throughput bottleneck at petabyte scale, and copying terabytes to wherever the code happens to run saturates the network before any real work starts.</p>`,
        },
        {
          type: "idea",
          html: `<p>Store data as large, replicated <strong>blocks</strong> on the cluster's own disks, run the <strong>map</strong> function next to each block, and let the framework partition, sort and move every map output to the right <strong>reducer</strong> (the <strong>shuffle</strong>), rerunning any task that fails.</p>`,
        },
        {
          type: "text",
          html: `<h3>HDFS: a filesystem made of ordinary servers</h3>
<p>The Hadoop Distributed File System (HDFS), an open-source reimplementation of the Google File System, is <strong>shared-nothing</strong>: commodity machines with their own local disks, instead of a special shared-disk appliance. Every machine runs a <strong>DataNode</strong> daemon that serves its disks to the cluster. A single <strong>NameNode</strong> keeps the metadata in memory: which files exist, which blocks make up each file, and which DataNodes hold each block. Clients ask the NameNode where a block lives, then read the bytes straight from a DataNode.</p>
<p>Files are cut into large <strong>blocks</strong>, 128 MB by default since Hadoop 2 (GFS used 64 MB chunks). Each block is stored three times by default, with <strong>rack-aware</strong> placement: one replica on the writer's node (or a node in its rack) and the other two on two different nodes of one other rack, so the data survives a whole rack losing power. Since Hadoop 3 a directory can use <strong>erasure coding</strong> instead: Reed-Solomon codes, much like RAID spread across machines. Files are write-once (appends allowed, no in-place updates), which suits immutable batch inputs.</p>
<p>Big blocks favor long sequential reads and keep the metadata small, which points to HDFS's best-known weakness: every file, directory and block costs NameNode heap (a common rule of thumb is about 150 bytes per object), so millions of tiny files can exhaust the NameNode long before the disks fill up. Even so, the biggest Hadoop users have run HDFS across tens of thousands of machines (spread over many clusters) holding hundreds of petabytes. And since Hadoop 2 the NameNode needn't be a single point of failure: an active/standby pair with ZooKeeper-based failover, the kind of coordination service Chapter 9 describes, takes over when the active one dies.</p>`,
        },
        {
          type: "diagram",
          title: "HDFS: metadata in one place, bytes everywhere",
          svg: `<svg viewBox="0 0 400 334" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A NameNode holding block locations above two racks of three DataNodes each; every block has one replica in rack 1 and two in rack 2; a client reads block B1 directly from DataNode A">
  <defs>
    <marker id="c10d-hd-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
    <marker id="c10d-hd-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
  </defs>
  <rect x="12" y="10" width="376" height="78" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="24" y="31" font-size="13" font-weight="700">NameNode · metadata in RAM</text>
  <text x="24" y="53" font-size="12" style="font-family: var(--font-mono)">access.log = B1, B2, B3</text>
  <text x="24" y="73" font-size="12" style="font-family: var(--font-mono)">B1: A D E · B2: B E F · B3: C D F</text>
  <line x1="104" y1="148" x2="104" y2="92" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#c10d-hd-m)" style="stroke: var(--viz-muted)"/>
  <line x1="296" y1="148" x2="296" y2="92" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#c10d-hd-m)" style="stroke: var(--viz-muted)"/>
  <text x="200" y="124" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">heartbeat + block report</text>
  <rect x="12" y="150" width="184" height="118" rx="8" style="fill: none; stroke: var(--viz-line)"/>
  <text x="24" y="168" font-size="12" font-weight="700">Rack 1</text>
  <rect x="204" y="150" width="184" height="118" rx="8" style="fill: none; stroke: var(--viz-line)"/>
  <text x="216" y="168" font-size="12" font-weight="700">Rack 2</text>
  <rect x="20" y="176" width="52" height="84" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="78" y="176" width="52" height="84" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="136" y="176" width="52" height="84" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="212" y="176" width="52" height="84" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="270" y="176" width="52" height="84" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="328" y="176" width="52" height="84" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <g font-size="13" font-weight="700" text-anchor="middle">
    <text x="46" y="193">A</text><text x="104" y="193">B</text><text x="162" y="193">C</text>
    <text x="238" y="193">D</text><text x="296" y="193">E</text><text x="354" y="193">F</text>
  </g>
  <rect x="26" y="202" width="40" height="20" rx="3" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="84" y="202" width="40" height="20" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="142" y="202" width="40" height="20" rx="3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="218" y="202" width="40" height="20" rx="3" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="218" y="228" width="40" height="20" rx="3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="276" y="202" width="40" height="20" rx="3" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="276" y="228" width="40" height="20" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="334" y="202" width="40" height="20" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="334" y="228" width="40" height="20" rx="3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <g font-size="12" text-anchor="middle">
    <text style="font-family: var(--font-mono)" x="46" y="216">B1</text><text style="font-family: var(--font-mono)" x="104" y="216">B2</text><text style="font-family: var(--font-mono)" x="162" y="216">B3</text>
    <text style="font-family: var(--font-mono)" x="238" y="216">B1</text><text style="font-family: var(--font-mono)" x="238" y="242">B3</text>
    <text style="font-family: var(--font-mono)" x="296" y="216">B1</text><text style="font-family: var(--font-mono)" x="296" y="242">B2</text>
    <text style="font-family: var(--font-mono)" x="354" y="216">B2</text><text style="font-family: var(--font-mono)" x="354" y="242">B3</text>
  </g>
  <line x1="46" y1="224" x2="46" y2="290" stroke-width="2" marker-end="url(#c10d-hd-c)" style="stroke: var(--viz-c6)"/>
  <rect x="12" y="294" width="84" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="54" y="314" font-size="13" text-anchor="middle">client</text>
  <text x="106" y="306" font-size="12">reads B1 straight from DataNode A;</text>
  <text x="106" y="322" font-size="12" style="fill: var(--viz-muted)">the NameNode only says where it is</text>
</svg>`,
          caption: "A client in Rack 1 wrote access.log, so each block's first replica sits on a Rack 1 node and the other two on two different nodes of Rack 2. Losing any single machine, or either rack in its entirety, still leaves every block readable.",
        },
        {
          type: "text",
          html: `<h3>A job in four steps</h3>
<p>MapReduce is a framework for jobs that read and write files in a distributed filesystem such as HDFS, and a job has the same shape as the log pipeline: <strong>read</strong> the input and split it into records; <strong>map</strong> each record to a key and a value (<code>awk '{print $7}'</code> emitting <code>(url, 1)</code>); <strong>sort</strong> all the pairs by key; then <strong>reduce</strong>, walking through the sorted pairs while all values for a key sit next to each other (<code>uniq -c</code>). Only map and reduce are your code.</p>
<p>The <strong>mapper</strong> is called once per input record, emits zero or more key-value pairs, and keeps no state between records. The <strong>reducer</strong> is called once per <em>key</em> with an iterator over every value for that key. Keep the distinction straight: one reduce <em>task</em>, a process on some machine, handles many keys and calls your reduce function once for each.</p>`,
        },
        {
          type: "table",
          title: "The pipeline and the job, side by side",
          headers: ["Step", "Unix pipeline", "MapReduce", "Written by"],
          rows: [
            ["Read and split into records", "the log file, one line per record", "the input format splits each block into records", "framework"],
            ["Extract a key", "<code>awk '{print $7}'</code>", "<code>map(record)</code> → <code>(url, 1)</code>", "you"],
            ["Group by key", "<code>sort</code>", "partition + sort + shuffle + merge", "framework"],
            ["Aggregate", "<code>uniq -c</code>", "<code>reduce(url, values)</code> → count", "you"],
          ],
        },
        {
          type: "text",
          html: `<h3>Parallelism and data locality</h3>
<p>The framework runs one <strong>map task per input split</strong>, which in practice means roughly one per HDFS block: a 2 TB input becomes about 16,000 map tasks. The number of reduce tasks, <em>R</em>, is chosen by the job author (Hadoop's default is just 1; Spark SQL's default number of shuffle partitions is 200). Every map output pair goes to reducer <code>hash(key) mod R</code>, which guarantees that all values for a key, from whichever mapper, meet at the same reducer. This is the <code>hash mod N</code> placement that <a href="#/ch6/learn/rebalancing">Chapter 6</a> warns against for assigning keys to nodes. It is safe here because R is fixed for the life of the job, so no record ever has to move.</p>
<p>The scheduler tries to start each map task on a machine that already holds a replica of its block. This is <strong>data locality</strong>, "put the computation near the data": shipping the job's code, a JAR of a few megabytes, beats moving a 128 MB block across the network. It is best effort. If every node with a replica is busy, the task runs elsewhere in the same rack, and failing that anywhere, reading the block remotely.</p>`,
        },
        {
          type: "steps",
          title: "One MapReduce job",
          items: [
            "Split the input into map tasks, one per block, each scheduled near a replica of its block.",
            "Map: call the mapper on every record, emitting <code>(key, value)</code> pairs.",
            "Partition each pair by <code>hash(key) mod R</code>, sort each partition by key and spill it to the mapper's local disk (running the combiner, if any).",
            "Shuffle: each reducer fetches its partition from every mapper.",
            "Merge the sorted runs and call reduce once per key.",
            "Write one output file per reducer to HDFS; the job commits only when every task has succeeded.",
          ],
        },
        {
          type: "viz",
          id: "ch10/mapreduce-shuffle",
          title: "Inside a MapReduce job",
          caption: "Press Play to push a 12-line access log through every stage, then switch Reducers to 3, turn on the Combiner, and try both Failure modes. Notice that the final counts never change (/home 6, /docs 3, /cart 2, /blog 1); only the number of records shuffled and the busiest reducer's load do. 'Node B dies after map' is the subtle failure: a task that had already finished runs again, because its output lived only on its own local disk.",
        },
        {
          type: "text",
          html: `<h3>The shuffle, up close</h3>
<p>Each mapper buffers its output in memory (100 MB by default in Hadoop, spilling when 80% full). Every spill is partitioned by reducer, sorted by key and written to the mapper's <strong>local disk</strong>, not HDFS, because the data is temporary; at the end the spills are merged. Each reducer then fetches its partition from every mapper and merge-sorts those runs. Despite the name, nothing about the <strong>shuffle</strong> is random: it is a deterministic partition, sort, copy and merge.</p>
<p>Reducers start <em>copying</em> as soon as individual map tasks finish (by default Hadoop's "slowstart" kicks in once 5% of maps are done), overlapping network transfer with the map phase. But no <code>reduce()</code> call can run until <strong>every</strong> map task has finished, because the last mapper might still emit a value for any key. Dataflow engines and stream processors later attack exactly this barrier.</p>
<h3>Combiners shrink the shuffle</h3>
<p>A <strong>combiner</strong> is an optional map-side mini-reduce over sorted spills: instead of shipping <code>(/home, 1)</code> a thousand times, the mapper ships <code>(/home, 1000)</code> once. It is valid only for associative, commutative operations such as sum, count and max; it must emit the same kind of pair the reducer consumes; and the framework may run it zero, one or many times. An average must travel as <code>(sum, count)</code> and be divided at the end.</p>
<h3>Output, retries and chains</h3>
<p>Each reducer writes one file (<code>part-r-00000</code>, <code>part-r-00001</code>, …) to HDFS, typically with one replica on its own machine. Fault tolerance works per <strong>task</strong>: a failed task's partial output is discarded and the task reruns elsewhere, which is safe because inputs are immutable. The subtle case, from the original MapReduce paper: when a machine dies, even its <em>completed</em> map tasks rerun, since their output lived only on that machine's disk; completed reduce tasks don't, since their output is already replicated in the distributed filesystem.</p>
<p>With hash partitioning each part file is sorted by key, but the key ranges of different files interleave. For one <strong>globally sorted</strong> output, the job instead samples the input to choose R − 1 split points, so reducer <em>i</em> receives one contiguous key range (range partitioning, Chapter 6) and the part files, read in order, form a single sorted sequence. Hadoop's <code>TotalOrderPartitioner</code>, the TeraSort benchmark and Spark's <code>sortBy</code> all work this way; a poor sample gives some reducers far bigger ranges than others.</p>
<p>One job is rarely enough (ranking the counts needs a second sort), so jobs are chained by pointing one job's input directory at another's output directory, as the section on batch outputs explains. Don't confuse any of this with the "MapReduce" query feature of some document databases such as MongoDB and CouchDB (Chapter 2), which borrows the idea for queries inside a single database.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          html: `<p>"The shuffle randomly scatters records" and "each key gets its own reducer process" are both wrong. Records are <strong>deterministically</strong> partitioned by <code>hash(key) mod R</code> and sorted. Each reduce <em>task</em> handles many keys and calls your reduce function once per key; a job with 50 reducers and 10 million keys has 50 tasks, not 10 million.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google File System",
              year: "2003",
              tag: "SOSP paper",
              html: `A single master held all metadata, files were split into 64 MB chunks, and each chunk had three replicas by default. HDFS was built as an open-source reimplementation of this design.`,
            },
            {
              org: "Apache Hadoop 3.0",
              year: "Dec 2017",
              tag: "erasure coding",
              html: `Added HDFS erasure coding. A Reed-Solomon (6,3) policy stores 9 blocks for every 6 blocks of data, a 50% overhead instead of the 200% overhead of three replicas, and still tolerates the loss of any 3 of the 9.`,
            },
            {
              org: "Google MapReduce paper",
              year: "2004",
              tag: "fault tolerance",
              html: `The master pings every worker. When a worker fails, its in-progress tasks <em>and its completed map tasks</em> are re-executed elsewhere, because map output sat on the dead machine's local disk. Completed reduce tasks are not, because their output is in the global filesystem.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Most new deployments replace HDFS with cloud object storage (S3, GCS, Azure Blob Storage/ADLS) and run Spark, Trino or Flink on separate compute clusters: <strong>separation of storage and compute</strong>. With fast datacenter networks, data locality matters much less than it did. But object stores are not filesystems. S3 only became strongly read-after-write consistent in December 2020, and it still has no atomic directory rename (a "rename" is a copy plus a delete), which is why Hadoop's S3A committers and table formats such as Apache Iceberg and Delta Lake exist.</p>`,
        },
        {
          type: "tradeoffs",
          pros: [
            "Scales to petabytes on commodity machines",
            "Task-level retries turn machine failures into routine events",
            "You write two pure functions; the framework handles distribution",
            "Data locality avoids moving input across the network",
          ],
          cons: [
            "Every job pays for a full sort and an all-to-all shuffle, needed or not",
            "Map output spills to disk, so there is a lot of I/O",
            "Low-level API: even a join takes pages of hand-written code",
            "Job start-up (scheduling, launching new JVMs) costs seconds to tens of seconds",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>When asked "how does MapReduce work?", narrate one record's journey: HDFS block → map task on the same machine → partition <code>hash(key) mod R</code> → sorted spill on the mapper's local disk → fetched by its reducer → merged with the other runs → <code>reduce()</code> → part file in HDFS. Then name the two guarantees the framework gives you: all values for a key meet in one reduce call, and a failed task is invisible because it is retried from immutable input. Bonus points for explaining why finished map tasks may have to run again.</p>`,
        },
        {
          type: "quiz",
          q: "A job has 1,000 map tasks and 50 reducers. A machine that has already FINISHED 3 map tasks dies while reducers are still fetching map outputs. What does the framework do?",
          options: [
            "Nothing: finished map output is safely replicated in HDFS",
            "Reruns those 3 map tasks elsewhere, because their output lived only on the dead machine's local disk",
            "Restarts the whole job from the beginning",
            "Reruns all 50 reducers",
          ],
          answer: 1,
          explain: "Map output is written to the mapper's local disk, not HDFS, because it is temporary. If that disk disappears before every reducer has fetched its partition, those map tasks are recomputed from their input blocks, which are replicated. Reducers keep whatever they already fetched and the job carries on, so neither a full restart (C) nor rerunning the reducers (D) is needed. Option A is the tempting mistake: only reducer output goes to HDFS.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "reduce-side-joins",
      title: "Reduce-side joins: let the shuffle bring related records together",
      kicker: "Joins and grouping",
      concepts: ["reduce-side-join", "secondary-sort", "hot-key-handling", "speculative-execution"],
      blocks: [
        {
          type: "problem",
          html: `<p>Analysts want to know which pages are popular with which age groups. The click events carry a <code>user_id</code>; dates of birth live in the users database. The naive plan: for each of a billion events, ask the users database for that user's birth date over the network.</p>
<p>At just 1 ms per lookup, done one after another, that is a million seconds of round trips: about 11.6 days. A cache helps only if the key distribution is kind. Running thousands of lookups in parallel instead would hammer a production database that real users depend on. And because the database keeps changing while the job runs, two runs over the same events can give different answers, so the output is no longer reproducible.</p>`,
        },
        {
          type: "idea",
          html: `<p>Copy a <strong>snapshot</strong> of the users table next to the event log, then let the shuffle deliver every record that shares a <code>user_id</code> to the same reduce call, ordered so the user's profile arrives first. A join becomes a group-by over two inputs.</p>`,
        },
        {
          type: "text",
          html: `<h3>Joins without indexes</h3>
<p>A batch job has no indexes in the database sense. It scans its inputs from start to finish, which sounds wasteful but suits analytics that touch most records anyway. So a "join" in batch processing means something different from an OLTP lookup: not "find user 104's row" but "resolve <em>every</em> user_id in the event log against the users table, for all records at once, in parallel".</p>
<p>Step one is to get the users table out of the live database and into the distributed filesystem: export it from a backup, or keep a copy current through an ETL or change-data-capture pipeline (Chapter 11). Now both join inputs are files on the same cluster: local, fast to scan and frozen in time, so the job is deterministic.</p>
<h3>The sort-merge join</h3>
<p>Two sets of mappers run side by side. One reads events and emits <code>(user_id, event)</code>; the other reads the users snapshot and emits <code>(user_id, date_of_birth)</code>. Because both outputs are partitioned by <code>user_id</code>, a user's profile and all of that user's events reach the same reducer. A <strong>secondary sort</strong> then orders the values within each key: the user record first, followed by the user's events in timestamp order.</p>`,
        },
        {
          type: "diagram",
          title: "Sort-merge join with a secondary sort",
          svg: `<svg viewBox="0 0 400 390" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An events mapper and a users mapper both emit records keyed by user 104; partitioning sends them to reducer 2, which receives the user record first and then the events in time order, and emits each URL with the viewer's birth year">
  <defs>
    <marker id="c10d-sm-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="12" y="12" width="180" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="102" y="34" font-size="13" font-weight="700" text-anchor="middle">events mapper</text>
  <text x="102" y="66" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">(104, /a 09:01)</text>
  <text x="102" y="84" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">(104, /b 09:05)</text>
  <rect x="208" y="12" width="180" height="34" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <text x="298" y="34" font-size="13" font-weight="700" text-anchor="middle">users mapper</text>
  <text x="298" y="66" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">(104, born 1990)</text>
  <line x1="102" y1="92" x2="176" y2="119" stroke-width="1.5" marker-end="url(#c10d-sm-m)" style="stroke: var(--viz-muted)"/>
  <line x1="298" y1="74" x2="224" y2="119" stroke-width="1.5" marker-end="url(#c10d-sm-m)" style="stroke: var(--viz-muted)"/>
  <rect x="60" y="122" width="280" height="30" rx="6" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="200" y="142" font-size="12" text-anchor="middle">partition by user_id → reducer 2</text>
  <line x1="200" y1="153" x2="200" y2="172" stroke-width="1.5" marker-end="url(#c10d-sm-m)" style="stroke: var(--viz-muted)"/>
  <rect x="60" y="176" width="280" height="120" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="74" y="196" font-size="12" font-weight="700">reducer 2 · values in arrival order</text>
  <rect x="72" y="206" width="256" height="24" rx="4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <text x="84" y="223" font-size="12" style="font-family: var(--font-mono)">1  user 104: born 1990</text>
  <rect x="72" y="236" width="256" height="24" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="84" y="253" font-size="12" style="font-family: var(--font-mono)">2  event /a at 09:01</text>
  <rect x="72" y="264" width="256" height="24" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="84" y="281" font-size="12" style="font-family: var(--font-mono)">3  event /b at 09:05</text>
  <line x1="200" y1="297" x2="200" y2="318" stroke-width="1.5" marker-end="url(#c10d-sm-m)" style="stroke: var(--viz-muted)"/>
  <text x="200" y="338" font-size="12" style="font-family: var(--font-mono)" text-anchor="middle">(/a, born 1990) · (/b, born 1990)</text>
  <text x="200" y="364" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">secondary sort: the user record comes first, then</text>
  <text x="200" y="380" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">events by time, so only one user is held in memory</text>
</svg>`,
          caption: "Both mappers key their output by user_id, so user 104's profile and events meet at the same reducer. The secondary sort guarantees the profile arrives before any of the events, so the reducer never has to buffer events while waiting for it.",
        },
        {
          type: "text",
          html: `<p>The reducer's job is now almost trivial. It reads the first value for a key, keeps the birth date in a local variable, then streams through the events emitting <code>(url, viewer_age)</code> for each; a later job counts views per URL and age group. It holds <strong>one user record</strong> in memory at a time and makes no network calls, so a user with ten million events costs no more memory than a user with one. Both sides arrive sorted by key and the reducer merges them, hence the name <strong>sort-merge join</strong>.</p>
<p>You will rarely build a secondary sort by hand today, but it helps to know where it lives. In Hadoop MapReduce you assemble it from a composite key (user_id plus a tag or timestamp), a custom partitioner that looks only at user_id, and a grouping comparator that also looks only at user_id. Spark's RDD API offers <code>repartitionAndSortWithinPartitions</code>. SQL engines do it implicitly inside their sort-merge join operator.</p>
<h3>Keys are addresses</h3>
<p>A useful mental model: mappers "send messages" to reducers, and the key is the destination address. The framework handles all the networking and all the retries, so application code never deals with a lost message or a half-failed call, unlike services calling services (Chapter 8). The same mechanism does <strong>GROUP BY</strong>: key by the grouping column and let the reducer compute a COUNT, SUM or top-k. It also does <strong>sessionization</strong>: one user's activity is scattered across the logs of many web servers, and keying by session ID brings it together so you can analyze the sequence, for example to check whether users shown version B of a page went on to buy more than users shown version A.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          html: `<p>A reduce-side join is just "GROUP BY user_id" over two inputs at once. Once you see the key as a destination address, joins, aggregations and sessionization turn out to be the same pattern.</p>`,
        },
        {
          type: "text",
          html: `<h3>Hot keys and stragglers</h3>
<p>"All records for a key go to one reducer" has a dark side. A celebrity with 100 million followers, a viral post or one giant customer is a <strong>hot key</strong>, the <a href="#/ch6/learn/hot-spots">hot spot</a> of Chapter 6 (the book calls such records linchpin objects): one reducer receives a huge share of the records while the others finish in minutes. A stage, and therefore everything downstream of it, isn't done until its <strong>slowest</strong> task is. A production classic is the NULL key: anonymous events with <code>user_id = NULL</code> all hash to the same partition and create one enormous task. Filter them out, or handle them separately, before the join.</p>
<p>A slow task can also have nothing to do with the data. A machine with a failing disk or a noisy neighbor runs everything slowly. For that, frameworks offer <strong>speculative execution</strong> (the MapReduce paper calls them backup tasks): near the end of a stage, launch a duplicate of a slow task on another machine and keep whichever copy finishes first. Hadoop MapReduce turns it on by default; Spark leaves it off (<code>spark.speculation = false</code>). It is only safe because task output goes through the framework's commit protocol rather than straight into external systems, as the section on batch outputs explains. And it does nothing for skew, because the backup gets the same oversized partition. Try both below.</p>`,
        },
        {
          type: "viz",
          id: "ch10/stragglers-skew",
          title: "Stragglers and hot keys",
          caption: "Start at the default 35% hot-key share and turn on Speculative execution: the stage gets no shorter, because R3's backup has the same 3.45 M records to process. Then set the share to 0% and turn on Slow machine: now the backup wins. Finally turn Slow machine off, set the share back to 35%, turn on Split hot key and vary k; then drop the share to 0% with the split still on. Notice that the idle area after each finished bar, not the busy bars, is what a skewed stage wastes, and that splitting a key that isn't hot is pure overhead.",
        },
        {
          type: "text",
          html: `<h3>Splitting a hot key</h3>
<p>The only thing that fixed the hot key was spreading its records over several reducers. Real systems do this in a few ways, all variations on <strong>salting</strong>: attach a small random suffix to the hot key so its records hash to different partitions.</p>
<ul>
<li><strong>Pig's skewed join</strong> first runs a sampling job to find which keys are hot. In the join itself, records for a hot key go to one of several reducers chosen at random, and the matching records from the <em>other</em> input are replicated to all of those reducers, so every pair still meets.</li>
<li><strong>Crunch's sharded join</strong> works the same way, but you name the hot keys yourself instead of sampling.</li>
<li><strong>Hive's skewed tables</strong> declare the hot keys in table metadata when the table is created; Hive stores their records in separate files and can join those files with a map-side join (the next section).</li>
<li>For aggregations, <strong>two-stage aggregation</strong>: the first stage sends records to random reducers that each compute a partial result for the hot key (say, a partial count); a second stage combines the partial results into one value per key.</li>
</ul>
<p>Splitting isn't free: it costs a sampling pass, a final merge, and for joins, extra copies of the other side's records. Use it for keys you know, or have measured, to be hot.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache Pig",
              tag: "skewed join",
              html: `<code>JOIN ... USING 'skewed'</code> samples the input to find heavily skewed keys, then splits the records for those keys across several reducers while copying the matching records from the other input to each of them.`,
            },
            {
              org: "Apache Hive",
              tag: "skewed tables",
              html: `Tables can declare their hot values (<code>SKEWED BY ... ON (...)</code>). Hive's skew-join optimizations store or process those keys separately and handle the hot-key part of the join as a map join.`,
            },
            {
              org: "Google MapReduce paper",
              year: "2004",
              tag: "backup tasks",
              html: `Near the end of a job, the master schedules backup executions of the remaining in-progress tasks. The paper reports that its sort benchmark took 44% longer with backup tasks disabled.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Spark's adaptive query execution (added in 3.0, on by default since 3.2) now handles common skew automatically: it spots oversized shuffle partitions from runtime statistics, splits them into smaller tasks and replicates the matching partition of the other side. Some platforms add explicit skew hints. But knowing <em>why</em> skew happens (hot keys, NULL keys, a single dominant customer) is still what lets you fix the cases the optimizer can't see, such as skew inside a user-defined aggregation.</p>`,
        },
        {
          type: "tradeoffs",
          pros: [
            "Works for inputs of any size and any join key, with no assumptions about either",
            "Reducer memory is one key's profile, thanks to the secondary sort",
            "The same mechanism gives GROUP BY, sessionization and top-k",
            "Deterministic: it joins a snapshot, not a live database",
          ],
          cons: [
            "Both inputs are fully partitioned, sorted and shuffled across the network",
            "Hot keys turn one reducer into a straggler",
            "Needs a snapshot of the dimension data first",
            "Output is partitioned by the join key, which may not be what the next job wants",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>If an interviewer says "one task runs for 2 hours while the rest take 5 minutes", first ask whether it is a <strong>slow machine</strong> or a <strong>hot key</strong>: compare input records per task. Slow machine: speculative execution, and take the bad node out of service. Hot key: salting, a skewed join or two-stage aggregation, and check for NULL keys. "Just add more reducers" is the classic weak answer: a single key still lands on a single reducer, however many there are.</p>`,
        },
        {
          type: "quiz",
          q: "Your join finishes 99 of 100 reduce tasks in 4 minutes; the last one runs for 2 hours. Turning on speculative execution doesn't help. Why?",
          options: [
            "Speculative execution only works for map tasks",
            "The slow task holds a hot key; its backup has to process the same oversized partition, so it can't finish sooner. The key must be split across reducers",
            "Speculative execution needs twice the memory, so the backup was killed",
            "The shuffle assigns keys randomly, so the backup got a different partition",
          ],
          answer: 1,
          explain: "Backups help when the machine is slow, because the same work finishes sooner on a healthy one. With skew the work itself is huge, and the backup must redo all of it, so it can't win. Option D is tempting if you picture the shuffle as random, but partitioning is deterministic, so the backup gets exactly the same records. Speculation applies to reduce tasks as well as map tasks (A), and memory isn't the issue (C). The fix is to split the hot key and look for NULL keys.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "map-side-joins",
      title: "Map-side joins: skip the shuffle when you know your data's shape",
      kicker: "Joins, faster",
      concepts: ["map-side-join-broadcast", "map-side-join-partitioned", "map-side-merge-join"],
      blocks: [
        {
          type: "problem",
          html: `<p>A reduce-side join assumes nothing about its inputs, so it pays for everything. Both inputs are partitioned, sorted, spilled to local disk (sometimes through several merge passes) and copied across the network. Joining 2 TB of events with a 1 GB users table this way shuffles all 2 TB just so the 1 GB side can meet it.</p>
<p>If you <em>know</em> something about the inputs, most of that work is waste. Perhaps one side is small enough to hold in memory, or earlier jobs already partitioned, and maybe sorted, both sides by the join key.</p>`,
        },
        {
          type: "idea",
          html: `<p>Use what you know about the inputs (their <strong>size</strong>, <strong>partitioning</strong> and <strong>sort order</strong>) so that each mapper can do its share of the join locally: no reducers, no sorting, no shuffle.</p>`,
        },
        {
          type: "text",
          html: `<p>A <strong>map-side join</strong> runs as a cut-down MapReduce job with no reducers and no sort. Each mapper reads one block of the large input, joins it against whatever it needs from the other input, and writes one output file. Three techniques make that possible, each with a stronger precondition than the last.</p>
<h3>Broadcast hash join: one side is small</h3>
<p>If the users table fits in memory, every mapper loads <em>all</em> of it into an in-memory hash table keyed by user_id, then streams through its block of events, looking up each user_id as it goes. "Broadcast" means every mapper of the large input reads the whole small input; "hash" refers to the hash table. Pig calls this a replicated join, Hive a MapJoin and Spark a broadcast hash join; Cascading, Crunch and Impala support it too. A variant keeps the small input in a read-only on-disk index instead: its frequently used parts stay in the operating system's page cache, giving nearly in-memory lookups without the table having to fit in RAM.</p>
<h3>Partitioned hash join: both sides bucketed alike</h3>
<p>Suppose both inputs are split into the <strong>same number</strong> of partitions, by the <strong>same key</strong>, with the <strong>same hash function</strong>: say, both by the last digit of user_id, into 10 files each. Then any user record that could match an event in partition 3 of the events is in partition 3 of the users. Mapper <em>i</em> loads only partition <em>i</em> of the smaller side into a hash table and scans partition <em>i</em> of the larger side. This layout arises naturally when both inputs come from earlier jobs that already grouped by that key. Hive calls it a bucketed map join.</p>
<h3>Map-side merge join: bucketed and sorted</h3>
<p>If the inputs are partitioned the same way <em>and</em> sorted by the key within each partition, the mapper doesn't need a hash table at all. It reads both partitions together and merges them in key order, like the final step of a merge sort, so memory stops being a constraint. Hive calls this a sort-merge-bucket (SMB) join. One caveat: if an earlier job already partitioned and sorted both inputs, that job could have done the join in its own reduce phase. A separate merge join pays off when those sorted datasets are also reused for other purposes.</p>
<p>The visualization runs one join, 2 TB of events with the users table on user_id, all four ways, using a simple illustrative cost model. The point is the shape, not the exact seconds: break each shortcut on purpose.</p>`,
        },
        {
          type: "viz",
          id: "ch10/join-strategies",
          title: "Picking a join strategy",
          caption: "Try Broadcast with the default 1 GB users table and 4 GB per task, then drag Users table up to 10 GB. Next set Input layout to Bucketed + sorted and push the users table to 200 GB: Partitioned runs out of memory while Merge carries on. Finally choose 'Bucketed, different hash' and press 'Let the optimizer pick'. Notice the two very different ways a shortcut fails: loudly (out of memory, tasks killed) or silently (wrong answers).",
        },
        {
          type: "table",
          title: "Which join, when",
          headers: ["Strategy", "Use when", "Network", "Memory per task", "Needs"],
          rows: [
            ["Reduce-side (sort-merge)", "Nothing is known about the inputs", "Both inputs shuffled", "One key's small-side records (secondary sort)", "Nothing"],
            ["Broadcast hash", "One side fits in memory", "Small side copied to every machine", "The whole small side as a hash table", "A genuinely small input"],
            ["Partitioned hash (bucketed)", "Both bucketed alike on the key", "None", "One bucket of the smaller side", "Same key, same bucket count, same hash function"],
            ["Map-side merge (SMB)", "Both bucketed alike and sorted", "None", "Constant (streams both sides)", "Bucketed and sorted inputs"],
          ],
          note: "Every row except the first trades a shuffle for an assumption. When the assumption is false, the job either runs out of memory or, worse, returns wrong results.",
        },
        {
          type: "text",
          html: `<h3>The shape of the output</h3>
<p>The choice also changes what the <em>next</em> job can assume. Reduce-side join output is partitioned and sorted by the join key. Map-side join output is partitioned and sorted like the large input, with one output file per block or bucket of it. If a downstream job joins again on the same key, a reduce-side join has handed it a ready-made layout; a broadcast join hasn't.</p>
<h3>You have to know the layout</h3>
<p>Every map-side shortcut depends on facts about the physical data: its encoding, the number of partitions, the partitioning key, the hash function and the sort order. Those facts must live somewhere more reliable than the job author's memory. In the Hadoop ecosystem they are kept in the Hive metastore (exposed to other tools through HCatalog); today, table formats such as Apache Iceberg also record a table's partitioning (including hash buckets) and sort order in its metadata. When the facts are wrong, the failures are nasty:</p>
<ul>
<li><strong>The small side isn't small.</strong> The users table grew, or a filter's output was badly mis-estimated, so broadcast tasks run out of memory and are killed. Loud, at least.</li>
<li><strong>The buckets don't line up.</strong> Different partition counts, or the same count with different hash functions, mean user 42 can sit in bucket 7 of one table and bucket 19 of the other. A hand-written job that pairs bucket <em>i</em> with bucket <em>i</em> silently drops most matches. Engines check the bucketing metadata and fall back to a shuffle.</li>
<li><strong>Engines disagree.</strong> Bucketing written by one engine may not be recognized as compatible by another, so the "free" join quietly turns into a full shuffle. Spark's native bucketing, for example, has historically used a different hash function and file layout from Hive's: the hash function really is part of the layout contract.</li>
</ul>`,
        },
        {
          type: "callout",
          tone: "mistake",
          html: `<p>"A broadcast join is X times faster" has no fixed X: the saving depends on how big the large side is compared with the small side, and on the size of the cluster, since every machine receives a full copy. And a broadcast join whose "small" side was mis-estimated is a classic cause of out-of-memory failures in Spark jobs.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache Spark SQL",
              tag: "broadcast threshold",
              html: `Spark uses a broadcast hash join automatically when one side's estimated size is below the auto-broadcast threshold (10 MB by default, set by <code>autoBroadcastJoinThreshold</code>), and you can force one with a <code>BROADCAST</code> hint. Since 3.0, adaptive query execution can switch a planned sort-merge join to a broadcast join at runtime, once actual shuffle sizes are known.`,
            },
            {
              org: "Apache Hive",
              tag: "MapJoin, bucket, SMB",
              html: `Offers MapJoin (converted automatically when one table is small), bucket map joins for tables bucketed on the join key, and sort-merge-bucket joins for tables declared <code>CLUSTERED BY ... SORTED BY ... INTO N BUCKETS</code>.`,
            },
            {
              org: "Apache Pig",
              tag: "explicit strategies",
              html: `Makes the choice explicit: <code>JOIN ... USING 'replicated'</code> (broadcast: the large relation is listed first and the others are held in memory), <code>USING 'merge'</code> (both inputs sorted on the key) and <code>USING 'skewed'</code>.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Engines now choose and change join strategies at runtime. Spark's adaptive query execution (3.0+) re-plans after each shuffle using real sizes: it can turn a sort-merge join into a broadcast join, coalesce small partitions and split skewed ones. And table formats such as Iceberg can report their partitioning to Spark, so compatible tables join without a shuffle ("storage-partitioned joins", Spark 3.3+).</p>`,
        },
        {
          type: "tradeoffs",
          pros: [
            "No shuffle of the large input: often the biggest single saving in a batch job",
            "Broadcast needs no special layout, only a small side",
            "Bucketed and merge joins scale to two huge inputs",
            "A merge join needs constant memory",
          ],
          cons: [
            "Correctness depends on assumptions about size and layout that can silently change",
            "Broadcast costs memory in every task, and network proportional to cluster size",
            "Bucketing must be planned upstream and kept consistent (count, key, hash function)",
            "Output inherits the large input's layout, not the join key's",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Strong answers pick a join by asking three questions in order. Is one side small enough to broadcast, with headroom for estimation errors? Are both sides already bucketed the same way on the key (same count, same hash function)? Are they also sorted? Then state the fallback, a sort-merge join with a shuffle, and name the failure mode of each shortcut: out-of-memory for broadcast, silently missing matches for mismatched buckets.</p>`,
        },
        {
          type: "quiz",
          q: "Events (5 TB) and users (300 GB) are both bucketed by user_id into 256 buckets with the same hash function, but not sorted. Each task has 8 GB of memory. Which join avoids a shuffle and fits in memory?",
          options: [
            "Broadcast hash join of the users table",
            "Partitioned (bucketed) hash join: each task loads one users bucket (~1.2 GB) into a hash table and scans the matching events bucket",
            "Only a reduce-side join is possible",
            "Map-side merge join",
          ],
          answer: 1,
          explain: "300 GB ÷ 256 ≈ 1.2 GB per bucket; even with hash-table overhead that fits comfortably in 8 GB. Broadcasting would put all 300 GB in every task (A). A reduce-side join (C) would work, but it shuffles all 5.3 TB, which is what you were trying to avoid. A merge join (D) is tempting because it needs the least memory, but it requires each bucket to be sorted by user_id, and these aren't.",
        },
      ],
    },
  ],
});
