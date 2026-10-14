// Chapter 7 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch7", {
  sections: [
    // ------------------------------------------------------------------ 6
    {
      id: "lost-updates",
      title: "Lost updates: the read-modify-write trap",
      kicker: "Concurrent writes",
      concepts: ["lost-update", "atomic-write-operations", "compare-and-set"],
      blocks: [
        {
          type: "problem",
          title: "Two likes in, one like out",
          html: `<p>A post has 42 likes. Alice and Bob tap Like at the same moment, and two app servers run the same innocent code: read the count, add one in memory, write it back. Both read 42, both write 43. Both requests return 200 OK, and one like is gone without an error anywhere.</p>
<p>Nothing here breaks read committed: nobody saw uncommitted data, and the second write even waited for the first one's row lock. The isolation levels so far govern what a <em>reader</em> sees, not two transactions that each <strong>read, compute and write back</strong> the same value. Wrapping the code in <code>BEGIN ... COMMIT</code> doesn't help at read committed, nor at MySQL's default REPEATABLE READ. This is the <strong>lost update</strong>, one of the most common write-write races in real applications.</p>`,
        },
        {
          type: "idea",
          html: `<p>The second writer must apply its change to the <strong>latest</strong> value (atomic operations), <strong>wait</strong> for the first writer before reading (explicit locks), or <strong>notice</strong> that its premise changed and retry (compare-and-set, or automatic detection).</p>`,
        },
        {
          type: "text",
          html: `<h3>The read-modify-write cycle</h3>
<p>Read a value, modify it in application code, write the whole new value back. The cycle hides in many shapes:</p>
<ul>
<li><strong>Counters and balances:</strong> likes, stock levels, account balances.</li>
<li><strong>A local change to a complex value:</strong> two requests each append an item to a list inside the same JSON document and write the whole document back; one item disappears.</li>
<li><strong>Whole-page saves:</strong> two people fix different typos on the same wiki page, and the second Save reverts the first fix.</li>
</ul>
<p>The bug needs both reads to happen before either write commits. Tests rarely overlap requests that tightly, so the code passes; production traffic overlaps them constantly. In the visualization below <strong>you are the scheduler</strong>: each click advances one transaction by one database operation.</p>`,
        },
        {
          type: "viz",
          id: "ch7/lost-update-race",
          title: "Lost update race: you pick the interleaving",
          caption: "Try Naive first: step Alice all the way to commit before Bob reads (44, nothing lost), then press Play the classic race, which interleaves the two reads (43). Then pick each fix and try to lose a like, and finish with the 4-client stress test. Notice that no schedule breaks a fix, and that under contention each one costs waits or retries.",
        },
        {
          type: "text",
          html: `<p>In the classic race, notice the moment Bob's naive write blocks on Alice's row lock. Dirty-write protection is doing its job, and the like is lost anyway, because Bob computed 43 from a stale read <em>before</em> he waited. Each fix closes that gap differently.</p>
<h3>Fix 1: atomic write operations</h3>
<p>Don't do the arithmetic in the application. <code>UPDATE counters SET value = value + 1 WHERE key = 'foo'</code> is concurrency-safe in most relational databases. MongoDB's <code>$inc</code> and <code>$push</code> modify part of a document in place, and Redis offers <code>INCR</code>, <code>LPUSH</code> and the sorted-set commands people use as priority queues. Internally the database takes an <strong>exclusive lock on the object</strong> while reading and writing it (sometimes called <em>cursor stability</em>), or runs all such operations on one thread, as Redis does. In PostgreSQL, even at READ COMMITTED, a second <code>SET likes = likes + 1</code> waits for the row lock and then re-evaluates against the newest committed version, so the row ends at 44.</p>
<p>Two limits: not every change fits one operation (editing free text, validating a game move), and ORMs make the unsafe version the easy one.</p>`,
        },
        {
          type: "code",
          lang: "python",
          title: "The ORM trap, and the atomic version (Django)",
          code: `# Unsafe: a read-modify-write cycle hidden behind an object
post = Post.objects.get(id=7)    # SELECT ... -> likes = 42
post.likes += 1                  # computed in app memory: 43
post.save()                      # UPDATE posts SET ..., likes = 43 WHERE id = 7

# Safe: let the database do the arithmetic
Post.objects.filter(id=7).update(likes=F("likes") + 1)
# UPDATE posts SET likes = likes + 1 WHERE id = 7`,
        },
        {
          type: "text",
          html: `<h3>Fix 2: explicit locks</h3>
<p>When the logic doesn't fit one statement, <code>SELECT ... FOR UPDATE</code> locks the returned rows until the transaction ends, and a second transaction asking for them waits. A multiplayer game that validates each move against the rules before writing is the classic case. The weakness is human: <strong>every</strong> code path must take the lock, and one forgotten batch job silently reintroduces the race.</p>
<h3>Fix 3: let the database detect it</h3>
<p>Alternatively, let transactions run in parallel and have the database <strong>abort</strong> one that would lose an update; the app retries. PostgreSQL's REPEATABLE READ fails the second writer with <em>could not serialize access due to concurrent update</em> (SQLSTATE 40001), Oracle's SERIALIZABLE raises ORA-08177, and SQL Server's SNAPSHOT aborts on an update conflict. MySQL InnoDB's REPEATABLE READ does <strong>not</strong>, as both Hermitage and Jepsen found: as the snapshot isolation section showed, its UPDATE acts on the latest committed row, so the second writer simply overwrites. If preventing lost updates is part of what snapshot isolation means, as some argue, InnoDB's level isn't SI.</p>
<p>PostgreSQL's rule is <strong>first-updater-wins</strong>: the second UPDATE waits for the first writer's row lock, aborts if the first commits, and proceeds if it rolls back. The literature states first-committer-wins; either way exactly one of two conflicting writers survives. Because the app needs only a retry loop, there is no code path to forget.</p>
<h3>Fix 4: compare-and-set</h3>
<p>A conditional write succeeds only if the value is still what you read: <code>UPDATE wiki_pages SET content = 'new' WHERE id = 1234 AND content = 'old content'</code>. Zero rows changed means someone saved first, so re-read and retry. Comparing a <strong>version column</strong> instead (<code>AND version = 7</code>, setting it to 8) is cheaper and avoids ABA, where a value changes and changes back. One caveat: if your database evaluates the WHERE clause against an old snapshot, the check can pass when it shouldn't. Outside SQL this is called <strong>optimistic locking</strong>, and it's everywhere: HTTP's <code>If-Match</code>, Kubernetes's <code>resourceVersion</code>, DynamoDB condition expressions, and JPA's <code>@Version</code>, which throws <code>OptimisticLockException</code> when no row matches.</p>`,
        },
        {
          type: "code",
          lang: "sql",
          title: "Three SQL fixes for the same increment",
          code: `-- Atomic write: read and write happen under one row lock
UPDATE posts SET likes = likes + 1 WHERE id = 7;

-- Explicit lock: a second transaction waits at its SELECT
BEGIN;
SELECT likes FROM posts WHERE id = 7 FOR UPDATE;  -- 42, row now locked
-- arbitrary app logic here (validate a move, check a limit, ...)
UPDATE posts SET likes = 43 WHERE id = 7;
COMMIT;

-- Compare-and-set on a version column: no lock held while the app thinks
SELECT likes, version FROM posts WHERE id = 7;    -- 42, version 7
UPDATE posts SET likes = 43, version = 8
 WHERE id = 7 AND version = 7;
-- "UPDATE 0" means someone else won: re-read and retry`,
        },
        {
          type: "table",
          title: "Choosing a lost-update fix",
          headers: ["Technique", "Who waits or retries", "Needs app discipline?", "Complex logic?", "Across replicas?"],
          rows: [
            ["Atomic operation<br><code style=\"white-space:nowrap\">x = x + 1</code>, <code>$inc</code>, <code>INCR</code>", "The second writer waits briefly on the row lock (or the single thread)", "Low, but ORMs tempt you into read-modify-write", "No: only what fits one operation", "Only commutative ones, as CRDT counters"],
            ["Explicit lock<br><code>SELECT ... FOR UPDATE</code>", "The second transaction waits until the first ends", "High: every code path must take the lock", "Yes", "No: the lock lives on one node"],
            ["Compare-and-set (version column)", "The loser gets 0 rows and retries", "Medium: check the row count and loop", "Yes, even across user think time", "No: assumes one up-to-date copy"],
            ["Automatic detection (SI)", "The loser aborts with 40001 and retries", "Low: just a retry loop", "Yes", "No, and not in MySQL InnoDB"],
          ],
        },
        {
          type: "callout",
          tone: "warning",
          title: "Replicated data breaks all four",
          html: `<p>Locks and compare-and-set assume <strong>one up-to-date copy</strong> that every writer goes through. Multi-leader and leaderless replication (Chapter 5) accept concurrent writes on different replicas, so there is no single place to lock or compare against. Such systems keep siblings and merge them, or use operations that commute, such as CRDT counters (Riak 2.0's data types, for example). Last write wins, the default in many replicated databases, loses updates by design.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "MediaWiki", tag: "edit conflicts", html: "The software behind Wikipedia notices when a page changed after you opened the editor. It merges edits to different lines automatically and shows an <em>edit conflict</em> page only when both touched the same lines, so the second Save never silently reverts the first." },
            { org: "Kubernetes", tag: "compare-and-set", html: "An update carrying a stale <code>resourceVersion</code> fails with HTTP 409 Conflict, so controllers re-read and retry: compare-and-set at the heart of the control plane." },
            { org: "HTTP (RFC 7232, now RFC 9110)", tag: "conditional requests", html: "A PUT whose <code>If-Match</code> ETag is out of date fails with 412 Precondition Failed instead of silently overwriting someone else's change." },
            { org: "MySQL (Jepsen, 2023)", tag: "isolation testing", html: "Jepsen's MySQL 8.0.34 analysis reported that InnoDB's REPEATABLE READ allows lost updates, among other anomalies, so it isn't snapshot isolation in the usual sense." },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Two requests increment the same counter: make it correct\"",
          html: `<p>Rank the options instead of reaching for locks first: an <strong>atomic operation</strong> if the change fits one; <strong>compare-and-set on a version</strong> when there's app logic or user think time, since nothing stays locked while a human decides; <strong>FOR UPDATE</strong> for multi-row logic inside one short transaction; <strong>automatic detection</strong> only if your database has it (PostgreSQL REPEATABLE READ does, MySQL's doesn't), plus a retry loop. Strong answers name the ORM's load-modify-save as the usual culprit and point out that on a leaderless store none of this works without a single owner per key or a CRDT.</p>`,
        },
        {
          type: "quiz",
          q: "Two app servers each run <code>SELECT stock FROM items WHERE id = 7</code>, then <code>UPDATE items SET stock = &lt;value - 1&gt; WHERE id = 7</code>, at READ COMMITTED. Which change does <strong>not</strong> prevent the lost update?",
          options: [
            "<code>UPDATE items SET stock = stock - 1 WHERE id = 7</code>",
            "Reading with <code>SELECT ... FOR UPDATE</code>",
            "<code>UPDATE ... SET stock = &lt;v - 1&gt; WHERE id = 7 AND stock = &lt;v&gt;</code>, retrying if 0 rows change",
            "Wrapping both statements in <code>BEGIN ... COMMIT</code>, still at READ COMMITTED",
          ],
          answer: 3,
          explain: "A transaction at read committed only rules out dirty reads and dirty writes: both servers can still read the same committed stock and both write value - 1. It's tempting because 'it's in a transaction' sounds safe, but weak isolation doesn't serialize read-modify-write cycles. The atomic UPDATE, the explicit lock and the compare-and-set each make the second writer use, wait for, or detect the newer value.",
        },
      ],
    },

    // ------------------------------------------------------------------ 7
    {
      id: "write-skew-phantoms",
      title: "Write skew and phantoms: two correct transactions, one broken invariant",
      kicker: "The subtle anomaly",
      concepts: ["write-skew", "phantom", "materializing-conflicts"],
      blocks: [
        {
          type: "problem",
          title: "Nobody is on call",
          html: `<p>A hospital requires at least one doctor on call per shift. Alice and Bob are both on call for shift 1234, both feel ill, and both click <em>Go off call</em> within a second of each other. Each click runs a careful transaction: count the on-call doctors, and only if there are at least two, take yourself off call. Both see 2. Each updates its own row. Both commit. Nobody is on call.</p>
<p>They wrote <strong>different rows</strong>, so there was no dirty write and no lost update, and the fixes from the previous section have nothing to grab. Snapshot isolation commits both. Worse, the obvious repair, locking what you read, stops working as soon as the check is "no matching rows exist", because then there is nothing to lock.</p>`,
        },
        {
          type: "idea",
          html: `<p><strong>Write skew</strong>: a transaction's write is justified by a read (its premise) that a concurrent transaction invalidates. When the premise is about rows that <em>don't exist</em>, the conflict is a <strong>phantom</strong>, and the cure is a constraint, a materialized row to lock, or true serializability.</p>`,
        },
        {
          type: "diagram",
          title: "The on-call race: each transaction is right about its own snapshot",
          svg: `<style>.dd-diagram-body svg.c7d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c7d2-w{display:none}.dd-diagram-body svg.c7d2-n{display:block}}</style><svg class="c7d2-w" viewBox="0 0 640 250" role="img" aria-label="Alice and Bob each read 2 doctors on call, each update their own row, both commit, and 0 doctors remain on call">
<defs>
<marker id="c7ws-w-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
<marker id="c7ws-w-c5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c5)"/></marker>
<marker id="c7ws-w-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="12" y="62" font-size="13" font-weight="700" style="fill: var(--viz-c6)">Alice's tx</text>
<text x="12" y="127" font-size="13" font-weight="700">Database</text>
<text x="12" y="144" font-size="12" style="fill: var(--viz-muted)">doctors on call</text>
<text x="12" y="202" font-size="13" font-weight="700" style="fill: var(--viz-c5)">Bob's tx</text>
<rect x="125" y="106" width="260" height="46" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<text x="190" y="134" font-size="13" font-weight="700" text-anchor="middle">2 on call</text>
<text x="320" y="134" font-size="13" font-weight="700" text-anchor="middle">still 2 on call</text>
<rect x="130" y="34" width="120" height="46" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="190" y="53" font-size="13" font-weight="700" text-anchor="middle">sees 2 on call</text>
<text x="190" y="70" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">so OK to leave</text>
<rect x="260" y="34" width="120" height="46" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="320" y="53" font-size="13" font-weight="700" text-anchor="middle">UPDATE own row</text>
<text x="320" y="70" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Alice: off call</text>
<rect x="390" y="34" width="120" height="46" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="450" y="62" font-size="13" font-weight="700" text-anchor="middle">COMMIT</text>
<rect x="130" y="174" width="120" height="46" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="190" y="193" font-size="13" font-weight="700" text-anchor="middle">sees 2 on call</text>
<text x="190" y="210" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">so OK to leave</text>
<rect x="260" y="174" width="120" height="46" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="320" y="193" font-size="13" font-weight="700" text-anchor="middle">UPDATE own row</text>
<text x="320" y="210" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Bob: off call</text>
<rect x="390" y="174" width="120" height="46" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="450" y="202" font-size="13" font-weight="700" text-anchor="middle">COMMIT</text>
<line x1="190" y1="106" x2="190" y2="84" style="stroke: var(--viz-c6)" stroke-width="2" marker-end="url(#c7ws-w-c6)"/>
<line x1="190" y1="152" x2="190" y2="170" style="stroke: var(--viz-c5)" stroke-width="2" marker-end="url(#c7ws-w-c5)"/>
<line x1="320" y1="80" x2="320" y2="102" style="stroke: var(--viz-c6)" stroke-width="2" marker-end="url(#c7ws-w-c6)"/>
<line x1="320" y1="174" x2="320" y2="156" style="stroke: var(--viz-c5)" stroke-width="2" marker-end="url(#c7ws-w-c5)"/>
<text x="328" y="97" font-size="12" style="fill: var(--viz-c6)">row Alice</text>
<text x="328" y="168" font-size="12" style="fill: var(--viz-c5)">row Bob</text>
<rect x="530" y="98" width="100" height="62" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)" stroke-width="2"/>
<text x="580" y="124" font-size="14" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">on call: 0</text>
<text x="580" y="143" font-size="12" text-anchor="middle">rule broken</text>
<path d="M510,57 C522,57 522,104 528,108" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.5" marker-end="url(#c7ws-w-mu)"/>
<path d="M510,197 C522,197 522,154 528,150" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.5" marker-end="url(#c7ws-w-mu)"/>
<line x1="125" y1="238" x2="500" y2="238" style="stroke: var(--viz-muted)" stroke-width="1.5" marker-end="url(#c7ws-w-mu)"/>
<text x="510" y="242" font-size="12" style="fill: var(--viz-muted)">time</text>
</svg><svg class="c7d2-n" viewBox="0 0 360 300" role="img" aria-label="Alice and Bob each read 2 doctors on call, each update their own row, both commit, and 0 doctors remain on call">
<defs>
<marker id="c7ws-n-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
<marker id="c7ws-n-c5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c5)"/></marker>
<marker id="c7ws-n-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="61" y="20" font-size="13" font-weight="700" text-anchor="middle" style="fill: var(--viz-c6)">Alice's tx</text>
<text x="180" y="20" font-size="13" font-weight="700" text-anchor="middle">Database</text>
<text x="299" y="20" font-size="13" font-weight="700" text-anchor="middle" style="fill: var(--viz-c5)">Bob's tx</text>
<rect x="140" y="34" width="80" height="112" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<text x="180" y="62" font-size="13" font-weight="700" text-anchor="middle">2 on call</text>
<text x="180" y="128" font-size="13" font-weight="700" text-anchor="middle">still 2</text>
<rect x="10" y="34" width="102" height="46" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="61" y="53" font-size="13" font-weight="700" text-anchor="middle">sees 2</text>
<text x="61" y="70" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">OK to leave</text>
<rect x="10" y="100" width="102" height="46" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="61" y="119" font-size="13" font-weight="700" text-anchor="middle">UPDATE</text>
<text x="61" y="136" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">row Alice: off</text>
<rect x="10" y="166" width="102" height="34" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="61" y="188" font-size="13" font-weight="700" text-anchor="middle">COMMIT</text>
<rect x="248" y="34" width="102" height="46" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="299" y="53" font-size="13" font-weight="700" text-anchor="middle">sees 2</text>
<text x="299" y="70" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">OK to leave</text>
<rect x="248" y="100" width="102" height="46" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="299" y="119" font-size="13" font-weight="700" text-anchor="middle">UPDATE</text>
<text x="299" y="136" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">row Bob: off</text>
<rect x="248" y="166" width="102" height="34" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="299" y="188" font-size="13" font-weight="700" text-anchor="middle">COMMIT</text>
<line x1="140" y1="57" x2="116" y2="57" style="stroke: var(--viz-c6)" stroke-width="2" marker-end="url(#c7ws-n-c6)"/>
<line x1="220" y1="57" x2="244" y2="57" style="stroke: var(--viz-c5)" stroke-width="2" marker-end="url(#c7ws-n-c5)"/>
<line x1="112" y1="123" x2="136" y2="123" style="stroke: var(--viz-c6)" stroke-width="2" marker-end="url(#c7ws-n-c6)"/>
<line x1="248" y1="123" x2="224" y2="123" style="stroke: var(--viz-c5)" stroke-width="2" marker-end="url(#c7ws-n-c5)"/>
<rect x="110" y="232" width="140" height="56" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)" stroke-width="2"/>
<text x="180" y="256" font-size="14" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">on call: 0</text>
<text x="180" y="275" font-size="12" text-anchor="middle">rule broken</text>
<path d="M61,200 L61,260 L106,260" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.5" marker-end="url(#c7ws-n-mu)"/>
<path d="M299,200 L299,260 L254,260" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.5" marker-end="url(#c7ws-n-mu)"/>
<text x="180" y="218" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">time flows down</text>
</svg>`,
          caption: "No row was written twice, so nothing conflicted: no dirty write, no lost update, and snapshot isolation commits both.",
        },
        {
          type: "text",
          html: `<h3>What makes it write skew</h3>
<p>Two transactions read the same objects, then each updates some of them, possibly different ones. Had they updated the same object, you would get a dirty write or a lost update instead; write skew is the lost update <strong>generalized to several objects</strong>. That's why the previous section's fixes miss it. Single-object atomic operations don't apply. Snapshot isolation as PostgreSQL REPEATABLE READ, MySQL REPEATABLE READ, Oracle SERIALIZABLE and SQL Server SNAPSHOT implement it doesn't catch it either: where those levels detect lost updates at all, they look for two writes to the same row, and these writes touch different rows. Catching write skew takes true serializable isolation. A constraint would be ideal, but few databases can declare one that spans several rows (triggers or materialized views can sometimes emulate it).</p>
<p>Short of serializability, lock the rows the decision depends on: <code>SELECT * FROM doctors WHERE on_call = true AND shift_id = 1234 FOR UPDATE</code>, then count them in the app, because PostgreSQL rejects FOR UPDATE combined with an aggregate such as <code>COUNT(*)</code>. At read committed, Bob's SELECT now waits for Alice, re-reads the newest rows, finds one doctor, and he stays; at PostgreSQL's REPEATABLE READ it fails with a serialization error instead, and his retry reaches the same answer. Step through it below (the viz runs at read committed), then switch to room booking and watch the same trick fail.</p>`,
        },
        {
          type: "viz",
          id: "ch7/write-skew",
          title: "Write skew: doctors and double bookings",
          caption: "Try On-call doctors with No locks, then FOR UPDATE. Then switch to Room booking and play FOR UPDATE, Slot rows and EXCLUDE in turn. Notice that FOR UPDATE rescues the doctors but not the booking: when the check finds no rows, there is nothing to lock.",
        },
        {
          type: "text",
          html: `<p>The booking failure is the deeper lesson, and the same shape turns up everywhere:</p>
<ul>
<li><strong>Meeting rooms:</strong> check for an overlapping booking, insert if none. Snapshot isolation doesn't stop the double booking.</li>
<li><strong>Multiplayer games:</strong> a lock can stop two players moving the same piece, but not two players moving different pieces onto the same square.</li>
<li><strong>Usernames:</strong> check that a name is free, then insert. A UNIQUE constraint solves this one, because the second insert fails.</li>
<li><strong>Double spending:</strong> insert a tentative spend, then check the balance is still non-negative. Two concurrent spends each pass their own check.</li>
</ul>
<p>All of them follow the three steps in the diagram below. The order can vary (some flows write first and check afterwards), but the dependency is the same: a concurrent write changes what step 1 would return, so step 2's decision rests on a premise that is false by the time the transaction commits.</p>`,
        },
        {
          type: "diagram",
          title: "Check, decide, write: the premise loop",
          svg: `<style>.dd-diagram-body svg.c7d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c7d2-w{display:none}.dd-diagram-body svg.c7d2-n{display:block}}</style><svg class="c7d2-w" viewBox="0 0 640 238" role="img" aria-label="A transaction checks a rule, decides, and writes; a concurrent transaction's committed write changes the answer to the check">
<defs>
<marker id="c7pl-w-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
<marker id="c7pl-w-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
</defs>
<text x="20" y="18" font-size="12" style="fill: var(--viz-muted)">Your transaction</text>
<rect x="20" y="26" width="195" height="54" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="117" y="48" font-size="14" font-weight="700" text-anchor="middle">1. Check</text>
<text x="117" y="68" font-size="12" text-anchor="middle">SELECT: is the rule met?</text>
<rect x="245" y="26" width="150" height="54" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="320" y="48" font-size="14" font-weight="700" text-anchor="middle">2. Decide</text>
<text x="320" y="68" font-size="12" text-anchor="middle">app: OK, go ahead</text>
<rect x="425" y="26" width="195" height="54" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="522" y="48" font-size="14" font-weight="700" text-anchor="middle">3. Write</text>
<text x="522" y="68" font-size="12" text-anchor="middle">INSERT / UPDATE / DELETE</text>
<line x1="215" y1="53" x2="241" y2="53" style="stroke: var(--viz-muted)" stroke-width="2" marker-end="url(#c7pl-w-mu)"/>
<line x1="395" y1="53" x2="421" y2="53" style="stroke: var(--viz-muted)" stroke-width="2" marker-end="url(#c7pl-w-mu)"/>
<text x="380" y="126" font-size="12" style="fill: var(--viz-muted)">A concurrent transaction</text>
<rect x="380" y="134" width="240" height="54" rx="10" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="500" y="156" font-size="14" font-weight="700" text-anchor="middle">3. Write, then commit</text>
<text x="500" y="176" font-size="12" text-anchor="middle">a row that matches step 1's query</text>
<path d="M380,161 C260,161 117,150 117,86" style="fill: none; stroke: var(--viz-bad)" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#c7pl-w-bad)"/>
<text x="250" y="190" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">changes the answer to step 1</text>
<text x="20" y="214" font-size="12" style="fill: var(--viz-ok)">Step 1 found rows? Lock them (FOR UPDATE).</text>
<text x="20" y="231" font-size="12" style="fill: var(--viz-bad)">Step 1 looked for absent rows? A phantom: nothing to lock.</text>
</svg><svg class="c7d2-n" viewBox="0 0 360 372" role="img" aria-label="A transaction checks a rule, decides, and writes; a concurrent transaction's committed write changes the answer to the check">
<defs>
<marker id="c7pl-n-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
<marker id="c7pl-n-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
</defs>
<text x="12" y="16" font-size="12" style="fill: var(--viz-muted)">Your transaction</text>
<rect x="12" y="24" width="200" height="48" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="112" y="44" font-size="14" font-weight="700" text-anchor="middle">1. Check</text>
<text x="112" y="62" font-size="12" text-anchor="middle">SELECT: is the rule met?</text>
<line x1="112" y1="72" x2="112" y2="92" style="stroke: var(--viz-muted)" stroke-width="2" marker-end="url(#c7pl-n-mu)"/>
<rect x="12" y="96" width="200" height="48" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="112" y="116" font-size="14" font-weight="700" text-anchor="middle">2. Decide</text>
<text x="112" y="134" font-size="12" text-anchor="middle">app: OK, go ahead</text>
<line x1="112" y1="144" x2="112" y2="164" style="stroke: var(--viz-muted)" stroke-width="2" marker-end="url(#c7pl-n-mu)"/>
<rect x="12" y="168" width="200" height="48" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1.5"/>
<text x="112" y="188" font-size="14" font-weight="700" text-anchor="middle">3. Write</text>
<text x="112" y="206" font-size="12" text-anchor="middle">INSERT / UPDATE / DELETE</text>
<text x="12" y="252" font-size="12" style="fill: var(--viz-muted)">A concurrent transaction</text>
<rect x="12" y="260" width="200" height="48" rx="10" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)" stroke-width="1.5"/>
<text x="112" y="280" font-size="14" font-weight="700" text-anchor="middle">3. Write, commit</text>
<text x="112" y="298" font-size="12" text-anchor="middle">a row matching step 1</text>
<path d="M212,284 L262,284 L262,48 L218,48" style="fill: none; stroke: var(--viz-bad)" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#c7pl-n-bad)"/>
<text x="272" y="150" font-size="12" font-weight="700" style="fill: var(--viz-bad)">changes</text>
<text x="272" y="166" font-size="12" font-weight="700" style="fill: var(--viz-bad)">the answer</text>
<text x="272" y="182" font-size="12" font-weight="700" style="fill: var(--viz-bad)">to step 1</text>
<text x="12" y="340" font-size="12" style="fill: var(--viz-ok)">Rows found: lock them (FOR UPDATE).</text>
<text x="12" y="358" font-size="12" style="fill: var(--viz-bad)">Rows absent: a phantom, nothing to lock.</text>
</svg>`,
          caption: "Locking works only when step 1's answer is made of rows that already exist.",
        },
        {
          type: "text",
          html: `<h3>Phantoms: conflicts over rows that don't exist yet</h3>
<p>A <strong>phantom</strong> is a write in one transaction that changes the result of a search query in another. Snapshot isolation hides phantoms from read-only queries, since re-running a range scan in the same snapshot returns the same rows, but in a read-write transaction a phantom turns into write skew. The doctors case is the lucky one: step 1's rows exist and can be locked. In the booking, username and spending cases, step 1 looks for rows that are <em>absent</em>, so FOR UPDATE has nothing to attach to.</p>
<p>What happens next depends on the database, so always name it. PostgreSQL and Oracle lock nothing, and the phantom slips through. MySQL InnoDB at REPEATABLE READ or SERIALIZABLE takes next-key (gap) locks on the index range it scanned, which blocks the conflicting INSERT, often ending in a deadlock that aborts one of the bookings; that is index-range locking, covered in the two-phase locking section. At READ COMMITTED, InnoDB doesn't gap-lock searches.</p>
<h3>Materializing conflicts, and constraints</h3>
<p>If there's nothing to lock, create something. A <code>time_slots</code> table with one row per room per 15-minute slot for the next six months gives every booking a row to lock with FOR UPDATE before it checks and inserts (the viz's Slot rows setting uses one row per room and hour). The rows hold no data; they exist only as locks. This <strong>materializing of conflicts</strong> works, but it's fiddly and leaks concurrency control into the data model, so treat it as a last resort. It also relies on a fresh read once the lock is granted, which read committed provides. Under PostgreSQL REPEATABLE READ, a FOR UPDATE that had to wait raises no error, and the later check still reads the old snapshot, so the double booking can still happen; there, UPDATE the slot row (first-updater-wins then aborts the loser) or use SERIALIZABLE.</p>
<p>When the rule fits a constraint, prefer the constraint. UNIQUE covers usernames and discrete slots. PostgreSQL's exclusion constraints cover overlapping ranges: <code>EXCLUDE USING gist (room_id WITH =, during WITH &amp;&amp;)</code> forbids two bookings of one room with overlapping times (the <code>btree_gist</code> extension supplies the equality part). CHECK constraints can't help, because they see one row at a time. When nothing fits, the general fix is serializable isolation, which the next three sections build in three different ways.</p>`,
        },
        {
          type: "compare",
          title: "Four ways to protect a check-then-write",
          items: [
            { title: "FOR UPDATE on the rows you read", tone: "warn", html: "Works when the check's rows exist, as with the doctors. For 'no rows match' checks it locks nothing in PostgreSQL and Oracle; InnoDB's gap locks block the insert at REPEATABLE READ, often via a deadlock. Every code path must remember it." },
            { title: "Materialized conflict", tone: "warn", html: "Pre-create rows (one per slot) and lock them first. Works in any SQL database, but clutters the schema, and under PostgreSQL REPEATABLE READ you must UPDATE the slot row, not just lock it." },
            { title: "UNIQUE or EXCLUDE constraint", tone: "ok", html: "The database refuses the second write whatever the timing, at every isolation level; a concurrent insert waits to see whether the first one commits. Only for rules a constraint can express." },
            { title: "SERIALIZABLE", tone: "info", html: "Catches every variant, including the ones nobody anticipated. Costs waits (2PL) or aborts (SSI), and the app must retry whole transactions." },
          ],
        },
        {
          type: "realworld",
          items: [
            { org: "ACIDRain", year: "2017", tag: "SIGMOD paper", html: "Warszawski and Bailis analyzed 12 popular self-hosted e-commerce applications and found 22 concurrency attacks, such as overspending gift cards, that work by firing concurrent requests at check-then-act code running under the databases' default weak isolation." },
            { org: "Ruby on Rails", year: "2015", tag: "Feral Concurrency Control", html: "Bailis et al. showed that application-level checks such as <code>validates_uniqueness_of</code> are check-then-insert races that let duplicates through under concurrent requests. A database UNIQUE constraint is the reliable fix." },
            { org: "PostgreSQL", tag: "exclusion constraints", html: "Added in 9.0 and combined with range types since 9.2, <code>EXCLUDE USING gist (room_id WITH =, during WITH &amp;&amp;)</code> turns the double-booking phantom into a constraint violation the database enforces itself." },
            { org: "Oracle", tag: "SERIALIZABLE = SI", html: "Oracle's SERIALIZABLE level is snapshot isolation and permits write skew. Fekete et al.'s 'Making Snapshot Isolation Serializable' (2005) studied exactly which application patterns are unsafe under it." },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Design a booking system that never double-books\"",
          html: `<p>Start from the invariant, not the code: no two confirmed bookings for one room may overlap. Then choose the strongest mechanism that can express it: an <strong>exclusion constraint</strong> on (room, time range) in PostgreSQL, or a UNIQUE key on (room, slot) if slots are discrete, so the database refuses the second booking at any isolation level. Explain why check-then-insert under snapshot isolation fails (write skew through a phantom) and why FOR UPDATE on the check doesn't help (no rows to lock). If no constraint fits, lock materialized slot rows or run the booking at SERIALIZABLE with a retry loop. Bonus points: short-lived holds with an expiry for the checkout flow, and an idempotency key so a retried request can't book twice.</p>`,
        },
        {
          type: "quiz",
          q: "A sign-up flow runs <code>SELECT ... WHERE username = 'kai'</code> and INSERTs if nothing is found. Under snapshot isolation, two sign-ups for 'kai' race. What is the simplest robust fix?",
          options: [
            "Add FOR UPDATE to the SELECT",
            "Add a UNIQUE constraint on username and treat the violation as 'name taken'",
            "Retry the transaction if it fails",
            "Lower the isolation level to read committed",
          ],
          answer: 1,
          explain: "The SELECT finds no row, so in PostgreSQL or Oracle FOR UPDATE has nothing to lock: it's a phantom (InnoDB's gap locks would block it, typically by deadlocking). Retrying is pointless because nothing fails: both transactions commit. Read committed is weaker still. A UNIQUE constraint makes the database itself reject the second insert, whatever the timing and whatever the isolation level.",
        },
      ],
    },

    // ------------------------------------------------------------------ 8
    {
      id: "serial-execution",
      title: "Actual serial execution: serializable by doing one thing at a time",
      kicker: "Serializability, approach 1",
      concepts: ["serializable-isolation", "actual-serial-execution", "stored-procedures"],
      blocks: [
        {
          type: "problem",
          title: "A patchwork of fixes, each one forgettable",
          html: `<p>Look at the fixes so far: an atomic UPDATE here, FOR UPDATE there, a constraint, a table of slot rows that exist only to be locked. Each works only if every code path remembers it, and because races depend on timing, no test suite will tell you when one forgets. Serializable isolation would delete the whole category at once. The most literal way to get it is to run transactions <strong>one at a time, on one thread</strong>.</p>
<p>For decades that was dismissed out of hand. With data on spinning disks, a transaction waiting milliseconds for a random read (or seconds for a user to click) would leave the only thread idle while every other transaction queued behind it. Around 2007 that assumption stopped holding for a large class of workloads.</p>`,
        },
        {
          type: "idea",
          html: `<p>If transactions are short, the active data fits in memory, and each transaction arrives whole as a <strong>stored procedure</strong>, then one thread executing them in sequence is serializable by construction, and with no locks to manage it can outrun a concurrent engine.</p>`,
        },
        {
          type: "text",
          html: `<h3>Serializable isolation, defined</h3>
<p><strong>Serializable isolation</strong> guarantees that running transactions concurrently has the same result as running them one at a time in <em>some</em> serial order. Any order will do; it needn't be the order in which they started (real-time ordering is linearizability, Chapter 9). Since no anomaly in this chapter can occur in a serial execution, serializability rules out all of them, and the database, not the application, carries the burden. There are three families of implementation: literally running transactions one at a time (this section), two-phase locking, and serializable snapshot isolation.</p>
<h3>Why one thread became a serious option</h3>
<p>Two things changed. RAM became cheap enough to keep many applications' entire active dataset in memory, so a transaction never waits for a disk. And designers took seriously that OLTP transactions are usually short and touch a handful of rows, while long analytic reads can run on a consistent snapshot outside the serial loop. VoltDB (descended from the H-Store research prototype), Redis and Datomic all execute transactions serially. A single thread skips lock and latch coordination entirely, and that overhead is large: the 2008 study <em>OLTP Through the Looking Glass</em> found that most of a traditional engine's instructions went to buffer management, latching, locking and logging rather than useful work. The ceiling is one CPU core per partition.</p>
<h3>No room for conversations</h3>
<p>The catch is the shape of transactions. A flight booking (search, choose a seat, pay) can't be one transaction, because a transaction must never wait for a human. Even without a human, an <strong>interactive transaction</strong>, where the app sends a statement, reads the result, thinks and sends another, spends most of its life waiting on the network. A concurrent database fills that time with other transactions. A single-threaded one can't, so it requires the whole transaction up front as a stored procedure that runs start to finish without pausing.</p>`,
        },
        {
          type: "diagram",
          title: "Interactive transaction vs stored procedure on a single thread",
          svg: `<style>.dd-diagram-body svg.c7d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c7d2-w{display:none}.dd-diagram-body svg.c7d2-n{display:block}}</style><svg class="c7d2-w" viewBox="0 0 640 262" role="img" aria-label="An interactive transaction makes four round trips and leaves the database thread idle between them; a stored procedure is one call that keeps the thread busy, after which the next transaction runs">
<defs>
<marker id="c7sp-w-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
</defs>
<rect x="8" y="8" width="306" height="212" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<rect x="326" y="8" width="306" height="212" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<text x="20" y="30" font-size="14" font-weight="700">Interactive transaction</text>
<text x="338" y="30" font-size="14" font-weight="700">Stored procedure</text>
<text x="20" y="75" font-size="13" font-weight="700" style="fill: var(--viz-c6)">App</text>
<text x="20" y="168" font-size="13" font-weight="700">DB</text>
<text x="20" y="183" font-size="12" style="fill: var(--viz-muted)">1 thread</text>
<line x1="80" y1="70" x2="305" y2="70" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="80" y1="170" x2="305" y2="170" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="124" y="162" width="78" height="16" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="1" stroke-dasharray="4 3"/>
<rect x="214" y="162" width="58" height="16" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="1" stroke-dasharray="4 3"/>
<rect x="112" y="161" width="12" height="18" style="fill: var(--viz-ok)"/>
<rect x="202" y="161" width="12" height="18" style="fill: var(--viz-ok)"/>
<rect x="272" y="161" width="10" height="18" style="fill: var(--viz-ok)"/>
<rect x="148" y="63" width="30" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1"/>
<line x1="88" y1="70" x2="110" y2="159" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<line x1="124" y1="170" x2="146" y2="81" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<line x1="178" y1="70" x2="200" y2="159" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<line x1="214" y1="170" x2="236" y2="81" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<line x1="248" y1="70" x2="270" y2="159" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<line x1="282" y1="170" x2="300" y2="81" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<text x="88" y="60" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">SELECT</text>
<text x="182" y="60" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">UPDATE</text>
<text x="252" y="60" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">COMMIT</text>
<text x="196" y="200" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-warn)">idle, but nobody else can run</text>
<text x="338" y="75" font-size="13" font-weight="700" style="fill: var(--viz-c6)">App</text>
<text x="338" y="168" font-size="13" font-weight="700">DB</text>
<text x="338" y="183" font-size="12" style="fill: var(--viz-muted)">1 thread</text>
<line x1="398" y1="70" x2="623" y2="70" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="398" y1="170" x2="623" y2="170" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="434" y="161" width="38" height="18" style="fill: var(--viz-ok)"/>
<rect x="476" y="161" width="24" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<rect x="504" y="161" width="30" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<rect x="538" y="161" width="22" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<rect x="564" y="161" width="28" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<line x1="410" y1="70" x2="432" y2="159" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<line x1="472" y1="170" x2="494" y2="81" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-w-c6)"/>
<text x="400" y="60" font-size="12" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">CALL book_seat(...)</text>
<text x="398" y="200" font-size="12" font-weight="700" style="fill: var(--viz-ok)">one call, runs start to finish</text>
<text x="398" y="214" font-size="12" style="fill: var(--viz-muted)">then the next transaction runs</text>
<rect x="12" y="236" width="12" height="12" style="fill: var(--viz-ok)"/>
<text x="30" y="246" font-size="12">thread busy with this tx</text>
<rect x="196" y="236" width="12" height="12" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="1" stroke-dasharray="3 2"/>
<text x="214" y="246" font-size="12">thread idle, waiting on the app</text>
<rect x="420" y="236" width="12" height="12" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<text x="438" y="246" font-size="12">other transactions</text>
</svg><svg class="c7d2-n" viewBox="0 0 360 440" role="img" aria-label="An interactive transaction makes four round trips and leaves the database thread idle between them; a stored procedure is one call that keeps the thread busy, after which the next transaction runs">
<defs>
<marker id="c7sp-n-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
</defs>
<rect x="6" y="4" width="348" height="186" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<rect x="6" y="200" width="348" height="186" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<text x="16" y="26" font-size="14" font-weight="700">Interactive transaction</text>
<text x="16" y="66" font-size="13" font-weight="700" style="fill: var(--viz-c6)">App</text>
<text x="16" y="146" font-size="13" font-weight="700">DB</text>
<text x="16" y="161" font-size="12" style="fill: var(--viz-muted)">1 thread</text>
<line x1="70" y1="62" x2="345" y2="62" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="70" y1="146" x2="345" y2="146" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="123" y="138" width="93" height="16" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="1" stroke-dasharray="4 3"/>
<rect x="231" y="138" width="69" height="16" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="1" stroke-dasharray="4 3"/>
<rect x="108" y="137" width="15" height="18" style="fill: var(--viz-ok)"/>
<rect x="216" y="137" width="15" height="18" style="fill: var(--viz-ok)"/>
<rect x="300" y="137" width="12" height="18" style="fill: var(--viz-ok)"/>
<rect x="152" y="55" width="36" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)" stroke-width="1"/>
<line x1="80" y1="62" x2="106" y2="135" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<line x1="123" y1="146" x2="150" y2="73" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<line x1="188" y1="62" x2="214" y2="135" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<line x1="231" y1="146" x2="258" y2="73" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<line x1="272" y1="62" x2="298" y2="135" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<line x1="312" y1="146" x2="334" y2="73" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<text x="84" y="50" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">SELECT</text>
<text x="180" y="50" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">UPDATE</text>
<text x="276" y="50" font-size="12" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">COMMIT</text>
<text x="208" y="176" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-warn)">idle, but nobody else can run</text>
<text x="16" y="222" font-size="14" font-weight="700">Stored procedure</text>
<text x="16" y="262" font-size="13" font-weight="700" style="fill: var(--viz-c6)">App</text>
<text x="16" y="342" font-size="13" font-weight="700">DB</text>
<text x="16" y="357" font-size="12" style="fill: var(--viz-muted)">1 thread</text>
<line x1="70" y1="258" x2="345" y2="258" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="70" y1="342" x2="345" y2="342" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="108" y="333" width="44" height="18" style="fill: var(--viz-ok)"/>
<rect x="157" y="333" width="28" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<rect x="190" y="333" width="34" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<rect x="229" y="333" width="26" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<rect x="260" y="333" width="32" height="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<line x1="80" y1="258" x2="106" y2="331" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<line x1="152" y1="342" x2="178" y2="269" style="stroke: var(--viz-c6)" stroke-width="1.6" marker-end="url(#c7sp-n-c6)"/>
<text x="70" y="246" font-size="12" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">CALL book_seat(...)</text>
<text x="70" y="367" font-size="12" font-weight="700" style="fill: var(--viz-ok)">one call, runs start to finish</text>
<text x="70" y="381" font-size="12" style="fill: var(--viz-muted)">then the next transaction runs</text>
<rect x="10" y="402" width="12" height="12" style="fill: var(--viz-ok)"/>
<text x="28" y="412" font-size="12">this tx</text>
<rect x="90" y="402" width="12" height="12" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="1" stroke-dasharray="3 2"/>
<text x="108" y="412" font-size="12">idle, waiting</text>
<rect x="210" y="402" width="12" height="12" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)" stroke-width="1"/>
<text x="228" y="412" font-size="12">other txs</text>
</svg>`,
          caption: "A single-threaded engine can't afford to wait on the network inside a transaction, so the whole transaction is shipped as one call.",
        },
        {
          type: "text",
          html: `<h3>Stored procedures, rehabilitated</h3>
<p>Stored procedures earned their poor reputation. Each vendor had its own dated language (Oracle's PL/SQL, SQL Server's T-SQL, PostgreSQL's PL/pgSQL). Code inside the database is harder to version, deploy, debug, test and monitor. And the database is shared and performance-critical, so one badly written procedure hurts every application using it. Modern serial engines fix at least the language problem: VoltDB uses Java, Datomic Java or Clojure, and Redis Lua.</p>
<p>Procedures also simplify replication. Instead of shipping row changes, VoltDB executes the same stored procedure on every replica. That works only if procedures are <strong>deterministic</strong>, producing the same writes everywhere, which is why VoltDB offers special APIs for things like the current time: Chapter 5's statement-based replication problem, solved by construction.</p>
<h3>Scaling past one core: partitions</h3>
<p>To go beyond one core, partition the data (Chapter 6) so that each transaction touches a single partition, and give each partition its own thread. Throughput then grows with the number of cores. A transaction that spans partitions must be coordinated across all of them, and that is the cliff: VoltDB reported about 1,000 cross-partition writes per second, orders of magnitude below its single-partition throughput, and adding machines doesn't raise it. Simple key-value data partitions cleanly; data with secondary indexes tends to force cross-partition work, because an index entry rarely lives next to its row.</p>`,
        },
        {
          type: "diagram",
          title: "Partitioned serial execution",
          svg: `<style>.dd-diagram-body svg.c7d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c7d2-w{display:none}.dd-diagram-body svg.c7d2-n{display:block}}</style><svg class="c7d2-w" viewBox="0 0 640 228" role="img" aria-label="Four partitions, each with its own thread running single-partition transactions; one transaction spans partitions 2 and 3, so both threads stall while it coordinates">
<text x="14" y="18" font-size="12" style="fill: var(--viz-muted)">Each thread runs its own queue, top to bottom</text>
<rect x="14" y="28" width="144" height="168" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="170" y="28" width="144" height="168" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="326" y="28" width="144" height="168" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="482" y="28" width="144" height="168" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<text x="86" y="50" font-size="13" font-weight="700" text-anchor="middle">Partition 1</text>
<text x="242" y="50" font-size="13" font-weight="700" text-anchor="middle">Partition 2</text>
<text x="398" y="50" font-size="13" font-weight="700" text-anchor="middle">Partition 3</text>
<text x="554" y="50" font-size="13" font-weight="700" text-anchor="middle">Partition 4</text>
<text x="86" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">own thread</text>
<text x="242" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">own thread</text>
<text x="398" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">own thread</text>
<text x="554" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">own thread</text>
<rect x="28" y="78" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="28" y="112" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="28" y="146" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="184" y="78" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="340" y="78" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="496" y="78" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="496" y="112" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="496" y="146" width="116" height="26" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="184" y="112" width="272" height="26" rx="6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="2"/>
<rect x="184" y="146" width="116" height="26" rx="6" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.2" stroke-dasharray="4 3"/>
<rect x="340" y="146" width="116" height="26" rx="6" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="86" y="95" font-size="12" text-anchor="middle">tx 1</text>
<text x="86" y="129" font-size="12" text-anchor="middle">tx 5</text>
<text x="86" y="163" font-size="12" text-anchor="middle">tx 9</text>
<text x="242" y="95" font-size="12" text-anchor="middle">tx 2</text>
<text x="398" y="95" font-size="12" text-anchor="middle">tx 3</text>
<text x="554" y="95" font-size="12" text-anchor="middle">tx 4</text>
<text x="554" y="129" font-size="12" text-anchor="middle">tx 8</text>
<text x="554" y="163" font-size="12" text-anchor="middle">tx 12</text>
<text x="320" y="129" font-size="12" font-weight="700" text-anchor="middle">cross-partition tx: P2 + P3</text>
<text x="242" y="163" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">waiting</text>
<text x="398" y="163" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">waiting</text>
<text x="320" y="218" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-warn)">both threads stall while they coordinate</text>
</svg><svg class="c7d2-n" viewBox="0 0 360 200" role="img" aria-label="Four partitions, each with its own thread running single-partition transactions; one transaction spans partitions 2 and 3, so both threads stall while it coordinates">
<text x="8" y="16" font-size="12" style="fill: var(--viz-muted)">Each thread runs its queue in order</text>
<rect x="8" y="26" width="83" height="146" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="95" y="26" width="83" height="146" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="182" y="26" width="83" height="146" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<rect x="269" y="26" width="83" height="146" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1.5"/>
<text x="49" y="46" font-size="13" font-weight="700" text-anchor="middle">P1</text>
<text x="136" y="46" font-size="13" font-weight="700" text-anchor="middle">P2</text>
<text x="223" y="46" font-size="13" font-weight="700" text-anchor="middle">P3</text>
<text x="310" y="46" font-size="13" font-weight="700" text-anchor="middle">P4</text>
<text x="49" y="62" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">1 thread</text>
<text x="136" y="62" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">1 thread</text>
<text x="223" y="62" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">1 thread</text>
<text x="310" y="62" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">1 thread</text>
<rect x="16" y="74" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="16" y="106" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="16" y="138" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="103" y="74" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="190" y="74" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="277" y="74" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="277" y="106" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="277" y="138" width="67" height="24" rx="5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)" stroke-width="1.5"/>
<rect x="103" y="106" width="154" height="24" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)" stroke-width="2"/>
<rect x="103" y="138" width="67" height="24" rx="5" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.2" stroke-dasharray="4 3"/>
<rect x="190" y="138" width="67" height="24" rx="5" style="fill: none; stroke: var(--viz-muted)" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="49" y="90" font-size="12" text-anchor="middle">tx 1</text>
<text x="49" y="122" font-size="12" text-anchor="middle">tx 5</text>
<text x="49" y="154" font-size="12" text-anchor="middle">tx 9</text>
<text x="136" y="90" font-size="12" text-anchor="middle">tx 2</text>
<text x="223" y="90" font-size="12" text-anchor="middle">tx 3</text>
<text x="310" y="90" font-size="12" text-anchor="middle">tx 4</text>
<text x="310" y="122" font-size="12" text-anchor="middle">tx 8</text>
<text x="310" y="154" font-size="12" text-anchor="middle">tx 12</text>
<text x="180" y="122" font-size="12" font-weight="700" text-anchor="middle">cross-partition</text>
<text x="136" y="154" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">waits</text>
<text x="223" y="154" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">waits</text>
<text x="180" y="192" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-warn)">both threads stall to coordinate</text>
</svg>`,
          caption: "Throughput scales with partitions only while transactions stay inside one partition.",
        },
        {
          type: "keypoints",
          title: "When serial execution works: four constraints",
          items: [
            "<strong>Every transaction is small and fast.</strong> One slow transaction stalls everything behind it.",
            "<strong>The active dataset fits in memory.</strong> Rarely touched data can live on disk, but a transaction that needs it would stall the thread, so the system can abort it, load the data asynchronously, and restart it (<em>anti-caching</em>).",
            "<strong>Write throughput fits on one core</strong>, or the data partitions so that transactions need no cross-partition coordination.",
            "<strong>Cross-partition transactions are possible but rare.</strong> They run far slower and don't scale with machines.",
          ],
        },
        {
          type: "realworld",
          items: [
            { org: "H-Store / VoltDB", year: "2007", tag: "in-memory OLTP", html: "Stonebraker et al.'s <em>The End of an Architectural Era</em> argued for in-memory, single-threaded, partitioned engines. VoltDB, H-Store's commercial descendant, runs each transaction as a Java stored procedure on the thread that owns its partition." },
            { org: "Redis", tag: "single thread", html: "Commands run on one thread. MULTI/EXEC and Lua scripts never interleave with other clients, but Redis documents that it doesn't roll back when a queued command fails, and a long script blocks every other client." },
            { org: "LMAX", year: "2011", tag: "exchange", html: "Martin Fowler's write-up describes a business-logic processor on a single thread, entirely in memory, handling about 6 million orders per second, with input events journaled for recovery." },
            { org: "Datomic", tag: "single transactor", html: "All writes go through one transactor process that applies transactions serially, while peers serve reads from immutable database values." },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "The single-writer idea keeps coming back",
          html: `<p><strong>TigerBeetle</strong>, a database for financial accounting, deliberately executes transactions on a single core in large batches, arguing that contention on hot accounts makes multi-core concurrency control a poor trade for that workload. <strong>Calvin-style deterministic databases</strong> (Thomson et al., 2012) first agree on a global order of transactions and then execute them deterministically on every replica, which removes most coordination at execution time. And LMAX-style single-threaded event processing remains a common pattern in trading systems.</p>`,
        },
        {
          type: "tradeoffs",
          pros: [
            "Serializable by construction: no locks, no deadlocks, no anomalies to reason about",
            "No lock or latch overhead, so one in-memory thread can beat a concurrent engine",
            "Deterministic procedures make replication and replay simple",
          ],
          cons: [
            "Throughput is capped at one core per partition",
            "Transactions must be short, in memory, and submitted whole as stored procedures",
            "One slow transaction or script stalls every other client",
            "Cross-partition transactions are a cliff that more machines can't fix",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Why is single-threaded Redis fast, and when does it hurt?\"",
          html: `<p>Fast because the data is in memory, a command takes microseconds, and with one thread there are no locks or context switches; an event loop multiplexes thousands of connections. Redis 6 added I/O threads for network reads and writes, but commands still execute on one thread. It hurts whenever one command is slow: <code>KEYS *</code> on a large keyspace, a big set operation, or a long Lua script (or Redis 7 Function) blocks every client for its duration, which is effectively an outage. It also caps a node at one core, so you scale by sharding (Redis Cluster). A strong answer adds that MULTI/EXEC gives isolation but not rollback, and that WATCH turns it into optimistic check-and-set: EXEC fails if a watched key changed.</p>`,
        },
        {
          type: "quiz",
          q: "Why do serial-execution databases such as VoltDB require each transaction to be submitted as a stored procedure?",
          options: [
            "SQL can't be executed on a single thread",
            "An interactive transaction would hold the only execution thread while waiting for network round trips and application logic, stalling every other transaction",
            "Stored procedures are required for durability",
            "Stored procedures are parsed faster than ad hoc SQL",
          ],
          answer: 1,
          explain: "With one thread, any time spent waiting inside a transaction is time nobody else can use. Shipping the whole transaction as one procedure means it runs start to finish with no waits. Faster parsing is a minor side effect, not the reason, and durability comes from the log, not from procedures.",
        },
      ],
    },

    // ------------------------------------------------------------------ 9
    {
      id: "two-phase-locking",
      title: "Two-phase locking: readers and writers block each other",
      kicker: "Serializability, approach 2",
      concepts: ["two-phase-locking", "predicate-locks-index-range-locks", "deadlock"],
      blocks: [
        {
          type: "problem",
          title: "Readers that don't lock can't protect their premises",
          html: `<p>Serial execution needs tiny transactions over in-memory data. A general-purpose database, with terabytes on disk and interactive transactions waiting on the network, must keep many transactions in flight and still wants serializability. Look back at every anomaly so far: a transaction read something, and a concurrent transaction changed it before the first finished acting on what it read. <strong>Readers took no locks</strong>, so nothing stopped that.</p>
<p>The oldest answer, and for about 30 years the standard one, is to make reads lock too, and to make those locks cover rows that don't exist yet. The price is paid in waiting, unstable tail latency and deadlocks.</p>`,
        },
        {
          type: "idea",
          html: `<p>Under 2PL a read takes a <strong>shared</strong> lock and a write an <strong>exclusive</strong> lock, every lock is held until the transaction ends, and to stop phantoms the locks must cover <strong>search conditions</strong> (predicate or index-range locks), not just existing rows.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "2PL is not 2PC",
          html: `<p>Two-phase <strong>locking</strong> is concurrency control inside one database: it decides which transaction waits for which. Two-phase <strong>commit</strong> (<a href="#/ch9/learn/two-phase-commit">Chapter 9</a>) is an atomic commit protocol across several nodes: it makes them all commit or all abort. The names are unfortunately similar and the ideas unrelated, though some systems, such as Spanner, use both.</p>`,
        },
        {
          type: "text",
          html: `<h3>The rules</h3>
<p>Under snapshot isolation, readers never block writers and writers never block readers. 2PL deliberately reverses that. Many transactions may read an object at once, but writing needs exclusive access:</p>
<ul>
<li>If A has <strong>read</strong> an object and B wants to <strong>write</strong> it, B waits until A commits or aborts, so B can't change A's premise behind its back.</li>
<li>If A has <strong>written</strong> an object and B wants to <strong>read</strong> it, B waits until A ends, so B never sees uncommitted data.</li>
</ul>
<p>Mechanically, every object has a lock held in <strong>shared (S)</strong> or <strong>exclusive (X)</strong> mode. A read needs S and waits while anyone holds X. A write needs X and waits while anyone holds any lock. A transaction that reads and then writes upgrades its S lock to X. All locks are held until commit or abort.</p>`,
        },
        {
          type: "table",
          title: "Lock compatibility",
          headers: ["Another transaction holds", "You request S (read)", "You request X (write)"],
          rows: [
            ["No lock", "<span class=\"hl-good\">granted</span>", "<span class=\"hl-good\">granted</span>"],
            ["S (shared)", "<span class=\"hl-good\">granted</span>: readers share", "<span class=\"hl-bad\">wait</span>"],
            ["X (exclusive)", "<span class=\"hl-bad\">wait</span>", "<span class=\"hl-bad\">wait</span>"],
          ],
          note: "Only S with S is compatible. Under snapshot isolation, plain reads take no lock at all, so neither reader-versus-writer wait (S held, X requested; X held, S requested) arises.",
        },
        {
          type: "text",
          html: `<h3>Why "two phases"</h3>
<p>A transaction acquires locks as it runs (the <em>growing</em> phase) and releases them at the end (the <em>shrinking</em> phase). The rule that actually guarantees serializability is narrower than "hold everything to the end": <strong>never acquire a lock after releasing one</strong>. Basic 2PL obeys only that rule and is already conflict-serializable, but if it releases a write lock before commit, others may read data that is later rolled back, and the abort cascades to them. Strict 2PL holds write locks to the end. What databases implement, and what DDIA describes, holds <em>every</em> lock until commit or abort (strong strict, or rigorous, 2PL).</p>`,
        },
        {
          type: "diagram",
          title: "Locks held over a transaction's life",
          svg: `<style>.dd-diagram-body svg.c7d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c7d2-w{display:none}.dd-diagram-body svg.c7d2-n{display:block}}</style><svg class="c7d2-w" viewBox="0 0 640 222" role="img" aria-label="Three lock-count curves over time: rigorous 2PL rises then drops to zero at commit; basic 2PL rises then steps down before commit; a non-two-phase transaction releases a lock and later acquires another">
<rect x="6" y="6" width="204" height="210" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<rect x="218" y="6" width="204" height="210" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<rect x="430" y="6" width="204" height="210" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<text x="18" y="28" font-size="13" font-weight="700">Rigorous 2PL</text>
<text x="18" y="44" font-size="12" style="fill: var(--viz-muted)">what databases implement</text>
<text x="230" y="28" font-size="13" font-weight="700">Basic 2PL</text>
<text x="230" y="44" font-size="12" style="fill: var(--viz-muted)">releases before commit</text>
<text x="442" y="28" font-size="13" font-weight="700">Not two-phase</text>
<text x="442" y="44" font-size="12" style="fill: var(--viz-muted)">release, then acquire</text>
<g>
<line x1="40" y1="64" x2="40" y2="150" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="40" y1="150" x2="200" y2="150" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="252" y1="64" x2="252" y2="150" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="252" y1="150" x2="412" y2="150" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="464" y1="64" x2="464" y2="150" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="464" y1="150" x2="624" y2="150" style="stroke: var(--viz-line)" stroke-width="1.5"/>
</g>
<text x="0" y="0" font-size="12" text-anchor="middle" transform="translate(28 108) rotate(-90)" style="fill: var(--viz-muted)">locks held</text>
<text x="0" y="0" font-size="12" text-anchor="middle" transform="translate(240 108) rotate(-90)" style="fill: var(--viz-muted)">locks held</text>
<text x="0" y="0" font-size="12" text-anchor="middle" transform="translate(452 108) rotate(-90)" style="fill: var(--viz-muted)">locks held</text>
<text x="200" y="166" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<text x="412" y="166" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<text x="624" y="166" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<line x1="170" y1="62" x2="170" y2="150" style="stroke: var(--viz-muted)" stroke-width="1" stroke-dasharray="3 3"/>
<line x1="382" y1="62" x2="382" y2="150" style="stroke: var(--viz-muted)" stroke-width="1" stroke-dasharray="3 3"/>
<line x1="594" y1="62" x2="594" y2="150" style="stroke: var(--viz-muted)" stroke-width="1" stroke-dasharray="3 3"/>
<text x="170" y="58" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">COMMIT</text>
<text x="382" y="58" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">COMMIT</text>
<text x="594" y="58" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">COMMIT</text>
<path d="M40,150 H60 V130 H85 V110 H110 V90 H135 V70 H170 V150 H200" style="fill: none; stroke: var(--viz-c1)" stroke-width="2.5"/>
<path d="M252,150 H272 V130 H297 V110 H322 V90 H342 V110 H357 V130 H370 V150 H412" style="fill: none; stroke: var(--viz-warn)" stroke-width="2.5"/>
<path d="M464,150 H484 V130 H509 V110 H529 V130 H554 V110 H574 V90 H594 V150 H624" style="fill: none; stroke: var(--viz-bad)" stroke-width="2.5" stroke-dasharray="6 4"/>
<circle cx="554" cy="120" r="7" style="fill: none; stroke: var(--viz-bad)" stroke-width="2"/>
<line x1="545" y1="90" x2="551" y2="112" style="stroke: var(--viz-bad)" stroke-width="1.2"/>
<text x="540" y="84" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">re-acquire</text>
<text x="18" y="190" font-size="12" font-weight="700" style="fill: var(--viz-ok)">serializable, and nobody</text>
<text x="18" y="206" font-size="12" font-weight="700" style="fill: var(--viz-ok)">reads uncommitted data</text>
<text x="230" y="190" font-size="12" font-weight="700" style="fill: var(--viz-warn)">still serializable, but</text>
<text x="230" y="206" font-size="12" font-weight="700" style="fill: var(--viz-warn)">others may read dirty data</text>
<text x="442" y="190" font-size="12" font-weight="700" style="fill: var(--viz-bad)">acquire after release:</text>
<text x="442" y="206" font-size="12" font-weight="700" style="fill: var(--viz-bad)">not serializable</text>
</svg><svg class="c7d2-n" viewBox="0 0 360 452" role="img" aria-label="Three lock-count curves over time: rigorous 2PL rises then drops to zero at commit; basic 2PL rises then steps down before commit; a non-two-phase transaction releases a lock and later acquires another">
<rect x="6" y="6" width="348" height="140" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<rect x="6" y="154" width="348" height="140" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<rect x="6" y="302" width="348" height="140" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)" stroke-width="1"/>
<line x1="40" y1="36" x2="40" y2="124" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="40" y1="124" x2="176" y2="124" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="40" y1="184" x2="40" y2="272" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="40" y1="272" x2="176" y2="272" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="40" y1="332" x2="40" y2="420" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<line x1="40" y1="420" x2="176" y2="420" style="stroke: var(--viz-line)" stroke-width="1.5"/>
<text x="0" y="0" font-size="12" text-anchor="middle" transform="translate(28 82) rotate(-90)" style="fill: var(--viz-muted)">locks held</text>
<text x="0" y="0" font-size="12" text-anchor="middle" transform="translate(28 230) rotate(-90)" style="fill: var(--viz-muted)">locks held</text>
<text x="0" y="0" font-size="12" text-anchor="middle" transform="translate(28 378) rotate(-90)" style="fill: var(--viz-muted)">locks held</text>
<text x="176" y="139" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<text x="176" y="287" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<text x="176" y="435" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<line x1="150" y1="34" x2="150" y2="124" style="stroke: var(--viz-muted)" stroke-width="1" stroke-dasharray="3 3"/>
<line x1="150" y1="182" x2="150" y2="272" style="stroke: var(--viz-muted)" stroke-width="1" stroke-dasharray="3 3"/>
<line x1="150" y1="330" x2="150" y2="420" style="stroke: var(--viz-muted)" stroke-width="1" stroke-dasharray="3 3"/>
<text x="150" y="28" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">COMMIT</text>
<text x="150" y="176" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">COMMIT</text>
<text x="150" y="324" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">COMMIT</text>
<path d="M40,124 H57 V104 H78 V84 H100 V64 H121 V44 H150 V124 H176" style="fill: none; stroke: var(--viz-c1)" stroke-width="2.5"/>
<path d="M40,272 H57 V252 H78 V232 H100 V212 H117 V232 H129 V252 H140 V272 H176" style="fill: none; stroke: var(--viz-warn)" stroke-width="2.5"/>
<path d="M40,420 H57 V400 H78 V380 H95 V400 H117 V380 H134 V360 H150 V420 H176" style="fill: none; stroke: var(--viz-bad)" stroke-width="2.5" stroke-dasharray="6 4"/>
<circle cx="117" cy="390" r="7" style="fill: none; stroke: var(--viz-bad)" stroke-width="2"/>
<text x="196" y="34" font-size="13" font-weight="700">Rigorous 2PL</text>
<text x="196" y="52" font-size="12" style="fill: var(--viz-muted)">what databases do</text>
<text x="196" y="84" font-size="12" font-weight="700" style="fill: var(--viz-ok)">serializable, and</text>
<text x="196" y="100" font-size="12" font-weight="700" style="fill: var(--viz-ok)">nobody reads</text>
<text x="196" y="116" font-size="12" font-weight="700" style="fill: var(--viz-ok)">uncommitted data</text>
<text x="196" y="182" font-size="13" font-weight="700">Basic 2PL</text>
<text x="196" y="200" font-size="12" style="fill: var(--viz-muted)">releases early</text>
<text x="196" y="232" font-size="12" font-weight="700" style="fill: var(--viz-warn)">still serializable,</text>
<text x="196" y="248" font-size="12" font-weight="700" style="fill: var(--viz-warn)">but others may read</text>
<text x="196" y="264" font-size="12" font-weight="700" style="fill: var(--viz-warn)">dirty data</text>
<text x="196" y="330" font-size="13" font-weight="700">Not two-phase</text>
<text x="196" y="348" font-size="12" style="fill: var(--viz-muted)">release, then acquire</text>
<text x="196" y="380" font-size="12" font-weight="700" style="fill: var(--viz-bad)">acquire after</text>
<text x="196" y="396" font-size="12" font-weight="700" style="fill: var(--viz-bad)">release (circled):</text>
<text x="196" y="412" font-size="12" font-weight="700" style="fill: var(--viz-bad)">not serializable</text>
</svg>`,
          caption: "Two phases means no new lock after the first release. Databases sidestep the subtlety by releasing everything at commit.",
        },
        {
          type: "text",
          html: `<h3>Deadlocks</h3>
<p>With this many locks, transactions get stuck: A waits for a lock B holds while B waits for one A holds. The database keeps a <strong>wait-for graph</strong>, finds the cycle, and aborts one transaction (the victim) so the other can proceed; the application must retry the victim. Deadlocks are far more frequent under 2PL than under read committed, whose locks cover only writes, because reads lock too. The classic case: two transactions both read a row (S locks, compatible), then both try to write it (each upgrade to X blocks on the other's S).</p>
<p>PostgreSQL checks for a cycle only after a lock wait exceeds <code>deadlock_timeout</code> (1 second by default) and reports SQLSTATE 40P01. InnoDB detects deadlocks too, and gives up on any lock wait after <code>innodb_lock_wait_timeout</code> (50 seconds by default). Schemes based on transaction age, <em>wait-die</em> and <em>wound-wait</em>, never let a cycle form at all; Spanner uses wound-wait. In application code: take locks in a consistent order, ask for the write lock up front (<code>SELECT ... FOR UPDATE</code> rather than read, then upgrade), keep transactions short, and index the columns you search so that less gets locked. The visualization replays the write-skew section's room-booking race under 2PL.</p>`,
        },
        {
          type: "viz",
          id: "ch7/two-phase-locking",
          title: "Two-phase locking and the phantom booking",
          caption: "Press Play on the default, Index-range locks: both shared locks coexist, the inserts deadlock, a victim is aborted and its retry sees Alice's booking. Then follow the Try next buttons: Row locks only lets the phantom through, range locks let Bob book Room 124 in parallel, and No index locks the whole table. Notice the false conflict there: bookings for two different rooms deadlock.",
        },
        {
          type: "text",
          html: `<h3>Predicate locks: locking rows that don't exist</h3>
<p>Row locks alone don't make 2PL serializable, as the Row locks only setting shows: the conflicting row didn't exist when the check ran. The fix, from IBM's System R group in 1976, is the <strong>predicate lock</strong>: a shared lock not on a row but on a search condition, such as <code>room_id = 123 AND end_time &gt; '12:00' AND start_time &lt; '13:00'</code>. It covers every matching row, including rows not yet inserted. Before any insert, update or delete, the database checks whether the old or new version of the row matches an existing predicate lock and, if so, waits. 2PL with predicate locks is truly serializable. The trouble is speed: checking every write against many active predicates is expensive.</p>
<h3>Index-range locks: a cheap over-approximation</h3>
<p>So real databases approximate. An <strong>index-range lock</strong> (in InnoDB, a <em>next-key lock</em>) covers a larger range that is cheap to check: the index entries for room 123 at all times, say, or a time range across all rooms. Any write that would match the real predicate has to touch the same index range, so it finds the lock. If no suitable index exists, the database falls back to a shared lock on the whole table: safe, but terrible for concurrency, as the No index setting shows with a deadlock between bookings for different rooms. The approximation trades a few false conflicts for far less overhead.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "Eswaran, Gray, Lorie & Traiger", year: "1976", tag: "System R", html: "<em>The Notions of Consistency and Predicate Locks in a Database System</em> (CACM) introduced predicate locks and showed that two-phase locking yields serializable executions." },
            { org: "MySQL InnoDB", tag: "SERIALIZABLE", html: "At SERIALIZABLE, plain SELECTs become locking reads (FOR SHARE) when autocommit is off, and next-key locks (record plus gap) block phantoms. InnoDB detects deadlocks and rolls back a victim." },
            { org: "Microsoft SQL Server", tag: "key-range locks", html: "SERIALIZABLE holds key-range locks on the index ranges a query read, so inserts into those ranges block until the reader finishes: index-range locking in a mainstream product." },
            { org: "Google Spanner", tag: "2PL + TrueTime", html: "Read-write transactions use two-phase locking, with wound-wait to avoid deadlocks, combined with TrueTime commit timestamps; read-only transactions read lock-free at a snapshot timestamp." },
          ],
        },
        {
          type: "tradeoffs",
          pros: [
            "Truly serializable once predicate or index-range locks are used",
            "Works for any transaction shape: interactive, long, disk-resident",
            "Conflicts are resolved by waiting, so little work is thrown away",
            "Decades of production experience (InnoDB and SQL Server at SERIALIZABLE, DB2 at REPEATABLE READ)",
          ],
          cons: [
            "Readers block writers and writers block readers, so one slow transaction can stall many others",
            "Queues form, so latency at high percentiles becomes unstable",
            "Deadlocks are frequent, and every victim's work is wasted and retried",
            "Without a usable index, range locks degrade to table locks",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Why does 2PL deadlock so much more than read committed?\"",
          html: `<p>Under read committed only writes take locks, so a deadlock needs two transactions writing the same rows in opposite orders. Under 2PL every read takes a shared lock held to the end, so the common pattern "read a row, then update it" deadlocks whenever two transactions do it concurrently: both get S, and each upgrade to X waits on the other's S. Range locks widen the net further, since two inserts into the same gap can collide. The fixes: lock in a consistent order, take the X lock up front with <code>SELECT ... FOR UPDATE</code>, keep transactions short, index the searched columns, and retry on deadlock errors (40P01 in PostgreSQL, 1213 in MySQL).</p>`,
        },
        {
          type: "quiz",
          q: "Under 2PL with index-range locks, Alice and Bob both run 'check that room 123 is free at 12:00, then insert'. What typically happens?",
          options: [
            "Both inserts succeed and the room is double-booked",
            "Both take shared locks on the range, then each waits for the other in order to insert: a deadlock. One is aborted, and its retry sees the other's booking",
            "Bob's SELECT blocks until Alice commits, so there is no deadlock",
            "Alice is aborted at commit with a serialization failure",
          ],
          answer: 1,
          explain: "Shared locks are compatible, so both checks proceed; the two inserts then need exclusive access while the other still holds its shared lock, a cycle. C would be true only if the check itself took an exclusive lock on the range. A is what happens with row locks only, when there is no range to lock. D describes SSI, not 2PL.",
        },
      ],
    },

    // ------------------------------------------------------------------ 10
    {
      id: "ssi",
      title: "Serializable snapshot isolation: optimism that checks its premises",
      kicker: "Serializability, approach 3",
      concepts: ["serializable-snapshot-isolation", "optimistic-vs-pessimistic-concurrency"],
      blocks: [
        {
          type: "problem",
          title: "Wait for everything, or check nothing?",
          html: `<p>So far the choice looks grim. Serializable implementations either perform poorly under contention (2PL) or are capped at one core per partition (serial execution); weak isolation performs well but lets write skew and phantoms through. Pessimistic schemes make transactions wait for anything that <em>might</em> conflict, even when it turns out not to. Snapshot isolation makes nobody wait, but lets a transaction commit a decision whose premise is already false. Can a database keep "nobody waits" and still catch the premises that went stale?</p>`,
        },
        {
          type: "idea",
          html: `<p>Let transactions run on snapshots without blocking, <strong>track what each one read</strong>, and at commit time abort any read-write transaction whose premise was changed by a concurrent transaction that has <strong>already committed</strong>.</p>`,
        },
        {
          type: "text",
          html: `<h3>A young algorithm built on an old idea</h3>
<p><strong>Serializable snapshot isolation</strong> (SSI) was described by Michael Cahill, Uwe Röhm and Alan Fekete in 2008, from Cahill's PhD work, and PostgreSQL's SERIALIZABLE level has used it since version 9.1 (2011). FoundationDB uses a similar optimistic approach with conflict detection distributed across machines. Next to 2PL and serial execution, it is very young.</p>
<p>2PL is <strong>pessimistic</strong>: if anything might go wrong, wait until it's safe, as a mutex does. Serial execution is pessimistic to the extreme, as if each transaction held an exclusive lock on the entire database. SSI is <strong>optimistic</strong>: carry on regardless, check at commit whether isolation was violated, and if so abort and retry. Optimistic concurrency control itself dates back to Kung and Robinson (1981). It loses under high contention, when many transactions conflict and abort, and especially near maximum throughput, where retries pile extra load onto a saturated system. It wins when there is spare capacity and conflicts are rare. Commutative atomic operations, such as concurrent increments of one counter, needn't count as conflicts at all.</p>`,
        },
        {
          type: "diagram",
          title: "Optimistic vs pessimistic as contention grows (qualitative)",
          svg: `<style>.dd-diagram-body svg.c7d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c7d2-w{display:none}.dd-diagram-body svg.c7d2-n{display:block}}</style><svg class="c7d2-w" viewBox="0 0 640 240" role="img" aria-label="Qualitative sketch: optimistic concurrency starts with higher throughput and falls steeply at high contention; pessimistic locking starts lower and degrades gently">
<defs>
<marker id="c7op-w-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="70" y="20" font-size="12" font-weight="700" style="fill: var(--viz-muted)">useful throughput</text>
<text x="636" y="20" font-size="12" font-style="italic" text-anchor="end" style="fill: var(--viz-muted)">illustrative, not measured</text>
<line x1="70" y1="196" x2="70" y2="34" style="stroke: var(--viz-line)" stroke-width="1.5" marker-end="url(#c7op-w-mu)"/>
<line x1="70" y1="196" x2="474" y2="196" style="stroke: var(--viz-line)" stroke-width="1.5" marker-end="url(#c7op-w-mu)"/>
<text x="74" y="212" font-size="12" style="fill: var(--viz-muted)">low</text>
<text x="470" y="212" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">high</text>
<text x="270" y="230" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-muted)">contention: how often transactions conflict</text>
<path d="M80,52 C240,52 330,64 380,110 S440,180 466,186" style="fill: none; stroke: var(--viz-c2)" stroke-width="3"/>
<path d="M80,100 C200,104 340,118 466,150" style="fill: none; stroke: var(--viz-c7)" stroke-width="3"/>
<text x="84" y="42" font-size="13" font-weight="700" style="fill: var(--viz-c2)">optimistic (SSI, OCC)</text>
<text x="84" y="90" font-size="13" font-weight="700" style="fill: var(--viz-c7)">pessimistic (2PL)</text>
<text x="478" y="154" font-size="12" style="fill: var(--viz-c7)">waiting and deadlocks</text>
<text x="478" y="190" font-size="12" style="fill: var(--viz-c2)">abort-retry storms</text>
</svg><svg class="c7d2-n" viewBox="0 0 360 246" role="img" aria-label="Qualitative sketch: optimistic concurrency starts with higher throughput and falls steeply at high contention; pessimistic locking starts lower and degrades gently">
<defs>
<marker id="c7op-n-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="40" y="20" font-size="12" font-weight="700" style="fill: var(--viz-muted)">useful throughput</text>
<text x="356" y="20" font-size="12" font-style="italic" text-anchor="end" style="fill: var(--viz-muted)">illustrative</text>
<line x1="40" y1="196" x2="40" y2="34" style="stroke: var(--viz-line)" stroke-width="1.5" marker-end="url(#c7op-n-mu)"/>
<line x1="40" y1="196" x2="254" y2="196" style="stroke: var(--viz-line)" stroke-width="1.5" marker-end="url(#c7op-n-mu)"/>
<text x="44" y="212" font-size="12" style="fill: var(--viz-muted)">low</text>
<text x="250" y="212" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">high</text>
<text x="148" y="234" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-muted)">contention</text>
<path d="M48,52 C130,52 180,62 205,100 S238,180 248,186" style="fill: none; stroke: var(--viz-c2)" stroke-width="3"/>
<path d="M48,100 C120,104 190,118 248,150" style="fill: none; stroke: var(--viz-c7)" stroke-width="3"/>
<text x="52" y="42" font-size="12" font-weight="700" style="fill: var(--viz-c2)">optimistic (SSI)</text>
<text x="52" y="90" font-size="12" font-weight="700" style="fill: var(--viz-c7)">pessimistic (2PL)</text>
<text x="258" y="144" font-size="12" style="fill: var(--viz-c7)">waiting,</text>
<text x="258" y="158" font-size="12" style="fill: var(--viz-c7)">deadlocks</text>
<text x="258" y="184" font-size="12" style="fill: var(--viz-c2)">abort-retry</text>
<text x="258" y="198" font-size="12" style="fill: var(--viz-c2)">storms</text>
</svg>`,
          caption: "Optimism wins when conflicts are rare and there is spare capacity; the shapes are a sketch, not a benchmark.",
        },
        {
          type: "text",
          html: `<h3>Catching decisions built on stale premises</h3>
<p>SSI is snapshot isolation (every read comes from a consistent snapshot) plus an algorithm that detects serialization conflicts among writes and decides which transactions to abort. In write skew a transaction reads a premise, decides, and writes; under SI the premise may be false by commit time. The database can't see how the app used each read, so it treats any change to data a transaction read as a possible invalidation of its writes, and must detect when a query's result <em>might</em> have changed. That can happen in two ways, and the visualization lets you trigger both.</p>`,
        },
        {
          type: "viz",
          id: "ch7/ssi-detector",
          title: "SSI: catching stale premises",
          caption: "Try Write after read under Snapshot isolation, then under SSI, and watch where the abort happens. Then step through Stale read, Read-only reader and Writer aborts. Finally, in You schedule it, try to get both doctors off call under SSI. Notice that nobody ever waits, and only a read-write transaction whose premise was overwritten by a committed transaction gets aborted.",
        },
        {
          type: "steps",
          title: "The two cases SSI detects",
          items: [
            "<strong>Stale MVCC read: the write came first, uncommitted.</strong> T43 reads Alice's row while T42's update to it is still uncommitted, so the MVCC visibility rules show T43 the old version. The database records that T43 <em>ignored</em> a write by T42. When T43 tries to commit, it checks whether any ignored write has since committed; if so, T43's read was stale, and T43 is aborted.",
            "<strong>Write after read: the read came first.</strong> Like an index-range lock, except that nothing blocks. When T42 and T43 read the on-call doctors for shift 1234, the database notes on that index entry who read it (PostgreSQL calls these SIREAD locks). A transaction that writes looks for recent readers of the affected data and tells them their read may now be outdated: a tripwire, not a lock. T42 commits first and succeeds; at T43's commit the conflicting write has already committed, so T43 is aborted. The notes can be dropped once all concurrent transactions have finished.",
          ],
        },
        {
          type: "text",
          html: `<h3>Why wait until commit?</h3>
<p>In the first case the database knows at read time that T43 skipped an uncommitted write, so why not abort immediately? Because the read may prove harmless. T43 might be read-only, and in this two-transaction case a read-only transaction can't cause write skew: it can be ordered before T42. Or T42 might abort, or still be uncommitted when T43 commits, in which case T43's read wasn't stale after all. Waiting avoids those needless aborts and keeps snapshot isolation's best property: long consistent reads that never block. The Read-only reader and Writer aborts scenarios show both.</p>
<h3>Performance, and how PostgreSQL decides</h3>
<p>Tracking granularity is a trade-off: precise tracking costs bookkeeping, coarse tracking aborts more than necessary. Compared with 2PL, nobody waits for another transaction's locks, and read-only queries never block or get blocked, so latency is more predictable and read-heavy workloads benefit; compared with serial execution, SSI isn't limited to one core. The <strong>abort rate</strong> governs performance, and long read-write transactions are likely to conflict, so keep those short (long read-only ones are fine). Even so, SSI is less sensitive to one slow transaction than 2PL or serial execution.</p>
<p>PostgreSQL doesn't search for full cycles in a serialization graph. It records <strong>rw-antidependencies</strong> ("T1 read a version that T2 overwrote") among concurrent transactions and aborts on a <em>dangerous structure</em>: two consecutive edges T1 → T2 → T3 where T3 committed first (T1 and T3 may be the same transaction, as with the doctors). Fekete and colleagues proved in 2005 that every non-serializable execution under SI contains such a structure, so checking for it is enough; not every such structure completes a cycle, so some aborts are false positives. Under memory pressure, SIREAD locks are promoted from tuple to page to whole relation, and a sequential scan always takes a relation-level SIREAD lock, so a missing index means more aborts: the optimistic counterpart of 2PL's fallback to table locks.</p>
<h3>Living with SERIALIZABLE</h3>
<p>In PostgreSQL a serialization failure is SQLSTATE 40001, and it can surface at any statement, not only at COMMIT. The application must retry the <strong>whole</strong> transaction, re-running its reads, because a stale read was the problem. Long reports can use <code>SERIALIZABLE READ ONLY DEFERRABLE</code>, which waits for a safe snapshot and then can't be aborted. And SSI protects only transactions running at SERIALIZABLE; one at a lower level can write past the checks. As the section on aborts and retries shows, the retry loop also needs backoff, jitter and idempotency.</p>`,
        },
        {
          type: "code",
          lang: "python",
          title: "Retrying a serializable transaction (psycopg 3)",
          code: `import random, time
from psycopg import errors

RETRYABLE = (errors.SerializationFailure,   # SQLSTATE 40001
             errors.DeadlockDetected)       # SQLSTATE 40P01

def run_serializable(conn, work, attempts=5):
    """Run work(conn) as one SERIALIZABLE transaction; retry the whole thing."""
    for attempt in range(attempts):
        try:
            with conn.transaction():        # BEGIN; COMMIT, or ROLLBACK on error
                conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                return work(conn)           # re-runs every read, not just the write
        except RETRYABLE:
            if attempt == attempts - 1:
                raise
            time.sleep(random.uniform(0, 0.02 * 2 ** attempt))  # backoff, full jitter

# conn = psycopg.connect(dsn, autocommit=True), so conn.transaction() issues BEGIN`,
          caption: "The error may come from any statement or from COMMIT itself, so the whole function body is inside the retry.",
        },
        {
          type: "compare",
          title: "Three roads to serializability",
          items: [
            { title: "Actual serial execution", tone: "info", html: "Best when the active data fits in memory, transactions are tiny stored procedures, and writes fit on one core per partition. No waits and no aborts, but one slow transaction stalls everyone and cross-partition work is a cliff." },
            { title: "Two-phase locking", tone: "warn", html: "Handles any data size and transaction shape, including interactive ones. Conflicts cost waiting and deadlocks; readers and writers block each other, so tail latency suffers with long transactions or hot rows." },
            { title: "Serializable snapshot isolation", tone: "ok", html: "Reads never block; conflicts cost aborts and retries. Shines for read-heavy workloads with low or moderate contention and short read-write transactions; degrades into retry storms under heavy contention." },
          ],
        },
        {
          type: "callout",
          tone: "tip",
          title: "The practical choice",
          html: `<p>For an application the decision is usually between two strategies. Run at read committed (or SI) and fix the known hot spots explicitly with atomic updates, FOR UPDATE, constraints or materialized conflicts. Or run at SERIALIZABLE with a retry loop and accept some aborts. The first is faster if you have found every race; the second protects you from the races you haven't found.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "PostgreSQL", year: "2011", tag: "SSI in production", html: "Since 9.1, SERIALIZABLE is SSI, as described by Ports and Grittner (VLDB 2012). SIREAD locks show up in <code>pg_locks</code> with mode SIReadLock, and conflicts raise SQLSTATE 40001: could not serialize access due to read/write dependencies among transactions." },
            { org: "FoundationDB", tag: "optimistic, distributed", html: "Strictly serializable transactions via optimistic concurrency control: resolvers check each transaction's read ranges against recently committed writes. Transactions are limited to about 5 seconds, which keeps the conflict-tracking window small. Apple open-sourced it in 2018." },
            { org: "Jepsen: PostgreSQL 12.3", year: "2020", tag: "testing", html: "Jepsen found that a bug let PostgreSQL's SERIALIZABLE admit G2-item anomalies (write-skew-like cycles), and reproduced it in every version it tried, back to 9.5; the PostgreSQL team fixed it in the August 2020 minor releases. Even mature SSI implementations need adversarial testing." },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Optimistic serializability went mainstream",
          html: `<p>Optimistic serializability has become a default rather than an exotic option. <strong>CockroachDB</strong> runs at SERIALIZABLE by default using optimistic, timestamp-based MVCC, expects clients to retry on 40001, and added READ COMMITTED as an option only in 2024. Call designs like CockroachDB's and FoundationDB's SSI-like or optimistic rather than literally SSI; Spanner, by contrast, gets serializability from 2PL. Testing caught up too: Jepsen's Elle checker (2020) infers dependency cycles such as G2 from transaction histories, which is how the PostgreSQL bug above was found.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Walk me through how SSI catches the doctors\"",
          html: `<p>T42 (Alice) and T43 (Bob) both read the on-call rows for shift 1234, leaving SIREAD marks. T42's update of Alice's row trips T43's mark (T43 read what T42 overwrote); T43's update of Bob's row trips T42's. Nobody blocks. T42 commits first. At T43's commit, a concurrent transaction that has committed overwrote data T43 read, and T43 wrote, so T43 is aborted with 40001; its retry sees one doctor on call and refuses. Strong answers add that PostgreSQL may raise the error before COMMIT, that a read-only T43 wouldn't be aborted in this two-transaction case, and that the app must retry the whole transaction, not the failed statement.</p>`,
        },
        {
          type: "quiz",
          q: "Under SSI, T43 read 'Alice is on call' while T42's update of Alice's row was still uncommitted. Why doesn't the database abort T43 immediately?",
          options: [
            "It can't detect the situation until commit time",
            "T43 might be read-only, or T42 might abort or still be uncommitted when T43 commits; in those cases there is no anomaly, so an early abort would be wasted",
            "PostgreSQL doesn't track reads, only writes",
            "Because SSI relies on T42's row lock to block T43 instead",
          ],
          answer: 1,
          explain: "The database knows about the ignored write at read time, so A is wrong. It deliberately waits, because the stale read only matters if T43 goes on to write and T42 actually commits; in the read-only and writer-aborts cases an early abort would throw away a perfectly good transaction. C is false: tracking reads is exactly what SIREAD locks do. D describes pessimistic locking, which SSI avoids.",
        },
      ],
    },
  ],

  takeaways: [
    "Transactions collapse a universe of partial failures and race conditions into two outcomes, <strong>commit or abort</strong>, so the application only has to handle those, and can retry an abort.",
    "ACID is a fuzzy label: A means <strong>abortability</strong> (not concurrency), C is your application's invariants, I is a spectrum whose ideal is serializability, and D is a probability, not a certainty.",
    "Learn the <strong>anomalies, not the level names</strong>: dirty read, dirty write, read skew, lost update, write skew, phantom. 'Repeatable read' and 'serializable' mean different things in different databases, so test.",
    "Snapshot isolation via MVCC gives every transaction a frozen view without read locks, but it still allows <strong>write skew</strong>, and whether it catches lost updates depends on the database (PostgreSQL yes, MySQL InnoDB no).",
    "Most concurrency bugs are <strong>check-then-act</strong>. If a write depends on a read, make the write atomic, lock what you read, make the write conditional, materialize the conflict, use a constraint, or go serializable.",
    "There are three roads to serializability: <strong>actual serial execution</strong> (tiny in-memory transactions), <strong>two-phase locking</strong> (pessimistic: waits and deadlocks) and <strong>SSI</strong> (optimistic: aborts at commit). Either someone waits or someone retries.",
    "Retries are part of the API: on transient errors (40001, deadlock) ROLLBACK and retry the <strong>whole transaction</strong> with backoff and jitter, and write an idempotency key in the same transaction so a retry after an unknown commit outcome can't apply twice.",
  ],

  connections: [
    { to: "ch2", html: "Document databases without joins push you to denormalize, so one logical change updates several documents (a message and its unread counter); multi-object atomicity and isolation are what keep those copies in step." },
    { to: "ch3", html: "Atomicity and durability are built on the write-ahead log; MVCC versions live in the storage engine (PostgreSQL heap tuples, InnoDB and Oracle undo logs), and copy-on-write B-trees (LMDB, CouchDB) give snapshots almost for free." },
    { to: "ch5", html: "Durability usually means replication, and asynchronous replication can lose committed writes on failover. Lock- and CAS-based lost-update prevention assumes one up-to-date copy: multi-leader and leaderless stores need siblings, merges or CRDTs, and last write wins loses updates." },
    { to: "ch6", html: "Serial execution scales only by partitioning, and cross-partition transactions are the cliff (about 1,000 per second in VoltDB's figures). Global secondary indexes turn single-row writes into multi-partition transactions." },
    { to: "ch8", html: "A client timeout leaves the commit outcome unknown, the root of the retry and idempotency problem. Lock-based coordination across machines needs fencing tokens because of process pauses." },
    { to: "ch9", html: "Atomic commit across nodes is two-phase commit (not 2PL). Serializability (some serial order) differs from linearizability (single-object recency); together they make strict serializability (Spanner, FoundationDB). When 2PC and 2PL combine, a prepared participant must hold its locks until the coordinator decides, which is why coordinator failure is so costly." },
    { to: "ch11", html: "Dual writes to a database and another system break atomicity; change data capture and the outbox pattern restore it. Exactly-once stream processing is the streaming cousin of safe retries." },
    { to: "ch12", html: "End-to-end idempotence via operation IDs is the general fix for commit-unknown retries, and uniqueness constraints can be enforced through a partitioned log instead of distributed transactions." },
  ],

  furtherReading: [
    { title: "A Critique of ANSI SQL Isolation Levels (Berenson, Bernstein, Gray, Melton, O'Neil & O'Neil, SIGMOD 1995)", note: "Defines snapshot isolation and shows the SQL standard's isolation levels are ambiguous: the origin of most of this chapter's vocabulary." },
    { title: "Hermitage: testing transaction isolation levels (Martin Kleppmann)", url: "https://github.com/ept/hermitage", note: "Concrete test cases for each anomaly, with results for PostgreSQL, MySQL, Oracle, SQL Server and others; the fastest way to see what a level really does." },
    { title: "PostgreSQL documentation: Transaction Isolation", url: "https://www.postgresql.org/docs/current/transaction-iso.html", note: "Precise description of read committed, repeatable read (SI) and serializable (SSI) in one real system, including serialization-failure handling." },
    { title: "Serializable Isolation for Snapshot Databases (Cahill, Röhm & Fekete, SIGMOD 2008)", note: "The original SSI algorithm." },
    { title: "Serializable Snapshot Isolation in PostgreSQL (Ports & Grittner, VLDB 2012)", note: "How SSI was engineered into a production database: SIREAD locks, read-only optimizations, memory limits." },
    { title: "Weak Consistency: A Generalized Theory and Optimistic Implementations for Distributed Transactions (Atul Adya, PhD thesis, MIT 1999)", note: "Formal, implementation-independent definitions of the anomalies (G0, G1, G2) used by modern testing tools such as Jepsen's Elle." },
    { title: "Jepsen: Consistency models", url: "https://jepsen.io/consistency/models", note: "A clickable map of isolation and consistency models and how they relate, from read uncommitted to strict serializability." },
    { title: "Jepsen: PostgreSQL 12.3 analysis (2020)", url: "https://jepsen.io/analyses/postgresql-12.3", note: "A real serializability bug found in a mature SSI implementation, and how it was tested." },
    { title: "Jepsen: MySQL 8.0.34 analysis (2023)", url: "https://jepsen.io/analyses/mysql-8.0.34", note: "Evidence that InnoDB's REPEATABLE READ is not snapshot isolation in the usual sense (lost updates and other anomalies)." },
    { title: "ACIDRain: Concurrency-Related Attacks on Database-Backed Web Applications (Warszawski & Bailis, SIGMOD 2017)", note: "How weak isolation plus check-then-act code becomes an exploitable vulnerability in real e-commerce software." },
    { title: "A Read-Only Transaction Anomaly Under Snapshot Isolation (Fekete, O'Neil & O'Neil, SIGMOD Record 2004)", note: "Shows that even a read-only transaction can observe a non-serializable state under SI, which is why PostgreSQL offers SERIALIZABLE READ ONLY DEFERRABLE." },
    { title: "The End of an Architectural Era (It's Time for a Complete Rewrite) (Stonebraker et al., VLDB 2007)", note: "The argument behind H-Store/VoltDB and actual serial execution." },
    { title: "The LMAX Architecture (Martin Fowler, 2011)", url: "https://martinfowler.com/articles/lmax.html", note: "A vivid case study of single-threaded, in-memory transaction processing at millions of operations per second." },
    { title: "Exponential Backoff And Jitter (Marc Brooker, AWS Architecture Blog, 2015)", url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/", note: "Why retry loops need randomness, argued with simple simulations." },
    { title: "Designing robust and predictable APIs with idempotency (Brandur Leach, Stripe blog, 2017)", url: "https://stripe.com/blog/idempotency", note: "Idempotency keys and safe retries explained by the API that popularized them." },
  ],
});
