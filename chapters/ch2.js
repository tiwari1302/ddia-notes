// Chapter 2: Data Models and Query Languages
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch2",
  part: 1,
  number: 2,
  title: "Data Models and Query Languages",
  tagline: "Your data model decides which questions are cheap: trees fit documents, joins fit tables, deep connections fit graphs.",
  overview: `<p>Software is built in layers: objects in application code are represented in a general-purpose <strong>data model</strong> (relational tables, JSON documents, or a graph of vertices and edges), which a storage engine turns into bytes (Chapter 3), which hardware turns into physics. This chapter is about that middle layer and the query languages built for each model: SQL, MongoDB's query and aggregation languages and MapReduce, Cypher, SPARQL and Datalog. The model matters because it decides which questions are one line of query and which become hand-written code.</p>
<p>The central tension is the <strong>shape of relationships</strong>. A résumé is a tree of one-to-many data, and a document stores it as one unit with excellent locality. But employers, regions and the people who recommend you are shared (many-to-one and many-to-many), and they pull you back toward IDs and joins, which relational databases do natively. When anything can relate to anything at unknown depth, a graph fits best. A second tension runs underneath: <strong>who owns the schema and the access paths</strong>. Is the schema enforced by the database at write time, or interpreted by every reader? Are access paths chosen by an optimizer, or hard-coded by the programmer?</p>
<p>The ideas build in sequence. The comparison of relational and document models starts with the impedance mismatch and locality, then runs into many-to-one data, where 1970s history (IMS and CODASYL) repeats and teaches its lesson: let the system choose access paths. That lesson becomes declarative querying, with MapReduce as an instructive halfway point. Graphs then push relationships to the extreme: property graphs and Cypher, triple-stores and SPARQL, and Datalog's recursive rules, which also explain how SQL's <code>WITH RECURSIVE</code> works. Along the way the models converge: PostgreSQL stores JSON, MongoDB joins, and SQL:2023 queries graphs.</p>`,

  concepts: [
    // ── why-data-models ─────────────────────────────────────────────
    {
      id: "relational-model",
      term: "Relational model",
      def: `Data organized as <em>relations</em> (tables): unordered collections of tuples (rows) with named attributes. There is no nesting and there are no pointers; relationships are expressed as values (foreign keys) and resolved at query time with joins. Proposed by Edgar Codd in 1970; SQL is its dominant query language.`,
      problem: `Navigational databases (IMS, CODASYL) made every query a hand-written traversal along fixed access paths, so every new question meant new code. Codd proposed describing data as plain relations and letting the system work out how to find it (data independence).`,
      why: `Its 40-year dominance comes from <strong>generality</strong> and from moving the "how" into the database: declarative SQL, a query optimizer that picks access paths (indexes, join order, algorithms) from statistics, and joins that make many-to-one and many-to-many relationships cheap to express. The same model stretched from 1970s payroll and bookings to e-commerce, SaaS and social networks. Two common misattributions: ACID transactions are a property of transactional implementations (<a href="#/ch7/learn/acid-unpacked">Chapter 7</a>), not of the model; and "relational can't scale" describes particular products of the late 2000s, not the model (distributed SQL partitions relational data across machines).`,
      ex: `PostgreSQL, MySQL, Oracle, SQL Server and SQLite; distributed SQL in Google Spanner, CockroachDB, YugabyteDB and TiDB. GitHub and Shopify run their core data on MySQL; a bank ledger or an airline booking system is the textbook relational workload: shared entities, constraints, multi-row updates.`,
      section: "why-data-models",
    },
    {
      id: "nosql",
      term: "NoSQL",
      def: `An umbrella name for non-relational databases (key-value, wide-column, document and graph stores). It began as a Twitter hashtag for a 2009 meetup on open-source, distributed, non-relational databases and was later reinterpreted as "Not Only SQL". It names a movement, not one technology.`,
      problem: `By the late 2000s, web companies needed dataset sizes and write throughput beyond one machine, faster schema iteration, query types (documents, graphs) that fit SQL awkwardly, and cheaper open-source software than commercial relational databases offered.`,
      why: `Four drivers: (1) scalability beyond what relational products easily offered, especially very large datasets or very high write throughput; (2) a preference for free, open-source software; (3) specialized query operations the relational model supports poorly; (4) frustration with restrictive schemas and a wish for a more dynamic, expressive model. The stores under the label share little else: Redis, Cassandra, MongoDB and Neo4j solve different problems. Since then relational systems absorbed several drivers (JSON columns, distributed SQL) and NoSQL systems added SQL-like languages, joins and transactions, so "NoSQL = scale" and "NoSQL = no schema" are both myths.`,
      ex: `Google's Bigtable paper (OSDI 2006) and Amazon's Dynamo paper (SOSP 2007) inspired HBase, Cassandra, Riak and Voldemort; MongoDB's first release was in 2009. The meetup was held in San Francisco in June 2009 (organizer widely reported as Johan Oskarsson).`,
      section: "why-data-models",
    },
    {
      id: "polyglot-persistence",
      term: "Polyglot persistence",
      def: `Using several data stores in one application, each chosen for the access pattern it serves (e.g. PostgreSQL for orders, Elasticsearch for search, Redis for sessions, a graph store for recommendations).`,
      problem: `No single data model is best for every access pattern; forcing one store to do everything yields awkward code or poor performance.`,
      why: `Each store makes a different question cheap. The price is <strong>operational</strong> (each system needs backups, monitoring, upgrades and on-call expertise) and <strong>consistency</strong>: the same fact now lives in several places. Make one store the source of truth and derive the others from its change stream (change data capture or an event log, <a href="#/ch11/learn/change-data-capture">Chapter 11</a>; derived data, <a href="#/ch12/learn/data-integration">Chapter 12</a>) instead of dual writes from application code, which race and partially fail. For moderate needs a multi-model database (PostgreSQL with jsonb, full-text search and pgvector) can postpone the extra systems.`,
      ex: `An e-commerce stack: PostgreSQL for orders and inventory, Elasticsearch or OpenSearch for product search and facets, Redis for sessions and carts, a graph store or precomputed table for "customers also bought", and Parquet files on object storage for analytics. Debezium reads PostgreSQL's write-ahead log and publishes changes to Kafka, from which the search index is kept current.`,
      section: "why-data-models",
    },

    // ── impedance-mismatch ─────────────────────────────────────────────
    {
      id: "object-relational-impedance-mismatch",
      term: "Object-relational impedance mismatch",
      def: `The translation cost between how application code holds data (objects with nested collections, references and inheritance) and how relational tables store it (flat rows linked by key values). It shows up in <em>shape</em> (nested collections vs flat rows), <em>identity</em> (object references vs primary keys) and <em>navigation</em> (follow a pointer vs perform a join). ORMs such as Hibernate and Active Record generate the translation code but can't make the differences disappear.`,
      problem: `Application objects are nested graphs with collections and references, while tables are flat, so every crossing of the boundary needs translation code: shredding the object on write, reassembling it on read.`,
      why: `Leaky ORM abstractions cause classic performance bugs, most famously <strong>N+1 queries</strong>. N+1 comes from ORM lazy loading, not from SQL: one join, eager loading (Rails <code>includes</code>/<code>preload</code>, JPA fetch joins or entity graphs) or batching fetches the same data in a few queries. Documents remove the mismatch only for tree-shaped data; once objects reference shared entities, it returns as application-side joins or duplicated copies.`,
      ex: `A profile page lists 12 positions, each showing its company. With lazy loading the ORM issues 1 query for the user, 1 for the positions collection, then 1 per position for its company: 1 + 1 + 12 = <strong>14 queries</strong>. Eager loading takes 2–3 queries; one SQL join takes 1. The Rails gem Bullet exists to flag N+1 patterns in development, and GraphQL's DataLoader batches the same pattern in resolvers.`,
      section: "impedance-mismatch",
    },
    {
      id: "document-model",
      term: "Document model",
      def: `Records stored as self-contained documents (JSON, or a binary encoding such as MongoDB's BSON), each a tree: one-to-many relationships are nested inside the parent as arrays and sub-objects. A document is addressed by its ID and usually read and written as a unit, and documents in one collection need not share a structure.`,
      problem: `Tree-shaped objects (a résumé with its positions, schools and contact details) had to be shredded into many tables and reassembled with joins or an ORM.`,
      why: `It wins when data is <strong>one-to-many and loaded together</strong>: one read fetches the whole tree (locality), the stored shape matches application objects, and structure can evolve on read. It loses on many-to-one and many-to-many data (shared entities need references and joins, or copies that drift) and when you need small parts of large documents. Modern document databases aren't the 2010 caricature: they have secondary indexes (including multikey indexes on arrays), joins (<code>$lookup</code>) and multi-document transactions (MongoDB 4.0+), at extra cost.`,
      ex: `MongoDB, CouchDB/Couchbase and Google Firestore; Amazon DynamoDB (primarily key-value, with document support); PostgreSQL <code>jsonb</code> as a relational/document hybrid. Natural fits: a CMS article with its content blocks, a product listing with variant details, a user's settings, an event payload.`,
      section: "impedance-mismatch",
    },

    // ── many-to-one ─────────────────────────────────────────────
    {
      id: "many-to-one-many-to-many",
      term: "Many-to-one / many-to-many",
      def: `Relationship shapes. <strong>One-to-many</strong>: a parent owns several children that belong only to it (a user's positions); it fits a tree, so embedding works. <strong>Many-to-one</strong>: many records refer to one shared entity (many users in one region, many positions at one company). <strong>Many-to-many</strong>: both sides have many (users ↔ groups, users recommending users). The last two don't fit a tree. Relational databases use foreign keys and joins; a document database must store references and join in the application, join in the database (<code>$lookup</code>), or copy the shared data into each document.`,
      problem: `Human-meaningful values (regions, employers, industries) are shared by many records and change over time. Stored as free text in every record they drift into inconsistent spellings, become ambiguous, and make every rename a hunt for copies.`,
      why: `Storing an ID that points to one canonical record gives consistent spelling, no ambiguity (which Springfield?), one-place updates, localization (translate the list once) and better search (record once that Seattle is in Washington). And data gets more connected as products grow: employers become company pages with logos, users start recommending each other. That is the moment the tree breaks and joins come back, which makes many-to-one and many-to-many the classic signal to stay relational, or to plan joins in the document store.`,
      ex: `Sign-up forms offer a dropdown or autocomplete for region and industry so the profile stores an ID, not free text. Wikidata gives every entity a language-independent ID (Q42 is Douglas Adams) with labels in many languages. When Facebook, Inc. renamed itself Meta Platforms (October 2021), a profile storing an employer ID showed the new name on its next read; a profile storing the string "Facebook" had to be rewritten.`,
      section: "many-to-one",
    },
    {
      id: "normalization",
      term: "Normalization",
      def: `Storing each fact exactly once and referring to it by ID everywhere else (<code>region_id</code> instead of "Greater Seattle Area" in every row). Formal normal forms (1NF through BCNF) exist, but the working rule is: if a human-meaningful value is duplicated where it could live in one place, the schema isn't normalized.`,
      problem: `Copies of the same fact drift apart (update anomalies), and a rename must touch every copy.`,
      why: `An ID has no meaning to humans, so it never needs to change; the name it points to changes in one atomic write and every reader sees it. The price is that reads must join: normalization <em>requires</em> joins on read rather than "enabling" them. It's the right default for operational data where shared facts must stay correct.`,
      ex: `An orders table stores <code>customer_id</code> and <code>product_id</code>, so fixing a customer's email or renaming a product is one UPDATE. Contrast a deliberate snapshot: an order line keeps the <em>price at purchase time</em>, because that is a different fact that must not change when the catalog does.`,
      section: "many-to-one",
    },
    {
      id: "denormalization",
      term: "Denormalization",
      def: `Deliberately storing copies of data, usually a display field such as a company name next to its ID, so reads avoid a join or a second lookup.`,
      problem: `Joins at read time cost latency, especially when the related data sits on other partitions or the store has no joins at all (Cassandra's CQL, DynamoDB).`,
      why: `It trades write fan-out, storage and staleness for faster reads. A denormalized copy is <strong>derived data</strong>, a cache: it needs one owner and an update path (change data capture or a stream consumer, <a href="#/ch11/learn/change-data-capture">Chapter 11</a>; a materialized view, <a href="#/ch12/learn/unbundling-databases">Chapter 12</a>), an accepted staleness window, and a transaction if copies must change together (<a href="#/ch7/learn/why-transactions">Chapter 7</a>). Copy only rarely changing, display-only fields, and try an index, a cache or a materialized view first.`,
      ex: `MongoDB's "extended reference" pattern stores <code>{org_id, name}</code> in each position. Cassandra's query-first modeling keeps one table per query with the same data duplicated across tables. DynamoDB single-table design stores items that are read together under one partition key so one Query returns a pre-joined item collection.`,
      section: "many-to-one",
    },
    {
      id: "application-side-join",
      term: "Application-side join",
      def: `Resolving references (IDs) in application code by issuing follow-up queries, instead of letting the database join.`,
      problem: `Document databases with weak join support still contain many-to-one and many-to-many data; someone has to look up the referenced records, so the work moves into the application (more round trips, more code).`,
      why: `It's the relational join moved into your app, without the optimizer: you choose the strategy, often a naive loop that reproduces N+1; each step adds a round trip; and the queries see no consistent snapshot unless they run in a transaction. Mitigations: batch the lookup (one <code>$in</code> query for all IDs), cache small reference lists in memory, or use the database's own join (<code>$lookup</code>).`,
      ex: `Load a profile whose positions hold <code>org_id: o1</code> and <code>org_id: o2</code>, then fetch both orgs with one <code>find({_id: {$in: [o1, o2]}})</code>: 2 round trips instead of 1 join. GraphQL resolvers do the same, with DataLoader batching the per-item lookups.`,
      section: "many-to-one",
    },

    // ── repeating-history ─────────────────────────────────────────────
    {
      id: "hierarchical-model",
      term: "Hierarchical model (IMS)",
      def: `IBM IMS's 1960s data model: records nested in a tree, each record with exactly one parent. Structurally much like a JSON document.`,
      problem: `Early business systems needed to store nested one-to-many data efficiently (IMS was developed for stock-keeping in the Apollo space program); the tree later struggled with many-to-many relationships and had no joins.`,
      why: `Excellent for one-to-many data on 1960s and 1970s hardware, but with one parent per record, anything shared (a part used in many assemblies, a course taken by many students) has to be duplicated or cross-referenced by hand. Document databases repeat exactly this nesting, which is why they inherit the same weakness with shared entities.`,
      ex: `IBM IMS, first released commercially in 1968, is still sold and supported for mainframe customers such as banks and insurers. A JSON profile with nested positions is, structurally, an IMS record tree.`,
      section: "repeating-history",
    },
    {
      id: "codasyl-network-model",
      term: "CODASYL / network model",
      def: `The network model, standardized by the CODASYL committee (Conference on Data Systems Languages) around the turn of the 1970s. Records are connected by pointer-like links organized as owner/member <em>sets</em>, so a record can have several parents. A program reaches a record only by navigating an <strong>access path</strong>: start at a root record and move a cursor along chains of links (e.g. "get next member of this set"), with the system tracking each program's current position ("currency").`,
      problem: `IMS's tree couldn't represent many-to-many relationships; the network model generalized it by letting a record have several parents (one "Greater Seattle Area" record linked to every user who lives there).`,
      why: `It fixed sharing but kept hand navigation. Queries were concise and fast along paths that existed, but a new question or schema change meant rewriting navigation code, and with several paths to the same record the programmer had to track them mentally. Document databases repeat IMS's nesting, <em>not</em> CODASYL's pointers: like relational databases, they refer to other records by an ID resolved at read time. Graph databases resemble CODASYL superficially but differ in four ways (any vertex can link to any other; direct access by ID or index; unordered edges; declarative queries).`,
      ex: `Charles Bachman's Integrated Data Store (IDS) at General Electric influenced the standard, and his 1973 Turing Award lecture was titled "The Programmer as Navigator". IDMS was a widely used CODASYL-style database on mainframes.`,
      section: "repeating-history",
    },
    {
      id: "access-path",
      term: "Access path",
      def: `The route taken through the data to reach a record. In CODASYL it was a chain of pointer links chosen and hand-coded by the programmer; in relational systems the query optimizer chooses it automatically (e.g. which index, which join order).`,
      problem: `Someone must decide how to find the data. When it's the programmer, every new query or schema change means rewriting navigation code.`,
      why: `<strong>Who chooses the access path</strong> is the deepest lesson of the chapter. In a relational database, creating an index adds a new access path and existing queries start using it whenever the optimizer estimates it's cheaper, with no application change. Building a general-purpose optimizer took decades of research, but it's built once and every application benefits.`,
      ex: `CODASYL style: find the customer record, then repeatedly "get next order in this customer's orders set". Relational: one <code>SELECT ... JOIN ...</code>, and the optimizer picks an index on <code>orders.customer_id</code>, a hash join or a full scan, changing its mind as the data grows. IBM's System R optimizer paper (Selinger et al., SIGMOD 1979) was titled "Access Path Selection in a Relational Database Management System".`,
      section: "repeating-history",
    },

    // ── schema-flexibility ─────────────────────────────────────────────
    {
      id: "schema-on-read-vs-schema-on-write",
      term: "Schema-on-read vs schema-on-write",
      def: `<strong>Schema-on-write</strong> (relational): the schema is explicit and the database rejects writes that don't conform. <strong>Schema-on-read</strong> (most document stores): the structure is implicit, and each reader interprets whatever shapes were written. The analogy is static (compile-time) vs dynamic (run-time) type checking.`,
      problem: `Schemas change, and someone has to deal with the old data: either a migration at write time or handling code in every reader at read time.`,
      why: `Schema-on-read makes change cheap and suits heterogeneous data (many object types, or structure dictated by external systems such as webhook payloads), but every reader inherits every shape ever written, and typos surface late and far from their cause. Schema-on-write catches errors at the writer and documents the structure in one place, at the cost of migrations. Both guarantee structure, not meaning: renaming or repurposing a field still breaks old readers. "Schemaless" means implicit, not absent, and the gap has narrowed from both sides (MongoDB's <code>$jsonSchema</code> validators, JSON columns in SQL).`,
      ex: `Splitting <code>name</code> into <code>first_name</code>/<code>last_name</code>. Document: start writing the new shape; readers carry <code>if (!u.first_name) u.first_name = u.name.split(' ')[0]</code>. Relational: <code>ALTER TABLE users ADD COLUMN first_name text</code> is usually metadata-only (PostgreSQL for nullable columns, and since PostgreSQL 11 with a non-volatile default too; MySQL <code>ALGORITHM=INSTANT</code> since 8.0.12 when appending the column), while the <code>UPDATE</code> backfill rewrites every row and is the slow part everywhere. MySQL historically rebuilt the whole table for many ALTERs, which is why online schema-change tools such as Percona's pt-online-schema-change and GitHub's gh-ost exist.`,
      section: "schema-flexibility",
    },

    // ── locality-and-convergence ─────────────────────────────────────────────
    {
      id: "data-locality",
      term: "Data locality",
      def: `Storing data that is read together physically together (e.g. a whole document as one contiguous value, or interleaved parent/child rows) so a single lookup fetches it. This is storage locality; not to be confused with <a href="#/ch10/concepts/data-locality">Chapter 10's data locality</a>, which means moving computation to the machine that holds the data.`,
      problem: `Assembling one logical object from rows spread across several tables costs multiple index lookups and disk seeks.`,
      why: `Locality is a bet that you read and write the unit as a whole. The database usually loads the entire document even to read one field, and an update usually rewrites the entire document (only changes that keep the encoded size can easily happen in place), so keep documents small and never let them grow without bound. The same trade-off shows up inside relational databases, and locality isn't unique to documents.`,
      ex: `Google Spanner's <code>INTERLEAVE IN PARENT</code> stores a singer's album rows next to the singer row; Oracle's multi-table index clusters and Bigtable/HBase column families group data read together. Costs: PostgreSQL moves values over roughly 2 kB out of line and compresses them (TOAST), so reading one key of a large <code>jsonb</code> value fetches and decompresses all of it; appending every click to a MongoDB user document makes each profile read drag the whole history along and eventually hits the 16 MB document limit.`,
      section: "locality-and-convergence",
    },
    {
      id: "shredding",
      term: "Shredding",
      def: `Splitting a document-like (tree-shaped) structure into rows across several tables, as a normalized relational schema does.`,
      problem: `Relational tables are flat, so nested one-to-many data must be broken apart to be stored, which complicates schemas and code when the data is always used as a whole.`,
      why: `It's the book's test for whether the document model is natural: if your data is a tree of one-to-many relationships usually loaded whole, shredding buys awkward schemas and needless reassembly code. If parts of it are queried across records, shredding is exactly right. Hybrid schemas split the difference: columns for what you filter, join and constrain; a JSON column for the rest.`,
      ex: `A profile becomes <code>users</code>, <code>positions</code>, <code>education</code> and <code>contact_info</code>, each keyed by <code>user_id</code>: saving touches four tables and loading needs a four-way join or four queries. Order line items, by contrast, deserve their own table, because "sales per product" queries cut across orders.`,
      section: "locality-and-convergence",
    },

    // ── declarative-queries ─────────────────────────────────────────────
    {
      id: "declarative-vs-imperative-query",
      term: "Declarative vs imperative query",
      def: `<strong>Imperative</strong> code spells out the steps and their order (loops, conditions, variables). <strong>Declarative</strong> code states the conditions the result must satisfy and how to transform it (filter, sort, group, aggregate) and leaves the algorithm to the system. SQL follows Codd's relational algebra, e.g. selection σ<sub>family = 'Sharks'</sub>(animals).`,
      problem: `Imperative access code freezes one strategy: it can't exploit new indexes, more cores or storage reorganization, and it may silently depend on the order records happen to be stored in.`,
      why: `Declarative queries are more concise; they hide implementation details, so the database can get faster without query changes; they parallelize, which matters because CPUs now grow by adding cores rather than clock speed; and they survive storage reorganization, because SQL guarantees no order without <code>ORDER BY</code>. Their more limited expressiveness is exactly what gives the optimizer room. The cost is less direct control and occasional plan surprises.`,
      ex: `A <code>getSharks()</code> loop over an array vs <code>SELECT * FROM animals WHERE family = 'Sharks'</code>. In the browser: the CSS rule <code>li.selected &gt; p</code> stays correct when the class moves and speeds up when browsers improve, while JavaScript that walks the DOM and sets styles must undo them by hand and be rewritten to use newer APIs such as <code>querySelectorAll</code>. React applies the same idea to UIs; PostgreSQL 9.6's parallel query sped up existing SQL with no text changes.`,
      section: "declarative-queries",
    },
    {
      id: "query-optimizer",
      term: "Query optimizer",
      def: `The database component that turns a declarative query into an execution plan, choosing indexes, join order and algorithms, and parallelism, typically by estimating costs from statistics.`,
      problem: `Without it, programmers hand-code access paths, and no application benefits from a new index, more cores or a storage reorganization until its code is rewritten.`,
      why: `It's hard to build (decades of work since System R's cost-based optimizer, 1979) but built once for every application. It's statistical: an index is used only when estimates say it's cheaper, so for a predicate matching a quarter of the table a sequential or bitmap scan often wins. Wrong estimates (stale statistics, skew, correlated columns) produce bad plans; <code>EXPLAIN ANALYZE</code> shows its choices, and hints and plan pinning are the escape hatches.`,
      ex: `After <code>CREATE INDEX ON animals (family)</code>, the same shark query switches from a sequential scan to an index scan when sharks are rare; on a large table PostgreSQL may choose a Gather over a Parallel Seq Scan. Spark SQL's Catalyst optimizer pushes filters down into the data source, something hand-written RDD code doesn't get automatically.`,
      section: "declarative-queries",
    },

    // ── mapreduce-querying ─────────────────────────────────────────────
    {
      id: "mapreduce-querying",
      term: "MapReduce querying",
      def: `A programming model in which you supply two functions: <em>map</em>, called once per input record, emits key-value pairs; <em>reduce</em>, called once per key with all the values emitted for it, combines them. In MongoDB's <code>mapReduce</code>, a declarative filter runs first, map reads the document via <code>this</code> and calls <code>emit()</code>, and results go to an output collection.`,
      problem: `Document stores without SQL needed a way to run aggregations over many documents spread across many machines.`,
      why: `It sits between imperative and declarative: arbitrary code inside, but the framework controls execution. That only works because map and reduce must be <strong>pure</strong> (use only their input; no queries, no side effects), so they can run on any node, in any order, and be re-run after failures. Reduce may be applied again to its own outputs (re-reduce), so it must return the same type it receives and be associative and commutative: averaging averages is the classic bug. Usability cost: two coordinated functions are harder to write than a GROUP BY and opaque to the optimizer. MongoDB added the aggregation pipeline in 2.2 and deprecated map-reduce in 5.0 (2021). MapReduce as a distributed batch engine is the subject of <a href="#/ch10/learn/mapreduce-and-hdfs">Chapter 10</a>.`,
      ex: `Monthly shark sightings: filter <code>{family: 'Sharks'}</code>, map emits <code>('1995-12', numAnimals)</code>, reduce sums the values, so key <code>'1995-12'</code> with values [3, 4, 1, 2] becomes 10. CouchDB views are JavaScript map (and optional reduce) functions whose results are kept in an incrementally updated B-tree index; Hive compiled SQL-like HiveQL into Hadoop MapReduce jobs.`,
      section: "mapreduce-querying",
    },
    {
      id: "aggregation-pipeline",
      term: "Aggregation pipeline",
      def: `MongoDB's declarative, JSON-based query language made of chained stages (<code>$match</code>, <code>$group</code>, <code>$sort</code>, <code>$lookup</code>, ...), added in 2.2 (2012) and now the recommended replacement for mapReduce.`,
      problem: `Writing two coordinated JavaScript functions for every aggregation was verbose and error-prone and gave the database little room to optimize.`,
      why: `Stages are visible to the database, so it can optimize: move a <code>$match</code> earlier so it can use an index, coalesce <code>$sort</code> with a following <code>$limit</code>. It covers much of SQL's SELECT/WHERE/GROUP BY territory and later gained joins (<code>$lookup</code>, 3.2) and recursive lookups (<code>$graphLookup</code>, 3.4): a NoSQL system reinventing SQL in JSON form. Couchbase's N1QL (SQL++) is another example of the same convergence.`,
      ex: `Monthly shark totals: <code>[{$match: {family: 'Sharks'}}, {$group: {_id: {year: {$year: '$observedAt'}, month: {$month: '$observedAt'}}, totalAnimals: {$sum: '$numAnimals'}}}]</code>.`,
      section: "mapreduce-querying",
    },

    // ── property-graphs ─────────────────────────────────────────────
    {
      id: "graph-model",
      term: "Graph model",
      def: `Data as <strong>vertices</strong> (nodes, entities) and <strong>edges</strong> (relationships). Two main flavors: the <strong>property graph</strong> (Neo4j, Amazon Neptune; queried with Cypher/GQL or Gremlin) and the <strong>triple-store</strong> (RDF; queried with SPARQL). Datalog offers a logic-based way to query the same kind of data.`,
      problem: `Highly many-to-many data with variable-depth relationships needs ever more join tables and recursive SQL.`,
      why: `Relationships are first-class: any vertex can link to any other with no schema restricting which, one graph can hold many kinds of entities and relationships distinguished by labels, and queries can follow an <strong>unknown number of hops</strong> (Cypher <code>*0..</code>, SPARQL <code>:within*</code>). That suits data where many-to-many dominates and the questions are about paths: social graphs, fraud rings, network topology, knowledge graphs, road networks. It isn't free: unbounded traversals on dense graphs get expensive, graphs are hard to partition (Chapter 6), and whole-dataset aggregates are better done elsewhere.`,
      ex: `Facebook's TAO serves one graph of typed objects and associations (people, posts, check-ins, comments); its 2013 paper reports about a billion reads per second. For the 2016 Panama Papers, ICIJ journalists loaded 11.5 million leaked documents' entities into Neo4j and explored ownership chains with Linkurious. Google's Knowledge Graph (2012) and the web's link graph (PageRank) are graphs too.`,
      section: "property-graphs",
    },
    {
      id: "property-graph",
      term: "Property graph",
      def: `A graph in which each <strong>vertex</strong> has a unique ID, a set of outgoing edges, a set of incoming edges and properties (key-value pairs), and each <strong>edge</strong> has a unique ID, a tail vertex (where it starts), a head vertex (where it ends), a label and properties. Edges are directed but can be traversed in both directions. In Neo4j a node can carry several labels and each relationship has exactly one type.`,
      problem: `Many kinds of entities and relationships need to live in one graph without a rigid schema, with efficient traversal in both directions.`,
      why: `It can be stored relationally as two tables, <code>vertices(vertex_id, properties)</code> and <code>edges(edge_id, tail_vertex, head_vertex, label, properties)</code>, with indexes on both tail and head: those two indexes are what make "who points to me?" as cheap as "whom do I point to?". New kinds of data need no migration (add allergen vertices and <code>ALLERGIC_TO</code> edges, then ask which foods are safe). Cypher, created for Neo4j and named after a character in The Matrix, is the best-known language; GQL (ISO/IEC 39075:2024) standardizes a Cypher-influenced language, and SQL/PGQ (SQL:2023 part 16) queries property-graph views over relational tables.`,
      ex: `Friends of friends: <code>MATCH (a:Person {name: 'Alice'})-[:FRIEND]-&gt;(b)-[:FRIEND]-&gt;(c) WHERE c &lt;&gt; a RETURN DISTINCT c</code> (bind the start node, or the query scans every person). Systems: Neo4j, Amazon Neptune (Gremlin, openCypher and SPARQL), JanusGraph.`,
      section: "property-graphs",
    },
    {
      id: "recursive-cte",
      term: "Recursive CTE (WITH RECURSIVE)",
      def: `A SQL common table expression that refers to itself: it starts from seed rows and repeatedly adds rows derived from the previous ones until no new rows appear. SQL's way to traverse hierarchies of unknown depth.`,
      problem: `A fixed number of joins follows a fixed number of hops, but real hierarchies (city within state within country, org charts, bills of materials) have varying and changing depth.`,
      why: `It's evaluated as a <strong>fixpoint</strong>: the seed query runs once, then each iteration joins only the rows produced by the previous iteration (PostgreSQL calls this the working table), stopping when an iteration produces nothing. That's semi-naive evaluation, the same mechanism as Datalog's rounds. <code>UNION</code> discards rows already produced, which also ends recursion on cyclic data; <code>UNION ALL</code> doesn't and can loop forever (PostgreSQL 14 added <code>SEARCH</code> and <code>CYCLE</code> clauses). It's correct at any depth, but verbose next to Cypher.`,
      ex: `All places within the United States: <code>WITH RECURSIVE in_usa(vertex_id) AS (SELECT vertex_id FROM vertices WHERE properties-&gt;&gt;'name' = 'United States' UNION SELECT e.tail_vertex FROM edges e JOIN in_usa ON e.head_vertex = in_usa.vertex_id WHERE e.label = 'within') SELECT * FROM in_usa</code>. Written <code>WITH RECURSIVE</code> in PostgreSQL, MySQL 8.0+ and SQLite; SQL Server, Oracle (11g R2+) and DB2 omit the keyword, and Oracle also has <code>CONNECT BY</code>.`,
      section: "property-graphs",
    },

    // ── triples-and-datalog ─────────────────────────────────────────────
    {
      id: "triple-store-rdf-sparql",
      term: "Triple-store / RDF / SPARQL",
      def: `All data as (subject, predicate, object) triples. The subject is a vertex; the object is either a primitive value, making the triple a property (<code>lucy age 33</code>), or another vertex, making it an edge (<code>lucy marriedTo alain</code>). <strong>RDF</strong> (Resource Description Framework) is the W3C data model for such triples, written for example in Turtle; <strong>SPARQL</strong> (pronounced "sparkle") is its query language.`,
      problem: `Combining graph data from many independent sources needs a uniform representation and globally unambiguous names.`,
      why: `Properties and edges are the same mechanism (both are just predicates), so any graph flattens into facts. RDF names predicates, and often subjects, with URIs (e.g. <code>&lt;http://my-company.example/ns#within&gt;</code>, shortened with <code>PREFIX</code>) so one publisher's "within" can't clash with another's when datasets merge; the URI need not resolve to anything. The semantic-web vision was overhyped, but RDF thrives in knowledge graphs and data integration. SPARQL predates Cypher (Cypher borrowed its pattern matching) and supports property paths such as <code>:within*</code> for variable-depth traversal. Edge properties need reification, an intermediate node, or RDF-star (being standardized as part of RDF 1.2).`,
      ex: `Wikidata publishes its knowledge graph as RDF with a public SPARQL endpoint, where queries routinely use paths like <code>wdt:P31/wdt:P279*</code> (instance of a subclass of, at any depth). The emigrants query: <code>?person :bornIn/:within* ?us . ?us :name "United States" .</code> Stores: Apache Jena, Virtuoso, Amazon Neptune.`,
      section: "triples-and-datalog",
    },
    {
      id: "datalog",
      term: "Datalog",
      def: `A logic query language studied extensively in the 1980s, a subset of Prolog, that provides a foundation later query languages build on. Data is a set of facts written <code>predicate(subject, object)</code>, such as <code>within(idaho, usa)</code> (the same shape as triples); queries are <strong>rules</strong> (<code>Head :- Body</code>, read "Head holds if Body holds") that derive new facts and can call other rules, including themselves.`,
      problem: `Recursive, reusable query logic (a transitive "within") is clumsy to restate in every query that needs it.`,
      why: `Rules are named and composable like functions, so recursive logic is defined once and reused in bigger rules. Evaluation applies rules round after round until a round derives nothing new (a fixpoint); pure Datalog has no function symbols, so the derivable facts are finite and evaluation always terminates. Real engines evaluate predicates in dependency order and use semi-naive evaluation (only new facts feed recursive rules) plus magic-sets rewriting to skip facts the query doesn't need. For a quick one-off lookup it's clumsier than a single pattern; it pays off when the logic grows complex enough to want named, reusable pieces. Cypher and SPARQL don't descend from it; SQL's <code>WITH RECURSIVE</code> uses the same fixpoint idea.`,
      ex: `<code>within_recursive(Loc, Name) :- name(Loc, Name).</code> and <code>within_recursive(Loc, Name) :- within(Loc, Via), within_recursive(Via, Name).</code>, then <code>?- migrated(Who, 'United States', 'Europe').</code> (the first rule also matches people's names, which is harmless). Used by Datomic (its query language) and Cascalog (a Datalog-inspired query language for Hadoop); GitHub's CodeQL queries code with QL, a Datalog-derived language, and Soufflé is a Datalog engine for static analysis.`,
      section: "triples-and-datalog",
    },
  ],

  cheatsheet: [
    {
      title: "Relational vs document vs graph",
      type: "table",
      headers: ["Dimension", "Relational", "Document", "Graph"],
      rows: [
        ["Shape", "Flat tables of rows; relationships as foreign-key values", "Self-contained trees (JSON/BSON) addressed by ID", "Vertices and edges, both carrying properties"],
        ["Relationship it handles best", "Many-to-one and many-to-many, via joins", "One-to-many, via embedding", "Many-to-many with variable-depth paths"],
        ["Schema", "Explicit, enforced on write", "On read (implicit); optional validators (<code>$jsonSchema</code>)", "Usually none enforced (some support constraints)"],
        ["Locality", "One object spread over several tables = several lookups (unless interleaved)", "Whole document in one read, and usually one rewrite per update", "Neighbors via edge indexes; traversal hop by hop"],
        ["Many-to-many", "Natural: a join table", "Awkward: ID arrays + app-side joins, <code>$lookup</code>, or copies", "Native: edges"],
        ["Ad-hoc queries", "Excellent (SQL + optimizer)", "Good within a collection (query language, aggregation pipeline, <code>$lookup</code>); weak across collections", "Good for pattern and path queries; weaker for whole-dataset aggregates"],
        ["Query languages", "SQL", "MongoDB query language + aggregation pipeline (map-reduce deprecated)", "Cypher, Gremlin, SPARQL, GQL"],
        ["Typical pitfall", "ORM N+1 queries; heavy migrations on huge tables", "Duplicated data drifting; unbounded documents", "Harder to partition; weak at whole-dataset aggregates"],
        ["Best fit", "Business data with shared entities, constraints and cross-record queries", "Tree-shaped records loaded as a unit; heterogeneous records", "Highly connected data whose questions are paths"],
        ["Examples", "PostgreSQL, MySQL, Oracle, SQL Server; Spanner, CockroachDB", "MongoDB, CouchDB/Couchbase, Firestore, DynamoDB (KV + document), PostgreSQL jsonb (hybrid)", "Neo4j, Amazon Neptune, JanusGraph; RDF stores (Apache Jena, Virtuoso)"],
      ],
      note: "Most databases are now multi-model to a degree, so choose a model per access pattern rather than a camp.",
    },
    {
      title: "Relationship shapes and where they fit",
      type: "table",
      headers: ["Shape", "Example", "Fits a tree?", "Document model", "Relational model"],
      rows: [
        ["One-to-many", "A user's positions; an order's line items", "Yes", "Embed as an array or sub-object", "Child table with a foreign key; join"],
        ["Many-to-one", "Many users in one region; many positions at one company", "No", "Reference by ID (app-side join or <code>$lookup</code>), or copy the display name", "Foreign key to the shared row; join"],
        ["Many-to-many", "Users ↔ groups; users recommending users", "No", "ID array on the bounded side + multikey index, or a memberships collection", "Join table"],
        ["Variable depth", "City within state within country; org chart", "No", "<code>$graphLookup</code>, or loops in application code", "<code>WITH RECURSIVE</code>; or move to a graph model"],
      ],
    },
    {
      title: "Embed vs reference vs normalize",
      type: "table",
      headers: ["", "Embed (copy)", "Reference by ID (document)", "Normalized (SQL)"],
      rows: [
        ["Load one profile", "1 read", "2 round trips (app-side join)", "1 query with a join"],
        ["Rename a shared entity", "Rewrite every copy", "1 write", "1 write"],
        ["Reverse lookup \"who worked at X?\"", "Scan, or an extra (multikey) index on the copied field", "Scan, or a multikey index on the ID field", "Index on the foreign key"],
        ["Atomicity of the update", "Multi-document: needs a transaction", "Single document", "Single row"],
        ["Use when", "Owned, bounded, read together", "Shared or growing", "Relationships are many-to-one or many-to-many"],
      ],
      note: "Hybrid (extended reference): store the ID plus a rarely changing display name, refreshed asynchronously. Every copy is a cache: give it one owner and an update path (CDC, <a href=\"#/ch11/learn/change-data-capture\">Chapter 11</a>) and decide how stale it may be.",
    },
    {
      title: "Four data models across 50 years",
      type: "table",
      headers: ["", "Hierarchical (IMS, 1968)", "Network (CODASYL, 1970s)", "Relational (Codd, 1970)", "Document (2009 on)"],
      rows: [
        ["Structure", "Tree; every record has exactly one parent", "Records with several parents via owner/member sets", "Flat tables; no nesting", "Tree of nested records"],
        ["Many-to-many", "Duplicate data or hand-resolve references", "Pointer-like links", "Foreign keys + joins", "IDs + app-side join or <code>$lookup</code>, or copies"],
        ["Reaching a record", "Walk down the tree", "Move a cursor along access paths", "Any condition on any column", "By ID, secondary index or query language"],
        ["Who picks the access path", "Programmer", "Programmer", "Query optimizer", "Database (indexes + planner)"],
        ["New question or schema change", "Restructure and rewrite programs", "Rewrite navigation code", "Add an index; queries keep working", "Write the new shape; readers handle old ones"],
      ],
      note: "Document databases repeat IMS's nesting, not CODASYL's pointers: like relational databases, they refer to other records by an ID resolved at read time.",
    },
    {
      title: "Schema change: name → first_name + last_name",
      type: "table",
      headers: ["", "Relational (schema-on-write)", "Document (schema-on-read)"],
      rows: [
        ["What you run", "<code>ALTER TABLE ... ADD COLUMN</code> + batched <code>UPDATE</code> backfill", "Nothing; new writes use the new shape (optional backfill job)"],
        ["Cost", "ALTER: usually metadata-only. Backfill: rewrites every row. Older MySQL rebuilt the table (hence gh-ost, pt-osc)", "Zero up front; paid by every reader forever, or by an optional backfill"],
        ["Where bad data is caught", "At the writer, immediately", "In some reader, later"],
        ["Optional safety net", "Types, <code>NOT NULL</code>, <code>CHECK</code> constraints", "<code>$jsonSchema</code> validators (MongoDB 3.6+)"],
        ["Reader code", "One shape after the migration", "A branch per historical shape: <code>if (!u.first_name) ...</code>"],
        ["Type-system analogy", "Static (compile-time) checking", "Dynamic (run-time) checking"],
        ["Wins when", "Records share a structure; many independent readers", "Heterogeneous records; structure set by external systems"],
      ],
      note: "Both guarantee structure, not meaning: renaming or repurposing a field still breaks old readers, which is why expand/contract keeps the old field until every reader has moved.",
    },
    {
      title: "Zero-downtime migration (expand/contract)",
      type: "list",
      items: [
        "<strong>Expand</strong>: add the new nullable column(s): metadata-only in PostgreSQL, INSTANT in MySQL 8.0.12+, gh-ost/pt-osc on older MySQL; set a short <code>lock_timeout</code>",
        "<strong>Dual-write</strong> old and new from the app; start the backfill only after the rolling deploy finishes (old versions still write only the old column)",
        "<strong>Backfill</strong> in small, throttled, resumable batches by key range; watch replica lag and lock waits; never one giant UPDATE",
        "<strong>Read with fallback</strong> to the old column while the backfill runs (schema-on-read inside SQL)",
        "<strong>Verify, then switch</strong> all reads to the new columns",
        "<strong>Enforce</strong> (PostgreSQL): <code>CHECK (...) NOT VALID</code>, then <code>VALIDATE CONSTRAINT</code> without blocking writes",
        "<strong>Contract</strong>: stop writing the old column; drop it once no reader (including analytics jobs) uses it",
      ],
    },
    {
      title: "Locality checklist",
      type: "list",
      items: [
        "Pays off only when you read most of the document most of the time",
        "Reads usually load the whole document; updates usually rewrite it (only same-size changes are easy in place)",
        "Keep documents small; no unbounded arrays (events, comments, followers); MongoDB caps a document at 16 MB",
        "PostgreSQL TOASTs values over roughly 2 kB: reading one key of a big <code>jsonb</code> value fetches and decompresses all of it",
        "Locality without documents: Spanner <code>INTERLEAVE IN PARENT</code>, Oracle multi-table clusters, Bigtable/HBase column families",
        "Columnar storage for analytics (<a href=\"#/ch3/learn/column-storage\">Chapter 3</a>) is a different kind of locality: one column across many rows",
      ],
    },
    {
      title: "Imperative vs declarative query",
      type: "table",
      headers: ["", "Imperative", "Declarative"],
      rows: [
        ["You write", "A step-by-step algorithm (loops, conditions, variables)", "Conditions on the result plus transformations (filter, sort, group)"],
        ["Optimization", "Your responsibility, frozen when the code is written", "The optimizer picks a plan from statistics, and re-picks as data and indexes change"],
        ["New index or more cores", "Ignored until the code is rewritten", "Used automatically when estimated cheaper"],
        ["Parallelism", "Hard: the code fixes an order of operations", "Easy: only the pattern is specified"],
        ["Ordering", "Depends on storage order, often by accident", "No order without <code>ORDER BY</code>, so storage can be reorganized"],
        ["Control", "Full and explicit", "Indirect: <code>EXPLAIN</code>, statistics, indexes, hints"],
        ["Examples", "For-loops over arrays, IMS/CODASYL navigation, manual DOM manipulation", "SQL, CSS selectors, Cypher, SPARQL, Datalog, MongoDB aggregation pipeline"],
        ["In between", "MapReduce: you write map and reduce as code snippets...", "...but the framework decides where, in what order and how often they run"],
      ],
    },
    {
      title: "One query, three languages: monthly shark sightings",
      type: "table",
      headers: ["", "SQL", "MongoDB mapReduce", "Aggregation pipeline"],
      rows: [
        ["Filter", "<code>WHERE family = 'Sharks'</code>", "<code>query: {family: 'Sharks'}</code>, applied before map", "<code>{$match: {family: 'Sharks'}}</code>"],
        ["Group key", "<code>GROUP BY date_trunc('month', observed_at)</code>", "<code>emit(year + '-' + month, ...)</code> inside map", "<code>$group</code> on <code>{$year: ...}</code> and <code>{$month: ...}</code>"],
        ["Aggregate", "<code>sum(num_animals)</code>", "reduce returns <code>Array.sum(values)</code>", "<code>{$sum: '$numAnimals'}</code>"],
        ["What the database can optimize", "The whole query", "Only the filter; map and reduce are opaque code", "Every stage (reorder <code>$match</code>, use indexes)"],
        ["Status", "Standard", "Deprecated in MongoDB 5.0 (2021)", "Recommended since 2.2 (2012)"],
      ],
    },
    {
      title: "MapReduce rules",
      type: "list",
      items: [
        "<code>map(record)</code> emits (key, value) pairs; values are grouped by key; <code>reduce(key, values)</code> returns one value",
        "<strong>Pure</strong>: use only the input; no queries, no side effects, so the system can run them anywhere, in any order, and retry",
        "<strong>Re-reduce</strong>: reduce may run again on its own outputs, so it must be associative and commutative and return the type it receives",
        "Average = emit <code>{sum, count}</code>, add both, divide once at the end; never average averages",
        "Hive compiled HiveQL into MapReduce jobs; Spark SQL does not (it compiles to Spark stages)",
        "MapReduce as a distributed batch engine (shuffle, Hadoop): <a href=\"#/ch10/learn/mapreduce-and-hdfs\">Chapter 10</a>",
      ],
    },
    {
      title: "Variable-depth traversal",
      type: "table",
      headers: [`<span style="white-space:nowrap">Language</span>`, "Any number of hops", "Notes"],
      rows: [
        [`<span style="white-space:nowrap">Cypher</span>`, "<code>MATCH (a)-[:WITHIN*0..]-&gt;(b)</code>", "Created for Neo4j; one MATCH never traverses the same relationship twice, so <code>*0..</code> terminates on cycles; bound it (<code>*1..4</code>) on dense graphs"],
        [`<span style="white-space:nowrap">SPARQL</span>`, "<code>?x :within* ?y</code> (property path)", "Query language for RDF; predates Cypher"],
        [`<span style="white-space:nowrap">Datalog</span>`, "A recursive rule, evaluated to a fixpoint", "Terminates because the set of derivable facts is finite"],
        [`<span style="white-space:nowrap">SQL</span>`, "<code>WITH RECURSIVE</code>; SQL/PGQ graph patterns since SQL:2023", "<code>UNION</code> ends cycles, <code>UNION ALL</code> doesn't; PostgreSQL 14 <code>CYCLE</code> clause; SQL Server, Oracle and DB2 omit RECURSIVE"],
        [`<span style="white-space:nowrap">Gremlin</span>`, "<code>repeat(out('within')).emit()</code>", "Imperative traversal API (Apache TinkerPop)"],
        [`<span style="white-space:nowrap">GQL</span>`, "Cypher-like path patterns", "ISO/IEC 39075:2024, the first new ISO database query language since SQL"],
      ],
      note: "A query with a fixed number of joins silently misses deeper paths, and misses more every time someone adds a level to the hierarchy.",
    },
    {
      title: "Storing a hierarchy in SQL",
      type: "table",
      headers: ["Representation", "Read subtree", "Insert or move", "Notes"],
      rows: [
        ["Adjacency list (<code>parent_id</code>) + recursive CTE", "Any depth via recursion", "Cheap: one row", "Simplest; index <code>parent_id</code>; guard against cycles with UNION or a path check"],
        ["Materialized path (<code>'/1/4/9'</code>, e.g. PostgreSQL ltree)", "Prefix match, fast", "Moving a subtree rewrites every descendant's path", "Easy breadcrumbs and depth"],
        ["Nested sets (<code>lft</code>, <code>rgt</code>)", "Range query, very fast", "Inserts renumber many rows", "Read-mostly trees"],
        ["Closure table (ancestor, descendant, depth)", "One indexed lookup at any depth", "Extra rows per ancestor on insert", "Flexible; uses the most storage"],
      ],
    },
    {
      title: "Property graph vs RDF triple store",
      type: "table",
      headers: ["", "Property graph", "RDF triple store"],
      rows: [
        ["Unit of data", "Vertex and edge, each with an ID and properties; an edge has one label", "Triple (subject, predicate, object)"],
        ["Properties vs relationships", "Distinct: key-value properties vs edges", "Same mechanism: both are predicates"],
        ["Properties on a relationship", "Native", "Reification, an intermediate node, or RDF-star (RDF 1.2, in progress)"],
        ["Names", "Local IDs", "URIs, so datasets from different publishers merge cleanly"],
        ["Query languages", "Cypher/GQL (declarative), Gremlin (imperative)", "SPARQL, with property paths like <code>:within*</code>"],
        ["Schema and inference", "Optional constraints", "RDFS/OWL vocabularies and inference"],
        ["Pick it for", "Traversal-heavy application data", "Data integration, linked data, knowledge graphs (Wikidata)"],
        ["Systems", "Neo4j, Amazon Neptune, JanusGraph", "Apache Jena, Virtuoso, Amazon Neptune"],
      ],
    },
    {
      title: "Graph databases vs CODASYL: four differences",
      type: "list",
      items: [
        "<strong>Schema</strong>: CODASYL fixed which record type could be nested within which; in a graph any vertex can connect to any other",
        "<strong>Access</strong>: CODASYL reached records only by traversing an access path; a graph database can fetch a vertex directly by ID or through an index",
        "<strong>Order</strong>: CODASYL children were ordered sets the database maintained; graph vertices and edges are unordered and you sort at query time",
        "<strong>Queries</strong>: CODASYL navigation was imperative and broke when the schema changed; graph databases offer declarative languages (Cypher, SPARQL) alongside imperative APIs",
      ],
    },
    {
      title: "Reading Datalog",
      type: "list",
      items: [
        "Facts: <code>within(idaho, usa).</code>, <code>born_in(lucy, idaho).</code> (lowercase = constants)",
        "Rules: <code>Head :- Body.</code> reads \"Head holds if Body holds\"; commas mean \"and\"; capitalized words are variables",
        "Two rules with the same head mean \"or\"; a rule may call itself (recursion)",
        "Evaluation: apply rules round after round until a round derives nothing new (fixpoint); semi-naive evaluation feeds only new facts into recursive rules",
        "Same idea as SQL's <code>WITH RECURSIVE</code> working table",
      ],
    },
    {
      title: "When to pick each model",
      type: "list",
      items: [
        "<strong>Relational</strong>: many entity types that reference each other; many-to-one and many-to-many relationships; constraints and transactions; ad-hoc queries that cut across records",
        "<strong>Document</strong>: each record is a tree loaded and saved as a unit; heterogeneous or externally defined structure; few cross-record references; documents stay bounded",
        "<strong>Graph</strong>: anything can relate to anything; the questions are paths of unknown depth (social, fraud, network topology, knowledge graphs); relationship types keep evolving",
        "<strong>Hybrid</strong> (relational + JSON column) is often the pragmatic default",
        "<strong>Polyglot persistence</strong> is normal, but every extra store needs a sync path (CDC, <a href=\"#/ch11/learn/change-data-capture\">Chapter 11</a>) and an owner on call",
        "Choose by relationship shape and access pattern, not by scale folklore",
      ],
    },
    {
      title: "Red flags in a design review",
      type: "list",
      items: [
        "Embedding mutable shared entities (employer names, product prices, avatars) with no plan for updates",
        "Unbounded arrays inside documents (every comment in the post, every event in the user)",
        "Fixed-depth self-joins for hierarchies",
        "ORM lazy loading inside loops (N+1 queries)",
        "Impure map/reduce functions, or averaging averages",
        "Code that relies on storage order instead of <code>ORDER BY</code>",
        "\"Schemaless\" collections with no reader-side handling of old shapes",
        "Dual writes from application code to keep several stores in sync",
      ],
    },
    {
      title: "Numbers and versions to remember",
      type: "list",
      items: [
        "<strong>16 MB</strong>: MongoDB's maximum document (BSON) size",
        "<strong>~2 kB</strong>: PostgreSQL's TOAST threshold (larger values compressed or moved out of line)",
        "<strong>1 + 1 + N</strong>: lazy-loading queries for a user, its collection, and one association per element (12 positions = 14 queries)",
        "<strong>4 vs 29</strong>: lines of Cypher vs SQL for the emigrants query, in the book's version",
        "<strong>~1 billion reads/s</strong>: Facebook TAO, per its 2013 paper",
        "<strong>11.5 million</strong>: Panama Papers documents, explored as a Neo4j graph (2016)",
        "<strong>MongoDB</strong>: 2.2 aggregation pipeline · 3.2 <code>$lookup</code> and validation · 3.4 <code>$graphLookup</code> · 3.6 <code>$jsonSchema</code> · 4.0/4.2 transactions (replica sets/sharded) · 5.0 map-reduce deprecated",
        "<strong>PostgreSQL</strong>: 9.2 json · 9.3 JSON operators · 9.4 jsonb · 9.6 parallel query · 11 fast ADD COLUMN with default · 14 CYCLE/SEARCH",
        "<strong>MySQL</strong>: 5.7 JSON type · 8.0 recursive CTEs · 8.0.12 INSTANT ADD COLUMN (appended columns; any position since 8.0.29)",
      ],
    },
    {
      title: "Timeline",
      type: "list",
      items: [
        "<strong>1968</strong>: IBM IMS (hierarchical), built for Apollo program stock-keeping",
        "<strong>1970</strong>: Codd's \"A Relational Model of Data for Large Shared Data Banks\"",
        "<strong>Early 1970s</strong>: CODASYL network model; 1973 Bachman's Turing lecture \"The Programmer as Navigator\"",
        "<strong>1979</strong>: System R access-path selection paper (Selinger et al.); Oracle V2",
        "<strong>1986</strong>: first ANSI SQL standard",
        "<strong>2004</strong>: Google's MapReduce paper; <strong>2006–2007</strong>: Bigtable and Dynamo papers",
        "<strong>2009</strong>: the \"NoSQL\" meetup hashtag; MongoDB's first release",
        "<strong>2012</strong>: MongoDB aggregation pipeline; Spanner paper; PostgreSQL json type",
        "<strong>2014</strong>: PostgreSQL jsonb",
        "<strong>2015</strong>: MongoDB <code>$lookup</code>; openCypher; MySQL 5.7 JSON",
        "<strong>2018</strong>: MongoDB multi-document transactions; PostgreSQL 11 fast ADD COLUMN; MySQL INSTANT ADD COLUMN",
        "<strong>2021</strong>: MongoDB deprecates map-reduce",
        "<strong>2023</strong>: SQL/PGQ (SQL:2023 part 16)",
        "<strong>2024</strong>: ISO GQL",
      ],
    },
  ],

  interview: [
    // ── why-data-models ─────────────────────────────────────────────
    {
      id: "q-nosql-families",
      q: "What does \"NoSQL\" actually mean, and how do the main kinds of non-relational database differ?",
      diff: "easy",
      a: `<p><strong>NoSQL names a movement, not a technology.</strong> It began as a Twitter hashtag for a 2009 meetup on open-source, distributed, non-relational databases and was later reinterpreted as "Not Only SQL". Four forces drove it: datasets or write throughput beyond what the relational products of the time handled easily; a preference for open-source software; queries the relational model handles awkwardly (whole documents, deep chains of relationships); and frustration with rigid schemas. The stores under the label share little beyond not being relational.</p>
<p><strong>The main families</strong>, each making a different access pattern cheap:</p>
<ul>
<li><strong>Key-value</strong> (Redis, Riak; DynamoDB also supports documents): get and put by key, very fast, and not much else; any other lookup needs an extra index or a scan. Sessions, caches, carts, rate limits.</li>
<li><strong>Document</strong> (MongoDB, Couchbase, Firestore): JSON-like trees addressed by ID, with secondary indexes and a query language. Self-contained records loaded as a unit: profiles, catalogs, CMS pages.</li>
<li><strong>Wide-column</strong> (Bigtable, HBase, Cassandra): rows partitioned by key, with sorted keys or clustering columns that make range scans cheap; very high write throughput, but no joins, so you design one table per query. Time series, event logs, inboxes.</li>
<li><strong>Graph</strong> (Neo4j, Amazon Neptune): vertices and edges with variable-depth traversal. Social graphs, fraud rings, recommendations, knowledge graphs.</li>
</ul>
<p><strong>Two myths to retire.</strong> "NoSQL scales and SQL doesn't" describes late-2000s products, not models: Spanner, CockroachDB and Vitess-sharded MySQL scale relational data. "NoSQL means no schema" only moves the schema into every reader (schema-on-read). The lines have blurred too: MongoDB has joins and multi-document transactions, Cassandra is queried with the SQL-like CQL, and PostgreSQL stores and indexes JSON.</p>
<p><strong>How to choose:</strong> start from the access patterns and the shape of the relationships, not the label. Default to a store you can operate well (often a relational database, perhaps with a JSON column) and add a specialized one when a measured access pattern needs it, with a plan to keep it in sync (change data capture, <a href="#/ch11/learn/change-data-capture">Chapter 11</a>).</p>`,
      followups: [
        "Why does Cassandra data modeling start from the queries rather than the entities?",
        "Which of NoSQL's four original drivers still hold today?",
        "When would a key-value store be the wrong choice?",
      ],
      pitfalls: [
        "Treating \"NoSQL\" as a single kind of database",
        "\"NoSQL scales, SQL doesn't\"",
        "\"NoSQL means no schema\"",
      ],
      section: "why-data-models",
    },
    {
      id: "q08",
      q: "Give a scenario where you'd use polyglot persistence.",
      diff: "hard",
      a: `<p><strong>Scenario: an e-commerce marketplace.</strong> Its data has several access patterns, and each store makes a different one cheap:</p>
<ul>
<li><strong>PostgreSQL as the system of record</strong>: orders, payments, inventory, users. Shared entities, many-to-many relationships, constraints (stock can't go negative), multi-row transactions, ad-hoc reporting.</li>
<li><strong>Elasticsearch or OpenSearch</strong>: product search with full-text relevance, typo tolerance and faceted counts, which B-tree indexes do poorly.</li>
<li><strong>Redis</strong>: sessions, carts and rate limits: tiny key-value reads at sub-millisecond latency, data you can afford to rebuild.</li>
<li><strong>A graph store or a precomputed table</strong>: "customers who bought X also bought Y" and fraud rings (accounts sharing cards, devices, addresses) are multi-hop questions.</li>
<li><strong>Parquet on object storage plus a query engine</strong> (Spark, Trino, BigQuery): years of events scanned column by column for analytics (<a href="#/ch3/learn/column-storage">Chapter 3</a>).</li>
</ul>
<p><strong>The real cost is keeping them in sync.</strong> A product now lives in three places. Dual writes from application code (write PostgreSQL, then Elasticsearch) go wrong in two ways: two concurrent updates can land in different orders in the two stores, and a crash between the writes leaves them permanently different. Instead make one store the source of truth and derive the others from its change stream: change data capture (e.g. Debezium reading PostgreSQL's WAL into Kafka) or an event log (<a href="#/ch11/learn/change-data-capture">Chapter 11</a>), with idempotent consumers that can rebuild a derived store from scratch (<a href="#/ch12/learn/reprocessing">Chapter 12</a>). Then measure and accept the lag, e.g. search results a few seconds behind.</p>
<p><strong>And operational cost:</strong> every store needs backups, monitoring, upgrades, security and on-call knowledge. A small team may get years out of one PostgreSQL with jsonb, full-text search and pgvector, adding a specialized store only when a measured access pattern outgrows it.</p>`,
      followups: [
        "How do you keep Elasticsearch in sync with PostgreSQL?",
        "When is one multi-model database better than five specialized ones?",
        "What do users see while the sync pipeline is down, and how do you recover?",
      ],
      pitfalls: [
        "Dual writes from the application to every store",
        "Choosing a store per table, or one store for everything, without tying the choice to access patterns",
        "Ignoring the operational cost of each extra system",
      ],
      section: "why-data-models",
    },

    // ── impedance-mismatch ─────────────────────────────────────────────
    {
      id: "q02",
      q: "What is the object-relational impedance mismatch?",
      diff: "easy",
      a: `<p>It's the translation cost between how application code holds data (objects with nested collections and references) and how a relational database stores it (flat rows linked by key values). It has three parts:</p>
<ul>
<li><strong>Shape</strong>: a <code>User</code> object holds a list of positions, a list of schools and a contact-info object; normalized, that's four tables keyed by <code>user_id</code>. Saving shreds the object; loading reassembles it.</li>
<li><strong>Identity</strong>: objects are identified by references in memory, rows by primary keys; ORMs keep an identity map to reconcile them.</li>
<li><strong>Navigation</strong>: code follows pointers (<code>user.positions[0].company</code>); SQL performs joins.</li>
</ul>
<p><strong>ORMs (Hibernate, Active Record, Django) remove boilerplate, not the mismatch.</strong> The classic leak is <strong>N+1 queries</strong>: with lazy loading, a profile with 12 positions issues 1 query for the user, 1 for the positions collection, then 1 per position for its company: 1 + 1 + 12 = 14 round trips. That's a loading strategy, not a SQL limitation: one join, eager loading (Rails <code>includes</code>, JPA fetch joins or entity graphs) or batching gets the same data in 1–3 queries.</p>
<p><strong>Documents remove the mismatch only for tree-shaped data.</strong> Storing the profile as one JSON document means one read and no mapping layer. But each position's company is shared by many profiles, so you either store its ID (and join in the application) or copy its name (and handle renames): the mismatch comes back in another form.</p>`,
      followups: [
        "How would you detect and fix N+1 queries?",
        "Why doesn't storing the whole object as a JSON text column solve the problem?",
        "How does GraphQL relate to this mismatch?",
      ],
      pitfalls: [
        "\"ORMs eliminate the mismatch\"",
        "Blaming SQL for N+1 queries (it's the ORM's lazy loading)",
        "Claiming documents remove the mismatch for every kind of data",
      ],
      section: "impedance-mismatch",
    },

    // ── many-to-one ─────────────────────────────────────────────
    {
      id: "q04",
      q: "How does a document DB handle a many-to-many relationship like users-to-groups?",
      diff: "medium",
      a: `<p>The relationship doesn't fit a tree, so you decide where the references live and who resolves them. Four options:</p>
<ol>
<li><strong>Array of IDs on one side, plus a multikey index.</strong> Each user stores <code>groupIds: [g1, g7]</code>. "Groups of user u" is one read; "members of group g" is <code>find({groupIds: g})</code>, served by a multikey index on the array. Rule of thumb: put the array on the <strong>bounded</strong> side (a user's handful of groups), never on the unbounded side (a group's million members would approach MongoDB's 16 MB document limit and turn every join or leave into a rewrite of a huge document).</li>
<li><strong>Arrays on both sides (denormalized).</strong> Fast reads in both directions, but every membership change writes two documents. That's not atomic unless you use a multi-document transaction (MongoDB 4.0+ on replica sets, 4.2+ on sharded clusters), which adds latency and coordination; without one, a crash between the writes leaves the two sides disagreeing.</li>
<li><strong>Application-side join.</strong> Read the user, then fetch all its groups with one batched <code>{_id: {$in: [...]}}</code> query, not one query per group (that's N+1). Two round trips, more code, no optimizer.</li>
<li><strong>Join in the database.</strong> <code>$lookup</code> in the aggregation pipeline (MongoDB 3.2+) joins users to groups on the server; fine for occasional queries, though usually less flexible than a relational join.</li>
</ol>
<p>When the relationship itself carries data (role, joinedAt), a separate <code>memberships</code> collection of <code>{userId, groupId, role}</code> is common: a relational join table under another name. If many-to-many relationships dominate the product, that's the signal to keep that part of the data in a relational (or graph) model.</p>`,
      followups: [
        "Which side do you embed IDs on when one side is unbounded (a group with 1M members)?",
        "How do you show each group's current name on a user's page?",
        "What breaks if the process crashes between the two writes in option 2?",
      ],
      pitfalls: [
        "Storing an unbounded member list inside the group document",
        "Claiming document databases can't do joins or transactions today",
        "Fetching each related document in a loop (N+1)",
      ],
      section: "many-to-one",
    },
    {
      id: "q-embed-or-reference",
      q: "In a document database, how do you decide whether to embed related data or reference it?",
      diff: "medium",
      a: `<p>Decide per relationship, using four questions:</p>
<ul>
<li><strong>Ownership</strong>: does the child belong to exactly one parent (an order's line items, a user's addresses) or is it shared (a company, a product)? Owned favors embedding; shared favors a reference.</li>
<li><strong>Size and growth</strong>: is the set small and bounded ("one-to-few") or unbounded (comments, events, followers)? An unbounded array makes every read drag the whole history, makes each write rewrite an ever-larger document, and eventually hits MongoDB's 16 MB limit. Unbounded children get their own collection with the parent's ID on each child.</li>
<li><strong>Access pattern</strong>: is it read together with the parent, or updated and queried on its own?</li>
<li><strong>Change rate</strong>: a copied value that changes often (a price, an avatar) means write fan-out and stale copies.</li>
</ul>
<p><strong>Embed</strong> when the data is owned, bounded, read together and rarely updated on its own. Bonus: a single-document write is atomic, so a parent and its embedded children always change together.</p>
<p><strong>Reference</strong> when the data is shared, unbounded, updated independently or queried on its own; resolve references with one batched follow-up query or <code>$lookup</code>.</p>
<p><strong>Hybrid, the extended-reference pattern</strong>: keep the reference and also copy a few rarely changing display fields, e.g. <code>{org_id: 'o1', name: 'Acme Corp'}</code> in each position, so the hot read needs no join. Treat the copy as a cache: decide who refreshes it (a change stream or background job), how stale it may be, and whether copies that must change together need a multi-document transaction.</p>
<p><strong>Example:</strong> a blog post embeds its tags and an author summary <code>{id, name}</code>; comments live in their own collection keyed by <code>postId</code>, because they grow without bound and are paginated.</p>`,
      followups: [
        "What happens when an embedded array grows without bound?",
        "How would you keep denormalized copies consistent, and how stale may they be?",
        "How do you answer \"all posts by this author\" if the author is embedded?",
      ],
      pitfalls: [
        "Embedding everything \"because it's NoSQL\"",
        "Forgetting that multi-document updates aren't atomic without a transaction",
        "Copying mutable shared fields with no plan for updating them",
      ],
      section: "many-to-one",
    },
    {
      id: "q-normalize-vs-denormalize",
      q: "What are normalization and denormalization, and when would you deliberately denormalize?",
      diff: "medium",
      a: `<p><strong>Normalization</strong> stores each fact once and refers to it by ID, so a rename is one write and copies can't disagree (no update anomalies). The price is a join or lookup on every read that needs the value. The working rule: don't duplicate human-meaningful values that could live in one place.</p>
<p><strong>If asked for the formal normal forms</strong>, each removes one kind of duplication:</p>
<ul>
<li><strong>1NF</strong>: every column holds one atomic value; no repeating groups (no comma-separated list of phone numbers in one column).</li>
<li><strong>2NF</strong>: 1NF, and every non-key column depends on the <em>whole</em> key. In <code>order_lines(order_id, product_id, product_name, qty)</code>, <code>product_name</code> depends on <code>product_id</code> alone, so it belongs in <code>products</code>.</li>
<li><strong>3NF</strong>: 2NF, and no non-key column depends on another non-key column. In <code>users(user_id, zip, city)</code>, <code>city</code> follows from <code>zip</code>, so a city rename touches many rows.</li>
<li><strong>BCNF</strong>: a stricter 3NF in which every column that determines another is a candidate key.</li>
</ul>
<p>The usual summary of 3NF: each non-key column depends on "the key, the whole key, and nothing but the key". A JSON array column deliberately relaxes 1NF, which is fine for owned, one-to-many data read with its parent.</p>
<p><strong>Denormalization</strong> deliberately copies data to make a read cheaper, e.g. the company name stored next to <code>org_id</code> in each position.</p>
<p><strong>When I'd denormalize on purpose:</strong></p>
<ul>
<li>The join is expensive or impossible: the related data sits on other partitions (a cross-partition join on every request), or the store has no joins (Cassandra's one-table-per-query modeling, DynamoDB single-table design).</li>
<li>A hot read path has a tight latency budget and is read far more often than the copied field changes (a feed item carrying the author's display name).</li>
<li>Analytics, where star schemas trade update cost for scan speed (<a href="#/ch3/learn/oltp-vs-olap">Chapter 3</a>).</li>
</ul>
<p><strong>How to do it safely:</strong></p>
<ul>
<li>Copy only fields that rarely change or may be briefly stale, and keep the ID next to the copy so you can always go back to the source.</li>
<li>Treat every copy as <strong>derived data</strong> with one owner and one update path: change data capture or a stream consumer (<a href="#/ch11/learn/change-data-capture">Chapter 11</a>), or a materialized view maintained by the database.</li>
<li>Decide the acceptable staleness, and use a transaction when copies must change together (<a href="#/ch7/learn/why-transactions">Chapter 7</a>).</li>
<li>Try cheaper fixes first: an index, a cache, a materialized view.</li>
</ul>
<p>Don't confuse a copy with a snapshot: an order line storing the price at purchase time isn't denormalization; it's a different fact that must not change when the catalog does.</p>`,
      followups: [
        "Who updates the copies, and what happens if that job dies halfway?",
        "How is a materialized view different from denormalizing in application code?",
        "Give an example of a 3NF violation and the anomaly it causes.",
      ],
      pitfalls: [
        "Treating denormalization as free speed with no plan for keeping copies in sync",
        "Claiming normalization is always right, or always slow",
      ],
      section: "many-to-one",
    },
    {
      id: "q-design-profile-model",
      q: "Design the storage for a professional-network profile: positions, schools, skills, endorsements, company pages, recommendations and 'people you may know'. Which data model(s) would you use, and why?",
      diff: "hard",
      a: `<p><strong>Split the data by relationship shape</strong>, because one product holds differently shaped data:</p>
<ul>
<li><strong>Profile core</strong> (name, headline, summary, positions, education, contact info): a tree of one-to-many data owned by one user and loaded as a unit. Store it as a document, or as a relational row with a JSON column; one read renders the page.</li>
<li><strong>Companies, schools, skills</strong>: shared entities with their own pages (logo, followers, posts), i.e. many-to-one. Positions store <code>org_id</code>, never a free-text name. Optionally copy the display name next to the ID for the hot profile read and refresh copies asynchronously.</li>
<li><strong>Endorsements and recommendations</strong>: many-to-many between users, and each must show the author's <em>current</em> name and photo. Store them as rows in a join table (<code>author_id, recipient_id, text, created_at</code>) or as graph edges, never as embedded copies of the author.</li>
<li><strong>Connections and "people you may know"</strong>: a graph. Second- and third-degree candidates are multi-hop traversals: run them in a graph store, or precompute candidates offline with a batch job (<a href="#/ch10/learn/batch-outputs">Chapter 10</a>) and serve them from a key-value store keyed by user.</li>
<li><strong>Search</strong> ("engineers in Seattle who know Kafka"): an inverted index (Elasticsearch/OpenSearch) built from the other stores.</li>
</ul>
<p><strong>Keep the stores consistent</strong> with one source of truth per entity and change data capture into the derived stores (<a href="#/ch11/learn/change-data-capture">Chapter 11</a>), not dual writes.</p>
<p><strong>Walk the critical paths:</strong></p>
<ul>
<li><em>Read a profile</em>: 1 document read, 1 batched lookup of the referenced orgs and schools (or their cached copies), 1 query for recommendations joined to their authors' current names and photos.</li>
<li><em>Company rename</em> (Facebook becoming Meta in 2021 is a real case): 1 row update. Reads that go through the ID show the new name immediately; cached copies and the search index converge as the CDC consumer rewrites them, typically within seconds to minutes.</li>
<li><em>"Who worked at Acme?"</em>: an index on <code>positions.org_id</code> (a multikey index if positions are embedded).</li>
</ul>`,
      followups: [
        "A company renames itself. What exactly has to change in your design, and how long until every profile shows the new name?",
        "How do you show each recommender's current photo on every recommendation they wrote?",
        "How would you compute second-degree connections for hundreds of millions of members?",
      ],
      pitfalls: [
        "Embedding company names everywhere without a plan for renames",
        "Picking a single database for everything (or a different database for every table) without tying the choice to access patterns",
        "Running multi-hop graph queries as ad-hoc self-joins on the OLTP database",
      ],
      section: "many-to-one",
    },

    // ── repeating-history ─────────────────────────────────────────────
    {
      id: "q-history-repeating",
      q: "Some people argue that document databases repeat the mistakes of IMS. Do you agree?",
      diff: "hard",
      a: `<p><strong>Partly, and the true part is instructive.</strong></p>
<p><strong>Similarities with IMS (1968):</strong></p>
<ul>
<li>Both store nested one-to-many records: an IMS record tree and a JSON document are structurally alike, and both shine when data is a tree read as a unit.</li>
<li>Both find many-to-many awkward: a record with two parents must be duplicated or referenced by hand.</li>
<li>Early document stores lacked joins, pushing developers into duplication or application-side joins, just as IMS did.</li>
</ul>
<p><strong>Differences:</strong></p>
<ul>
<li>Document databases refer to other records by a unique ID resolved at read time (like a foreign key), not by pointers you navigate (CODASYL style). That's the same mechanism relational databases use.</li>
<li>They have secondary indexes and query languages, so the system, not the programmer, chooses the access path; nobody walks a cursor.</li>
<li>Modern versions closed many gaps: <code>$lookup</code> (3.2), <code>$graphLookup</code> (3.4), <code>$jsonSchema</code> validation (3.6), multi-document transactions (4.0/4.2).</li>
</ul>
<p><strong>The lasting lesson of the 1970s</strong> isn't "tables good, trees bad". It's that the system should choose access paths (declarative queries plus an optimizer), and that the model should follow the shape of the relationships: documents for the tree-shaped parts, joins (relational or <code>$lookup</code>) once many-to-one and many-to-many data grows. Stonebraker and Hellerstein's essay "What Goes Around Comes Around" (2005) makes the broader case that data-model proposals keep cycling back to old ideas.</p>`,
      followups: [
        "What did the relational optimizer give programmers that CODASYL didn't?",
        "In what four ways does a graph database differ from CODASYL?",
      ],
      pitfalls: [
        "Tribalism (\"NoSQL is bad\" / \"SQL is old\")",
        "Confusing the hierarchical (IMS) and network (CODASYL) models",
      ],
      section: "repeating-history",
    },

    // ── schema-flexibility ─────────────────────────────────────────────
    {
      id: "q03",
      q: "What do schema-on-read and schema-on-write mean, and what tradeoffs do they imply?",
      diff: "medium",
      a: `<p><strong>Schema-on-write</strong> (relational): the schema is explicit and the database rejects writes that don't conform. <strong>Schema-on-read</strong> (most document stores): the structure is implicit and interpreted by whoever reads the data. The analogy is static vs dynamic type checking.</p>
<p><strong>Trade-offs:</strong></p>
<ul>
<li><strong>Where errors surface</strong>: schema-on-write fails a bad write immediately, at the writer. Schema-on-read accepts a typo'd field, and some reader (perhaps another team's analytics job months later) trips over it.</li>
<li><strong>Cost of change</strong>: schema-on-read changes are free up front, since you just start writing the new shape. But old shapes live on, so every reader carries branches like <code>if (!u.first_name) u.first_name = u.name.split(' ')[0]</code> unless you backfill. Schema-on-write needs a migration, after which readers see one shape.</li>
<li><strong>Documentation</strong>: an explicit schema describes the data in one place; an implicit one is scattered across code.</li>
</ul>
<p><strong>Migration cost, precisely:</strong> <code>ALTER TABLE ... ADD COLUMN</code> is usually metadata-only (PostgreSQL for nullable columns, and since version 11 for non-volatile defaults too; MySQL <code>ALGORITHM=INSTANT</code> since 8.0.12 for an appended column). The slow part everywhere is the <code>UPDATE</code> backfill that rewrites every row. MySQL historically rebuilt the whole table for many ALTERs, which is why online schema-change tools such as Percona's pt-online-schema-change and GitHub's gh-ost exist. Leaving the new column NULL and filling it in at read time is schema-on-read inside SQL.</p>
<p><strong>Schema-on-read genuinely wins</strong> for heterogeneous records (many object types, where a table per type is impractical) and for structure dictated by external systems you don't control (webhook payloads, third-party events). <strong>Schema-on-write wins</strong> when records should share a structure, many independent programs read them, and correctness matters.</p>
<p><strong>Nuances:</strong> "schemaless" means implicit, not absent; MongoDB offers optional <code>$jsonSchema</code> validators (3.6+), and SQL databases offer JSON columns. And both approaches guarantee structure, not meaning: renaming or repurposing a field still breaks old readers.</p>`,
      followups: [
        "How would you split users.name into two columns on a 2-billion-row table with zero downtime? (See the zero-downtime migration question.)",
        "Where would you enforce required fields in a MongoDB collection?",
        "How does this relate to Avro's writer's and reader's schemas (<a href=\"#/ch4/learn/avro\">Chapter 4</a>)?",
      ],
      pitfalls: [
        "\"Schemaless means no schema\"",
        "Claiming every ALTER TABLE locks and copies the table",
        "Assuming schema-on-write removes the need to coordinate readers during a change",
      ],
      section: "schema-flexibility",
    },
    {
      id: "q-zero-downtime-migration",
      q: "You must split users.name into first_name and last_name on a 2-billion-row table with zero downtime. Walk me through it.",
      diff: "hard",
      a: `<p>Use <strong>expand/contract</strong> (parallel change): never change a column in place. Add the new shape, move everything over, then remove the old one. Each step deploys on its own and can be rolled back.</p>
<ol>
<li><strong>Agree on the split rule first.</strong> Names don't split cleanly (single names, multi-part surnames, family-name-first conventions). Decide with product what happens to ambiguous cases; you may want to keep a full display name anyway.</li>
<li><strong>Expand.</strong> Add nullable <code>first_name</code> and <code>last_name</code>. That's metadata-only in PostgreSQL and <code>ALGORITHM=INSTANT</code> in MySQL 8.0.12+; on older MySQL use an online schema-change tool (gh-ost, pt-online-schema-change). Set a short <code>lock_timeout</code> so the ALTER can't wait behind a long transaction while blocking everything queued behind it.</li>
<li><strong>Dual-write.</strong> Deploy code that writes <code>name</code> and the new columns on every insert and update. During a rolling deploy old versions still write only <code>name</code>, so start the backfill after the deploy completes (or make it repeatable).</li>
<li><strong>Backfill in batches.</strong> Update by primary-key range, a few thousand rows at a time, <code>WHERE first_name IS NULL</code>, throttled on replication lag and lock waits, and resumable. Never one giant UPDATE: on 2 billion rows it would hold locks for hours, bloat the table (PostgreSQL MVCC keeps old row versions) and leave every replica far behind.</li>
<li><strong>Read with fallback.</strong> Reads prefer the new columns and fall back to splitting <code>name</code> while the backfill runs: schema-on-read inside SQL.</li>
<li><strong>Verify, then switch.</strong> Count remaining NULLs, compare samples, then move all reads to the new columns.</li>
<li><strong>Enforce.</strong> In PostgreSQL add <code>CHECK (first_name IS NOT NULL) NOT VALID</code> (instant), then <code>VALIDATE CONSTRAINT</code>, which scans without blocking writes; from PostgreSQL 12, <code>SET NOT NULL</code> can then skip its own full scan.</li>
<li><strong>Contract.</strong> Stop writing <code>name</code>; drop it once no reader (other services, analytics jobs) uses it.</li>
</ol>
<p><strong>Rollback</strong> is easy at every step before the contract phase, because the old column stays complete and authoritative. In a document database the same dance happens without the ALTER: new writes use the new shape, readers handle both, and an optional background job rewrites old documents.</p>`,
      followups: [
        "How do you keep replicas from falling behind during the backfill?",
        "What would the same change look like in a document database?",
        "How do you roll back halfway through?",
      ],
      pitfalls: [
        "A single UPDATE over the whole table in one transaction",
        "Forgetting that old app versions keep writing the old column during a rolling deploy",
        "Assuming every name has exactly two parts",
      ],
      section: "schema-flexibility",
    },
    {
      id: "q-variable-attributes",
      q: "An e-commerce catalog sells TVs (screen size, refresh rate), shirts (size, color, fabric) and books (ISBN, author), and new categories appear every month. How would you store product attributes?",
      diff: "medium",
      a: `<p>This is the "heterogeneous items" case where schema-on-read genuinely helps. Lay out the options and their costs:</p>
<ol>
<li><strong>One wide table</strong> with a nullable column per attribute: simple, but sparse, and every new attribute is a migration.</li>
<li><strong>A table per category</strong>: typed and constrained, but every new category is a schema change, and cross-category queries need UNIONs.</li>
<li><strong>Entity-attribute-value rows</strong> <code>(product_id, attribute, value)</code>: endlessly flexible, but types and constraints are lost and reading one product needs a pivot or one self-join per attribute. Usually an anti-pattern at scale.</li>
<li><strong>The pragmatic answer: a relational core plus a JSON column.</strong> Real columns with constraints for what every product has and what you filter, join or aggregate on (<code>id, category, brand, price, stock</code>), and a <code>jsonb attrs</code> column for category-specific attributes. Index what you query: a GIN index for containment (<code>attrs @&gt; '{"color": "red"}'</code>), an expression index for ranges, e.g. <code>CREATE INDEX ON products (((attrs-&gt;&gt;'screen_in')::numeric))</code>. Validate with CHECK constraints or JSON Schema in the application, per category.</li>
<li><strong>A document database</strong>: the same idea with schema-on-read built in; keep price and stock as top-level, indexed fields.</li>
</ol>
<p><strong>Faceted search</strong> across categories ("TVs, 55 inches or more, under $800, by brand, with counts") usually goes to a search index (Elasticsearch/OpenSearch) fed from the catalog by change data capture.</p>`,
      followups: [
        "How would you index 'all TVs with a screen of at least 55 inches' in your design?",
        "Where do you enforce that every TV has a screen size?",
      ],
      pitfalls: [
        "Reaching for EAV by default",
        "Putting price and stock inside the JSON blob, where constraints, indexes and aggregates are awkward",
      ],
      section: "schema-flexibility",
    },

    // ── locality-and-convergence ─────────────────────────────────────────────
    {
      id: "q01",
      q: "When would you pick a document database over a relational one?",
      diff: "medium",
      a: `<p><strong>Choose by relationship shape and access pattern, not by scale folklore.</strong></p>
<p><strong>A document model fits when:</strong></p>
<ul>
<li>The data is a tree of one-to-many relationships loaded and saved as a unit (a profile with its positions, a CMS page with its blocks): one read, no shredding, a natural match for application objects.</li>
<li>Records are heterogeneous, or their structure is set by systems you don't control (event payloads, webhooks), so schema-on-read helps.</li>
<li>There are few references between records, or they are cheap to resolve (a small reference list cached in memory).</li>
<li>Documents stay small and bounded; you don't keep appending to them.</li>
</ul>
<p><strong>Stay relational when:</strong></p>
<ul>
<li>Shared entities are referenced from many places (<strong>many-to-one</strong>: regions, companies, products) or many-to-many relationships matter (users ↔ groups): joins keep each fact in one place.</li>
<li>Constraints and multi-record transactions are the norm, or queries slice across records (reporting, "who worked at Acme?").</li>
</ul>
<p><strong>Often the best answer is a hybrid</strong>: a relational schema with a JSON/JSONB column for the genuinely variable part (product attributes, preferences), or a document store that uses references plus <code>$lookup</code> where needed.</p>
<p><strong>Not good reasons:</strong> "it scales" (scale is a property of implementations; Spanner, CockroachDB and Vitess-sharded MySQL scale relational data) and "no schema" (the schema just moves into every reader). And "documents can't do transactions" is outdated: MongoDB has had multi-document transactions since 4.0 (2018), though they cost more than single-document writes, which are atomic by themselves.</p>`,
      followups: [
        "Your app later needs many-to-many (users ↔ groups). What now?",
        "How big can a document get, and what happens as it grows?",
        "Would you put product attributes in a JSON column or in a document database?",
      ],
      pitfalls: [
        "\"NoSQL = no schema\"",
        "\"NoSQL = scale\"",
        "Saying document databases can't join or run transactions (outdated since $lookup in 3.2 and transactions in 4.0)",
      ],
      section: "locality-and-convergence",
    },

    // ── declarative-queries ─────────────────────────────────────────────
    {
      id: "q05",
      q: "Explain declarative vs imperative query languages. Why is SQL declarative?",
      diff: "easy",
      a: `<p><strong>Imperative</strong> code spells out the steps and their order: loop over the animals, test each one, append the sharks to a result list. <strong>Declarative</strong> code states the conditions the result must satisfy and how to transform it (filter, sort, group, aggregate), and leaves the algorithm to the system: <code>SELECT * FROM animals WHERE family = 'Sharks'</code>.</p>
<p>SQL is declarative because it follows Codd's relational algebra: you describe a set of rows, and the <strong>query optimizer</strong> chooses the access path (which index, or a scan), the join order and algorithm (nested loop, hash, merge) and the degree of parallelism, using statistics about the data.</p>
<p><strong>Why it matters:</strong></p>
<ul>
<li><strong>Free improvements</strong>: add an index or upgrade the engine and existing queries can get faster with no code change (PostgreSQL 9.6 started running existing queries in parallel across cores).</li>
<li><strong>Storage freedom</strong>: the database can move rows around (vacuuming, compaction, reclustering) because SQL promises no order without <code>ORDER BY</code>. Imperative code that iterates storage often depends on order without realizing it.</li>
<li><strong>Parallelism</strong>: CPUs now grow by adding cores, not clock speed. A loop fixes an order of operations; a declarative query specifies only the pattern, so the engine can split it across cores or machines.</li>
<li><strong>Concision</strong>: less code, fewer places for bugs.</li>
</ul>
<p><strong>A browser analogy:</strong> the CSS rule <code>li.selected &gt; p { background: blue; }</code> stays correct as the <code>selected</code> class moves and gets faster as browsers improve. JavaScript that walks the DOM and sets styles must remember to undo them, and must be rewritten to use newer APIs such as <code>querySelectorAll</code>.</p>`,
      followups: [
        "What can go wrong with letting the optimizer choose? (See the declarative trade-offs question.)",
        "Where does MapReduce sit on this spectrum?",
        "Why doesn't SQL return rows in insertion order?",
      ],
      pitfalls: [
        "Equating declarative with \"shorter code\" and missing the optimizer and parallelism arguments",
        "Relying on the order rows come back without ORDER BY",
      ],
      section: "declarative-queries",
    },
    {
      id: "q-declarative-tradeoffs",
      q: "Declarative queries let the optimizer choose the plan. When does that hurt, and what do you do about it?",
      diff: "medium",
      a: `<p><strong>The benefit, briefly:</strong> the plan adapts to indexes, data size, cores and storage changes without touching the query.</p>
<p><strong>When it hurts:</strong></p>
<ul>
<li><strong>Misestimates</strong>: stale statistics after a bulk load, skew (one customer owns 40% of orders) or correlated columns (city and postal code) make a predicate look selective when it isn't, or vice versa, so the optimizer picks, say, a nested loop over millions of rows.</li>
<li><strong>Parameter-sensitive plans</strong>: a cached plan built for a rare value gets reused for a common one (SQL Server's "parameter sniffing").</li>
<li><strong>Plan regressions</strong>: a version upgrade or statistics refresh flips a plan overnight, with no code change to blame.</li>
<li><strong>Generated SQL</strong>: an ORM emits pathological queries (N+1 patterns, giant IN lists, needless joins).</li>
<li><strong>Surprises that are actually correct</strong>: the optimizer ignores your new index because the predicate matches a quarter of the table, where a sequential or bitmap scan really is cheaper.</li>
</ul>
<p><strong>What to do</strong>, roughly in order:</p>
<ol>
<li><strong>Read the plan</strong>: <code>EXPLAIN (ANALYZE, BUFFERS)</code> in PostgreSQL. Compare estimated and actual row counts at each node; a large gap marks the misestimate.</li>
<li><strong>Fix the inputs</strong>: refresh statistics (<code>ANALYZE</code>), raise the statistics target, add extended statistics for correlated columns (<code>CREATE STATISTICS</code>, PostgreSQL 10+).</li>
<li><strong>Fix the access path</strong>: the right composite, partial or covering index.</li>
<li><strong>Rewrite the query</strong>: e.g. don't wrap an indexed column in a function, or split an OR across two indexes into a UNION.</li>
<li><strong>Escape hatches</strong>: optimizer hints (Oracle and MySQL hints; the pg_hint_plan extension for PostgreSQL) and plan pinning (Oracle SQL Plan Management, SQL Server Query Store).</li>
</ol>
<p>Even these fixes live in one place, the database, rather than in every application, which was the original argument for declarative languages.</p>`,
      followups: [
        "What do you look at first in an EXPLAIN plan?",
        "Why doesn't SQL guarantee row order without ORDER BY?",
        "How would you catch a plan regression before it reaches production?",
      ],
      pitfalls: [
        "Saying declarative is always faster than hand-written code",
        "Relying on insertion order instead of ORDER BY",
      ],
      section: "declarative-queries",
    },

    // ── mapreduce-querying ─────────────────────────────────────────────
    {
      id: "q07",
      q: "Compare MapReduce querying to SQL for analytics.",
      diff: "medium",
      a: `<p><strong>MapReduce</strong> is a low-level programming model: a map function, called once per record, emits key-value pairs, and a reduce function, called once per key with all its values, combines them. In MongoDB's version a declarative filter runs first, map reads <code>this</code> and calls <code>emit()</code>, and reduce combines values. It sits <strong>between imperative and declarative</strong>: you write code, but the framework decides where and in what order it runs.</p>
<p><strong>Strengths:</strong> arbitrary code inside (parse strings, call libraries), natural parallelism across machines, and fault tolerance, because map and reduce must be <strong>pure</strong>: they use only their input, run no queries and have no side effects, so the system can run them anywhere, in any order, and re-run failed attempts.</p>
<p><strong>Weaknesses:</strong> two coordinated functions are harder to write than one GROUP BY; there are subtle rules (reduce may be re-applied to its own output, so it must be associative and commutative, and averaging averages is wrong); and the code is opaque, so the engine can't reorder it, push filters into it or pick indexes for it.</p>
<p><strong>SQL</strong> states the result (<code>SELECT date_trunc('month', observed_at), sum(num_animals) ... GROUP BY 1</code>) and leaves the how to the optimizer, and nothing about SQL restricts it to one machine. Some SQL engines did compile to MapReduce: Hive originally turned HiveQL into Hadoop MapReduce jobs. Most modern ones don't: Spark SQL compiles to Spark's own DAG of stages, and Trino, BigQuery and Flink SQL have their own distributed execution engines.</p>
<p><strong>History settled the interface question:</strong> MongoDB added the declarative aggregation pipeline in 2.2 (2012) and deprecated map-reduce in 5.0 (2021). MapReduce is a reasonable <em>runtime</em> idea; SQL-like languages won as the <em>interface</em>. (MapReduce as a distributed batch engine is the subject of <a href="#/ch10/learn/mapreduce-and-hdfs">Chapter 10</a>.)</p>`,
      followups: [
        "Why must map and reduce be pure? (See the purity question.)",
        "How would you compute a monthly average with map and reduce?",
        "Does Spark SQL run MapReduce jobs under the hood?",
      ],
      pitfalls: [
        "Saying Spark SQL compiles to MapReduce",
        "Recommending mapReduce for new in-database analytics in MongoDB",
        "Forgetting the purity requirement",
      ],
      section: "mapreduce-querying",
    },
    {
      id: "q-mapreduce-purity",
      q: "Why must map and reduce functions be pure, and what goes wrong if a reduce function isn't associative?",
      diff: "medium",
      a: `<p><strong>Pure</strong> means the output depends only on the input and the function does nothing else: no database queries, no writes to external systems, no clock or randomness that changes the result.</p>
<p><strong>Why it's required:</strong> the framework wants the freedom to run map and reduce on any node, in any order, any number of times. If a node dies mid-task, the task is re-run elsewhere and the partial output discarded; a slow task may even be run twice speculatively (<a href="#/ch10/learn/reduce-side-joins">Chapter 10</a>). That's only safe if running a function twice is indistinguishable from running it once. A mapper that increments an external counter or sends an email repeats that effect on every retry, and the effect can't be discarded. (MongoDB doesn't even give map and reduce access to the database.)</p>
<p><strong>Why reduce must be associative and commutative:</strong> reduce may run on partial groups and then again on its own outputs (combiners in Hadoop, re-reduce in MongoDB). So <code>reduce(k, [reduce(k, [a, b]), c])</code> must equal <code>reduce(k, [a, b, c])</code> for any grouping and order, and the output must have the same type as the emitted values. Sum, count, min and max qualify; average doesn't.</p>
<p><strong>The classic bug, averaging averages:</strong> four December sightings of 3, 4, 1 and 2 sharks. If reduce averages, [3, 4] reduces to 3.5 and re-reducing [3.5, 1, 2] gives about 2.17, but the true mean is 2.5. Fix: emit <code>{sum, count}</code> pairs, reduce by adding both fields, and divide once at the end (MongoDB's <code>finalize</code> function, or a final projection).</p>`,
      followups: [
        "How would you compute an average correctly with MapReduce?",
        "What replaced mapReduce in MongoDB and why?",
      ],
      pitfalls: [
        "Computing an average of averages",
        "Writing to an external database from inside map",
      ],
      section: "mapreduce-querying",
    },

    // ── property-graphs ─────────────────────────────────────────────
    {
      id: "q06",
      q: "What problem does the graph data model solve that relational struggles with?",
      diff: "medium",
      a: `<p><strong>Variable-depth traversal over highly connected data</strong>, where many-to-many relationships dominate and the questions are about paths.</p>
<p>Example: "people born in the US who now live in Europe". Birthplaces are recorded at different granularities (a city, a state, the country itself), so the path from a person up to "United States" is 0, 1, 2 or more <code>WITHIN</code> hops. In Cypher:</p>
<pre><code>MATCH (p:Person)-[:BORN_IN]-&gt;()-[:WITHIN*0..]-&gt;(:Location {name: 'United States'}),
      (p)-[:LIVES_IN]-&gt;()-[:WITHIN*0..]-&gt;(:Location {name: 'Europe'})
RETURN p.name</code></pre>
<p><strong>What SQL struggles with, precisely:</strong> SQL <em>can</em> traverse arbitrary depth with <code>WITH RECURSIVE</code>, but the query is verbose (the book's version is 29 lines against 4 of Cypher), each hop is a join, and the common shortcut, a fixed number of self-joins, silently misses anyone one level deeper than planned and breaks again whenever a level is added.</p>
<p>Graphs also make heterogeneous relationships cheap: one graph holds <code>KNOWS</code>, <code>WORKS_AT</code>, <code>BORN_IN</code> and <code>LIVES_IN</code> edges between different kinds of vertices, any vertex can link to any other without a schema change, and edges can be followed in both directions. People within three hops of Alice:</p>
<pre><code>MATCH (alice:Person {name: 'Alice'})-[:KNOWS*1..3]-&gt;(p)
WHERE p &lt;&gt; alice
RETURN DISTINCT p</code></pre>
<p>Binding the start node keeps the query from scanning everyone; <code>WHERE p &lt;&gt; alice</code> matters because a cycle (alice → bob → alice) would otherwise return Alice herself; <code>DISTINCT</code> removes people reachable by several paths.</p>
<p><strong>Real uses:</strong> social graphs (Facebook's TAO), fraud rings sharing devices or cards, network and dependency topology, knowledge graphs, the ICIJ's Panama Papers investigation (Neo4j). <strong>Modern:</strong> SQL:2023 added SQL/PGQ (graph patterns over relational tables) and ISO published GQL in 2024. <strong>Not a free lunch:</strong> unbounded traversals on dense graphs explode, graphs are hard to partition, and whole-dataset aggregates are better done in SQL or a batch engine.</p>`,
      followups: [
        "How do you stop a variable-length traversal from exploding on a dense graph?",
        "How would you store a property graph in PostgreSQL?",
        "How might the optimizer decide where to start the emigrants query?",
      ],
      pitfalls: [
        "\"Graph databases are always faster for joins\"",
        "Claiming SQL can't do recursion",
        "Running unbounded *.. patterns from an unbound start node in production",
      ],
      section: "property-graphs",
    },
    {
      id: "q-hierarchy-in-sql",
      q: "You need to store an org chart (or a product category tree) and query 'everything under node X at any depth'. Would you use SQL or a graph database?",
      diff: "medium",
      a: `<p><strong>SQL handles this well</strong>; a tree doesn't need a graph database.</p>
<p><strong>Default design:</strong> an adjacency list, <code>categories(id, parent_id, name)</code> with an index on <code>parent_id</code>, queried with a recursive CTE:</p>
<pre><code>WITH RECURSIVE subtree AS (
  SELECT id, name FROM categories WHERE id = 42
  UNION
  SELECT c.id, c.name
  FROM categories c JOIN subtree s ON c.parent_id = s.id
)
SELECT * FROM subtree;</code></pre>
<ul>
<li><strong>Portability:</strong> <code>WITH RECURSIVE</code> in PostgreSQL, MySQL 8.0+ and SQLite; SQL Server, Oracle and DB2 write recursive CTEs without the RECURSIVE keyword, and Oracle also has <code>CONNECT BY</code>.</li>
<li><strong>Cycles:</strong> <code>UNION</code> (not <code>UNION ALL</code>) discards rows already produced, so a cycle created by a bad update ends the recursion instead of looping forever. If you add a depth or path column, rows in a cycle are no longer duplicates, so add an explicit guard: track the visited path, use PostgreSQL 14's <code>CYCLE</code> clause, or cap the depth. Better still, prevent cycles on write.</li>
</ul>
<p><strong>Alternatives trade write cost for read speed:</strong> a materialized path (<code>'/1/4/9'</code>, e.g. PostgreSQL's ltree) makes subtree reads a prefix match but moving a subtree rewrites every descendant; nested sets make reads a range query but inserts renumber many rows; a closure table storing every ancestor-descendant pair makes any-depth reads one indexed lookup at the cost of extra rows per insert.</p>
<p><strong>A graph database earns its place</strong> when traversals are arbitrary-depth <em>and</em> multi-relational <em>and</em> ad hoc (several edge types, patterns like "colleagues of colleagues who worked at X"), or when the graph is the core of the product. In between, SQL:2023's SQL/PGQ brings graph pattern queries to relational tables.</p>`,
      followups: [
        "How do you prevent cycles?",
        "Which representation is best if the tree changes constantly vs rarely?",
        "Your recursive query never finishes. What happened?",
      ],
      pitfalls: [
        "Claiming SQL can't do recursion",
        "Hard-coding a fixed number of self-joins",
      ],
      section: "property-graphs",
    },

    // ── triples-and-datalog ─────────────────────────────────────────────
    {
      id: "q-property-graph-vs-rdf",
      q: "Property graph vs RDF triple store: what's the difference, and when would you pick each?",
      diff: "medium",
      a: `<p><strong>Property graph:</strong> vertices and edges each have an ID and key-value properties, and each edge has a label (a type). Queried with Cypher/GQL (declarative) or Gremlin (imperative). Geared to application-centric traversal: "friends of friends who work at X".</p>
<p><strong>RDF triple store:</strong> everything is a <code>(subject, predicate, object)</code> triple. Properties and relationships are the same mechanism: <code>lucy :age 33</code> and <code>lucy :marriedTo alain</code> are both just predicates. Names are URIs, so datasets from different publishers merge without clashes; queries use SPARQL, with property paths such as <code>:within*</code>; and there are standards for vocabularies and inference (RDFS, OWL).</p>
<p><strong>The practical difference shows up on relationship properties.</strong> To record that Lucy lived in London from 2010 to 2015, a property graph puts <code>{from: 2010, to: 2015}</code> on the <code>LIVED_IN</code> edge. In RDF you introduce an intermediate node (a "residence" with person, place, from and to), use reification, or use RDF-star, which lets a triple be the subject of another triple and is being standardized by the W3C as part of RDF 1.2.</p>
<p><strong>Pick RDF</strong> for data integration, linked or open data, and knowledge graphs that span sources: Wikidata publishes its graph as RDF behind a public SPARQL endpoint, and schema.org markup (often JSON-LD) is how search engines read structured facts from web pages. <strong>Pick a property graph</strong> for traversal-heavy application data you own: fraud detection, recommendations, network topology. Some services support both; Amazon Neptune offers Gremlin, openCypher and SPARQL.</p>`,
      followups: [
        "How would you record that Lucy lived in London from 2010 to 2015 in each model?",
        "What does SPARQL's :within* do?",
        "Why do URIs matter when merging datasets from two organizations?",
      ],
      pitfalls: [
        "Saying RDF died with the semantic web",
        "Claiming triple stores can't express edge properties at all",
      ],
      section: "triples-and-datalog",
    },
  ],
});
