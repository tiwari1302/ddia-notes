// Chapter 2 deep dive, part 1 (hook + first half of the sections). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch2", {
  hook: `
<p>A thought experiment (the company is hypothetical). It's 2010, and a startup is building a professional network. Every profile is a JSON document: a name, a summary, an array of jobs, an array of schools. The profile page loads with a single read, the objects in the code look exactly like the stored data, and nobody has ever written a migration. Life is good.</p>
<p>Then the product grows. Employers become company pages with logos and news feeds. Users start writing recommendations for each other, and each one has to show the recommender's current name and photo. A product manager asks for "who else worked at this company?", a question that a pile of profile trees, each rooted at a user, can only answer by scanning all of them or by maintaining an extra index on the embedded field.</p>
<p>Then a real event. On October 28, 2021, Facebook, Inc. renamed itself Meta Platforms. In our startup, every profile that copied the string "Facebook" into a job entry has to be found and updated, and if that job dies halfway through, some profiles say one thing and the rest say another. A competitor that stored an employer ID instead changed one row.</p>
<p>Nothing about the startup's data was wrong in 2010. It started out as a tree and quietly became a graph, and the data model decided which of these questions was cheap and which was a project. This chapter is about making that decision on purpose. It compares the <strong>relational</strong>, <strong>document</strong> and <strong>graph</strong> models, and the query languages built for each: declarative SQL, MapReduce, Cypher, SPARQL and Datalog.</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "why-data-models",
      title: "Every data model is a bet on which questions will be cheap",
      kicker: "Motivation",
      concepts: ["relational-model", "nosql", "polyglot-persistence"],
      blocks: [
        {
          type: "problem",
          html: `<p>Three engineers are choosing the database for a new professional-network product. The first says "PostgreSQL: it's what we know." The second says "MongoDB: profiles are JSON, and we'll ship faster." The third says "It's a social network, so obviously a graph database." Each is right about some slice of the data, which is exactly why the argument never ends.</p>
<p>A wrong choice doesn't hurt on day one. It hurts in year two, when a question that should take one line of query becomes a hand-written batch job, when a company renaming itself means rewriting millions of records, or when adding a field needs a maintenance window. Both naive strategies fail. "Pick whatever is fashionable, or whatever folklore says scales" ignores the shape of the data. "Find the one right database" ignores that a single application holds data of several shapes: résumés are trees, employers are shared entities, and connections between people form a graph.</p>`,
        },
        {
          type: "idea",
          html: `<p>A data model is a bet on which questions will be cheap to ask. No single bet wins for every access pattern, so the real skill is matching the model to the <strong>shape of your relationships</strong>, and accepting that one application may need more than one model.</p>`,
        },
        {
          type: "text",
          html: `<h3>Models all the way down</h3>
<p>Most software is a stack of models, and each layer describes its data using the layer underneath. Application developers start from the real world (people, companies, job changes, payments) and capture it as objects, data structures and the APIs that operate on them. Storing those structures means translating them into a <strong>general-purpose data model</strong>: rows in tables, JSON documents, or vertices and edges in a graph.</p>
<p>Inside the database, its engineers chose a byte layout for those tables, documents or graphs (in memory, on disk, over the network) that makes them fast to query and search (Chapter 3 opens that box). Further down, hardware turns bytes into voltages, magnetism and light. Every layer offers a clean interface over the mess beneath it, so the people working on one layer don't need to understand all the others.</p>`,
        },
        {
          type: "diagram",
          title: "Layers of data models",
          caption: "Each layer is expressed in terms of the one below and hides it. This chapter is about the violet layer: the general-purpose model your application's data is translated into, which decides which questions are easy to ask.",
          svg: `<svg viewBox="0 0 640 264" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four stacked layers: application objects, data model, storage engine, hardware; each represented in terms of the one below">
<defs>
<marker id="c2ly-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-muted)"/></marker>
</defs>
<rect x="16" y="8" width="544" height="46" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6); stroke-width: 1.5"/>
<text x="32" y="36" font-size="13"><tspan font-weight="700">Application:</tspan> objects and data structures</text>
<text x="544" y="36" text-anchor="end" font-size="12" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-c6)">user.positions[ ]</text>
<line x1="96" y1="56" x2="96" y2="74" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c2ly-a)"/>
<text x="108" y="70" font-size="12" style="fill: var(--viz-muted)">represented as</text>
<rect x="16" y="76" width="544" height="46" rx="10" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="32" y="104" font-size="13"><tspan font-weight="700">Data model:</tspan> tables, JSON documents, graphs</text>
<rect x="430" y="88" width="30" height="22" rx="2" style="fill: none; stroke: var(--viz-c1); stroke-width: 1.3"/>
<path d="M440 88 V110 M450 88 V110 M430 95.3 H460 M430 102.7 H460" style="fill: none; stroke: var(--viz-c1); stroke-width: 1"/>
<text x="488" y="105" text-anchor="middle" font-size="14" font-weight="700" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-c1)">{ }</text>
<path d="M520 92 L546 92 L533 108 Z" style="fill: none; stroke: var(--viz-c1); stroke-width: 1.3"/>
<circle cx="520" cy="92" r="4" style="fill: var(--viz-c1)"/>
<circle cx="546" cy="92" r="4" style="fill: var(--viz-c1)"/>
<circle cx="533" cy="108" r="4" style="fill: var(--viz-c1)"/>
<line x1="96" y1="124" x2="96" y2="142" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c2ly-a)"/>
<text x="108" y="138" font-size="12" style="fill: var(--viz-muted)">represented as</text>
<rect x="16" y="144" width="544" height="46" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="32" y="172" font-size="13"><tspan font-weight="700">Storage engine:</tspan> bytes in memory, on disk, on the network</text>
<text x="544" y="172" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">Chapter 3</text>
<line x1="96" y1="192" x2="96" y2="210" style="stroke: var(--viz-muted); stroke-width: 1.5; fill: none" marker-end="url(#c2ly-a)"/>
<text x="108" y="206" font-size="12" style="fill: var(--viz-muted)">represented as</text>
<rect x="16" y="212" width="544" height="46" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="32" y="240" font-size="13"><tspan font-weight="700">Hardware:</tspan> electrical currents, magnetic fields, pulses of light</text>
<path d="M572 10 H586 V256 H572" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.5"/>
<text x="604" y="133" text-anchor="middle" font-size="12" transform="rotate(90 604 133)" style="fill: var(--viz-muted)">each layer hides the one below</text>
</svg>`,
        },
        {
          type: "text",
          html: `<p>The middle layer matters more than it looks. It shapes how you reason about the problem, not just how the code looks. In any given model, some questions are natural and fast, some are clumsy or slow, and some are painful enough that teams quietly stop asking them. Choosing a model is choosing which of your future questions fall into which group.</p>
<p>This chapter compares three general-purpose models, <strong>relational</strong>, <strong>document</strong> and <strong>graph</strong>, together with the query languages built for them: SQL, MongoDB's query and aggregation APIs and MapReduce, Cypher, SPARQL and Datalog. How each model is laid out on disk is Chapter 3's subject; how data is encoded when it travels between processes is Chapter 4's.</p>`,
        },
        {
          type: "timeline",
          title: "Fifty years of data-model fashions",
          items: [
            { year: "1968", html: `IBM ships <strong>IMS</strong>, a hierarchical database originally built for stock-keeping in the Apollo space program.` },
            { year: "1970", html: `Edgar Codd publishes the <strong>relational model</strong> in Communications of the ACM. Many doubt it can be implemented efficiently.` },
            { year: "1970s", html: `The <strong>network model</strong> (standardized by the CODASYL committee) and the hierarchical model are the main alternatives to relational.` },
            { year: "1979", html: `Oracle V2 ships; it is generally cited as the first commercially available SQL relational database.` },
            { year: "Mid-1980s", html: `Relational databases with SQL become the standard tool for business data processing.` },
            { year: "Late 1980s", html: `<strong>Object databases</strong> promise to remove the gap between objects and tables. They stay niche.` },
            { year: "Early 2000s", html: `<strong>XML databases</strong> have their turn. They stay niche too.` },
            { year: "2006–07", html: `Google's Bigtable and Amazon's Dynamo papers inspire HBase, Cassandra, Riak and Voldemort.` },
            { year: "2009", html: `"<strong>NoSQL</strong>" appears as a hashtag for a meetup, and becomes the name of a movement.` },
            { year: "2012", html: `Google's <strong>Spanner</strong> paper shows a globally distributed database with transactions; a full SQL engine follows (SIGMOD 2017).` },
          ],
        },
        {
          type: "text",
          html: `<h3>Why relational won, and kept winning</h3>
<p>Codd's 1970 proposal was radically simple: all data lives in <strong>relations</strong> (SQL calls them tables), and a relation is nothing more than an unordered set of <strong>tuples</strong> (rows). By the mid-1980s, relational database systems with SQL had become the default for anyone storing data with some regular structure, and they have stayed dominant ever since.</p>
<p>The relational model grew up on the mainframes of business data processing, running <em>transaction processing</em> (sales, bank transfers, airline bookings) and <em>batch processing</em> (invoices, payroll, reports). Codd's aim was to hide how the data was physically stored behind a simpler interface. The real triumph is how far that interface stretched: the same model now runs publishing, social networks, e-commerce, games and SaaS products, most of which look nothing like payroll. Each challenger in the timeline above generated hype, found niches, and faded without displacing it.</p>
<h3>NoSQL: a hashtag, not a technology</h3>
<p>The latest wave got its name almost by accident. "NoSQL" was a catchy Twitter hashtag for a 2009 meetup about open-source, distributed, non-relational databases, later reinterpreted as "Not Only SQL". It names a movement, not a technology: key-value stores, wide-column stores, document databases and graph databases have little in common beyond what they are not. Four forces drove adoption:</p>
<ol>
<li><strong>Scale:</strong> datasets, or write throughput, bigger than the relational products of the time could easily handle.</li>
<li><strong>Open source:</strong> a widespread preference for free software over expensive commercial databases.</li>
<li><strong>Specialized queries:</strong> operations the relational model supports poorly, such as following deep chains of relationships.</li>
<li><strong>Schema frustration:</strong> a wish for a more dynamic, expressive data model than rigid relational schemas allowed.</li>
</ol>
<h3>Two myths to retire</h3>
<p>"Relational can't scale" confuses a model with particular implementations in a particular era. Nothing about tables, rows and joins forbids partitioning data across machines, and distributed SQL databases now do exactly that. "NoSQL means no schema" is the other myth: the data still has a structure that every reader depends on; it just isn't declared in one place (see <a href="#/ch2/learn/schema-flexibility">Schemaless isn't schema-free</a>).</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "IBM IMS",
              title: "The original document-shaped database",
              year: "1968",
              tag: "hierarchical",
              html: `<p>IBM's Information Management System was developed for stock-keeping in the Apollo space program and first released commercially in 1968. It stored records as nested trees, the design that document databases echo today (see <a href="#/ch2/learn/repeating-history">Document databases are repeating history</a>).</p>`,
            },
            {
              org: "Edgar F. Codd / IBM Research",
              title: "The relational model",
              year: "1970",
              tag: "paper",
              html: `<p>Codd's "A Relational Model of Data for Large Shared Data Banks" appeared in Communications of the ACM in 1970, and he received the Turing Award in 1981. Oracle V2 (1979) is generally cited as the first commercially available SQL relational database.</p>`,
            },
            {
              org: "The NoSQL meetup",
              title: "A name that outgrew its event",
              year: "2009",
              tag: "origin",
              html: `<p>The hashtag was coined for a meetup on open-source, distributed, non-relational databases, widely reported as held in San Francisco in June 2009 and organized by Johan Oskarsson. The label quickly came to stand for the whole wave of non-relational systems.</p>`,
            },
            {
              org: "Google Spanner and distributed SQL",
              title: "Scale without giving up SQL",
              year: "2012",
              tag: "distributed SQL",
              html: `<p>Spanner (OSDI 2012) showed a globally distributed database with transactions; the SIGMOD 2017 paper "Spanner: Becoming a SQL System" describes its full SQL engine. CockroachDB (1.0 in 2017), YugabyteDB and TiDB followed, undercutting the idea that scale requires giving up the relational model.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book, the camps have kept converging. Distributed SQL databases (Spanner, CockroachDB, YugabyteDB, TiDB) partition relational tables across many machines with transactions, removing the main reason scale once implied NoSQL. PostgreSQL and MySQL store and index JSON; MongoDB gained joins (<code>$lookup</code>) and multi-document transactions. Vector similarity search followed the same arc: it arrived as specialized vector databases, and general-purpose databases soon added vector indexes (for example the pgvector extension for PostgreSQL). Many products are now multi-model, so the useful question is no longer "SQL or NoSQL?" but "which model fits this access pattern?"</p>`,
        },
        {
          type: "text",
          html: `<h3>Polyglot persistence</h3>
<p>Different applications have different needs, and so do different parts of one application. The realistic future is not one winner but <strong>polyglot persistence</strong>: relational databases used alongside a variety of non-relational stores, each chosen for the access pattern it serves. The price is operational: more systems to run and upgrade, and more copies of data to keep consistent (Chapter 11's change data capture and Chapter 12's derived data are about doing that safely).</p>
<p>So, back to the three engineers: each wins a slice. The profile itself (summary, positions, schools) is a self-contained tree loaded as a unit, so it fits a document, or a JSON column in PostgreSQL. Employers, schools and regions are shared entities that many profiles point to, so they belong in one place behind an ID, which means joins. "People you may know" walks connections of unknown depth, the home ground of a graph database or a precomputed index. That is this chapter's thesis in a paragraph; the sections that follow justify each part.</p>
<p>Some data fits none of the three: similarity search over genome databases such as GenBank, petabyte-scale particle-physics analysis at the Large Hadron Collider, and full-text search over inverted indexes (Chapter 3). When a domain's questions are different enough, it grows a specialized model of its own.</p>`,
        },
        {
          type: "keypoints",
          title: "The three models in this chapter",
          items: [
            `<strong>Relational:</strong> flat tables; relationships expressed by IDs and resolved by joins. Best when many-to-one and many-to-many relationships dominate and you need ad-hoc queries.`,
            `<strong>Document:</strong> self-contained trees (JSON). Best for one-to-many data that is loaded and saved together, with few references between documents.`,
            `<strong>Graph:</strong> anything may relate to anything. Best when the relationships are the point and queries follow connections of unknown depth.`,
            `<strong>Query languages:</strong> declarative ones (SQL, Cypher, SPARQL, Datalog) let the database decide how to find the data; MapReduce sits halfway between declarative and imperative.`,
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Which database would you use?" is rarely a test of brand knowledge. Interviewers listen for whether you start from the shape of the data and the access patterns. A strong answer sounds like: "Profiles are tree-shaped and read whole, so a document or a JSON column. Companies are shared and get renamed, so they're entities referenced by ID. Connection queries are multi-hop, so a graph store or a precomputed index, kept in sync by change data capture." Then name the cost: every extra store is another system to operate and another copy to keep consistent. "MongoDB because it scales" or "SQL because it's ACID", with no reference to the queries, is the classic weak answer.</p>`,
        },
        {
          type: "quiz",
          q: "A teammate says: \"We need NoSQL because relational databases can't scale.\" What's the best response, based on this chapter?",
          options: [
            "Agree: the relational model forbids partitioning a table across machines.",
            "Scale was one historical driver, but it described particular products, not the model: distributed SQL databases partition relational data today. Choose the model by the shape of your data and queries.",
            "Disagree: NoSQL databases never scale better than relational ones.",
            "Agree, because NoSQL databases have no schema, which makes them faster.",
          ],
          answer: 1,
          explain: "NoSQL rose for four reasons (scale, open source, specialized queries, schema flexibility), and the scale complaint was about the relational products of the late 2000s. Spanner, CockroachDB and others partition relational data today. Option C overcorrects: some non-relational stores really were easier to scale out for particular workloads. Option D repeats two myths: 'schemaless' data still has an implicit schema, and a missing schema doesn't make anything faster by itself.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "impedance-mismatch",
      title: "One résumé, four tables: the object-relational mismatch",
      kicker: "Relational vs document",
      concepts: ["object-relational-impedance-mismatch", "document-model", "relational-model"],
      blocks: [
        {
          type: "problem",
          html: `<p>Picture a profile page on a professional network: a user with a name and a short summary, a list of past jobs, a list of schools and a few contact links. In application code that's one object holding a few collections. A normalized relational schema shreds it into four tables (<code>users</code>, plus <code>positions</code>, <code>education</code> and <code>contact_info</code>, each keyed by <code>user_id</code>), so loading one profile takes a multi-way join or a burst of queries, and saving it touches four tables.</p>
<p>An ORM such as Hibernate or Active Record writes that translation for you, but the abstraction leaks. With lazy loading, one page view quietly becomes a query for the user, a query for the list of positions, and then one more query per position to fetch its company. The naive escape, serializing the whole object into a single text column, gets you one read, but now the database can't see inside the profile to query or index it.</p>`,
        },
        {
          type: "idea",
          html: `<p>When data is a self-contained tree of one-to-many relationships that is loaded and saved as a unit, storing it as one <strong>document</strong> removes the translation layer and gives <strong>locality</strong>: a single read fetches the whole tree.</p>`,
        },
        {
          type: "text",
          html: `<h3>A profile has one-to-many parts</h3>
<p>Take one profile, user 251. Some fields occur exactly once per user: <code>first_name</code>, <code>last_name</code>, <code>summary</code>. They map cleanly onto columns of a <code>users</code> table. But most people have held more than one job, studied at more than one school, and list more than one way to reach them. Each of those is a <strong>one-to-many</strong> relationship from the user to a collection, and a single row has no natural slot for a collection. Relational designers have three options:</p>
<ol>
<li><strong>Normalize into separate tables.</strong> Positions, education and contact info each get a table with a foreign key back to <code>users</code>. This is the traditional design, shown on the left of the diagram below.</li>
<li><strong>Use structured types or a queryable document column.</strong> SQL:1999 added structured types and arrays, and Oracle, IBM DB2, SQL Server and PostgreSQL support XML and/or JSON columns that the database can query and index inside. Several items live in one row and stay visible to queries.</li>
<li><strong>Store an opaque blob.</strong> Encode jobs, schools and contacts as JSON or XML text in a plain text column and let the application parse it. Simple, but the database can't look inside, so you can't query or index by school or job title.</li>
</ol>
<p>A document database takes a fourth view: the profile <em>is</em> the record. Positions and education become arrays inside it, contact info becomes a nested object, and the one-to-many relationships form an explicit <strong>tree</strong>.</p>`,
        },
        {
          type: "diagram",
          title: "The same profile as tables and as a tree",
          caption: "Left: normalized, the profile is spread over four tables linked by foreign keys, and reading it means joining them back together. Right: as a document, the one-to-many parts nest under the user, and the whole tree is one record.",
          svg: `<svg viewBox="0 0 640 304" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a users table with three child tables positions, education and contact_info pointing back to it. Right: a tree rooted at user 251 with branches positions, education and contact_info">
<defs>
<marker id="c2im-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-c2)"/></marker>
</defs>
<rect x="84" y="8" width="156" height="24" rx="4" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="162" y="25" text-anchor="middle" font-size="13" font-weight="700">users</text>
<rect x="84" y="32" width="156" height="78" style="fill: var(--viz-node); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="94" y="50" font-size="12" font-family="ui-monospace, Menlo, monospace">user_id PK</text>
<text x="94" y="68" font-size="12" font-family="ui-monospace, Menlo, monospace">first_name</text>
<text x="94" y="86" font-size="12" font-family="ui-monospace, Menlo, monospace">last_name</text>
<text x="94" y="104" font-size="12" font-family="ui-monospace, Menlo, monospace">summary</text>
<rect x="8" y="150" width="98" height="24" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="57" y="167" text-anchor="middle" font-size="12" font-weight="700">positions</text>
<rect x="8" y="174" width="98" height="78" style="fill: var(--viz-node); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="16" y="192" font-size="12" font-family="ui-monospace, Menlo, monospace">id</text>
<text x="16" y="210" font-size="12" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-c2)">user_id FK</text>
<text x="16" y="228" font-size="12" font-family="ui-monospace, Menlo, monospace">job_title</text>
<text x="16" y="246" font-size="12" font-family="ui-monospace, Menlo, monospace">org</text>
<rect x="112" y="150" width="98" height="24" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="161" y="167" text-anchor="middle" font-size="12" font-weight="700">education</text>
<rect x="112" y="174" width="98" height="78" style="fill: var(--viz-node); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="120" y="192" font-size="12" font-family="ui-monospace, Menlo, monospace">id</text>
<text x="120" y="210" font-size="12" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-c2)">user_id FK</text>
<text x="120" y="228" font-size="12" font-family="ui-monospace, Menlo, monospace">school</text>
<text x="120" y="246" font-size="12" font-family="ui-monospace, Menlo, monospace">start, end</text>
<rect x="216" y="150" width="104" height="24" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="268" y="167" text-anchor="middle" font-size="12" font-weight="700">contact_info</text>
<rect x="216" y="174" width="104" height="78" style="fill: var(--viz-node); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="224" y="192" font-size="12" font-family="ui-monospace, Menlo, monospace">id</text>
<text x="224" y="210" font-size="12" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-c2)">user_id FK</text>
<text x="224" y="228" font-size="12" font-family="ui-monospace, Menlo, monospace">type</text>
<text x="224" y="246" font-size="12" font-family="ui-monospace, Menlo, monospace">url</text>
<line x1="57" y1="148" x2="118" y2="113" style="stroke: var(--viz-c2); stroke-width: 1.5; fill: none" marker-end="url(#c2im-a)"/>
<line x1="161" y1="148" x2="162" y2="113" style="stroke: var(--viz-c2); stroke-width: 1.5; fill: none" marker-end="url(#c2im-a)"/>
<line x1="268" y1="148" x2="206" y2="113" style="stroke: var(--viz-c2); stroke-width: 1.5; fill: none" marker-end="url(#c2im-a)"/>
<text x="162" y="278" text-anchor="middle" font-size="13" font-weight="700">1 profile = rows in 4 tables</text>
<text x="162" y="296" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">read = a 4-way join, or 4 queries</text>
<line x1="330" y1="8" x2="330" y2="296" style="stroke: var(--viz-line); stroke-width: 1; fill: none"/>
<rect x="436" y="12" width="104" height="34" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="488" y="34" text-anchor="middle" font-size="13" font-weight="700">user 251</text>
<path d="M488 46 L386 96 M488 46 L485 96 M488 46 L584 96" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.5"/>
<rect x="338" y="96" width="96" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="386" y="115" text-anchor="middle" font-size="12">positions[]</text>
<rect x="437" y="96" width="96" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="485" y="115" text-anchor="middle" font-size="12">education[]</text>
<rect x="536" y="96" width="96" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="584" y="115" text-anchor="middle" font-size="12">contact_info{}</text>
<path d="M348 126 V196 M348 160 H356 M348 196 H356 M447 126 V196 M447 160 H455 M447 196 H455 M546 126 V196 M546 160 H554 M546 196 H554" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.3"/>
<rect x="356" y="146" width="78" height="28" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="395" y="165" text-anchor="middle" font-size="12">Engineer</text>
<rect x="356" y="182" width="78" height="28" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="395" y="201" text-anchor="middle" font-size="12">Intern</text>
<rect x="455" y="146" width="78" height="28" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="494" y="165" text-anchor="middle" font-size="12">State U</text>
<rect x="455" y="182" width="78" height="28" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="494" y="201" text-anchor="middle" font-size="12">College</text>
<rect x="554" y="146" width="78" height="28" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="593" y="165" text-anchor="middle" font-size="12">blog</text>
<rect x="554" y="182" width="78" height="28" rx="5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="593" y="201" text-anchor="middle" font-size="12">website</text>
<text x="486" y="278" text-anchor="middle" font-size="13" font-weight="700">1 profile = 1 document</text>
<text x="486" y="296" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">read = 1 lookup by key</text>
</svg>`,
        },
        {
          type: "code",
          lang: "json",
          title: "User 251 as one JSON document",
          code: `{
  "user_id": 251,
  "first_name": "Maya",
  "last_name": "Okafor",
  "summary": "Backend engineer who likes boring, reliable databases.",
  "region_id": "r:204",
  "industry_id": 47,
  "positions": [
    { "job_title": "Staff Engineer",   "org": "Northwind Logistics" },
    { "job_title": "Software Intern",  "org": "Tailspin Toys" }
  ],
  "education": [
    { "school_name": "State University",       "start": 2008, "end": 2012 },
    { "school_name": "Lakeside Community College", "start": 2006, "end": 2008 }
  ],
  "contact_info": {
    "blog":    "https://maya.example.com",
    "website": "https://okafor.example.dev"
  }
}`,
          caption: "Arrays hold the one-to-many parts and a nested object holds the contact links. Notice that <code>region_id</code> and <code>industry_id</code> are already IDs, while each <code>org</code> is a plain string; the next section explains why that difference matters.",
        },
        {
          type: "text",
          html: `<h3>Locality: one read instead of a join</h3>
<p>To render the profile from the normalized schema, the database must either join <code>users</code> with three child tables or answer several separate queries, each of which may touch a different place on disk. The document is one lookup by key, with everything stored together. This property, <strong>locality</strong>, is the document model's main performance argument for tree-shaped data; <a href="#/ch2/learn/locality-and-convergence">Locality, simpler code, and convergence</a> looks at where it stops paying off.</p>
<h3>What "impedance mismatch" really means</h3>
<p>The term is borrowed from electronics, where joining two circuits whose impedances don't match wastes power at the connection. Here the connection is the boundary between objects in memory and rows in tables, and the mismatch has three parts:</p>
<ul>
<li><strong>Shape:</strong> objects nest collections inside each other; relations are flat sets of rows.</li>
<li><strong>Identity:</strong> an object refers to another by memory reference; a row refers to another by a key value.</li>
<li><strong>Navigation:</strong> code follows a reference (<code>position.company</code>); the database performs a join.</li>
</ul>
<p>Object-relational mapping frameworks such as Hibernate (Java) and Active Record (Ruby on Rails) remove most of the boilerplate this translation needs, but they can't make those differences disappear. The best-known symptom is the <strong>N+1 queries problem</strong>:</p>`,
        },
        {
          type: "code",
          lang: "pseudocode",
          title: "N+1 queries from lazy loading (generic ORM pseudocode)",
          code: `user = User.find(251)              # query 1:  SELECT * FROM users WHERE id = 251
for job in user.positions:         # query 2:  SELECT * FROM positions WHERE user_id = 251
    show(job.title, job.company.name)
                                   # queries 3..14, one per position:
                                   #           SELECT * FROM companies WHERE id = ?

# 12 positions -> 1 + 1 + 12 = 14 round trips to render one profile`,
        },
        {
          type: "text",
          html: `<p>Loading a collection lazily costs one query; the N comes from touching a lazy association on each element of it. The name counts one query for a list plus one per element, and here there's an extra query for the user, so a profile with 12 positions costs 14 round trips, and a search page showing 20 profiles can cost hundreds. Each query is fast on its own, so nobody notices until latency creeps up under load.</p>
<p>The fix is a loading strategy, not a new database. Eager loading (<code>includes</code> or <code>preload</code> in Rails, fetch joins or entity graphs in JPA and Hibernate) or batching replaces the per-row lookups with one <code>IN (…)</code> query, and plain SQL can fetch the whole page in a single join. N+1 is a property of lazy loading in an ORM, not a limitation of the relational model.</p>
<p>JSON brings problems of its own as an encoding, such as ambiguous number precision and no built-in schema; Chapter 4 covers them. And the tree above has a weak spot: it stays clean only while every child belongs to exactly one parent. Look at the <code>org</code> strings. Many profiles name the same employer, and the next section shows how that one shared fact breaks the tree.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Ruby on Rails / Hibernate",
              title: "N+1 is common enough to have tooling",
              tag: "ORM",
              html: `<p>Rails provides <code>includes</code>, <code>preload</code> and <code>eager_load</code> to load associations up front, and Hibernate/JPA offer fetch joins and entity graphs. The popular Rails gem Bullet exists specifically to detect N+1 queries during development.</p>`,
            },
            {
              org: "PostgreSQL",
              title: "Option 2, built in",
              year: "2012–2014",
              tag: "JSON",
              html: `<p>PostgreSQL added a <code>json</code> type in 9.2 (2012), JSON operators and functions in 9.3 (2013), and the binary, indexable <code>jsonb</code> type in 9.4 (2014). A profile's nested parts can live in one column, with a GIN index serving containment queries such as "profiles listing State University".</p>`,
            },
            {
              org: "LinkedIn Espresso",
              title: "A document store at a professional network",
              year: "2013",
              tag: "paper",
              html: `<p>LinkedIn built Espresso, a distributed document store whose documents follow Avro schemas, described in the SIGMOD 2013 paper "On Brewing Fresh Espresso: LinkedIn's Distributed Data Serving Platform". It shows a document-oriented design serving data at a large professional network.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>A lot of today's tree-versus-tables translation happens in the API layer instead of the ORM. With GraphQL (open-sourced by Facebook in 2015), a client asks for a tree-shaped result, such as a user with positions and each position's company, and per-field resolvers fetch the pieces from tables or other services. Naive resolvers reproduce N+1 one layer up, which is why Facebook's companion DataLoader library batches and caches lookups within a request. Meanwhile JSONB columns have made the "queryable document column" option mainstream, so tables versus documents is often a per-column decision rather than a per-database one.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Storing the profile as one document",
          prosLabel: "What you gain",
          consLabel: "What you pay",
          pros: [
            "One read fetches the whole profile (locality): no joins, no N+1.",
            "The stored shape matches the objects in code, so there's no mapping layer to write and debug for the tree.",
            "New fields can be added without a migration (with a catch; see \"Schemaless isn't schema-free\").",
            "A whole profile is easy to keep on one partition when the data is spread over machines (Chapter 6).",
          ],
          cons: [
            "Shared facts (employers, schools, regions) end up copied into many documents unless you reference them by ID.",
            "Questions that cut across trees (\"everyone who studied at State University\") need indexes on embedded fields, or a scan.",
            "You can't point directly at a nested item; you address it by a path inside its parent.",
            "Reads and updates usually handle the whole document, which wastes work as documents grow large.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A common pair of questions: "What is the object-relational impedance mismatch?" and then "So would you pick a document database to avoid it?" A strong answer defines the mismatch concretely (shape, identity, navigation), names N+1 with the right arithmetic (1 + 1 + N), and gives the fixes (eager loading, batching, a join) plus how you'd catch it: query logs, APM traces, or a detector like Bullet. Then the nuance: documents remove the translation only for tree-shaped data loaded as a unit. As soon as items are shared between records (employers, tags, other users), you are back to references and joins.</p>`,
        },
        {
          type: "quiz",
          q: "A profile page shows a user with 12 positions, each displaying its company's name. The ORM lazy-loads every association. How many queries does one page view issue, and what would an embedded-document design change?",
          options: [
            "1 query: ORMs always join associations automatically.",
            "About 14: 1 for the user, 1 that loads the positions collection, then 1 per position for its company (12). An embedded document returns the user and positions in one read, but each company name then becomes a copy stored inside the profile.",
            "25: one query per position, one per company, plus one for the user.",
            "None after the first view, so the data model doesn't matter.",
          ],
          answer: 1,
          explain: "Loading a collection lazily is a single query; the N comes from touching one lazy association per element, giving the classic shape of one list query plus one per element, plus the initial user query. Option C is tempting but double-counts: the 12 positions arrive together in one query, not one each. Embedding gives one read with locality, but it buys that by copying shared data (company names) into every profile, which is exactly the problem of the next section. Eager loading or a single SQL join would also fix the query count without changing the data model.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "many-to-one",
      title: "IDs, not strings: why many-to-one pulls you back to joins",
      kicker: "Relational vs document",
      concepts: ["many-to-one-many-to-many", "normalization", "denormalization", "application-side-join"],
      blocks: [
        {
          type: "problem",
          html: `<p>Why did the profile store <code>region_id</code> rather than a region name? Imagine region were a plain string, like <code>org</code>, typed freehand by every user. Then the same place shows up as "Greater Seattle Area", "Seattle area", "Seattle, WA" and "Greater Seatle Area". You can't tell the many towns called Springfield apart. Renaming a region means rewriting millions of copies. Translating the site means translating every user's free text. And a search for engineers in Washington state has no way to know that Seattle is in it.</p>
<p>The obvious fix is to store an ID that points to one canonical record: many users point to one region, a <strong>many-to-one</strong> relationship. But that breaks the tree. The region belongs to no single profile, so a document database must either copy it into every profile or store the ID and look it up separately, and without joins in the database, the application does that lookup itself. Data also gets more connected over time, never less: employers become company pages, users recommend each other, and the tree turns into a graph.</p>`,
        },
        {
          type: "idea",
          html: `<p>Anything meaningful to humans that might change belongs in exactly one place, referenced by an ID. That removes duplication (<strong>normalization</strong>), but it means reads need <strong>joins</strong>, which relational databases do natively and early document databases pushed onto application code.</p>`,
        },
        {
          type: "text",
          html: `<h3>Five reasons to store an ID instead of text</h3>
<p>This is why sign-up forms offer a dropdown or an autocomplete for region and industry rather than a free-text box. The user picks from a standardized list, the form stores an ID, and you get:</p>
<ul>
<li><strong>Consistent style and spelling</strong> across all profiles.</li>
<li><strong>No ambiguity</strong> when several places share a name.</li>
<li><strong>Easy updates:</strong> the name lives in one place, so when a city is renamed (it happens, often after a political change), one write fixes every profile.</li>
<li><strong>Localization:</strong> translate the list once, and every profile shows the region in the reader's language.</li>
<li><strong>Better search:</strong> record once that Seattle is in Washington, and a search for people in Washington finds the Seattle profiles too.</li>
</ul>
<p>Behind all five sits one question: <strong>duplication</strong>. An ID carries no meaning, so nothing ever forces it to change. Names, spellings and labels do change, and when one is copied into many records, every copy has to change with it: extra write work, plus the risk that some copies are missed and the records disagree. That disagreement is called an <strong>update anomaly</strong>, and removing the duplication that causes it is <strong>normalization</strong>. You don't need the textbook normal forms to apply the idea: if you're storing the same value in many places when it could be stored once and referenced, the schema isn't normalized.</p>
<h3>Three shapes of relationship</h3>
<p><strong>One-to-many:</strong> a user has many positions, and each position belongs to one user. That fits a tree. <strong>Many-to-one:</strong> many users live in one region, or work at one company; the shared record has no single parent, so it doesn't fit a tree. <strong>Many-to-many:</strong> users recommend other users, and people work at many organizations that each employ many people. That's a graph.</p>`,
        },
        {
          type: "diagram",
          title: "When profiles start pointing at things",
          caption: "Each profile still nests its own positions (one-to-many). But the employer is now a shared entity that many positions point to by ID (many-to-one), and a recommendation links one user's profile to another's (many-to-many). Neither of the last two fits inside a single tree.",
          svg: `<svg viewBox="0 0 640 312" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two profile documents, Ana and Ben, each with a nested position that references the shared organization Acme Corp by id o1; Ben's profile recommends Ana's">
<defs>
<marker id="c2mo-c3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-c3)"/></marker>
<marker id="c2mo-c5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-c5)"/></marker>
</defs>
<rect x="16" y="12" width="236" height="100" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="30" y="34" font-size="13" font-weight="700">Ana · profile document</text>
<rect x="30" y="46" width="208" height="54" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="40" y="66" font-size="12" font-weight="700">positions[ ]</text>
<text x="40" y="88" font-size="12" font-family="ui-monospace, Menlo, monospace">Engineer · org_id: o1</text>
<rect x="16" y="170" width="236" height="100" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="30" y="192" font-size="13" font-weight="700">Ben · profile document</text>
<rect x="30" y="204" width="208" height="54" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="40" y="224" font-size="12" font-weight="700">positions[ ]</text>
<text x="40" y="246" font-size="12" font-family="ui-monospace, Menlo, monospace">Analyst · org_id: o1</text>
<line x1="70" y1="168" x2="70" y2="116" style="stroke: var(--viz-c5); stroke-width: 2; fill: none" marker-end="url(#c2mo-c5)"/>
<text x="82" y="146" font-size="12" font-weight="600" style="fill: var(--viz-c5)">recommends</text>
<rect x="420" y="96" width="204" height="84" rx="10" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3); stroke-width: 1.5"/>
<text x="522" y="124" text-anchor="middle" font-size="14" font-weight="700">Acme Corp</text>
<text x="522" y="146" text-anchor="middle" font-size="12">id o1 · logo · page · news</text>
<text x="522" y="166" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">stored once</text>
<line x1="240" y1="84" x2="416" y2="127" style="stroke: var(--viz-c3); stroke-width: 1.8; fill: none" marker-end="url(#c2mo-c3)"/>
<line x1="240" y1="240" x2="416" y2="152" style="stroke: var(--viz-c3); stroke-width: 1.8; fill: none" marker-end="url(#c2mo-c3)"/>
<text x="330" y="96" text-anchor="middle" font-size="12" style="fill: var(--viz-c3)">org_id</text>
<text x="310" y="150" text-anchor="middle" font-size="12" font-weight="600" style="fill: var(--viz-c3)">many positions → one org</text>
<rect x="16" y="291" width="14" height="10" rx="2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.2"/>
<text x="36" y="300" font-size="12">one-to-many: nested</text>
<rect x="186" y="291" width="14" height="10" rx="2" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3); stroke-width: 1.2"/>
<text x="206" y="300" font-size="12">many-to-one: shared entity</text>
<line x1="400" y1="296" x2="414" y2="296" style="stroke: var(--viz-c5); stroke-width: 2.5; fill: none"/>
<text x="420" y="300" font-size="12">many-to-many: users ↔ users</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>Who does the join?</h3>
<p>In a relational database, referring to a region or a company by ID is routine: a foreign key, and a join at read time. Document databases of the book's era had weak join support or none, because one-to-many trees don't need joins. So a many-to-one reference meant an <strong>application-side join</strong>: fetch the profile, collect its org IDs, fetch those orgs in a second request, and stitch the results together in code. Small, slow-changing lists such as regions and industries can be cached in application memory to save the round trip, but the work of joining has still moved out of the database and into your code.</p>
<p>The pressure only grows. Once organizations and schools become entities with their own pages (a logo, a news feed), a position should reference the organization rather than hold its name as a string. Add recommendations, where one user endorses another and the page must show the recommender's <em>current</em> name and photo, and you have a many-to-many relationship between users. Data that started as a forest of independent trees is now a web of references.</p>
<p>The visualization below puts the choices side by side: six profile documents on the left (with employer names embedded, or with references), and the same data as three normalized tables on the right.</p>`,
        },
        {
          type: "viz",
          id: "ch2/normalize-or-embed",
          title: "Embed or reference?",
          caption: "Pick an operation and press <b>▶ Run</b>: <b>Load Ana's profile</b>, then <b>Rename Acme</b> with <b>Crash mid-write</b> switched on, then <b>Who worked at Acme?</b>; repeat with <b>Reference ids</b>. Notice that embedding wins the load (1 read against 5 joined rows), but the crash leaves two profiles still saying \"Acme Corp\" (and the reverse query, searching for the new name, silently skips them), while the relational row and the reference design rename with one write that can't be half-done.",
        },
        {
          type: "text",
          html: `<p>The four experiments tell the whole story:</p>
<ul>
<li><strong>Load a profile.</strong> Embedding wins: one document, one read, against five rows from three tables joined together. With references, your code makes a second request for the organizations: the application-side join.</li>
<li><strong>Rename Acme.</strong> Normalization wins: one write to one row. The embedded design must find and rewrite every copy, 4 of 6 profiles here and potentially millions in production.</li>
<li><strong>Crash mid-rename.</strong> Two profiles say "Acme Inc" and two still say "Acme Corp": the update anomaly, made visible. An update that spans several documents isn't atomic unless you wrap it in a transaction.</li>
<li><strong>Who worked at Acme?</strong> Profiles are trees rooted at users, so the reverse question scans them, unless you index the embedded field. After a half-done rename it's worse: a search for "Acme Inc" silently misses the profiles that still say "Acme Corp". Real document databases support that (a MongoDB multikey index covers every element of an array such as <code>positions.org_id</code>); the demo just has no such index, and in production you have to plan for one.</li>
</ul>
<h3>Denormalization is a trade, not a sin</h3>
<p>None of this means "never copy". <strong>Denormalization</strong>, storing a copy on purpose, is a legitimate read optimization: keep the org ID, and next to it a copy of the display name and logo URL, so the profile page renders without a join. MongoDB's data-modeling guidance calls this the <em>extended reference</em> pattern. It works best for fields that rarely change and are only displayed.</p>
<p>Be clear about what you bought, though. A denormalized copy is a cache. It goes stale when the source changes, every rename fans out into many writes, and something has to keep the copies in step: a background job, or better, change data capture from the source of truth (Chapter 11) feeding derived views (Chapter 12). Updating several records together safely is the job of multi-record transactions (Chapter 7).</p>`,
        },
        {
          type: "compare",
          title: "Embed, reference, or both?",
          items: [
            {
              title: "Embed",
              tone: "ok",
              html: `<p>The child is <strong>owned by one parent</strong>, <strong>bounded</strong> in size, and <strong>read together</strong> with it; it's rarely updated on its own.</p><p><em>Examples:</em> a profile's contact links, an order's line items.</p>`,
            },
            {
              title: "Reference",
              tone: "info",
              html: `<p>The child is <strong>shared</strong> by many parents, <strong>unbounded</strong> (comments, events), <strong>updated independently</strong>, or <strong>queried on its own</strong> ("all users at Acme").</p><p><em>Examples:</em> a position's company, a post's comments.</p>`,
            },
            {
              title: "Reference + copy",
              tone: "warn",
              html: `<p>A hot read path needs a display field that <strong>rarely changes</strong>, and you can tolerate brief staleness and run a sync job.</p><p><em>Example:</em> <code>org_id</code> plus a copied company name and logo.</p>`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Wikidata",
              title: "IDs at planetary scale",
              tag: "knowledge base",
              html: `<p>Every Wikidata entity has a language-independent identifier (Q42 is Douglas Adams), and labels in many languages hang off that single ID. Localization and renames happen in one place, which is the book's argument for standardized lists, applied to a whole encyclopedia.</p>`,
            },
            {
              org: "Amazon DynamoDB",
              title: "Single-table design",
              tag: "denormalization",
              html: `<p>DynamoDB's "single-table design", popularized by AWS re:Invent talks and Alex DeBrie's <em>The DynamoDB Book</em> (2020), stores differently typed items that are read together under one partition key, so a single Query returns a pre-joined "item collection". It's denormalization designed around access patterns known in advance.</p>`,
            },
            {
              org: "Apache Cassandra",
              title: "Query-first modeling",
              tag: "wide-column",
              html: `<p>Cassandra's data-modeling guidance starts from the queries: design one table per query and denormalize data across those tables, because CQL has no joins. The cost is that every write must update each table that holds a copy.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Document databases have since conceded that many-to-one data needs joins in the database. MongoDB added the <code>$lookup</code> stage (a left outer join inside the aggregation pipeline) in 3.2 (2015) and the recursive <code>$graphLookup</code> in 3.4 (2016), then multi-document ACID transactions in 4.0 (2018) for replica sets and 4.2 (2019) for sharded clusters. A rename that touches many embedded copies can now be made all-or-nothing, at a cost in throughput. The modern question is no longer whether you can join, but which access patterns should pay for it.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Normalizing a shared fact",
          prosLabel: "Store once, reference by ID",
          consLabel: "What it costs",
          pros: [
            "A change is one write, and it can't leave copies disagreeing.",
            "Consistent spelling, no ambiguity, easy localization and smarter search.",
            "Reverse questions (\"who worked at Acme?\") follow an index on the foreign key.",
            "Records stay smaller, with no copies to keep in sync.",
          ],
          cons: [
            "Every read that displays the fact needs a join, in the database or in your code.",
            "Application-side joins add round trips and code.",
            "Less locality: one page view reads several places on disk.",
            "Joins across partitions get expensive once data is spread over machines (Chapter 6).",
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          html: `<p>Two embedding mistakes are especially common. The first is embedding <strong>mutable shared entities</strong>: employer names, product prices, user avatars and display names. They look like static strings on day one and turn into a fan-out rewrite, and a source of disagreeing copies, the first time they change. The second is embedding <strong>unbounded arrays</strong>, such as every comment inside the post document or every event inside the user document. The document grows with each write, every read drags the whole history along, and eventually it hits a hard ceiling (MongoDB caps a document at 16 MB; <a href="#/ch2/learn/locality-and-convergence">Locality, simpler code, and convergence</a> shows the fix).</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design the storage for a professional-network profile" is a classic, and interviewers want you to classify each relationship before you name a database. A strong answer: positions, education and contact links are one-to-many and read with the profile, so embed them (or use a JSON column). Companies, schools, regions and skills are many-to-one, so reference them by ID, perhaps with a denormalized display name. Recommendations and connections are many-to-many, so model them as their own records or edges, indexed in both directions. Then volunteer the costs: who updates the copied names when a company rebrands (change data capture or a background job), how "who worked at X?" is indexed, and whether that update must be atomic.</p>`,
        },
        {
          type: "quiz",
          q: "You copied each employer's name into 50 million profile documents. One employer rebrands. What is the core problem?",
          options: [
            "The documents grow larger.",
            "The name is a many-to-one fact stored 50 million times: you must find and rewrite every copy, and if the job dies partway, profiles disagree. A normalized design stores it once and can't have that anomaly.",
            "JSON can't represent a renamed string.",
            "The rebrand invalidates every index on the collection.",
          ],
          answer: 1,
          explain: "Duplicating human-meaningful, changeable data turns one logical update into many physical ones, with no atomicity unless you add a multi-document transaction. Option D is tempting because index entries holding the old name do have to change, but that's a symptom of the copies, not the core problem, and indexes on other fields are untouched. Option A is false: a rename barely changes document size.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "repeating-history",
      title: "Document databases are repeating history, and history has a lesson",
      kicker: "History",
      concepts: ["hierarchical-model", "codasyl-network-model", "access-path"],
      blocks: [
        {
          type: "problem",
          html: `<p>Picture a business system in 1975 built on a navigational database (an illustrative scenario). The billing program reaches an invoice by starting at a customer record and following a chain of links, a route its programmer picked and hard-coded. Then someone asks a new question: "which customers bought product X last quarter?" If no chain of links leads there conveniently, there's no query to write. A programmer must write a new navigation program, or the schema must grow new links, and every program that walks the old ones has to be checked.</p>
<p>IBM's IMS had an even more basic limit. It stored data as trees of nested records, much like JSON documents, so a record that belongs to two parents (a course taken by many students) had to be duplicated or cross-referenced by hand, with no joins to help. The network model fixed the sharing by letting a record have several parents, but kept the hand navigation. The relational model attacked the real problem: <em>who</em> chooses the route to the data.</p>`,
        },
        {
          type: "idea",
          html: `<p>The network model made the programmer choose and hand-code the <strong>access path</strong>; the relational model handed that job to a <strong>query optimizer</strong> that is built once and benefits every application. That, more than tables as such, is why relational won, and it's the lesson document and graph databases had to relearn.</p>`,
        },
        {
          type: "text",
          html: `<h3>The hierarchical model: everything is a tree</h3>
<p>IBM built its Information Management System (IMS) for stock-keeping in the Apollo space program and began selling it in 1968; through the 1970s it was the leading database for business data processing. Its <strong>hierarchical model</strong> stores everything as trees: records nest inside records, and every record has exactly one parent. If that sounds familiar, it should: structurally it's very close to a JSON document.</p>
<p>IMS had a document database's strengths and weaknesses: nesting suits one-to-many data, many-to-many data has no natural home, and there were no joins to fall back on. A course taken by many students has many parents, which a tree can't express, so developers chose between duplicating the course under every student (and keeping the copies consistent) or storing references and resolving them by hand. Developers met the same problems again with document databases decades later.</p>
<p>Two rival fixes emerged, the <strong>network model</strong> and the <strong>relational model</strong>, and the debate between their camps ran through much of the 1970s. The diagram contrasts all three on the same students-and-courses data.</p>`,
        },
        {
          type: "diagram",
          title: "Three answers to \"a course has many students\"",
          caption: "Hierarchical: one parent per record, so the shared course is copied. Network: the course has several parents, but a program reaches it by walking a path its author chose. Relational: the data is laid out in plain tables, and the optimizer chooses the path for each query.",
          svg: `<svg viewBox="0 0 640 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hierarchical model duplicates a shared course under each student; network model links one course to two students and navigates by a programmer-chosen path; relational model has tables and a query optimizer that picks paths">
<defs>
<marker id="c2rh-c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-c2)"/></marker>
<marker id="c2rh-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-warn)"/></marker>
<marker id="c2rh-c1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill: var(--viz-c1)"/></marker>
</defs>
<line x1="213" y1="8" x2="213" y2="268" style="stroke: var(--viz-line); stroke-width: 1; fill: none"/>
<line x1="427" y1="8" x2="427" y2="268" style="stroke: var(--viz-line); stroke-width: 1; fill: none"/>
<text x="106" y="22" text-anchor="middle" font-size="13" font-weight="700">Hierarchical (IMS)</text>
<rect x="16" y="40" width="64" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="48" y="60" text-anchor="middle" font-size="13" font-weight="700">Ana</text>
<rect x="112" y="40" width="84" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="154" y="60" text-anchor="middle" font-size="13">DB101</text>
<rect x="112" y="82" width="84" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="154" y="102" text-anchor="middle" font-size="13">OS201</text>
<path d="M80 55 H112 M96 55 V97 H112" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.5"/>
<rect x="16" y="136" width="64" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="48" y="156" text-anchor="middle" font-size="13" font-weight="700">Ben</text>
<rect x="112" y="136" width="84" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-bad); stroke-width: 2.2"/>
<text x="154" y="156" text-anchor="middle" font-size="13">DB101</text>
<path d="M80 151 H112" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.5"/>
<text x="154" y="186" text-anchor="middle" font-size="12" font-weight="600" style="fill: var(--viz-bad)">duplicated copy</text>
<text x="106" y="244" text-anchor="middle" font-size="13" font-weight="700">one parent per record</text>
<text x="106" y="262" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">shared records get copied</text>
<text x="320" y="22" text-anchor="middle" font-size="13" font-weight="700">Network (CODASYL)</text>
<path d="M265 29 H277 L271 37 Z" style="fill: var(--viz-warn); stroke: none"/>
<rect x="236" y="40" width="70" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="271" y="60" text-anchor="middle" font-size="13" font-weight="700">Ana</text>
<rect x="334" y="40" width="70" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.5"/>
<text x="369" y="60" text-anchor="middle" font-size="13" font-weight="700">Ben</text>
<rect x="278" y="128" width="84" height="30" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2); stroke-width: 1.5"/>
<text x="320" y="148" text-anchor="middle" font-size="13">DB101</text>
<line x1="281" y1="70" x2="304" y2="124" style="stroke: var(--viz-warn); stroke-width: 2.2; stroke-dasharray: 5 4; fill: none" marker-end="url(#c2rh-w)"/>
<line x1="359" y1="70" x2="336" y2="124" style="stroke: var(--viz-c2); stroke-width: 1.8; fill: none" marker-end="url(#c2rh-c2)"/>
<text x="320" y="182" text-anchor="middle" font-size="12" style="fill: var(--viz-warn)">dashed: the access path</text>
<text x="320" y="198" text-anchor="middle" font-size="12" style="fill: var(--viz-warn)">the programmer chose</text>
<text x="320" y="214" text-anchor="middle" font-size="12" style="fill: var(--viz-warn)">▼ marks the cursor</text>
<text x="320" y="244" text-anchor="middle" font-size="13" font-weight="700">many parents allowed</text>
<text x="320" y="262" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">navigate by pointers</text>
<text x="534" y="22" text-anchor="middle" font-size="13" font-weight="700">Relational</text>
<rect x="452" y="36" width="164" height="32" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1); stroke-width: 1.5"/>
<text x="534" y="57" text-anchor="middle" font-size="13" font-weight="700">query optimizer</text>
<line x1="534" y1="68" x2="534" y2="94" style="stroke: var(--viz-c1); stroke-width: 1.8; fill: none" marker-end="url(#c2rh-c1)"/>
<text x="544" y="86" font-size="12" style="fill: var(--viz-c1)">picks paths</text>
<rect x="444" y="96" width="180" height="120" rx="8" style="fill: none; stroke: var(--viz-muted); stroke-width: 1.2; stroke-dasharray: 5 4"/>
<rect x="454" y="104" width="160" height="28" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="464" y="123" font-size="12"><tspan font-weight="700">students</tspan> (id, name)</text>
<rect x="454" y="142" width="160" height="28" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="464" y="161" font-size="12"><tspan font-weight="700">enrollments</tspan> (sid, cid)</text>
<rect x="454" y="180" width="160" height="28" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-width: 1.2"/>
<text x="464" y="199" font-size="12"><tspan font-weight="700">courses</tspan> (id, title)</text>
<text x="534" y="244" text-anchor="middle" font-size="13" font-weight="700">data in the open</text>
<text x="534" y="262" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">paths chosen automatically</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>The network model: many parents, navigated by hand</h3>
<p>The network model came out of the Conference on Data Systems Languages (<strong>CODASYL</strong>), and several vendors built databases to its standard. It loosens the hierarchy's one rule: a record may have several parents. A single "Greater Seattle Area" record can be linked to every user who lives there, so many-to-one and many-to-many relationships become expressible without copies.</p>
<p>Those links weren't key values looked up at query time; they were closer to pointers, just persisted on disk. To get to a record, a program started at a root record and walked chains of links until it arrived, and that route is called the <strong>access path</strong>. A CODASYL program steered a cursor: loop over a list of records, follow a link, loop again. The system tracked the current record of each type (its "currency"), so what a command did depended on where the cursor happened to be. With many-to-many relationships, several routes lead to the same record, and the programmer had to keep track of all of them in their head.</p>
<p>On the limited hardware of the 1970s this was efficient, and queries along existing paths were concise and fast. The trouble was change. A new kind of question, or a schema change that altered the paths, meant finding and rewriting the hand-written navigation code that depended on them. Here is the flavor of it, for the question from the opening scenario:</p>`,
        },
        {
          type: "code",
          lang: "pseudocode",
          title: "CODASYL-style pseudocode (illustrative, not exact CODASYL DML)",
          code: `-- Which customers bought product X last quarter?
-- The schema links customer -> orders -> order lines -> product,
-- so this program starts from customers and walks down.

FIND FIRST customer IN all-customers
WHILE found:
    FIND FIRST order WITHIN customer-orders        -- cursor moves to this customer's orders
    WHILE found:
        IF order.date IN last-quarter:
            FIND FIRST line WITHIN order-lines
            WHILE found:
                FIND OWNER WITHIN product-lines    -- follow the link up to the product
                IF product.code = 'X':
                    ADD current customer TO result -- "current" depends on cursor state
                FIND NEXT line WITHIN order-lines
        FIND NEXT order WITHIN customer-orders
    FIND NEXT customer IN all-customers`,
        },
        {
          type: "code",
          lang: "sql",
          title: "The same question in SQL",
          code: `SELECT DISTINCT c.name
FROM customers c
JOIN orders o      ON o.customer_id = c.id
JOIN order_lines l ON l.order_id = o.id
JOIN products p    ON p.id = l.product_id
WHERE p.code = 'X'
  AND o.order_date >= DATE '1975-07-01'
  AND o.order_date <  DATE '1975-10-01';`,
          caption: "The SQL names the tables and the conditions, and nothing else. Whether to start from product X or from the customers, and which indexes to use, is the optimizer's decision.",
        },
        {
          type: "text",
          html: `<p>Notice what the pseudocode bakes in. It starts from customers because that's the path its author chose, and visits every recent order to answer a question about one product. If an administrator adds a faster route from products to their order lines tomorrow, this program won't use it until someone rewrites it.</p>
<h3>The relational model: data in the open</h3>
<p>Codd's answer was to put every piece of data in plain view. A table is just a set of rows, with no nesting to descend and no chains of links to walk. Any rows can be selected by any condition, starting from any table, and a new row needs no links to be wired up when it's inserted.</p>
<p>Somebody still has to decide how to execute a query: which table to read first, which indexes to use, which join algorithm to run. In a relational database that somebody is the <strong>query optimizer</strong>, and its choices <em>are</em> the access path, made automatically and remade when the data or the indexes change. To support a new kind of query, you declare a new index; the optimizer considers it for every query and uses it whenever its statistics say that's cheaper, with no change to application code. (<a href="#/ch2/learn/declarative-queries">Say what, not how</a> looks at how it decides.)</p>
<p>A general-purpose optimizer is hard to build, and the optimizers in major relational databases represent decades of research and engineering. But it's built once, and every application on that database benefits. That's the deep reason relational won: <strong>data independence</strong>, separating what you ask from how it's found.</p>
<h3>Where do document databases sit?</h3>
<p>Document databases went back to the hierarchical model in one respect: they store nested one-to-many records (positions, education) inside the parent rather than in separate tables. For many-to-one and many-to-many relationships, though, they do what relational databases do: refer to the other record by a unique identifier (a foreign key in one, a document reference in the other) and resolve it at read time with a join or follow-up queries. They did not adopt CODASYL's pointer navigation. Graph databases look the most like CODASYL at first glance, but they differ in four important ways, set out in <a href="#/ch2/learn/triples-and-datalog">Graphs as facts</a>.</p>`,
        },
        {
          type: "compare",
          title: "Four models, one family resemblance",
          items: [
            {
              title: "Hierarchical (IMS)",
              tone: "warn",
              html: `<p>A tree of records, <strong>one parent each</strong>. Great for one-to-many. Many-to-many means duplicates or hand-made references, and there are no joins.</p>`,
            },
            {
              title: "Network (CODASYL)",
              tone: "bad",
              html: `<p>Records with <strong>many parents</strong>, joined by pointer-like links. Fast along existing paths, but the programmer chooses and hard-codes every access path, so new questions mean new code.</p>`,
            },
            {
              title: "Relational",
              tone: "ok",
              html: `<p>Flat tables, references by key, any row reachable by any condition. The <strong>optimizer chooses access paths</strong>, and a new index can help existing queries without code changes.</p>`,
            },
            {
              title: "Document",
              tone: "info",
              html: `<p><strong>Nested one-to-many</strong> like IMS; <strong>references by ID</strong> like relational, resolved by joins (<code>$lookup</code>) or follow-up queries. No pointer navigation.</p>`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "IBM IMS",
              title: "Not just history",
              year: "1968",
              tag: "hierarchical",
              html: `<p>IMS was built for the Apollo program's stock-keeping and first released commercially in 1968. IBM still sells and supports it on its mainframes, where it is used by large organizations such as banks and insurers, so hierarchical databases are not purely a museum piece.</p>`,
            },
            {
              org: "Charles Bachman / GE",
              title: "IDS and the CODASYL standard",
              year: "1960s",
              tag: "network",
              html: `<p>Bachman designed the Integrated Data Store (IDS) at General Electric in the 1960s, and it strongly influenced the CODASYL network-model standard. Navigating records by following links was his idea of how programmers should work with databases.</p>`,
            },
            {
              org: "IBM System R",
              title: "Access path selection, automated",
              year: "1979",
              tag: "paper",
              html: `<p>IBM's System R project produced one of the first SQL implementations and the first widely cited cost-based optimizer, described in Selinger et al., "Access Path Selection in a Relational Database Management System" (SIGMOD 1979). The paper's title names this section's idea exactly.</p>`,
            },
            {
              org: "Stonebraker's essays",
              title: "What goes around comes around",
              year: "2005, 2024",
              tag: "essay",
              html: `<p>Stonebraker and Hellerstein's "What Goes Around Comes Around" (2005) reviewed some 35 years of data-model proposals and concluded that most re-proposed old ideas. The 2024 follow-up by Stonebraker and Pavlo extended the argument to document, key-value and graph systems.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "history",
          title: "Two Turing Awards, two worldviews",
          html: `<p>Both sides of this debate won computing's highest prize. Charles Bachman received the 1973 Turing Award for his work on database technology, and titled his lecture "The Programmer as Navigator": the programmer steering through the database along chains of records. Edgar Codd received the award in 1981 for the relational model, whose whole point was that the programmer shouldn't have to navigate at all. The tension resurfaces whenever a new system asks developers to fix their access patterns up front.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Are document databases repeating the mistakes of IMS?" is a favorite senior-level question because no slogan answers it. A strong answer is <em>partly</em>. They share IMS's strength (nested one-to-many data with good locality) and its weakness (shared, many-to-many data needs copies or references). But they reference by ID rather than by pointer, resolve references with joins or follow-up queries, support secondary indexes and declarative queries, and have added <code>$lookup</code> and transactions over time. Close on the lasting lesson: systems in which the database, not the programmer, chooses how to find the data adapt far better to new questions.</p>`,
        },
        {
          type: "quiz",
          q: "Why did the relational model beat CODASYL, even though CODASYL queries could be very fast?",
          options: [
            "Relational databases used less disk space.",
            "In CODASYL the programmer chose access paths in code, so new queries or schema changes meant rewriting navigation; a relational optimizer chooses paths automatically, and a new index can benefit queries without changing them.",
            "CODASYL couldn't represent many-to-many relationships.",
            "SQL was standardized before CODASYL.",
          ],
          answer: 1,
          explain: "The win was data independence: separating what you ask from how it's found. Option C is the tempting trap: the network model's whole point was allowing a record to have several parents, so it could represent many-to-many relationships. Its problem was that programs had to navigate them by hand. Option D is false: the CODASYL standards came first.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "schema-flexibility",
      title: "Schemaless isn't schema-free: it's a question of where the schema lives",
      kicker: "Relational vs document",
      concepts: ["schema-on-read-vs-schema-on-write"],
      blocks: [
        {
          type: "problem",
          html: `<p>Your app stores each user's full name in a single <code>name</code> field, and now product wants separate first and last names. In a relational database that's a migration: <code>ALTER TABLE</code> to add the columns, then an <code>UPDATE</code> that rewrites every row to fill them in. On a large MySQL table in the early 2010s, the <code>ALTER</code> alone could rebuild the whole table and take hours, which is why GitHub and Percona built tools to run schema changes online.</p>
<p>In a document database you simply start writing the new shape. But the old documents are still there in the old shape, and every program that reads them has to cope, including the analytics job another team wrote last year that you've never seen. So-called schemaless stores still have a schema. It's implicit, and it's enforced (or not) by every reader instead of by the database.</p>`,
        },
        {
          type: "idea",
          html: `<p><strong>Schema-on-write</strong> enforces structure when data enters, so bad data fails loudly and early, and every change needs a migration. <strong>Schema-on-read</strong> accepts anything and interprets it later, so change is cheap, but every reader inherits every shape ever written.</p>`,
        },
        {
          type: "text",
          html: `<h3>Two names for where the schema lives</h3>
<p>Document databases are often called <em>schemaless</em>, but the word misleads. The code that reads the data almost always assumes some structure: it expects a <code>first_name</code> to exist and to be a string. The schema is there; the questions are where it lives and when it's checked.</p>
<ul>
<li><strong>Schema-on-write</strong> (the traditional relational approach): the schema is explicit and declared in the database, and every write is checked against it. Data that doesn't conform is rejected.</li>
<li><strong>Schema-on-read</strong> (the document approach): the structure is implicit and only interpreted when the data is read. The database stores whatever it's given.</li>
</ul>
<p>The closest analogy is type checking in programming languages: schema-on-write is like static, compile-time checking, and schema-on-read is like dynamic, runtime checking. Programmers have argued about which is better for decades, and the honest answer is that it depends on the situation. The same goes here.</p>
<h3>The same change, both ways</h3>
<p>In a document database, new code simply writes documents with the new fields, and every reader handles documents written before the change:</p>`,
        },
        {
          type: "code",
          lang: "javascript",
          title: "Document store: the reader copes with every shape",
          code: `// App v2 writes { first_name, last_name }. Older documents still hold { name }.
function displayFirstName(user) {
  if (typeof user.first_name === "string") {
    return user.first_name;                // written by app v2
  }
  if (typeof user.name === "string") {
    return user.name.split(" ")[0];        // written by app v1: convert on the fly
  }
  return "(unknown)";                      // a shape nobody planned for
}`,
        },
        {
          type: "code",
          lang: "sql",
          title: "Relational table: change the schema, then convert the rows",
          code: `ALTER TABLE users ADD COLUMN first_name text;            -- quick: a catalog change
UPDATE users SET first_name = split_part(name, ' ', 1);  -- slow: rewrites every row

-- MySQL equivalent of the backfill:
-- UPDATE users SET first_name = substring_index(name, ' ', 1);`,
        },
        {
          type: "text",
          html: `<p>The two SQL statements cost very different amounts. <code>ADD COLUMN</code> without a default is usually a quick metadata change: the database records the new column in its catalog and treats existing rows as NULL. The <code>UPDATE</code> is slow on any database because it rewrites every row; on a billion-row table, run as one statement, it means hours of I/O, a huge transaction and a flood of replication traffic. When the book was written, MySQL was the notable exception: it rebuilt the entire table for many <code>ALTER</code>s, including adding a column, which could mean minutes or hours of disruption on a big table, so teams used external tools to work around it.</p>
<p>There's also a middle path: skip the backfill, leave the new column NULL for old rows, and fill it in at read time, exactly as the document code does. That's schema-on-read, practiced inside a relational database.</p>
<p>The visualization runs both designs side by side on the same events. Ship the new version, write a few users, run the reader, and then make a write with a typo in it.</p>`,
        },
        {
          type: "viz",
          id: "ch2/schema-on-read",
          title: "Where does the schema live?",
          caption: "Try <b>Ship v2</b>, then <b>+ Write user</b>, then <b>▶ Run reader</b> with <b>Reader handles old {name} docs</b> off, then on; finish with <b>+ Buggy write (typo)</b> and run the reader again. Notice that the table pays up front (a migration rewrites every row) and rejects the typo at the writer, while the document store accepts every shape and its errors surface later, in the reader.",
        },
        {
          type: "text",
          html: `<p>Two things stand out. First, the document store did nothing when v2 shipped, which is both its strength and its trap: the cost of the change didn't disappear, it was deferred to every reader, and a v2 reader that didn't know about the old shape rendered every old document as <code>undefined</code>, at read time, possibly inside another team's service. Second, the typo went silently into the document store and was rejected immediately by the table. Schema-on-write turns a latent data bug into a loud one, raised at the writer, where the person who caused it can fix it.</p>
<h3>When schema-on-read is the right call</h3>
<p>Schema-on-read genuinely wins when the items in a collection don't all share one structure, for one of two reasons:</p>
<ul>
<li><strong>Many types of object</strong>, so a table per type is impractical: a catalog where TVs, shirts and books all have different attributes and new categories appear every month.</li>
<li><strong>Structure decided by someone else</strong>: external systems you don't control, which may change at any time, such as webhook payloads from a payment provider, third-party event feeds or scraped pages.</li>
</ul>
<p>Before JSON columns, relational teams faked this with <strong>entity-attribute-value</strong> (EAV) tables of the form <code>(entity_id, attribute, value)</code>. EAV is flexible, but it loses types and constraints, and reading one entity back takes a pivot or one self-join per attribute. A JSON or JSONB column is the modern, indexable version of the same escape hatch (see the interview question on <a href="#/ch2/interview/q-variable-attributes">storing variable product attributes</a>).</p>
<h3>When a schema is a feature</h3>
<p>When records are expected to share a structure, which is most of the time, an explicit schema is documentation that can't go stale and a guard that catches errors at the writer instead of in some distant reader. Its price is migrations, and on large tables the safe way to migrate is <strong>expand-contract</strong> (also called parallel change): add the new columns as nullable; deploy code that writes both old and new; backfill old rows in small, throttled batches; switch readers to the new columns; stop writing the old column; and drop it once nothing reads it.</p>
<p>Be precise about what schema-on-write guarantees: every row has the declared columns and types, not that every reader understands what they mean. Renaming or repurposing a column still breaks old readers, which is why expand-contract keeps the old column until every reader has moved. The same problem appears one layer down, in how data is encoded between services; Chapter 4's Avro writer's and reader's schemas and Protocol Buffers field tags are schema evolution with backward and forward compatibility.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "GitHub gh-ost",
              title: "Online migrations without triggers",
              year: "2016",
              tag: "MySQL",
              html: `<p>GitHub open-sourced gh-ost in 2016: it builds an altered copy of a table in the background, applies ongoing changes by reading the MySQL binary log rather than using triggers, and then cuts over. GitHub's announcement explains why: MySQL's own online <code>ALTER</code> caused replication lag and couldn't be paused or throttled, and the trigger-based tools it had used added load and lock contention on busy tables.</p>`,
            },
            {
              org: "Percona Toolkit",
              title: "pt-online-schema-change",
              tag: "MySQL",
              html: `<p>pt-online-schema-change creates an empty copy of the table with the new structure, keeps it in sync with triggers, copies rows over in chunks, and atomically swaps the tables, so the schema change doesn't block writes.</p>`,
            },
            {
              org: "MongoDB",
              title: "Opt-in schema-on-write",
              year: "2015–2017",
              tag: "validation",
              html: `<p>MongoDB 3.2 (2015) added document validation rules, and 3.6 (2017) added <code>$jsonSchema</code> validators, so a "schemaless" collection can reject documents that don't match a declared JSON Schema.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The gap has narrowed from both sides. PostgreSQL 11 (2018) made <code>ADD COLUMN</code> with a non-volatile <code>DEFAULT</code> a metadata-only change (a volatile default such as <code>clock_timestamp()</code> still rewrites the table), and MySQL 8.0.12 (2018) added <code>ALGORITHM=INSTANT</code> for appending a column, extended to other positions in later 8.0 releases. Document databases moved the other way with optional validators like MongoDB's. Data lakes went through the same cycle: raw files queried schema-on-read gave way to table formats such as Delta Lake and Apache Iceberg, which enforce and evolve a schema. What stays expensive everywhere is rewriting existing data.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Schema-on-read",
          prosLabel: "What it gives you",
          consLabel: "What it costs you",
          pros: [
            "Shape changes need no migration and no maintenance window.",
            "Heterogeneous records (many types, external payloads) are stored as they come.",
            "Old and new shapes coexist during a gradual rollout.",
            "No long-running backfill hammering the database and its replicas.",
          ],
          cons: [
            "Every reader must handle every shape ever written, forever or until a backfill.",
            "Errors surface late, in a reader far from the writer that caused them.",
            "No single place documents the structure; it's spread across code.",
            "Typos and wrong types are stored silently, and analytics must clean them at query time.",
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          html: `<p>"It's schemaless, so we don't need to think about the schema." The schema still exists: it's spread across every piece of code that reads the data, undeclared and unversioned, so you can't see it in one place. Teams that treat it as absent rediscover it through production errors. Treat the implicit schema as real instead: write it down, version it, validate writes where you can (a <code>$jsonSchema</code> validator or validation in the application), and plan backfills for old shapes rather than carrying legacy branches forever.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Split <code>users.name</code> into first and last names on a 2-billion-row table with zero downtime" is a common practical question, and interviewers want expand-contract, not one <code>ALTER</code> plus one <code>UPDATE</code>. A strong answer: add nullable columns (metadata-only on modern PostgreSQL and MySQL); deploy dual writes; backfill in batches of a few thousand rows walked by primary key, throttled by replica lag; verify with counts and sampling; move readers over behind a flag; stop writing <code>name</code>; drop it later. Then mention the tools (gh-ost or pt-online-schema-change when MySQL must rebuild a table) and the edge cases: names that don't split on a single space, and services you don't own that still read <code>name</code>.</p>`,
        },
        {
          type: "quiz",
          q: "Your MongoDB users collection contains three historical shapes of user document, and a new analytics job crashes on 2% of records. Which statement is most accurate?",
          options: [
            "MongoDB corrupted those documents.",
            "The schema existed all along, implicitly, in the readers. Under schema-on-read the old shapes are every reader's responsibility: handle them at read time, backfill them, and/or add a validator for new writes.",
            "Moving the data into a PostgreSQL JSONB column would fix the old records automatically.",
            "With schema-on-write, the schema change would have been free.",
          ],
          answer: 1,
          explain: "Nothing is corrupt: the job's assumptions simply don't match shapes that were legitimately written earlier. Option C is tempting, but a JSONB column is schema-on-read too unless you add constraints, and moving the data changes none of its shapes. Option D is wrong because schema-on-write moves the cost to migration time (the backfill); it doesn't remove it.",
        },
      ],
    },
  ],
});
