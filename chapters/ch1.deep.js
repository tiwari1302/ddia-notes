// Chapter 1 deep dive, part 1 (hook + first half of the sections). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch1", {
  hook: `
<p>Imagine a five-person startup with a photo-sharing app. (The company and the night below are hypothetical, but each piece of it is a common way for things to go wrong.) Under the hood the app is four off-the-shelf systems glued together by the team's own code: PostgreSQL holds users and photo records, Redis caches hot feeds, Elasticsearch powers search, and a job queue hands new uploads to workers that make thumbnails.</p>
<p>At 9:02 pm on a Friday, a celebrity with 30 million followers links to the app. Within ten minutes traffic is 40 times normal and the database primary is pinned at 100% CPU. The dashboard's <em>average</em> response time still looks tolerable. Meanwhile the 99th percentile has gone from 200 ms to 9 seconds, and one upload in a hundred times out. Trying to help, an engineer raises the cache size in the config file and pushes it to every server at once. The file has a typo, and the whole site goes down.</p>
<p>Six months later the app is doing fine, bigger than ever. But nobody dares touch the cache-invalidation code someone wrote at 2 am that night.</p>
<p>That one night contains this whole chapter. The typo and the outage are about <strong>reliability</strong>: the difference between a fault and a failure, and why human changes cause so many outages. The celebrity link and the 9-second p99 are about <strong>scalability</strong>: which load parameter matters, how fan-out multiplies work, and why averages hide pain. The code nobody will touch is about <strong>maintainability</strong>: operability and accidental complexity. And for the parent who stored every photo of their children in that app, a corrupted database is not a minor bug. That is why these three concerns frame the entire book.</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "data-systems",
      title: "Your application is now a data system",
      kicker: "Motivation",
      concepts: ["data-intensive", "composite-data-system", "nonfunctional-requirements"],
      blocks: [
        {
          type: "problem",
          html: `<p>The textbook picture of a web app is one program talking to one relational database. Real features don't look like that. Posting a photo in our hypothetical app writes a row to PostgreSQL, deletes a stale entry in Redis, updates an Elasticsearch document and enqueues a thumbnail job, because no single tool is good at durable storage, fast lookups, full-text search and background work all at once.</p>
<p>The naive mental model treats each tool as a black box and assumes its guarantees add up to guarantees for the whole. They don't. If the app writes the database and then crashes before it touches the cache, users keep seeing the old caption until the cache entry expires. PostgreSQL did its job, and so did Redis. The <em>system</em> is still wrong, and no component's documentation will warn you.</p>`,
        },
        {
          type: "idea",
          html: `<p>Once you combine databases, caches, indexes and queues behind an API, you have built a new, special-purpose data system. Its reliability, scalability and maintainability are your design problem, not your vendors'.</p>`,
        },
        {
          type: "text",
          html: `<p>Many applications today are <strong>data-intensive</strong> rather than compute-intensive. Raw CPU power is rarely what limits them. The hard parts are the amount of data, how complex it is, and how fast it changes. A photo app does very little arithmetic; it spends its life storing, finding, copying and invalidating bytes.</p>
<p>Such applications are assembled from a handful of standard building blocks, each with one job:</p>
<ul>
<li><strong>Databases</strong> store data so that you, or another program, can find it again later.</li>
<li><strong>Caches</strong> remember the result of an expensive operation so the next read is fast.</li>
<li><strong>Search indexes</strong> let users look things up by keyword or filter in various ways.</li>
<li><strong>Stream processing</strong> sends messages to other processes, to be handled asynchronously.</li>
<li><strong>Batch processing</strong> periodically crunches a large pile of accumulated data.</li>
</ul>
<p>These blocks are so well packaged that most engineers never write a storage engine; they pick one. Even picking is harder than it sounds, because there are many databases with different characteristics and many ways to build a cache. And a real feature usually needs several blocks at once, wired together like this:</p>`,
        },
        {
          type: "diagram",
          title: "One API, five systems behind it",
          caption: "The client sees a single API. Behind it, application code tries the cache first, falls back to the database, sends keyword queries to the search index and hands slow work to a queue. The amber dashed arrows are the part no vendor supplies: keeping the cache and the index in step with the database on every write.",
          svg: `<svg viewBox="0 0 400 470" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A client calls an API backed by application code, which talks to a cache, a primary database, a search index and a message queue feeding async workers">
<defs>
<marker id="c1ds-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-muted)"/></marker>
<marker id="c1ds-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-warn)"/></marker>
</defs>
<rect x="20" y="8" width="92" height="34" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6); stroke-width: 1.5"/>
<text x="66" y="30" text-anchor="middle" font-size="13" font-weight="700">Client</text>
<line x1="12" y1="60" x2="388" y2="60" style="stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 5 4; fill: none"/>
<text x="388" y="53" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">API: hides everything below</text>
<rect x="8" y="70" width="384" height="392" rx="14" style="fill: none; stroke: var(--viz-c1); stroke-width: 1.5; stroke-dasharray: 6 5"/>
<line x1="66" y1="42" x2="66" y2="82" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1ds-a)"/>
<rect x="20" y="84" width="92" height="320" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="66" y="238" text-anchor="middle" font-size="13" font-weight="700">Application</text>
<text x="66" y="255" text-anchor="middle" font-size="13" font-weight="700">code</text>
<rect x="240" y="84" width="148" height="50" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="314" y="105" text-anchor="middle" font-size="13" font-weight="700">Cache</text>
<text x="314" y="123" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Redis, Memcached</text>
<text x="176" y="100" text-anchor="middle" font-size="12">read: cache first</text>
<line x1="112" y1="110" x2="238" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1ds-a)"/>
<line x1="112" y1="124" x2="238" y2="124" style="stroke: var(--viz-warn); stroke-width: 2; stroke-dasharray: 5 4; fill: none" marker-end="url(#c1ds-w)"/>
<rect x="240" y="150" width="148" height="50" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="314" y="171" text-anchor="middle" font-size="13" font-weight="700">Primary database</text>
<text x="314" y="189" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">PostgreSQL, MySQL</text>
<text x="176" y="166" text-anchor="middle" font-size="12">miss / every write</text>
<line x1="112" y1="176" x2="238" y2="176" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1ds-a)"/>
<rect x="240" y="216" width="148" height="50" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="314" y="237" text-anchor="middle" font-size="13" font-weight="700">Search index</text>
<text x="314" y="255" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Elasticsearch</text>
<text x="176" y="232" text-anchor="middle" font-size="12">search queries</text>
<line x1="112" y1="242" x2="238" y2="242" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1ds-a)"/>
<line x1="112" y1="256" x2="238" y2="256" style="stroke: var(--viz-warn); stroke-width: 2; stroke-dasharray: 5 4; fill: none" marker-end="url(#c1ds-w)"/>
<rect x="240" y="282" width="148" height="50" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3); stroke-width: 1.5"/>
<text x="314" y="303" text-anchor="middle" font-size="13" font-weight="700">Message queue</text>
<text x="314" y="321" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Kafka, RabbitMQ</text>
<text x="176" y="298" text-anchor="middle" font-size="12">enqueue slow jobs</text>
<line x1="112" y1="308" x2="238" y2="308" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1ds-a)"/>
<line x1="314" y1="332" x2="314" y2="356" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1ds-a)"/>
<rect x="240" y="358" width="148" height="46" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="314" y="377" text-anchor="middle" font-size="13" font-weight="700">Async workers</text>
<text x="314" y="395" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">email, thumbnails</text>
<line x1="24" y1="424" x2="58" y2="424" style="stroke: var(--viz-warn); stroke-width: 2; stroke-dasharray: 5 4; fill: none"/>
<text x="66" y="428" font-size="12">on every write, your code keeps these in sync</text>
<text x="200" y="451" text-anchor="middle" font-size="13" font-weight="700" style="fill: var(--viz-c1)">Your new data system: its guarantees are yours</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>Why lump them together as "data systems"?</h3>
<p>The traditional categories are blurring. Redis, a datastore, is widely used as a message queue. Apache Kafka, a message queue, offers durability that looks a lot like a database's. New tools are built for a range of uses rather than one box on a diagram, so it makes more sense to treat them all as <strong>data systems</strong> with different trade-offs.</p>
<p>More importantly, once no single tool covers your requirements, you split the work into tasks that each tool does well and stitch them together with application code. The API in front hides all of it from clients. At that point you have built a new, special-purpose data system out of general-purpose parts, and you are its designer. A promise such as "after a write, clients never see the old value from the cache" exists nowhere except in your code. Making such promises robust, instead of relying on fragile dual writes from application code, is the subject of Chapters 11 (change data capture) and 12 (derived data).</p>
<h3>A race that needs no crash</h3>
<p>Crashes are the obvious way to break that promise, but an ordinary race is enough. (This example goes beyond the book.) Reader R misses in the cache and reads version 1 from the database. Before R finishes, writer W updates the database to version 2 and deletes the cache key. Then R, slightly late, puts version 1 into the cache, where it stays until it expires. Every component behaved exactly as documented, and users now see stale data. Facebook's memcache paper calls these <em>stale sets</em> and added leases to prevent them. Chapter 7 (race conditions) and Chapter 11 (keeping derived data in sync) treat such races systematically; for now, notice that they are yours to handle.</p>
<h3>The questions you now own</h3>
<p>Designing a data system raises questions no single component answers. How do you keep data correct and complete when something goes wrong inside? How do you give consistently good performance while parts are degraded? How do you scale to more load? What does a good API for the whole look like? The answers also depend on non-technical forces: the team's skills and experience, legacy dependencies, the deadline, the organization's tolerance for risk, and regulation.</p>
<p>Requirements come in two kinds. <strong>Functional requirements</strong> say what the system does: store photos, return a feed, search by tag. <strong>Nonfunctional requirements</strong> are general properties such as security, reliability, compliance, scalability, compatibility and maintainability. Two systems with identical features can differ wildly in these, and they are what bite at 9 pm on a Friday. The book concentrates on three.</p>`,
        },
        {
          type: "compare",
          title: "The three concerns this book is about",
          items: [
            {
              title: "Reliability",
              tone: "info",
              html: `<p>The system keeps working <strong>correctly</strong>, at the expected performance, even when hardware, software or people go wrong.</p><p><em>In the hook:</em> the config typo that took the whole site down.</p>`,
            },
            {
              title: "Scalability",
              tone: "info",
              html: `<p>There are <strong>reasonable ways to cope with growth</strong> in data volume, traffic or complexity.</p><p><em>In the hook:</em> the celebrity link, the pinned database and the 9-second p99.</p>`,
            },
            {
              title: "Maintainability",
              tone: "info",
              html: `<p>Many different people can <strong>keep operating and changing</strong> the system productively over the years.</p><p><em>In the hook:</em> the cache code nobody dares touch.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          html: `<p>"We chose PostgreSQL (or DynamoDB, or MongoDB), so our data layer is solved." Not quite: the composition is the system. Its correctness lives in the gaps between components: the cache that missed an invalidation, the index updated before the transaction committed, the queue message delivered twice. Most of this book explains how each piece behaves under faults and concurrency, precisely so you can compose them safely.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Facebook",
              title: "Memcache in front of MySQL",
              year: "2013",
              tag: "paper",
              html: `<p>"Scaling Memcache at Facebook" (NSDI 2013) describes a look-aside cache: web servers read memcache, fall back to MySQL on a miss and fill the cache; on a write they update MySQL and then delete the cache key. Daemons called mcsqueal tail each database's commit log and broadcast deletes to the cache clusters in its region, and <em>leases</em> were added against stale sets and thundering herds. Cache consistency was the application's job.</p>`,
            },
            {
              org: "The New York Times",
              title: "A message log as the source of truth",
              year: "2017",
              tag: "Kafka",
              html: `<p>The NYT described storing every article it has published since 1851 in a single Kafka topic, the "Monolog", and building search indexes and other services from it. A "message queue" acting as the durable store.</p>`,
            },
            {
              org: "Redis",
              title: "A cache that is also a broker",
              tag: "queues",
              html: `<p>Redis lists have long backed job queues such as Resque and Sidekiq (Ruby). Redis 5.0 (2018) added Streams, an append-only log type with consumer groups.</p>`,
            },
            {
              org: "PostgreSQL",
              title: "One database, many roles",
              tag: "SQL",
              html: `<p>JSONB (9.4, 2014) brought document-style storage, and <code>FOR UPDATE SKIP LOCKED</code> (9.5, 2016) made it practical to run job queues in ordinary tables. One database now covers roles that used to need separate systems.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book appeared, the boundaries have blurred further in both directions. PostgreSQL absorbed queue, document and (through the pgvector extension) vector-search roles; Redis gained a persistent log type; and some teams keep data in Kafka indefinitely as a system of record. Both "just use Postgres" and "a specialized store for each job" are live strategies today. Choosing between them is exactly this chapter's trade-off: fewer moving parts (operability, simplicity) against each part's ceiling (scalability, specialized features).</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>In a design interview, drawing boxes labelled "cache", "DB" and "search" is the easy part. Interviewers probe the arrows: <em>What if the database write succeeds and the cache delete fails? Which store is the source of truth? How does the search index catch up, and how stale may it be?</em> A strong answer names the source of truth, states the guarantee between components ("search may lag by a few seconds; the profile page always reads the database"), and says how it is enforced: delete-after-write with a TTL as a backstop, or change data capture from the database's log (Chapter 11) instead of dual writes from application code.</p>`,
        },
        {
          type: "quiz",
          q: "Your app writes a post to PostgreSQL, then deletes the cached copy in Redis and updates Elasticsearch, all from application code. A crash between the steps leaves search showing an outdated version of the post. Whose guarantee was violated?",
          options: [
            "PostgreSQL's: it should have notified the other stores",
            "Elasticsearch's: its consistency settings were too weak",
            "Yours: the combination is a new data system, and keeping its derived copies in sync is a guarantee your code must provide",
            "Nobody's: caches and indexes are allowed to be wrong",
          ],
          answer: 2,
          explain: "Each component did exactly what it promises. The promise that the cache and the search index reflect the database exists only in your application code, so you, as the data-system designer, are responsible for it. Option D is tempting because derived copies often lag, but users still see a wrong result: 'eventually right' is a guarantee you have to design on purpose, for example with change data capture (Chapters 11 and 12).",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "reliability",
      title: "Faults are inevitable; failures are optional",
      kicker: "Reliability",
      concepts: ["reliability", "fault-vs-failure", "fault-tolerance", "chaos-engineering", "availability"],
      blocks: [
        {
          type: "problem",
          html: `<p>Hypothetical: a team running a 200-server service sets the goal "nothing ever breaks". They buy premium hardware, freeze changes over the holidays, and treat every incident as a lapse in vigilance. Then a disk dies on a holiday weekend. The failover script, last run 18 months ago, fails because a hostname has changed. A one-disk problem becomes a six-hour outage.</p>
<p>At this scale, prevention can't push faults to zero, and recovery code that never runs quietly rots. The team needs words that separate the broken part from the outage users see, and a goal that treats faults as routine while stopping them from spreading.</p>`,
        },
        {
          type: "idea",
          html: `<p>Faults are inevitable, so design for <strong>fault tolerance</strong>: stop component faults from turning into user-visible failures, and keep that machinery honest by injecting faults on purpose.</p>`,
        },
        {
          type: "text",
          html: `<p>Informally, a reliable system <strong>keeps working correctly even when things go wrong</strong>. For a typical application, users expect four things:</p>
<ul>
<li>it does what they expected it to do;</li>
<li>it tolerates their mistakes, and use in ways the designers didn't foresee;</li>
<li>its performance is good enough for their use case, at the expected load and data volume;</li>
<li>it prevents unauthorized access and abuse.</li>
</ul>
<p>That is broader than <strong>availability</strong>, the fraction of time a service is up. A service that is up but shows one user another user's photos, silently drops an upload, or leaks data is unreliable, however many nines its dashboard shows.</p>`,
        },
        {
          type: "diagram",
          title: "From fault to (no) failure",
          caption: "Fault tolerance is everything between a fault and a failure: noticing the broken part, routing around it, and having spare capacity to absorb its load. Break any link and the red path wins.",
          svg: `<svg viewBox="0 0 400 316" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A fault is detected and contained so users are unaffected; if it is not detected or there is no spare capacity, it becomes a failure">
<defs>
<marker id="c1fc-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-muted)"/></marker>
<marker id="c1fc-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-bad)"/></marker>
</defs>
<rect x="48" y="12" width="180" height="52" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 1.5"/>
<text x="138" y="33" text-anchor="middle" font-size="13" font-weight="700">Fault</text>
<text x="138" y="51" text-anchor="middle" font-size="12">disk dies on server 6</text>
<line x1="138" y1="64" x2="138" y2="88" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1fc-a)"/>
<rect x="48" y="90" width="180" height="52" rx="10" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn); stroke-width: 1.5"/>
<text x="138" y="111" text-anchor="middle" font-size="13" font-weight="700">Detect</text>
<text x="138" y="129" text-anchor="middle" font-size="12">health check fails</text>
<line x1="138" y1="142" x2="138" y2="166" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1fc-a)"/>
<rect x="48" y="168" width="180" height="60" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="138" y="188" text-anchor="middle" font-size="13" font-weight="700">Contain</text>
<text x="138" y="205" text-anchor="middle" font-size="12">route around server 6;</text>
<text x="138" y="220" text-anchor="middle" font-size="12">spares absorb its load</text>
<line x1="138" y1="228" x2="138" y2="252" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1fc-a)"/>
<rect x="48" y="254" width="180" height="52" rx="10" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok); stroke-width: 1.5"/>
<text x="138" y="275" text-anchor="middle" font-size="13" font-weight="700">No failure</text>
<text x="138" y="293" text-anchor="middle" font-size="12">users notice nothing</text>
<path d="M42 92 H34 V226 H42" style="fill: none; stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="24" y="159" text-anchor="middle" font-size="12" transform="rotate(-90 24 159)" style="fill: var(--viz-c1)">fault tolerance</text>
<path d="M228 116 H318 V164" style="fill: none; stroke: var(--viz-bad); stroke-width: 1.8; stroke-dasharray: 6 4" marker-end="url(#c1fc-b)"/>
<text x="318" y="92" text-anchor="middle" font-size="12" style="fill: var(--viz-bad)">not detected, or</text>
<text x="318" y="107" text-anchor="middle" font-size="12" style="fill: var(--viz-bad)">no spare capacity</text>
<rect x="248" y="168" width="140" height="60" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2.5"/>
<text x="318" y="193" text-anchor="middle" font-size="13" font-weight="700">Failure</text>
<text x="318" y="211" text-anchor="middle" font-size="12">users see errors</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>Faults versus failures</h3>
<p>A <strong>fault</strong> is one component deviating from its specification: a dead disk, a crashed process, a slow network link. A <strong>failure</strong> is the system as a whole no longer providing the service users need. Faults happen to parts; failures happen to users.</p>
<p>Systems that anticipate faults and cope with them are <strong>fault-tolerant</strong> (or resilient). The goal isn't zero faults, which is impossible, but machinery that keeps faults from turning into failures. Tolerance is always relative to named faults, because you can't tolerate everything: surviving a black hole swallowing the Earth would need web hosting in space. So a reliability design should say which faults it handles ("loss of any one machine", "loss of one availability zone") and which it doesn't.</p>
<p>Since a fault's probability never reaches zero, it is usually better to design to <em>tolerate</em> faults than to count on preventing them.</p>
<h3>Measuring availability: the nines</h3>
<p>The book doesn't use them, but interviewers will: availability targets are quoted in "nines", each a downtime budget.</p>`,
        },
        {
          type: "table",
          title: "The nines (beyond the book)",
          headers: ["Availability", "Downtime per year", "Downtime per month"],
          rows: [
            ["99% (two nines)", "≈ 3.65 days", "≈ 7.3 hours"],
            ["99.9% (three nines)", "≈ 8.77 hours", "≈ 43.8 minutes"],
            ["99.95%", "≈ 4.38 hours", "≈ 21.9 minutes"],
            ["99.99% (four nines)", "≈ 52.6 minutes", "≈ 4.4 minutes"],
            ["99.999% (five nines)", "≈ 5.26 minutes", "≈ 26 seconds"],
          ],
          note: "Year = 365.25 days; month = one twelfth of that. Each extra nine divides the downtime budget by ten.",
        },
        {
          type: "text",
          html: `<p>Where does downtime come from? A standard approximation from reliability engineering (not from the book) is</p>
<span class="formula">availability ≈ MTTF / (MTTF + MTTR)</span>
<p>where <strong>MTTF</strong> is the mean time to failure and <strong>MTTR</strong> the mean time to recover. Only the ratio MTTR / MTTF matters, so halving recovery time buys exactly as much as halving how often things break. A service that fails about once a month (730 hours) and takes an hour to recover is at about 99.86%; cut recovery to six minutes and it reaches about 99.99% without breaking any less often. Fast detection, automatic failover and quick rollback are reliability features, not just operational hygiene.</p>
<h3>Composing availability</h3>
<p>The arithmetic of dependencies (again beyond the book): if a request needs <em>all</em> of k dependencies, its availability is at best their product. Five dependencies at 99.9% give 0.999<sup>5</sup> ≈ 99.5%, about 44 hours of downtime a year, five times worse than any single part. If <em>any one</em> of several replicas will do, the service is down only when all are: two replicas at 99% give 1 − 0.01 × 0.01 = 99.99%.</p>
<p>That second formula assumes the replicas fail <strong>independently</strong>. If both run the same buggy release or get the same bad config, they fail together and you're back near 99%. Treat it as an upper bound, never a promise. The next section shows which kinds of faults are independent and which are not.</p>`,
        },
        {
          type: "diagram",
          title: "Dependencies multiply; redundancy helps only if independent",
          caption: "Top: a request that needs all three services fails whenever any one of them is down. Bottom: two replicas are both down only 0.01% of the time, but only if nothing makes them fail together.",
          svg: `<svg viewBox="0 0 400 268" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Serial dependencies multiply availability to about 99.7 percent; two independent 99 percent replicas give 99.99 percent">
<defs>
<marker id="c1av-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="16" y="20" font-size="13" font-weight="700">Needs all (serial)</text>
<rect x="16" y="32" width="72" height="44" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="52" y="50" text-anchor="middle" font-size="12" font-weight="700">DB</text>
<text x="52" y="67" text-anchor="middle" font-size="12">99.9%</text>
<line x1="88" y1="54" x2="110" y2="54" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1av-a)"/>
<rect x="112" y="32" width="72" height="44" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="148" y="50" text-anchor="middle" font-size="12" font-weight="700">Cache</text>
<text x="148" y="67" text-anchor="middle" font-size="12">99.9%</text>
<line x1="184" y1="54" x2="206" y2="54" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1av-a)"/>
<rect x="208" y="32" width="72" height="44" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="244" y="50" text-anchor="middle" font-size="12" font-weight="700">Auth</text>
<text x="244" y="67" text-anchor="middle" font-size="12">99.9%</text>
<line x1="280" y1="54" x2="298" y2="54" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1av-a)"/>
<rect x="300" y="36" width="88" height="36" rx="18" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn); stroke-width: 1.5"/>
<text x="344" y="59" text-anchor="middle" font-size="13" font-weight="700">≈ 99.7%</text>
<text x="16" y="98" font-size="12" style="fill: var(--viz-muted)">0.999 × 0.999 × 0.999: dependencies multiply</text>
<line x1="16" y1="114" x2="384" y2="114" style="stroke: var(--viz-line); stroke-width: 1; fill: none"/>
<text x="16" y="140" font-size="13" font-weight="700">Needs any (redundant)</text>
<line x1="16" y1="198" x2="58" y2="198" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none"/>
<circle cx="60" cy="198" r="3.5" style="fill: var(--viz-muted); stroke: none"/>
<path d="M60 198 L94 171 M60 198 L94 225" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.5"/>
<rect x="96" y="154" width="120" height="34" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="156" y="176" text-anchor="middle" font-size="12" font-weight="700">Replica A · 99%</text>
<rect x="96" y="208" width="120" height="34" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="156" y="230" text-anchor="middle" font-size="12" font-weight="700">Replica B · 99%</text>
<path d="M216 171 L248 198 M216 225 L248 198" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="248" y1="198" x2="262" y2="198" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1av-a)"/>
<rect x="264" y="178" width="124" height="40" rx="20" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok); stroke-width: 1.5"/>
<text x="326" y="195" text-anchor="middle" font-size="13" font-weight="700">99.99%</text>
<text x="326" y="211" text-anchor="middle" font-size="12">if independent</text>
<text x="200" y="262" text-anchor="middle" font-size="12" font-weight="600" style="fill: var(--viz-bad)">same bug or config on both → back to ≈ 99%</text>
</svg>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "Tolerate rather than prevent, except for security",
          html: `<p>For faults you can recover from (a dead disk, a crashed process), designing to tolerate them beats betting on preventing them. Security is the main exception. If an attacker has read your users' data, no failover undoes it, so for security faults prevention has to come first. This chapter, like most of the book, is about the curable kind.</p>`,
        },
        {
          type: "text",
          html: `<h3>Break things on purpose</h3>
<p>A counterintuitive practice follows: deliberately <strong>raise</strong> the rate of faults, for example by killing random processes without warning. Many serious bugs are really poor error handling, like the "replica unreachable" code path that last ran in a test years ago. Injecting faults continuously keeps that machinery exercised, so you find it broken on a Tuesday afternoon rather than during a real outage. This is now called <strong>chaos engineering</strong>; Netflix's Chaos Monkey is the classic example.</p>
<h3>Does reliability matter for ordinary apps?</h3>
<p>It isn't only for nuclear plants and air traffic control. Bugs in business software cost productivity (and legal risk if figures are reported wrongly); e-commerce outages cost revenue and reputation. Even a seemingly unimportant app has a responsibility to users: think of the parent whose children's photos all live in it.</p>
<p>Sometimes cutting reliability is right, as for a prototype in an unproven market or a service with very thin margins. Just make that choice deliberately, rather than discovering it in a postmortem.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Netflix",
              title: "Chaos Monkey and friends",
              year: "2010–2012",
              tag: "chaos",
              html: `<p>Netflix built Chaos Monkey to terminate production instances at random during business hours, so every service had to survive instance loss. It was first described in a December 2010 Netflix blog post ("5 Lessons We've Learned Using AWS"), expanded on in the 2011 "Simian Army" post, and open-sourced in 2012. A sibling, Chaos Kong, simulates losing an entire AWS region.</p>`,
            },
            {
              org: "Google",
              title: "Disaster Recovery Testing (DiRT)",
              year: "2012",
              tag: "game days",
              html: `<p>Google runs company-wide DiRT exercises that deliberately break systems and processes to check that recovery works, as described in the ACM Queue article "Weathering the Unexpected" (2012).</p>`,
            },
            {
              org: "Equifax",
              title: "The fault you can't tolerate",
              year: "2017",
              tag: "security",
              html: `<p>Attackers exploited an unpatched Apache Struts vulnerability (CVE-2017-5638) and obtained personal data on roughly 147 million people. No amount of failover reverses a breach, which is why security calls for prevention.</p>`,
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "The price of reliability",
          prosLabel: "What fault tolerance buys",
          consLabel: "What it costs",
          pros: [
            "Faults stay invisible to users: no lost revenue, data or trust from a dead disk or a crashed node.",
            "Routine operations become non-events: rolling upgrades, machine replacements and failovers.",
            "Recovery paths stay tested, because you exercise them all the time.",
          ],
          cons: [
            "Spare capacity and redundant hardware cost money and sit idle most of the time.",
            "Retries, failover logic and fault-injection tooling are code you must write, test and maintain.",
            "Every recovery mechanism is a new place for bugs: a failover that fires wrongly can cause the outage it was meant to prevent.",
            "For a prototype or a very thin-margin service, consciously accepting lower reliability can be the right business call.",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Fault injection grew from Netflix tooling into a discipline. The <em>Principles of Chaos Engineering</em> manifesto (mid-2010s) framed it as experiments: define steady state, form a hypothesis, inject real-world faults, and look for a difference. Cloud providers now sell it as a managed service: AWS Fault Injection Simulator launched in 2021, since renamed AWS Fault Injection Service.</p>
<p>Site Reliability Engineering practice also turned "how reliable should we be?" into an explicit number. A <strong>service level objective</strong>, say 99.9% of requests succeeding over 30 days, leaves an <strong>error budget</strong> of 0.1%. While budget remains, teams ship quickly; once it's spent, they slow down and invest in reliability.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"How would you make this reliable?" A weak answer says "add replicas". A strong answer names the faults first ("we tolerate the loss of any single machine and any one availability zone; we don't survive a region outage"), then the mechanism for each (replication, health checks, automatic failover), then the recovery time ("failover within 30 seconds"), and finally how you know it works (fault-injection tests, game days). Mentioning that faster recovery counts as much as fewer failures, and that redundancy math assumes independent faults, signals real operational experience.</p>`,
        },
        {
          type: "quiz",
          q: "One of 12 app servers crashes. The load balancer routes around it within seconds and no user request fails. How should you describe this event?",
          options: [
            "A failure that was quickly fixed",
            "A fault that the system tolerated, so no failure occurred",
            "Neither: a crash isn't a fault if the server restarts",
            "Both a fault and a failure, because a component stopped working",
          ],
          answer: 1,
          explain: "A fault is a component deviating from its spec (the crashed server); a failure is the system as a whole not providing its service to users. Fault tolerance (the load balancer plus spare capacity) kept the first from becoming the second. Option D is the tempting one, but it mixes up the component level and the system level: a component stopping is a fault, and it only becomes a failure if users lose service.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "fault-types",
      title: "Three kinds of faults, and why redundancy fixes only one",
      kicker: "Reliability",
      concepts: ["hardware-software-human-faults", "mttf", "correlated-faults", "cascading-failure", "rolling-upgrade"],
      blocks: [
        {
          type: "problem",
          html: `<p>For decades, teams bought reliability: RAID, dual power supplies, a diesel generator in the basement. That works against hardware faults that are rare and unrelated. Then fleets grew until "rare per disk" became "daily per cluster", and cloud VMs started vanishing without warning.</p>
<p>Worse, many outages aren't hardware at all. When every replica runs the same buggy kernel, or someone pushes the same bad config to every server, a fourth identical replica doesn't help in the slightest. Each class of fault needs its own defense.</p>`,
        },
        {
          type: "idea",
          html: `<p>Redundancy defeats <strong>independent</strong> hardware faults. <strong>Correlated</strong> software bugs and human changes need something else: isolation, restarts, testing, staged rollouts, fast rollback and monitoring.</p>`,
        },
        {
          type: "text",
          html: `<h3>Hardware faults: rare per part, routine per fleet</h3>
<p>Disks crash, RAM goes bad, the power grid blacks out, someone unplugs the wrong network cable. Each event is rare for one component, but a data center has a great many components. Hard disks have a <strong>mean time to failure (MTTF)</strong> of roughly 10 to 50 years, which sounds reassuring until you multiply:</p>
<span class="formula">expected failures per day ≈ N / (MTTF in years × 365)</span>
<p>With 10,000 disks and an MTTF of 30 years, that's 10,000 / 10,950 ≈ 0.9 failures a day (about 2.7 at 10 years, 0.55 at 50). In a cluster that size a dead disk is a daily event, not an emergency: per-component reliability is the wrong lens at fleet scale.</p>`,
        },
        {
          type: "diagram",
          title: "One disk versus ten thousand",
          caption: "An illustrative year for a 10,000-disk cluster, randomly generated at 0.91 failures per day: 329 dead disks, and only about 4 days in 10 without one. Nobody should be paged for a single dead disk; the system has to absorb it.",
          svg: `<svg viewBox="0 0 400 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One disk fails about once in 30 years, but a 10,000-disk cluster sees a failure on most days of the year">
<path d="M20 18 v24 a12 4 0 0 0 24 0 v-24" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<ellipse cx="32" cy="18" rx="12" ry="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="56" y="27" font-size="13" font-weight="700">1 disk: MTTF ≈ 30 years</text>
<text x="56" y="45" font-size="12" style="fill: var(--viz-muted)">about one failure in 30 years</text>
<text x="38" y="80" font-size="12"><tspan font-weight="700">10,000 disks</tspan> · an illustrative year, 1 square = 1 day</text>
<path d="M51 92h11v11h-11zM181 92h11v11h-11zM194 92h11v11h-11zM207 92h11v11h-11zM259 92h11v11h-11zM285 92h11v11h-11zM90 105h11v11h-11zM116 105h11v11h-11zM129 105h11v11h-11zM181 105h11v11h-11zM220 105h11v11h-11zM233 105h11v11h-11zM259 105h11v11h-11zM324 105h11v11h-11zM337 105h11v11h-11zM51 118h11v11h-11zM64 118h11v11h-11zM90 118h11v11h-11zM181 118h11v11h-11zM220 118h11v11h-11zM233 118h11v11h-11zM259 118h11v11h-11zM272 118h11v11h-11zM285 118h11v11h-11zM337 118h11v11h-11zM90 131h11v11h-11zM103 131h11v11h-11zM116 131h11v11h-11zM129 131h11v11h-11zM155 131h11v11h-11zM181 131h11v11h-11zM194 131h11v11h-11zM259 131h11v11h-11zM285 131h11v11h-11zM298 131h11v11h-11zM324 131h11v11h-11zM38 144h11v11h-11zM51 144h11v11h-11zM103 144h11v11h-11zM142 144h11v11h-11zM155 144h11v11h-11zM246 144h11v11h-11zM259 144h11v11h-11zM311 144h11v11h-11zM337 144h11v11h-11zM64 157h11v11h-11zM103 157h11v11h-11zM116 157h11v11h-11zM129 157h11v11h-11zM168 157h11v11h-11zM194 157h11v11h-11zM220 157h11v11h-11zM259 157h11v11h-11zM298 157h11v11h-11zM350 157h11v11h-11zM38 170h11v11h-11zM64 170h11v11h-11zM77 170h11v11h-11zM90 170h11v11h-11zM129 170h11v11h-11zM142 170h11v11h-11zM168 170h11v11h-11zM181 170h11v11h-11zM207 170h11v11h-11zM285 170h11v11h-11zM298 170h11v11h-11zM64 183h11v11h-11zM90 183h11v11h-11zM129 183h11v11h-11zM168 183h11v11h-11zM207 183h11v11h-11zM220 183h11v11h-11zM246 183h11v11h-11zM259 183h11v11h-11zM311 183h11v11h-11zM337 183h11v11h-11zM38 196h11v11h-11zM51 196h11v11h-11zM64 196h11v11h-11zM77 196h11v11h-11zM129 196h11v11h-11zM194 196h11v11h-11zM233 196h11v11h-11zM311 196h11v11h-11zM324 196h11v11h-11zM51 209h11v11h-11zM64 209h11v11h-11zM77 209h11v11h-11zM90 209h11v11h-11zM129 209h11v11h-11zM181 209h11v11h-11zM207 209h11v11h-11zM259 209h11v11h-11zM272 209h11v11h-11zM285 209h11v11h-11zM324 209h11v11h-11zM337 209h11v11h-11zM77 222h11v11h-11zM90 222h11v11h-11zM116 222h11v11h-11zM142 222h11v11h-11zM155 222h11v11h-11zM207 222h11v11h-11zM259 222h11v11h-11zM311 222h11v11h-11zM324 222h11v11h-11zM64 235h11v11h-11zM77 235h11v11h-11zM103 235h11v11h-11zM181 235h11v11h-11zM233 235h11v11h-11zM272 235h11v11h-11zM337 235h11v11h-11zM350 235h11v11h-11zM64 248h11v11h-11zM103 248h11v11h-11zM129 248h11v11h-11zM155 248h11v11h-11zM194 248h11v11h-11zM233 248h11v11h-11zM259 248h11v11h-11zM285 248h11v11h-11zM337 248h11v11h-11zM38 261h11v11h-11zM103 261h11v11h-11zM129 261h11v11h-11zM142 261h11v11h-11zM259 261h11v11h-11zM272 261h11v11h-11zM285 261h11v11h-11zM324 261h11v11h-11zM350 261h11v11h-11zM51 274h11v11h-11zM64 274h11v11h-11zM77 274h11v11h-11zM103 274h11v11h-11zM129 274h11v11h-11zM142 274h11v11h-11zM155 274h11v11h-11z" style="fill: var(--viz-grid); stroke: var(--viz-line); stroke-width: 0.6"/>
<path d="M38 92h11v11h-11zM77 92h11v11h-11zM90 92h11v11h-11zM103 92h11v11h-11zM116 92h11v11h-11zM129 92h11v11h-11zM142 92h11v11h-11zM155 92h11v11h-11zM168 92h11v11h-11zM233 92h11v11h-11zM246 92h11v11h-11zM272 92h11v11h-11zM311 92h11v11h-11zM337 92h11v11h-11zM38 105h11v11h-11zM64 105h11v11h-11zM142 105h11v11h-11zM155 105h11v11h-11zM207 105h11v11h-11zM246 105h11v11h-11zM272 105h11v11h-11zM285 105h11v11h-11zM298 105h11v11h-11zM350 105h11v11h-11zM77 118h11v11h-11zM129 118h11v11h-11zM155 118h11v11h-11zM168 118h11v11h-11zM194 118h11v11h-11zM207 118h11v11h-11zM298 118h11v11h-11zM311 118h11v11h-11zM324 118h11v11h-11zM38 131h11v11h-11zM51 131h11v11h-11zM64 131h11v11h-11zM142 131h11v11h-11zM168 131h11v11h-11zM220 131h11v11h-11zM233 131h11v11h-11zM272 131h11v11h-11zM337 131h11v11h-11zM350 131h11v11h-11zM64 144h11v11h-11zM77 144h11v11h-11zM90 144h11v11h-11zM129 144h11v11h-11zM194 144h11v11h-11zM207 144h11v11h-11zM220 144h11v11h-11zM272 144h11v11h-11zM285 144h11v11h-11zM298 144h11v11h-11zM324 144h11v11h-11zM350 144h11v11h-11zM38 157h11v11h-11zM77 157h11v11h-11zM142 157h11v11h-11zM155 157h11v11h-11zM207 157h11v11h-11zM233 157h11v11h-11zM246 157h11v11h-11zM285 157h11v11h-11zM311 157h11v11h-11zM51 170h11v11h-11zM103 170h11v11h-11zM116 170h11v11h-11zM194 170h11v11h-11zM220 170h11v11h-11zM233 170h11v11h-11zM246 170h11v11h-11zM259 170h11v11h-11zM311 170h11v11h-11zM324 170h11v11h-11zM337 170h11v11h-11zM350 170h11v11h-11zM38 183h11v11h-11zM51 183h11v11h-11zM77 183h11v11h-11zM116 183h11v11h-11zM142 183h11v11h-11zM194 183h11v11h-11zM272 183h11v11h-11zM285 183h11v11h-11zM298 183h11v11h-11zM324 183h11v11h-11zM90 196h11v11h-11zM116 196h11v11h-11zM142 196h11v11h-11zM155 196h11v11h-11zM181 196h11v11h-11zM220 196h11v11h-11zM246 196h11v11h-11zM259 196h11v11h-11zM272 196h11v11h-11zM285 196h11v11h-11zM298 196h11v11h-11zM337 196h11v11h-11zM38 209h11v11h-11zM116 209h11v11h-11zM142 209h11v11h-11zM168 209h11v11h-11zM311 209h11v11h-11zM64 222h11v11h-11zM103 222h11v11h-11zM129 222h11v11h-11zM220 222h11v11h-11zM233 222h11v11h-11zM246 222h11v11h-11zM285 222h11v11h-11zM337 222h11v11h-11zM350 222h11v11h-11zM38 235h11v11h-11zM51 235h11v11h-11zM90 235h11v11h-11zM116 235h11v11h-11zM142 235h11v11h-11zM155 235h11v11h-11zM194 235h11v11h-11zM220 235h11v11h-11zM246 235h11v11h-11zM285 235h11v11h-11zM324 235h11v11h-11zM38 248h11v11h-11zM51 248h11v11h-11zM90 248h11v11h-11zM168 248h11v11h-11zM207 248h11v11h-11zM246 248h11v11h-11zM272 248h11v11h-11zM311 248h11v11h-11zM350 248h11v11h-11zM64 261h11v11h-11zM116 261h11v11h-11zM168 261h11v11h-11zM194 261h11v11h-11zM220 261h11v11h-11zM233 261h11v11h-11zM246 261h11v11h-11zM298 261h11v11h-11zM194 274h11v11h-11zM220 274h11v11h-11z" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 0.8"/>
<path d="M64 92h11v11h-11zM220 92h11v11h-11zM298 92h11v11h-11zM324 92h11v11h-11zM350 92h11v11h-11zM51 105h11v11h-11zM77 105h11v11h-11zM103 105h11v11h-11zM168 105h11v11h-11zM194 105h11v11h-11zM311 105h11v11h-11zM38 118h11v11h-11zM103 118h11v11h-11zM116 118h11v11h-11zM142 118h11v11h-11zM246 118h11v11h-11zM350 118h11v11h-11zM77 131h11v11h-11zM207 131h11v11h-11zM246 131h11v11h-11zM311 131h11v11h-11zM116 144h11v11h-11zM168 144h11v11h-11zM181 144h11v11h-11zM233 144h11v11h-11zM51 157h11v11h-11zM90 157h11v11h-11zM181 157h11v11h-11zM272 157h11v11h-11zM324 157h11v11h-11zM337 157h11v11h-11zM155 170h11v11h-11zM272 170h11v11h-11zM103 183h11v11h-11zM155 183h11v11h-11zM181 183h11v11h-11zM233 183h11v11h-11zM350 183h11v11h-11zM103 196h11v11h-11zM168 196h11v11h-11zM207 196h11v11h-11zM350 196h11v11h-11zM103 209h11v11h-11zM155 209h11v11h-11zM194 209h11v11h-11zM220 209h11v11h-11zM233 209h11v11h-11zM246 209h11v11h-11zM298 209h11v11h-11zM350 209h11v11h-11zM38 222h11v11h-11zM51 222h11v11h-11zM168 222h11v11h-11zM181 222h11v11h-11zM194 222h11v11h-11zM272 222h11v11h-11zM298 222h11v11h-11zM129 235h11v11h-11zM168 235h11v11h-11zM207 235h11v11h-11zM259 235h11v11h-11zM298 235h11v11h-11zM311 235h11v11h-11zM77 248h11v11h-11zM116 248h11v11h-11zM142 248h11v11h-11zM181 248h11v11h-11zM220 248h11v11h-11zM298 248h11v11h-11zM324 248h11v11h-11zM51 261h11v11h-11zM77 261h11v11h-11zM90 261h11v11h-11zM155 261h11v11h-11zM181 261h11v11h-11zM207 261h11v11h-11zM311 261h11v11h-11zM337 261h11v11h-11zM38 274h11v11h-11zM90 274h11v11h-11zM116 274h11v11h-11zM168 274h11v11h-11zM181 274h11v11h-11zM207 274h11v11h-11z" style="fill: var(--viz-bad); stroke: var(--viz-bad); stroke-width: 0.8"/>
<rect x="38" y="295" width="11" height="11" style="fill: var(--viz-grid); stroke: var(--viz-line); stroke-width: 0.6"/>
<text x="54" y="305" font-size="12">none: 139 days</text>
<rect x="156" y="295" width="11" height="11" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 0.8"/>
<text x="172" y="305" font-size="12">one: 142 days</text>
<rect x="268" y="295" width="11" height="11" style="fill: var(--viz-bad); stroke: var(--viz-bad); stroke-width: 0.8"/>
<text x="284" y="305" font-size="12">2 to 4: 84 days</text>
<text x="200" y="330" text-anchor="middle" font-size="12" font-weight="600">failures/day ≈ N / (MTTF × 365) = 10,000 / 10,950 ≈ 0.9</text>
</svg>`,
        },
        {
          type: "text",
          html: `<p>The first response was <strong>hardware redundancy</strong>: RAID, dual power supplies, hot-swappable CPUs, batteries and diesel generators. While losing a whole machine was rare, that was enough; restoring a backup onto a new machine was fast enough for most applications, and only those needing very high availability kept copies on several machines.</p>
<p>Two things changed. Data volumes and computing demands grew, so more applications run on many machines, and hardware faults grow in proportion. And cloud platforms such as AWS routinely lose virtual machine instances without warning, because they favor flexibility and elasticity over single-machine reliability. So systems increasingly tolerate the loss of whole machines in software, instead of or on top of hardware redundancy.</p>
<p>The bonus: a system that survives losing a machine can be patched one node at a time, a <strong>rolling upgrade</strong>, with no downtime. A single-server system must schedule an outage. (Rolling upgrades need old and new versions to read each other's data; see Chapter 4.)</p>
<p>Crucially, hardware faults are mostly <strong>independent</strong>: one disk dying doesn't make its neighbor die. Weak correlations exist (a shared rack's heat and power, a bad manufacturing batch, common firmware), but faults mostly arrive one at a time. That independence is why redundancy works.</p>
<h3>Software faults: one bug, every replica</h3>
<p>Software errors are <strong>systematic</strong>: the same code runs on every node, so a bug that hits one node tends to hit them all at once. Being correlated, they cause far more system failures than hardware faults. Typical examples:</p>
<ul>
<li>a bug that brings down every server instance when one particular input or event arrives. On June 30, 2012, a leap second triggered a Linux kernel bug that sent many Java and MySQL processes into a CPU-burning livelock at the same moment;</li>
<li>a runaway process that exhausts a shared resource: CPU, memory, disk space or network bandwidth;</li>
<li>a dependency that slows down, stops responding or returns corrupted responses;</li>
<li><strong>cascading failures</strong>, where a small fault in one component triggers a fault in another, which triggers more.</li>
</ul>
<p>Such bugs can sleep for years until unusual circumstances wake them: the code assumed something about its environment ("a minute has 60 seconds") that was true until it wasn't.</p>
<p>A cascade typically unfolds like this. A dependency slows down, so each request holds a thread and a connection longer. The shared pool fills and unrelated requests queue behind the slow ones. Callers time out and retry, multiplying load on the struggling tier. Health checks fail and capacity is pulled out, so the survivors take the shifted load until they fall over too. Standard defenses: timeouts on every remote call, bounded retries with exponential backoff and jitter, circuit breakers with a fallback, separate pools per dependency (bulkheads), and load shedding. Chapter 8 goes deeper.</p>
<p>There's no quick fix, but many small things help: thinking hard about assumptions and interactions, thorough testing, process isolation, letting processes crash and restart, and monitoring behavior in production. Add <strong>self-checks</strong> wherever the system promises something: a message queue can verify that messages out equal messages in, and alert on any mismatch.</p>`,
        },
        {
          type: "text",
          html: `<h3>Human errors: a leading cause of outages</h3>
<p>People design, build and operate these systems, and even careful people make mistakes. A study of three large internet services (Oppenheimer and colleagues, 2003) found configuration errors by operators were the leading cause of outages, while hardware faults (servers or network) played a role in only 10–25% of them. The book's defenses:</p>
<ul>
<li><strong>Minimize opportunities for error</strong> with well-designed abstractions, APIs and admin interfaces that make the right thing easy, but not so restrictive that people work around them.</li>
<li><strong>Decouple where mistakes are made from where they cause failures:</strong> full-featured sandboxes with real data, where people can experiment safely.</li>
<li><strong>Test thoroughly at every level</strong>, from unit tests to whole-system integration and manual tests; automate the rare corner cases.</li>
<li><strong>Make recovery quick and easy:</strong> fast config rollback, gradual rollout of new code so a bug hits few users, and tools to recompute data if an old computation was wrong.</li>
<li><strong>Monitor in detail</strong>: performance metrics and error rates (telemetry) that warn early and let you check assumptions.</li>
<li><strong>Practice good management and training.</strong></li>
</ul>
<p>Beyond the book: modern incident culture treats "human error" as a symptom of system design, hence blameless postmortems. And many of the best-known recent outages share one shape: a change pushed too widely, too fast.</p>`,
        },
        {
          type: "diagram",
          title: "Why redundancy beats only one class of fault",
          caption: "Three replicas survive a dead disk because the other two are unaffected. A shared bug, or a config pushed everywhere, hits all three at once. Against correlated faults the defense is limiting the blast radius, for example with a canary.",
          svg: `<svg viewBox="0 0 400 292" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A hardware fault takes out one of three replicas; a software bug or a config pushed to all takes out all three; a canary limits it to one">
<line x1="134" y1="8" x2="134" y2="184" style="stroke: var(--viz-grid); stroke-width: 1.5; fill: none"/>
<line x1="266" y1="8" x2="266" y2="286" style="stroke: var(--viz-grid); stroke-width: 1.5; fill: none"/>
<line x1="8" y1="192" x2="392" y2="192" style="stroke: var(--viz-grid); stroke-width: 1.5; fill: none"/>
<text x="68" y="22" text-anchor="middle" font-size="13" font-weight="700">Hardware</text>
<text x="200" y="22" text-anchor="middle" font-size="13" font-weight="700">Software</text>
<text x="332" y="22" text-anchor="middle" font-size="13" font-weight="700">Human</text>
<text x="68" y="46" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">one disk dies</text>
<text x="200" y="46" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">same bug on all</text>
<text x="332" y="46" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">config pushed to all</text>
<path d="M68 54 L34 80" style="fill: none; stroke: var(--viz-bad); stroke-width: 1.5"/>
<path d="M200 54 L166 80 M200 54 L200 80 M200 54 L234 80" style="fill: none; stroke: var(--viz-bad); stroke-width: 1.5"/>
<path d="M332 54 L298 80 M332 54 L332 80 M332 54 L366 80" style="fill: none; stroke: var(--viz-bad); stroke-width: 1.5"/>
<circle cx="32" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<circle cx="68" cy="96" r="15" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<circle cx="104" cy="96" r="15" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<circle cx="164" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<circle cx="200" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<circle cx="236" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<circle cx="296" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<circle cx="332" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<circle cx="368" cy="96" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<g font-size="12" font-weight="700" text-anchor="middle">
<text x="32" y="100">R1</text><text x="68" y="100">R2</text><text x="104" y="100">R3</text>
<text x="164" y="100">R1</text><text x="200" y="100">R2</text><text x="236" y="100">R3</text>
<text x="296" y="100">R1</text><text x="332" y="100">R2</text><text x="368" y="100">R3</text>
</g>
<text x="68" y="136" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-ok)">2 of 3 up: fine</text>
<text x="200" y="136" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-bad)">0 of 3 up: outage</text>
<text x="332" y="136" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-bad)">0 of 3 up: outage</text>
<text x="68" y="158" text-anchor="middle" font-size="12">independent:</text>
<text x="68" y="174" text-anchor="middle" font-size="12">redundancy works</text>
<text x="200" y="158" text-anchor="middle" font-size="12">correlated:</text>
<text x="200" y="174" text-anchor="middle" font-size="12">one bug, all nodes</text>
<text x="332" y="158" text-anchor="middle" font-size="12">correlated:</text>
<text x="332" y="174" text-anchor="middle" font-size="12">one push, all nodes</text>
<text x="16" y="220" font-size="12">Redundancy only helps against</text>
<text x="16" y="237" font-size="12">independent faults. For correlated</text>
<text x="16" y="254" font-size="12">ones, shrink the blast radius:</text>
<text x="16" y="271" font-size="12" font-weight="700">roll out to one node first →</text>
<text x="332" y="212" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">with a canary</text>
<path d="M332 218 L300 238" style="fill: none; stroke: var(--viz-warn); stroke-width: 1.5"/>
<circle cx="298" cy="252" r="13" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn); stroke-width: 2"/>
<circle cx="332" cy="252" r="13" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<circle cx="366" cy="252" r="13" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<g font-size="12" font-weight="700" text-anchor="middle">
<text x="298" y="256">R1</text><text x="332" y="256">R2</text><text x="366" y="256">R3</text>
</g>
<text x="332" y="284" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-ok)">contained: 1 of 3</text>
</svg>`,
        },
        {
          type: "text",
          html: `<p>The fault lab below puts all three classes on one small service: eight identical app servers behind a load balancer, with load that needs five of them. Inject a fault, toggle defenses, and watch a 60-minute strip mark each minute healthy, degraded or down. Its timings are illustrative model parameters, not measurements.</p>`,
        },
        {
          type: "viz",
          id: "ch1/fault-lab",
          title: "Fault lab: when faults become failures",
          caption: "Try Kill a server a few times, then Leap-second bug with the watchdog off and on, then Push bad config with All at once versus Canary plus auto-rollback. Notice that lowering the load (more spare servers) absorbs dead machines but does nothing against the bad config, and nothing against the leap-second bug either until a reboot brings servers back.",
        },
        {
          type: "text",
          html: `<p>What the lab shows:</p>
<ul>
<li><strong>Dead server.</strong> Requests sent to it fail only during the two minutes before the health check removes it; after that, as long as the survivors have headroom, users notice nothing. Kill too many and even healthy servers fail requests from overload.</li>
<li><strong>Leap-second bug.</strong> Spare capacity is useless when every server hangs at once. What shortens the outage is rebooting stuck servers promptly (the watchdog) instead of waiting about 15 minutes for an operator.</li>
<li><strong>Bad config.</strong> The sneakiest: the servers stay up and pass liveness checks while failing every request. A canary on its own only slows the damage, because nothing is watching it and the rollout carries on; a canary plus automatic rollback limits it to one server for about three minutes.</li>
</ul>`,
        },
        {
          type: "table",
          title: "Three classes of fault",
          headers: ["Fault class", "Typical examples", "Correlated?", "Primary defenses"],
          rows: [
            [`<span style="white-space:nowrap">Hardware</span>`, "Disk crash, bad RAM, power outage, unplugged cable, cloud VM vanishing", "Mostly independent (weak links: shared rack, batch, firmware)", "Redundancy (RAID, replicas), tolerating machine loss in software, spare capacity, automated replacement"],
            [`<span style="white-space:nowrap">Software</span>`, "Leap-second kernel bug, runaway process, slow or corrupting dependency, cascading failure", "Highly correlated: the same code runs everywhere", "Testing, process isolation, crash-and-restart, timeouts, backoff and circuit breakers, self-checks, monitoring"],
            [`<span style="white-space:nowrap">Human</span>`, "Bad config push, mistyped command, broken deploy", "Correlated across the rollout's scope", "Well-designed interfaces, sandboxes, staged rollouts, fast rollback, monitoring, training"],
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google",
              title: "A new cluster's first year",
              year: "2009",
              tag: "hardware",
              html: `<p>Jeff Dean's widely cited list from his LADIS 2009 talk: in a typical first year, a new cluster sees roughly 1,000 individual machine failures, thousands of hard-drive failures, about one power-distribution-unit failure (500–1,000 machines suddenly disappear) and about 20 rack failures. At that scale, hardware faults are routine.</p>`,
            },
            {
              org: "The 2012 leap second",
              title: "One kernel bug, every machine",
              year: "June 30, 2012",
              tag: "software",
              html: `<p>When the leap second was inserted, a Linux kernel bug made many systems, notably Java and MySQL processes, spin at high CPU or hang at the same moment; Reddit and Mozilla were among those reporting problems. Restarting the application often didn't help, but rebooting or resetting the system clock did. A textbook correlated fault: every replica ran the same kernel.</p>`,
            },
            {
              org: "Amazon S3",
              title: "A mistyped playbook command",
              year: "Feb 28, 2017",
              tag: "human",
              html: `<p>While debugging, an authorized engineer ran a command from an established playbook with an incorrect input, removing far more us-east-1 S3 servers than intended, including servers for the index and placement subsystems, which then needed a full restart. The disruption lasted about four hours.</p>`,
            },
            {
              org: "CrowdStrike",
              title: "A content update pushed everywhere",
              year: "July 19, 2024",
              tag: "human / config",
              html: `<p>A faulty content update (Channel File 291) for the Falcon sensor went out at once, not in stages, to every online Windows host running a recent sensor version. It crashed about 8.5 million Windows devices by Microsoft's estimate, grounding flights and disrupting hospitals and banks. CrowdStrike afterwards committed to staged deployment of such updates.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p><strong>Hardware faults aren't always fail-stop.</strong> In 2021, Google ("Cores that Don't Count") and Meta ("Silent Data Corruptions at Scale") reported CPUs that occasionally compute wrong results without crashing. Redundancy can't catch a machine that confidently returns a wrong answer; end-to-end checksums and verification can.</p>
<p><strong>Config is code.</strong> On July 2, 2019, Cloudflare deployed a new WAF managed rule globally in one step; its regular expression backtracked catastrophically, exhausted CPU on the machines serving HTTP and HTTPS traffic, and caused about 27 minutes of errors worldwide. Cloudflare then introduced staged rollouts for such rules. CrowdStrike's 2024 outage had the same shape at far larger scale: a "content" change that skipped the staging code changes got.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A common probe: "Your service runs on three replicas. Is it highly available?" A strong answer separates fault classes. Three replicas handle independent hardware faults, if the survivors have headroom; they do nothing against a bad deploy or a poison input that crashes every replica. For those: canaries gated on error rates, automatic rollback, input validation, and timeouts, backoff and circuit breakers against cascades. Bonus: at 10,000 disks failures are daily, so replacement must be automated.</p>`,
        },
        {
          type: "quiz",
          q: "You run every service on 3 replicas spread across separate racks and power feeds. Which event does this redundancy protect you against LEAST?",
          options: [
            "A disk dying on one replica",
            "A power supply failing in one rack",
            "A kernel bug triggered by a leap second on every machine",
            "Someone unplugging one server's network cable",
          ],
          answer: 2,
          explain: "Redundancy works when faults are independent: one disk, one rack, one cable. A bug in code that every replica runs is a correlated fault: all three copies hit it at the same moment, as many Linux systems did on June 30, 2012. Option B can look tempting because a power failure sounds big, but your replicas sit on separate racks and feeds, so it removes only one of them. The defenses against correlated bugs are testing, isolation, restarts, staged rollouts and monitoring, not more identical copies.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "describing-load",
      title: "Scalability starts with the right load parameter",
      kicker: "Scalability",
      concepts: ["scalability", "load-parameters", "twitter-home-timeline", "fan-out"],
      blocks: [
        {
          type: "problem",
          html: `<p>"Is your system scalable?" has no answer as asked. Scalable along which dimension, from what to what? Teams that optimize the obvious number, raw requests per second, get blindsided by the number that actually drives their costs.</p>
<p>Twitter in 2012 is the classic case. It received only about 4.6k new tweets per second on average, an easy write rate. Yet it struggled, because every tweet has to appear in the home timeline of every follower, and timeline reads outnumbered tweets by roughly 65 to 1. Until you name the parameter that drives the work, here <em>fan-out</em>, you can't reason about growth at all.</p>`,
        },
        {
          type: "idea",
          html: `<p>Scalability means having a plan for growth along a <strong>named load parameter</strong>, and the right parameter is the one that dominates the work. For Twitter it was the distribution of followers per user, which drives fan-out, not the tweet rate.</p>`,
        },
        {
          type: "text",
          html: `<p>A system that works today may not work next year, usually because of growth: from 10,000 concurrent users to 100,000, from 1 million to 10 million, or far more data. <strong>Scalability</strong> is a system's ability to cope with increased load. But it isn't a label: "X is scalable" and "Y doesn't scale" mean nothing on their own. The useful questions are <em>"if the system grows in this particular way, what are our options?"</em> and <em>"how can we add computing resources to handle the extra load?"</em></p>
<p>To ask them, first describe today's load with a few numbers, called <strong>load parameters</strong>. Which numbers depends on the architecture: requests per second to a web server, the read/write ratio of a database, simultaneously active users in a chat room, a cache's hit rate. Sometimes the average matters; sometimes a few extreme cases dominate the bottleneck.</p>
<h3>Twitter's two operations (2012)</h3>
<p>The book's example uses figures from Raffi Krikorian's November 2012 talk "Timelines at Scale". They describe Twitter then, not now. Two operations dominated:</p>
<ul>
<li><strong>Post tweet:</strong> about 4.6k requests/s on average, over 12k/s at peak.</li>
<li><strong>Home timeline</strong> (view tweets from the people you follow): about 300k requests/s.</li>
</ul>
<p>Twelve thousand writes per second is not hard. The difficulty is <strong>fan-out</strong>: each user follows many people and is followed by many people. There are two broad ways to get each tweet to the right readers.</p>
<p><strong>Approach 1, fan-out on read (pull).</strong> Posting inserts the tweet into a global collection. Opening a home timeline looks up everyone the user follows, fetches their tweets and merges them by time. In a relational database that is one query:</p>`,
        },
        {
          type: "code",
          lang: "sql",
          title: "Approach 1: the home timeline as a query",
          code: `SELECT tweets.*, users.*
  FROM tweets
  JOIN users   ON tweets.sender_id    = users.id
  JOIN follows ON follows.followee_id = users.id
 WHERE follows.follower_id = :current_user
 ORDER BY tweets.created_at DESC
 LIMIT 50;`,
          caption: "Cheap to write, expensive to read: every timeline view re-runs this join across everyone the reader follows.",
        },
        {
          type: "text",
          html: `<p><strong>Approach 2, fan-out on write (push).</strong> Keep a cache for each user's home timeline, like a mailbox of incoming tweets. When a user posts, look up all of their followers and insert the new tweet into each follower's timeline cache. Reading a home timeline is then cheap, because its result was computed ahead of time.</p>`,
        },
        {
          type: "diagram",
          title: "Fan-out on read versus fan-out on write",
          caption: "Pull does the work when someone reads: one lookup per followed account, then a merge. Push does it when someone writes: one insert per follower, so a read is a single lookup. Figures are Twitter's from November 2012.",
          svg: `<svg viewBox="0 0 400 358" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Fan-out on read merges tweets from followed accounts at read time; fan-out on write copies each tweet into every follower's timeline cache">
<defs>
<marker id="c1tw-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="16" y="20" font-size="13" font-weight="700">Approach 1 · fan-out on read (pull)</text>
<rect x="16" y="34" width="116" height="60" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3); stroke-width: 1.5"/>
<text x="74" y="58" text-anchor="middle" font-size="13" font-weight="700">tweets</text>
<text x="74" y="76" text-anchor="middle" font-size="12">one row per tweet</text>
<rect x="180" y="34" width="96" height="60" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="228" y="58" text-anchor="middle" font-size="13" font-weight="700">merge</text>
<text x="228" y="76" text-anchor="middle" font-size="12">by time</text>
<circle cx="350" cy="64" r="24" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6); stroke-width: 1.5"/>
<text x="350" y="68" text-anchor="middle" font-size="12" font-weight="700">Bob</text>
<line x1="326" y1="64" x2="278" y2="64" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<line x1="180" y1="46" x2="134" y2="46" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<line x1="180" y1="64" x2="134" y2="64" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<line x1="180" y1="82" x2="134" y2="82" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<text x="200" y="114" text-anchor="middle" font-size="12">read: one lookup per followed account, then merge</text>
<text x="200" y="132" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-c2)">300k timeline reads/s</text>
<line x1="16" y1="146" x2="384" y2="146" style="stroke: var(--viz-line); stroke-width: 1; fill: none"/>
<text x="16" y="170" font-size="13" font-weight="700">Approach 2 · fan-out on write (push)</text>
<circle cx="48" cy="240" r="24" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6); stroke-width: 1.5"/>
<text x="48" y="244" text-anchor="middle" font-size="12" font-weight="700">Alice</text>
<text x="48" y="282" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-c3)">4.6k tweets/s</text>
<text x="48" y="298" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">(12k peak)</text>
<line x1="72" y1="240" x2="94" y2="240" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<rect x="96" y="212" width="96" height="56" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="144" y="236" text-anchor="middle" font-size="13" font-weight="700">fan-out</text>
<text x="144" y="254" text-anchor="middle" font-size="12">workers</text>
<line x1="192" y1="234" x2="248" y2="203" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<line x1="192" y1="240" x2="248" y2="240" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<line x1="192" y1="246" x2="248" y2="277" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c1tw-a)"/>
<rect x="250" y="186" width="134" height="34" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="317" y="207" text-anchor="middle" font-size="12">Bob's timeline</text>
<rect x="250" y="223" width="134" height="34" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="317" y="244" text-anchor="middle" font-size="12">Cara's timeline</text>
<rect x="250" y="260" width="134" height="34" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="317" y="281" text-anchor="middle" font-size="12">Dev's timeline</text>
<text x="200" y="324" text-anchor="middle" font-size="12">write: one insert per follower · read: one lookup</text>
<text x="200" y="346" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-c3)">4.6k tweets/s × 75 followers ≈ 345k cache writes/s</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>Why Twitter switched, and what it cost</h3>
<p>Twitter's first version used approach 1, but its systems struggled to keep up with home-timeline queries, so it switched to approach 2. The ratio explains why: timeline reads (300k/s) outnumber tweets (4.6k/s) about 65 to 1, nearly two orders of magnitude, so it pays to do the work once at write time rather than at every read.</p>
<p>The bill arrives at write time. A tweet reaches about 75 followers on average, so 4.6k tweets/s become 4.6k × 75 ≈ <strong>345k writes/s</strong> into timeline caches. And the average hides huge variation: some accounts had over 30 million followers, so one of their tweets meant over 30 million writes, against a goal of delivering tweets within five seconds.</p>
<p>That fan-out runs <strong>asynchronously</strong>: the author's request returns once the tweet is stored, and background workers fill follower timelines. The five-second goal is a freshness target for that work, not the latency of posting. So a 30-million-follower tweet is a backlog problem, delaying everyone else's deliveries, rather than one slow request.</p>
<p>The visualization below plays both strategies plus the hybrid Twitter was moving to: a tiny animated network on top, and Twitter's 2012 numbers on a log scale below. Its fan-out capacity (1M timeline writes/s) and the accounts each reader follows are assumptions, labelled on screen.</p>`,
        },
        {
          type: "viz",
          id: "ch1/twitter-fanout",
          title: "Twitter timelines: fan-out on read vs write",
          caption: "Try Bob opens timeline under Pull, then Alice tweets and Celebrity tweets under Push, then the same buttons under Hybrid; drag the sliders to change the load. Notice the celebrity's delivery bar blowing past the 5-second goal under Push, while Hybrid turns that flood into one write plus a few lookups at read time.",
        },
        {
          type: "text",
          html: `<h3>The load parameter is the follower distribution</h3>
<p>The calculator makes the point: the cost of fan-out on write is set not by tweets per second but by how many followers each tweet reaches. The key load parameter is the <strong>distribution of followers per user</strong>, ideally weighted by how often each user tweets. Your application's key parameter will differ, but the method transfers: find the number that dominates the work, and study its skew, not just its average.</p>
<p>That is where Twitter went next. In 2012 it was moving to a <strong>hybrid</strong>: most users' tweets are still fanned out on write, but a small number of accounts with very large followings are exempt; their tweets are fetched at read time and merged in, as in approach 1. Push for the many, pull for the few. Chapter 12 revisits the timeline as derived data, a kind of materialized view.</p>
<p>More generally, <strong>fan-out</strong> is the number of requests to other services, or writes to other places, needed to serve one incoming request: a search query sent to 100 index shards, a page calling 30 microservices. The celebrity problem returns in Chapter 6 as hot keys in a partitioned database.</p>
<p>Practical details (beyond the book): timeline caches typically hold tweet IDs, with tweets fetched ("hydrated") at read time; following someone means backfilling their recent tweets, and unfollows and deletions must propagate too; and timelines of users who haven't logged in for a while needn't be maintained at all, since they can be rebuilt when the user returns.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Twitter",
              title: "The book's numbers",
              year: "Nov 2012",
              tag: "fan-out",
              html: `<p>From Raffi Krikorian's QCon talk "Timelines at Scale", as cited in the book: 4.6k tweets/s on average, over 12k/s at peak, 300k home-timeline reads/s, about 75 followers per tweet on average (345k timeline-cache writes/s), accounts with over 30M followers, and a goal of delivering tweets within 5 seconds.</p>`,
            },
            {
              org: "Twitter",
              title: "What a timeline cache held",
              year: "2012",
              tag: "Redis",
              html: `<p>The same talk described home timelines kept in Redis clusters as lists of tweet IDs (reportedly capped at about 800 entries each), with tweet bodies hydrated from separate stores at read time and each timeline replicated on several Redis machines. A 2012 design, not a current figure.</p>`,
            },
            {
              org: "Mastodon",
              title: "Push, but not for everyone",
              tag: "open source",
              html: `<p>Mastodon fans posts out on write into per-user home feeds stored in Redis, using Sidekiq background jobs, and stops maintaining feeds for users who have been inactive for a while; their feed is regenerated when they come back. Skipping inactive users is a load-parameter optimization.</p>`,
            },
            {
              org: "X (Twitter)",
              title: "Ranked feeds do read-time work",
              year: "2023",
              tag: "ranking",
              html: `<p>Twitter's March 2023 post on its open-sourced recommendation algorithm said the "For You" pipeline runs about 5 billion times a day, picks roughly 1,500 candidate tweets per request and ranks them, finishing in under 1.5 seconds on average: heavy read-time work on top of precomputed data.</p>`,
            },
          ],
        },
        {
          type: "compare",
          title: "Where to put the work",
          items: [
            {
              title: "Fan-out on read (pull)",
              tone: "warn",
              html: `<p><strong>Write:</strong> one insert. <strong>Read:</strong> a lookup per followed account, plus a merge.</p><p>Good when reads are rare relative to writes, or for accounts with huge followings. Breaks when reads dominate, as Twitter's did.</p>`,
            },
            {
              title: "Fan-out on write (push)",
              tone: "info",
              html: `<p><strong>Write:</strong> one insert per follower, done asynchronously. <strong>Read:</strong> a single cache lookup.</p><p>Good when reads vastly outnumber writes. Breaks on skew: one celebrity post means millions of writes and a delivery backlog. Costs storage for every follower's copy.</p>`,
            },
            {
              title: "Hybrid",
              tone: "ok",
              html: `<p><strong>Push</strong> for ordinary accounts, <strong>pull</strong> for the few with huge followings, merged at read time.</p><p>Good when the follower distribution is heavily skewed, which it almost always is. Costs two code paths and a read-time merge.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Ranked feeds changed the picture again. The "For You" pipeline Twitter described in 2023 retrieves around 1,500 candidates and ranks them with machine-learning models for every request, so a large share of the work happens at read time once more. Modern feeds are hybrid pipelines: precompute candidates where that's cheap, rank at read time where it matters. The underlying question hasn't changed: given your read/write ratio and your skew, where should the work go?</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design a news feed" is one of the most common system-design questions, and this section is its skeleton. Interviewers want you to <em>quantify</em> before choosing: reads versus posts per second, average and maximum followers, the freshness target. A strong answer picks push for ordinary accounts because reads dominate, raises the celebrity problem unprompted, proposes the hybrid, then handles details: storing IDs not full posts, capping timeline length, skipping inactive users, backfilling on follow, and fanning out asynchronously through a queue so posting stays fast.</p>`,
        },
        {
          type: "quiz",
          q: "Twitter's tweet rate (about 4.6k/s) was low and easy to absorb. Why was it nonetheless the wrong number to plan around?",
          options: [
            "Tweets are tiny, so their volume doesn't matter",
            "Each tweet's cost depends on its author's follower count, so the skewed follower distribution, not the tweet rate, determines the fan-out work",
            "Writes are always cheaper than reads",
            "Timeline reads were cached, so only writes mattered",
          ],
          answer: 1,
          explain: "Under fan-out on write, one tweet costs one write per follower: about 75 on average, but over 30M for the biggest accounts. The distribution of followers per user (weighted by how often they tweet) is the load parameter that sets the cost, and a tweets-per-second figure hides that skew. Option D sounds plausible because timelines were indeed cached, but the cache is exactly what makes each write expensive: filling it is the fan-out work.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "describing-performance",
      title: "Response time is a distribution, not a number",
      kicker: "Performance",
      concepts: ["response-time-vs-latency", "percentiles", "throughput", "slo-sla", "percentile-aggregation"],
      blocks: [
        {
          type: "problem",
          html: `<p>Once you can describe your load, you need to say how well you handle it. "Average response time: 120 ms" sounds precise but hides what users experience: the same request takes 40 ms one time and 2 seconds the next, thanks to garbage-collection pauses, retransmitted packets and queueing.</p>
<p>An average blends a few disastrous requests with many fast ones. It jumps when one request times out, and it can stay flat while 1% of users time out. You need a description of the whole distribution, and a way to combine it across servers and time windows without lying.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat response time as a <strong>distribution</strong>: the median for the typical experience, high percentiles for the tail, and aggregate by merging histograms, never by averaging percentiles.</p>`,
        },
        {
          type: "text",
          html: `<p>With load described, you can ask what happens as it grows, in two ways. <em>Increase a load parameter and keep resources (CPU, memory, network bandwidth) fixed: how does performance change?</em> Or: <em>increase a load parameter: how much must resources grow to keep performance the same?</em> Both need performance numbers.</p>
<p>A batch system such as Hadoop usually cares about <strong>throughput</strong>: records processed per second, or total time to run a job on a dataset of a given size. (Ideally job time = dataset size / throughput; in practice it's longer, because of skew and waiting for the slowest task, as Chapter 10 shows.) An online system cares more about <strong>response time</strong>: the time between a client sending a request and receiving the response. That time has several parts:</p>`,
        },
        {
          type: "diagram",
          title: "What \"response time\" includes",
          caption: "The client's stopwatch covers everything. A timer inside the request handler sees only the service time, which is how server-side metrics can look healthy while users wait in queues.",
          svg: `<svg viewBox="0 28 400 188" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Response time is network delay plus queueing plus service time plus network delay back; latency in the book's sense is the waiting part">
<path d="M20 66 V58 H200 V66" style="fill: none; stroke: var(--viz-warn); stroke-width: 1.5"/>
<text x="20" y="46" font-size="12" font-weight="600">latency (book's sense): waiting to be handled</text>
<rect x="20" y="78" width="70" height="30" style="fill: var(--viz-grid); stroke: var(--viz-line); stroke-width: 1"/>
<rect x="90" y="78" width="110" height="30" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn); stroke-width: 1"/>
<rect x="200" y="78" width="120" height="30" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1"/>
<rect x="320" y="78" width="60" height="30" style="fill: var(--viz-grid); stroke: var(--viz-line); stroke-width: 1"/>
<text x="55" y="98" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">network</text>
<text x="145" y="98" text-anchor="middle" font-size="12">queue</text>
<text x="260" y="98" text-anchor="middle" font-size="12" font-weight="700">service time</text>
<text x="350" y="98" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">network</text>
<path d="M200 116 V124 H320 V116" style="fill: none; stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="260" y="140" text-anchor="middle" font-size="12">timer inside the handler</text>
<path d="M20 152 V160 H380 V152" style="fill: none; stroke: var(--viz-c6); stroke-width: 1.5"/>
<text x="200" y="178" text-anchor="middle" font-size="12" font-weight="700">response time = what the client measures</text>
<text x="200" y="206" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Everyday use of "latency" is looser: say which you mean.</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>Latency is not response time</h3>
<p>The words are often used as synonyms, but the book separates them. <strong>Response time</strong> is what the client sees: the actual work of processing the request (the <em>service time</em>) plus network and queueing delays. <strong>Latency</strong> is the time a request spends waiting to be handled, while it is <em>latent</em>, awaiting service. Not everyone follows this distinction, so say which you mean.</p>
<h3>One request, many answers</h3>
<p>Send the same request repeatedly and the response time differs each time. Across many requests, response time is a <strong>distribution</strong>: most requests are reasonably fast, with occasional outliers that take much longer. Some outliers are genuinely expensive requests, but identical requests get unlucky too: a context switch to a background process, a lost packet and its TCP retransmission, a garbage-collection pause, a page fault forcing a disk read, even mechanical vibration in the server rack.</p>
<h3>Why the mean misleads</h3>
<p>Dashboards love the <strong>mean</strong>, but it doesn't tell you how many users actually experienced that delay. <strong>Percentiles</strong> work better. Sort the response times from fastest to slowest; the <strong>median</strong> (p50) is the halfway point, with half of requests faster and half slower. But the median describes one request. A user loading a page with five resources has far more than a 50% chance that at least one is slower than the median: with five independent requests it's 1 − 0.5<sup>5</sup> ≈ 97%.</p>
<p>To see how bad the outliers are, look higher: <strong>p95, p99 and p999</strong> (99.9th) are the thresholds that 95%, 99% and 99.9% of requests are faster than. These <strong>tail latencies</strong> directly shape users' experience.</p>
<p>The sandbox below holds 2,000 synthetic response times (illustrative, not measured) with live markers for the mean and four percentiles. Switch on real sources of slowness, append 30-second timeouts, or split traffic across two servers.</p>`,
        },
        {
          type: "viz",
          id: "ch1/percentiles",
          title: "Mean vs percentiles",
          caption: "Try adding a 30 s timeout or two, then toggling TCP retransmits and cache misses, then switching to Two servers. Notice that one timeout shifts the mean while the median barely moves, that each source of slowness moves a different percentile, and that the average of the two servers' p99s lands well below the true p99.",
        },
        {
          type: "text",
          html: `<p>Each source of slowness lived in a different part of the distribution. Cache misses (5% of requests) moved p95 and p99 but barely moved the median. Retransmits (0.5%) barely touched p95 yet roughly doubled p99.9. One timeout moved the mean by about 15 ms without changing the typical request. No single number captures that; a handful of percentiles does.</p>
<h3>Which percentile should you care about?</h3>
<p>Amazon writes the response-time targets of its internal services at p99.9, a threshold only 1 request in 1,000 exceeds. Why care about so few? Because those slow requests are not random: they tend to come from customers with long purchase histories, whose accounts carry the most data, and those are the customers Amazon least wants to lose. The book also cites Amazon's finding that 100 ms of added response time cost about 1% of sales, and a separate report tying a one-second delay to a 16% drop in a customer-satisfaction score.</p>
<p>There is a limit: Amazon judged optimizing p99.99 (1 in 10,000) too expensive. The extreme tail is dominated by random events outside your control, and each extra nine costs more for less benefit.</p>
<h3>SLOs and SLAs</h3>
<p>Percentiles go into targets and contracts. A <strong>service level objective (SLO)</strong> or <strong>service level agreement (SLA)</strong> defines a service's expected performance and availability. For example: the service counts as up if its median response time is under 200 ms and its p99 under 1 s (slower, and it might as well be down), and it must be up at least 99.9% of the time. Miss an SLA and clients may be owed a refund.</p>
<p>Google's SRE vocabulary (beyond the book) splits this three ways: the <strong>SLI</strong> is the measured indicator (say, the fraction of requests completing within 300 ms at the load balancer), the <strong>SLO</strong> your internal target for it over a window, and the <strong>SLA</strong> the external contract with consequences. Latency SLIs should be percentiles or "fraction under a threshold", never a mean.</p>
<h3>Computing percentiles in production</h3>
<p>Dashboards typically keep a rolling window (say, the last 10 minutes of requests) and recompute percentiles every minute. Keeping and sorting every value is expensive, so real systems use cheap approximations such as forward decay, t-digest and HdrHistogram.</p>
<p>Aggregation is where teams go wrong. Averaging percentiles, to lower time resolution or to combine machines, is mathematically meaningless. Instead <strong>add the histograms</strong> (or merge the sketches) and compute the percentile from the combined data, as the sandbox's Two servers mode does for its "true p99".</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Three latency myths",
          html: `<ul>
<li><strong>"Average the per-server p99s to get the fleet's p99."</strong> Percentiles don't average. In the sandbox the average comes out far too low; with other data it can be too high. Merge the histograms instead.</li>
<li><strong>"A p99 of 200 ms means 99% of users are fine."</strong> Percentiles count requests, not users. Heavy users send many requests and hit the tail far more often than 1% of the time.</li>
<li><strong>"Mean ± standard deviation summarizes latency."</strong> Those suit symmetric, bell-shaped data. Response times are skewed, often with several humps (cache hit versus miss), so a standard deviation describes no real request.</li>
</ul>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Amazon",
              title: "Dynamo's SLA at the 99.9th percentile",
              year: "2007",
              tag: "paper",
              html: `<p>The Dynamo paper gives a typical internal SLA: respond within 300 ms for 99.9% of requests at a peak load of 500 requests per second. It explains that Amazon targets the 99.9th percentile rather than the mean or median so that all customers, not just most, get a good experience, and that one page can call over 150 services, each bound by such a contract.</p>`,
            },
            {
              org: "Amazon",
              title: "Latency and sales",
              tag: "as reported",
              html: `<p>The book cites Amazon's observation that a 100 ms increase in response time reduced sales by about 1%. It is an often-repeated internal finding rather than a published study, so treat the exact figure as reported, not measured by you.</p>`,
            },
            {
              org: "Google SRE",
              title: "SLIs, SLOs and error budgets",
              year: "2016",
              tag: "book",
              html: `<p>Google's <em>Site Reliability Engineering</em> book frames service health as SLIs and SLOs, recommends percentiles rather than averages for latency, and uses error budgets (100% minus the SLO) to decide when to ship and when to slow down.</p>`,
            },
            {
              org: "Prometheus / DDSketch",
              title: "Aggregating correctly",
              tag: "monitoring",
              html: `<p>Prometheus' documentation warns that quantiles from summaries can't be aggregated across instances and recommends histograms with <code>histogram_quantile</code> instead. DDSketch (VLDB 2019) is a mergeable quantile sketch with relative-error guarantees, built for exactly this kind of aggregation.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Monitoring tools have absorbed the "merge histograms, never average percentiles" lesson. Prometheus histogram buckets from many instances can be summed and turned into a percentile with <code>histogram_quantile</code>, while precomputed summary quantiles can't be combined. Exponential (native) histograms in Prometheus and OpenTelemetry, and mergeable sketches such as Datadog's DDSketch, make correct aggregation cheap across thousands of hosts.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>When asked to set a performance target, avoid "average latency under 100 ms". Say something like "p50 under 100 ms and p99 under 500 ms, measured at the load balancer over 28 days, at an expected peak of 2k requests/s". Then show you know the traps: server-side timers miss queueing, so measure close to the client (see "Why the queue, not the work, makes requests slow"); aggregate by merging histograms; and a page that fans out to many backends turns their tail into the common case (see "Why the slowest call wins").</p>`,
        },
        {
          type: "quiz",
          q: "A service reports a mean response time of 120 ms and a median of 40 ms. What does this most likely tell you?",
          options: [
            "Most requests take around 120 ms",
            "The distribution is skewed: a minority of very slow requests pulls the mean far above the typical request",
            "The measurement is broken, because the mean can't exceed the median",
            "The p99 must be about 240 ms",
          ],
          answer: 1,
          explain: "Response times are right-skewed: most are fast, a few are very slow, and those few pull the mean up until it describes almost no actual request. The median says half of requests finish within 40 ms. Option C is wrong because nothing forces the mean and median to match; they coincide only for symmetric distributions, and a mean above the median is the normal signature of a long tail. Nothing lets you derive p99 from these two numbers (D): you have to measure the tail.",
        },
      ],
    },
  ],
});
