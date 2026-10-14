// Chapter 5 deep dive, part 1 (hook + first half of the sections). Authoring guide: docs/AUTHORING.md
// Diagrams carry two SVGs (.ch5d-w for wide screens, .ch5d-n for phones) and a tiny <style> that swaps them.
DDIA.registerDeepDive("ch5", {
  hook: `<p>You edit your profile bio, press <strong>Save</strong>, and the page reloads with your <em>old</em> bio. You try again: same thing. Ten seconds later the new text shows up on its own. Nothing was lost. The write reached the database fine, but the reload was answered by a <strong>read replica</strong> that was a couple of seconds behind.</p>
<p>Now the same problem at the scale of a company. On 21 October 2018 at 22:52 UTC, routine replacement of failing 100G optical equipment cut GitHub's US East Coast network hub off from its primary East Coast data center for <strong>43 seconds</strong>. That was long enough for Orchestrator, GitHub's failover tool, to promote database servers on the West Coast to primary. When the link came back, each coast held writes the other had never seen. Rather than throw any of them away or risk mixing up users' data, GitHub ran in a degraded state for <strong>24 hours and 11 minutes</strong> while it reconciled.</p>
<p>Both stories have the same root. Copying bytes to another machine is trivial; keeping several copies in agreement while machines crash, networks split and users write at the same moment is the entire subject of this chapter. There are three broad answers. Let <strong>one leader</strong> put every write in order. Let <strong>several leaders</strong> accept writes and reconcile afterwards. Or have <strong>no leader</strong> at all, and rely on overlapping groups of replicas. Each one moves the disagreement to a different place, and each section below shows exactly where.</p>`,
  sections: [
    // ------------------------------------------------------------------ 1
    {
      id: "why-replicate",
      title: "Three reasons to copy your data, and the one hard part",
      kicker: "Motivation",
      concepts: ["why-replicate"],
      blocks: [
        {
          type: "problem",
          html: `<p>Picture a growing app whose whole database lives on <strong>one server</strong> in Virginia. That server is a single failure domain: when its disk, power supply or kernel gives out, the data and the service disappear together. It is a single location: a user in Sydney pays a round trip of roughly 200 ms across the Pacific on every query. And it is a single machine's worth of read capacity: a read-heavy product pegs its CPU long before writes become a problem.</p>
<p>The obvious fix is a nightly backup, or a copy of the data directory on a second machine. Restoring takes hours and loses up to a day of writes. Worse, copying a live database's files while writes continue produces a <strong>torn copy</strong>: the first files reflect 2:00 a.m., the last ones 2:07, and the result may not even be internally consistent. Copying data once is easy. The trouble is that real data never stops changing, and every copy has to apply every change.</p>`,
        },
        {
          type: "text",
          html: `<h3>Three reasons to keep live copies</h3>
<p><strong>Lower latency.</strong> Light in fiber needs time to cross an ocean, and no hardware upgrade changes that. A replica in Sydney turns a 200 ms round trip into a few milliseconds for Australian readers. Keeping data physically close to the people who use it is called geo-distribution.</p>
<p><strong>Higher availability.</strong> If a machine dies, or a whole datacenter loses power, another copy keeps serving. Restoring from a backup means hours of downtime; promoting a live replica takes seconds to minutes. Replication is how a database rides out the routine hardware and software faults from Chapter 1.</p>
<p><strong>More read throughput.</strong> If most queries are reads, every extra machine that holds the data is another machine that can answer them. Ten replicas can serve roughly ten times the reads of one, which is why read-heavy sites such as Wikipedia send most queries to replicas.</p>
<p>Notice what is missing: <strong>write throughput</strong>. Every replica has to apply every write, so adding replicas adds work to each write instead of spreading it. This is the most common misconception about replication. If one machine cannot keep up with your writes, you have to split the data into partitions (<a href="#/ch6/learn/why-partition">Chapter 6</a>). This chapter assumes every node holds a full copy of the dataset; real systems usually do both, with each partition replicated on several nodes.</p>
<p>From here to the end of Part II, the book assumes the <strong>shared-nothing</strong> architecture from <a href="#/ch1/learn/coping-with-load">Chapter 1</a>: independent machines, each with its own CPU, memory and disks, that cooperate only by sending messages over a network.</p>`,
        },
        {
          type: "idea",
          html: `<p>Keep <strong>live copies</strong> (replicas) on several machines and continuously ship every change to all of them. The rest of the chapter answers two questions: how changes travel between replicas, and what the system does during the window in which the copies disagree.</p>`,
        },
        {
          type: "diagram",
          title: "Three ways to organize replicas",
          caption: "Violet nodes accept writes, cyan nodes hold copies, blue circles are clients. Single-leader funnels every write through one node. Multi-leader lets each region accept writes and syncs the leaders asynchronously. Leaderless has the client send each write to several replicas and count the acknowledgements.",
          svg: `<style>.ch5d-n{display:none!important}@media (max-width:600px){.ch5d-w{display:none!important}.ch5d-n{display:block!important}}</style>
<svg class="ch5d-w" viewBox="0 0 640 304" role="img" aria-label="Single-leader, multi-leader and leaderless replication side by side">
<defs>
<marker id="ch5-fam-w-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
<marker id="ch5-fam-w-v" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
</defs>
<g transform="translate(8,8)">
<rect x="0" y="0" width="200" height="274" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="100" y="28" text-anchor="middle" font-size="14" font-weight="700">Single-leader</text>
<circle cx="100" cy="64" r="15" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="100" y="68" text-anchor="middle" font-size="12">C</text>
<line x1="100" y1="80" x2="100" y2="113" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-w-b)"/>
<text x="108" y="101" font-size="12" style="fill: var(--viz-muted)">writes</text>
<circle cx="100" cy="142" r="25" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="100" y="146" text-anchor="middle" font-size="12" font-weight="700">Leader</text>
<line x1="84" y1="162" x2="61" y2="195" stroke-width="1.5" style="stroke: var(--viz-c1)" marker-end="url(#ch5-fam-w-v)"/>
<line x1="116" y1="162" x2="139" y2="195" stroke-width="1.5" style="stroke: var(--viz-c1)" marker-end="url(#ch5-fam-w-v)"/>
<text x="100" y="198" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">log</text>
<circle cx="50" cy="216" r="19" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="50" y="220" text-anchor="middle" font-size="12">F</text>
<circle cx="150" cy="216" r="19" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="150" y="220" text-anchor="middle" font-size="12">F</text>
<text x="100" y="260" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">One node orders every write</text>
</g>
<g transform="translate(220,8)">
<rect x="0" y="0" width="200" height="274" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="100" y="28" text-anchor="middle" font-size="14" font-weight="700">Multi-leader</text>
<rect x="4" y="90" width="72" height="138" rx="10" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
<rect x="124" y="90" width="72" height="138" rx="10" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
<circle cx="40" cy="64" r="15" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="40" y="68" text-anchor="middle" font-size="12">C</text>
<circle cx="160" cy="64" r="15" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="160" y="68" text-anchor="middle" font-size="12">C</text>
<line x1="40" y1="80" x2="40" y2="118" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-w-b)"/>
<line x1="160" y1="80" x2="160" y2="118" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-w-b)"/>
<circle cx="40" cy="146" r="24" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="40" y="150" text-anchor="middle" font-size="12" font-weight="700">Leader</text>
<circle cx="160" cy="146" r="24" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="160" y="150" text-anchor="middle" font-size="12" font-weight="700">Leader</text>
<line x1="68" y1="146" x2="132" y2="146" stroke-width="1.5" style="stroke: var(--viz-c1)" marker-start="url(#ch5-fam-w-v)" marker-end="url(#ch5-fam-w-v)"/>
<text x="100" y="168" text-anchor="middle" font-size="12" class="viz-halo">async</text>
<text x="40" y="214" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">DC 1</text>
<text x="160" y="214" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">DC 2</text>
<text x="100" y="260" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Every region accepts writes</text>
</g>
<g transform="translate(432,8)">
<rect x="0" y="0" width="200" height="274" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="100" y="28" text-anchor="middle" font-size="14" font-weight="700">Leaderless</text>
<circle cx="70" cy="64" r="15" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="70" y="68" text-anchor="middle" font-size="12">C</text>
<text x="94" y="60" font-size="12" style="fill: var(--viz-muted)">write to all n,</text>
<text x="94" y="76" font-size="12" style="fill: var(--viz-muted)">wait for w acks</text>
<line x1="66.8" y1="78.7" x2="44.7" y2="178.5" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-w-b)"/>
<line x1="73.2" y1="78.7" x2="95.3" y2="178.5" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-w-b)"/>
<line x1="78.3" y1="76.5" x2="147.9" y2="181.7" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-w-b)"/>
<circle cx="40" cy="200" r="20" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="40" y="204" text-anchor="middle" font-size="12">R</text>
<circle cx="100" cy="200" r="20" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="100" y="204" text-anchor="middle" font-size="12">R</text>
<circle cx="160" cy="200" r="20" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="160" y="204" text-anchor="middle" font-size="12">R</text>
<text x="100" y="260" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Quorums instead of a leader</text>
</g>
<circle cx="177" cy="292" r="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="187" y="296" font-size="12">client</text>
<circle cx="249" cy="292" r="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="259" y="296" font-size="12">leader (accepts writes)</text>
<circle cx="417" cy="292" r="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="427" y="296" font-size="12">follower / replica</text>
</svg>
<svg class="ch5d-n" viewBox="0 0 360 526" role="img" aria-label="Single-leader, multi-leader and leaderless replication, stacked">
<defs>
<marker id="ch5-fam-n-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
<marker id="ch5-fam-n-v" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
</defs>
<g transform="translate(8,8)">
<rect x="0" y="0" width="344" height="156" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="14" y="24" font-size="16" font-weight="700">Single-leader</text>
<text x="14" y="44" font-size="15" style="fill: var(--viz-muted)">One node orders every write</text>
<circle cx="40" cy="100" r="15" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="40" y="105" text-anchor="middle" font-size="15">C</text>
<line x1="56" y1="100" x2="97" y2="100" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-n-b)"/>
<text x="76" y="91" text-anchor="middle" font-size="14" style="fill: var(--viz-muted)">writes</text>
<circle cx="126" cy="100" r="26" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="126" y="105" text-anchor="middle" font-size="14" font-weight="700">Leader</text>
<line x1="151.2" y1="93.6" x2="214.7" y2="77.4" stroke-width="1.5" style="stroke: var(--viz-c1)" marker-end="url(#ch5-fam-n-v)"/>
<line x1="151.2" y1="106.4" x2="214.7" y2="122.6" stroke-width="1.5" style="stroke: var(--viz-c1)" marker-end="url(#ch5-fam-n-v)"/>
<text x="184" y="105" text-anchor="middle" font-size="15" class="viz-halo" style="fill: var(--viz-muted)">log</text>
<circle cx="236" cy="72" r="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="236" y="77" text-anchor="middle" font-size="15">F</text>
<circle cx="236" cy="128" r="18" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="236" y="133" text-anchor="middle" font-size="15">F</text>
</g>
<g transform="translate(8,172)">
<rect x="0" y="0" width="344" height="156" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="14" y="24" font-size="16" font-weight="700">Multi-leader</text>
<text x="14" y="44" font-size="15" style="fill: var(--viz-muted)">Every region accepts writes</text>
<rect x="50" y="54" width="98" height="94" rx="10" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
<rect x="196" y="54" width="98" height="94" rx="10" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
<circle cx="24" cy="92" r="14" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="24" y="97" text-anchor="middle" font-size="15">C</text>
<circle cx="320" cy="92" r="14" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="320" y="97" text-anchor="middle" font-size="15">C</text>
<line x1="39" y1="92" x2="72" y2="92" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-n-b)"/>
<line x1="305" y1="92" x2="272" y2="92" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-n-b)"/>
<circle cx="100" cy="92" r="25" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="100" y="97" text-anchor="middle" font-size="14" font-weight="700">Leader</text>
<circle cx="244" cy="92" r="25" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="244" y="97" text-anchor="middle" font-size="14" font-weight="700">Leader</text>
<line x1="128" y1="92" x2="216" y2="92" stroke-width="1.5" style="stroke: var(--viz-c1)" marker-start="url(#ch5-fam-n-v)" marker-end="url(#ch5-fam-n-v)"/>
<text x="172" y="82" text-anchor="middle" font-size="15" class="viz-halo">async</text>
<text x="100" y="140" text-anchor="middle" font-size="15" style="fill: var(--viz-muted)">DC 1</text>
<text x="244" y="140" text-anchor="middle" font-size="15" style="fill: var(--viz-muted)">DC 2</text>
</g>
<g transform="translate(8,336)">
<rect x="0" y="0" width="344" height="156" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="14" y="24" font-size="16" font-weight="700">Leaderless</text>
<text x="14" y="44" font-size="15" style="fill: var(--viz-muted)">Quorums instead of a leader</text>
<circle cx="44" cy="100" r="15" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="44" y="105" text-anchor="middle" font-size="15">C</text>
<line x1="58.7" y1="96.8" x2="183.4" y2="69.6" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-n-b)"/>
<line x1="60" y1="100" x2="183" y2="100" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-n-b)"/>
<line x1="58.7" y1="103.2" x2="183.4" y2="130.4" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#ch5-fam-n-b)"/>
<circle cx="200" cy="66" r="15" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="200" y="71" text-anchor="middle" font-size="15">R</text>
<circle cx="200" cy="100" r="15" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="200" y="105" text-anchor="middle" font-size="15">R</text>
<circle cx="200" cy="134" r="15" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="200" y="139" text-anchor="middle" font-size="15">R</text>
<text x="222" y="96" font-size="14" style="fill: var(--viz-muted)">write to all n,</text>
<text x="222" y="114" font-size="14" style="fill: var(--viz-muted)">wait for w acks</text>
</g>
<circle cx="40" cy="510" r="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="50" y="515" font-size="15">client</text>
<circle cx="116" cy="510" r="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="126" y="515" font-size="15">leader</text>
<circle cx="194" cy="510" r="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="204" y="515" font-size="15">follower / replica</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>All the difficulty is in the changes</h3>
<p>If data never changed, replication would be a one-time copy. Everything hard comes from propagating changes, and there are three families of algorithms for it, which the rest of the chapter takes in turn:</p>
<ul>
<li><strong>Single-leader:</strong> one node accepts all writes and streams them to the others in one fixed order. PostgreSQL, MySQL, MongoDB and Kafka work this way.</li>
<li><strong>Multi-leader:</strong> several nodes, typically one per region, accept writes and exchange them asynchronously, so two of them can accept conflicting writes.</li>
<li><strong>Leaderless:</strong> clients send each write to several replicas and read from several, relying on overlapping quorums instead of one node that orders writes. Cassandra and Riak work this way.</li>
</ul>
<p>Two decisions come up in every family: whether to replicate <strong>synchronously or asynchronously</strong>, and what to do with a replica that has <strong>failed or fallen behind</strong>. In most databases each is a configuration flag or two, but the consequences run deep. They decide whether a crash loses writes the client was told were saved, whether one slow disk can stall the whole system, and whether users see stale data.</p>
<p>None of this is new. The theory goes back to database research in the 1970s, and it has aged well because the ways networks and machines misbehave have not changed: packets are still delayed and lost, and machines still crash. What changed is the audience. Ordinary application developers now build on replicated, often asynchronous, databases every day, and phrases like <em>eventual consistency</em> are used widely and understood poorly.</p>`,
        },
        {
          type: "compare",
          title: "What replication buys, and what it doesn't",
          items: [
            { title: "Lower latency", tone: "ok", html: "A replica near the user answers reads in milliseconds instead of a cross-ocean round trip, for example a read replica in Sydney for a primary in Virginia." },
            { title: "Higher availability", tone: "ok", html: "Lose a machine or a whole datacenter and another copy keeps serving, after seconds of failover rather than hours of restore." },
            { title: "More read throughput", tone: "ok", html: "Spread reads across many replicas. Works best when reads dominate and slightly stale answers are acceptable." },
            { title: "Not more write throughput", tone: "bad", html: "Every replica applies every write, so write capacity stays bounded by a single node. Scaling writes needs partitioning (Chapter 6)." },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Common misconception: a replica is a backup",
          html: `<p>A replica copies <em>everything</em>, including your mistakes. A <code>DELETE</code> without a <code>WHERE</code>, a buggy migration or a dropped table reaches every follower within milliseconds. Replication protects you from machines failing, not from people and software doing the wrong thing.</p>
<p>You still need <strong>point-in-time backups</strong>: a periodic base backup plus an archive of the log, so you can restore to the moment just before the mistake. A middle ground is a <strong>delayed replica</strong> that deliberately applies changes, say, an hour late (PostgreSQL's <code>recovery_min_apply_delay</code>, MySQL's <code>SOURCE_DELAY</code>), which gives you an hour to stop it before a bad change lands.</p>`,
        },
        {
          type: "timeline",
          title: "How replication got here",
          items: [
            { year: "1995", html: "<strong>Bayou</strong> (Xerox PARC): weakly consistent replication for mobile, often-disconnected devices, with application-supplied merge procedures for conflicting writes." },
            { year: "2007", html: "Amazon's <strong>Dynamo</strong> paper popularizes leaderless replication: quorums, sloppy quorums with hinted handoff, and vector clocks." },
            { year: "2008", html: "Facebook open-sources <strong>Cassandra</strong>, pairing Dynamo-style replication with a Bigtable-style data model." },
            { year: "2010", html: "<strong>PostgreSQL 9.0</strong> ships built-in streaming replication and hot standby (read-only queries on replicas)." },
            { year: "2011", html: "Shapiro, Preguiça, Baquero and Zawirski formalize <strong>CRDTs</strong>, data types whose concurrent updates always merge." },
            { year: "2014", html: "The <strong>Raft</strong> paper makes consensus-based log replication approachable; etcd, CockroachDB and many newer systems adopt it." },
            { year: "2017", html: "<strong>PostgreSQL 10</strong> adds built-in logical replication." },
            { year: "2020", html: "<strong>Amazon S3</strong> becomes strongly read-after-write consistent." },
            { year: "2021", html: "<strong>MongoDB 5.0</strong> makes majority acknowledgement the default write concern, and <strong>Kafka 3.0</strong> makes <code>acks=all</code> the producer default." },
          ],
        },
        {
          type: "realworld",
          items: [
            { org: "Amazon Aurora", year: "2017", tag: "availability", html: "Aurora's storage keeps <strong>six copies</strong> of every data page, two in each of three Availability Zones. A write needs 4 of the 6 copies to acknowledge and a read needs 3, so Aurora can lose a whole AZ and keep writing, or an AZ plus one more node without losing data (SIGMOD 2017 paper)." },
            { org: "GitLab", year: "2017", tag: "replicas are not backups", html: "GitLab's January 2017 data loss is the standard proof that replicas are not backups. When the primary's data directory was deleted by mistake, the replicas had nothing to offer, and the only thing left to fall back on was a snapshot about six hours old. <a href=\"#/ch5/learn/node-outages\">How it began</a>, with a lagging replica that had to be re-seeded, comes up under node outages; the full incident is in <a href=\"#/ch12/learn/trust-but-verify\">Chapter 12</a>." },
            { org: "Wikipedia", tag: "read scaling", html: "Wikimedia runs its MediaWiki databases on MariaDB in sections, each with one primary and several replicas, and MediaWiki's load balancer sends most reads to replicas. It is textbook read scaling on top of single-leader replication." },
          ],
        },
        {
          type: "keypoints",
          items: [
            "Replication buys lower latency, higher availability and more read throughput. It does <strong>not</strong> buy write throughput.",
            "Everything hard comes from changes, and from the window in which copies disagree.",
            "Three families: single-leader, multi-leader, leaderless. Two recurring dials: synchronous vs asynchronous, and what to do with failed or lagging replicas.",
            "A replica is not a backup: it faithfully replicates mistakes. Keep point-in-time backups.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>'Why would you add replicas?' sounds like a warm-up, but interviewers use it to check whether you know the limits. A strong answer names the three benefits and immediately adds that replicas don't raise write throughput (that takes partitioning) and don't replace backups. Then it turns the question into decisions: which reads can tolerate staleness, how much data you can afford to lose if the leader dies (which decides synchronous vs asynchronous), and whether you need writes in more than one region (which decides single-leader vs multi-leader).</p>`,
        },
        {
          type: "quiz",
          q: "Your database spends 85% of its CPU on reads and 5% on writes. A colleague proposes adding three asynchronous read replicas. Which goal will that NOT help with?",
          options: [
            "Serving more read queries per second",
            "Handling ten times more writes per second next year",
            "Serving reads from a region closer to some users",
            "Keeping a recent copy of the data if the primary's disk dies",
          ],
          answer: 1,
          explain: "Every replica must apply every write, so write capacity is still bounded by what one node can apply, plus replication overhead; scaling writes needs partitioning (Chapter 6). D is the tempting wrong pick because asynchronous replicas can lag, but a lagging replica is still a recent copy: only the last unreplicated moments are at risk, instead of everything since the last backup.",
        },
      ],
    },
    // ------------------------------------------------------------------ 2
    {
      id: "leaders-and-followers",
      title: "One leader, many followers: who waits for whom",
      kicker: "Single-leader replication",
      concepts: ["single-leader-replication", "synchronous-vs-asynchronous-replication", "semi-synchronous-replication"],
      blocks: [
        {
          type: "problem",
          html: `<p>Let every replica accept writes independently and two of them can apply the same pair of updates, say <em>set balance to 0</em> and <em>add 50</em>, in opposite orders. One replica ends with 50, the other with 0, and neither knows anything is wrong. The simplest cure is to let exactly <strong>one node decide the order</strong> of all writes.</p>
<p>That immediately raises a second question: when does that node tell the client "OK"? If it waits for every follower, one slow or dead follower stalls every write in the system. If it waits for none, the client can be told "saved" for a write that exists on exactly one machine, which may die a millisecond later.</p>`,
        },
        {
          type: "idea",
          html: `<p>Route every write through one <strong>leader</strong> that streams an ordered change log to its <strong>followers</strong>. The one real dial is how many followers must confirm a write before the client hears OK, and that dial trades latency and availability against durability.</p>`,
        },
        {
          type: "text",
          html: `<h3>How it works</h3>
<p>One replica is designated the <strong>leader</strong> (also called primary or master). Clients send every write to it. The leader applies the write to its own storage and appends it to its <strong>replication log</strong>, also called the change stream. The other replicas, the <strong>followers</strong> (secondaries, read replicas, standbys), consume that log and apply the changes in exactly the same order. Because there is a single order, the followers converge on the leader's data and two writes can never conflict.</p>
<p>Writes are accepted only by the leader; reads can go to the leader or to any follower. (In PostgreSQL, <em>hot standby</em> specifically means a standby that also answers read-only queries; a warm standby only waits to take over.)</p>
<p>This is the default design in relational databases: PostgreSQL streaming replication, MySQL, Oracle Data Guard and SQL Server Always On availability groups all work this way. So do MongoDB replica sets, every Kafka partition (one leader replica, several followers) and replicated block devices such as DRBD.</p>
<h3>Who waits for whom</h3>
<p>Say a user changes their profile picture. The leader receives the update and forwards it to two followers. Follower 1 is <strong>synchronous</strong>: the leader waits until F1 confirms it has the change before telling the user "saved". Follower 2 is <strong>asynchronous</strong>: the leader sends the change and moves on without waiting. Usually both finish within milliseconds, but nothing guarantees that. A follower recovering from a crash, a saturated network or a busy disk can stretch it to seconds or minutes.</p>
<p>In the simulation below, a client (blue) writes to the leader (violet), which replicates to two followers (cyan). Each node shows the tail of its log. A square turns green once the client has been told OK, and an acknowledged write that so far exists <em>only</em> on the leader gets a dashed amber outline: it is at risk. F2 sits behind a slow link (300 ms round trip against F1's 4 ms). Switch between the three modes and try two things: make the system lose a write it acknowledged, then make it stop accepting writes altogether.</p>`,
        },
        {
          type: "viz",
          id: "ch5/sync-async",
          title: "Sync, semi-sync and async replication",
          caption: "Try Async: press Write twice, and as soon as both new squares turn green, press Crash leader. Notice the red squares on the old leader: writes the client was told succeeded, gone after failover. Reset, pick Sync and Crash F2: the next Write blocks until you revive F2. In Semi-sync, Crash F1 and watch F2 take over as the synchronous follower.",
        },
        {
          type: "text",
          html: `<p>Those two failures bracket the whole design space.</p>
<p><strong>Fully synchronous</strong> replication guarantees every follower has every acknowledged write, so failing over can never lose data. But the leader has to block whenever <em>any</em> follower fails to answer, whether from a crash, a network blip or a slow disk. With three followers you have three ways to halt every write in the system, so making all followers synchronous is impractical. Latency suffers too: the leader commits locally (call it 1 ms) and then waits for the <em>slowest</em> follower it depends on. In the simulation that is 1 + max(4, 300) = <strong>301 ms</strong> per write, all because of one slow link. This is tail latency amplification from Chapter 1: the more nodes you wait for, the likelier one of them is having a bad moment.</p>
<p><strong>Fully asynchronous</strong> replication never blocks: the client hears OK right after the leader's local commit. The price is durability. An acknowledged write may exist on exactly one machine, and if that machine dies before shipping it, a promoted follower will not have it. Giving up durability sounds like a bad deal, yet fully asynchronous replication is extremely common, especially with many followers or with followers in distant regions, where waiting would be slow.</p>
<p><strong>Semi-synchronous</strong> replication, as the book defines it, sits in between: exactly one follower is synchronous and the rest are asynchronous. If the synchronous follower becomes unavailable or slow, one of the asynchronous followers is made synchronous instead. You always have an up-to-date copy on at least two nodes, without depending on any particular follower being healthy. A close relative is waiting for <em>any k of n</em> followers: the leader takes the fastest acknowledgements, so a single slow follower no longer dictates latency.</p>
<h3>What vendors actually ship</h3>
<p>"Semi-sync" means different things in different products, and the differences surface exactly during an outage.</p>
<ul>
<li><strong>MySQL semi-synchronous replication</strong> waits for an acknowledgement from <em>any</em> <code>rpl_semi_sync_master_wait_for_slave_count</code> replicas (default 1). If none answers within <code>rpl_semi_sync_master_timeout</code> (default 10,000 ms), it silently reverts to asynchronous replication and keeps committing. That bounds latency, but durability is quietly downgraded at the very moment something is already wrong. Since 5.7 the default wait point is <code>AFTER_SYNC</code> (often called lossless semi-sync): the leader waits for the acknowledgement before committing in the storage engine, so no other session can see a write that no replica has. MySQL 8.0.26 introduced new names (<code>rpl_semi_sync_source_*</code>) and deprecated the old ones.</li>
<li><strong>PostgreSQL</strong> lists synchronous standbys in <code>synchronous_standby_names</code>. <code>FIRST 1 (s1, s2)</code> waits for the highest-priority connected standby, so if s1 disappears s2 takes over the synchronous role: the book's semi-sync. <code>ANY 2 (s1, s2, s3)</code> (quorum commit, since version 10) waits for any two. PostgreSQL never degrades to asynchronous by itself: if no synchronous standby is connected, commits wait indefinitely.</li>
</ul>
<p>PostgreSQL also lets each transaction choose how far its commit must travel before the client hears OK, through <code>synchronous_commit</code>. The ladder is worth knowing because it separates <em>durable</em> from <em>visible</em>: the default level guarantees the standby has your write on disk, not that a query on the standby can see it yet.</p>`,
        },
        {
          type: "table",
          title: "PostgreSQL synchronous_commit, from fastest to safest",
          headers: ["Setting", "Client hears OK once…", "Survives losing the leader for good?", "Read on the standby sees it?"],
          rows: [
            ["<code>off</code>", "the commit is recorded in the leader's memory; the WAL flush follows a moment later", "No. Even a crash and restart of the leader can lose the last few commits", "Not guaranteed"],
            ["<code>local</code>", "the leader has flushed the WAL to its own disk", "No: the standby may not have received it", "Not guaranteed"],
            ["<code style='white-space:nowrap'>remote_write</code>", "the standby has received the WAL and handed it to its operating system", "Yes, unless the standby's OS also crashes before flushing", "Not guaranteed"],
            ["<code>on</code> (default)", "the standby has flushed the WAL to durable storage", "Yes", "Not guaranteed: flushed is not yet applied"],
            ["<code style='white-space:nowrap'>remote_apply</code> (9.6+)", "the standby has applied the commit", "Yes", "Yes"],
          ],
          note: "Assumes synchronous_standby_names names at least one standby. Without one, local, remote_write and remote_apply all behave like on for the leader alone. Even off never corrupts the database; it can only lose the most recent commits.",
        },
        {
          type: "compare",
          title: "Who must confirm before the client hears OK?",
          items: [
            { title: "Asynchronous", tone: "warn", html: "<strong>Waits for:</strong> nobody.<br><strong>Latency:</strong> the local commit.<br><strong>Risk:</strong> acknowledged writes in the leader's unreplicated tail vanish on failover.<br><strong>Typical use:</strong> many read replicas, cross-region replicas." },
            { title: "Semi-synchronous", tone: "ok", html: "<strong>Waits for:</strong> one follower, replaced if it fails.<br><strong>Latency:</strong> one follower round trip.<br><strong>Guarantee:</strong> every acknowledged write is on at least two nodes." },
            { title: "Fully synchronous", tone: "bad", html: "<strong>Waits for:</strong> every follower.<br><strong>Latency:</strong> the slowest follower's round trip.<br><strong>Risk:</strong> any one failed follower stops all writes." },
            { title: "Quorum or majority", tone: "info", html: "<strong>Waits for:</strong> any k of n, often a majority.<br><strong>Latency:</strong> the k-th fastest round trip, so one slow node is hidden.<br><strong>Seen in:</strong> PostgreSQL <code>ANY n</code>, MongoDB <code>w: majority</code>, Raft and Paxos." },
          ],
        },
        {
          type: "text",
          html: `<p>Two refinements are worth knowing by name. <strong>Chain replication</strong> arranges the replicas in a line: writes enter at the head and flow down the chain, and reads are served by the tail, which only ever holds fully replicated data. It provides strong consistency with good throughput (van Renesse and Schneider, 2004). And <strong>consensus</strong> protocols such as Raft and Paxos (Chapter 9) are, mechanically, single-leader replication of a log in which an entry counts as committed once a <em>majority</em> of nodes have it: quorum-synchronous replication plus a safe way to choose the next leader.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book was written, consensus-replicated logs have become the usual choice for new distributed databases. etcd, CockroachDB, TiKV and YugabyteDB all replicate through Raft, and MongoDB's replica-set protocol has been Raft-like since 3.2. Kafka replaced ZooKeeper with its own Raft quorum (KRaft) for cluster <em>metadata</em>, while partition data still replicates through the in-sync replica set.</p>
<p>Defaults moved toward durability as well: Kafka 3.0 (2021) made <code>acks=all</code> with idempotence the producer default, and MongoDB 5.0 (2021) made <code>w: majority</code> the default write concern. Asynchronous acknowledgement is increasingly something you opt into, not something you get by accident.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "PostgreSQL", tag: "per-transaction dial", html: "Because <code>synchronous_commit</code> can be set per session or per transaction, one cluster can mix guarantees: a payment transaction waits for <code>remote_apply</code> on the standby while a bulk analytics insert uses <code>local</code>. The standby set itself is <code>FIRST 1 (s1, s2)</code> (the book's semi-sync) or <code>ANY k (…)</code> (quorum commit)." },
            { org: "MySQL", tag: "silent fallback", html: "After <code>rpl_semi_sync_master_timeout</code> (default 10 seconds) with no replica acknowledgement, the primary keeps committing asynchronously, then returns to semi-sync once a replica catches up. The <code>Rpl_semi_sync_master_status</code> status variable (<code>…_source_status</code> in newer releases) tells you which mode you are actually in; alert on it." },
            { org: "Apache Kafka", tag: "ISR", html: "Each partition has a leader and followers. The in-sync replica set (ISR) holds the followers that are keeping up; with <code>acks=all</code> a write commits once every ISR member has it, and <code>min.insync.replicas</code> refuses writes if the ISR shrinks too far. Kafka 3.0 made <code>acks=all</code> the producer default." },
            { org: "Amazon RDS Multi-AZ", tag: "sync standby", html: "Classic Multi-AZ instance deployments replicate synchronously to a standby in a second Availability Zone, which serves no reads and exists to take over. AWS documents failovers as typically completing in one to two minutes." },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "Waiting for followers buys",
          consLabel: "Waiting for followers costs",
          pros: [
            "No acknowledged write is lost when the leader dies, as long as a follower it waited for survives.",
            "Failover can be automatic without a data-loss judgment call: the synchronous follower is known to be current.",
            "With an apply-level wait (PostgreSQL <code>remote_apply</code>), reads on that follower see the write.",
          ],
          cons: [
            "Every write pays the round trip to the slowest follower it waits for: a fraction of a millisecond inside a datacenter, tens to hundreds of milliseconds across continents.",
            "A dead or slow synchronous follower stalls writes, unless the system re-designates another follower (semi-sync) or quietly gives up (MySQL's timeout).",
            "The more followers you wait for, the likelier one of them is slow right now: tail latency amplification (Chapter 1).",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Expect: <em>"Your primary database dies. How much data can you lose?"</em> A strong answer ties the replication mode to a recovery point objective. With asynchronous replication the answer is "whatever had not shipped yet", bounded by the replication lag. With a synchronous or quorum standby it is zero, paid for with write latency and the risk of stalls.</p>
<p>Then describe the common production mix: one synchronous (or <code>ANY 1</code> of two) standby in the same region for durability, plus asynchronous replicas elsewhere for reads and disaster recovery. Extra credit for knowing that MySQL's semi-sync silently falls back to asynchronous after a timeout, and that "synchronous" in PostgreSQL means flushed on the standby, not applied, unless you choose <code>remote_apply</code>.</p>`,
        },
        {
          type: "quiz",
          q: "A leader has two followers in the book's semi-synchronous setup: F1 is synchronous, F2 asynchronous. F1's disk starts taking seconds per write. What should a correct semi-sync implementation do?",
          options: [
            "Block all writes until F1 recovers, to preserve durability",
            "Make F2 the synchronous follower, so writes continue and still land on two nodes",
            "Keep acknowledging writes from the leader alone until F1 recovers",
            "Promote F2 to leader",
          ],
          answer: 1,
          explain: "Semi-sync promises two up-to-date copies without depending on one particular follower, so another follower takes over the synchronous role. A is fully synchronous behaviour: one sick node halts everything. C is tempting because it is what MySQL's semi-sync actually does after its timeout (it degrades to asynchronous), which is exactly why that setting bounds latency rather than guaranteeing durability. D confuses a follower's problem with the leader's: promotion is failover, and the leader is healthy.",
        },
      ],
    },
    // ------------------------------------------------------------------ 3
    {
      id: "node-outages",
      title: "Adding followers and surviving crashes: why failover is the dangerous part",
      kicker: "Operations",
      concepts: ["new-follower-setup", "catch-up-recovery", "failover", "split-brain"],
      blocks: [
        {
          type: "problem",
          html: `<p>Nodes go down all the time: disks fail, kernels panic, and every security patch means a reboot. You want to add, restart and replace replicas without ever stopping the database. Copying the data files to a new machine doesn't work while writes are flowing (the copy is torn across time), and locking the database for the hours a copy takes is just downtime by another name.</p>
<p>Follower restarts turn out to be routine. The hard case is the leader. When it dies, something must notice, pick a successor and redirect every client, and each step has a sharp edge: the successor may be missing writes, the old leader may come back still convinced it is in charge, and an over-eager timeout can set all of this off during a mere load spike.</p>`,
        },
        {
          type: "idea",
          html: `<p>Everything hinges on <strong>log positions</strong>. A snapshot tied to a position bootstraps a new follower; a remembered position lets a restarted follower catch up; and the leader's unreplicated tail beyond the followers' positions is exactly what a failover can lose.</p>`,
        },
        {
          type: "steps",
          title: "Adding a follower without downtime",
          items: [
            "<strong>Take a consistent snapshot</strong> of the leader without locking it. Most databases already do this for backups: <code>pg_basebackup</code> for PostgreSQL; Percona XtraBackup or the CLONE plugin (8.0.17+) for MySQL.",
            "<strong>Record the exact log position</strong> the snapshot corresponds to: a log sequence number (LSN) in PostgreSQL, binlog coordinates or a GTID set in MySQL. Every change up to that point is in the snapshot; nothing after it is.",
            "<strong>Copy the snapshot</strong> to the new follower's machine. For a large database this can take hours, and the leader keeps accepting writes the whole time.",
            "<strong>Request every change since that position</strong> and apply the backlog. Once the backlog is gone the follower has <strong>caught up</strong> and streams new changes like any other follower.",
          ],
        },
        {
          type: "diagram",
          title: "Bootstrapping a follower: snapshot plus log",
          caption: "The snapshot's log position splits history in two. Everything up to 5000 arrives as copied files; everything after 5000 arrives by replaying the leader's log. If the leader has already discarded entry 5001 by the time the copy finishes, the follower can never catch up and you have to start over.",
          svg: `<style>.ch5d-n{display:none!important}@media (max-width:600px){.ch5d-w{display:none!important}.ch5d-n{display:block!important}}</style>
<svg class="ch5d-w" viewBox="0 0 640 200" role="img" aria-label="A new follower is built from a snapshot at log position 5000 and then replays entries 5001 onward">
<defs>
<marker id="ch5-boot-w-v" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
<marker id="ch5-boot-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker>
</defs>
<text x="14" y="37" font-size="13" font-weight="700">Leader log</text>
<rect x="100" y="18" width="54" height="28" rx="5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="127" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">4998</text>
<rect x="158" y="18" width="54" height="28" rx="5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="185" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">4999</text>
<rect x="216" y="18" width="54" height="28" rx="5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="243" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5000</text>
<rect x="274" y="18" width="54" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="301" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5001</text>
<rect x="332" y="18" width="54" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="359" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5002</text>
<rect x="390" y="18" width="54" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="417" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5003</text>
<rect x="448" y="18" width="54" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="475" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5004</text>
<rect x="506" y="18" width="54" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="533" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5005</text>
<rect x="564" y="18" width="54" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="591" y="37" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">5006</text>
<line x1="100" y1="56" x2="270" y2="56" stroke-width="2" style="stroke: var(--viz-c1)"/>
<line x1="100" y1="51" x2="100" y2="61" stroke-width="2" style="stroke: var(--viz-c1)"/>
<line x1="270" y1="51" x2="270" y2="61" stroke-width="2" style="stroke: var(--viz-c1)"/>
<text x="185" y="76" text-anchor="middle" font-size="12" font-weight="600" style="fill: var(--viz-c1)">snapshot @ position 5000</text>
<line x1="274" y1="56" x2="618" y2="56" stroke-width="2" style="stroke: var(--viz-warn)"/>
<line x1="274" y1="51" x2="274" y2="61" stroke-width="2" style="stroke: var(--viz-warn)"/>
<line x1="618" y1="51" x2="618" y2="61" stroke-width="2" style="stroke: var(--viz-warn)"/>
<text x="446" y="76" text-anchor="middle" font-size="12" font-weight="600" style="fill: var(--viz-warn)">written while the snapshot was copied</text>
<path d="M185,84 L185,160 L374,160" stroke-width="1.5" style="fill: none; stroke: var(--viz-c1)" marker-end="url(#ch5-boot-w-v)"/>
<text x="195" y="150" font-size="12">1 · copy the snapshot</text>
<line x1="446" y1="84" x2="446" y2="127" stroke-width="1.5" style="stroke: var(--viz-warn)" marker-end="url(#ch5-boot-w-a)"/>
<text x="456" y="110" font-size="12">2 · stream 5001…5006</text>
<rect x="378" y="132" width="240" height="56" rx="10" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="498" y="155" text-anchor="middle" font-size="13" font-weight="700">New follower</text>
<text x="498" y="176" text-anchor="middle" font-size="12" font-weight="600" style="fill: var(--viz-ok)">✓ caught up, now streams live</text>
</svg>
<svg class="ch5d-n" viewBox="0 0 360 320" role="img" aria-label="A new follower is built from a snapshot at log position 5000 and then replays entries 5001 onward">
<defs>
<marker id="ch5-boot-n-v" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
<marker id="ch5-boot-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker>
</defs>
<text x="14" y="22" font-size="15" font-weight="700">Leader log</text>
<rect x="14" y="32" width="44" height="28" rx="5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="36" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">4999</text>
<rect x="62" y="32" width="44" height="28" rx="5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="84" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">5000</text>
<rect x="110" y="32" width="44" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="132" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">5001</text>
<rect x="158" y="32" width="44" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="180" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">5002</text>
<rect x="206" y="32" width="44" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="228" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">5003</text>
<rect x="254" y="32" width="44" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="276" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">5004</text>
<rect x="302" y="32" width="44" height="28" rx="5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="324" y="51" text-anchor="middle" font-size="14" style="font-family: var(--font-mono)">5005</text>
<line x1="14" y1="68" x2="106" y2="68" stroke-width="2" style="stroke: var(--viz-c1)"/>
<line x1="110" y1="68" x2="346" y2="68" stroke-width="2" style="stroke: var(--viz-warn)"/>
<text x="14" y="90" font-size="14" font-weight="600" style="fill: var(--viz-c1)">snapshot @ 5000</text>
<text x="236" y="90" text-anchor="middle" font-size="14" font-weight="600" style="fill: var(--viz-warn)">written during the copy</text>
<path d="M60,98 L60,280 L113,280" stroke-width="1.5" style="fill: none; stroke: var(--viz-c1)" marker-end="url(#ch5-boot-n-v)"/>
<text x="70" y="170" font-size="15">1 · copy the</text>
<text x="70" y="187" font-size="15">snapshot</text>
<line x1="228" y1="98" x2="228" y2="245" stroke-width="1.5" style="stroke: var(--viz-warn)" marker-end="url(#ch5-boot-n-a)"/>
<text x="238" y="170" font-size="15">2 · stream</text>
<text x="238" y="187" font-size="15">5001 onward</text>
<rect x="118" y="250" width="228" height="60" rx="10" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="232" y="274" text-anchor="middle" font-size="15" font-weight="700">New follower</text>
<text x="232" y="296" text-anchor="middle" font-size="15" font-weight="600" style="fill: var(--viz-ok)">✓ caught up, streams live</text>
</svg>`,
        },
        {
          type: "text",
          html: `<p>Step 4 hides a requirement: the leader must still <strong>have</strong> every log entry since the snapshot's position. Logs are not kept forever, or they would fill the disk. If copying the snapshot takes six hours and the leader keeps only one hour of log, the new follower can never catch up and you start again.</p>
<h3>Follower failure: catch-up recovery</h3>
<p>The same requirement governs ordinary follower failures. Each follower keeps, on its own disk, the changes it has received and the position up to which it has applied them. When it restarts after a crash, a patch reboot or a network outage, it connects to the leader, asks for everything after that position, applies the backlog and resumes streaming. This <strong>catch-up recovery</strong> is why follower restarts are routine: as long as the leader still holds the missing stretch of log, nothing special is needed. (Try it in the simulation in the previous section: crash a follower, write a few times, then revive it.)</p>
<p>Databases differ in how they make sure that stretch of log still exists. PostgreSQL's <strong>replication slots</strong> (9.4) make the primary keep WAL until each registered replica has consumed it. The danger is that a replica which disappears pins WAL on the primary until its disk fills; PostgreSQL 13 added <code>max_slot_wal_keep_size</code> to cap that. Without slots, <code>wal_keep_size</code> (<code>wal_keep_segments</code> before 13) keeps a fixed amount. MongoDB's oplog is a fixed-size capped collection: a secondary that is offline for longer than the oplog window "falls off the oplog" and needs a full resync.</p>
<p>GitLab's January 2017 outage started exactly here. Under unusually high load (partly from spam), a PostgreSQL secondary fell so far behind that the WAL it needed had already been removed from the primary, so engineers had to re-seed it from scratch with <code>pg_basebackup</code>. In the middle of that work, the primary's data directory was deleted by mistake.</p>`,
        },
        {
          type: "callout",
          tone: "tip",
          title: "Rule of thumb: size the log for your worst day",
          html: `<p>Keep enough log to cover the longest follower outage you want to recover from without a re-seed, plus the time a full re-seed takes, and alert on it. PostgreSQL's <code>pg_replication_slots</code> view shows which slots are holding WAL back; MongoDB's <code>rs.printReplicationInfo()</code> reports the oplog window. A forgotten slot belonging to a decommissioned replica is a classic way to fill a primary's disk.</p>`,
        },
        {
          type: "text",
          html: `<h3>Leader failure: failover</h3>
<p>Losing the leader is harder. A follower must be promoted to leader, clients must send their writes to it, and the remaining followers must start consuming its log. This is <strong>failover</strong>. An administrator can do it by hand, or the system can do it automatically in three steps:</p>
<ol>
<li><strong>Decide that the leader has failed.</strong> Nothing can reliably tell a crashed leader from a paused or unreachable one, so systems use a timeout: nodes exchange heartbeats, and a leader that stays silent for, say, 30 seconds (the book's example; MongoDB's default election timeout is 10 seconds) is presumed dead.</li>
<li><strong>Choose a new leader.</strong> Either the remaining replicas elect one, or a previously chosen controller node appoints one. The best candidate is the replica with the most up-to-date data, which minimizes loss. Getting every node to agree on that choice is a consensus problem (Chapter 9).</li>
<li><strong>Reconfigure the system.</strong> Clients must send writes to the new leader, and if the old leader comes back it has to accept that it is now a follower.</li>
</ol>
<p>Every step has a sharp edge:</p>
<ul>
<li><strong>The unreplicated tail is lost.</strong> With asynchronous replication the new leader may lack the old leader's last few writes. If the old leader rejoins, those writes conflict with what the new leader has done since, and the usual answer is to discard them. Writes the client was told were durable silently disappear.</li>
<li><strong>Discarding is dangerous when anything outside the database saw those writes.</strong> In a 2012 GitHub incident, an out-of-date MySQL follower was promoted. Its auto-increment counter lagged the old leader's, so it handed out primary keys the old leader had already used. Those keys were also used in Redis, the two stores disagreed, and some private data was shown to the wrong users.</li>
<li><strong>Split brain.</strong> Two nodes can both believe they are the leader, typically because the old one was cut off rather than dead. If both accept writes and nothing merges them, data is lost or corrupted. Some systems have a safety catch that shuts one node down when two leaders are detected, known as <strong>STONITH</strong> ("shoot the other node in the head"), but a carelessly designed mechanism can shut down both.</li>
<li><strong>The timeout is a dilemma.</strong> Too long, and every real failure means more seconds of failed writes. Too short, and a load spike or network glitch that merely delays heartbeats triggers a failover nobody needed, piling reconnections and resynchronization onto a system that was already struggling.</li>
</ul>
<p>The simulation below plays three failure stories step by step. <em>Lost writes</em> shows the unreplicated tail disappearing, <em>Reused IDs</em> is a simplified reconstruction of the GitHub incident, and <em>Split brain</em> shows two leaders accepting writes at once. The first and third stories have a toggle that switches on the defence: a synchronous follower, or fencing.</p>`,
        },
        {
          type: "viz",
          id: "ch5/failover",
          title: "When failover goes wrong",
          caption: "Pick a story and press Play. Run Lost writes and Split brain twice, with the toggle off and then on (Reused IDs has no defence to switch on). Notice that in Lost writes the new leader reuses #42 for a different write, that in Reused IDs nothing inside the database looks wrong, and that in Split brain the Leaders counter reaches 2 unless fencing is on.",
        },
        {
          type: "text",
          html: `<p>In all three stories the database followed its own rules perfectly. <em>Lost writes</em> lost data because an asynchronous acknowledgement promises less than clients assume; the synchronous follower fixed it by paying a round trip on every write. <em>Reused IDs</em> shows that throwing away writes is never a purely local act: anything that copied an ID, sent an email or charged a card is now out of step with the rewritten history. <em>Split brain</em> shows that a timeout cannot distinguish "dead" from "unreachable", so the old leader has to be actively stopped, not merely presumed gone.</p>
<p>Because of these risks, some operations teams prefer to fail over by hand even when their software can do it automatically. A human can check how far behind each follower is, and whether the old leader is really dead, before choosing. The cost is minutes of write downtime while someone is paged.</p>
<p>None of these problems belongs to one product. Any system spread across machines has to live with crashes and unreliable networks, and has to trade consistency and durability against availability and latency. Chapter 8 explains why a timeout can never tell slow from dead and how <a href="#/ch8/learn/fencing-tokens">fencing tokens</a> stop a deposed leader from doing damage; Chapter 9 shows how <a href="#/ch9/learn/consensus">consensus makes leader election safe</a>.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "GitHub", year: "2012", tag: "reused keys", html: "The incident behind the <em>Reused IDs</em> story above. Inside MySQL the promotion looked clean: the new leader simply handed out keys it believed were unused. The damage lived <em>between</em> systems, because Redis already held data under those keys, and some private data reached the wrong users (as described in DDIA, citing GitHub's write-up)." },
            { org: "GitHub", year: "2018", tag: "cross-region failover", html: "A 43-second loss of connectivity between the US East Coast network hub and the primary East Coast data center led Orchestrator to promote West Coast database primaries. Both sides then held writes the other lacked, and GitHub accepted 24 hours 11 minutes of degraded service to reconcile them without losing data." },
            { org: "MongoDB and Kafka", tag: "discarded writes", html: "MongoDB <em>rolls back</em> writes that a former primary accepted but never replicated to a majority, saving them to rollback files when it rejoins; writes acknowledged with <code>w: majority</code> are not rolled back. Kafka's <code>unclean.leader.election.enable</code> (default false since 0.11) decides whether an out-of-sync replica may become leader: an explicit choice between availability and losing committed messages." },
            { org: "Elasticsearch", year: "2019", tag: "split brain", html: "Before 7.0, clusters had to set <code>discovery.zen.<wbr>minimum_master_nodes</code> to a majority of master-eligible nodes; get it wrong and a partition could elect two masters. Version 7.0 replaced this with a new cluster-coordination layer that manages the voting quorum automatically." },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Failover has been hardened a great deal since the book. The common recipe today:</p>
<ul>
<li><strong>Elect through a majority, with terms.</strong> Raft-based databases, MongoDB replica sets, Patroni for PostgreSQL (which elects the primary through a distributed configuration store such as etcd, Consul, ZooKeeper or Kubernetes) and GitHub's Orchestrator (which can run Raft among its own nodes) all require a majority to agree, so two leaders cannot win the same term.</li>
<li><strong>Commit on a majority.</strong> A write acknowledged by a majority is on at least one member of every future majority, so a correctly elected new leader always has it.</li>
<li><strong>Refuse risky promotions.</strong> Patroni's <code>maximum_lag_on_failover</code> stops a replica that is too far behind from being promoted, choosing a longer outage over lost data.</li>
<li><strong>Rejoin cleanly.</strong> <code>pg_rewind</code> (PostgreSQL 9.5+) turns a diverged former primary back into a follower without a full re-copy.</li>
</ul>
<p>Even then, an old leader that was merely paused can wake up and act on stale beliefs. Leases and fencing tokens (Chapter 8) are what stop it.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "Automatic failover gives you",
          consLabel: "Automatic failover risks",
          pros: [
            "Recovery in seconds, instead of however long it takes to page a human at 3 a.m.",
            "Rehearsed, predictable behaviour, rather than a tired operator deciding under pressure.",
            "Combined with majority commit, failover that loses no acknowledged writes.",
          ],
          cons: [
            "With asynchronous replication, any automatic failover may discard the old leader's unreplicated writes.",
            "False positives: a long GC pause, a load spike or a brief network glitch looks like death, and an unnecessary failover adds load.",
            "Split brain if the old leader is not fenced, and divergent histories when a brief partition triggers a cross-region failover (GitHub, 2018).",
            "Systems outside the database (caches, search indexes, other stores) can disagree with the new history.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"What happens when the leader dies?" is the standard follow-up to any single-leader design. Walk the three steps (detect by timeout, elect the most up-to-date replica, redirect clients), then volunteer the dangers: lost asynchronous writes, outside systems out of step, split brain, and the timeout dilemma.</p>
<p>Interviewers then probe. <em>How do you prevent split brain?</em> Elect through a majority so two leaders cannot both win, and fence the old one so it cannot act on a stale belief: STONITH, or epoch numbers that storage and downstream services check (fencing tokens). <em>How do you avoid losing writes?</em> Make at least one follower synchronous or commit on a majority, and refuse to promote replicas that lag beyond a threshold. Weak answers stop at "a follower takes over".</p>`,
        },
        {
          type: "quiz",
          q: "To cut failover time, a team lowers the leader-failure timeout from 30 s to 2 s. During the next traffic spike, the busy leader takes 3 s to answer heartbeats. What is the most likely outcome?",
          options: [
            "Faster recovery, since the leader really was failing",
            "An unnecessary failover that adds work to an already overloaded cluster and, with asynchronous replication, may discard the old leader's latest writes",
            "Nothing, because heartbeats are tiny and unaffected by load",
            "Split brain becomes impossible because failures are detected sooner",
          ],
          answer: 1,
          explain: "A slow leader is not a dead leader, but a timeout cannot tell the difference. Promoting a new leader under load forces clients to reconnect and followers to resynchronize, making things worse, and any unreplicated writes on the old leader are at risk. A is the tempting answer if you equate 'slow to respond' with 'failing'. D has it backwards: an aggressive timeout makes it more likely that a still-alive leader is replaced, which is exactly how split brain starts.",
        },
      ],
    },
    // ------------------------------------------------------------------ 4
    {
      id: "replication-logs",
      title: "What actually travels from leader to follower",
      kicker: "Mechanism",
      concepts: ["replication-log-types", "logical-replication"],
      blocks: [
        {
          type: "problem",
          html: `<p>"Ship the changes to the followers" sounds obvious until you have to pick a format. Ship the SQL statements? Then <code>NOW()</code>, <code>RAND()</code> and <code>UUID()</code> produce different values on each replica, an <code>UPDATE</code> that depends on existing rows must run in exactly the same order everywhere, and triggers fire their own side effects. Ship the storage engine's own write-ahead log? Then every follower must run a byte-compatible storage engine, which means the same major database version, so you cannot upgrade without downtime.</p>
<p>Every choice of format couples the follower to something on the leader. The question is what you are willing to be coupled to.</p>`,
        },
        {
          type: "idea",
          html: `<p>The replication log is an <strong>interface</strong> between leader and follower. The lower its level, the more exact the replay but the tighter the coupling. A <strong>logical, row-based log</strong> hits the sweet spot, and doubles as a change feed that other systems can consume.</p>`,
        },
        {
          type: "compare",
          title: "One change (user 42 logs in), four ways to ship it",
          items: [
            { title: "Statement", tone: "warn", html: "<code>UPDATE users SET last_login = NOW() WHERE id = 42</code><br><br><strong>Coupled to:</strong> every replica evaluating the statement identically: same function results, same row order, same triggers." },
            { title: "Physical WAL", tone: "warn", html: "<code>rel 16384 · block 917 · offset 112: 8 bytes 00 1f a3 …</code> (illustrative)<br><br><strong>Coupled to:</strong> the on-disk page format, which in practice means the same major version on both sides." },
            { title: "Logical row", tone: "ok", html: "<code>UPDATE users key(id=42) SET last_login = '2017-03-01 10:00:00.123'</code><br><br><strong>Coupled to:</strong> only the table's schema. Other programs can read it too." },
            { title: "Trigger-based", tone: "info", html: "<code>INSERT INTO change_log(tbl, pk, payload) VALUES ('users', 42, …)</code><br><br><strong>Coupled to:</strong> your own trigger code and the process that ships the table. Maximum flexibility, maximum overhead." },
          ],
        },
        {
          type: "text",
          html: `<h3>Statement-based replication</h3>
<p>The simplest scheme: the leader logs every write <em>statement</em> it executes (<code>INSERT</code>, <code>UPDATE</code>, <code>DELETE</code>), and each follower runs the same SQL as if a client had sent it. The log is compact and readable. But replay is only correct if every replica gets the same result from the same statement, and three things break that:</p>
<ul>
<li><strong>Nondeterministic functions.</strong> <code>NOW()</code> returns a different time on each replica, <code>RAND()</code> a different number, <code>UUID()</code> a different ID.</li>
<li><strong>Order-dependent statements.</strong> An <code>UPDATE … WHERE</code> that depends on existing rows, or an <code>INSERT</code> that takes the next auto-increment value, must run in exactly the same order on every replica. That limits how many transactions can execute concurrently.</li>
<li><strong>Side effects.</strong> Triggers, stored procedures and user-defined functions may do different things on each replica unless they are perfectly deterministic.</li>
</ul>
<p>The leader can patch some of this by substituting fixed values when it logs a statement. MySQL, for instance, records each statement's timestamp, so <code>NOW()</code> replays identically. Statements it cannot fix, such as those calling <code>UUID()</code> or <code>SYSDATE()</code>, or <code>UPDATE … LIMIT</code> without <code>ORDER BY</code>, are classified as <em>unsafe</em>.</p>
<p>MySQL replicated statements exclusively until 5.1 added row-based logging; <code>MIXED</code> mode logs statements but switches to row format for unsafe ones, and row format became the default in 5.7.7. Statement shipping still works where determinism is enforced by design: VoltDB replicates statements safely because it requires transactions to be deterministic.</p>
<h3>Write-ahead log shipping</h3>
<p><a href="#/ch3/learn/write-ahead-log">Chapter 3</a> showed that storage engines already keep a log. A B-tree writes every modification to a write-ahead log (WAL) before touching its pages, and in a log-structured engine the log <em>is</em> the main storage. That log contains everything needed to rebuild the data, so the leader can simply send it to the followers, which then build exactly the same files. PostgreSQL streaming replication and Oracle work this way.</p>
<p>The catch is that the WAL describes changes at the lowest level: which bytes changed in which disk block. That ties replication to the storage engine's on-disk format. If a new database version changes the format, leader and followers cannot run different versions, so the classic zero-downtime upgrade (upgrade the followers first, then fail over to one of them) is impossible. A PostgreSQL streaming standby must run the same major version as its primary.</p>`,
        },
        {
          type: "diagram",
          title: "The replication-log ladder",
          caption: "The lower the level, the more exactly a follower reproduces the leader's state, and the more of the leader's internals it must share. Logical row changes are the usual sweet spot. Trigger-based replication sits outside the ladder: application code decides what to capture and can feed any target.",
          svg: `<style>.ch5d-n{display:none!important}@media (max-width:600px){.ch5d-w{display:none!important}.ch5d-n{display:block!important}}</style>
<svg class="ch5d-w" viewBox="0 0 640 214" role="img" aria-label="Statement, logical row and physical WAL replication ordered by level, plus trigger-based replication to the side">
<defs>
<marker id="ch5-log-w-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<line x1="30" y1="22" x2="30" y2="196" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#ch5-log-w-m)"/>
<text x="16" y="110" text-anchor="middle" font-size="12" transform="rotate(-90 16 110)" style="fill: var(--viz-muted)">more exact replay</text>
<rect x="50" y="20" width="390" height="54" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="66" y="42" font-size="14" font-weight="700">SQL statement</text>
<text x="66" y="62" font-size="12" style="fill: var(--viz-muted)">VoltDB · MySQL STATEMENT and MIXED</text>
<text x="428" y="42" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">highest level</text>
<rect x="50" y="82" width="390" height="54" rx="8" stroke-width="2" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="66" y="104" font-size="14" font-weight="700">Logical row change</text>
<text x="66" y="124" font-size="12" style="fill: var(--viz-muted)">MySQL ROW binlog · PG logical · MongoDB oplog</text>
<text x="428" y="104" text-anchor="end" font-size="12" font-weight="600" style="fill: var(--viz-c4)">sweet spot</text>
<rect x="50" y="144" width="390" height="54" rx="8" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="66" y="166" font-size="14" font-weight="700">Physical WAL (page bytes)</text>
<text x="66" y="186" font-size="12" style="fill: var(--viz-muted)">PostgreSQL streaming · Oracle</text>
<text x="428" y="166" text-anchor="end" font-size="12" style="fill: var(--viz-muted)">lowest level</text>
<line x1="458" y1="196" x2="458" y2="22" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#ch5-log-w-m)"/>
<text x="476" y="110" text-anchor="middle" font-size="12" transform="rotate(-90 476 110)" style="fill: var(--viz-muted)">looser coupling</text>
<rect x="494" y="20" width="136" height="92" rx="10" stroke-dasharray="5 4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="562" y="44" text-anchor="middle" font-size="13" font-weight="700">Trigger-based</text>
<text x="562" y="64" text-anchor="middle" font-size="12">application layer</text>
<text x="562" y="84" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Bucardo · Databus</text>
<line x1="562" y1="112" x2="562" y2="140" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#ch5-log-w-m)"/>
<rect x="494" y="144" width="136" height="54" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="562" y="176" text-anchor="middle" font-size="13">any target DB</text>
</svg>
<svg class="ch5d-n" viewBox="0 0 360 330" role="img" aria-label="Statement, logical row and physical WAL replication ordered by level, plus trigger-based replication">
<defs>
<marker id="ch5-log-n-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="14" y="20" font-size="14" style="fill: var(--viz-muted)">↑ looser coupling, readable by others</text>
<rect x="14" y="30" width="332" height="56" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="28" y="53" font-size="16" font-weight="700">SQL statement</text>
<text x="28" y="75" font-size="14" style="fill: var(--viz-muted)">VoltDB · MySQL STATEMENT, MIXED</text>
<rect x="14" y="94" width="332" height="56" rx="8" stroke-width="2" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="28" y="117" font-size="16" font-weight="700">Logical row change</text>
<text x="334" y="117" text-anchor="end" font-size="14" font-weight="600" style="fill: var(--viz-c4)">sweet spot</text>
<text x="28" y="139" font-size="14" style="fill: var(--viz-muted)">MySQL ROW · PG logical · MongoDB</text>
<rect x="14" y="158" width="332" height="56" rx="8" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="28" y="181" font-size="16" font-weight="700">Physical WAL (page bytes)</text>
<text x="28" y="203" font-size="14" style="fill: var(--viz-muted)">PostgreSQL streaming · Oracle</text>
<text x="14" y="236" font-size="14" style="fill: var(--viz-muted)">↓ more exact replay, tighter coupling</text>
<rect x="14" y="248" width="196" height="76" rx="10" stroke-dasharray="5 4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
<text x="112" y="272" text-anchor="middle" font-size="15" font-weight="700">Trigger-based</text>
<text x="112" y="293" text-anchor="middle" font-size="14">application layer</text>
<text x="112" y="312" text-anchor="middle" font-size="14" style="fill: var(--viz-muted)">Bucardo, Databus</text>
<line x1="212" y1="286" x2="243" y2="286" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#ch5-log-n-m)"/>
<rect x="248" y="258" width="98" height="56" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="297" y="282" text-anchor="middle" font-size="14">any target</text>
<text x="297" y="301" text-anchor="middle" font-size="14">database</text>
</svg>`,
        },
        {
          type: "text",
          html: `<h3>Logical (row-based) log</h3>
<p>The way out of the coupling is to use a different log format for replication than for storage: a <strong>logical log</strong> that describes changes at the granularity of rows.</p>
<ul>
<li>An inserted row: the new values of all its columns.</li>
<li>A deleted row: enough to identify it, normally the primary key (or, for a table without one, the old values of all columns).</li>
<li>An updated row: its identity plus the new values of all columns, or just the changed ones.</li>
</ul>
<p>A transaction that touches several rows becomes several such records followed by one marking the commit. MySQL's binlog in <code>ROW</code> format is the textbook example.</p>
<p>Because it says nothing about pages or bytes, a logical log decouples the follower from the leader's internals: they can run different versions, or even different storage engines. It is also easy for <em>other</em> programs to parse, so you can stream a database's changes into a data warehouse, a search index or a cache. That technique is <strong>change data capture</strong> (Chapter 11); Debezium, for example, reads the MySQL binlog and PostgreSQL's logical decoding stream. PostgreSQL added logical decoding in 9.4 and built-in publish/subscribe logical replication in 10, and teams routinely use it for major-version upgrades with near-zero downtime: replicate into a server running the new version, let it catch up, then switch traffic over.</p>
<p>MongoDB's oplog is a logical log with an extra property: its entries are <strong>idempotent</strong>. An <code>$inc</code> on the primary is recorded as a <code>$set</code> of the resulting value, so a secondary that applies the same entry twice, say after a crash in the middle of a batch, still ends up in the right state.</p>
<p>Logical logs have costs worth naming in an interview. One <code>UPDATE</code> that touches a million rows becomes a million log records. Tables need a primary key, or the log must carry full old-row images (PostgreSQL's <code>REPLICA IDENTITY FULL</code>). And PostgreSQL's built-in logical replication does not replicate schema changes (DDL): you apply them to subscribers yourself, which makes evolving the change stream's schema a Chapter 4 problem.</p>
<h3>Trigger-based replication</h3>
<p>Everything so far is done by the database itself. Sometimes you need more control: replicate only some tables or rows, replicate between different database products, or apply custom conflict-resolution logic. Then replication moves up into the application layer. Some tools read the database's log directly (Oracle GoldenGate can expose data changes to an application this way). Others use <strong>triggers</strong>: custom code that runs on every write and records the change in a separate table, from which an external process reads, transforms and applies it elsewhere. Databus for Oracle and Bucardo for PostgreSQL work like this. The flexibility costs more overhead than built-in replication, and such setups are more prone to bugs and odd limitations.</p>`,
        },
        {
          type: "table",
          title: "The four approaches side by side",
          headers: ["Method", "What travels", "Coupled to", "Typical trouble", "Examples"],
          rows: [
            ["Statement-based", "SQL text", "Identical evaluation on every replica", "Nondeterminism, ordering, side effects", "MySQL before 5.1 and MIXED mode, VoltDB"],
            ["WAL shipping", "Byte changes to disk pages", "Storage format, hence the major version", "No mixed-version upgrades; high bandwidth", "PostgreSQL streaming, Oracle"],
            ["Logical (row-based)", "One record per changed row", "The table schema only", "Bulk updates are large; needs keys; DDL not shipped (PostgreSQL)", "MySQL ROW binlog, PostgreSQL logical, MongoDB oplog"],
            ["Trigger-based", "Whatever your code records", "Your trigger code", "Overhead; bugs", "Bucardo, Databus"],
          ],
        },
        {
          type: "realworld",
          items: [
            { org: "MySQL", tag: "statement → row", html: "Row-based binary logging arrived in MySQL 5.1, and <code>binlog_format=ROW</code> became the default in 5.7.7. <code>MIXED</code> logs statements but switches to row format for statements MySQL classifies as unsafe for statement-based replication." },
            { org: "PostgreSQL", tag: "physical + logical", html: "Built-in streaming replication (9.0) ships physical WAL, so standbys must run the same major version. Logical decoding (9.4) and built-in logical replication (10) exist largely so changes can flow between different versions and out to external consumers." },
            { org: "Uber", year: "2016", tag: "WAL coupling", html: "Uber's post <em>Why Uber Engineering Switched from Postgres to MySQL</em> cited physical WAL replication among its reasons: high replication bandwidth caused by write amplification, and replicas having to run the same version, which made upgrades painful." },
            { org: "MongoDB", tag: "idempotent oplog", html: "Oplog entries are idempotent: operations such as <code>$inc</code> are rewritten into the resulting <code>$set</code> before they are recorded, so secondaries can safely re-apply entries." },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p><strong>Amazon Aurora</strong> pushes "ship the log" further than anyone. Its SIGMOD 2017 paper describes a database engine that sends only redo log records to a distributed storage service, which applies them to data pages itself in the background, replicated six ways across three Availability Zones. The engine never writes full pages over the network; in the paper's phrase, the log is the database.</p>
<p>Meanwhile, the logical log has become infrastructure in its own right. Change data capture tools such as Debezium turn a database's binlog or logical decoding stream into an event stream that feeds caches, search indexes and warehouses, which is the theme of Chapters 11 and 12.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "Why logical logs won",
          consLabel: "What they cost",
          pros: [
            "Leader and followers can run different versions, so upgrades and migrations need only a switchover.",
            "Readable by other systems: change data capture into caches, search indexes and warehouses.",
            "Deterministic replay: the leader records the result of each change, not the recipe.",
          ],
          cons: [
            "Bulk statements become one record per row, so a single <code>UPDATE</code> can produce a flood.",
            "Rows need a stable identity: a primary key, or full old-row images.",
            "Schema changes need their own path (PostgreSQL's built-in logical replication skips DDL).",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Two questions lead here. <em>"How would you upgrade a database across major versions with near-zero downtime?"</em> Physical replication can't help because the on-disk format differs, so set up logical replication into a new-version server, let it catch up, apply schema changes separately, then switch writes over. <em>"How do you keep a search index in sync with the database?"</em> Not by having the application write to both (the two writes can fail or interleave independently), but by consuming the database's logical log through change data capture.</p>
<p>A strong answer to either mentions bootstrapping (an initial snapshot tied to a log position, exactly like adding a follower), ordering per key, and idempotent consumers, because the stream will occasionally redeliver events.</p>`,
        },
        {
          type: "quiz",
          q: "You want to upgrade PostgreSQL across major versions with only seconds of downtime. Why won't it work to add a new-version standby through ordinary streaming replication and fail over to it?",
          options: [
            "Streaming replication is too slow to keep a standby current",
            "Streaming replication ships physical WAL describing on-disk page changes, which is tied to the storage format, so the standby must run the same major version; logical replication decouples the versions",
            "A newer version cannot parse the SQL statements stored in the WAL",
            "Streaming replication cannot cross datacenters",
          ],
          answer: 1,
          explain: "PostgreSQL's WAL is a physical log, so it is only meaningful to a server with the same on-disk format. C is the tempting mistake: it assumes the WAL contains SQL, but it contains no statements at all, only page-level changes. Logical replication ships row changes, which a server running a different version can apply.",
        },
      ],
    },
    // ------------------------------------------------------------------ 5
    {
      id: "replication-lag",
      title: "When followers fall behind: three anomalies with names",
      kicker: "Consistency",
      concepts: ["replication-lag", "eventual-consistency", "read-your-writes-consistency", "monotonic-reads", "consistent-prefix-reads"],
      blocks: [
        {
          type: "problem",
          html: `<p>Read scaling means adding followers and sending reads to them, and that only works with asynchronous replication: if every follower were synchronous, one failed node would stop all writes. So a read can land on a follower that has not yet applied a recent write. Usually the gap is a fraction of a second; under load or network trouble it grows to seconds or minutes.</p>
<p>Users then see impossible things. A comment they just posted is missing. A comment appears, then vanishes on refresh. An answer shows up before the question it answers. Telling them "it's eventually consistent" doesn't help, because "eventually" comes with no deadline.</p>`,
        },
        {
          type: "idea",
          html: `<p>You usually cannot remove lag, but you can promise each user specific guarantees (<strong>read-your-writes</strong>, <strong>monotonic reads</strong>, <strong>consistent prefix</strong>) by controlling which replica serves each read.</p>`,
        },
        {
          type: "text",
          html: `<h3>Lag is the price of read scaling</h3>
<p>Leader-based replication invites a simple design for read-heavy workloads: one leader for writes, many followers for reads. Add followers and read capacity grows. But it only works asynchronously; with synchronous followers, each node you added would be one more way for writes to stall, so the system would get <em>less</em> available as it grew.</p>
<p>So the same query, run at the same moment on the leader and on a follower, can return different answers. The inconsistency is temporary: stop writing, wait, and the followers catch up. That is <strong>eventual consistency</strong>, a term usually credited to Douglas Terry and colleagues and popularized by Werner Vogels. "Eventually" is deliberately vague: there is no limit on how far behind a replica may fall. In normal operation <strong>replication lag</strong> is a fraction of a second, but near capacity or during network problems it stretches to several seconds or even minutes.</p>
<p>Lag becomes a user-visible bug only when a read lands on a replica that is behind what <em>that reader</em> has already done or seen. Three versions of the bug are common enough to have names, and each has a guarantee that rules it out:</p>
<ul>
<li><strong>Read-your-writes:</strong> you never miss your own update.</li>
<li><strong>Monotonic reads:</strong> you never see time go backward.</li>
<li><strong>Consistent prefix:</strong> you never see an effect before its cause.</li>
</ul>
<p>The simulation draws each anomaly as a space-time diagram: time runs left to right, every actor gets a lane, and the dashed violet arrows are replication messages whose slope <em>is</em> the lag. Pick an anomaly, drag the lag slider until the outcome flips from green to red, then switch on the fix and see what it changes.</p>`,
        },
        {
          type: "viz",
          id: "ch5/replication-lag",
          title: "Replication lag anomalies",
          caption: "Try Read your writes with Fix off and drag the lag across 1.0 s: the outcome flips at exactly that point. Then try each fix. Notice that every fix is a rule about where a read may go, and that in Monotonic reads the pinned user reads from the slow follower: stale, but never backwards.",
        },
        {
          type: "table",
          title: "Three guarantees, one baseline",
          headers: ["Guarantee", "Rules out", "Common implementation", "Cost"],
          rows: [
            ["Read-your-writes", "You post a comment, reload, and it is missing", "Read your own recent changes from the leader, or wait for a replica that has reached your write's log position", "Leader load, cross-region round trips, slower reads while waiting"],
            ["Monotonic reads", "A comment appears, then vanishes on refresh", "Pin each user to one replica, for example by hash of user ID", "Reads can still be stale; the user must be rerouted if that replica fails"],
            ["Consistent prefix", "An answer appears before its question", "Send causally related writes through one partition's log, or track dependencies", "Constrains partitioning; dependency metadata"],
            ["Eventual consistency (baseline)", "Nothing in the moment; replicas converge once writes stop", "Plain asynchronous replication", "No bound on staleness"],
          ],
        },
        {
          type: "text",
          html: `<h3>Read-your-writes in practice</h3>
<p><strong>Read-after-write consistency</strong>, also called read-your-writes, promises users that they will always see updates <em>they</em> submitted. It promises nothing about other people's updates, which may still show up late. With leader-based replication there are several ways to provide it:</p>
<ol>
<li><strong>Read what the user may have changed from the leader.</strong> This needs a way to know what that is without querying it. A profile is usually editable only by its owner, so read your own profile from the leader and everyone else's from followers.</li>
<li><strong>Use a time window.</strong> If most things are editable, route a user's reads to the leader for, say, one minute after their last write, and stop serving reads from any follower more than a minute behind.</li>
<li><strong>Track log positions.</strong> The client remembers the position of its latest write, ideally a logical timestamp such as the leader's log sequence number. A replica serving that user must have caught up to it; otherwise the read waits or goes to another replica. A wall-clock timestamp also works, but then clock synchronization becomes critical (Chapter 8).</li>
<li><strong>Mind the regions.</strong> With replicas in several datacenters, any read that must be served by the leader has to be routed to the leader's datacenter.</li>
</ol>
<p>It gets harder when one person uses a laptop and a phone. A per-device record of "my last write position" fails, because the phone has no idea what the laptop wrote, so that metadata must be stored centrally. And the two devices may reach your service through different networks and land in different datacenters; if your approach needs leader reads, route all of a user's devices to the same datacenter.</p>
<h3>Monotonic reads</h3>
<p>A user refreshes a page twice. The first request hits a follower with little lag and shows a new comment; the second hits a more-lagged follower and the comment is gone. <strong>Monotonic reads</strong> rules this out: after seeing data from some point in time, a user never sees an older state. It is weaker than strong consistency and stronger than eventual consistency. The usual implementation is to send each user's reads to the same replica, chosen by a hash of the user ID rather than at random. If that replica fails, the user has to be rerouted, and that moment needs care.</p>
<p>Monotonic reads and read-your-writes are <em>independent</em> guarantees, not stronger and weaker versions of one another. A user pinned to a lagging follower never sees time go backward, but can easily miss their own latest write, which went to the leader. Most products want both.</p>
<h3>Consistent prefix reads</h3>
<p>The book illustrates the third anomaly with an invented exchange: Mr. Poons asks Mrs. Cake how far into the future she can see, and she replies that it is usually about ten seconds. An observer reading through followers can receive her reply before his question, because the two messages were stored in different partitions and the question's partition was lagging. To the observer, Mrs. Cake answers before anyone has asked.</p>
<p><strong>Consistent prefix reads</strong> guarantees that if writes happen in a certain order, anyone reading them sees them in that order. A single log applied in order provides this automatically, which is why the anomaly mostly appears in partitioned (sharded) databases: partitions replicate independently, so there is no global order of writes. The fixes are to write causally related data to the same partition (not always possible or efficient), or to track causal dependencies explicitly, using the happens-before relation that the section on concurrent writes develops. Kafka shows the trade-off plainly: ordering is guaranteed only within a partition, so events that must stay in order need the same key.</p>
<h3>Measure lag, and design for minutes</h3>
<p>In leader-based systems lag is measurable: subtract a follower's replayed log position from the leader's current one. PostgreSQL's <code>pg_stat_replication</code> shows each standby's sent, written, flushed and replayed positions, plus (since version 10) the time lags <code>write_lag</code>, <code>flush_lag</code> and <code>replay_lag</code>. MySQL's <code>Seconds_Behind_Source</code> (<code>Seconds_Behind_Master</code> before 8.0.22) is derived from event timestamps and misleads in documented cases: it can read 0 while the receiving thread is itself far behind, and NULL when replication has stopped.</p>
<p>Many teams instead write a heartbeat row on the leader every second (Percona's <code>pt-heartbeat</code>) and measure its age on each replica. Use the number for routing too: take replicas beyond a lag threshold out of the read pool.</p>
<p>Whenever you build on asynchronous followers, ask what happens if lag grows to minutes or hours. If the answer is "users see nonsense", you need one of these guarantees. Designing as if asynchronous followers were synchronous only postpones the problem to the first bad day, and application-level workarounds are intricate and easy to get wrong. That is exactly why databases offer transactions (Chapter 7) and stronger consistency models (Chapter 9).</p>`,
        },
        {
          type: "analogy",
          title: "Analogy: branch libraries",
          html: `<p>A magazine is printed at head office (the leader) and couriered to branch libraries (followers), some quickly and some slowly. Your letter is printed in this week's issue, but your local branch still has last week's: <strong>read-your-writes</strong> is broken. You read this week's issue at one branch, then visit another that hasn't received it, and the news un-happens: <strong>monotonic reads</strong> is broken. A reply printed in one magazine reaches you before the letter it answers, printed in another magazine that travels by a slower courier: <strong>consistent prefix</strong> is broken. Each fix is a rule about which branch you are allowed to read at.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "Facebook", year: "2013", tag: "remote markers", html: "<em>Scaling Memcache at Facebook</em> (NSDI 2013) describes remote markers. When a web server in a non-master region updates a key, it sets a marker for that key in its region; while the marker exists, cache misses on that key in that region read from the master region instead of the possibly stale local replica. The marker is removed once the replicated update arrives, giving read-after-write behaviour without sending every read to the master." },
            { org: "Ruby on Rails 6.0", year: "2019", tag: "time window", html: "Rails 6's automatic database role switching sends <code>GET</code> and <code>HEAD</code> requests to a replica unless the session wrote recently; the documented example uses a 2-second delay, after which reads go back to the replica. It is the time-window rule, built into a framework." },
            { org: "MediaWiki", tag: "log positions", html: "MediaWiki's <code>ChronologyProtector</code> records the primary's replication position after a user's write and makes that user's subsequent requests wait for (or choose) a replica that has caught up, giving read-your-writes across page loads." },
            { org: "Azure Cosmos DB and MongoDB", tag: "session tokens", html: "Cosmos DB's default <em>Session</em> consistency level and MongoDB 3.6's causally consistent client sessions both implement session guarantees such as read-your-writes and monotonic reads by passing a session or cluster-time token with each request." },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>These guarantees have become product features. They trace back to the "session guarantees" of Terry et al. (1994): read your writes, monotonic reads, writes follow reads and monotonic writes. MongoDB's causally consistent sessions (3.6) provide them. Azure Cosmos DB lets you choose among Strong, Bounded staleness, Session (the default), Consistent prefix and Eventual. DynamoDB reads are eventually consistent unless you ask for a strongly consistent read, which costs twice the read capacity. And Amazon S3, long the poster child of eventual consistency, became strongly read-after-write consistent in December 2020.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "Reading from asynchronous followers gives you",
          consLabel: "…and costs you",
          pros: [
            "Read capacity that grows with every follower you add.",
            "Reads served close to the user, in their own region.",
            "A leader left free for writes and for the reads that must be fresh.",
          ],
          cons: [
            "Any read may be stale, by an unbounded amount in the worst case.",
            "Each guarantee you need (read-your-writes, monotonic reads, consistent prefix) is routing logic you must build and get right.",
            "Lag has to be measured and acted on; a stuck replica silently serves old data.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A classic prompt: <em>"Users say their edits disappear right after saving, then come back. What's going on?"</em> Name it: reads are served by asynchronous followers and the user's own write hasn't reached the one they hit, which is a read-your-writes violation. Then offer fixes with their costs: read recently edited data from the leader (simple, more leader load), or carry the write's log position in the session and only read from replicas that have reached it (precise, needs plumbing).</p>
<p>Raise the hard cases before you're asked: one user on several devices, multiple regions, and why wall-clock timestamps are risky. If the symptom is content disappearing on refresh, talk about monotonic reads and sticky routing; if replies appear before questions, talk about consistent prefix and partitioning.</p>`,
        },
        {
          type: "quiz",
          q: "To guarantee monotonic reads, each user is pinned to one replica by hash(user_id). Does that also give read-your-writes?",
          options: [
            "Yes, because the user always talks to the same server",
            "No: the pinned replica is still an asynchronous follower and may not have applied the user's latest write yet",
            "Yes, as long as the replica is in the user's region",
            "No, because pinning breaks monotonic reads when the replica is slow",
          ],
          answer: 1,
          explain: "Pinning stops reads from going backward, but the write went to the leader, and the pinned follower may still be behind it. Read-your-writes needs a separate rule: read from the leader, or wait until the replica reaches the write's log position. A is tempting because 'same server every time' feels consistent, but consistency with yourself across reads is not the same as seeing your own writes. D is wrong: a slow pinned replica gives stale reads, never backward ones.",
        },
      ],
    },
  ],
});
