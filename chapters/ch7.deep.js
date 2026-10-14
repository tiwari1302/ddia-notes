// Chapter 7 deep dive, part 1 (hook + why transactions through snapshot isolation).
// Part 2 (lost updates through SSI, takeaways, connections, reading) lives in ch7.deep2.js.
// Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch7", {
  hook: `<p>In early March 2014 Flexcoin, a small operation that billed itself as a bitcoin bank, posted a notice that it was closing for good. An attacker had found that Flexcoin let customers move coins between accounts, and fired <strong>thousands of transfer requests at it simultaneously</strong>. Each request checked that the sending account held enough coins, then moved them. Because so many checks ran before any of the debits had landed, every check passed, and the same coins were moved again and again until the sending account was overdrawn. About <strong>896 BTC</strong> were gone, and the business with them. Within days the exchange Poloniex reported a similar hole in its withdrawal code, where withdrawals placed at almost the same instant could each pass the balance check, and reportedly lost about 12.3% of the bitcoin it held.</p>
<p>Nothing crashed. No query returned a wrong answer: each balance check was correct at the instant it ran, and each transfer, taken alone, was legitimate. The bug lived entirely in the gap between <em>check</em> and <em>act</em> when requests overlap, a <strong>check-then-act race</strong>. Storing balances in "a real database" doesn't close that gap, and wrapping the code in BEGIN and COMMIT doesn't necessarily close it either: that depends on a setting most teams never look at.</p>
<p>This chapter is about what that setting controls. A <strong>transaction</strong> turns a series of reads and writes into something that happens completely or not at all, so a crash halfway through leaves nothing behind. Its <strong>isolation level</strong> decides which interleavings of concurrent transactions the database permits, and therefore which races, Flexcoin's among them, can still slip through. By the end you should be able to answer, for your own database, the question this chapter is built around: what exactly does it promise when two things happen at once, or when something fails halfway?</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "why-transactions",
      title: "Why transactions exist: two outcomes instead of a thousand",
      kicker: "Motivation",
      concepts: ["multi-object-transactions"],
      blocks: [
        {
          type: "problem",
          title: "A thousand ways to fail halfway",
          html: `<p>Make a list of everything that can go wrong while an application changes data. The database software or its disk can fail in the middle of a write. The application server can crash after the first of five related writes. The network can drop between the app and the database, or between two database nodes. Two clients can write the same record at once and silently overwrite each other. A reader can catch a record halfway through an update. Races between clients can produce results no client intended. The list never really ends, and every item combines with every other.</p>
<p>The naive answer is to issue independent writes and patch things up in application code. It rarely works: after a crash the app often can't even tell which of its writes landed, and races depend on timing, so tests almost never reproduce them. Take an email app that stores each message as a row and keeps an <strong>unread counter</strong> per user, so the inbox badge is cheap to display. It inserts the new message, then increments the counter, as two separate statements. A reader that runs between them sees the new email next to a badge that says 0. A crash between them leaves the counter wrong forever, because nothing will ever come back to fix it.</p>`,
        },
        {
          type: "idea",
          html: `<p>A <strong>transaction</strong> groups several reads and writes into one logical unit that either <strong>commits</strong> (every write takes effect) or <strong>aborts</strong> (none does). The application handles two outcomes instead of hundreds of partial states, and when it gets an abort it can simply try again.</p>`,
        },
        {
          type: "text",
          html: `<p>That is the whole trick. Partial failure, where some steps succeeded and others didn't, is replaced by total failure, which is far easier to reason about. Concurrency is tamed in the same stroke: the database promises, to a degree you choose, that other clients won't see or disturb your half-finished work.</p>
<p>A transaction is not a law of nature, though. It is an abstraction someone designed to simplify the programming model, and it has costs: coordination, waiting on locks or redoing aborted work, and in distributed systems, availability. Some applications can do without it, and some guarantees can be had more cheaply. This chapter's aim is to know exactly what you get and what you pay, so you can make that call deliberately.</p>
<p>The transaction model that MySQL, PostgreSQL, Oracle and SQL Server follow comes, in broad strokes, from <strong>IBM System R</strong> in the mid-1970s, and it barely changed for three decades. Then, in the late 2000s, many NoSQL systems dropped transactions or redefined the word to mean something much weaker, in the name of scalability and availability. Two slogans grew up around that split: "transactions don't scale" and "every serious application needs full ACID". Both are hyperbole. The reality is a menu of specific guarantees with specific prices.</p>
<p>The diagram shows the email example's two failure modes. They look alike from the user's chair, but they are different bugs with different causes.</p>`,
        },
        {
          type: "diagram",
          title: "One unread counter, two different bugs",
          svg: `<style>.ch7a-n{display:none!important}@media (max-width:600px){.ch7a-w{display:none!important}.ch7a-n{display:block!important}}</style>
<svg class="ch7a-w" viewBox="0 0 640 280" role="img" aria-label="Top: a second user reads the inbox between the insert and the counter update and sees one new email with an unread count of zero. Bottom: the insert succeeds, the counter update fails, and the counter stays wrong.">
<defs><marker id="ch7a-em-w-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<rect x="8" y="8" width="624" height="140" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="24" y="32" font-size="14" font-weight="700" style="fill: var(--viz-bad)">Isolation violated</text>
<text x="166" y="32" font-size="12" style="fill: var(--viz-muted)">a reader runs between the two writes</text>
<line x1="96" y1="70" x2="616" y2="70" style="stroke: var(--viz-grid)"/>
<line x1="96" y1="120" x2="452" y2="120" style="stroke: var(--viz-grid)"/>
<text x="24" y="75" font-size="13" font-weight="700" style="fill: var(--viz-c6)">User 1</text>
<text x="24" y="125" font-size="13" font-weight="700" style="fill: var(--viz-c5)">User 2</text>
<rect x="110" y="56" width="130" height="28" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="175" y="75" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">INSERT email</text>
<rect x="456" y="56" width="160" height="28" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="536" y="75" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">UPDATE unread + 1</text>
<rect x="252" y="106" width="96" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="300" y="125" font-size="12" text-anchor="middle">1 new email</text>
<rect x="356" y="106" width="92" height="28" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="402" y="125" font-size="12" text-anchor="middle">unread: 0</text>
<text x="462" y="118" font-size="12" font-weight="600" style="fill: var(--viz-bad)">inbox shows a message,</text>
<text x="462" y="134" font-size="12" font-weight="600" style="fill: var(--viz-bad)">counter shows 0</text>
<rect x="8" y="156" width="624" height="116" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="24" y="180" font-size="14" font-weight="700" style="fill: var(--viz-bad)">Atomicity violated</text>
<text x="166" y="180" font-size="12" style="fill: var(--viz-muted)">the second write fails</text>
<line x1="96" y1="220" x2="256" y2="220" style="stroke: var(--viz-grid)"/>
<text x="24" y="225" font-size="13" font-weight="700" style="fill: var(--viz-c6)">User 1</text>
<rect x="110" y="206" width="130" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="175" y="225" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">INSERT email ✓</text>
<rect x="256" y="206" width="168" height="28" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="340" y="225" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">UPDATE unread ✗</text>
<text x="340" y="254" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">crash or constraint error</text>
<line x1="426" y1="220" x2="456" y2="220" stroke-width="1.5" style="stroke: var(--viz-bad)" marker-end="url(#ch7a-em-w-bad)"/>
<rect x="460" y="198" width="156" height="46" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="538" y="218" font-size="13" font-weight="700" text-anchor="middle">counter is wrong</text>
<text x="538" y="236" font-size="12" text-anchor="middle">forever</text>
</svg>
<svg class="ch7a-n" viewBox="0 0 360 392" role="img" aria-label="Top: a second user reads the inbox between the insert and the counter update and sees one new email with an unread count of zero. Bottom: the insert succeeds, the counter update fails, and the counter stays wrong.">
<rect x="6" y="6" width="348" height="190" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="18" y="30" font-size="14" font-weight="700" style="fill: var(--viz-bad)">Isolation violated</text>
<text x="18" y="48" font-size="12" style="fill: var(--viz-muted)">a reader runs between the two writes</text>
<line x1="70" y1="80" x2="346" y2="80" style="stroke: var(--viz-grid)"/>
<line x1="70" y1="135" x2="256" y2="135" style="stroke: var(--viz-grid)"/>
<text x="18" y="84" font-size="12" font-weight="700" style="fill: var(--viz-c6)">User 1</text>
<text x="18" y="139" font-size="12" font-weight="700" style="fill: var(--viz-c5)">User 2</text>
<rect x="72" y="66" width="94" height="28" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="119" y="85" font-size="12" text-anchor="middle">insert email</text>
<rect x="256" y="66" width="90" height="28" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="301" y="85" font-size="12" text-anchor="middle">unread + 1</text>
<rect x="172" y="106" width="80" height="26" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="212" y="124" font-size="12" text-anchor="middle">1 new email</text>
<rect x="172" y="138" width="80" height="26" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="212" y="156" font-size="12" text-anchor="middle">unread: 0</text>
<text x="18" y="184" font-size="12" font-weight="600" style="fill: var(--viz-bad)">inbox shows a message, counter shows 0</text>
<rect x="6" y="204" width="348" height="180" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="18" y="228" font-size="14" font-weight="700" style="fill: var(--viz-bad)">Atomicity violated</text>
<text x="18" y="246" font-size="12" style="fill: var(--viz-muted)">the second write fails</text>
<line x1="70" y1="278" x2="186" y2="278" style="stroke: var(--viz-grid)"/>
<text x="18" y="282" font-size="12" font-weight="700" style="fill: var(--viz-c6)">User 1</text>
<rect x="72" y="264" width="104" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="124" y="283" font-size="12" text-anchor="middle">insert email ✓</text>
<rect x="186" y="264" width="160" height="28" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="266" y="283" font-size="12" text-anchor="middle">update unread ✗</text>
<text x="266" y="310" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">crash or constraint error</text>
<rect x="18" y="324" width="324" height="48" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="180" y="344" font-size="13" font-weight="700" text-anchor="middle">counter is wrong forever</text>
<text x="180" y="362" font-size="12" text-anchor="middle">nothing will ever repair it</text>
</svg>`,
          caption: `Isolation stops others from seeing your half-done work; atomicity stops a failure from leaving it half-done. The top bug needs a concurrent reader, the bottom one needs only a crash, and one transaction around both statements fixes both.`,
        },
        {
          type: "text",
          html: `<p>Notice that each statement in the diagram was safe on its own. The insert either stored the whole message or nothing, and the increment either happened or didn't. The damage came from the gap between two individually correct writes, and that gap is exactly what a transaction closes.</p>
<h3>One object at a time is (almost) a solved problem</h3>
<p>Storage engines almost universally make a write to a <em>single</em> object atomic and isolated. Suppose you write a 20 KB JSON document and the network drops after the first 10 KB arrive: the database discards the fragment rather than storing half a document it can't parse. If the power fails while the engine is overwriting a value, recovery gives you the old value or the new one, never a splice of both. And a concurrent reader never sees the document half-written. The mechanisms are the ones from Chapter 3: a <strong>log</strong> (such as a <a href="#/ch3/learn/write-ahead-log">write-ahead log</a>) to recover a consistent state after a crash, and a <strong>lock on each object</strong> so only one thread modifies it at a time.</p>
<p>Some databases go further with richer single-object operations: an atomic <strong>increment</strong> such as Redis's <code>INCR</code>, which removes the read-modify-write cycle entirely, or <strong>compare-and-set</strong>, which writes only if the value hasn't changed since you read it (Cassandra's <code>INSERT … IF NOT EXISTS</code> and <code>UPDATE … IF</code>). They are genuinely useful, and the section on lost updates leans on them. Vendors sometimes market them as "lightweight transactions" (Cassandra's own name for its conditional writes) or even as "ACID", but they are not transactions in the usual sense. A transaction groups operations on <em>several</em> objects, and many real invariants span several objects.</p>`,
        },
        {
          type: "list",
          title: "Why one object at a time isn't enough",
          items: [
            `<strong>Foreign keys.</strong> Inserting an order and its line items touches several tables, and each line item points at the order. If some inserts land and others don't, references dangle or rows go missing. A multi-object transaction keeps the graph of references valid.`,
            `<strong>Denormalized documents.</strong> Document databases without joins push you to store data where it is read, so one logical change often updates several documents: the message and the unread counter, or a post and its author's post count. Single-document atomicity can't keep them in step.`,
            `<strong>Secondary indexes.</strong> Every index is a separate structure that must change whenever the record does. Without a transaction spanning both, a crash or a concurrent query can find a record in one index but not another, or an index entry pointing at a value that isn't there.`,
          ],
        },
        {
          type: "text",
          html: `<h3>How the database knows which writes belong together</h3>
<p>In a relational database the grouping is tied to the client's connection: everything between <code>BEGIN TRANSACTION</code> and <code>COMMIT</code> on one connection is one transaction. That convention is simple, and it has a sharp edge the section on aborts and retries explores: if the connection dies after the client sends <code>COMMIT</code> but before the reply arrives, the client doesn't know which outcome it got.</p>
<p>Many non-relational APIs have no such grouping. A multi-put or batch-write call bundles several writes into one request but may apply some and not others. DynamoDB's <code>BatchWriteItem</code>, for example, can hand back a list of <code>UnprocessedItems</code> for the caller to resubmit: each item is written atomically, but the batch as a whole is not. Before relying on a "batch", find out whether it is all-or-nothing.</p>
<p>One misconception to clear up before going further: transactions are not just a crash-recovery feature. They are the boundary for two separate jobs, <strong>failure handling</strong> (atomicity: a failure leaves no partial writes behind) and <strong>concurrency control</strong> (isolation: concurrent transactions don't see or disturb each other's partial work). The next two sections deal with the ACID labels and with atomicity in practice; everything after that is about isolation.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "IBM System R",
              year: "1970s",
              tag: "the template",
              html: `IBM's research relational database established the transaction model, including the idea of isolation levels, that MySQL, PostgreSQL, Oracle and SQL Server still follow in broad strokes. Today's SQL standard isolation levels descend from its definitions.`,
            },
            {
              org: "Google Bigtable and Percolator",
              year: "2006 / 2010",
              tag: "one row wasn't enough",
              html: `Bigtable offered transactions only within a single row. To update its web search index incrementally instead of rebuilding it in large batches, Google built Percolator (OSDI 2010), which layered multi-row, cross-table transactions with snapshot isolation on top of Bigtable.`,
            },
            {
              org: "Google Spanner",
              year: "2012",
              tag: "transactions by default",
              html: `Spanner's authors took a deliberate position: give programmers general-purpose transactions and let them fix performance hot spots when they show up, because coding around missing transactions in every application is the worse deal.`,
            },
            {
              org: "MongoDB",
              year: "2018",
              tag: "multi-document",
              html: `Version 4.0 added multi-document ACID transactions on replica sets, and 4.2 (2019) extended them to sharded clusters. They provide snapshot isolation, not serializability.`,
            },
            {
              org: "Amazon DynamoDB",
              year: "2018",
              tag: "multi-item",
              html: `<code>TransactWriteItems</code> and <code>TransactGetItems</code>, launched in November 2018, let one all-or-nothing request span several items, even in different tables, up to a fixed per-request item limit.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Transactions came back",
          html: `<p>The NoSQL retreat from transactions turned out to be temporary, and Spanner's bet (transactions first, tune the hot spots later) became the mainstream one. Distributed SQL databases in the same mold (CockroachDB, YugabyteDB, TiDB) have since made multi-row transactions across partitions their headline feature, and in 2018 both MongoDB and DynamoDB added multi-item transactions. The question today is less "transactions or not" than "which isolation level, at what price".</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"When would you not need a multi-object transaction?\"",
          html: `<p>A strong answer starts from the invariant, not the technology. If each user action changes exactly one object (a document holding a whole shopping cart, one row per sensor reading), single-object atomicity plus an atomic increment or compare-and-set is enough. If the second write is <em>derived</em> data that can be rebuilt (a search index, a cache, a count you can recompute), update it asynchronously from a change stream and accept brief staleness (Chapter 11). If data is append-only and every consumer is idempotent, a partially applied batch can simply be replayed. Then name the cost you are avoiding: in a partitioned store, a transaction that spans partitions needs coordination on every commit. A weak answer says "NoSQL doesn't need transactions" without naming which invariant could break.</p>`,
        },
        {
          type: "quiz",
          q: "An app inserts a new email row and then increments the unread counter as two separate auto-committed statements. No other client is running at all. Which problem can still occur?",
          options: [
            "The user sees the new email while the counter still says 0, because a reader ran between the two statements",
            "The process crashes after the insert, so the counter is permanently one lower than the number of unread emails",
            "A dirty write from another session overwrites the counter",
            "A phantom row appears in the inbox query",
          ],
          answer: 1,
          explain: `With no other clients, nothing can observe or interfere with the gap between the two statements, so the isolation problems (a reader catching the gap, a dirty write, a phantom) can't happen. What remains is failure: a crash after the insert leaves the counter permanently wrong. That is an atomicity problem, and wrapping both statements in one transaction fixes it. The "user sees the email with a counter of 0" answer is the tempting one, but it needs a concurrent reader, which makes it an isolation bug.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "acid-unpacked",
      title: "ACID, letter by letter: what the promise really covers",
      kicker: "Foundations",
      concepts: ["acid", "base", "atomicity", "consistency-acid", "isolation", "durability"],
      blocks: [
        {
          type: "problem",
          title: `"Fully ACID compliant", and still overdrawn`,
          html: `<p>A vendor page says "fully ACID compliant". A team puts "check the balance, then debit it" inside one transaction and concludes that two concurrent withdrawals can't overdraw an account. At the database's default isolation level they can: both transactions read the same balance, both pass the check, both debit. That is the Flexcoin bug from the opening, now sitting inside a transaction.</p>
<p>The same team believes that "consistency" means the database protects their business rules, that "durable" means a committed write can never be lost, and that "atomic" means safe under concurrency. Each letter promises something narrower than its name suggests. An engineer who can't say exactly which promise they are relying on will eventually ship a bug that no test catches.</p>`,
        },
        {
          type: "idea",
          html: `<p>Read each letter narrowly. <strong>A</strong> is abortability: all or nothing when something fails, with nothing to say about concurrency. <strong>C</strong> is your application's invariants, enforced by the database only where you declare constraints. <strong>I</strong> is a spectrum whose ideal is serializability but whose default is weaker. <strong>D</strong> is a matter of probability. "ACID" tells you little until you know the isolation level.</p>`,
        },
        {
          type: "text",
          html: `<p>The acronym was coined in 1983 by Theo Härder and Andreas Reuter, building on Jim Gray's earlier work, to give database fault tolerance a precise vocabulary. In practice implementations differ so much that "ACID compliant" now says little more than "this system has transactions of some kind". The isolation letter in particular hides enormous variation, as the rest of this chapter shows.</p>
<p>Systems that don't meet the ACID bar are sometimes described as <strong>BASE</strong>: Basically Available, Soft state, Eventual consistency. The term came out of late-1990s research on scalable network services and was popularized during the NoSQL wave. It is even vaguer than ACID; about the only thing it reliably means is "not ACID". Here is what each letter actually promises, next to the way it is commonly misread.</p>`,
        },
        {
          type: "compare",
          title: "What each letter promises, and the common misreading",
          items: [
            {
              title: "Atomicity",
              tone: "info",
              html: `<strong>Promises:</strong> if a fault occurs partway through, the transaction is aborted and all of its writes are discarded.<br><strong>Misread as:</strong> concurrent transactions can't interfere with each other. That is isolation's job.`,
            },
            {
              title: "Consistency",
              tone: "warn",
              html: `<strong>Promises:</strong> your invariants hold before and after each transaction, provided your transactions preserve them.<br><strong>Misread as:</strong> the database keeps the data correct by itself. It checks only the constraints you declare.`,
            },
            {
              title: "Isolation",
              tone: "warn",
              html: `<strong>Promises:</strong> concurrent transactions don't step on each other, to the degree the isolation level says.<br><strong>Misread as:</strong> ACID means serializable. Most databases default to read committed or a snapshot level.`,
            },
            {
              title: "Durability",
              tone: "info",
              html: `<strong>Promises:</strong> committed data survives crashes, via disk and a log, replication, or both.<br><strong>Misread as:</strong> committed data can never be lost. Correlated faults, fsync bugs and failover can still lose it.`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>A is for abortability</h3>
<p>In multithreaded programming, an atomic operation is one that no other thread can observe half-done. ACID's atomicity is a different idea, and it says nothing about concurrency. It describes what happens when a client makes several writes and a <strong>fault</strong> strikes after some of them have been applied: a process crash, a network interruption, a full disk, a violated constraint. The database aborts the transaction and discards or undoes every write it made, so the outcome is as if it had never run.</p>
<p>Without that guarantee, an error halfway through a series of writes leaves the application guessing which ones landed, and a retry might apply some of them twice. With it, an aborted transaction is known to have changed nothing, so the app can safely try again. That is why "abortability" would arguably have been a better name. The mechanism is the log from Chapter 3: a transaction whose commit record never reached the log is rolled back during recovery (by applying undo records in InnoDB, Oracle and SQL Server; in PostgreSQL its row versions simply stay invisible). The section on aborts and retries shows exactly when "try again" is safe and when it does damage.</p>
<h3>C is your job</h3>
<p>Consistency in the ACID sense means that certain statements about your data, its <strong>invariants</strong>, always hold. In an accounting system, credits and debits across all accounts must balance; in a booking system, no seat is sold twice. If a transaction starts from valid data and its writes preserve the invariants, the data is still valid when it ends.</p>
<p>Notice who does the work. The database can enforce some invariants (foreign keys, uniqueness constraints, CHECK constraints such as <code>balance &gt;= 0</code>), but only the ones you declare. If application code writes data that breaks a rule the database doesn't know about, the database will commit it without complaint. Atomicity, isolation and durability are properties of the database; consistency is a property of the application, which relies on the other three to achieve it. Arguably the C doesn't belong in the acronym at all.</p>
<p>The word is also badly overloaded. Four unrelated meanings appear in this book, and mixing them up is a classic source of confusion in design discussions:</p>`,
        },
        {
          type: "table",
          title: "Four meanings of \"consistency\"",
          headers: ["Term", "What it means", "Where it appears"],
          rows: [
            ["ACID consistency", "Application invariants hold before and after every transaction", "This chapter"],
            ["Eventual consistency", "Replicas converge to the same value once writes stop", "Chapter 5 (replication)"],
            ["Consistent hashing", "A way to assign keys to nodes so that few keys move when nodes join or leave", "Chapter 6 (partitioning)"],
            ["CAP consistency", "Linearizability: every read sees the latest write, as if there were one copy", "Chapter 9"],
          ],
        },
        {
          type: "text",
          html: `<h3>I is a spectrum</h3>
<p>Most databases serve many clients at once. When concurrent transactions touch the same records they can step on each other, and isolation is the promise that they don't. The textbook definition is <strong>serializability</strong>: each transaction can pretend it is the only one running, and the database guarantees that the final result is the same as if the transactions had run one after another, in some order.</p>
<p>In practice serializable isolation is rarely the default, because of its cost. PostgreSQL, Oracle and SQL Server default to read committed, and MySQL's InnoDB to its own repeatable read. Names don't settle meanings either: the level Oracle calls "serializable" actually implements snapshot isolation, which allows anomalies a truly serializable system never would. The rest of the chapter climbs this ladder one rung at a time: read committed (no dirty reads or writes), snapshot isolation (no read skew), the anomalies that survive it (lost updates, write skew, phantoms), and finally the three ways to get genuine serializability.</p>
<h3>D is a probability</h3>
<p>Durability promises that once a transaction has committed, its data won't be forgotten, even if the hardware fails or the database crashes. On a single node that means the data has reached non-volatile storage, usually through a <strong>write-ahead log</strong> that is flushed with <code>fsync</code> before the commit is acknowledged (Chapter 3). In a replicated database it can also mean the data has been copied to some number of nodes first (Chapter 5).</p>
<p>No system achieves perfect durability. If every replica shares the same bug or the same power feed, they fail together. Asynchronous replication can lose recently committed writes when the leader fails over. An <code>fsync</code> error can be mishandled by the operating system or the database; SSDs can corrupt data on sudden power loss and grow bad blocks over the years; an in-memory database with no log loses everything in a power cut. So durability in practice is layered: disks, replication and backups together, each covering failures the others miss.</p>
<p>That makes "committed" a matter of degree. Each rung of the ladder below survives a bigger failure and adds latency to every commit. Redis is a handy example of picking a rung: with its append-only file at the default <code>appendfsync everysec</code>, the log is fsynced about once a second, so a crash can lose roughly the last second of acknowledged writes.</p>`,
        },
        {
          type: "diagram",
          title: "The durability ladder",
          svg: `<style>.ch7a-n{display:none!important}@media (max-width:600px){.ch7a-w{display:none!important}.ch7a-n{display:block!important}}</style>
<svg class="ch7a-w" viewBox="0 0 640 200" role="img" aria-label="Four rising steps: in memory only, fsync to local disk, replicated to followers, replicated across regions. Each survives a bigger failure and costs more latency per commit.">
<defs><marker id="ch7a-dur-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="12" y="84" width="146" height="66" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="85" y="104" font-size="13" font-weight="700" text-anchor="middle">In memory only</text>
<text x="85" y="124" font-size="12" text-anchor="middle">survives nothing:</text>
<text x="85" y="140" font-size="12" text-anchor="middle">a crash loses it</text>
<rect x="170" y="64" width="146" height="86" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="243" y="84" font-size="13" font-weight="700" text-anchor="middle">fsync to local disk</text>
<text x="243" y="102" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">write-ahead log</text>
<text x="243" y="124" font-size="12" text-anchor="middle">survives a crash</text>
<text x="243" y="140" font-size="12" text-anchor="middle">and a power cut</text>
<rect x="328" y="44" width="146" height="106" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="401" y="64" font-size="13" font-weight="700" text-anchor="middle">Replicated to</text>
<text x="401" y="80" font-size="13" font-weight="700" text-anchor="middle">followers</text>
<text x="401" y="100" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sync or quorum ack</text>
<text x="401" y="124" font-size="12" text-anchor="middle">survives losing</text>
<text x="401" y="140" font-size="12" text-anchor="middle">one machine</text>
<rect x="486" y="24" width="146" height="126" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="559" y="44" font-size="13" font-weight="700" text-anchor="middle">Replicated across</text>
<text x="559" y="60" font-size="13" font-weight="700" text-anchor="middle">regions</text>
<text x="559" y="80" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">copies far apart</text>
<text x="559" y="124" font-size="12" text-anchor="middle">survives losing</text>
<text x="559" y="140" font-size="12" text-anchor="middle">a data center</text>
<line x1="12" y1="170" x2="628" y2="170" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#ch7a-dur-w)"/>
<text x="320" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">each rung: bigger failures survived, more latency on every commit</text>
</svg>
<svg class="ch7a-n" viewBox="0 0 360 296" role="img" aria-label="Four rungs, from in memory only to replicated across regions. Each survives a bigger failure and costs more latency per commit.">
<rect x="16" y="12" width="238" height="56" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="28" y="34" font-size="13" font-weight="700">In memory only</text>
<text x="28" y="54" font-size="12">survives nothing: a crash loses it</text>
<rect x="16" y="76" width="268" height="56" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="28" y="98" font-size="13" font-weight="700">fsync to local disk (WAL)</text>
<text x="28" y="118" font-size="12">survives a crash and a power cut</text>
<rect x="16" y="140" width="298" height="56" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="28" y="162" font-size="13" font-weight="700">Replicated to followers</text>
<text x="28" y="182" font-size="12">survives losing one machine</text>
<rect x="16" y="204" width="328" height="56" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="28" y="226" font-size="13" font-weight="700">Replicated across regions</text>
<text x="28" y="246" font-size="12">survives losing a data center</text>
<text x="16" y="284" font-size="12" style="fill: var(--viz-muted)">↓ each rung: more latency on every commit</text>
</svg>`,
          caption: `"Committed" means different things in different systems: ask which rung. The second rung also assumes the disk really persists data when fsync returns, an assumption the fsyncgate story below shows was shakier than anyone thought.`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Härder & Reuter",
              year: "1983",
              tag: "origin of ACID",
              html: `The acronym comes from their paper "Principles of Transaction-Oriented Database Recovery" (ACM Computing Surveys), which built on Jim Gray's 1981 paper "The Transaction Concept: Virtues and Limitations".`,
            },
            {
              org: "BASE",
              year: "1997 / 2008",
              tag: "the counter-slogan",
              html: `Coined in Fox, Gribble, Chawathe, Brewer and Gauthier's SOSP 1997 paper "Cluster-Based Scalable Network Services", and popularized by Dan Pritchett's 2008 ACM Queue article "BASE: An Acid Alternative".`,
            },
            {
              org: "PostgreSQL \"fsyncgate\"",
              year: "2018",
              tag: "durability bug",
              html: `PostgreSQL developers found that on Linux a failed <code>fsync</code> could clear the error and mark the unwritten pages clean, so retrying the fsync could report success after data had been lost. Minor releases in early 2019 changed PostgreSQL to PANIC and recover from its write-ahead log instead of retrying.`,
            },
            {
              org: "Google SSD field study",
              year: "2016",
              tag: "durability is probabilistic",
              html: `Schroeder, Lagisetty and Merchant (FAST 2016) analyzed years of Google production data and found that 30 to 80% of SSDs developed at least one bad block within their first four years in service.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Even \"fsynced to disk\" needed rethinking",
          html: `<p>For decades databases treated a successful <code>fsync</code> as the end of the durability story and a failed one as something to retry. The 2018 PostgreSQL discovery showed that on Linux a retry could succeed even though the data never reached the disk, because the kernel had already dropped the dirty pages. PostgreSQL's fix was to stop trusting retries: crash, and rebuild state from the write-ahead log. A 2020 USENIX ATC paper, "Can Applications Recover from fsync Failures?", found similar weaknesses in several other widely used storage systems. The lesson for durability claims: ask not only which rung, but how the system behaves when the rung itself reports an error.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Three different things called \"atomic\"",
          html: `<p>An <strong>atomic CPU instruction</strong>, or Java's <code>AtomicInteger</code>, means other threads can't see the operation half-done. An <strong>atomic register</strong> in distributed systems is another name for a linearizable one (Chapter 9): every read sees the latest write. ACID <strong>atomicity</strong> means a failed transaction's writes are undone. Only the last is what the A in ACID promises, and none of them stops two concurrent transactions from interleaving their reads and writes. That is the I.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Explain ACID\"",
          html: `<p>A strong answer goes letter by letter and corrects the folklore as it goes. <strong>Atomicity</strong>: all-or-nothing on failure, which is what makes retries safe; not about concurrency. <strong>Consistency</strong>: the application's invariants; the database only enforces declared constraints. <strong>Isolation</strong>: the letter that varies most; name your database's default (read committed in PostgreSQL, repeatable read in MySQL InnoDB) and one anomaly it allows. <strong>Durability</strong>: committed data survives crashes through the log, fsync and replication, with real failure modes such as losing writes on asynchronous failover. The usual follow-up is "So is your database serializable?" The answer that lands is "not by default, and here is a bug that permits".</p>`,
        },
        {
          type: "quiz",
          q: "A team says: \"Our database is ACID, so two concurrent withdrawals can't overdraw an account.\" Which letter would have to provide that guarantee, and does the ACID label promise it?",
          options: [
            "Atomicity: all-or-nothing writes make concurrent withdrawals safe",
            "Isolation, and only if the isolation level actually prevents the check-then-debit race; at the common default (read committed) both withdrawals can pass the check",
            "Durability: once the first withdrawal commits, the second is guaranteed to see it",
            "Consistency: every ACID database automatically enforces balance >= 0",
          ],
          answer: 1,
          explain: `Concurrency is isolation's job, and the level matters: read committed allows this race, while serializable isolation (or an atomic conditional UPDATE, a row lock, or a CHECK constraint the team declares) prevents it. Atomicity is the tempting answer, but it only guarantees that each withdrawal is all-or-nothing if it fails; two withdrawals that both succeed are both fully applied. Durability is about surviving crashes, and the database enforces only the invariants you declare.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "aborts-and-retries",
      title: "Aborts and retries: when \"try again\" is safe",
      kicker: "Foundations",
      concepts: ["safe-retries", "atomicity"],
      blocks: [
        {
          type: "problem",
          title: "A timeout that moves the money twice",
          html: `<p>Atomicity promises that an aborted transaction leaves no trace, so the natural error handler is "just try again". But a timeout doesn't tell you whether you aborted. Alice transfers $100 from savings to checking. The database writes the COMMIT record to disk, and then the reply is lost on the network. The app sees a timeout, retries, and $100 leaves savings a second time. Atomicity held on both attempts, since each was a complete, valid transaction; it simply has nothing to say about two transactions that carry the same intent.</p>
<p>Blind retries do other damage too. If the error came from overload, every client retrying at once makes the overload worse. A constraint violation fails identically on every attempt, so retrying it only burns capacity. And the confirmation email the transaction triggered goes out again on each try, because aborting a transaction doesn't un-send an email. "Retry on error" is safe only when you know what the earlier attempt left behind.</p>`,
        },
        {
          type: "idea",
          html: `<p>Retry only when the earlier attempt provably left no trace (atomicity covers faults <em>inside</em> the transaction). For the case where the outcome is unknown, make the operation <strong>idempotent</strong>: a client-generated key, written in the same transaction under a UNIQUE constraint, turns a duplicate attempt into a no-op. And back off, with jitter, so retries don't amplify overload.</p>`,
        },
        {
          type: "text",
          html: `<p>Datastores take two broad attitudes to errors. ACID databases follow "if I can't guarantee the whole thing, I'll abandon it": rather than leave a half-done state behind, they abort and roll back. Leaderless and best-effort stores (Chapter 5) take the opposite line, doing as much as they can and leaving it to the application to recover from whatever state results.</p>
<p>The ACID attitude hands the application a clean slate on abort. The log decides which transactions happened: one whose commit record reached the log is durable, and one without a commit record is rolled back during recovery, whether by applying undo records (InnoDB, Oracle, SQL Server) or by leaving its row versions permanently invisible (PostgreSQL). After an abort nothing the transaction wrote is visible, so running it again is safe, <em>provided</em> it really aborted.</p>
<p>Exploiting that takes code that many stacks don't write for you. Popular ORMs such as Rails's ActiveRecord and Django don't retry aborted transactions: the error bubbles up as an exception and usually reaches the user as a failed request. That throws away the main benefit of abortability. But writing a correct retry loop is harder than it looks, so try the cases below before reading the pitfalls. Alice moves $100 from Savings to Checking; you choose how the app talks to the database, where the crash happens, and what the app does about it.</p>`,
        },
        {
          type: "viz",
          id: "ch7/atomic-transfer",
          title: "All-or-nothing transfer",
          caption: `Try the default first: with no transaction, a crash after the debit makes $100 vanish. Then follow the Try next buttons. Transaction mode rolls the half-done transfer back, Retry completes it, a crash before the reply makes the retry move the money twice, and a transfer id turns that retry into a no-op. Notice the last stop: a transfer id without a transaction still leaves the accounts $100 short.`,
        },
        {
          type: "text",
          html: `<p>The guided path makes two points. First, atomicity and retries belong together. A crash inside a transaction leaves nothing behind, so retrying finishes the job; the same crash without a transaction leaves a half-applied transfer that no retry policy can repair. Second, atomicity can't help once the failure happens <em>after</em> commit. In the "before reply" cases both attempts were complete, valid transactions, and the invariant (Savings + Checking = $1,000) even held, yet Alice's single intent was applied twice. Only the transfer id made the second attempt harmless, and only because it was written atomically with the transfer itself.</p>`,
        },
        {
          type: "list",
          title: "Five ways a retry goes wrong",
          ordered: true,
          items: [
            `<strong>The commit succeeded, but the acknowledgement was lost.</strong> The client sees a timeout or a dropped connection, retries, and the transaction runs twice. Only application-level deduplication, such as an idempotency key, prevents this.`,
            `<strong>The error was caused by overload.</strong> Retrying immediately adds load exactly when the system has least to spare, and many clients retrying in lockstep can keep it down. Cap the number of retries and use exponential backoff with jitter.`,
            `<strong>The error is permanent.</strong> Deadlocks, serialization failures, lock timeouts, failovers and connection resets are transient and worth retrying. A constraint or CHECK violation, or bad input, will fail the same way every time.`,
            `<strong>The transaction has side effects outside the database.</strong> An email, a call to a payment API or a published message happens even if the transaction later aborts, and happens again on every retry. Do such work after commit, for example from an <a href="#/ch11/learn/change-data-capture">outbox table</a> that a separate process drains (Chapter 11), or make the external call idempotent too. Committing atomically across different systems needs <a href="#/ch9/learn/two-phase-commit">two-phase commit</a> (Chapter 9).`,
            `<strong>The client dies while retrying.</strong> Retry state usually lives in the client process's memory; if that process crashes, whatever it was trying to write is lost. Durable intent (a queued job, a stored request) survives a crash, and an in-memory retry loop doesn't.`,
          ],
        },
        {
          type: "text",
          html: `<h3>Idempotency keys: making "unknown" safe</h3>
<p>The fix for a lost acknowledgement is to make the operation <strong>idempotent</strong>, so that applying it twice has the same effect as applying it once. A transfer is not naturally idempotent ("move $100" twice moves $200), so you give each user intent an identity:</p>
<ol>
<li>The client generates a key <strong>once per intent</strong> (a UUID when Alice presses "Transfer"), not once per attempt, and sends the same key on every retry.</li>
<li>The server inserts the key into a table with a <strong>UNIQUE</strong> constraint, in the same transaction as the business writes, ideally along with the response it is about to return.</li>
<li>If that insert hits a duplicate key, the work is already done: return the saved result instead of doing it again. The same key arriving with a different payload is a client bug and should be rejected.</li>
<li>Keys are kept for a bounded window that covers any realistic retry. Stripe, for instance, may prune keys once they are at least 24 hours old.</li>
</ol>
<p>The key has to be written <em>inside</em> the transaction. Record it separately, before or after, and a crash between the two writes recreates the original problem: either the key exists without the transfer (the retry is wrongly skipped) or the transfer exists without the key (the retry runs it again). The viz's final case makes the same point from the other side: a key cannot repair an operation that was half-applied. You need atomicity and idempotency together. <a href="#/ch12/learn/end-to-end-argument">Chapter 12</a> generalizes this into end-to-end operation IDs that travel from the client through every system that touches the request.</p>
<h3>Retrying correctly in SQL</h3>
<p>Retry the <strong>whole transaction</strong>: start again from BEGIN, re-run its reads, and re-run the logic that decides what to write. Re-sending only the statement that failed is wrong, because the reads it depended on may be stale, which is often exactly why it failed.</p>
<p>Know what state an error leaves the session in. In PostgreSQL any error inside a transaction marks the whole transaction as aborted, and every later statement fails until you issue ROLLBACK. MySQL's InnoDB behaves differently: a lock wait timeout rolls back only the statement that timed out (unless <code>innodb_rollback_on_timeout</code> is enabled), leaving the rest of the transaction open, while a deadlock rolls back the entire transaction. Portable retry code therefore always does the same thing: ROLLBACK, then start over from BEGIN.</p>
<p>Finally, space the attempts out. Plain exponential backoff (wait 50 ms, then 100, then 200) keeps clients that failed together in lockstep, so they collide again on every retry. Adding <strong>jitter</strong>, a random delay up to the backoff limit, spreads them out. Cap both the delay and the number of attempts, and consider a per-client retry budget so that a widespread outage doesn't become a retry storm.</p>`,
        },
        {
          type: "code",
          lang: "python",
          title: "A retry wrapper with an idempotency key",
          code: `import random, time

RETRYABLE = {"40001", "40P01"}      # serialization_failure, deadlock_detected

def transfer(db, key, src, dst, amount):
    # key: generated ONCE per user intent (e.g. a UUID when Alice clicks), reused on every retry
    for attempt in range(6):
        try:
            with db.transaction():  # BEGIN ... COMMIT; ROLLBACK on any exception
                row = db.query_one(
                    """INSERT INTO transfers (id, src, dst, amount)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (id) DO NOTHING
                       RETURNING id""",
                    key, src, dst, amount)
                if row is None:     # an earlier attempt already committed this intent
                    return "already done"   # (real code also checks the payload matches)
                db.execute("UPDATE accounts SET balance = balance - %s WHERE id = %s", amount, src)
                db.execute("UPDATE accounts SET balance = balance + %s WHERE id = %s", amount, dst)
            return "done"
        except ConnectionLost:
            pass                    # outcome unknown: retrying with the same key is safe
        except DatabaseError as e:
            if e.sqlstate not in RETRYABLE:
                raise               # e.g. 23514 check_violation: it will never succeed
        # capped exponential backoff with "full jitter"
        time.sleep(random.uniform(0, min(2.0, 0.05 * 2 ** attempt)))
    raise RetriesExhausted(key)     # the caller may try again later, with the same key`,
          caption: `A PostgreSQL-flavored sketch. The key and the transfer commit or vanish together, so a retry after an unknown outcome either does the work or finds the key and stops. Every retry re-runs the whole transaction from BEGIN.`,
        },
        {
          type: "table",
          title: "Which errors to retry",
          headers: ["Error", "What it means", "What to do"],
          rows: [
            ["PostgreSQL <code>40001</code> serialization_failure", "Your transaction lost a conflict with a concurrent one", "ROLLBACK, back off, retry the whole transaction"],
            ["PostgreSQL <code>40P01</code> deadlock_detected, MySQL <code>1213</code> deadlock", "The database broke a deadlock by aborting your transaction", "ROLLBACK (MySQL has already rolled back), then retry"],
            ["MySQL <code>1205</code> lock wait timeout", "Waited too long for a row lock; by default only that statement was rolled back", "ROLLBACK the whole transaction, then retry"],
            ["<code>23505</code> unique_violation", "A uniqueness constraint rejected the write", "Permanent, unless it is your own idempotency key: then the work is already done"],
            ["<code>23514</code> check_violation", "A CHECK constraint (say, balance >= 0) rejected the write", "Permanent: report it, don't retry"],
            ["Connection reset or failover during COMMIT", "The commit may or may not have happened", "Outcome unknown: look up the idempotency key, or retry with the same key"],
          ],
          note: `The 23xxx codes are PostgreSQL's SQLSTATE values (class 23 is the SQL standard's integrity-constraint class); MySQL reports its own error numbers for the same conditions.`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "AWS Architecture Blog",
              year: "2015",
              tag: "backoff and jitter",
              html: `Marc Brooker's post "Exponential Backoff And Jitter" simulated clients contending for one resource. Plain exponential backoff still left retries arriving in clusters; adding randomness spread them out, and with 100 contending clients it cut the total number of calls by more than half.`,
            },
            {
              org: "PostgreSQL",
              tag: "official guidance",
              html: `The documentation's advice on serialization failures is to retry the complete transaction, including the logic that decides what to write, when SQLSTATE 40001 is reported, and it notes that deadlock failures (40P01) are worth retrying the same way.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "A timeout is not a failure",
          html: `<p>A timeout means "I don't know". The request may never have arrived, may have been processed with the reply lost on the way back, or may still be running. Treat a timeout as a failure and retry, and you double payments; treat it as a success, and you drop them. Design for the third state: make the operation idempotent so a retry is always safe, or look up what actually happened (by idempotency key) before deciding what to do.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"The commit timed out. Did it happen?\"",
          html: `<p>A favorite question, because it tests whether you know where atomicity ends. A strong answer: "The client can't know. The transaction is atomic, so it either fully committed or fully rolled back, but the acknowledgement may have been lost. So I make the write idempotent: the client generates a key per user intent, the server inserts it under a UNIQUE constraint in the same transaction as the business writes, and a retry with the same key returns the stored result. I retry only transient errors (serialization failures, deadlocks, connection loss), always the whole transaction from BEGIN, with capped exponential backoff and jitter, and I move side effects such as emails to an outbox that is processed after commit." Expect follow-ups on why the key must be in the same transaction, how long to keep keys, and what changes when two services are involved (two-phase commit in Chapter 9, end-to-end operation IDs in Chapter 12).</p>`,
        },
        {
          type: "quiz",
          q: "A transfer transaction commits, but the network drops before the app receives OK. The app retries the entire transaction. What does atomicity guarantee here?",
          options: [
            "The database recognizes the retry as a duplicate and rejects it",
            "Nothing that helps: both attempts are complete, valid transactions, so the transfer happens twice unless the app adds its own deduplication, such as an idempotency key",
            "The database rolls back the first attempt because the client never acknowledged it",
            "Durability makes the second attempt a no-op",
          ],
          answer: 1,
          explain: `Atomicity makes a single transaction all-or-nothing; it says nothing about two separate transactions with the same intent. The first commit is durable whether or not the client heard about it, so nothing rolls it back: databases don't wait for a client acknowledgement. "The database recognizes the duplicate" is tempting, but the database has no way to know two transactions represent one intent unless you tell it, for example with a UNIQUE transfer id written in the same transaction.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "read-committed",
      title: "Read committed: never see or overwrite uncommitted data",
      kicker: "Weak isolation, level 1",
      concepts: ["weak-isolation", "read-committed", "dirty-read", "dirty-write"],
      blocks: [
        {
          type: "problem",
          title: "Half-finished work, seen and overwritten",
          html: `<p>An inbox transaction inserts a new message and then bumps the unread counter. If another session can read uncommitted data, the user sees the message next to "unread: 0". Worse, if the writer then aborts, the reader has displayed, or acted on, data that never existed.</p>
<p>Writers have the same problem with each other. Alice and Bob try to buy the same used car at the same moment. A purchase updates two rows: the listing (who bought the car) and the invoice (who gets billed). If one transaction can overwrite the other's uncommitted writes, the steps interleave, and the listing ends up with Bob while the invoice goes to Alice. The two naive positions are no isolation at all (fast, broken) and full serializability (correct, historically slow). Databases settled on a cheap middle level, and it is what most applications run on, usually without anyone having chosen it.</p>`,
        },
        {
          type: "idea",
          html: `<p><strong>Read committed</strong> makes two promises: <strong>no dirty reads</strong> (you only see data that has been committed) and <strong>no dirty writes</strong> (you only overwrite data that has been committed). Databases implement it with row-level write locks, plus keeping each row's last committed value around for readers.</p>`,
        },
        {
          type: "text",
          html: `<p>Two transactions that touch different data can safely run in parallel. Concurrency bugs appear only when one transaction reads data that another is modifying, or two modify the same data at once. Such bugs are hard to find by testing, because they need unlucky timing, and hard to reason about in a large application where you don't know what else is touching the database.</p>
<p>Serializable isolation would hide all of this, but it has a cost, and for decades most databases chose not to pay it by default. Instead they offer <strong>weak isolation levels</strong> that block some anomalies and permit others. The consequences are not academic: weak isolation has led to stolen money (the Flexcoin and Poloniex races from the opening), drawn the attention of financial auditors, and corrupted customer data. "We use an ACID database" is not enough; you need to know which anomalies your level lets through.</p>
<p>That is also the best way to learn the levels: by the anomalies each one allows, not by their names, which vary from database to database. The table is the map this chapter fills in, one column per section.</p>`,
        },
        {
          type: "table",
          title: "Isolation levels by the anomalies they allow",
          headers: ["Level", "Dirty write", "Dirty read", "Read skew", "Lost update", "Write skew", "Phantom"],
          rows: [
            ["Read uncommitted", "Prevented", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>"],
            ["Read committed", "Prevented", "Prevented", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-bad\">Possible</span>"],
            ["Snapshot isolation", "Prevented", "Prevented", "Prevented", "<span class=\"hl-warn\">Depends on DB*</span>", "<span class=\"hl-bad\">Possible</span>", "<span class=\"hl-warn\">Partly*</span>"],
            ["Serializable", "Prevented", "Prevented", "Prevented", "Prevented", "Prevented", "Prevented"],
          ],
          note: `* Under snapshot isolation, lost updates are caught automatically in some databases (PostgreSQL) but not others (MySQL InnoDB), and phantoms are hidden from read-only queries but still cause write skew when a read decides a write. Dirty reads and writes are this section; read skew is the next; lost updates, write skew and phantoms follow. "Repeatable read" is missing on purpose: it means snapshot isolation in PostgreSQL, something subtly different in MySQL, and serializability in DB2, as the snapshot isolation section shows.`,
        },
        {
          type: "text",
          html: `<h3>No dirty reads</h3>
<p>Read committed is the most basic level that real applications rely on, and the default in PostgreSQL, Oracle and SQL Server (MySQL's InnoDB defaults to repeatable read instead). Below it sits <strong>read uncommitted</strong>, which prevents dirty writes but allows dirty reads; few teams choose it deliberately, and PostgreSQL quietly runs it as read committed.</p>
<p>A <strong>dirty read</strong> is seeing another transaction's writes before it has committed. Preventing them matters for two reasons. First, a transaction that updates several objects should become visible all at once. If another transaction can see some of its writes but not the rest, it sees the new email with the old counter, a state that never existed as a whole and that can produce confusing screens or wrong decisions. Second, transactions abort. A dirty reader may see a value that is later rolled back, which means it saw data that was never committed, and it may already have shown that data to a user or written something based on it.</p>
<p>The timeline puts the two levels side by side. User 1 sets x from 2 to 3 and later commits; User 2 reads x twice, once before that commit and once after, first at read uncommitted and then at read committed.</p>`,
        },
        {
          type: "diagram",
          title: "A dirty read, and what read committed returns instead",
          svg: `<style>.ch7a-n{display:none!important}@media (max-width:600px){.ch7a-w{display:none!important}.ch7a-n{display:block!important}}</style>
<svg class="ch7a-w" viewBox="0 0 640 240" role="img" aria-label="User 1 sets x to 3 and later commits. A reader at read uncommitted sees 3 before the commit, a dirty read. A reader at read committed sees the old value 2 until the commit, then 3.">
<text x="624" y="18" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time →</text>
<line x1="170" y1="50" x2="624" y2="50" style="stroke: var(--viz-grid)"/>
<line x1="170" y1="158" x2="624" y2="158" style="stroke: var(--viz-grid)"/>
<line x1="170" y1="212" x2="624" y2="212" style="stroke: var(--viz-grid)"/>
<text x="16" y="46" font-size="13" font-weight="700" style="fill: var(--viz-c6)">User 1</text>
<text x="16" y="62" font-size="12" style="fill: var(--viz-muted)">writer</text>
<text x="16" y="100" font-size="13" font-weight="700">Database</text>
<text x="16" y="116" font-size="12" style="fill: var(--viz-muted)">value of x</text>
<text x="16" y="154" font-size="13" font-weight="700" style="fill: var(--viz-c5)">User 2</text>
<text x="16" y="170" font-size="12" style="fill: var(--viz-muted)">read uncommitted</text>
<text x="16" y="208" font-size="13" font-weight="700" style="fill: var(--viz-c5)">User 2</text>
<text x="16" y="224" font-size="12" style="fill: var(--viz-muted)">read committed</text>
<rect x="196" y="36" width="120" height="28" rx="6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="256" y="55" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set x = 3</text>
<rect x="414" y="36" width="72" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="450" y="55" font-size="12" text-anchor="middle">commit</text>
<line x1="450" y1="66" x2="450" y2="232" stroke-dasharray="4 4" style="stroke: var(--viz-ok)"/>
<rect x="170" y="90" width="146" height="28" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="243" y="109" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">x = 2</text>
<rect x="316" y="90" width="134" height="28" stroke-dasharray="4 3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="383" y="109" font-size="12" text-anchor="middle">2, with 3 pending</text>
<rect x="450" y="90" width="174" height="28" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="537" y="109" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">x = 3</text>
<text x="380" y="138" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">dirty read</text>
<rect x="330" y="144" width="100" height="28" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="380" y="163" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 3</text>
<rect x="500" y="144" width="100" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="550" y="163" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 3</text>
<text x="380" y="192" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-ok)">old committed value</text>
<rect x="330" y="198" width="100" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="380" y="217" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 2</text>
<rect x="500" y="198" width="100" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="550" y="217" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 3</text>
</svg>
<svg class="ch7a-n" viewBox="0 0 360 246" role="img" aria-label="User 1 sets x to 3 and later commits. A reader at read uncommitted sees 3 before the commit, a dirty read. A reader at read committed sees the old value 2 until the commit, then 3.">
<text x="344" y="14" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time →</text>
<line x1="223" y1="68" x2="223" y2="238" stroke-dasharray="4 4" style="stroke: var(--viz-ok)"/>
<text x="16" y="30" font-size="12" font-weight="700" style="fill: var(--viz-c6)">User 1 · writer</text>
<rect x="20" y="38" width="90" height="28" rx="6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="65" y="57" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set x = 3</text>
<rect x="196" y="38" width="54" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="223" y="57" font-size="12" text-anchor="middle">commit</text>
<text x="16" y="86" font-size="12" font-weight="700">Database · value of x</text>
<rect x="16" y="94" width="94" height="28" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="63" y="113" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">x = 2</text>
<rect x="110" y="94" width="113" height="28" stroke-dasharray="4 3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="166" y="113" font-size="12" text-anchor="middle">2 (3 pending)</text>
<rect x="223" y="94" width="121" height="28" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="283" y="113" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">x = 3</text>
<text x="16" y="142" font-size="12" font-weight="700" style="fill: var(--viz-c5)">User 2 · read uncommitted</text>
<rect x="116" y="150" width="100" height="28" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="166" y="169" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 3</text>
<rect x="240" y="150" width="100" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="290" y="169" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 3</text>
<text x="16" y="198" font-size="12" font-weight="700" style="fill: var(--viz-c5)">User 2 · read committed</text>
<rect x="116" y="206" width="100" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="166" y="225" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 2</text>
<rect x="240" y="206" width="100" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="290" y="225" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">get x → 3</text>
</svg>`,
          caption: `Under read committed a writer's changes become visible all at once, at commit (the dashed green line). Under read uncommitted the first read already returns 3, and had User 1 aborted instead of committing, User 2 would have seen a value that never existed.`,
        },
        {
          type: "text",
          html: `<h3>No dirty writes</h3>
<p>What if two transactions update the same row at the same time? Normally the later write overwrites the earlier one. It is a <strong>dirty write</strong> when the earlier write is still uncommitted, so the later transaction overwrites a value that may yet be rolled back, or that belongs to someone else's unfinished multi-row change. Read committed forbids it, typically by making the second writer wait until the first transaction has committed or aborted.</p>
<p>The car sale shows why it matters. Each purchase sets <code>listings.buyer</code> and then <code>invoices.recipient</code>. If Alice's and Bob's purchases can overwrite each other's uncommitted rows, the interleaving below leaves the car sold to Bob and the invoice addressed to Alice. Each transaction did the right thing; their writes simply got mixed. Dirty writes also make rollback ill-defined: if Alice's transaction aborted after Bob had overwritten her row, there would be no sensible value to restore.</p>`,
        },
        {
          type: "diagram",
          title: "A dirty write: the car sale",
          svg: `<style>.ch7a-n{display:none!important}@media (max-width:600px){.ch7a-w{display:none!important}.ch7a-n{display:block!important}}</style>
<svg class="ch7a-w" viewBox="0 0 640 244" role="img" aria-label="Alice writes the listing, Bob overwrites it while Alice's write is uncommitted, Bob writes the invoice, Alice overwrites it. Both commit, leaving the listing with Bob and the invoice with Alice.">
<text x="16" y="70" font-size="13" font-weight="700">listings</text>
<text x="16" y="86" font-size="12" style="fill: var(--viz-muted)">buyer</text>
<text x="16" y="140" font-size="13" font-weight="700">invoices</text>
<text x="16" y="156" font-size="12" style="fill: var(--viz-muted)">recipient</text>
<rect x="108" y="54" width="378" height="38" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<rect x="108" y="124" width="378" height="38" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<rect x="116" y="58" width="86" height="30" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="159" y="78" font-size="13" text-anchor="middle">1 · Alice</text>
<rect x="208" y="58" width="86" height="30" rx="6" stroke-width="2" style="fill: var(--viz-c5-soft); stroke: var(--viz-bad)"/>
<text x="251" y="78" font-size="13" text-anchor="middle">2 · Bob</text>
<text x="251" y="110" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-bad)">overwrites uncommitted write</text>
<rect x="300" y="128" width="86" height="30" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="343" y="148" font-size="13" text-anchor="middle">3 · Bob</text>
<rect x="392" y="128" width="86" height="30" rx="6" stroke-width="2" style="fill: var(--viz-c6-soft); stroke: var(--viz-bad)"/>
<text x="435" y="148" font-size="13" text-anchor="middle">4 · Alice</text>
<text x="435" y="180" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-bad)">overwrites uncommitted write</text>
<line x1="494" y1="44" x2="494" y2="166" stroke-width="1.5" stroke-dasharray="4 4" style="stroke: var(--viz-ok)"/>
<text x="494" y="36" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-ok)">both commit</text>
<rect x="510" y="54" width="120" height="108" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="570" y="80" font-size="13" font-weight="700" text-anchor="middle">Final state</text>
<text x="570" y="104" font-size="12" text-anchor="middle">listing: Bob</text>
<text x="570" y="124" font-size="12" text-anchor="middle">invoice: Alice</text>
<text x="570" y="148" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">✗ mismatch</text>
<rect x="108" y="194" width="14" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="128" y="205" font-size="12">Alice's write</text>
<rect x="222" y="194" width="14" height="14" rx="3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="242" y="205" font-size="12">Bob's write</text>
<rect x="330" y="194" width="14" height="14" rx="3" stroke-dasharray="3 2" style="fill: none; stroke: var(--viz-muted)"/>
<text x="350" y="205" font-size="12">uncommitted</text>
<rect x="440" y="194" width="14" height="14" rx="3" stroke-width="2" style="fill: none; stroke: var(--viz-bad)"/>
<text x="460" y="205" font-size="12">dirty write</text>
<text x="16" y="234" font-size="12">With row-level write locks, Bob would wait at step 2 until Alice committed or aborted.</text>
</svg>
<svg class="ch7a-n" viewBox="0 0 360 306" role="img" aria-label="Alice writes the listing, Bob overwrites it while Alice's write is uncommitted, Bob writes the invoice, Alice overwrites it. Both commit, leaving the listing with Bob and the invoice with Alice.">
<text x="16" y="24" font-size="12" font-weight="700" style="font-family: var(--font-mono)">listings.buyer</text>
<text x="332" y="20" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-ok)">commit</text>
<line x1="332" y1="28" x2="332" y2="158" stroke-width="1.5" stroke-dasharray="4 4" style="stroke: var(--viz-ok)"/>
<rect x="16" y="32" width="304" height="36" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<rect x="20" y="36" width="70" height="28" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="55" y="55" font-size="12" text-anchor="middle">1 · Alice</text>
<rect x="96" y="36" width="70" height="28" rx="6" stroke-width="2" style="fill: var(--viz-c5-soft); stroke: var(--viz-bad)"/>
<text x="131" y="55" font-size="12" text-anchor="middle">2 · Bob</text>
<text x="131" y="84" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-bad)">overwrites uncommitted write</text>
<text x="16" y="110" font-size="12" font-weight="700" style="font-family: var(--font-mono)">invoices.recipient</text>
<rect x="16" y="118" width="304" height="36" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<rect x="172" y="122" width="70" height="28" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="207" y="141" font-size="12" text-anchor="middle">3 · Bob</text>
<rect x="248" y="122" width="70" height="28" rx="6" stroke-width="2" style="fill: var(--viz-c6-soft); stroke: var(--viz-bad)"/>
<text x="283" y="141" font-size="12" text-anchor="middle">4 · Alice</text>
<text x="344" y="172" font-size="12" font-weight="600" text-anchor="end" style="fill: var(--viz-bad)">overwrites uncommitted write</text>
<rect x="16" y="184" width="328" height="50" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="180" y="206" font-size="13" font-weight="700" text-anchor="middle">Final: listing → Bob, invoice → Alice</text>
<text x="180" y="225" font-size="12" text-anchor="middle">the buyer and the invoice disagree</text>
<rect x="16" y="244" width="12" height="12" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="34" y="255" font-size="12">Alice</text>
<rect x="82" y="244" width="12" height="12" rx="3" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="100" y="255" font-size="12">Bob</text>
<rect x="140" y="244" width="12" height="12" rx="3" stroke-dasharray="3 2" style="fill: none; stroke: var(--viz-muted)"/>
<text x="158" y="255" font-size="12">uncommitted</text>
<rect x="246" y="244" width="12" height="12" rx="3" stroke-width="2" style="fill: none; stroke: var(--viz-bad)"/>
<text x="264" y="255" font-size="12">dirty write</text>
<text x="16" y="280" font-size="12">With row write locks, Bob waits at step 2</text>
<text x="16" y="296" font-size="12">until Alice commits or aborts.</text>
</svg>`,
          caption: `Both transactions commit, yet the final state matches neither purchase. Steps are numbered in time order. With the locks, the two purchases would take effect one after the other, and whoever bought second would get both the car and the invoice.`,
        },
        {
          type: "text",
          html: `<h3>How databases implement it</h3>
<p><strong>No dirty writes</strong> is done with row-level locks. A transaction that wants to modify a row (or document) must first acquire an exclusive lock on it and hold that lock until it commits or aborts. Only one transaction can hold a given row's lock; a second writer waits its turn. Almost every database does this at read committed and above.</p>
<p><strong>No dirty reads</strong> could use locks too: make every reader briefly take the same lock, so it can't read a row while an uncommitted write holds it. That works, and IBM DB2 and SQL Server (unless <code>READ_COMMITTED_SNAPSHOT</code> is on) do essentially this. The price is that one long-running write transaction makes every reader of the rows it touched wait, and slow readers hold up writers in turn. A single slow batch job can stall the read-only parts of an application, which is bad for response times and worse for operability, since one misbehaving job degrades everything.</p>
<p>So most databases take a different route. For every row being written, the database remembers both the old committed value and the new value set by the transaction that holds the write lock. Other transactions that read the row get the old value until the writer commits, then switch to the new one. Readers never wait for writers. PostgreSQL implements this with multi-version concurrency control, taking a fresh snapshot of committed data at the start of each <em>statement</em>. The next section stretches that per-statement snapshot over a whole transaction, and its MVCC viz lets you replay both a dirty read (Read uncommitted, with T13 ending in Abort) and the read skew that read committed still allows.</p>`,
        },
        {
          type: "callout",
          tone: "warning",
          title: "What read committed does not prevent",
          html: `<p>Read committed blocks dirty reads and dirty writes and nothing else. Two classic bugs pass straight through. The <strong>counter race</strong>: two transactions each read a counter as 42 and write back 43. Neither write is dirty, because the second write lands only after the first transaction has committed (waiting for its row lock if necessary), so read committed allows it and one increment vanishes (the lost update of the section on lost updates). And <strong>read skew</strong>: a transaction reading several rows can see some of them before another transaction's commit and some after it (the next section). Flexcoin-style check-then-act races survive read committed too.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "PostgreSQL, Oracle, SQL Server, MySQL",
              tag: "default levels",
              html: `PostgreSQL, Oracle and SQL Server default to READ COMMITTED; MySQL's InnoDB defaults to REPEATABLE READ. Most applications therefore run at a weak isolation level that nobody explicitly chose.`,
            },
            {
              org: "Microsoft SQL Server",
              tag: "locks or versions",
              html: `On-premises SQL Server implements READ COMMITTED with shared read locks unless the <code>READ_COMMITTED_SNAPSHOT</code> database option is on, which switches it to row versioning so that readers don't block writers. Azure SQL Database turns that option on by default.`,
            },
            {
              org: "SQL Server NOLOCK",
              tag: "read uncommitted in practice",
              html: `The widely used <code>WITH (NOLOCK)</code> table hint is equivalent to READ UNCOMMITTED for that table. Besides returning data that may later be rolled back, Microsoft's documentation warns that such scans can miss rows when another transaction splits a page, or see a row twice when a concurrent update moves it ahead of the scan.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What read committed gives you",
          consLabel: "What it still lets through",
          pros: [
            "No dirty reads: a transaction's writes become visible all at once, at commit",
            "No dirty writes: multi-row updates from different transactions can't interleave",
            "Cheap: with versioned reads, readers never wait for writers and writers never wait for readers",
            "The default in PostgreSQL, Oracle and SQL Server, so tools, ORMs and DBAs expect it",
          ],
          cons: [
            "Read skew: a multi-row read can mix states from before and after another commit",
            "Lost updates from concurrent read-modify-write cycles",
            "Write skew and phantoms: check-then-act races like Flexcoin's",
            "Long reads (backups, reports) see the database changing underneath them",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"What is your database's default isolation level, and what does it permit?\"",
          html: `<p>Many candidates can define a dirty read; fewer can say what their own production database runs at. A strong answer names the level (PostgreSQL, Oracle, SQL Server: read committed; MySQL InnoDB: repeatable read; CockroachDB: serializable), lists what it still allows (at read committed: read skew, lost updates, write skew), and shows where that matters in their system: "our stock decrement is a single atomic UPDATE with a WHERE stock &gt; 0 guard, not a read followed by a write." Extra credit for knowing that on-premises SQL Server implements read committed with read locks unless <code>READ_COMMITTED_SNAPSHOT</code> is enabled, which decides whether readers block writers.</p>`,
        },
        {
          type: "quiz",
          q: "Why do most databases prevent dirty reads by keeping the old committed value, rather than by making readers take read locks?",
          options: [
            "Read locks cannot prevent dirty reads",
            "With read locks, one long-running write transaction would block every reader of the rows it touched, so response times would suffer badly",
            "The SQL standard forbids read locks at read committed",
            "Read locks would cause dirty writes",
          ],
          answer: 1,
          explain: `Read locks do work: they are how DB2 and lock-based SQL Server implement read committed. The cost is that readers and writers wait for each other, and one slow writer can stall every reader of its rows. Keeping the last committed value lets readers proceed without waiting, which is why it is the common choice. The standard defines levels by the anomalies they forbid and doesn't prescribe locks or versions.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "snapshot-isolation",
      title: "Snapshot isolation: a frozen view built from row versions",
      kicker: "Weak isolation, level 2",
      concepts: ["non-repeatable-read-read-skew", "snapshot-isolation", "mvcc"],
      blocks: [
        {
          type: "problem",
          title: "Two reads from two different moments",
          html: `<p>Read committed still lets one transaction see the database at different points in time. Alice has $500 in each of two accounts, $1,000 in total. While she looks at her balances, a transfer moves $100 from account 2 to account 1. Her app reads account 1 before the transfer commits ($500) and account 2 after it ($400). For a moment, $100 has vanished.</p>
<p>For Alice, a refresh fixes it. Some jobs can't refresh their way out. A backup that copies a busy database for hours would capture some tables before a change and others after it, and restoring it would make that mix permanent. Analytic queries and integrity checks would return nonsense or raise false alarms. The obvious fix, read locks on everything a transaction reads, would let a long backup block every writer for hours, which is exactly what read committed's design was built to avoid.</p>`,
        },
        {
          type: "diagram",
          title: "Read skew: Alice's missing $100",
          svg: `<style>.ch7a-n{display:none!important}@media (max-width:600px){.ch7a-w{display:none!important}.ch7a-n{display:block!important}}</style>
<svg class="ch7a-w" viewBox="0 0 640 216" role="img" aria-label="Alice reads account 1 as 500 before a transfer commits and account 2 as 400 after it commits, so her view adds up to 900 instead of 1000.">
<text x="624" y="20" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time →</text>
<line x1="140" y1="56" x2="630" y2="56" style="stroke: var(--viz-grid)"/>
<line x1="140" y1="120" x2="630" y2="120" style="stroke: var(--viz-grid)"/>
<text x="16" y="52" font-size="13" font-weight="700" style="fill: var(--viz-c6)">Alice</text>
<text x="16" y="68" font-size="12" style="fill: var(--viz-muted)">reads balances</text>
<text x="16" y="116" font-size="13" font-weight="700" style="fill: var(--viz-c5)">Transfer</text>
<text x="16" y="132" font-size="12" style="fill: var(--viz-muted)">moves $100</text>
<line x1="508" y1="36" x2="508" y2="146" stroke-width="1.5" stroke-dasharray="4 4" style="stroke: var(--viz-ok)"/>
<rect x="150" y="42" width="120" height="28" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="210" y="61" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">acct 1 = $500</text>
<rect x="232" y="106" width="100" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="282" y="125" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">acct 1 +100</text>
<rect x="340" y="106" width="100" height="28" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="390" y="125" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">acct 2 −100</text>
<rect x="448" y="106" width="60" height="28" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="478" y="125" font-size="12" text-anchor="middle">commit</text>
<rect x="516" y="42" width="114" height="28" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="573" y="61" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">acct 2 = $400</text>
<text x="16" y="180" font-size="12" style="fill: var(--viz-muted)">every committed state:</text>
<text x="16" y="198" font-size="12" style="fill: var(--viz-muted)">$500 + $500 or $600 + $400 = $1,000</text>
<rect x="330" y="162" width="300" height="44" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="480" y="189" font-size="13" font-weight="700" text-anchor="middle">Alice's view: $500 + $400 = $900</text>
</svg>
<svg class="ch7a-n" viewBox="0 0 360 234" role="img" aria-label="Alice reads account 1 as 500 before a transfer commits and account 2 as 400 after it commits, so her view adds up to 900 instead of 1000.">
<line x1="284" y1="26" x2="284" y2="148" stroke-width="1.5" stroke-dasharray="4 4" style="stroke: var(--viz-ok)"/>
<text x="16" y="22" font-size="12" font-weight="700" style="fill: var(--viz-c6)">Alice · reads balances</text>
<rect x="16" y="30" width="70" height="40" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="51" y="46" font-size="12" text-anchor="middle">acct 1</text>
<text x="51" y="62" font-size="12" font-weight="700" text-anchor="middle">$500</text>
<rect x="288" y="30" width="56" height="40" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="316" y="46" font-size="12" text-anchor="middle">acct 2</text>
<text x="316" y="62" font-size="12" font-weight="700" text-anchor="middle">$400</text>
<text x="16" y="96" font-size="12" font-weight="700" style="fill: var(--viz-c5)">Transfer · moves $100</text>
<rect x="74" y="104" width="70" height="40" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="109" y="120" font-size="12" text-anchor="middle">acct 1</text>
<text x="109" y="136" font-size="12" text-anchor="middle">+$100</text>
<rect x="150" y="104" width="70" height="40" rx="6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="185" y="120" font-size="12" text-anchor="middle">acct 2</text>
<text x="185" y="136" font-size="12" text-anchor="middle">−$100</text>
<rect x="226" y="104" width="54" height="40" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="253" y="129" font-size="12" text-anchor="middle">commit</text>
<rect x="16" y="160" width="328" height="40" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="180" y="185" font-size="13" font-weight="700" text-anchor="middle">Alice's view: $500 + $400 = $900</text>
<text x="180" y="222" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">every committed state sums to $1,000</text>
</svg>`,
          caption: `Each read returned committed data, yet together they describe a state that never existed at any single moment. The dashed green line is the transfer's commit: Alice's first read falls before it and her second after it.`,
        },
        {
          type: "idea",
          html: `<p>Give each transaction a <strong>consistent snapshot</strong>: it sees the database exactly as it was when it started, no matter what commits afterwards. Build that snapshot by keeping several committed versions of each row (<strong>MVCC</strong>), so readers never block writers and writers never block readers.</p>`,
        },
        {
          type: "text",
          html: `<p>Alice's anomaly is called <strong>read skew</strong>, or a <strong>non-repeatable read</strong>: within one transaction, different reads observe the database at different points in time. Had she re-read account 1 at the end, she would have got $600, a different answer to the same question inside the same transaction. Read committed allows it, because each individual read did return committed data.</p>
<p>Read skew is tolerable when a person can simply reload the page. It is not tolerable for:</p>
<ul>
<li><strong>Backups.</strong> Copying a large database takes hours, and writes keep arriving. Without a consistent view, the backup holds old versions of some data and new versions of the rest, and restoring it makes that inconsistency permanent.</li>
<li><strong>Analytic queries.</strong> A query that scans much of the database to compute a total produces an answer that corresponds to no moment in time.</li>
<li><strong>Integrity checks.</strong> A periodic job that verifies "debits equal credits" raises false alarms whenever it straddles a commit.</li>
</ul>
<h3>Snapshot isolation</h3>
<p><strong>Snapshot isolation</strong> (SI) is the standard answer. Each transaction reads from a consistent snapshot: it sees everything that had committed when it started, and nothing committed afterwards, even if it runs for hours. Every read in Alice's transaction would show the pre-transfer state, $500 + $500. PostgreSQL, Oracle, SQL Server (its SNAPSHOT level), MySQL's InnoDB (loosely, as shown below) and many other databases support it, under a confusing variety of names.</p>
<p>The implementation principle explains its popularity: <strong>readers never block writers, and writers never block readers</strong>. Writes still take row-level write locks, so two writers to the same row still queue up and dirty writes remain impossible. Reads take no locks at all. A three-hour backup can run alongside normal traffic, and no writer ever waits for it.</p>
<h3>MVCC: keep the old versions around</h3>
<p>To give different in-progress transactions views from different points in time, the database must keep several committed versions of a row side by side. That is <strong>multi-version concurrency control</strong> (MVCC). Read committed can use the same machinery with a fresh snapshot per statement; snapshot isolation simply uses one snapshot for the whole transaction. In the PostgreSQL-style design:</p>
<ul>
<li>Every transaction gets a unique, always-increasing <strong>transaction id</strong> (txid).</li>
<li>Every row version carries <code>created_by</code>, the txid that inserted it (PostgreSQL's <code>xmin</code>), and <code>deleted_by</code>, initially empty (<code>xmax</code>).</li>
<li>A DELETE removes nothing; it sets <code>deleted_by</code> on the current version.</li>
<li>An UPDATE is a delete plus an insert: the old version gets <code>deleted_by</code>, and a new version appears with <code>created_by</code> set to the updating transaction.</li>
<li>Once no transaction can possibly still see a deleted version, <strong>garbage collection</strong> (VACUUM, in PostgreSQL) removes it for good.</li>
</ul>
<p>One simplification to flag: this model, like the book's, hands out the txid at BEGIN and takes the snapshot then. PostgreSQL actually assigns a permanent txid only at a transaction's first write (read-only transactions get lightweight virtual ids) and takes a REPEATABLE READ snapshot at the transaction's first statement rather than at BEGIN. The visibility logic is the same.</p>
<p>The viz replays Alice's case with the book's txids, T12 for her long-running audit and T13 for the transfer, plus T14, a one-statement read from her phone app. The table lists every row version with its <code>created_by</code> and <code>deleted_by</code>, and the log explains each visibility decision.</p>`,
        },
        {
          type: "viz",
          id: "ch7/mvcc-snapshots",
          title: "MVCC snapshots",
          caption: `Try Play under Read committed first: T12's total comes out at $900. Switch to Snapshot isolation and replay: $1,000, because T13's versions are newer than T12's snapshot. Then pick Read uncommitted and set "T13 ends with" to Abort: the phone app shows $400, a balance that never existed. Notice that "Writer waited for a reader?" comes out no in every run, even though T13 overwrites a row T12 has already read: T12's read took no lock.`,
        },
        {
          type: "text",
          html: `<p>Three things to take from the replays. The versions are identical under every level; only the <em>visibility rule</em> each read applies changes, which is how one storage engine offers several isolation levels. An abort copies nothing back: T13's versions stay in the table, struck through, ignored by every reader because their creator never committed. And garbage collection waits for the oldest snapshot: under SI the old $500 versions had to survive until T12 finished.</p>
<p>The visibility rule fits in four steps:</p>`,
        },
        {
          type: "steps",
          title: "Which row versions can a transaction see?",
          items: [
            `When a transaction starts, the database records which other transactions are <strong>in progress</strong> at that moment.`,
            `Writes by any of those in-progress transactions are ignored, <strong>even if they commit later</strong>.`,
            `Writes by <strong>aborted</strong> transactions are always ignored.`,
            `Writes by transactions with a <strong>later txid</strong> (which started after this one) are ignored, committed or not. Every other write is visible.`,
          ],
        },
        {
          type: "text",
          html: `<p>Equivalently: a version is visible if its creator had committed when the reader started, and it is either not deleted or deleted by a transaction that had <em>not</em> committed by then. That is why T12 still sees v(2, $500) after T13 commits: T13's deletion is as invisible to T12 as its new version.</p>
<h3>Indexes and append-only trees</h3>
<p>Indexes can simply point at every version of a row, with queries filtering out the ones they can't see and garbage collection removing old entries along with old versions. PostgreSQL adds <strong>heap-only tuple (HOT)</strong> updates: if no indexed column changed and the new version fits on the same page as the old one, the indexes aren't touched at all.</p>
<p>A different design uses <strong>append-only, copy-on-write B-trees</strong>, as in CouchDB, Datomic and LMDB. An update never modifies a page in place; it writes new copies of every page from the changed leaf up to the root. Each write transaction creates a new root, each root is a consistent snapshot as of that commit, and a reader simply keeps hold of the root it started with. The price is background compaction to reclaim pages no root refers to any more (Chapter 3).</p>`,
        },
        {
          type: "callout",
          tone: "warning",
          title: "Long-running transactions are not free",
          html: `<p>A snapshot pins every version it might need. In PostgreSQL a multi-hour report, or a session left idle in an open transaction, stops VACUUM from removing dead versions, so tables and indexes <strong>bloat</strong>. PostgreSQL's txids are also 32-bit, so VACUUM must periodically "freeze" old rows to prevent <strong>transaction ID wraparound</strong>; if it falls too far behind, the database stops accepting writes to protect itself. Oracle keeps old versions in undo segments instead of the table, and a long query whose undo has been overwritten fails with <code>ORA-01555: snapshot too old</code>. InnoDB also rebuilds old versions from its undo log, and its purge threads can't trim that log while an old snapshot is still open.</p>`,
        },
        {
          type: "text",
          html: `<h3>Why nobody agrees on the names</h3>
<p>The SQL standard's isolation levels descend from System R's 1975 definitions, written before snapshot isolation had been described, so SI has no standard name. In 1995 Berenson and colleagues defined it and showed that the standard's definitions are ambiguous: read narrowly, they let SI, which is not serializable, avoid every phenomenon they list. Vendors improvised: Oracle calls SI "serializable", PostgreSQL and MySQL call their snapshot levels "repeatable read", and DB2 uses "repeatable read" to mean serializability.</p>
<p>MySQL's version deserves a specific warning. InnoDB's REPEATABLE READ gives plain SELECTs a snapshot, but locking reads (<code>FOR UPDATE</code>, <code>FOR SHARE</code>), UPDATE and DELETE operate on the <em>latest committed</em> rows. That is why it doesn't detect lost updates, and why a transaction that mixes the two kinds of read can observe a combination of rows that no single snapshot contains.</p>
<p>Interviewers often use the standard's vocabulary, so map it across. ANSI's <strong>P2, the non-repeatable (fuzzy) read</strong>, is re-reading one row and getting a different committed value; read skew generalizes it to several objects read at different times. ANSI's <strong>P3, the phantom read</strong>, is re-running a range query and getting a different set of rows. A snapshot prevents both for read-only queries, which is why PostgreSQL's REPEATABLE READ shows no P3 phantoms even though the standard permits them at that level. Snapshot isolation is still not serializable: whether it prevents lost updates depends on the database (see the section on lost updates), and it does not prevent write skew (the section after that).</p>`,
        },
        {
          type: "table",
          title: "What the level names actually mean",
          headers: ["Database", "Level as named", "What you actually get"],
          rows: [
            [`<span style="white-space:nowrap">PostgreSQL</span>`, "REPEATABLE READ", "Snapshot isolation; updating a row that a concurrent transaction changed and committed aborts with a serialization error"],
            [`<span style="white-space:nowrap">PostgreSQL</span>`, "SERIALIZABLE", "Serializable snapshot isolation (SSI), since 9.1"],
            ["MySQL InnoDB", "REPEATABLE READ (the default)", "A snapshot for plain SELECTs; locking reads, UPDATE and DELETE see the latest committed rows; no lost-update detection"],
            ["Oracle", "SERIALIZABLE", "Snapshot isolation, which allows write skew"],
            ["SQL Server", "SNAPSHOT", "Snapshot isolation; the READ_COMMITTED_SNAPSHOT option instead gives per-statement snapshots at read committed"],
            ["IBM DB2", "REPEATABLE READ", "Serializability (DB2 calls the standard's repeatable read \"read stability\")"],
          ],
          note: `Labels are not behavior. Before relying on a level, test it against concrete anomaly cases, for example with Kleppmann's Hermitage suite.`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Oracle",
              tag: "snapshot too old",
              html: `Oracle builds read-consistent snapshots from undo data rather than keeping old row versions in the table. When a long query needs undo that has already been overwritten, it fails with ORA-01555 "snapshot too old": Oracle's version of the cost of long-running snapshots.`,
            },
            {
              org: "Sentry",
              year: "2015",
              tag: "txid wraparound",
              html: `In July 2015 Sentry's write-heavy PostgreSQL database neared transaction ID wraparound and stopped accepting writes, taking the service down for most of a working day. Recovery took finishing the vacuums and, in the end, truncating one large table: the operational price of MVCC's 32-bit transaction ids.`,
            },
            {
              org: "Uber",
              year: "2016",
              tag: "write amplification",
              html: `When Uber moved from PostgreSQL to MySQL, it cited this cost of MVCC: every update writes a new row version that the indexes must also point to (<a href="#/ch3/learn/other-indexes">Chapter 3</a>).`,
            },
            {
              org: "Hermitage",
              year: "2014",
              tag: "testing the labels",
              html: `Martin Kleppmann's Hermitage project runs the same concurrent-transaction test cases against many databases at each isolation level, documenting for example that PostgreSQL's REPEATABLE READ is snapshot isolation and that Oracle's SERIALIZABLE allows write skew.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What snapshot isolation buys",
          consLabel: "What it costs",
          pros: [
            "Consistent reads for backups, reports and integrity checks, however long they run",
            "No read locks: readers never block writers and writers never block readers",
            "Prevents dirty reads, dirty writes, read skew, and phantoms in read-only queries",
            "In the PostgreSQL design an abort needs no undo: its versions are simply invisible",
          ],
          cons: [
            "Old versions pile up while any snapshot needs them: bloat, purge lag, ORA-01555",
            "Write amplification: every update writes a new version, and possibly new index entries",
            "Lost-update protection varies by database",
            "Not serializable: write skew still gets through",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Explain MVCC visibility in 60 seconds\"",
          html: `<p>Have a crisp script ready. "Every row version is tagged with the txid that created it and, once it is updated or deleted, the txid that deleted it; an update is a delete plus an insert. When a transaction starts, it notes which transactions are still in progress. It sees a version only if the creator had committed before it started, and the version hasn't been deleted by a transaction that had also committed before it started. Aborted writes are never visible. So readers take no locks, writers lock only against other writers, and garbage collection removes versions no snapshot can see. The catches: long transactions pin old versions, and snapshot isolation still allows write skew." Expect the follow-up "So is snapshot isolation serializable?" Answer no, and give the on-call doctors example from the write-skew section.</p>`,
        },
        {
          type: "quiz",
          q: "A nightly backup runs as a single 3-hour transaction under snapshot isolation on a busy PostgreSQL database. What is the main cost?",
          options: [
            "All writes are blocked for 3 hours",
            "Concurrent writers fail with serialization errors",
            "Old row versions can't be garbage-collected while the backup's snapshot might still need them, so tables and indexes bloat",
            "The backup will contain a mix of before and after states",
          ],
          answer: 2,
          explain: `Under snapshot isolation readers take no locks, so writers carry on; "all writes blocked" is the tempting answer, and it is how a design based on read locks would behave. A read-only backup conflicts with no writer, so nobody gets serialization errors. The snapshot is consistent, so a backup mixing before and after states is the read-committed problem, not this one. The real price is that MVCC must keep every version the backup might read until it finishes, so VACUUM can't reclaim them.`,
        },
      ],
    },
  ],
});
