// Chapter 7: Transactions
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch7",
  part: 2,
  number: 7,
  title: "Transactions",
  tagline: "Transactions shrink crashes and races down to commit-or-abort; isolation levels decide which concurrency bugs still slip through.",
  overview: `<p>A <strong>transaction</strong> groups several reads and writes into one unit that either commits entirely or aborts entirely. That single abstraction absorbs a long list of problems the application would otherwise handle itself: a crash between two related writes, a network drop mid-operation, two clients overwriting each other, a reader catching data half-updated. The application is left with two outcomes, and after an abort it can usually just retry (<a href="#/ch7/learn/why-transactions">why transactions exist</a>). The famous summary of the guarantees, <strong>ACID</strong>, is looser than it sounds: atomicity is really abortability, consistency is the application's job, durability is a matter of probability, and isolation is where the real choices are made.</p>
<p>The central tension is between <strong>serializability</strong>, which makes concurrency invisible to the programmer, and what it costs in waiting, aborts or single-core throughput. Most databases therefore default to a weaker level (read committed in PostgreSQL, Oracle and SQL Server; repeatable read in MySQL), so most applications run exposed to anomalies nobody chose: read skew, lost updates, write skew and phantoms. These bugs depend on timing, rarely show up in tests, and have cost real money, and vendor names for isolation levels often hide what they actually prevent.</p>
<p>The ideas build in order. After <a href="#/ch7/learn/acid-unpacked">ACID letter by letter</a> and <a href="#/ch7/learn/aborts-and-retries">when a retry is safe</a>, the chapter climbs a ladder of anomalies: <a href="#/ch7/learn/read-committed">read committed</a> stops dirty reads and dirty writes, <a href="#/ch7/learn/snapshot-isolation">snapshot isolation</a> uses MVCC row versions to stop read skew, <a href="#/ch7/learn/lost-updates">lost updates</a> need atomic operations, locks or compare-and-set, and <a href="#/ch7/learn/write-skew-phantoms">write skew and phantoms</a> slip past all of those. Only serializability closes the whole class, and there are three ways to get it: <a href="#/ch7/learn/serial-execution">actual serial execution</a>, <a href="#/ch7/learn/two-phase-locking">two-phase locking</a> (pessimistic: wait) and <a href="#/ch7/learn/ssi">serializable snapshot isolation</a> (optimistic: abort and retry). Chapter 9 picks up from there: transactions that span several nodes (two-phase commit) and the real-time guarantee that serializability does not give you (linearizability).</p>`,

  // ------------------------------------------------------------------
  // CONCEPTS (teaching order, grouped by deep-dive section)
  // ------------------------------------------------------------------
  concepts: [
    // --- why-transactions ---
    {
      id: "multi-object-transactions",
      term: "Multi-object transactions",
      def: `A transaction that reads and writes <strong>several objects</strong> (rows, documents, index entries) as one unit. A relational database groups them by connection: everything between <code>BEGIN</code> and <code>COMMIT</code> on one client connection is one transaction. Many non-relational batch or multi-put APIs have no such grouping, so part of a batch can fail while the rest succeeds.`,
      problem: `Foreign keys, denormalized documents (a message plus an unread counter) and secondary indexes all require several objects to change together. Single-object atomicity can leave them out of sync after a crash, and a concurrent reader can see one change without the other.`,
      why: `Almost every storage engine already makes a <strong>single-object</strong> write atomic and isolated, using a log for crash recovery and a lock per object, so a 20 KB JSON document is never left half-written. Single-object primitives such as increment and compare-and-set are useful, and are sometimes marketed as "lightweight transactions", but they cannot group writes to different objects. Without multi-object transactions the application must reason about every partial outcome itself, and after a crash it often cannot tell which of its writes landed. With them it handles two outcomes: committed, or aborted and safe to retry.`,
      ex: `An inbox inserts a message row and then increments <code>unread_count</code>: a crash between the two leaves the counter wrong forever, and a concurrent reader can see the message with a count of 0. Bigtable offered only single-row transactions, so Google built Percolator (OSDI 2010) to get multi-row snapshot-isolation transactions for incremental web indexing. Cassandra's "lightweight transactions" are single-partition compare-and-set via Paxos. The pendulum swung back: the Spanner paper (2012) argued that programmers should deal with the cost of overusing transactions rather than code around their absence, and MongoDB 4.0 and DynamoDB both added multi-item transactions in 2018.`,
      section: "why-transactions",
    },

    // --- acid-unpacked ---
    {
      id: "acid",
      term: "ACID",
      def: `<strong>A</strong>tomicity, <strong>C</strong>onsistency, <strong>I</strong>solation, <strong>D</strong>urability: the safety guarantees a transaction is supposed to provide. The acronym was coined by Theo Härder and Andreas Reuter in 1983, building on Jim Gray's transaction work. In practice an "ACID" label says little about which <strong>isolation level</strong> you actually get, and the C is a property of the application rather than the database.`,
      problem: `Vendors and engineers needed a shorthand for the safety guarantees of transactions; it became a label that hides very different behavior.`,
      why: `Each letter is narrower than its name. <strong>A</strong> is about faults, not concurrency (abortability is the better word). <strong>C</strong> means your invariants hold, which the database enforces only for constraints you declare. <strong>I</strong> is a spectrum whose ideal is serializability but whose default is weaker. <strong>D</strong> reduces the risk of losing committed data without eliminating it. Two databases can both be "ACID compliant" and behave completely differently under concurrency, so the useful questions are: which isolation level, which anomalies does it still allow, and what does "committed" mean here (fsynced? replicated to how many nodes?).`,
      ex: `PostgreSQL, Oracle and SQL Server are ACID databases that default to <strong>read committed</strong>, where a "check the balance, then debit" transaction can still overdraw an account under concurrent requests. Oracle's level named SERIALIZABLE is really snapshot isolation, and MySQL's REPEATABLE READ does not detect lost updates. All of them ship under the same four letters.`,
      section: "acid-unpacked",
    },
    {
      id: "base",
      term: "BASE",
      def: `<strong>B</strong>asically <strong>A</strong>vailable, <strong>S</strong>oft state, <strong>E</strong>ventual consistency. Coined by Fox, Gribble, Chawathe, Brewer and Gauthier in "Cluster-Based Scalable Network Services" (SOSP 1997) and popularized by Dan Pritchett's 2008 ACM Queue article "BASE: An Acid Alternative".`,
      problem: `Large-scale web services that gave up transactions for availability needed a contrasting slogan.`,
      why: `It is even vaguer than ACID and mostly means "not ACID": stay available, tolerate temporarily inconsistent replicas, and push reconciliation (retries, idempotent updates, conflict merging) into the application. It names a philosophy rather than a set of guarantees, so it never tells you which anomalies to expect. The binary framing has also aged badly: many systems that launched without transactions later added them.`,
      ex: `Dynamo-style stores such as Cassandra and Riak: tunable quorums, no multi-key transactions, and conflicts settled by last-write-wins or siblings (<a href="#/ch5/concepts/last-write-wins">Chapter 5</a>). Pritchett's article describes splitting one logical update into steps linked by a persistent queue and making each step idempotent. MongoDB (4.0, 2018) and DynamoDB (2018) later added multi-item transactions.`,
      section: "acid-unpacked",
    },
    {
      id: "atomicity",
      term: "Atomicity",
      def: `If a fault (process crash, power loss, network failure, full disk, constraint violation) occurs after some of a transaction's writes have been applied, the database <strong>aborts</strong> the transaction and discards all of its writes: all or nothing. A better name would be <strong>abortability</strong>. It is <strong>not about concurrency</strong> (that is isolation), and it is unrelated to atomic CPU instructions and to linearizability.`,
      problem: `A crash, network failure or constraint violation halfway through several writes would leave half-applied changes that the application can neither find nor undo.`,
      why: `The payoff is that an aborted transaction left nothing behind, so a retry starts from a clean slate. That makes a retry safe only when you <em>know</em> the earlier attempt aborted: a timeout during COMMIT means the outcome is unknown (<a href="#/ch7/learn/aborts-and-retries">aborts and retries</a> covers idempotency keys). At recovery the log decides: a transaction without a commit record is rolled back (<a href="#/ch3/concepts/write-ahead-log-redo-log">write-ahead log</a>). Mechanics differ: InnoDB, Oracle and SQL Server apply undo records, while PostgreSQL leaves an aborted transaction's row versions in place, invisible because it never committed, until VACUUM removes them.`,
      ex: `A transfer debits Savings and credits Checking. As two auto-committed UPDATEs, a crash between them makes $100 vanish; inside one transaction, recovery finds no COMMIT record and discards the debit. Contrast Java's <code>AtomicInteger</code> or C++'s <code>std::atomic</code>, where "atomic" means no other thread sees a half-done operation: in ACID terms that is an isolation property.`,
      section: "acid-unpacked",
    },
    {
      id: "consistency-acid",
      term: "Consistency (the C in ACID)",
      def: `Application-specific <strong>invariants</strong> (e.g. credits and debits balance) hold before and after each transaction. The database can enforce only some of them (constraints); mostly it is the <strong>application's responsibility</strong>. Not the same as eventual consistency, consistent hashing, or CAP's consistency.`,
      problem: `Teams needed a name for "the data still makes sense", but folding it into ACID made people believe the database guarantees it on its own.`,
      why: `The database enforces only invariants you <strong>declare</strong>: NOT NULL, UNIQUE, foreign keys, CHECK constraints (which see one row at a time) and, in PostgreSQL, exclusion constraints. Anything spanning rows ("total balances unchanged", "at least one doctor on call") holds only if every transaction's logic is correct <em>and</em> runs under enough isolation. Atomicity, isolation and durability are database properties; consistency is what the application achieves by using them, which is why the C arguably doesn't belong in the acronym. Keep the four meanings apart: ACID consistency (invariants), eventual consistency (replicas converge, <a href="#/ch5/concepts/eventual-consistency">Chapter 5</a>), consistent hashing (placement, Chapter 6) and CAP's C, which is linearizability (<a href="#/ch9/concepts/linearizability">Chapter 9</a>).`,
      ex: `Accounting: debits and credits across all accounts must balance. <code>CHECK (balance &gt;= 0)</code> stops one row going negative, but "every transfer adds exactly what it takes" is enforced only by the transfer code. A hospital's "at least one doctor on call per shift" cannot be a CHECK at all, since it spans rows; it needs serializable isolation or explicit locking (<a href="#/ch7/learn/write-skew-phantoms">write skew</a>).`,
      section: "acid-unpacked",
    },
    {
      id: "isolation",
      term: "Isolation",
      def: `Concurrently running transactions shouldn't interfere with each other. The ideal is <strong>serializability</strong> (the outcome is as if they ran one at a time), but databases usually default to <strong>weaker levels</strong> that permit named anomalies.`,
      problem: `Concurrent clients touching the same data cause race conditions that are timing-dependent and almost untestable.`,
      why: `Isolation is the letter that varies most between products and matters most for correctness. Serializable is rarely the default because it costs waiting, aborts or throughput: PostgreSQL, Oracle and SQL Server default to read committed, MySQL InnoDB to repeatable read, and Oracle's level called SERIALIZABLE is actually snapshot isolation. Think in anomalies rather than names (dirty read, dirty write, read skew, lost update, write skew, phantom): each level is defined by which of them it still allows, and the chapter climbs that ladder one rung at a time.`,
      ex: `Flexcoin, a Bitcoin bank, shut down in March 2014 after an attacker sent thousands of simultaneous transfer requests that moved coins repeatedly before balances were updated; about 896 BTC were lost. ACIDRain (SIGMOD 2017) found 22 similar concurrency attacks, such as overspending gift cards, in 12 popular e-commerce applications running under their databases' default isolation.`,
      section: "acid-unpacked",
    },
    {
      id: "durability",
      term: "Durability",
      def: `Once a transaction commits, its data is not lost even if the node crashes: it is written to <strong>non-volatile storage</strong> (usually via a write-ahead log) and/or <strong>replicated</strong> to other nodes before the commit is acknowledged. Never absolute: correlated failures, fsync bugs and lost asynchronous replicas all defeat it.`,
      problem: `Memory is volatile and machines fail; without durability a "successful" commit could vanish on the next power cut.`,
      why: `"Committed" is a ladder, and each rung survives a bigger failure at a higher commit latency: acknowledged from memory, fsynced to the local log, replicated to followers, replicated across regions. Every rung has known gaps. In 2018 PostgreSQL developers found that on Linux a failed fsync could clear the error and mark dirty pages clean, so retrying the fsync reported success while data was gone (the early-2019 fix was to PANIC and recover from the WAL). A Google field study (FAST 2016) found that 30 to 80 percent of SSDs developed bad blocks within four years of deployment. Asynchronous replication loses acknowledged writes on failover, and correlated faults (a shared bug, a shared power feed) take out replicas together. In practice durability means disk, replication and backups combined.`,
      ex: `MySQL's <code>innodb_flush_log_at_trx_commit=1</code> (the default) flushes the redo log at every commit; settings 0 and 2 trade up to about a second of commits for speed. PostgreSQL's <code>synchronous_commit = off</code> can lose the most recent commits on a crash without corrupting anything. Redis with AOF and <code>appendfsync everysec</code> can lose about the last second of writes. Spanner and CockroachDB acknowledge a commit only once a majority of replicas have it in their consensus log (Paxos and Raft respectively).`,
      section: "acid-unpacked",
    },

    // --- aborts-and-retries ---
    {
      id: "safe-retries",
      term: "Retrying aborted transactions",
      def: `Because an aborted transaction leaves no trace, the application can retry it, but only the <strong>whole transaction</strong> (reads and decisions included), only for <strong>transient</strong> errors (deadlock, serialization failure, failover), with capped exponential backoff and jitter, and with a client-generated <strong>idempotency key</strong> written in the same transaction for the case where the commit outcome is unknown. External side effects are not rolled back by an abort.`,
      problem: `Abort is only useful if the app can do something about it; naive retry loops cause duplicate payments, retry storms and repeated emails. Leaderless, best-effort stores (Chapter 5) don't even abort: they apply what they can and leave the cleanup to the application.`,
      why: `Five ways a naive retry does harm: (1) the transaction committed but the acknowledgement was lost, so a retry runs it twice; (2) the error came from overload, so retries amplify it (cap them, and back off exponentially with jitter); (3) the error is permanent, such as a constraint violation, so retrying is pointless; (4) side effects outside the database (an email, a payment API call) already happened, so send them after commit through an <a href="#/ch11/concepts/dual-writes-problem">outbox</a> or make them idempotent too; (5) the client dies mid-retry and its write is lost. ORMs such as Rails's ActiveRecord and Django raise an exception on abort rather than retrying. At the SQL level, always ROLLBACK and start again from BEGIN: PostgreSQL marks the whole transaction aborted after any error, while InnoDB rolls back only the failed statement on a lock wait timeout (unless <code>innodb_rollback_on_timeout</code> is on) but the whole transaction on a deadlock.`,
      ex: `Stripe's API accepts an <code>Idempotency-Key</code> header: a retried charge with the same key returns the saved result instead of charging twice, the same key with different parameters is rejected, and keys may be pruned once they are at least 24 hours old. Retry PostgreSQL 40001 (serialization failure) and 40P01 (deadlock), or MySQL 1213 (deadlock) and 1205 (lock wait timeout); don't retry 23505 (unique violation) unless it is your own idempotency key, which means "already done". Marc Brooker's 2015 AWS post on exponential backoff and jitter showed that randomized delays break up clustered retries and, with 100 contending clients, more than halve the total number of calls. <a href="#/ch12/concepts/idempotence-via-operation-ids">Chapter 12</a> generalizes the key into end-to-end operation IDs.`,
      section: "aborts-and-retries",
    },

    // --- read-committed ---
    {
      id: "weak-isolation",
      term: "Weak isolation levels",
      def: `Non-serializable isolation levels (<strong>read uncommitted, read committed, snapshot isolation / repeatable read</strong>) that block some anomalies but not others, in exchange for better performance. They are defined by the anomalies they permit.`,
      problem: `Serializable isolation used to be too expensive for most workloads, so databases shipped cheaper levels, and most applications run on them by default.`,
      why: `"Use an ACID database" is not a concurrency strategy: you need to know which anomalies your level permits and protect each hot spot explicitly (atomic updates, locks, constraints). The ladder: read uncommitted stops dirty writes; read committed adds no dirty reads; snapshot isolation adds no read skew and phantom-free read-only queries; serializable stops everything, write skew included. Vendor names don't match behavior, so test what you rely on, as Kleppmann's Hermitage project (2014) did across many databases.`,
      ex: `PostgreSQL, Oracle and SQL Server ship read committed as the default and MySQL InnoDB ships repeatable read, so most applications run at a weak level nobody explicitly chose. CockroachDB is a notable exception: SERIALIZABLE by default. Check-then-act races of the kind weak isolation lets through cost Flexcoin and, reportedly, Poloniex real bitcoin in 2014.`,
      section: "read-committed",
    },
    {
      id: "read-committed",
      term: "Read committed",
      def: `Isolation level guaranteeing <strong>no dirty reads</strong> (you see only committed data) and <strong>no dirty writes</strong> (you overwrite only committed data). Implemented with row-level write locks held until commit, plus returning the last committed value to readers (PostgreSQL takes a new snapshot per statement). Default in PostgreSQL, Oracle and SQL Server.`,
      problem: `Without it, readers could see half-finished or later-rolled-back work, and concurrent writers could interleave multi-row updates (the listing goes to Bob, the invoice to Alice).`,
      why: `It is the cheapest level most applications can live with: a writer's changes become visible all at once, at commit, and in MVCC implementations readers never wait for writers. Read locks would also prevent dirty reads, but one long write transaction would then block every reader of the rows it touched, so most databases keep the old committed value instead (DB2, and SQL Server without READ_COMMITTED_SNAPSHOT, do use short read locks). What it does <strong>not</strong> stop: read skew, lost updates from application read-modify-write, and write skew. One subtlety: in PostgreSQL even at read committed, a single <code>UPDATE ... SET n = n + 1</code> is safe, because the second updater waits for the row lock and then re-evaluates against the newest committed version.`,
      ex: `PostgreSQL: a fresh MVCC snapshot per statement. Oracle: per-statement read consistency rebuilt from undo. SQL Server: lock-based read committed on-premises unless <code>READ_COMMITTED_SNAPSHOT</code> is on, which Azure SQL Database enables by default. MySQL InnoDB offers READ COMMITTED but defaults to REPEATABLE READ.`,
      section: "read-committed",
    },
    {
      id: "dirty-read",
      term: "Dirty read",
      def: `Reading data another transaction has written but <strong>not yet committed</strong> (ANSI phenomenon P1). Prevented at read committed and above.`,
      problem: `Readers could see part of a multi-row update, or data from a transaction that later rolls back.`,
      why: `Two harms. You see part of a multi-object update but not the rest (the new message without the counter bump), and if the writer then aborts, you have displayed, or acted on, data that never existed. Most databases prevent it without read locks by remembering the old committed value and returning that until the writer commits.`,
      ex: `SQL Server's widely used <code>WITH (NOLOCK)</code> hint means read uncommitted: queries can return rows that are later rolled back, and Microsoft's documentation warns that such scans can even skip rows or read one twice when concurrent writes move rows around. In a banking app at read uncommitted, a phone balance screen could show $400 from a transfer that then rolls back.`,
      section: "read-committed",
    },
    {
      id: "dirty-write",
      term: "Dirty write",
      def: `Overwriting a value another transaction has written but <strong>not yet committed</strong> (Berenson et al.'s P0). Prevented at every level, even read uncommitted, by row-level write locks held until commit or abort: the second writer waits.`,
      problem: `Two transactions updating the same rows could interleave their uncommitted writes (the car-sale listing to Bob, invoice to Alice), and rollback becomes ill-defined.`,
      why: `Without it, two multi-object updates interleave row by row and the result matches neither transaction; rollback also becomes ill-defined, because the value to restore may itself be uncommitted. Don't confuse it with the counter race: when two transactions both read 42 and both write 43, the second write happens <em>after</em> the first commits, so it is not a dirty write. That is a <a href="#/ch7/concepts/lost-update">lost update</a>, which read committed allows.`,
      ex: `Car sale: buying updates the listing (buyer) and the invoice (recipient). Alice and Bob buy at the same moment; with dirty writes allowed, the listing ends up with Bob and the invoice goes to Alice. With row write locks, Bob waits at his first write until Alice commits, then overwrites both rows consistently.`,
      section: "read-committed",
    },

    // --- snapshot-isolation ---
    {
      id: "non-repeatable-read-read-skew",
      term: "Non-repeatable read / read skew",
      def: `Within one transaction, reads observe the database at <strong>different points in time</strong>. ANSI's P2 <em>non-repeatable (fuzzy) read</em>: re-reading the same row returns a different committed value. <em>Read skew</em> (Berenson et al.'s A5A) generalizes it to different objects read before and after another transaction commits. Allowed at read committed; prevented by snapshot isolation.`,
      problem: `Long reads (backups, analytics, integrity checks) observe different parts of the database at different moments, e.g. $500 + $400 = $900.`,
      why: `Every value read was committed, yet together they describe a state that never existed. A page refresh hides it, but some jobs can't tolerate it: a backup copying a busy database for hours would mix old and new data and make the inconsistency permanent on restore, and analytic queries and integrity checks would return nonsense or false alarms. Read locks would fix it at the price of a backup blocking writers for hours, so the real answer is a per-transaction snapshot.`,
      ex: `Alice has $500 in each of two accounts. While she looks, a transfer moves $100 from account 2 to account 1; she reads account 1 before it ($500) and account 2 after it ($400), so $100 seems to have vanished. <code>pg_dump</code> and <code>mysqldump --single-transaction</code> avoid exactly this by running the whole dump inside one snapshot.`,
      section: "snapshot-isolation",
    },
    {
      id: "snapshot-isolation",
      term: "Snapshot isolation (often labeled repeatable read)",
      def: `Each transaction reads from a <strong>consistent snapshot</strong>: everything committed when it started, nothing committed afterwards. Implemented with <a href="#/ch7/concepts/mvcc">MVCC</a>; writes still take row write locks. Defined by Berenson et al. (1995) and absent from the SQL standard, so its names vary: REPEATABLE READ in PostgreSQL and (loosely) MySQL, SERIALIZABLE in Oracle, SNAPSHOT in SQL Server.`,
      problem: `Consistent long reads were needed without read locks that would block writers.`,
      why: `<strong>Readers never block writers and writers never block readers</strong>, so a long consistent read can run alongside normal traffic. It prevents dirty reads, dirty writes, read skew and phantoms in read-only queries. Lost-update detection depends on the product: PostgreSQL REPEATABLE READ, Oracle SERIALIZABLE and SQL Server SNAPSHOT abort the second writer; MySQL REPEATABLE READ does not. It does <strong>not</strong> prevent write skew. It is also not the usual default: PostgreSQL, Oracle and SQL Server default to read committed (PostgreSQL and Oracle with per-statement snapshots, on-premises SQL Server with locks unless RCSI is on), and MySQL InnoDB defaults to its own repeatable read. The cost is keeping old versions alive for as long as the oldest snapshot might need them.`,
      ex: `<code>pg_dump</code> runs inside a REPEATABLE READ snapshot. MongoDB's multi-document transactions (4.0+) read from a snapshot and provide snapshot isolation, not serializability. Percolator layered SI transactions over Bigtable. Hermitage shows Oracle's SERIALIZABLE allowing write skew, exactly as snapshot isolation does.`,
      section: "snapshot-isolation",
    },
    {
      id: "mvcc",
      term: "MVCC (multi-version concurrency control)",
      def: `Keeping several committed <strong>versions of each row</strong>, tagged with the creating and deleting transaction ids, so each transaction can read the version visible in its snapshot. Updates create new versions; garbage collection (VACUUM in PostgreSQL) removes versions no transaction can still see.`,
      problem: `Consistent snapshots for long reads would otherwise need read locks that block writers, or would show read skew.`,
      why: `The <strong>visibility rule</strong> is the heart of it: a version is visible to a snapshot if its creator had committed when the snapshot was taken (not in the snapshot's in-progress list, not a later txid, not aborted), and it has no deleter or its deleter fails that same test. An UPDATE is a delete plus the insert of a new version. Read committed uses the same machinery with a fresh snapshot per statement; snapshot isolation keeps one for the whole transaction. The operational price is old versions: a long-running transaction keeps them alive, causing table and index bloat in PostgreSQL, whose 32-bit transaction ids must also be frozen by VACUUM to avoid wraparound. Oracle and InnoDB instead rebuild old versions from undo logs, so a long Oracle query fails with ORA-01555 "snapshot too old" rather than bloating the table.`,
      ex: `PostgreSQL stores <code>xmin</code> (creator) and <code>xmax</code> (deleter) on every tuple and cleans up with autovacuum; HOT updates skip index maintenance when no indexed column changes and the new version fits on the same page. CouchDB, Datomic and LMDB use append-only (copy-on-write) B-trees in which each write transaction creates a new root, and every root is a consistent snapshot. Uber's 2016 post on moving from Postgres to MySQL cited MVCC write amplification as one reason. Precise detail: PostgreSQL assigns a permanent txid only at a transaction's first write and takes a REPEATABLE READ snapshot at its first statement, not at BEGIN.`,
      section: "snapshot-isolation",
    },

    // --- lost-updates ---
    {
      id: "lost-update",
      term: "Lost update",
      def: `Two transactions each <strong>read a value, modify it in application code and write it back</strong> (a read-modify-write cycle); the later write silently clobbers the earlier one's change. Berenson et al.'s P4. Allowed at read committed and at MySQL's REPEATABLE READ.`,
      problem: `Read-modify-write cycles in application code silently drop concurrent changes: two likes become one, two deposits become one, and nothing raises an error.`,
      why: `It is one of the most common write-write races, and it fails silently, so it surfaces as numbers that slowly drift. Fixes, roughly in order of preference: an <a href="#/ch7/concepts/atomic-write-operations">atomic write operation</a>; an explicit lock (<code>SELECT ... FOR UPDATE</code>) when the logic can't be one statement; <a href="#/ch7/concepts/compare-and-set">compare-and-set</a> on a version column; or automatic detection, which aborts the second writer in PostgreSQL REPEATABLE READ ("could not serialize access due to concurrent update"), Oracle SERIALIZABLE (ORA-08177) and SQL Server SNAPSHOT, but not in MySQL REPEATABLE READ. Replication caveat: locks and CAS assume a single up-to-date copy. Multi-leader and leaderless systems accept concurrent writes on different replicas, and <a href="#/ch5/concepts/last-write-wins">last-write-wins</a>, the default in many of them, loses updates by design; use siblings and merges or <a href="#/ch5/concepts/crdts">CRDTs</a>.`,
      ex: `Two users like a post at once and the ORM runs <code>post.likes += 1; post.save()</code> for each: 42 becomes 43, not 44. Two editors save the same wiki page and one edit disappears; two requests append to a list inside the same JSON document and one item is lost. Jepsen's 2023 analysis of MySQL 8.0.34 reported lost updates under REPEATABLE READ, consistent with Hermitage's earlier results.`,
      section: "lost-updates",
    },
    {
      id: "atomic-write-operations",
      term: "Atomic write operations",
      def: `Database-side read-modify-write in a <strong>single operation</strong>, e.g. <code>UPDATE t SET n = n + 1</code>, MongoDB <code>$inc</code>/<code>$push</code>, Redis <code>INCR</code>. Implemented with an exclusive lock on the object for the duration of the operation, or by running all such operations on one thread.`,
      problem: `Doing read-modify-write in application code lets concurrent clients overwrite each other's changes (lost updates).`,
      why: `The best fix whenever the change fits in one operation: no application-side read, no retry loop, and the database applies each change to the latest value. The exclusive lock held for the read and the write is sometimes called <em>cursor stability</em>. In PostgreSQL even at read committed, <code>UPDATE ... SET n = n + 1</code> is safe because a second updater waits for the row lock and re-evaluates against the newest version. Limits: not every change fits (editing free text, validating complex rules); ORMs make the unsafe version the easy one to write; and every increment of one row serializes on its lock, so a viral counter becomes a hot row.`,
      ex: `SQL <code>UPDATE counters SET n = n + 1 WHERE key = 'foo'</code>; MongoDB <code>$inc</code> and <code>$push</code>; Redis <code>INCR</code>, <code>LPUSH</code> and <code>ZINCRBY</code>; DynamoDB atomic counters via <code>UpdateItem</code>. In Django, <code>Post.objects.filter(pk=1).update(likes=F("likes") + 1)</code> is atomic while <code>post.likes += 1; post.save()</code> is not; Rails's <code>update_counters</code> issues a single atomic UPDATE.`,
      section: "lost-updates",
    },
    {
      id: "compare-and-set",
      term: "Compare-and-set (optimistic locking)",
      def: `A conditional write that succeeds only if the value (or, better, a <strong>version number</strong>) is still what the writer read, e.g. <code>UPDATE ... WHERE id = 1 AND version = 7</code>. Zero rows updated means someone else changed it, so re-read and retry. Also HTTP If-Match/ETag, Kubernetes resourceVersion, DynamoDB condition expressions.`,
      problem: `Holding locks while a user or app "thinks" is expensive, but blind writes lose concurrent updates.`,
      why: `It is <strong>optimistic</strong>: no lock is held while a user edits or the app computes, and a conflict costs a re-read and a retry instead of a wait. Compare a version number rather than the old contents: it is cheaper and avoids the ABA problem (a value changed and changed back looks untouched). Check how your database evaluates the WHERE clause, because a CAS checked against an old snapshot would not protect you. At read committed, PostgreSQL and MySQL re-check an UPDATE's WHERE against the latest committed row (PostgreSQL REPEATABLE READ aborts the second writer instead), so CAS works there. Under heavy contention the retries pile up, so CAS suits updates that rarely conflict.`,
      ex: `HTTP <code>ETag</code> plus <code>If-Match</code> (a stale PUT fails with 412 Precondition Failed); Kubernetes <code>resourceVersion</code> (a stale update gets 409 Conflict, so controllers re-read and retry); DynamoDB condition expressions on a version attribute; JPA/Hibernate <code>@Version</code> (OptimisticLockException); Rails <code>lock_version</code> (StaleObjectError); Redis <code>WATCH</code> with MULTI/EXEC.`,
      section: "lost-updates",
    },

    // --- write-skew-phantoms ---
    {
      id: "write-skew",
      term: "Write skew",
      def: `Two transactions read the same data (a <strong>premise</strong>), each decides it may proceed, and each writes, possibly to <strong>different objects</strong>. Each would be valid alone; together they break an invariant. It generalizes the lost update: had they written the same object, it would be a lost update or a dirty write. Berenson et al.'s A5B.`,
      problem: `Invariants spanning several rows (at least one doctor on call) break even though no row is written twice, so no write-write conflict is detected.`,
      why: `There is no write-write conflict, so atomic operations, row-level lost-update detection (PostgreSQL REPEATABLE READ, MySQL REPEATABLE READ, Oracle SERIALIZABLE, SQL Server SNAPSHOT) and snapshot isolation itself all let it through. Fixes: <strong>serializable</strong> isolation; locking every row the decision depends on (<code>SELECT * FROM doctors WHERE on_call AND shift_id = 1234 FOR UPDATE</code>, then count in the app, since PostgreSQL rejects FOR UPDATE with <code>COUNT(*)</code>); a constraint when one fits (UNIQUE, EXCLUDE); or <a href="#/ch7/concepts/materializing-conflicts">materializing the conflict</a>. Locking works only when the premise rows exist; when the premise is that rows are absent, the conflict is a <a href="#/ch7/concepts/phantom">phantom</a>.`,
      ex: `Doctors: Alice and Bob are both on call for shift 1234; each checks "at least two on call?", sees 2, and takes only themselves off; both commit and nobody is on call. The same shape: double-booking a meeting room, two players moving different pieces onto one square, two sign-ups claiming one username, two purchases each checking that the balance still covers them. ACIDRain (2017) used it to overspend gift cards in real e-commerce applications.`,
      section: "write-skew-phantoms",
    },
    {
      id: "phantom",
      term: "Phantom",
      def: `A write in one transaction <strong>changes the result of a search query</strong> in another; when that transaction's decision depended on the query, the phantom causes write skew. ANSI's narrower P3 <em>phantom read</em> means re-running a range query returns a different set of rows.`,
      problem: `Checks for the absence of rows can't be protected by row locks, because the conflicting row doesn't exist yet.`,
      why: `Snapshot isolation prevents phantoms in <strong>read-only</strong> queries (PostgreSQL's REPEATABLE READ shows no P3 phantom reads even though the standard allows them there), but a read-write transaction acting on "no rows match" is unprotected. <code>SELECT ... FOR UPDATE</code> on an empty result is database-specific: PostgreSQL and Oracle lock nothing, so the phantom slips through; MySQL InnoDB at REPEATABLE READ or SERIALIZABLE takes next-key (gap) locks that block the conflicting INSERT, often ending in a deadlock; at READ COMMITTED InnoDB doesn't gap-lock searches. UPDATEs can move rows into or out of a range too, not just INSERTs and DELETEs. Real fixes: predicate or index-range locks (2PL), SSI, constraints, or materialized conflict rows.`,
      ex: `Room booking: "SELECT bookings for room 123 overlapping 12:00 to 13:00; if none, INSERT". Claiming a username. Rails's <code>validates_uniqueness_of</code> is a check-then-insert race that lets duplicates through under concurrent requests (Bailis et al., "Feral Concurrency Control", SIGMOD 2015); a UNIQUE index is the reliable fix.`,
      section: "write-skew-phantoms",
    },
    {
      id: "materializing-conflicts",
      term: "Materializing conflicts",
      def: `Creating otherwise-useless rows (e.g. one per room per time slot) purely so that transactions checking for the <strong>absence</strong> of a booking have something concrete to lock with FOR UPDATE. A last resort; constraints or serializable isolation are usually better.`,
      problem: `Phantoms: when the check is "no rows match", FOR UPDATE has nothing to lock, so write skew slips through.`,
      why: `It turns an unlockable phantom into an ordinary row-lock conflict, but it is error-prone and leaks concurrency control into the data model: someone must pre-create and maintain the rows, and every code path must lock them. It also depends on a <strong>fresh read after the lock</strong>, so it works at read committed. Under PostgreSQL REPEATABLE READ, a lock-only <code>FOR UPDATE</code> that had to wait raises no error, and the follow-up check still reads the old snapshot, so the double booking can still happen; there, UPDATE the slot row (so first-updater-wins aborts the loser) or use SERIALIZABLE.`,
      ex: `A <code>time_slots(room_id, slot_start)</code> table with one row per room per 15 minutes for the next six months, locked with FOR UPDATE before checking bookings. A coarser variant locks the room's own row (<code>SELECT id FROM rooms WHERE id = 123 FOR UPDATE</code>) to serialize all bookings of one room. For double-spend checks over a ledger, lock the account row before inserting spend entries.`,
      section: "write-skew-phantoms",
    },

    // --- serial-execution ---
    {
      id: "serializable-isolation",
      term: "Serializable isolation",
      def: `The strongest level: the result of concurrently executing transactions equals the result of running them <strong>one at a time in some serial order</strong>. Any order will do, not necessarily the order in which they started; real-time recency is <a href="#/ch9/concepts/serializability-vs-linearizability">linearizability</a> (Chapter 9), and the combination of both is strict serializability. It prevents every anomaly in this chapter.`,
      problem: `Weak isolation anomalies are subtle, inconsistent across databases and untestable; serializability removes the whole class.`,
      why: `It replaces a patchwork of per-case fixes (an atomic update here, a lock there, a slot table, a constraint) that each work only if every code path remembers them. There are three ways to implement it: actual serial execution, two-phase locking and serializable snapshot isolation. The cost is waiting, aborts or single-core throughput, and the application must retry aborted transactions. It is rarely the default; exceptions include CockroachDB, Spanner, FoundationDB and SQLite. In PostgreSQL it protects only transactions that themselves run at SERIALIZABLE.`,
      ex: `PostgreSQL SERIALIZABLE is SSI (since 9.1); MySQL InnoDB and SQL Server SERIALIZABLE use 2PL; VoltDB and Redis execute serially; Spanner offers external consistency, which is strict serializability. Oracle's SERIALIZABLE is snapshot isolation and allows write skew.`,
      section: "serial-execution",
    },
    {
      id: "actual-serial-execution",
      term: "Actual serial execution",
      def: `Execute transactions <strong>one at a time on a single thread</strong> (one per partition), with no concurrency control at all: serializable by construction. Practical when four conditions hold: transactions are short and submitted whole as stored procedures; the active data fits in memory; write throughput fits one core per partition; cross-partition transactions are rare.`,
      problem: `Locking-based serializability was slow and complex; with in-memory data and short transactions, avoiding concurrency altogether became the faster option.`,
      why: `Around 2007, cheap RAM and short OLTP transactions made it viable, and skipping lock and latch coordination can make one thread faster than a concurrent engine: the 2008 study "OLTP Through the Looking Glass" found most of a traditional engine's instructions went to buffer management, latching, locking and logging. The costs: throughput is capped at one core per partition; a single slow transaction stalls everyone queued behind it; interactive transactions are impossible; and cross-partition transactions need coordination and are far slower (VoltDB reported about 1,000 cross-partition writes per second, orders of magnitude below its single-partition rate; DDIA cites this figure). Rarely used data can live on disk if the engine aborts a transaction that needs it, loads the data and restarts it (anti-caching).`,
      ex: `VoltDB, the commercial descendant of the H-Store prototype, runs each transaction as a Java stored procedure on the thread that owns its partition. Redis executes commands on one thread; MULTI/EXEC and Lua scripts run without interleaving. Datomic sends every write through a single transactor. The LMAX exchange runs its business logic on one in-memory thread at about 6 million orders per second (Fowler, 2011).`,
      section: "serial-execution",
    },
    {
      id: "stored-procedures",
      term: "Stored procedures (for serial execution)",
      def: `Submitting an <strong>entire transaction's logic</strong> to the database as one procedure call, so it runs start to finish without network round trips. Required by single-threaded engines (VoltDB uses Java, Redis Lua, Datomic Java or Clojure).`,
      problem: `Interactive transactions spend most of their time waiting on the network or the app; a single-threaded engine would sit idle while blocking everyone.`,
      why: `Shipping the whole transaction means it runs with no waits, which is what keeps the single thread busy. Deterministic procedures also enable replication by re-execution: VoltDB runs the same procedure on each replica instead of shipping row changes, which requires deterministic APIs for the current time and random numbers. The historical downsides are real: vendor languages (PL/SQL, T-SQL, PL/pgSQL) feel dated; code inside the database is harder to version, test, deploy, debug and monitor; and the database is shared, so one badly written procedure hurts every user. Modern engines use general-purpose languages instead.`,
      ex: `VoltDB: Java procedures. Datomic: transaction functions in Java or Clojure. Redis: Lua via <code>EVAL</code> and, since Redis 7, Functions. A Redis script that runs past the busy threshold (<code>lua-time-limit</code>, renamed <code>busy-reply-threshold</code> in Redis 7, 5 seconds by default) is not killed: other clients start getting BUSY errors until it finishes or is killed, which is an outage. Keep scripts tiny.`,
      section: "serial-execution",
    },

    // --- two-phase-locking ---
    {
      id: "two-phase-locking",
      term: "Two-phase locking (2PL)",
      def: `Pessimistic concurrency control for serializability. A read takes a <strong>shared (S)</strong> lock and a write an <strong>exclusive (X)</strong> lock, so readers block writers and writers block readers, and a transaction never acquires a lock after releasing one (a growing phase, then a shrinking phase). The form DDIA describes, and databases implement, holds <strong>every lock until commit or abort</strong> (strong strict, or rigorous, 2PL). It has nothing to do with two-phase <em>commit</em>.`,
      problem: `Readers taking no locks is exactly what lets premises change underneath them; to be serializable, reads must block conflicting writes.`,
      why: `The variants, precisely: basic 2PL only forbids acquiring after releasing; it is already conflict-serializable, but releasing write locks before commit lets others read uncommitted data (cascading aborts). Strict 2PL holds write locks to the end; rigorous 2PL holds all of them. What breaks serializability is releasing a lock and later acquiring another. Row locks alone don't stop phantoms, so 2PL also needs <a href="#/ch7/concepts/predicate-locks-index-range-locks">predicate or index-range locks</a>. The price is waiting: a slow transaction makes others queue, tail latency becomes unstable, and <a href="#/ch7/concepts/deadlock">deadlocks</a> are far more common than under read committed because reads lock too. That cost is why it fell out of favor as a default.`,
      ex: `Not a pre-MVCC relic: MySQL InnoDB at SERIALIZABLE (plain SELECTs become locking reads when autocommit is off), SQL Server at SERIALIZABLE (key-range locks), DB2 at REPEATABLE READ, and Google Spanner's read-write transactions (with wound-wait) all use it today. Eswaran, Gray, Lorie and Traiger (1976) showed that two-phase locking yields serializable executions.`,
      section: "two-phase-locking",
    },
    {
      id: "predicate-locks-index-range-locks",
      term: "Predicate locks / index-range locks",
      def: `A <strong>predicate lock</strong> is a shared lock on a search condition (e.g. room 123, overlapping 12:00 to 13:00) that covers every matching row, including rows that don't exist yet; any insert, update or delete whose old or new row matches must wait. An <strong>index-range (next-key) lock</strong> is the cheap approximation: lock a range of an index that contains the predicate, such as every booking for room 123.`,
      problem: `Plain row locks can't lock rows that don't exist yet, so phantoms get through 2PL.`,
      why: `2PL plus predicate locks is truly serializable, but true predicate locks are rarely implemented, because checking every write against many active predicates is slow. Index-range locks over-approximate (a few false conflicts) in exchange for cheap checks: any conflicting write must touch the same index range and so finds the lock. Without a suitable index the database falls back to locking the whole table, which is safe but kills concurrency, so index the columns your checks search.`,
      ex: `InnoDB's next-key lock is a record lock plus a lock on the gap before it, which is why an empty FOR UPDATE range blocks a conflicting INSERT at REPEATABLE READ. SQL Server's SERIALIZABLE takes key-range locks. PostgreSQL's SSI "predicate locks" (SIReadLock in <code>pg_locks</code>) never block; they are tripwires that lead to aborts, and a sequential scan takes one on the whole relation.`,
      section: "two-phase-locking",
    },
    {
      id: "deadlock",
      term: "Deadlock",
      def: `Two or more transactions each <strong>waiting for a lock another holds</strong>. The database detects the cycle in its wait-for graph and aborts a victim, which the application must retry. Common under 2PL, especially when two transactions both read (shared lock) and then both try to write.`,
      problem: `Lock-based isolation makes transactions wait; with waits in a cycle nobody can ever proceed unless the system breaks the cycle.`,
      why: `Databases either detect or prevent deadlocks. Detection: InnoDB checks for a cycle on every lock wait by default; PostgreSQL only once a wait exceeds <code>deadlock_timeout</code> (1 s by default). The victim receives an error to retry: PostgreSQL 40P01, MySQL 1213, Oracle ORA-00060. Lock-wait timeouts are a blunter tool (InnoDB's <code>innodb_lock_wait_timeout</code> defaults to 50 s). Prevention by transaction age never lets a cycle form: under <strong>wait-die</strong> an older transaction waits and a younger one aborts; under <strong>wound-wait</strong> an older transaction aborts (wounds) a younger lock holder, and a younger one waits. Application mitigations: lock in a consistent order, take write locks up front instead of read-then-upgrade, keep transactions short, index what you search, and retry the whole transaction with backoff.`,
      ex: `A pays B while B pays A, and each transaction locks its sender first: a cycle. Locking the lower account id first removes it. Spanner uses wound-wait for read-write transactions. In InnoDB at REPEATABLE READ, two concurrent bookings that each run <code>SELECT ... FOR UPDATE</code> on the same empty range both get (compatible) gap locks, and then deadlock when each tries to INSERT into the gap the other has locked.`,
      section: "two-phase-locking",
    },

    // --- ssi ---
    {
      id: "serializable-snapshot-isolation",
      term: "Serializable snapshot isolation (SSI)",
      def: `Optimistic serializable isolation built on snapshot isolation (Cahill, Röhm and Fekete, 2008; PostgreSQL's SERIALIZABLE since 9.1 in 2011). Transactions read from snapshots without blocking; the database tracks what each one read and aborts, at commit, a read-write transaction whose <strong>premise</strong> was changed by a concurrent transaction that committed. Two detection cases: (1) <strong>stale MVCC reads</strong>: a write it ignored because of its snapshot has since committed; (2) <strong>writes that affect prior reads</strong>: writers check SIREAD marks and notify the readers.`,
      problem: `Serializability via 2PL or serial execution was too costly; snapshot isolation was fast but allowed write skew.`,
      why: `Waiting until commit avoids needless aborts: the reader may turn out to be read-only, or the conflicting writer may abort or still be uncommitted. In PostgreSQL the failure is SQLSTATE 40001 and can surface at an earlier statement, not only at COMMIT; the application retries the whole transaction. PostgreSQL aborts on "dangerous structures" (two consecutive read-write antidependencies among concurrent transactions) rather than proven cycles, so some aborts are false positives. It is not a free lunch: abort rates climb under contention, long read-write transactions are likely to conflict, a missing index means sequential scans with relation-level SIREAD locks and more aborts, and only transactions running at SERIALIZABLE are protected. Long reports can use <code>SERIALIZABLE READ ONLY DEFERRABLE</code>, which waits for a snapshot that can never be aborted.`,
      ex: `PostgreSQL SERIALIZABLE (described by Ports and Grittner, VLDB 2012). FoundationDB and CockroachDB use related optimistic, MVCC-based schemes (DDIA calls FoundationDB's algorithm similar to SSI) rather than SSI as such. Jepsen's 2020 analysis reported that a bug let PostgreSQL 12.3's SERIALIZABLE admit G2-item anomalies, fixed in the next minor release: even mature implementations benefit from adversarial testing.`,
      section: "ssi",
    },
    {
      id: "optimistic-vs-pessimistic-concurrency",
      term: "Optimistic vs pessimistic concurrency",
      def: `<strong>Pessimistic</strong> control (2PL, explicit FOR UPDATE, and serial execution as the extreme) waits whenever something <em>might</em> conflict. <strong>Optimistic</strong> control (SSI, classic OCC from Kung and Robinson in 1981, compare-and-set) proceeds without waiting, checks at the end, and aborts and retries if a conflict actually happened.`,
      problem: `Locking up front wastes concurrency when conflicts are rare; checking at the end wastes work when they are common.`,
      why: `Optimism wins when conflicts are rare and there is spare capacity: no waiting, predictable latency, and read-only work never blocks. It loses under high contention, when many transactions abort, and near maximum throughput, when retries add load and push an overloaded system further over the edge. Pessimism degrades more gently but pays in queues, tail latency and deadlocks. Commutative operations such as concurrent increments need not count as conflicts, which lowers contention under either scheme.`,
      ex: `A flash-sale inventory row hit by thousands of buyers: under SSI most transactions abort and retry, under 2PL they queue on the lock, and the better fix for both is a single conditional decrement (<code>UPDATE items SET stock = stock - 1 WHERE id = 7 AND stock &gt; 0</code>) that holds the row lock only briefly. Optimistic designs elsewhere: Kubernetes resourceVersion, DynamoDB conditional writes, and <code>git push</code> rejecting a non-fast-forward until you fetch and rebase.`,
      section: "ssi",
    },
  ],

  // ------------------------------------------------------------------
  // CHEATSHEET
  // ------------------------------------------------------------------
  cheatsheet: [
    {
      title: "Isolation levels vs anomalies",
      type: "table",
      headers: ["Level", "Dirty write", "Dirty read", "Read skew", "Lost update", "Write skew", "Phantom (read-only query)"],
      rows: [
        ["Read uncommitted", "prevented", "possible", "possible", "possible", "possible", "possible"],
        ["Read committed", "prevented", "prevented", "possible", "possible", "possible", "possible"],
        ["Snapshot isolation", "prevented", "prevented", "prevented", "depends on DB*", "possible", "prevented"],
        ["Serializable", "prevented", "prevented", "prevented", "prevented", "prevented", "prevented"],
      ],
      note: "* Lost updates under snapshot isolation are detected automatically by PostgreSQL REPEATABLE READ, Oracle SERIALIZABLE and SQL Server SNAPSHOT, but not by MySQL InnoDB REPEATABLE READ. \"Lost update\" means an application read-modify-write; a single atomic <code>UPDATE ... SET n = n + 1</code> is safe even at read committed. A phantom inside a read-write transaction (check, then write) is write skew, which only serializable isolation, a constraint or a materialized conflict stops. Vendor names don't map cleanly onto these rows: see \"Names that lie\".",
    },
    {
      title: "Anomaly names across sources (ANSI SQL-92 and Berenson et al. 1995)",
      type: "table",
      headers: [`<span style="white-space:nowrap">Code</span>`, "Name", "One-line example", "Weakest level that prevents it"],
      rows: [
        [`<span style="white-space:nowrap">P0</span>`, "Dirty write", "Listing goes to Bob, invoice to Alice", "Read uncommitted (row write locks)"],
        [`<span style="white-space:nowrap">P1</span>`, "Dirty read", "Phone app shows an uncommitted $400 that is later rolled back", "Read committed"],
        [`<span style="white-space:nowrap">P2</span>`, "Non-repeatable (fuzzy) read", "Re-read one row, get a different committed value", "Snapshot isolation (ANSI: repeatable read)"],
        [`<span style="white-space:nowrap">A5A</span>`, "Read skew", "$500 + $400 = $900 in the middle of a transfer", "Snapshot isolation"],
        [`<span style="white-space:nowrap">P3</span>`, "Phantom", "Re-run a range query and new rows appear", "Snapshot isolation for read-only queries; serializable when a write depends on it"],
        [`<span style="white-space:nowrap">P4</span>`, "Lost update", "Two likes become one", "Snapshot isolation with auto-detect (not MySQL RR), or explicit fixes"],
        [`<span style="white-space:nowrap">A5B</span>`, "Write skew", "Both doctors go off call; nobody is left", "Serializable"],
      ],
      note: "P1 to P3 are the ANSI phenomena; Berenson et al. added P0, P4, A5A and A5B and showed the ANSI wording is ambiguous. DDIA's \"phantom\" is broader than P3: any write that changes the result of a search another transaction acted on.",
    },
    {
      title: "Default isolation by database",
      type: "table",
      headers: ["Database", "Default", "What you actually get", "Other levels worth knowing"],
      rows: [
        ["PostgreSQL", "Read committed", "MVCC with a new snapshot per statement; a single UPDATE re-checks the newest row version after waiting", "REPEATABLE READ = snapshot isolation with lost-update detection; SERIALIZABLE = SSI (9.1+)"],
        ["MySQL InnoDB", "Repeatable read", "Plain SELECTs read a snapshot; locking reads, UPDATE and DELETE act on the latest committed rows; no lost-update detection", "SERIALIZABLE = 2PL with next-key locks (plain SELECTs become locking reads when autocommit is off)"],
        ["Oracle", "Read committed", "Per-statement read consistency rebuilt from undo", "SERIALIZABLE = snapshot isolation (allows write skew; ORA-08177 on write conflicts)"],
        ["SQL Server", "Read committed (locking)", "Short shared read locks unless READ_COMMITTED_SNAPSHOT is on (on by default in Azure SQL Database)", "SNAPSHOT = snapshot isolation; SERIALIZABLE = 2PL with key-range locks"],
        ["CockroachDB", "Serializable", "Optimistic, timestamp-based MVCC; clients retry SQLSTATE 40001", "READ COMMITTED available as an option since 2024"],
        ["Google Spanner", "Serializable (external consistency)", "Read-write transactions: 2PL with wound-wait plus TrueTime commit timestamps; read-only transactions read a lock-free snapshot", "External consistency = strict serializability (serializable plus real-time order)"],
        ["SQLite", "Serializable", "One writer at a time for the whole database; in WAL mode readers keep a snapshot while the writer works", "The limit is write concurrency: competing writers get SQLITE_BUSY"],
        ["MongoDB (multi-document transactions)", "Snapshot isolation", "Snapshot reads; write conflicts abort with a transient error that the driver's callback API retries", "No serializable level; single-document writes are atomic on their own"],
      ],
      note: "Check what you actually run: <code>SHOW transaction_isolation;</code> in PostgreSQL, <code>SELECT @@transaction_isolation;</code> in MySQL 8.",
    },
    {
      title: "Names that lie",
      type: "list",
      items: [
        "<strong>Oracle SERIALIZABLE</strong> = snapshot isolation: write skew is allowed. Oracle's default READ COMMITTED is genuine read committed.",
        "<strong>PostgreSQL REPEATABLE READ</strong> = snapshot isolation, with lost-update detection and no P3 phantom reads (stronger than ANSI requires), but write skew is allowed.",
        "<strong>MySQL REPEATABLE READ</strong> = snapshot reads without lost-update detection; locking reads and UPDATEs see the latest committed data, so mixing the two styles can show states no single snapshot contains.",
        "<strong>DB2 REPEATABLE READ</strong> = serializable (it locks everything a query touches); DB2's \"read stability\" is the ANSI repeatable-read equivalent.",
        "<strong>SQL Server SNAPSHOT</strong> = snapshot isolation; <strong>READ_COMMITTED_SNAPSHOT</strong> = MVCC read committed (a database option, not a separate level).",
        "<strong>Cassandra \"lightweight transactions\"</strong> = single-partition compare-and-set via Paxos, not multi-object transactions.",
        "<strong>\"ACID compliant\"</strong> says nothing about the isolation level; ask which anomalies remain.",
      ],
    },
    {
      title: "Anomaly to minimal fix",
      type: "table",
      headers: ["Anomaly", "Minimal fix", "Example or caveat"],
      rows: [
        ["Dirty read", "Read committed", "Every mainstream default already gives you this"],
        ["Dirty write", "Read committed (row write locks held until commit)", "Prevented even at read uncommitted in practice"],
        ["Read skew", "Snapshot isolation (one snapshot per transaction)", "Backups and reports: <code>pg_dump</code>, <code>mysqldump --single-transaction</code>"],
        ["Lost update", "Atomic UPDATE, SELECT ... FOR UPDATE, CAS on a version column, or SI auto-detect", "Auto-detect exists in PostgreSQL RR, Oracle SERIALIZABLE and SQL Server SNAPSHOT, not in MySQL RR"],
        ["Write skew, premise rows exist", "FOR UPDATE on every row the decision read, or SERIALIZABLE", "Doctors: <code>SELECT * ... FOR UPDATE</code>, count in the app (PostgreSQL rejects FOR UPDATE with COUNT(*))"],
        ["Write skew via phantom (premise: rows absent)", "UNIQUE or EXCLUDE constraint, materialized conflict rows, or SERIALIZABLE", "FOR UPDATE on an empty result locks nothing in PostgreSQL and Oracle"],
      ],
    },
    {
      title: "Check-then-act checklist",
      type: "list",
      items: [
        "<strong>1.</strong> What did I read to justify this write (the premise)?",
        "<strong>2.</strong> Can a concurrent transaction change that answer before I commit?",
        "<strong>3.</strong> Do the premise rows exist (lock them with FOR UPDATE) or might they be absent (a constraint, materialized rows, or SERIALIZABLE)?",
        "<strong>4.</strong> Can the read-modify-write become one atomic UPDATE, with the check in its WHERE clause and the affected-row count checked?",
        "<strong>5.</strong> Is the final check made on the authoritative copy, inside the transaction, rather than on a replica or a cache?",
      ],
    },
    {
      title: "Preventing lost updates",
      type: "list",
      items: [
        "<strong>Atomic operation</strong>: <code>UPDATE counters SET n = n + 1 WHERE id = ?</code>, MongoDB <code>$inc</code>, Redis <code>INCR</code>. In PostgreSQL this is safe even at READ COMMITTED: the second updater waits for the row lock, then re-evaluates against the newest version.",
        "<strong>Conditional atomic update</strong>: <code>UPDATE accounts SET balance = balance - 80 WHERE id = ? AND balance &gt;= 80</code>, then check the affected-row count (0 means refused).",
        "<strong>Explicit lock</strong>: <code>SELECT ... FOR UPDATE</code>, validate in the app, write, commit. For logic too complex for one statement, such as a game move checked against the rules. Weakness: one code path that forgets the lock reintroduces the race.",
        "<strong>Compare-and-set</strong>: <code>UPDATE ... SET ..., version = 8 WHERE id = ? AND version = 7</code>; 0 rows means re-read and retry. Prefer a version column to comparing contents (cheaper, and no ABA problem).",
        "<strong>CAS outside SQL</strong>: HTTP <code>ETag</code> + <code>If-Match</code> (412 Precondition Failed), Kubernetes <code>resourceVersion</code> (409 Conflict), DynamoDB condition expressions, JPA <code>@Version</code>.",
        "<strong>Automatic detection</strong>: PostgreSQL REPEATABLE READ, Oracle SERIALIZABLE (ORA-08177) and SQL Server SNAPSHOT abort the second writer; MySQL REPEATABLE READ does not. No special code paths to forget, but the app must retry.",
        "<strong>Replicated data</strong>: locks and CAS assume one up-to-date copy. Multi-leader and leaderless stores using last-write-wins still lose updates (Chapter 5); use siblings and merges, or CRDT counters.",
      ],
    },
    {
      title: "Lost-update defenses compared",
      type: "table",
      headers: ["Technique", "Who waits or retries", "App discipline needed", "Complex logic?", "Multi-leader / leaderless replicas?"],
      rows: [
        ["Atomic operation", "Second writer waits briefly for the row lock", "Low: one statement", "No: must fit one operation", "Only if commutative (CRDT counters)"],
        ["SELECT ... FOR UPDATE", "Second transaction waits for the whole first transaction", "High: every code path must take the lock", "Yes", "No: the lock lives on one copy"],
        ["Compare-and-set (version column)", "Loser re-reads and retries", "Medium: check affected rows, loop", "Yes", "No: needs one authoritative copy"],
        ["Automatic detection (SI)", "Loser aborts and retries", "Low: a retry loop", "Yes", "No"],
        ["Serializable isolation", "Loser waits (2PL) or aborts (SSI)", "Low: a retry loop", "Yes, and it covers write skew too", "Only over single-copy or consensus-replicated data (Spanner, CockroachDB)"],
      ],
    },
    {
      title: "Three ways to get serializable",
      type: "table",
      headers: ["", "Actual serial execution", "Two-phase locking (2PL)", "Serializable snapshot isolation (SSI)"],
      rows: [
        [`<span style="white-space:nowrap">Strategy</span>`, "One transaction at a time on one thread per partition", "Pessimistic: S locks for reads, X for writes, all held to commit; index-range locks for phantoms", "Optimistic: run on a snapshot, track reads, abort at commit if a premise went stale"],
        [`<span style="white-space:nowrap">Reads block writes?</span>`, "N/A (no concurrency)", "Yes, and writes block reads", "No: SIREAD marks are tripwires, not locks"],
        [`<span style="white-space:nowrap">Deadlocks?</span>`, "No", "Yes, frequent; the database aborts a victim", "No read-lock deadlocks; conflicts become aborts (row write locks still exist)"],
        [`<span style="white-space:nowrap">Conflict handling</span>`, "N/A", "Wait; deadlock victim aborted (PostgreSQL 40P01, MySQL 1213)", "Abort at commit (SQLSTATE 40001), sometimes earlier; app retries"],
        [`<span style="white-space:nowrap">Latency</span>`, "Low and predictable while every transaction is short", "Unstable at high percentiles under contention", "Predictable; read-only work never waits"],
        [`<span style="white-space:nowrap">Scaling</span>`, "One core per partition; cross-partition transactions are slow (VoltDB reported about 1,000 cross-partition writes/s)", "Many cores, limited by lock contention", "Many cores; FoundationDB distributes conflict detection across machines"],
        [`<span style="white-space:nowrap">Sensitive to</span>`, "Slow transactions", "Slow transactions and hot rows", "Long read-write transactions and contention"],
        [`<span style="white-space:nowrap">Best for</span>`, "Small, fast stored-procedure transactions over in-memory data that partitions cleanly", "High contention, where waiting wastes less than abort storms", "Read-heavy or low-contention OLTP with spare capacity"],
        [`<span style="white-space:nowrap">Examples</span>`, "VoltDB, Redis (MULTI/EXEC, Lua), Datomic transactor", "MySQL InnoDB SERIALIZABLE, SQL Server SERIALIZABLE, Spanner read-write transactions", "PostgreSQL 9.1+ SERIALIZABLE (FoundationDB and CockroachDB use related optimistic schemes)"],
      ],
    },
    {
      title: "Shared/exclusive lock compatibility (2PL)",
      type: "table",
      headers: ["Lock already held by another transaction", "Request S (read)", "Request X (write)"],
      rows: [
        ["None", "Granted", "Granted"],
        ["S (shared)", "Granted", "Wait"],
        ["X (exclusive)", "Wait", "Wait"],
      ],
      note: "Read-then-write upgrades S to X: two transactions that both read a row and then both try to update it each wait for the other's S lock, the classic 2PL deadlock. Under MVCC snapshot isolation plain reads take no lock at all; locking reads (FOR UPDATE, FOR SHARE) still do.",
    },
    {
      title: "Locking reads on missing rows (the phantom test)",
      type: "table",
      headers: ["Database and level", "Locking read that matches no rows", "Concurrent INSERT into that range"],
      rows: [
        ["PostgreSQL, any level", "Locks nothing", "Proceeds: the phantom slips through (use a constraint or SERIALIZABLE)"],
        ["Oracle, any level", "Locks nothing", "Proceeds"],
        ["MySQL InnoDB, REPEATABLE READ or SERIALIZABLE", "Next-key / gap locks on the scanned index range", "Blocks; two such bookings often deadlock and one is aborted"],
        ["MySQL InnoDB, READ COMMITTED", "No gap locks for searches", "Proceeds"],
        ["SQL Server, SERIALIZABLE (or HOLDLOCK)", "Key-range locks", "Blocks until the reader's transaction ends"],
      ],
      note: "Always say which database a phantom claim is about. Constraints (UNIQUE, PostgreSQL EXCLUDE) are enforced at every level: a second inserter waits for the first transaction, then fails if it committed.",
    },
    {
      title: "Safe retry rules",
      type: "list",
      items: [
        "Retry only <strong>transient</strong> errors: PostgreSQL 40001 (serialization failure) and 40P01 (deadlock); MySQL 1213 (deadlock) and 1205 (lock wait timeout); Oracle ORA-08177 and ORA-00060; failover or connection reset.",
        "<strong>ROLLBACK, then retry the whole transaction</strong> from BEGIN, re-running its reads and decisions, never just the failed statement. PostgreSQL rejects every statement after an error until ROLLBACK; InnoDB rolls back only the statement on a lock wait timeout (unless <code>innodb_rollback_on_timeout</code>) but the whole transaction on a deadlock.",
        "Back off exponentially <strong>with jitter</strong>, cap the delay, and cap the attempts (a retry budget), so retries don't amplify overload.",
        "For outcome-unknown cases (timeout or connection reset during COMMIT), write a client-generated <strong>idempotency key</strong> in the same transaction under a UNIQUE constraint; a duplicate key means \"already done, return the saved result\".",
        "Never retry <strong>permanent</strong> errors: 23505 unique violation (unless it is your own idempotency key), 23514 check violation, bad input.",
        "Keep <strong>external side effects</strong> (email, payment APIs, message publishes) out of the transaction: send them after commit through an outbox, or make them idempotent too.",
        "Don't count on the ORM: Rails's ActiveRecord and Django raise on abort; they don't retry for you.",
      ],
    },
    {
      title: "What \"committed\" means: the durability ladder",
      type: "table",
      headers: ["Rung", "Survives", "Cost per commit", "Examples"],
      rows: [
        ["Acknowledged before fsync", "Little: a crash can lose the most recent commits (or everything, with persistence off)", "Lowest latency", "Redis with persistence off; MySQL <code>innodb_flush_log_at_trx_commit</code> 0 or 2 and PostgreSQL <code>synchronous_commit = off</code> risk up to about a second of commits"],
        ["fsynced to the local log (WAL)", "Process crash and power loss, if the disk honors fsync", "One fsync (group commit shares it among transactions)", "PostgreSQL and MySQL defaults; Redis <code>appendfsync always</code>"],
        ["Replicated to followers before the ack", "Loss of one machine", "A network round trip", "PostgreSQL synchronous standbys, MySQL semi-synchronous replication, MongoDB <code>w: \"majority\"</code>"],
        ["Replicated across regions before the ack", "Loss of a data center or region", "A cross-region round trip (tens of milliseconds or more)", "Spanner and CockroachDB multi-region configurations"],
      ],
      note: "Every rung still falls to correlated faults, fsync bugs (PostgreSQL's 2018 fsyncgate) and bad media (30 to 80 percent of SSDs in Google's fleet developed bad blocks within four years). Backups are part of durability.",
    },
    {
      title: "Easily confused terms",
      type: "table",
      headers: ["Term", "Often confused with", "The difference"],
      rows: [
        ["Two-phase locking (2PL)", "Two-phase commit (2PC)", "2PL is concurrency control inside one database (isolation); 2PC is atomic commit across nodes (Chapter 9). Spanner uses both."],
        ["Serializable", "Linearizable", "Serializable: equivalent to some serial order of transactions, not necessarily real time. Linearizable: reads see the latest write in real time (single object). Both together: strict serializability."],
        ["Atomicity (ACID)", "Atomic instructions / atomic operations", "ACID atomicity undoes a failed transaction's writes; atomic CPU instructions stop other threads seeing half an operation, which in ACID terms is isolation."],
        [`<span style="white-space:nowrap">Consistency</span> (ACID)`, "Eventual consistency, consistent hashing, CAP consistency", "Application invariants vs replicas converging (Chapter 5) vs partition placement (Chapter 6) vs linearizability (Chapter 9)."],
        ["Snapshot isolation", "Serializable", "SI allows write skew; serializable doesn't. Oracle's SERIALIZABLE is SI."],
        ["Dirty write", "Lost update", "A dirty write overwrites uncommitted data (prevented everywhere); a lost update overwrites committed data based on a stale read (allowed at read committed)."],
        ["Lost update", "Write skew", "Same object read-modify-written vs different objects written from a shared premise; only the first is caught by row-level conflict detection."],
      ],
    },
    {
      title: "MVCC visibility rule",
      type: "note",
      body: `<p>A snapshot records which transactions were <strong>in progress</strong> when it was taken. A row version is visible to it when:</p>
<span class="formula">creator committed AND creator not in the in-progress list AND creator started before the snapshot (lower txid)<br>AND (no deleter OR the deleter fails the same test)</span>
<p>Writes by aborted transactions are never visible. An UPDATE marks the old version deleted and creates a new one. Read committed takes a new snapshot per statement; snapshot isolation keeps one for the whole transaction. (PostgreSQL actually assigns a txid at a transaction's first write and snapshots at its first statement; the rule is the same.)</p>`,
    },
    {
      title: "Numbers and dates to remember",
      type: "list",
      items: [
        "<strong>1975</strong> IBM System R's transaction model, still followed by most SQL databases; <strong>1976</strong> Eswaran et al.: 2PL and predicate locks.",
        "<strong>1981</strong> Kung and Robinson: optimistic concurrency control; <strong>1983</strong> ACID (Härder and Reuter).",
        "<strong>1995</strong> Berenson et al. define snapshot isolation and P0, P4, A5A, A5B; <strong>1997</strong> BASE (Fox, Brewer et al.).",
        "<strong>2008</strong> SSI (Cahill, Röhm, Fekete); <strong>2011</strong> PostgreSQL 9.1 makes SERIALIZABLE true SSI.",
        "<strong>2018</strong> MongoDB 4.0 multi-document transactions (sharded clusters in 4.2, 2019) and DynamoDB transactions (November).",
        "PostgreSQL <code>deadlock_timeout</code> 1 s; InnoDB <code>innodb_lock_wait_timeout</code> 50 s.",
        "PostgreSQL txids are 32-bit: VACUUM must freeze old rows before about 2 billion transactions pass, or the database stops accepting writes to protect itself (wraparound).",
        "VoltDB: about 1,000 cross-partition writes/s (VoltDB's own figure, cited by DDIA), orders of magnitude below its single-partition throughput.",
        "Stripe idempotency keys kept at least 24 hours; FoundationDB transactions limited to about 5 seconds; MongoDB transactions time out after 60 seconds by default.",
        "DynamoDB transactions: up to 100 items per request (25 until September 2022), at twice the capacity cost of ordinary reads and writes.",
        "Flexcoin, March 2014: about 896 BTC lost to thousands of simultaneous transfer requests.",
      ],
    },
    {
      title: "Choosing a strategy for your application",
      type: "note",
      body: `<p style="margin-bottom:10px"><strong>Option 1: weak default plus targeted fixes.</strong> Stay at read committed (or snapshot isolation) and protect each known hot spot explicitly: atomic or conditional UPDATEs for counters and balances, FOR UPDATE where logic is complex, UNIQUE or EXCLUDE constraints for "no duplicates" rules, materialized rows as a last resort. Fast and familiar, but every new code path must be analyzed, and a forgotten case is a silent bug.</p>
<p style="margin-bottom:10px"><strong>Option 2: SERIALIZABLE plus a retry wrapper.</strong> Correctness no longer depends on spotting every race. It requires retrying the whole transaction on 40001 and 40P01 with backoff, short read-write transactions, side effects after commit, monitoring abort rates and hot rows, and running every relevant transaction at SERIALIZABLE (PostgreSQL's SSI protects serializable transactions only from each other). CockroachDB and Spanner make this the default.</p>
<p>Either way, <strong>serializable is not linearizable</strong>: it does not promise that you see the latest committed write in real time (<a href="#/ch9/concepts/serializability-vs-linearizability">Chapter 9</a>).</p>`,
    },
  ],

  // ------------------------------------------------------------------
  // INTERVIEW (grouped by deep-dive section, in teaching order)
  // ------------------------------------------------------------------
  interview: [
    // --- why-transactions ---
    {
      id: "q-multi-object-need",
      q: "Many NoSQL stores guarantee atomicity only for a single key or document. When is that enough, and when do you need multi-object transactions?",
      diff: "medium",
      section: "why-transactions",
      a: `<p><strong>Start from the invariant, not the product.</strong> Nearly every storage engine already makes a write to one row, key or document all-or-nothing and isolated (a log for crash recovery, a lock per object), and many add single-object atomic operations such as increment and compare-and-set. That is enough when every user action changes exactly one object: a cart stored as one document, a profile, an append-only event row, a counter bumped with <code>INCR</code>.</p>
<p><strong>You need multi-object transactions when an invariant spans objects:</strong></p>
<ul>
<li><strong>References</strong>: an order and its line items, or any foreign key. A partial write leaves orphans or dangling pointers.</li>
<li><strong>Denormalized copies</strong>: a message and the recipient's unread counter, a post and its author's post count. A crash between the writes leaves them disagreeing forever, and a concurrent reader can see one without the other.</li>
<li><strong>Secondary indexes</strong>: the index entry and the record are separate objects. Where an index is maintained asynchronously (DynamoDB global secondary indexes, for example, are eventually consistent), a query can briefly find a record through one path and not another.</li>
<li><strong>Moves</strong>: a debit and a credit, a stock decrement and an order insert.</li>
</ul>
<p><strong>Without them, the application carries the burden:</strong> put everything that must change together into one document; make writes idempotent so a half-applied batch can be replayed; derive secondary data asynchronously from a change stream and accept staleness (Chapter 11); or chain local transactions with compensating actions, which gives up isolation between the steps. Then name the cost being avoided: in a partitioned store a transaction that spans partitions needs coordination on every commit (Chapter 9's two-phase commit), which is why many early NoSQL systems left transactions out. The trend has reversed: MongoDB (4.0, 2018) and DynamoDB (2018) added multi-document and multi-item transactions, so today the sharper question is which isolation level and at what latency.</p>`,
      followups: [
        "How would you keep an unread counter consistent with the messages it counts, without a transaction?",
        "Is DynamoDB's BatchWriteItem a transaction?",
        "What do compensating actions give up compared with a real transaction?",
        "Why did many early NoSQL systems leave multi-object transactions out?",
      ],
      pitfalls: [
        "Saying \"NoSQL doesn't need transactions\" without naming the invariant at risk",
        "Treating a batch or multi-put API as all-or-nothing (BatchWriteItem can return UnprocessedItems)",
        "Calling single-object compare-and-set or \"lightweight transactions\" a transaction",
        "Forgetting that a secondary index is a second object that must stay in step",
      ],
    },

    // --- acid-unpacked ---
    {
      id: "q01",
      q: "What does ACID really mean?",
      diff: "medium",
      section: "acid-unpacked",
      a: `<p>ACID (Härder and Reuter, 1983) names the safety guarantees of a transaction, but each letter promises less than its name suggests, and the label alone tells you little about how a database behaves under concurrency.</p>
<ul>
<li><strong>Atomicity, better called abortability.</strong> If a fault (crash, network failure, full disk, constraint violation) hits after some of a transaction's writes, the database aborts it and discards all of them. It is about failures, <em>not</em> concurrency. The payoff: after an abort nothing changed, so a retry is safe, provided you know it aborted (a COMMIT that times out has an unknown outcome).</li>
<li><strong>Consistency is the application's invariants</strong> (credits equal debits, at least one doctor on call). The database enforces only what you declare (NOT NULL, UNIQUE, foreign keys, CHECK); everything else depends on correct transaction code running under enough isolation. It is a property of the application, and the word has four meanings to keep apart: ACID invariants, eventual consistency (replicas converge), consistent hashing (placement) and CAP's C (linearizability).</li>
<li><strong>Isolation: concurrent transactions shouldn't interfere.</strong> The ideal is serializability, but defaults are weaker: read committed in PostgreSQL, Oracle and SQL Server, repeatable read in MySQL, and Oracle's SERIALIZABLE is really snapshot isolation. Each level is defined by the anomalies it still allows.</li>
<li><strong>Durability reduces the risk of losing committed data; it never eliminates it.</strong> Mechanisms: a write-ahead log fsynced before the commit is acknowledged, and/or replication to other nodes. Known failure modes: mishandled fsync errors (PostgreSQL's 2018 "fsyncgate"), SSD bad blocks, asynchronous replicas losing acknowledged writes on failover, correlated faults. Backups are part of the story.</li>
</ul>
<p>A strong close: "When a vendor says ACID, I ask which isolation level it runs at and which anomalies that allows, and what <em>committed</em> means: fsynced locally, or replicated to how many nodes?" BASE (Basically Available, Soft state, Eventual consistency) is the even vaguer counter-slogan; it mostly means "not ACID".</p>`,
      followups: [
        "Which isolation level does your database default to, and which anomalies does that allow?",
        "What does BASE mean, and is it really the opposite of ACID?",
        "If atomicity isn't about concurrency, what stops two concurrent withdrawals from overdrawing an account?",
        "What would it take for a commit to survive the loss of a whole data center?",
      ],
      pitfalls: [
        "Equating the C in ACID with CAP consistency",
        "Thinking ACID implies serializable isolation",
        "Saying atomicity protects against concurrent access",
        "Claiming committed data can never be lost",
      ],
    },

    // --- aborts-and-retries ---
    {
      id: "q-commit-outcome-unknown",
      q: "A client's COMMIT times out. Did the transaction commit? How do you make retries safe?",
      diff: "medium",
      section: "aborts-and-retries",
      a: `<p><strong>You can't tell.</strong> The timeout may have struck before the COMMIT reached the database (nothing happened) or after the commit record was durably written but before the acknowledgement arrived (everything happened). Atomicity makes each attempt all-or-nothing; it says nothing about two attempts with the same intent. A blind retry after a lost acknowledgement runs the transfer twice, and both runs are perfectly valid transactions.</p>
<p><strong>Make the operation idempotent:</strong></p>
<ul>
<li>The client generates a request id <strong>once per user intent</strong>, not per attempt, and sends the same id on every retry.</li>
<li>The server writes that id <strong>inside the same transaction</strong> as the business writes, under a UNIQUE constraint, ideally together with the response (a <code>processed_requests</code> table). A retry hits the constraint, so the server returns the saved result: "already done". If the id were recorded in a separate transaction, a crash between the two writes would recreate the original problem.</li>
<li>The same id with a different payload is a client bug: reject it. Keep ids for longer than any client keeps retrying (Stripe keeps <code>Idempotency-Key</code>s for at least 24 hours and rejects a reused key with different parameters).</li>
<li>Alternatively, query the outcome by request id before retrying.</li>
</ul>
<p><strong>Retry hygiene:</strong> retry only transient errors (timeouts, connection resets, PostgreSQL 40001 and 40P01, MySQL 1213); ROLLBACK and re-run the whole transaction; use capped exponential backoff with jitter. <strong>External side effects</strong> such as emails or third-party payment calls belong after commit, via an outbox, or must carry their own idempotency key, because an abort cannot unsend an email. Chapter 12's end-to-end operation IDs are the general form of this pattern.</p>`,
      followups: [
        "How long must idempotency keys be retained?",
        "What if a retry arrives with the same key but a different payload?",
        "How does this relate to exactly-once processing in stream processors?",
        "Why can't the database deduplicate retries for you?",
      ],
      pitfalls: [
        "Assuming a timeout means the transaction failed",
        "Generating the idempotency key on the server per attempt instead of once on the client",
        "Retrying permanent errors such as constraint violations",
        "Sending emails or calling payment APIs inside the transaction",
      ],
    },

    // --- read-committed ---
    {
      id: "q-isolation-ladder",
      q: "Walk me through the common isolation levels. Which anomalies does each prevent, how is each usually implemented, and what do real databases default to?",
      diff: "medium",
      section: "read-committed",
      a: `<p>Frame it by <strong>anomalies, not names</strong>, because vendors reuse the same names for different behavior.</p>
<ul>
<li><strong>Read uncommitted</strong>: prevents dirty writes (row write locks held to commit) but allows dirty reads. Rarely chosen on purpose; SQL Server's <code>NOLOCK</code> hint is where most people meet it.</li>
<li><strong>Read committed</strong>: no dirty reads and no dirty writes. Row write locks plus serving readers the last committed value (PostgreSQL and Oracle take a fresh MVCC snapshot per statement; DB2 and lock-based SQL Server use short read locks). Still allows read skew, lost updates and write skew.</li>
<li><strong>Snapshot isolation</strong> (called REPEATABLE READ in PostgreSQL and MySQL, SERIALIZABLE in Oracle, SNAPSHOT in SQL Server): one MVCC snapshot per transaction, so readers and writers don't block each other. Prevents read skew and phantoms in read-only queries. Lost-update detection depends on the product: PostgreSQL, Oracle and SQL Server abort the second writer; MySQL doesn't. Still allows write skew.</li>
<li><strong>Serializable</strong>: equivalent to some serial order. Implemented by actual serial execution (VoltDB, Redis), two-phase locking with index-range locks (MySQL InnoDB and SQL Server at SERIALIZABLE), or SSI (PostgreSQL).</li>
</ul>
<p><strong>Defaults:</strong> PostgreSQL, Oracle and SQL Server use read committed; MySQL InnoDB uses repeatable read; CockroachDB uses serializable. Close with the practical point: labels differ by vendor, so test the behavior you rely on (Hermitage-style concurrent test cases), know which anomalies your code is exposed to, and then either protect each hot spot explicitly or run serializable with retries.</p>`,
      followups: [
        "Which isolation level does your production database actually run at, and how would you check?",
        "Which anomaly does snapshot isolation still allow, and how would you prevent it without SERIALIZABLE?",
        "Where do lost updates fit in this ladder?",
        "Why is serializable almost never the default?",
      ],
      pitfalls: [
        "Reciting the ANSI table as if every vendor implements it literally",
        "Saying REPEATABLE READ means the same thing in PostgreSQL and MySQL",
        "Assuming serializable is the default",
        "Forgetting that dirty writes are prevented even at the lowest level",
      ],
    },

    // --- snapshot-isolation ---
    {
      id: "q-read-phenomena",
      q: "What is the difference between a dirty read, a non-repeatable read and a phantom read?",
      diff: "easy",
      section: "snapshot-isolation",
      a: `<ul>
<li><strong>Dirty read (ANSI P1)</strong>: you see another transaction's <em>uncommitted</em> write, which may still roll back, so you may act on data that never existed. Prevented from read committed upward.</li>
<li><strong>Non-repeatable or fuzzy read (P2)</strong>: you read a row, another transaction <em>commits</em> a change to it, and re-reading the same row gives a different value. DDIA generalizes this to <strong>read skew</strong>, reading different objects at different points in time (Alice sees $500 + $400 = $900 mid-transfer). Prevented by snapshot isolation.</li>
<li><strong>Phantom read (P3)</strong>: you run a range query, another transaction inserts or deletes rows (or updates rows into or out of the range), and re-running the query returns a different set of rows.</li>
</ul>
<p>A snapshot hides phantoms from <strong>read-only</strong> queries; that is why PostgreSQL's REPEATABLE READ shows no P3 phantom reads even though the standard allows them at that level. But if your decision to write depended on the range query, a concurrent insert creates <strong>write skew</strong> (a double booking), which only serializable isolation, a constraint or a materialized conflict prevents. Row locks can't lock rows that don't exist yet; that is why predicate and index-range locks exist.</p>`,
      followups: [
        "Does PostgreSQL's REPEATABLE READ allow phantom reads?",
        "How does MySQL InnoDB prevent phantoms for locking reads?",
        "Can an UPDATE, rather than an INSERT, cause a phantom?",
      ],
      pitfalls: [
        "Confusing a non-repeatable read with a dirty read (in a non-repeatable read the changed value was committed)",
        "Thinking phantoms come only from INSERTs",
        "Claiming row-level locks prevent phantoms",
      ],
    },
    {
      id: "q04",
      q: "How do MVCC and snapshot isolation work?",
      diff: "hard",
      section: "snapshot-isolation",
      a: `<p><strong>MVCC</strong> keeps several committed versions of each row so that different transactions can each read the database as of their own point in time. <strong>Snapshot isolation</strong> is MVCC plus a rule: a transaction reads only versions that were committed when its snapshot was taken.</p>
<p><strong>Mechanism (PostgreSQL-style, as in DDIA):</strong></p>
<ul>
<li>Every transaction has an increasing transaction id (txid). Each row version carries <code>xmin</code> (the txid that created it) and <code>xmax</code> (the txid that deleted it, if any).</li>
<li>A DELETE only sets <code>xmax</code>. An UPDATE sets <code>xmax</code> on the old version and inserts a new version whose <code>xmin</code> is the updater.</li>
<li>When the snapshot is taken, the database records which transactions are <strong>in progress</strong>.</li>
<li><strong>Visibility</strong>: a version is visible if its creator committed, is not in the in-progress list, and started before the snapshot (lower txid), and its deleter, if any, fails that same test. Writes by in-progress, later or aborted transactions are therefore ignored. "xmin &lt;= my txid" on its own is wrong: a lower txid may still be in progress, or may have aborted.</li>
</ul>
<p><strong>Locks:</strong> reads take none, so readers never block writers and writers never block readers. Writers still take row write locks, so two writers of the same row still serialize and dirty writes remain impossible.</p>
<p><strong>Where old versions live:</strong> PostgreSQL keeps them in the table itself and removes them with VACUUM; Oracle and InnoDB update rows in place and reconstruct older versions from undo logs, purging undo later. That drives the operational trade-offs: PostgreSQL bloats when a long transaction holds VACUUM back, while Oracle fails the long query with ORA-01555 "snapshot too old". MongoDB's WiredTiger engine is also MVCC-based.</p>
<p><strong>Read committed vs snapshot isolation:</strong> the same machinery, but read committed takes a new snapshot per statement while snapshot isolation keeps one for the whole transaction. (Precise detail: PostgreSQL assigns a permanent txid only at a transaction's first write and takes the REPEATABLE READ snapshot at the first statement, not at BEGIN.)</p>`,
      followups: [
        "What stops VACUUM from removing a dead row version, and what happens when it falls behind?",
        "What is transaction ID wraparound, and how does freezing prevent it?",
        "How do indexes cope with several versions of the same row?",
        "Does MVCC prevent lost updates or write skew?",
      ],
      pitfalls: [
        "Giving the visibility rule as \"xmin &lt;= my txid\" without the in-progress list",
        "Saying MVCC readers take shared locks",
        "Forgetting that writers still lock rows",
        "Assuming every engine keeps old versions in the table, as PostgreSQL does",
      ],
    },
    {
      id: "q-mvcc-long-transactions",
      q: "Explain how PostgreSQL implements snapshot isolation with MVCC, and what operational problems long-running transactions cause.",
      diff: "hard",
      section: "snapshot-isolation",
      a: `<p><strong>Mechanism.</strong> Every row version (tuple) carries <code>xmin</code>, the txid that created it, and <code>xmax</code>, the txid that deleted or replaced it. An UPDATE never overwrites in place: it sets <code>xmax</code> on the old tuple and writes a new tuple whose <code>xmin</code> is the updater. A snapshot records the txid horizon and the list of transactions in progress when it was taken; a tuple is visible if its creator committed before the snapshot (not in progress, not later, not aborted) and its deleter, if any, did not. At REPEATABLE READ one snapshot covers the whole transaction (taken at its first statement); at READ COMMITTED each statement gets a fresh one. Reads take no locks; writes still take row locks, so concurrent updates of one row serialize. (PostgreSQL assigns a permanent txid only at a transaction's first write; read-only transactions use virtual ids.)</p>
<p><strong>Why long transactions hurt:</strong></p>
<ul>
<li><strong>Bloat.</strong> VACUUM may remove a dead tuple only when no snapshot can still see it. One long-running or "idle in transaction" session holds that horizon back for the whole database, so dead tuples pile up: tables and indexes bloat, scans read more pages, and the cache fills with garbage.</li>
<li><strong>Replicas, too.</strong> With <code>hot_standby_feedback</code> on, a long query on a standby reports its snapshot to the primary and causes the same bloat there; with it off, the standby instead cancels queries that conflict with replayed cleanup.</li>
<li><strong>Wraparound.</strong> Txids are 32-bit, so VACUUM must freeze old tuples before about 2 billion transactions pass. If it can't, because of a long transaction or autovacuum falling behind, PostgreSQL first warns and eventually stops accepting writes until a VACUUM completes. Sentry's 2015 write-up of such an outage is a well-known example.</li>
</ul>
<p><strong>Contrast:</strong> Oracle and InnoDB update rows in place and keep old versions in undo logs. A long Oracle query whose undo has been overwritten fails with ORA-01555 "snapshot too old" instead of bloating the table; in InnoDB a long transaction makes the undo history (purge lag) grow.</p>
<p><strong>Mitigations:</strong> <code>idle_in_transaction_session_timeout</code> and <code>statement_timeout</code>; short OLTP transactions; analytics on a replica or a warehouse; monitoring of the oldest transaction's age (<code>xact_start</code> in <code>pg_stat_activity</code>, <code>age(datfrozenxid)</code>) and autovacuum progress; per-table autovacuum tuning for hot tables. HOT updates, which skip new index entries when no indexed column changes and the page has room, reduce the write amplification Uber cited when it moved to MySQL in 2016.</p>`,
      followups: [
        "Why did Uber cite Postgres's MVCC design when it moved to MySQL in 2016?",
        "How does read committed use MVCC differently from repeatable read in Postgres?",
        "What is a HOT update and why does it help?",
        "Does snapshot isolation prevent write skew?",
      ],
      pitfalls: [
        "Saying MVCC readers take shared locks",
        "Forgetting that writers still lock rows (dirty writes are still prevented by locks)",
        "Claiming SI is serializable",
        "Describing visibility as simply \"xmin &lt;= my txid\" without the in-progress list",
      ],
    },
    {
      id: "q09",
      q: "Why is 'Repeatable Read' a misleading name?",
      diff: "medium",
      section: "snapshot-isolation",
      a: `<p>The SQL standard's levels (based on System R's 1975 definitions) predate snapshot isolation and define each level only by the phenomena it forbids, ambiguously, as Berenson et al. showed in 1995. In ANSI terms, P1 (dirty read) is forbidden from read committed up, P2 (non-repeatable read) from repeatable read up, and P3 (phantom) only at serializable. Vendors then attached the name "repeatable read" to quite different behavior:</p>
<ul>
<li><strong>PostgreSQL REPEATABLE READ</strong>: snapshot isolation with lost-update detection. It prevents P3 phantom reads too, more than the standard requires, but allows write skew.</li>
<li><strong>MySQL InnoDB REPEATABLE READ</strong> (the default): plain SELECTs read the transaction's snapshot, but locking reads (FOR UPDATE, FOR SHARE), UPDATE and DELETE act on the latest committed rows. So lost updates are not detected, and mixing the two read styles can show a state no single snapshot contains. Next-key (gap) locks block phantoms only for locking reads.</li>
<li><strong>Oracle</strong>: its default READ COMMITTED is genuine read committed. The misnamed level is <strong>SERIALIZABLE</strong>, which is snapshot isolation and allows write skew.</li>
<li><strong>IBM DB2</strong>: "repeatable read" means serializable (it locks everything a query touches); DB2's "read stability" is the ANSI repeatable-read equivalent.</li>
<li><strong>SQL Server</strong>: REPEATABLE READ is lock-based (shared locks held to commit; phantoms possible). SNAPSHOT is snapshot isolation, and READ_COMMITTED_SNAPSHOT is a database option that makes read committed use row versions.</li>
</ul>
<p>The practical lesson: don't trust the label. Test the behaviors your code relies on with Hermitage-style concurrent cases (two sessions, a scripted interleaving, check the outcome).</p>`,
      followups: [
        "Does PostgreSQL's REPEATABLE READ allow write skew?",
        "How would you demonstrate MySQL's missing lost-update detection with two terminal sessions?",
        "What did the Hermitage project find about Oracle's SERIALIZABLE?",
      ],
      pitfalls: [
        "Saying REPEATABLE READ means the same thing in PostgreSQL and MySQL",
        "Calling Oracle's READ COMMITTED misnamed (its SERIALIZABLE is the misnamed one)",
        "Treating the ANSI definitions as precise",
      ],
    },

    // --- lost-updates ---
    {
      id: "q06",
      q: "How do you prevent lost updates?",
      diff: "medium",
      section: "lost-updates",
      a: `<p>A lost update is a <strong>read-modify-write race</strong>: two transactions read the same value, each computes a new one in application code, and the later write clobbers the earlier (both read 42, both write 43). Read committed allows it, and so does MySQL's REPEATABLE READ. Options, roughly in order of preference:</p>
<ol>
<li><strong>Atomic operation</strong>: <code>UPDATE counters SET n = n + 1 WHERE id = ?</code>, MongoDB <code>$inc</code>, Redis <code>INCR</code>. No application-side read at all. In PostgreSQL this is safe even at READ COMMITTED, because the second updater waits for the row lock and re-evaluates against the newest version.</li>
<li><strong>Explicit lock</strong>: <code>SELECT ... FOR UPDATE</code>, then validate and write. For logic too complex for one statement, such as a multiplayer game move checked against the rules. The risk is a code path that forgets the lock.</li>
<li><strong>Compare-and-set with a version column</strong>: <code>UPDATE ... SET ..., version = 8 WHERE id = ? AND version = 7</code>; 0 rows updated means re-read and retry. A version number is cheaper than comparing contents and avoids ABA. The same idea appears as HTTP ETag/If-Match, Kubernetes resourceVersion, DynamoDB condition expressions and JPA <code>@Version</code>.</li>
<li><strong>Automatic detection</strong>: PostgreSQL REPEATABLE READ, Oracle SERIALIZABLE (ORA-08177) and SQL Server SNAPSHOT abort the second writer, and the application retries. MySQL REPEATABLE READ does not. Its advantage is that there is no special code path to forget.</li>
</ol>
<p><strong>Replication caveat:</strong> locks and CAS assume a single up-to-date copy. In multi-leader or leaderless replication, concurrent writes land on different replicas, and last-write-wins (the default in many such systems) loses updates by design; keep siblings and merge, or use commutative operations such as CRDT counters (Chapter 5).</p>
<p>The anti-pattern to name: <code>post.likes += 1; post.save()</code> in an ORM with no concurrency control.</p>`,
      followups: [
        "Which would you pick for a game move validated by complex rules?",
        "Why is a version column better than comparing the old contents?",
        "How do you prevent lost updates in a multi-leader or leaderless database?",
        "Is a single UPDATE ... SET n = n + 1 safe at READ COMMITTED?",
      ],
      pitfalls: [
        "Saying \"wrap it in a transaction\" fixes it at read committed",
        "Assuming MySQL's REPEATABLE READ detects lost updates",
        "Comparing whole old contents in a CAS instead of a version number",
        "Relying on last-write-wins replication for counters",
      ],
    },
    {
      id: "q-transfer-at-read-committed",
      q: "Your service runs on PostgreSQL at its default isolation level. A /transfer endpoint reads the sender's balance, checks it is at least the amount, then debits the sender and credits the receiver. What can go wrong under concurrency, and how would you fix it?",
      diff: "medium",
      section: "lost-updates",
      a: `<p><strong>The bug.</strong> PostgreSQL's default is READ COMMITTED, which stops dirty reads and dirty writes but not check-then-act races. Two concurrent $80 transfers from an account holding $100 both read 100, both pass "80 &lt;= 100", and both debit, leaving -60. Wrapping the steps in a transaction does not help at this level. If the balance is one column, this is the lost-update pattern (a read-modify-write of one row whose read went stale), which is why PostgreSQL's REPEATABLE READ would abort the second transfer; if the balance is computed as SUM over a ledger table, it is write skew via a phantom, since each transfer inserts a new ledger row, and only SERIALIZABLE or explicit locking catches it.</p>
<p><strong>Fixes, strongest first:</strong></p>
<ul>
<li><strong>Conditional atomic UPDATE</strong>: <code>UPDATE accounts SET balance = balance - 80 WHERE id = :from AND balance &gt;= 80</code>, then check the affected-row count (0 means insufficient funds: roll back). Safe at read committed: the second UPDATE waits for the first one's row lock, then re-evaluates its WHERE clause against the newest version, sees 20 and updates nothing.</li>
<li><strong>Lock the sender row</strong>: <code>SELECT balance FROM accounts WHERE id = :from FOR UPDATE</code>, check in code, then UPDATE. Use this when the rule is too complex for one statement (daily limits, fraud checks).</li>
<li><strong>SERIALIZABLE</strong> with a retry loop on 40001, which also protects rules you didn't think of.</li>
<li><strong>Backstop</strong>: <code>CHECK (balance &gt;= 0)</code>, so a missed code path fails loudly instead of overdrawing.</li>
</ul>
<p><strong>The rest of a strong answer:</strong> debit and credit in <strong>one transaction</strong> (atomicity); when locking two accounts, lock them in a <strong>consistent order</strong> (lower id first) so that concurrent A-to-B and B-to-A transfers can't deadlock; accept a <strong>client idempotency key</strong>, stored under a UNIQUE constraint in the same transaction, so a retry after a timeout cannot transfer twice. For a ledger design, lock the account row before inserting entries (a materialized conflict) or run SERIALIZABLE. Flexcoin's 2014 loss of about 896 BTC had this shape: thousands of simultaneous transfers passed the balance check before balances were updated.</p>`,
      followups: [
        "What if the balance is computed as SUM over a ledger table instead of stored in a row?",
        "How do you avoid deadlocks when A pays B while B pays A?",
        "What changes if the two accounts live on different shards?",
        "How would the client safely retry after a timeout?",
        "A flash sale has 100 units and 50,000 buyers arriving at once: how do you avoid overselling, and what becomes the bottleneck?",
      ],
      pitfalls: [
        "Saying \"wrap it in a transaction\" is enough at read committed",
        "Checking the balance in application code without a lock or a conditional write",
        "Ignoring the affected-row count of a conditional UPDATE",
        "Locking accounts in request order, so concurrent opposite transfers deadlock",
      ],
    },
    {
      id: "q-hot-counter",
      q: "Design a 'likes' counter for a viral post receiving tens of thousands of likes per second, without losing updates.",
      diff: "hard",
      section: "lost-updates",
      a: `<p><strong>Correctness first.</strong> A read-modify-write in the application (read <code>likes</code>, write <code>likes + 1</code>) loses updates. <code>UPDATE posts SET likes = likes + 1 WHERE id = ?</code> is correct, but every increment of that post waits for the same row lock, which is held until each commit's log flush completes, so increments of one row run one commit at a time and that single row becomes the bottleneck. The problem to design around is contention, not correctness.</p>
<p><strong>Options:</strong></p>
<ul>
<li><strong>Model the like, not the number.</strong> A like is set membership: store <code>(user_id, post_id)</code> under a UNIQUE constraint, so double clicks and retries are idempotent and an unlike is a DELETE. Compute the count asynchronously from those rows or their change stream.</li>
<li><strong>Sharded counters.</strong> Keep N sub-rows per post, increment a random one, and sum the N rows on read. Lock contention drops by a factor of N; reads become slightly more expensive.</li>
<li><strong>Buffer in memory.</strong> Redis <code>INCR</code> (single-threaded and atomic) absorbs the burst; deltas are flushed to the database periodically. Either accept a small loss window if the buffer node crashes, or make the flush idempotent by recording which deltas have been applied.</li>
<li><strong>Log and aggregate.</strong> Append like events to a log partitioned by post id (e.g. Kafka) and aggregate them in a stream processor with idempotent or exactly-once offset handling (<a href="#/ch11/concepts/exactly-once-semantics">Chapter 11</a>). Each post's partition has one consumer, so no locks are needed.</li>
<li><strong>Across regions</strong>, use a CRDT counter (<a href="#/ch5/concepts/crdts">Chapter 5</a>) rather than last-write-wins replication of the value, which drops increments.</li>
</ul>
<p>Ask whether exact real-time counts are required. Most products display approximate counts ("12.4K") that may lag by seconds, while the user's own like must appear immediately: a read-your-writes concern served from the membership row or from client state, not from the aggregate.</p>`,
      followups: [
        "How do unlikes work with your design?",
        "How do you show a user their own like immediately (read-your-writes)?",
        "What is lost if the buffering node crashes?",
      ],
      pitfalls: [
        "SELECT then UPDATE in application code",
        "A distributed lock around every increment",
        "Last-write-wins replication of counter values across regions",
      ],
    },

    // --- write-skew-phantoms ---
    {
      id: "q03",
      q: "Explain write skew with a concrete example.",
      diff: "hard",
      section: "write-skew-phantoms",
      a: `<p><strong>Setup:</strong> a hospital rule says at least one doctor must be on call per shift. Alice and Bob are both on call for shift 1234; both feel ill and click "go off call" at the same moment, under snapshot isolation.</p>
<ol>
<li>Alice's transaction runs <code>SELECT COUNT(*) FROM doctors WHERE on_call AND shift_id = 1234</code>, gets 2, decides it's safe, and runs <code>UPDATE doctors SET on_call = false WHERE name = 'Alice' AND shift_id = 1234</code>.</li>
<li>Bob's transaction, concurrently, reads its own snapshot: the count is 2, so it updates Bob's row.</li>
<li>Both commit. Nobody is on call.</li>
</ol>
<p><strong>Why nothing caught it:</strong> they wrote different rows, so there was no dirty write and no lost update; row-level lost-update detection and atomic operations don't apply, and each transaction was correct on its own. Each one's premise (the count) was invalidated by the other's write.</p>
<p><strong>Fixes:</strong></p>
<ul>
<li><strong>SERIALIZABLE</strong>: PostgreSQL's SSI aborts one of them; under 2PL one waits (or deadlocks and is retried) and then sees the change.</li>
<li><strong>Lock the premise rows</strong>: <code>SELECT * FROM doctors WHERE on_call AND shift_id = 1234 FOR UPDATE</code>, then count in the application. PostgreSQL rejects FOR UPDATE combined with an aggregate such as <code>COUNT(*)</code>. Bob's query waits for Alice's lock; at read committed it then re-checks the rows and finds only himself on call, and at PostgreSQL REPEATABLE READ it fails with a serialization error and is retried.</li>
<li><strong>Materialize the aggregate</strong>: keep <code>on_call_count</code> on the shift row and decrement it with <code>UPDATE shifts SET on_call_count = on_call_count - 1 WHERE id = 1234 AND on_call_count &gt; 1</code>, which turns write skew into a conflict on one row.</li>
</ul>
<p><strong>The phantom variant</strong> is harder. In room booking the premise is "no overlapping booking exists", so FOR UPDATE has nothing to lock: PostgreSQL and Oracle lock nothing, while InnoDB at REPEATABLE READ takes gap locks that block the conflicting insert and often deadlock. Fixes there: a constraint (UNIQUE on discrete slots, or PostgreSQL's <code>EXCLUDE USING gist</code> for overlapping ranges), materialized slot rows locked with FOR UPDATE, or SERIALIZABLE.</p>`,
      followups: [
        "What happens to Bob's FOR UPDATE query at READ COMMITTED in PostgreSQL once Alice commits?",
        "How would SSI detect this case?",
        "Could a CHECK constraint enforce \"at least one doctor on call\"? Why or why not?",
      ],
      pitfalls: [
        "Calling it a lost update or a dirty write",
        "Using FOR UPDATE with COUNT(*) (PostgreSQL rejects it)",
        "Assuming FOR UPDATE helps when the premise is that no rows exist",
        "Believing snapshot isolation prevents it",
      ],
    },
    {
      id: "q-write-skew-vs-lost-update",
      q: "How is write skew different from a lost update, and why doesn't SELECT ... FOR UPDATE always fix it?",
      diff: "medium",
      section: "write-skew-phantoms",
      a: `<ul>
<li><strong>Lost update</strong>: two transactions read-modify-write the <strong>same object</strong>, and the later write overwrites the earlier change (two likes become one). Because both write one object, it can be caught per row: atomic operations, compare-and-set, explicit locks, or snapshot isolation's automatic detection (PostgreSQL, Oracle, SQL Server; not MySQL REPEATABLE READ).</li>
<li><strong>Write skew</strong>: two transactions read <strong>overlapping data</strong> (a premise), then write <strong>different objects</strong>. Each is valid alone; together they break an invariant spanning objects (no doctor left on call). There is no write-write conflict to detect, so snapshot isolation and row-level detection let it through. A lost update is the special case in which both write the same object.</li>
</ul>
<p><strong>Why FOR UPDATE isn't a universal fix:</strong> it locks the rows a query <em>returns</em>. That works when the premise rows exist: lock every on-call doctor of the shift (<code>SELECT * ... WHERE on_call AND shift_id = 1234 FOR UPDATE</code>), and the second transaction waits, then either re-reads the changed rows (read committed) or is aborted and retried (PostgreSQL REPEATABLE READ). It fails when the premise is that rows are <strong>absent</strong>: a free room, an unused username, a spending total that new rows would push over a limit. The query returns nothing, so nothing is locked, and a concurrent INSERT is a phantom. PostgreSQL and Oracle lock nothing in that case; InnoDB at REPEATABLE READ takes gap locks that block the insert, often via a deadlock.</p>
<p><strong>Fixes for the phantom case:</strong> UNIQUE or EXCLUDE constraints, materialized conflict rows, or SERIALIZABLE (predicate or index-range locks under 2PL, SIREAD tracking under SSI).</p>`,
      followups: [
        "Is write skew possible under read committed? Under Oracle's SERIALIZABLE?",
        "How does 2PL prevent phantoms?",
        "Give a write skew example from a system you've built.",
      ],
      pitfalls: [
        "Calling write skew a dirty write",
        "Believing snapshot isolation prevents write skew",
        "Using FOR UPDATE with COUNT(*) in PostgreSQL (rejected) or on an empty result (locks nothing)",
      ],
    },
    {
      id: "q02",
      q: "What's the difference between snapshot isolation and serializable?",
      diff: "hard",
      section: "write-skew-phantoms",
      a: `<p><strong>Snapshot isolation (SI)</strong>: each transaction reads a consistent snapshot of everything committed when it started, using MVCC, so readers and writers never block each other. It prevents dirty reads, dirty writes, read skew and phantoms in read-only queries. Lost-update detection varies: PostgreSQL REPEATABLE READ, Oracle SERIALIZABLE and SQL Server SNAPSHOT abort the second writer; MySQL REPEATABLE READ doesn't. It <strong>allows write skew</strong>, including write skew caused by phantoms.</p>
<p><strong>Serializable</strong>: the outcome equals some serial execution of the same transactions, so every anomaly is prevented, write skew included. Implementations: actual serial execution (VoltDB, Redis), two-phase locking with index-range locks (MySQL InnoDB and SQL Server at SERIALIZABLE, Spanner), and SSI (PostgreSQL 9.1+), which is SI plus conflict tracking that aborts transactions acting on stale premises.</p>
<p><strong>The example:</strong> Alice and Bob, both on call, each check "are at least two doctors on call?" in their own snapshots, see 2, and each takes only themselves off call. They write different rows, so SI commits both and nobody is on call. Under SERIALIZABLE in PostgreSQL, one of them is aborted with SQLSTATE 40001, and its retry sees that only one doctor remains.</p>
<p><strong>Two precision points:</strong> serializable means equivalent to <em>some</em> serial order, not real-time order; "every read sees the latest write" is linearizability (Chapter 9), and the two combined are strict serializability (Spanner's external consistency). And labels don't settle it: Oracle's SERIALIZABLE is SI. Without SERIALIZABLE, the doctors case can be made safe by locking the premise rows (<code>SELECT * ... FOR UPDATE</code>) or by keeping a per-shift count updated with a conditional UPDATE.</p>`,
      followups: [
        "How would you make the doctors case safe without SERIALIZABLE?",
        "Why do databases default to something weaker than serializable?",
        "Is serializable the same as linearizable?",
        "How does PostgreSQL's SERIALIZABLE catch the doctors case?",
      ],
      pitfalls: [
        "Saying SI prevents everything except phantoms",
        "Claiming serializable means transactions take effect in the order they started",
        "Assuming Oracle's SERIALIZABLE is serializable",
      ],
    },
    {
      id: "q-no-double-booking",
      q: "Design the backend for a meeting-room (or seat) booking system that must never double-book, even under heavy concurrent demand.",
      diff: "hard",
      section: "write-skew-phantoms",
      a: `<p><strong>Name the problem.</strong> "Check that no booking overlaps, then insert" is check-then-insert: a <strong>phantom</strong>. Under snapshot isolation two requests both see the slot free and both insert (write skew), and <code>SELECT ... FOR UPDATE</code> on the bookings query locks nothing when the slot is free, at least in PostgreSQL and Oracle. The design must give the database something that conflicts.</p>
<p><strong>Options, simplest first:</strong></p>
<ol>
<li><strong>Discrete slots plus UNIQUE</strong>: if bookings are whole units (seats, 30-minute blocks), <code>UNIQUE (room_id, slot_start)</code>. The database rejects the second insert at any isolation level, and the app maps the violation to "already taken".</li>
<li><strong>Arbitrary intervals plus an exclusion constraint</strong> (PostgreSQL): <code>EXCLUDE USING gist (room_id WITH =, during WITH &amp;&amp;)</code> on a range column (the btree_gist extension provides the equality part). A second overlapping insert waits for the first transaction, then fails if it committed.</li>
<li><strong>A lock row per room</strong>: <code>SELECT id FROM rooms WHERE id = :room FOR UPDATE</code> before checking and inserting serializes bookings per room, a materialized conflict. It works at read committed; under PostgreSQL REPEATABLE READ the later check still reads the old snapshot, so UPDATE the room row instead, or use SERIALIZABLE.</li>
<li><strong>SERIALIZABLE plus retries</strong>: PostgreSQL's SSI aborts one of the two conflicting bookings. Good when rules are complex (capacity limits, multi-room events).</li>
<li><strong>A single writer per room</strong> at very high scale: route all requests for a room through one partition of a log keyed by room id and process them sequentially, the streaming form of serial execution (<a href="#/ch12/concepts/enforcing-constraints-on-streams">Chapter 12</a>).</li>
</ol>
<p><strong>The rest of the system:</strong> multi-step checkout uses <strong>tentative holds</strong> (rows with an <code>expires_at</code>, covered by the same constraint) plus a sweeper that releases expired ones; every booking request carries an <strong>idempotency key</strong>, so a retried request can't create a second booking; availability <strong>browsing</strong> can be served from replicas or a cache, but the <strong>final check</strong> must run on the primary, inside the booking transaction. To book several rooms atomically, insert them in one transaction in a consistent order (sorted room ids) to avoid deadlocks.</p>`,
      followups: [
        "How do you book several rooms atomically without deadlocks?",
        "Rooms are sharded across databases: what now?",
        "How do holds expire safely if the payment step is slow?",
        "Why not use a Redis lock around the booking?",
        "You used materialized slot rows under REPEATABLE READ in PostgreSQL. Is that still safe?",
      ],
      pitfalls: [
        "SELECT ... FOR UPDATE on the bookings table (in PostgreSQL or Oracle it locks nothing when the slot is free; InnoDB's gap locks block it but tend to deadlock)",
        "App-level uniqueness validation (the Rails validates_uniqueness_of race)",
        "Doing the final availability check against a replica or cache",
        "Using a distributed lock without fencing tokens (Chapter 8)",
      ],
    },

    // --- serial-execution ---
    {
      id: "q-single-threaded-db",
      q: "Redis and VoltDB execute transactions on a single thread. Why can that be fast, and when does the design break down?",
      diff: "medium",
      section: "serial-execution",
      a: `<p><strong>Why it's fast:</strong></p>
<ul>
<li><strong>No locks, latches or lock-wait queues.</strong> With one thread executing, nothing can interleave, so every transaction is serializable by construction.</li>
<li><strong>Data in memory</strong>, so the thread never waits for disk.</li>
<li><strong>Transactions submitted whole</strong> (Lua scripts or Functions in Redis, Java stored procedures in VoltDB), so the thread never waits for the network or the application mid-transaction.</li>
<li>Each operation takes microseconds, so one core sustains a very high rate. The 2008 "OLTP Through the Looking Glass" study found that most of a conventional engine's instructions went to buffer management, latching, locking and logging rather than useful work.</li>
</ul>
<p><strong>Where it breaks down:</strong></p>
<ul>
<li><strong>One core per partition.</strong> Scaling means partitioning: Redis Cluster divides keys into 16,384 hash slots, and a multi-key command or script must touch a single slot (hash tags such as <code>{user:42}</code> force related keys together); VoltDB runs one thread per partition, but cross-partition transactions need coordination and are far slower.</li>
<li><strong>One slow transaction stalls everyone.</strong> A long Lua script, <code>KEYS *</code> or a large <code>SORT</code> blocks all other clients; once a script runs past the busy threshold (5 seconds by default), Redis starts answering everyone else with BUSY errors until it finishes or is killed.</li>
<li><strong>Data must fit in memory</strong>, and interactive transactions don't fit the model at all.</li>
<li><strong>Weaker transaction semantics than people assume.</strong> Redis MULTI/EXEC provides isolation (no interleaving) but <strong>no rollback</strong>: if one queued command fails at runtime, the others still apply. WATCH adds optimistic check-and-set (EXEC fails if a watched key changed). A Lua script that errors midway does not undo its earlier writes.</li>
</ul>
<p>Redis 6's I/O threads parallelize socket reads and writes, but command execution remains single-threaded. The same idea appears in LMAX's single-threaded business logic and in Datomic's single transactor.</p>`,
      followups: [
        "How does VoltDB replicate if it ships procedures rather than row changes?",
        "What did Redis 6's I/O threads change, and what didn't they change?",
        "When would you choose a design like LMAX's single-threaded business logic?",
      ],
      pitfalls: [
        "Claiming Redis MULTI/EXEC rolls back on error",
        "Saying single-threaded means it can't use multiple cores at all (partitions can)",
        "Running long Lua scripts in production Redis",
      ],
    },

    // --- two-phase-locking ---
    {
      id: "q-2pl-vs-2pc",
      q: "What is the difference between two-phase locking and two-phase commit? Do real systems use both?",
      diff: "easy",
      section: "two-phase-locking",
      a: `<p>They solve different problems.</p>
<ul>
<li><strong>Two-phase locking (2PL)</strong> is <strong>concurrency control inside one database</strong>, used to get serializable isolation. Transactions take shared locks to read and exclusive locks to write, never acquire a lock after releasing one, and in practice hold every lock until commit or abort. The cost is waiting, deadlocks and unstable tail latency.</li>
<li><strong>Two-phase commit (2PC)</strong> is an <strong>atomic-commit protocol across several nodes</strong> or resource managers (<a href="#/ch9/learn/two-phase-commit">Chapter 9</a>). The coordinator asks every participant to prepare; each votes yes (promising it can commit, even after a crash) or no; the coordinator then tells all of them to commit, or all to abort. The cost is extra round trips and blocking if the coordinator fails after participants have prepared.</li>
</ul>
<p>They are orthogonal and often combined. Spanner uses 2PL (with wound-wait) for isolation in read-write transactions and 2PC across the shards a transaction touches. The interaction is the painful part: a prepared participant must keep holding its locks until it learns the decision, so a coordinator outage can block other transactions on those rows.</p>`,
      followups: [
        "What happens to a prepared participant's locks if the coordinator crashes?",
        "Does 2PC give you isolation?",
        "Why do many microservice designs avoid 2PC altogether?",
      ],
      pitfalls: [
        "Treating 2PL and 2PC as the same thing",
        "Saying 2PC makes transactions serializable",
        "Describing 2PL's two phases as \"prepare\" and \"commit\"",
      ],
    },
    {
      id: "q-deadlocks",
      q: "How do databases deal with deadlocks, and what can you do in application code to make them rarer?",
      diff: "medium",
      section: "two-phase-locking",
      a: `<p>A deadlock is a <strong>cycle in the wait-for graph</strong>: T1 waits for a lock T2 holds while T2 waits for one T1 holds. Nobody can proceed until the system breaks the cycle.</p>
<p><strong>What databases do:</strong></p>
<ul>
<li><strong>Detect and abort a victim.</strong> InnoDB checks for cycles on every lock wait by default; PostgreSQL only once a wait exceeds <code>deadlock_timeout</code> (1 s by default). The victim gets an error (PostgreSQL 40P01, MySQL 1213, Oracle ORA-00060) that the application must handle by retrying the whole transaction.</li>
<li><strong>Time out.</strong> Lock-wait timeouts (InnoDB's <code>innodb_lock_wait_timeout</code>, 50 s by default) catch what detection misses, bluntly.</li>
<li><strong>Prevent by age.</strong> Wound-wait (used by Spanner) and wait-die order transactions by start time so a cycle can never form; the cost is some unnecessary aborts.</li>
</ul>
<p><strong>Why 2PL deadlocks so much more than read committed:</strong> under 2PL reads take shared locks. Two transactions that each read a row and then try to update it each wait for the other's shared lock, a cycle. Under MVCC read committed, plain reads take no locks, so only write-write orderings can deadlock.</p>
<p><strong>Application mitigations:</strong> acquire locks in a <strong>consistent global order</strong> (lower account id first); take the write lock up front with <code>SELECT ... FOR UPDATE</code> instead of read-then-upgrade; keep transactions short and never wait for a user inside one; index the columns you search so fewer rows and ranges are locked; retry the whole transaction with backoff and jitter.</p>`,
      followups: [
        "Why does \"read, then update\" deadlock under SERIALIZABLE in MySQL but not under READ COMMITTED?",
        "What is wound-wait, and why might a distributed database prefer it to deadlock detection?",
        "Two transfers run A to B and B to A at the same moment: walk through the deadlock and the fix.",
      ],
      pitfalls: [
        "Treating a deadlock error as a database bug rather than a normal, retryable outcome",
        "Retrying only the failed statement",
        "Raising lock timeouts instead of fixing lock order",
      ],
    },
    {
      id: "q-2pl-phantoms",
      q: "Row locks can't lock a row that doesn't exist yet. How does two-phase locking stay serializable when a transaction's decision depends on rows being absent?",
      diff: "hard",
      section: "two-phase-locking",
      a: `<p><strong>The problem is the phantom.</strong> A booking transaction runs "any booking for room 123 overlapping 12:00 to 13:00?", finds none, and inserts one. Under 2PL with row locks only, the empty result locked nothing, so a second transaction runs the same check, also finds nothing, and both insert: a double booking, which is write skew through a phantom. Serializability needs a lock on the <em>question</em>, not just on the rows that answered it.</p>
<ul>
<li><strong>Predicate locks</strong> (the System R group, 1976): the reader takes a shared lock on the search condition itself, for example <code>room_id = 123 AND end_time &gt; '12:00' AND start_time &lt; '13:00'</code>. Before any insert, update or delete, the database checks whether the old or new version of the row matches a predicate held by another transaction, and if so waits. This covers rows that don't exist yet and gives true serializability, but matching every write against every active predicate is too slow, so mainstream databases don't implement it in this pure form.</li>
<li><strong>Index-range locks</strong> (next-key locking) approximate the predicate with a <em>larger</em> range that is cheap to check, attached to an index the query used: the index entries for room 123 (all times), or a time range across all rooms. Any write that could match the predicate must touch that part of the index, so it hits the lock. Over-locking causes false conflicts but costs far less. With no suitable index, the database falls back to locking much more, up to the whole table.</li>
</ul>
<p><strong>In real systems:</strong> MySQL InnoDB uses next-key locks (a record lock plus a lock on the gap before it) for locking reads, UPDATE and DELETE at REPEATABLE READ and SERIALIZABLE; an INSERT into a locked gap waits. Gap locks held by different transactions don't conflict with each other, so two bookers can both lock the empty gap and then deadlock on their inserts; one is aborted, and its retry sees the other's booking. At READ COMMITTED InnoDB turns gap locking off for searches, so the phantom gets through. SQL Server uses key-range locks at SERIALIZABLE. PostgreSQL has no blocking predicate locks: <code>SELECT ... FOR UPDATE</code> on an empty result locks nothing at any level, and its SERIALIZABLE (SSI) records non-blocking SIREAD "predicate locks" and aborts at commit instead.</p>
<p><strong>A strong close:</strong> if the rule fits a constraint, prefer the constraint (UNIQUE for discrete slots, a PostgreSQL <code>EXCLUDE</code> constraint for overlapping ranges), which works at every isolation level; otherwise materialize the conflict as lockable rows, or run SERIALIZABLE and index the columns you search so the locks stay narrow.</p>`,
      followups: [
        "Why doesn't SELECT ... FOR UPDATE stop the double booking in PostgreSQL, when it does in MySQL at REPEATABLE READ?",
        "What happens to the locks if the booking query can't use an index?",
        "Why do gap locks in InnoDB make deadlocks more likely, and what should the application do about it?",
        "How does SSI handle the same booking race without blocking?",
      ],
      pitfalls: [
        "Claiming row-level locks prevent phantoms",
        "Saying databases implement exact predicate locks (they approximate them with index ranges)",
        "Forgetting that a missing index widens the lock, up to the whole table",
        "Assuming PostgreSQL's SIREAD \"predicate locks\" block writers",
      ],
    },

    // --- ssi ---
    {
      id: "q05",
      q: "How does Serializable Snapshot Isolation (SSI) work?",
      diff: "hard",
      section: "ssi",
      a: `<p>SSI is <strong>optimistic serializable isolation built on snapshot isolation</strong> (Cahill, Röhm and Fekete, 2008; PostgreSQL's SERIALIZABLE since 9.1). Transactions read from MVCC snapshots and never wait for each other's reads; the database tracks enough to notice when a transaction acted on a <strong>premise</strong> that is no longer true, and aborts it.</p>
<p><strong>Two cases it detects</strong> (doctors example: T42 is Alice, T43 is Bob):</p>
<ol>
<li><strong>Stale MVCC read</strong> (the write came before the read): T43 reads Alice's row while T42's update of it is still uncommitted, so the visibility rules make T43 ignore that write. The database records that T43 ignored a write by T42. When T43 commits, it checks whether any ignored write has since committed; if so, T43 is aborted.</li>
<li><strong>Write after read</strong>: both transactions read the on-call doctors for shift 1234, and the database leaves a <strong>SIREAD mark</strong> on what each read. When T42 then writes Alice's row, it finds T43's mark and flags that T43's read may be outdated (a tripwire, not a blocking lock), and T43's write flags T42 in turn. T42 commits first and succeeds; when T43 tries to commit, a conflicting write it was warned about has committed, so T43 is aborted.</li>
</ol>
<p><strong>Why wait until commit?</strong> At read time the stale read might be harmless: T43 might be read-only, T42 might abort, or T42 might still be uncommitted when T43 commits. Waiting avoids needless aborts and keeps snapshot isolation's cheap long reads.</p>
<p><strong>In PostgreSQL:</strong> it aborts on "dangerous structures", two consecutive read-write antidependencies among concurrent transactions (T1 to T2 to T3, with T3 committing first), rather than on proven cycles, so some aborts are false positives. The error is SQLSTATE 40001 ("could not serialize access due to read/write dependencies among transactions") and can surface at an earlier statement, not only at COMMIT; the application retries the whole transaction. SIREAD locks can be promoted from row to page to relation under memory pressure, and a sequential scan takes a relation-level one, so missing indexes raise the abort rate. In a rare three-transaction case even a read-only transaction can be aborted (Fekete, O'Neil and O'Neil's read-only anomaly, 2004); <code>READ ONLY DEFERRABLE</code> avoids that by waiting for a safe snapshot.</p>
<p><strong>Trade-offs:</strong> no lock waits, predictable latency, and scaling across cores (FoundationDB applies a similar optimistic approach across machines). But abort rates climb with contention, and long read-write transactions are likely to be aborted, so keep them short.</p>`,
      followups: [
        "Why does SSI wait until commit instead of aborting at the stale read?",
        "Which workloads make SSI abort a lot?",
        "Can a read-only transaction be aborted under PostgreSQL SERIALIZABLE?",
        "How does SSI differ from 2PL with index-range locks?",
      ],
      pitfalls: [
        "Saying SSI takes read locks that block writers",
        "Claiming it aborts only on real cycles, with no false positives",
        "Retrying only the failed statement",
        "Assuming read-only transactions can never be aborted",
      ],
    },
    {
      id: "q08",
      q: "What's the difference between optimistic and pessimistic concurrency control?",
      diff: "medium",
      section: "ssi",
      a: `<p><strong>Pessimistic</strong> control (2PL, explicit <code>SELECT ... FOR UPDATE</code>; serial execution is the extreme case, as if every transaction locked everything) assumes conflicts are likely and makes transactions wait until it is safe. <strong>Optimistic</strong> control (SSI, classic OCC from Kung and Robinson in 1981, compare-and-set) proceeds without waiting, validates at the end, and aborts and retries if a conflict actually happened.</p>
<ul>
<li><strong>Optimistic wins</strong> when conflicts are rare and the system has spare capacity: no lock waits, no read-lock deadlocks, predictable latency.</li>
<li><strong>Pessimistic wins</strong> under high contention: each abort throws away completed work and the retry adds load. Near maximum throughput that feedback loop makes overload worse.</li>
<li><strong>Hot-row example</strong>: a flash-sale inventory row with thousands of concurrent buyers. Under SSI most transactions abort and retry; under 2PL they queue. The best answer for both is to shrink the critical section to one conditional atomic UPDATE.</li>
<li><strong>Commutative operations</strong> such as increments need not count as conflicts, so expressing changes as atomic operations reduces contention under either approach.</li>
</ul>
<p>Outside databases the same split appears: compare-and-set on a Kubernetes resourceVersion, DynamoDB conditional writes and a rejected non-fast-forward <code>git push</code> are optimistic; a mutex is pessimistic.</p>`,
      followups: [
        "Why can optimistic concurrency make an overloaded system worse?",
        "Is CAS on a version column optimistic or pessimistic? What about SELECT ... FOR UPDATE?",
        "How would you handle a hot row under each approach?",
      ],
      pitfalls: [
        "Saying optimistic is always faster",
        "Ignoring the cost of retries near capacity",
        "Treating serial execution as optimistic",
      ],
    },
    {
      id: "q07",
      q: "When would you pick each of the three serializable implementations?",
      diff: "hard",
      section: "ssi",
      a: `<p>Decide by data size, transaction shape and, above all, <strong>contention</strong>.</p>
<ul>
<li><strong>Actual serial execution</strong> (VoltDB, Redis, Datomic's transactor): when transactions are tiny and can be submitted whole as stored procedures, the active data fits in memory, and the workload partitions so that almost every transaction touches one partition. There is no locking overhead and it is serializable by construction, but you get one core per partition, a single slow transaction stalls everyone, and cross-partition work is slow.</li>
<li><strong>Two-phase locking</strong> (MySQL InnoDB and SQL Server at SERIALIZABLE, Spanner's read-write transactions): very much in use today, and the better fit under <strong>high contention</strong>, where waiting in a queue wastes less than abort-retry storms. Costs: readers and writers block each other, tail latency becomes unstable, deadlocks need retries, and index-range locks need good indexes or whole tables get locked.</li>
<li><strong>SSI</strong> (PostgreSQL SERIALIZABLE), and related optimistic schemes (SSI-like) such as FoundationDB's and CockroachDB's: read-heavy or low-contention OLTP with spare capacity. Readers never block, latency is predictable and read-only queries are cheap; the cost is aborts, which climb with contention and with long read-write transactions, so the application needs a retry loop.</li>
</ul>
<p>In practice you usually choose a database rather than an algorithm, so ask what its SERIALIZABLE actually does (Oracle's is not serializable at all). Rule of thumb: low contention and short transactions favor optimistic; hot rows favor pessimistic or, better, redesigning the hot spot (atomic increments, sharded counters); tiny, in-memory, cleanly partitioned workloads favor serial execution.</p>`,
      followups: [
        "Your workload has one extremely hot row. Which approach suffers least, and what would you change instead?",
        "Why does FoundationDB limit transactions to about 5 seconds?",
        "How do 2PL-based and SSI-based databases fail differently under overload?",
      ],
      pitfalls: [
        "Listing CockroachDB or FoundationDB as literal SSI implementations",
        "Calling 2PL obsolete (MySQL, SQL Server and Spanner use it today)",
        "Ignoring contention when choosing",
      ],
    },
    {
      id: "q-adopting-serializable",
      q: "Your team decides to run the application at SERIALIZABLE. What has to change in the application code and in operations?",
      diff: "medium",
      section: "ssi",
      a: `<p><strong>Expect transactions to fail, by design.</strong> They will now be aborted with serialization errors (SQLSTATE 40001 in PostgreSQL and CockroachDB) or deadlocks (in 2PL engines such as MySQL and SQL Server). That is the mechanism working, not a bug.</p>
<p><strong>Application code:</strong></p>
<ul>
<li>Wrap every transaction in a <strong>retry loop</strong> that re-runs the whole transaction, reads and decisions included, with backoff, jitter and a retry cap. ORMs such as Rails and Django don't do this for you.</li>
<li><strong>No non-idempotent side effects inside the retried block</strong>: send emails and call external APIs after commit, through an outbox.</li>
<li><strong>Keep read-write transactions short</strong>; move long reports to <code>READ ONLY</code> transactions (<code>DEFERRABLE</code> in PostgreSQL) or a replica.</li>
<li><strong>Run every relevant transaction at SERIALIZABLE</strong>: PostgreSQL's SSI only protects serializable transactions from each other, so one code path left at read committed reopens the hole.</li>
</ul>
<p><strong>Operations:</strong> monitor abort and retry rates per endpoint, find hot rows and reduce contention (atomic operations, splitting counters); make sure the columns you query are indexed, since in PostgreSQL a sequential scan takes a relation-level SIREAD lock and raises the abort rate; test the retry path deliberately, for example with two sessions forcing the doctors write skew.</p>
<p><strong>What it doesn't buy:</strong> serializable is not linearizable. It doesn't promise that a transaction sees the latest write in real time, and it says nothing about stale reads from asynchronous replicas (Chapter 9).</p>`,
      followups: [
        "Which workloads make SSI abort a lot?",
        "How do 2PL-based SERIALIZABLE levels fail differently?",
        "How would you test that your retry logic is correct?",
      ],
      pitfalls: [
        "Retrying only the statement that failed instead of the whole transaction",
        "Leaving HTTP calls or emails inside the retried block",
        "Assuming serializable means \"sees the latest data\" (that's linearizability)",
      ],
    },
  ],
});
