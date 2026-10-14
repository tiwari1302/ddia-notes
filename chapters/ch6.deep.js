// Chapter 6 deep dive, part 1 (hook + why partition, key ranges, hashing, hot spots,
// secondary indexes). Part 2 (rebalancing and request routing) lives in ch6.deep2.js.
// Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch6", {
  hook: `<p>Imagine a smart-thermostat startup (made up, but the numbers are typical). Its 200,000 devices each report a reading every minute, about 3,300 writes a second, and it stores them under a key that starts with the timestamp, splitting each day into four 6-hour ranges, one per node: 00:00–05:59 on node 1, 06:00–11:59 on node 2, and so on. At 14:00 the dashboard shows node 3 at 100% CPU and the other three nearly idle, because every thermostat is writing "now" and "now" lives on one node. The team switches to hashing the key and the writes even out, but the "this thermostat, last 2 hours" page now has to ask all four nodes and is only as fast as the slowest one. Then the business doubles, they add a fifth node, place keys with <code>hash(key) mod 5</code> instead of <code>mod 4</code>, and about <strong>80% of all readings</strong> start moving at once.</p>
<p>Cutting data into pieces is easy. Cutting it so that load stays even, the queries you care about touch one piece, and growth moves only what it must is the hard part, and it is what this chapter is about. Each section below fixes one of the startup's failures: choosing the key, handling skew, indexing by something other than the key, rebalancing, and finding the right node.</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "why-partition",
      title: "Why one machine eventually stops being enough",
      kicker: "Motivation",
      concepts: ["partition", "partitioning-and-replication"],
      blocks: [
        {
          type: "problem",
          title: "One machine, one ceiling",
          html: `<p>Picture an orders database on a single Postgres primary (illustrative, but typical): 8 TB of data on a 10 TB volume, 25,000 writes per second, CPU at 85%, and the largest instance your cloud provider sells is perhaps twice as big. A bigger machine buys you a year, not a solution.</p>
<p>Read replicas don't help with this. Each replica stores all 8 TB and replays all 25,000 writes per second, so replication (Chapter 5) multiplies read capacity and availability but leaves data volume and write throughput exactly where they were. Very large single databases also get painful to operate: Notion has described Postgres's VACUUM process stalling on its single pre-sharding database, and Figma has written about vacuum becoming a reliability risk on multi-terabyte tables.</p>
<p>So the data has to be split across machines, and both obvious splits fail. Put each new record on a random node and the balance is perfect, but nobody can find anything: a read for one key has to ask every node. Split by an attribute that looks natural, say customers A–M on node 1 and N–Z on node 2, and every record is findable, but the two halves are almost never equal in size or in traffic.</p>`,
        },
        {
          type: "idea",
          html: `<p>Give every record exactly <strong>one home partition</strong>, chosen by a <strong>deterministic function of its key</strong>. Choose the function so that data and query load spread evenly, and any component can compute where a key lives without asking around.</p>`,
        },
        {
          type: "text",
          html: `<h3>One home per record</h3>
<p>A <strong>partition</strong> is a slice of the data. Every record (a row, a document, a key-value pair) belongs to exactly one partition, and each partition behaves like a small database of its own that can live on its own machine. Some operations will still have to touch several partitions, and much of this chapter is about keeping those rare and cheap.</p>
<p>Almost every system has its own word for a partition. MongoDB, Elasticsearch and SolrCloud say <em>shard</em>; HBase says <em>region</em>; Bigtable says <em>tablet</em>; Couchbase says <em>vBucket</em>; Riak says <em>vnode</em>; Spanner calls its key-range pieces <em>splits</em>. Cassandra places data by token ranges (its vnodes) and, confusingly, uses <em>partition</em> for something smaller: the set of rows that share one partition key. Kafka's topic partitions are partitioned logs, covered in Chapter 11. And none of this has anything to do with a <strong>network partition</strong>, the communication failure of Chapter 8: same word, unrelated idea.</p>
<p>The goal is to spread <em>both</em> data and query load evenly. Get it right and 10 nodes store 10 times as much as one and handle roughly 10 times the reads and writes, at least for queries that touch a single partition. Get it wrong and you have <strong>skew</strong>: some partitions hold more data or receive more requests than others. The extreme case is a <strong>hot spot</strong>, a partition taking a disproportionate share of the load. With bad enough skew, 10 nodes deliver the throughput of one while nine sit idle.</p>
<h3>Why placement must be a function of the key</h3>
<p>Random placement balances perfectly but loses <strong>addressability</strong>. Nothing about the key tells you where its record went, so every lookup turns into a broadcast to all nodes. The fix is to make placement a deterministic function of the key. Then any component (a client library, a routing proxy, the database itself) can compute where <code>user:77</code> lives and send one request there. The next two sections cover the two classic functions: keep keys in sorted ranges, or hash them.</p>`,
        },
        {
          type: "diagram",
          title: "Random placement versus placement by key",
          svg: `<style>.dd-diagram-body svg.ch6d-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d-w{display:none!important}.dd-diagram-body svg.ch6d-n{display:block!important}}</style><svg class="ch6d-w" viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a client must ask all four nodes for user 77 because records were placed randomly. Right: the client computes f(user:77) = N3 and sends one request to node 3.">
  <defs>
    <marker id="c6d-addr-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
    <marker id="c6d-addr-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
  </defs>
  <rect x="8" y="8" width="304" height="204" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="328" y="8" width="304" height="204" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="160" y="32" font-size="13" font-weight="600" text-anchor="middle">Random placement</text>
  <text x="480" y="32" font-size="13" font-weight="600" text-anchor="middle">Placement = f(key)</text>
  <rect x="30" y="46" width="90" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="75" y="66" font-size="13" text-anchor="middle">Client</text>
  <text x="132" y="66" font-size="12" style="font-family: var(--font-mono)">get user:77</text>
  <line x1="75" y1="76" x2="50" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad)" style="stroke: var(--viz-bad)"/>
  <line x1="75" y1="76" x2="122" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad)" style="stroke: var(--viz-bad)"/>
  <line x1="75" y1="76" x2="194" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad)" style="stroke: var(--viz-bad)"/>
  <line x1="75" y1="76" x2="266" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad)" style="stroke: var(--viz-bad)"/>
  <g font-size="13" font-weight="700" text-anchor="middle" class="viz-halo" style="fill: var(--viz-bad)">
    <text x="62" y="114">?</text><text x="98" y="114">?</text><text x="134" y="114">?</text><text x="170" y="114">?</text>
  </g>
  <rect x="20" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="92" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="164" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="236" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <g font-size="13" text-anchor="middle">
    <text x="50" y="167">N1</text><text x="122" y="167">N2</text><text x="194" y="167">N3</text><text x="266" y="167">N4</text>
  </g>
  <text x="160" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">every read asks all 4 nodes</text>
  <rect x="350" y="46" width="90" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="395" y="66" font-size="13" text-anchor="middle">Client</text>
  <text x="452" y="66" font-size="12" style="font-family: var(--font-mono)">f(user:77) = N3</text>
  <line x1="395" y1="76" x2="512" y2="143" stroke-width="2" marker-end="url(#c6d-addr-ok)" style="stroke: var(--viz-ok)"/>
  <g opacity="0.5">
    <rect x="340" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
    <rect x="412" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
    <rect x="556" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  </g>
  <rect x="484" y="146" width="60" height="32" rx="6" stroke-width="2" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <g font-size="13" text-anchor="middle">
    <text x="370" y="167" opacity="0.6">N1</text><text x="442" y="167" opacity="0.6">N2</text><text x="514" y="167" font-weight="600">N3</text><text x="586" y="167" opacity="0.6">N4</text>
  </g>
  <text x="480" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-ok)">every read goes to exactly one node</text>
</svg><svg class="ch6d-n" viewBox="0 0 320 428" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a client must ask all four nodes for user 77 because records were placed randomly. Right: the client computes f(user:77) = N3 and sends one request to node 3.">
  <defs>
    <marker id="c6d-addr-bad-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
    <marker id="c6d-addr-ok-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
  </defs>
  <rect x="8" y="8" width="304" height="204" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="160" y="32" font-size="13" font-weight="600" text-anchor="middle">Random placement</text>
  <rect x="30" y="46" width="90" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="75" y="66" font-size="13" text-anchor="middle">Client</text>
  <text x="132" y="66" font-size="12" style="font-family: var(--font-mono)">get user:77</text>
  <line x1="75" y1="76" x2="50" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad-n)" style="stroke: var(--viz-bad)"/>
  <line x1="75" y1="76" x2="122" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad-n)" style="stroke: var(--viz-bad)"/>
  <line x1="75" y1="76" x2="194" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad-n)" style="stroke: var(--viz-bad)"/>
  <line x1="75" y1="76" x2="266" y2="144" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c6d-addr-bad-n)" style="stroke: var(--viz-bad)"/>
  <g font-size="13" font-weight="700" text-anchor="middle" class="viz-halo" style="fill: var(--viz-bad)">
    <text x="62" y="114">?</text><text x="98" y="114">?</text><text x="134" y="114">?</text><text x="170" y="114">?</text>
  </g>
  <rect x="20" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="92" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="164" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="236" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <g font-size="13" text-anchor="middle">
    <text x="50" y="167">N1</text><text x="122" y="167">N2</text><text x="194" y="167">N3</text><text x="266" y="167">N4</text>
  </g>
  <text x="160" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">every read asks all 4 nodes</text>
  <g transform="translate(-320,212)">
  <rect x="328" y="8" width="304" height="204" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="480" y="32" font-size="13" font-weight="600" text-anchor="middle">Placement = f(key)</text>
  <rect x="350" y="46" width="90" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="395" y="66" font-size="13" text-anchor="middle">Client</text>
  <text x="452" y="66" font-size="12" style="font-family: var(--font-mono)">f(user:77) = N3</text>
  <line x1="395" y1="76" x2="512" y2="143" stroke-width="2" marker-end="url(#c6d-addr-ok-n)" style="stroke: var(--viz-ok)"/>
  <g opacity="0.5">
    <rect x="340" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
    <rect x="412" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
    <rect x="556" y="146" width="60" height="32" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  </g>
  <rect x="484" y="146" width="60" height="32" rx="6" stroke-width="2" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <g font-size="13" text-anchor="middle">
    <text x="370" y="167" opacity="0.6">N1</text><text x="442" y="167" opacity="0.6">N2</text><text x="514" y="167" font-weight="600">N3</text><text x="586" y="167" opacity="0.6">N4</text>
  </g>
  <text x="480" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-ok)">every read goes to exactly one node</text>
  </g>
</svg>`,
          caption: `Both layouts can be perfectly balanced. Only the right one is addressable: because placement is computed from the key, the client never has to ask where a record lives.`,
        },
        {
          type: "text",
          html: `<h3>Partitions are replicated too</h3>
<p>Partitioning and replication solve different problems, so real systems combine them. Each partition is copied to several nodes (Chapter 5), which means every node stores replicas of many partitions. With single-leader replication each partition has its own leader, and the leaders are spread out: a node is the leader for some partitions and a follower for others. When a node dies, only the partitions it led need a failover, and its work is picked up by several survivors instead of one.</p>
<p>The choice of replication scheme is mostly independent of the choice of partitioning scheme. Everything in Chapter 5 (leaders and followers, quorums, replication lag) applies to each partition separately, so the rest of this chapter mostly sets replication aside and treats a partition as one logical unit.</p>`,
        },
        {
          type: "diagram",
          title: "Partitioning combined with replication",
          svg: `<style>.dd-diagram-body svg.ch6d-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d-w{display:none!important}.dd-diagram-body svg.ch6d-n{display:block!important}}</style><svg class="ch6d-w" viewBox="0 0 640 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four nodes, four partitions with three replicas each. Each node holds one leader replica and two follower replicas; dashed arrows run from each partition's leader to its two followers.">
  <defs>
    <marker id="c6d-rep-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
  </defs>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <text x="91.5" y="23">Node 1</text><text x="246.5" y="23">Node 2</text><text x="401.5" y="23">Node 3</text><text x="556.5" y="23">Node 4</text>
  </g>
  <rect x="24" y="32" width="135" height="226" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="179" y="32" width="135" height="226" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="334" y="32" width="135" height="226" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="489" y="32" width="135" height="226" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <g stroke-width="1.5" stroke-dasharray="5 4" fill="none" style="stroke: var(--viz-c1)">
    <path d="M111.5,50 Q169,30 226.5,50" marker-end="url(#c6d-rep-m)"/>
    <path d="M111.5,50 Q246.5,22 381.5,50" marker-end="url(#c6d-rep-m)"/>
    <path d="M266.5,104 Q324,84 381.5,104" marker-end="url(#c6d-rep-m)"/>
    <path d="M266.5,104 Q401.5,76 536.5,104" marker-end="url(#c6d-rep-m)"/>
    <path d="M421.5,158 Q479,138 536.5,158" marker-end="url(#c6d-rep-m)"/>
    <path d="M381.5,158 Q246.5,130 111.5,158" marker-end="url(#c6d-rep-m)"/>
    <path d="M536.5,212 Q401.5,184 266.5,212" marker-end="url(#c6d-rep-m)"/>
    <path d="M536.5,212 Q324,180 111.5,212" marker-end="url(#c6d-rep-m)"/>
  </g>
  <g style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)">
    <rect x="32" y="50" width="119" height="32" rx="6"/>
    <rect x="187" y="104" width="119" height="32" rx="6"/>
    <rect x="342" y="158" width="119" height="32" rx="6"/>
    <rect x="497" y="212" width="119" height="32" rx="6"/>
  </g>
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
    <rect x="187" y="50" width="119" height="32" rx="6"/>
    <rect x="342" y="50" width="119" height="32" rx="6"/>
    <rect x="342" y="104" width="119" height="32" rx="6"/>
    <rect x="497" y="104" width="119" height="32" rx="6"/>
    <rect x="497" y="158" width="119" height="32" rx="6"/>
    <rect x="32" y="158" width="119" height="32" rx="6"/>
    <rect x="32" y="212" width="119" height="32" rx="6"/>
    <rect x="187" y="212" width="119" height="32" rx="6"/>
  </g>
  <g font-size="13" text-anchor="middle">
    <text x="91.5" y="71" font-weight="600">P1 leader</text>
    <text x="246.5" y="71">P1 follower</text>
    <text x="401.5" y="71">P1 follower</text>
    <text x="246.5" y="125" font-weight="600">P2 leader</text>
    <text x="401.5" y="125">P2 follower</text>
    <text x="556.5" y="125">P2 follower</text>
    <text x="401.5" y="179" font-weight="600">P3 leader</text>
    <text x="556.5" y="179">P3 follower</text>
    <text x="91.5" y="179">P3 follower</text>
    <text x="556.5" y="233" font-weight="600">P4 leader</text>
    <text x="91.5" y="233">P4 follower</text>
    <text x="246.5" y="233">P4 follower</text>
  </g>
</svg><svg class="ch6d-n" viewBox="0 0 360 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four nodes, four partitions with three replicas each. Each node holds one leader replica and two follower replicas; dashed arrows run from each partition's leader to its two followers.">
  <defs><marker id="c6d-rep-mn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
  <g font-size="12" font-weight="600" text-anchor="middle"><text x="80" y="16">Node 1</text><text x="160" y="16">Node 2</text><text x="240" y="16">Node 3</text><text x="320" y="16">Node 4</text></g>
  <rect x="43" y="24" width="74" height="268" rx="9" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="123" y="24" width="74" height="268" rx="9" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="203" y="24" width="74" height="268" rx="9" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="283" y="24" width="74" height="268" rx="9" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <g font-size="13" font-weight="700" text-anchor="middle"><text x="20" y="77">P1</text><text x="20" y="137">P2</text><text x="20" y="197">P3</text><text x="20" y="257">P4</text></g>
  <g stroke-width="1.4" stroke-dasharray="4 3" fill="none" style="stroke: var(--viz-c1)"><path d="M88,56 Q124,40 160,56" marker-end="url(#c6d-rep-mn)"/><path d="M88,56 Q164,30 240,56" marker-end="url(#c6d-rep-mn)"/><path d="M168,116 Q204,100 240,116" marker-end="url(#c6d-rep-mn)"/><path d="M168,116 Q244,90 320,116" marker-end="url(#c6d-rep-mn)"/><path d="M248,176 Q284,160 320,176" marker-end="url(#c6d-rep-mn)"/><path d="M232,176 Q156,150 80,176" marker-end="url(#c6d-rep-mn)"/><path d="M312,236 Q196,204 80,236" marker-end="url(#c6d-rep-mn)"/><path d="M312,236 Q236,210 160,236" marker-end="url(#c6d-rep-mn)"/></g>
  <rect x="48" y="56" width="64" height="32" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="80" y="76" font-size="12" font-weight="700" text-anchor="middle">leader</text>
  <rect x="128" y="56" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="160" y="76" font-size="12" text-anchor="middle">follower</text>
  <rect x="208" y="56" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="240" y="76" font-size="12" text-anchor="middle">follower</text>
  <rect x="128" y="116" width="64" height="32" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="160" y="136" font-size="12" font-weight="700" text-anchor="middle">leader</text>
  <rect x="208" y="116" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="240" y="136" font-size="12" text-anchor="middle">follower</text>
  <rect x="288" y="116" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="320" y="136" font-size="12" text-anchor="middle">follower</text>
  <rect x="48" y="176" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="80" y="196" font-size="12" text-anchor="middle">follower</text>
  <rect x="208" y="176" width="64" height="32" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="240" y="196" font-size="12" font-weight="700" text-anchor="middle">leader</text>
  <rect x="288" y="176" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="320" y="196" font-size="12" text-anchor="middle">follower</text>
  <rect x="48" y="236" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="80" y="256" font-size="12" text-anchor="middle">follower</text>
  <rect x="128" y="236" width="64" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="160" y="256" font-size="12" text-anchor="middle">follower</text>
  <rect x="288" y="236" width="64" height="32" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="320" y="256" font-size="12" font-weight="700" text-anchor="middle">leader</text>
</svg>`,
          caption: `Every node is a leader for some partitions and a follower for others, so load and the impact of a failure spread evenly. Dashed arrows run from each partition's leader to its two followers; if Node 3 dies, only P3 needs a new leader.`,
        },
        {
          type: "text",
          html: `<h3>Who does what</h3>
<p>The division of labor is worth memorizing. <strong>Partitioning</strong> scales data volume and write throughput, because each node stores and writes only its share. <strong>Replication</strong> provides fault tolerance and scales reads, because every copy can answer them. A system with only replication still has a single-machine ceiling for writes; a system with only partitioning loses data whenever one disk dies.</p>
<p>Queries that stay inside one partition scale out almost perfectly: each is served by one node, so twice the nodes give roughly twice the throughput. The cost lives elsewhere: in queries that span partitions, in transactions that must commit atomically on several machines, and in <a href="#/ch6/learn/secondary-indexes">secondary indexes</a>.</p>
<h3>Three different things called partitioning</h3>
<ul>
<li><strong>Horizontal partitioning (sharding)</strong>: the rows of one table spread across machines by key. This is the chapter's subject.</li>
<li><strong>Vertical partitioning</strong>: different tables, or groups of columns, moved to different databases. Often the cheaper first step, because each piece stays an ordinary single-node database.</li>
<li><strong>Single-node table partitioning</strong>: PostgreSQL's declarative partitioning or MySQL's partitioned tables split one table into pieces on <em>one</em> server. Queries can skip irrelevant pieces (partition pruning) and dropping last month's data is instant, but it adds no capacity: the server's CPU, memory and disk are unchanged.</li>
</ul>
<p>"We partitioned the events table by month" in Postgres is a retention and pruning technique, not a scaling strategy. Interviewers notice when candidates blur the three.</p>
<h3>When not to partition</h3>
<p>If the data and the write load fit on one machine, with replicas for reads and fault tolerance, don't partition. Scale the machine up, add read replicas, and consider moving whole tables to separate databases before splitting any table's rows. Sharding makes every cross-entity query, transaction and schema change harder for as long as the system exists. Figma scaled up and moved groups of tables into their own databases before it sharded any rows; Notion ran a single Postgres database until it was clearly outgrowing it.</p>`,
        },
        {
          type: "callout",
          tone: "history",
          title: "An old idea, rediscovered twice",
          html: `<p>Partitioning is not a NoSQL invention. Parallel databases such as Teradata and Tandem NonStop SQL spread tables across many machines in the 1980s and ran queries on all partitions at once. The mid-2000s rediscovered the idea at web scale: Bigtable (2006), Dynamo (2007) and the systems they inspired, such as HBase, Cassandra and Riak, alongside MongoDB and Hadoop. Most of them partitioned key-value or document data and gave up joins and multi-partition transactions to do it. Distributed SQL databases (Spanner, CockroachDB, TiDB, YugabyteDB) later brought SQL and transactions back while splitting and moving partitions automatically.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Instagram",
              year: "2012",
              tag: "logical shards",
              html: `"Sharding &amp; IDs at Instagram" describes many <strong>logical shards</strong> (Postgres schemas) mapped onto far fewer physical database servers, so a logical shard can move to a new server without re-splitting any data. Each 64-bit ID packs 41 bits of millisecond timestamp, 13 bits of logical shard ID and a 10-bit per-shard sequence, so the shard can be read straight out of the ID.`,
            },
            {
              org: "Notion",
              year: "2021",
              tag: "480 logical shards",
              html: `Notion split its monolithic Postgres into <strong>480 logical shards</strong> (Postgres schemas) spread over 32 physical databases, 15 per database, partitioned by <strong>workspace ID</strong>, because nearly every query is scoped to one workspace and each workspace's data then stays together. The count 480 was chosen for its many divisors, so the logical shards spread evenly over many possible host counts (<a href="#/ch6/learn/rebalancing-strategies">rebalancing strategies</a> covers the later re-shard).`,
            },
            {
              org: "Figma",
              year: "2024",
              tag: "vertical first",
              html: `Figma's databases team scaled Postgres vertically first, then moved groups of tables into their own databases (vertical partitioning), and only then sharded rows horizontally. Tables that share a shard key are grouped into "colos" so joins and transactions within a colo stay on one shard; logical sharding was rolled out before physical sharding to reduce risk; and a query proxy (DBProxy) parses and routes queries, scatter-gathering those that lack a shard key.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What partitioning buys",
          consLabel: "What it costs",
          pros: [
            "Storage and write throughput grow with the node count, past any single machine's ceiling.",
            "Smaller datasets per node: faster backups, restores, index builds and maintenance such as vacuum.",
            "Smaller blast radius: a dead node affects only the partitions it held, and leadership is spread out.",
            "Queries scoped to one partition scale out almost linearly.",
          ],
          cons: [
            "You must choose a partition key, and changing it later means moving essentially all the data.",
            "Queries without the partition key become scatter-gather; transactions across partitions need distributed commit (Chapter 9).",
            "Secondary indexes and uniqueness constraints get hard (see the section on secondary indexes).",
            "Skew and hot spots can waste most of the cluster.",
            "New machinery to run: rebalancing, request routing and a partition map that must stay correct.",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Sharding you can buy",
          html: `<p>Since the book, partitioning has become something many teams buy rather than build. Distributed SQL databases (Cloud Spanner, generally available since 2017, plus CockroachDB, TiDB and YugabyteDB) split key ranges and move them between nodes automatically. Sharding layers keep a familiar engine underneath: Vitess for MySQL (created at YouTube; Slack described its migration onto it in 2020) and Citus for Postgres. And teams that sharded Postgres themselves, such as Notion (2021) and Figma (2024), published detailed accounts that are among the best free case studies on choosing a partition key.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A common prompt: "Our database is running out of room. Read replicas or sharding?" A strong answer starts by asking which resource is exhausted. If it is read load, use replicas or a cache. If it is storage or write throughput, replicas cannot help, because every replica holds all the data and applies every write; you need partitioning, but try scaling up and vertical partitioning first. Then name a partition key and justify it from the access patterns ("which entity are the busiest queries scoped to?"), and say what gets harder: cross-shard queries, transactions, secondary indexes and rebalancing. Confusing sharding with single-node table partitioning, or with network partitions, is an instant red flag.</p>`,
        },
        {
          type: "quiz",
          q: "To guarantee perfectly even balance, a team stores each new record on a randomly chosen node out of 10. What is the main problem?",
          options: [
            "Writes get slower because generating random numbers is expensive",
            "A read for a specific key cannot know which node holds it, so it must ask all 10 nodes",
            "Random placement creates hot spots on whichever node is luckiest",
            "Every record now has to be replicated to all 10 nodes",
          ],
          answer: 1,
          explain: `Balance is perfect, but placement is no longer a function of the key, so every point lookup becomes a broadcast to all 10 nodes. Option C is the tempting one because hot spots are a real partitioning problem, but they come from skewed keys or skewed access patterns; random placement of distinct records spreads them almost perfectly evenly. Replication is an independent choice, so option D does not follow either.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "key-range",
      title: "Sorted key ranges: cheap scans, dangerous hot spots",
      kicker: "Strategy 1",
      concepts: ["key-range-partitioning"],
      blocks: [
        {
          type: "problem",
          title: "Equal slices, unequal load",
          html: `<p>Once placement has to be a function of the key, the simplest function keeps keys in order: partition 1 takes keys from the start of the alphabet up to some boundary, partition 2 the next stretch, and so on. The naive version cuts the key space into equal-width slices (A–E, F–J, K–O, ...) and fails at once, because real keys are nowhere near uniform. Far more surnames start with S or M than with Q or X, so the S slice fills up while others stay nearly empty.</p>
<p>A subtler failure survives even well-chosen boundaries. Keys that grow over time (timestamps, auto-increment IDs, time-ordered UUIDs) give every new write the largest key so far, and the largest key always lives in the last range. However many partitions you have, one of them takes every insert.</p>`,
        },
        {
          type: "idea",
          html: `<p>Give each partition a <strong>contiguous range of keys</strong>, put the boundaries where the data actually is, and keep keys <strong>sorted</strong> inside each partition. Range scans then touch one or a few partitions. The price: any access pattern concentrated in one range, above all "now", becomes a hot spot.</p>`,
        },
        {
          type: "analogy",
          title: "Encyclopedia volumes",
          html: `<p>A printed encyclopedia doesn't give each volume one letter. One volume might cover only <em>Sa–Sm</em> while another covers <em>U</em> through <em>Z</em>, because the publisher sets the boundaries so the volumes come out about equally thick. To look something up you read the spines and pull the one volume that must contain it; inside, entries are in order, so you can read a run of neighboring entries straight through. The spine labels are the partition boundaries.</p>`,
        },
        {
          type: "text",
          html: `<h3>Boundaries follow the data</h3>
<p>Each partition owns a contiguous range, from a minimum key up to (but not including) the next partition's minimum. The ranges don't need to be equally wide; they need to hold about the same amount of data, or better, the same amount of load. An administrator can choose the boundaries, or the database can choose them itself by splitting any range that grows too big (<a href="#/ch6/learn/rebalancing-strategies">dynamic partitioning</a>, covered with the rebalancing strategies).</p>
<p>Routing is then simple. The routing metadata is just the sorted list of boundaries, so any component can binary-search it to find the partition for a key. A scan from <code>k1</code> to <code>k2</code> contacts only the partitions whose ranges overlap <code>[k1, k2]</code>: usually one, at most a few neighbors. Hold on to that property; it is exactly what hashing gives up in the next section.</p>`,
        },
        {
          type: "diagram",
          title: "Boundaries placed where the keys are",
          svg: `<style>.dd-diagram-body svg.ch6d-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d-w{display:none!important}.dd-diagram-body svg.ch6d-n{display:block!important}}</style><svg class="ch6d-w" viewBox="0 0 640 182" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A bar chart of how many surnames start with each letter, above a key-space bar split into five partitions of unequal width: A–C, D–H, I–M, N–Sm and Sn–Z, each holding about a fifth of the keys.">
  <text x="20" y="13" font-size="12" style="fill: var(--viz-muted)">keys per first letter (illustrative)</text>
  <rect x="24" y="56.4" width="15" height="19.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="47.1" y="22.8" width="15" height="53.2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="70.2" y="34" width="15" height="42" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="93.3" y="48" width="15" height="28" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="116.3" y="64.8" width="15" height="11.2" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="139.4" y="56.4" width="15" height="19.6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="162.5" y="50.8" width="15" height="25.2" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="185.6" y="39.6" width="15" height="36.4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="208.7" y="73.2" width="15" height="2.8" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="231.7" y="62" width="15" height="14" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="254.8" y="56.4" width="15" height="19.6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="277.9" y="48" width="15" height="28" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="301" y="25.6" width="15" height="50.4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="324" y="64.8" width="15" height="11.2" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="347.1" y="67.6" width="15" height="8.4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="370.2" y="48" width="15" height="28" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="393.3" y="74.3" width="15" height="1.7" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="416.3" y="42.4" width="15" height="33.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="439.4" y="20" width="7.5" height="56" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="446.9" y="20" width="7.5" height="56" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="462.5" y="56.4" width="15" height="19.6" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="485.6" y="74.3" width="15" height="1.7" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="508.7" y="67.6" width="15" height="8.4" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="531.7" y="36.8" width="15" height="39.2" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="554.8" y="74.5" width="15" height="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="577.9" y="73.2" width="15" height="2.8" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="601" y="73.2" width="15" height="2.8" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="31.5" y="92">A</text><text x="54.6" y="92">B</text><text x="77.7" y="92">C</text><text x="100.8" y="92">D</text><text x="123.8" y="92">E</text><text x="146.9" y="92">F</text><text x="170" y="92">G</text><text x="193.1" y="92">H</text><text x="216.2" y="92">I</text><text x="239.2" y="92">J</text><text x="262.3" y="92">K</text><text x="285.4" y="92">L</text><text x="308.5" y="92">M</text><text x="331.5" y="92">N</text><text x="354.6" y="92">O</text><text x="377.7" y="92">P</text><text x="400.8" y="92">Q</text><text x="423.8" y="92">R</text><text x="446.9" y="92">S</text><text x="470" y="92">T</text><text x="493.1" y="92">U</text><text x="516.2" y="92">V</text><text x="539.2" y="92">W</text><text x="562.3" y="92">X</text><text x="585.4" y="92">Y</text><text x="608.5" y="92">Z</text>
  </g>
  <rect x="20" y="100" width="69.2" height="30" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="89.2" y="100" width="115.4" height="30" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="204.6" y="100" width="115.4" height="30" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="320" y="100" width="126.9" height="30" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="446.9" y="100" width="173.1" height="30" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <g text-anchor="middle">
    <text x="54.6" y="120" font-size="13" font-weight="600">P1</text>
    <text x="146.9" y="120" font-size="13" font-weight="600">P2</text>
    <text x="262.3" y="120" font-size="13" font-weight="600">P3</text>
    <text x="383.5" y="120" font-size="13" font-weight="600">P4</text>
    <text x="533.5" y="120" font-size="13" font-weight="600">P5</text>
    <text x="54.6" y="148" font-size="12">A–C</text>
    <text x="146.9" y="148" font-size="12">D–H</text>
    <text x="262.3" y="148" font-size="12">I–M</text>
    <text x="383.5" y="148" font-size="12">N–Sm</text>
    <text x="533.5" y="148" font-size="12">Sn–Z</text>
  </g>
  <text x="320" y="174" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">each partition holds about a fifth of the keys, so the boundaries are uneven</text>
</svg><svg class="ch6d-n" viewBox="0 0 360 196" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A bar chart of how many surnames start with each letter, above a key-space bar split into five partitions of unequal width: A–C, D–H, I–M, N–Sm and Sn–Z, each holding about a fifth of the keys.">
  <text x="10" y="13" font-size="11" style="fill: var(--viz-muted)">keys per first letter (illustrative)</text>
  <rect x="12.3" y="56.4" width="8.5" height="19.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="25.4" y="22.8" width="8.5" height="53.2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="38.4" y="34" width="8.5" height="42" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="51.5" y="48" width="8.5" height="28" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="64.6" y="64.8" width="8.5" height="11.2" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="77.7" y="56.4" width="8.5" height="19.6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="90.8" y="50.8" width="8.5" height="25.2" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="103.8" y="39.6" width="8.5" height="36.4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="116.9" y="73.2" width="8.5" height="2.8" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="130" y="62" width="8.5" height="14" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="143.1" y="56.4" width="8.5" height="19.6" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="156.1" y="48" width="8.5" height="28" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="169.2" y="25.6" width="8.5" height="50.4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="182.3" y="64.8" width="8.5" height="11.2" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="195.4" y="67.6" width="8.5" height="8.4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="208.4" y="48" width="8.5" height="28" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="221.5" y="74.3" width="8.5" height="1.7" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="234.6" y="42.4" width="8.5" height="33.6" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="247.7" y="20" width="4.2" height="56" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="251.9" y="20" width="4.2" height="56" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="260.8" y="56.4" width="8.5" height="19.6" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="273.8" y="74.3" width="8.5" height="1.7" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="286.9" y="67.6" width="8.5" height="8.4" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="300" y="36.8" width="8.5" height="39.2" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="313.1" y="74.5" width="8.5" height="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="326.1" y="73.2" width="8.5" height="2.8" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="339.2" y="73.2" width="8.5" height="2.8" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <rect x="10" y="100" width="39.2" height="30" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="49.2" y="100" width="65.4" height="30" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="114.6" y="100" width="65.4" height="30" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <rect x="180" y="100" width="71.9" height="30" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <rect x="251.9" y="100" width="98.1" height="30" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
  <g font-size="11" text-anchor="middle" style="fill: var(--viz-muted)"><text x="16.5" y="92">A</text><text x="29.6" y="92">B</text><text x="42.7" y="92">C</text><text x="55.8" y="92">D</text><text x="68.8" y="92">E</text><text x="81.9" y="92">F</text><text x="95" y="92">G</text><text x="108.1" y="92">H</text><text x="121.2" y="92">I</text><text x="134.2" y="92">J</text><text x="147.3" y="92">K</text><text x="160.4" y="92">L</text><text x="173.5" y="92">M</text><text x="186.5" y="92">N</text><text x="199.6" y="92">O</text><text x="212.7" y="92">P</text><text x="225.8" y="92">Q</text><text x="238.8" y="92">R</text><text x="251.9" y="92">S</text><text x="265" y="92">T</text><text x="278.1" y="92">U</text><text x="291.2" y="92">V</text><text x="304.2" y="92">W</text><text x="317.3" y="92">X</text><text x="330.4" y="92">Y</text><text x="343.5" y="92">Z</text></g>
  <g text-anchor="middle">
    <text x="29.6" y="120" font-size="12" font-weight="600">P1</text>
    <text x="81.9" y="120" font-size="12" font-weight="600">P2</text>
    <text x="147.3" y="120" font-size="12" font-weight="600">P3</text>
    <text x="216" y="120" font-size="12" font-weight="600">P4</text>
    <text x="301" y="120" font-size="12" font-weight="600">P5</text>
    <text x="29.6" y="148" font-size="11">A–C</text>
    <text x="81.9" y="148" font-size="11">D–H</text>
    <text x="147.3" y="148" font-size="11">I–M</text>
    <text x="216" y="148" font-size="11">N–Sm</text>
    <text x="301" y="148" font-size="11">Sn–Z</text>
  </g>
  <g font-size="11" text-anchor="middle" style="fill: var(--viz-muted)"><text x="180" y="172">each partition holds about a fifth of the keys,</text><text x="180" y="188">so the boundaries are uneven</text></g>
</svg>`,
          caption: `Dense letters get narrow partitions and sparse ones get wide partitions: P1 covers three letters, P5 seven and a half. The boundaries are wherever the cumulative count crosses another fifth, even in the middle of S.`,
        },
        {
          type: "text",
          html: `<h3>Sorted inside, too</h3>
<p>Within a partition, keys are kept in sorted order, in <a href="#/ch3/learn/sstables-and-lsm-trees">SSTables and LSM-trees</a> or in a <a href="#/ch3/learn/b-trees">B-tree</a> (Chapter 3). A range scan is therefore a sequential read through neighboring keys, not a pile of random lookups. That lets you treat the key as a <strong>concatenated index</strong>: key each sensor reading by <code>year-month-day-hour-minute-second</code>, and "every reading from March 2024" is one contiguous slice.</p>
<h3>The moving hot spot</h3>
<p>That same timestamp key is a trap. Suppose readings are range-partitioned by timestamp, one partition per day. Every sensor writes the current time, so all of today's writes land in today's partition while the partitions for earlier days receive nothing but occasional reads. At midnight the hot spot moves to a fresh partition, and it only ever moves forward: the newest range is permanently hot for writes, and older ranges go cold for good.</p>
<p>Any key that grows over time behaves the same way when it leads the key in a range-partitioned store: <strong>auto-increment IDs</strong>, <strong>MongoDB ObjectIds</strong> (whose first 4 bytes are a timestamp), <strong>Snowflake-style IDs</strong>, and <strong>UUIDv7</strong> or <strong>ULIDs</strong>, which are time-ordered by design. In a single-node B-tree that ordering is a feature, since inserts append neatly at the right-hand edge. In a range-partitioned cluster it aims every insert at one machine.</p>
<p>The fix is to lead with something other than time. Prefix the key with the sensor name, so it becomes <code>(sensor, timestamp)</code>, and partition by sensor first. Writes from many sensors now spread across partitions, and "sensor 7, last 2 hours" is still a single contiguous scan. The cost moves to a different query: "all sensors, 10:00 to 11:00" now needs one range scan per sensor.</p>`,
        },
        {
          type: "diagram",
          title: "Timestamp keys versus sensor-first keys",
          svg: `<style>.dd-diagram-body svg.ch6d-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d-w{display:none!important}.dd-diagram-body svg.ch6d-n{display:block!important}}</style><svg class="ch6d-w" viewBox="0 0 640 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: with key = timestamp, all eight sensors write to the Today partition while Mon, Tue and Wed sit idle. Bottom: with key = sensor then timestamp, each of four partitions receives writes from two sensors.">
  <defs>
    <marker id="c6d-ts-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
    <marker id="c6d-ts-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
  </defs>
  <text x="16" y="22" font-size="13" font-weight="600">Key = timestamp</text>
  <g stroke-width="1.5" marker-end="url(#c6d-ts-bad)" style="stroke: var(--viz-bad)">
    <line x1="110" y1="61" x2="494" y2="98"/><line x1="170" y1="61" x2="507" y2="98"/><line x1="230" y1="61" x2="520" y2="98"/><line x1="290" y1="61" x2="533" y2="98"/>
    <line x1="350" y1="61" x2="546" y2="98"/><line x1="410" y1="61" x2="559" y2="98"/><line x1="470" y1="61" x2="572" y2="98"/><line x1="530" y1="61" x2="585" y2="98"/>
  </g>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)">
    <circle cx="110" cy="48" r="13"/><circle cx="170" cy="48" r="13"/><circle cx="230" cy="48" r="13"/><circle cx="290" cy="48" r="13"/>
    <circle cx="350" cy="48" r="13"/><circle cx="410" cy="48" r="13"/><circle cx="470" cy="48" r="13"/><circle cx="530" cy="48" r="13"/>
  </g>
  <g font-size="12" text-anchor="middle">
    <text x="110" y="52">S1</text><text x="170" y="52">S2</text><text x="230" y="52">S3</text><text x="290" y="52">S4</text>
    <text x="350" y="52">S5</text><text x="410" y="52">S6</text><text x="470" y="52">S7</text><text x="530" y="52">S8</text>
  </g>
  <g style="fill: var(--viz-node); stroke: var(--viz-node-stroke)">
    <rect x="40" y="100" width="130" height="34" rx="6"/><rect x="185" y="100" width="130" height="34" rx="6"/><rect x="330" y="100" width="130" height="34" rx="6"/>
  </g>
  <rect x="475" y="100" width="130" height="34" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <g font-size="13" text-anchor="middle">
    <text x="105" y="122" style="fill: var(--viz-muted)">Mon: idle</text>
    <text x="250" y="122" style="fill: var(--viz-muted)">Tue: idle</text>
    <text x="395" y="122" style="fill: var(--viz-muted)">Wed: idle</text>
    <text x="540" y="122" font-weight="600">Today: 100%</text>
  </g>
  <line x1="16" y1="156" x2="624" y2="156" style="stroke: var(--viz-line)"/>
  <text x="16" y="182" font-size="13" font-weight="600">Key = sensor, then timestamp</text>
  <g stroke-width="1.5" marker-end="url(#c6d-ts-ok)" style="stroke: var(--viz-ok)">
    <line x1="110" y1="219" x2="83" y2="254"/><line x1="170" y1="219" x2="127" y2="254"/><line x1="230" y1="219" x2="228" y2="254"/><line x1="290" y1="219" x2="272" y2="254"/>
    <line x1="350" y1="219" x2="373" y2="254"/><line x1="410" y1="219" x2="417" y2="254"/><line x1="470" y1="219" x2="518" y2="254"/><line x1="530" y1="219" x2="562" y2="254"/>
  </g>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)">
    <circle cx="110" cy="206" r="13"/><circle cx="170" cy="206" r="13"/><circle cx="230" cy="206" r="13"/><circle cx="290" cy="206" r="13"/>
    <circle cx="350" cy="206" r="13"/><circle cx="410" cy="206" r="13"/><circle cx="470" cy="206" r="13"/><circle cx="530" cy="206" r="13"/>
  </g>
  <g font-size="12" text-anchor="middle">
    <text x="110" y="210">S1</text><text x="170" y="210">S2</text><text x="230" y="210">S3</text><text x="290" y="210">S4</text>
    <text x="350" y="210">S5</text><text x="410" y="210">S6</text><text x="470" y="210">S7</text><text x="530" y="210">S8</text>
  </g>
  <g style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)">
    <rect x="40" y="256" width="130" height="34" rx="6"/><rect x="185" y="256" width="130" height="34" rx="6"/><rect x="330" y="256" width="130" height="34" rx="6"/><rect x="475" y="256" width="130" height="34" rx="6"/>
  </g>
  <g font-size="13" text-anchor="middle">
    <text x="105" y="278">S1–S2: 25%</text><text x="250" y="278">S3–S4: 25%</text><text x="395" y="278">S5–S6: 25%</text><text x="540" y="278">S7–S8: 25%</text>
  </g>
  <text x="16" y="312" font-size="12" style="fill: var(--viz-muted)">cost: "all sensors, 10:00–11:00" now needs 8 range scans, one per sensor</text>
</svg><svg class="ch6d-n" viewBox="0 0 360 336" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: with key = timestamp, all eight sensors write to the Today partition while Mon, Tue and Wed sit idle. Bottom: with key = sensor then timestamp, each of four partitions receives writes from two sensors.">
  <defs>
    <marker id="c6d-ts-bad-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
    <marker id="c6d-ts-ok-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
  </defs>
  <text x="8" y="18" font-size="13" font-weight="600">Key = timestamp</text>
  <g stroke-width="1.3" marker-end="url(#c6d-ts-bad-n)" style="stroke: var(--viz-bad)"><line x1="30" y1="54" x2="281" y2="92"/><line x1="73" y1="54" x2="289" y2="92"/><line x1="116" y1="54" x2="297" y2="92"/><line x1="159" y1="54" x2="305" y2="92"/><line x1="202" y1="54" x2="313" y2="92"/><line x1="245" y1="54" x2="321" y2="92"/><line x1="288" y1="54" x2="329" y2="92"/><line x1="331" y1="54" x2="337" y2="92"/></g>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"><circle cx="30" cy="42" r="12"/><circle cx="73" cy="42" r="12"/><circle cx="116" cy="42" r="12"/><circle cx="159" cy="42" r="12"/><circle cx="202" cy="42" r="12"/><circle cx="245" cy="42" r="12"/><circle cx="288" cy="42" r="12"/><circle cx="331" cy="42" r="12"/></g>
  <g font-size="11" text-anchor="middle"><text x="30" y="46">S1</text><text x="73" y="46">S2</text><text x="116" y="46">S3</text><text x="159" y="46">S4</text><text x="202" y="46">S5</text><text x="245" y="46">S6</text><text x="288" y="46">S7</text><text x="331" y="46">S8</text></g>
  <g style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"><rect x="8" y="94" width="80" height="32" rx="6"/><rect x="95" y="94" width="80" height="32" rx="6"/><rect x="182" y="94" width="80" height="32" rx="6"/></g>
  <rect x="269" y="94" width="80" height="32" rx="6" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <g font-size="12" text-anchor="middle"><text x="48" y="114" style="fill: var(--viz-muted)">Mon: idle</text><text x="135" y="114" style="fill: var(--viz-muted)">Tue: idle</text><text x="222" y="114" style="fill: var(--viz-muted)">Wed: idle</text><text x="309" y="114" font-weight="600">Today: 100%</text></g>
  <line x1="8" y1="146" x2="352" y2="146" style="stroke: var(--viz-line)"/>
  <text x="8" y="170" font-size="13" font-weight="600">Key = sensor, then timestamp</text>
  <g stroke-width="1.3" marker-end="url(#c6d-ts-ok-n)" style="stroke: var(--viz-ok)"><line x1="30" y1="206" x2="34" y2="242"/><line x1="73" y1="206" x2="62" y2="242"/><line x1="116" y1="206" x2="121" y2="242"/><line x1="159" y1="206" x2="149" y2="242"/><line x1="202" y1="206" x2="208" y2="242"/><line x1="245" y1="206" x2="236" y2="242"/><line x1="288" y1="206" x2="295" y2="242"/><line x1="331" y1="206" x2="323" y2="242"/></g>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"><circle cx="30" cy="194" r="12"/><circle cx="73" cy="194" r="12"/><circle cx="116" cy="194" r="12"/><circle cx="159" cy="194" r="12"/><circle cx="202" cy="194" r="12"/><circle cx="245" cy="194" r="12"/><circle cx="288" cy="194" r="12"/><circle cx="331" cy="194" r="12"/></g>
  <g font-size="11" text-anchor="middle"><text x="30" y="198">S1</text><text x="73" y="198">S2</text><text x="116" y="198">S3</text><text x="159" y="198">S4</text><text x="202" y="198">S5</text><text x="245" y="198">S6</text><text x="288" y="198">S7</text><text x="331" y="198">S8</text></g>
  <g style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"><rect x="8" y="244" width="80" height="32" rx="6"/><rect x="95" y="244" width="80" height="32" rx="6"/><rect x="182" y="244" width="80" height="32" rx="6"/><rect x="269" y="244" width="80" height="32" rx="6"/></g>
  <g font-size="12" text-anchor="middle"><text x="48" y="264">S1–S2: 25%</text><text x="135" y="264">S3–S4: 25%</text><text x="222" y="264">S5–S6: 25%</text><text x="309" y="264">S7–S8: 25%</text></g>
  <g font-size="11" style="fill: var(--viz-muted)"><text x="8" y="300">cost: "all sensors, 10:00–11:00" now needs</text><text x="8" y="316">8 range scans, one per sensor</text></g>
</svg>`,
          caption: `With time first, eight sensors share one hot partition and the other three do nothing. With the sensor first, writes spread by sensor and each sensor's readings stay sorted by time, so "sensor 3, last 2 hours" is still one scan. What you lose is the cheap cross-sensor time query.`,
        },
        {
          type: "text",
          html: `<h3>Shaping keys on purpose</h3>
<p>Range partitioning rewards deliberate key design. The Bigtable paper stores web pages under <strong>reversed hostnames</strong> (<code>com.cnn.www</code>), so every page of one domain sits in a contiguous run of rows and a whole site can be read in one scan. Spanner, which also partitions by key range, recommends <strong>bit-reversed sequences</strong> (consecutive values with their bits reversed, so they land far apart) or random <strong>UUIDv4</strong> keys when nothing needs to be read in key order: it gives up ordering on purpose to spread inserts. OpenTSDB, a time-series database built on HBase, begins each row key with the metric's ID and only then the timestamp, so different metrics write to different regions instead of all piling onto the newest one; later versions added optional salting.</p>
<p>Systems that partition by key range include Bigtable and its open-source counterpart HBase, RethinkDB, MongoDB's ranged sharding (its only option before version 2.4), and the distributed SQL family: Spanner, CockroachDB, and TiKV underneath TiDB.</p>`,
        },
        {
          type: "compare",
          title: "Three keys for the same sensor readings",
          items: [
            {
              title: "Timestamp first",
              tone: "bad",
              html: `<strong>Cheap:</strong> "everything between 10:00 and 11:00", one contiguous slice.<br><strong>Expensive:</strong> every single write, because all of them hit the newest partition. Hot spot guaranteed.`,
            },
            {
              title: "Sensor, then timestamp",
              tone: "ok",
              html: `<strong>Cheap:</strong> "sensor 7, last 2 hours" (one scan), and writes spread across sensors.<br><strong>Expensive:</strong> "all sensors, 10:00–11:00", which needs one scan per sensor. A sensor far busier than the rest is still a hot spot.`,
            },
            {
              title: "Bit-reversed or random (UUIDv4)",
              tone: "warn",
              html: `<strong>Cheap:</strong> inserts, spread almost perfectly.<br><strong>Expensive:</strong> any scan in time order, since ordering is gone. This is effectively hashing, the next section's strategy.`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Bigtable",
              year: "2006",
              tag: "tablets",
              html: `Rows are kept in lexicographic order by row key and split dynamically into row ranges called <strong>tablets</strong>, roughly 100–200 MB each by default. The paper's Webtable example stores pages under reversed hostnames (<code>com.cnn.www</code>) so that pages from one domain are contiguous.`,
            },
            {
              org: "Google Cloud Spanner",
              tag: "schema docs",
              html: `Spanner distributes data by key range, so a monotonically increasing first key column (a timestamp or sequence) sends every insert to one server. Its schema-design guidance recommends UUIDv4, bit-reversed sequences, hashing the value into a leading key part, or reordering the key columns. Indexes are tables too, so indexing a timestamp column can create the same hot spot.`,
            },
            {
              org: "Apache HBase",
              tag: "hotspotting",
              html: `Regions are contiguous row-key ranges. The HBase Reference Guide warns that monotonically increasing row keys, typical of time series, make all writes hit one region ("hotspotting"), and suggests salting, hashing or reversing the key.`,
            },
            {
              org: "MongoDB",
              tag: "ranged sharding",
              html: `Range-based sharding was the only option before version 2.4. MongoDB's documentation warns that a monotonically increasing shard key, such as an ObjectId or a timestamp, routes every insert to the chunk holding the maximum key, and therefore to a single shard.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Key ranges are not \"the bad one\"",
          html: `<p>It's tempting to file key-range partitioning as the naive option and hashing as the fix. Key ranges are the right choice whenever range scans matter and access is spread across the key space, which is exactly why Bigtable, HBase, Spanner and CockroachDB use them. They become dangerous only when access concentrates in one range, and the cure is usually a better key, not a different partitioner.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design a metrics, IoT or logging store" almost always has a timestamp in it, and interviewers want you to spot the monotonic-key hot spot before they point it out. A strong answer: don't lead the key with time; lead with the entity the main queries are scoped to (device, tenant, metric), then time, so a per-entity time range stays one contiguous scan. Then name what is left over: cross-entity time queries fan out to every partition, one very busy device can still be hot, and an entity's data grows forever unless you add a time bucket to the key.</p>`,
        },
        {
          type: "quiz",
          q: "A metrics store is key-range partitioned by reading timestamp across 12 nodes, one calendar month per node. What does the load look like on an ordinary day?",
          options: [
            "Even, because every node covers the same length of time",
            "Every write goes to the current month's node, while the other 11 serve only reads of older data",
            "Range queries such as \"last 7 days\" must be scattered to all 12 nodes",
            "The database automatically splits the current month across all 12 nodes",
          ],
          answer: 1,
          explain: `Equal-sized time ranges do not mean equal load: new readings always carry the newest timestamp, so they all land in one range. Option A is the tempting one, but "same length of time" describes the data at rest, not where today's writes go. A "last 7 days" query is actually cheap here (one or two nodes). Dynamic splitting could split the hot month, but the newest keys would still all land in the newest piece.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "hash-partitioning",
      title: "Hashing buys evenness by giving up order",
      kicker: "Strategy 2",
      concepts: ["hash-based-partitioning", "compound-partition-key", "data-colocation"],
      blocks: [
        {
          type: "problem",
          title: "Spreading any key pattern, with no tuning",
          html: `<p>Key ranges need boundaries that match the data, and they still melt under sequential or clustered keys. What engineers wanted was a placement function that spreads <em>any</em> key pattern evenly, whether sequential IDs, timestamps or ten thousand users whose names begin with "Mc", with no tuning at all. A hash function does exactly that: inputs that look almost identical produce outputs that look unrelated.</p>
<p>The naive implementation calls the language's built-in hash, and that is a trap. Java's <code>Object.hashCode()</code> is identity-based unless a class overrides it, Ruby's <code>Object#hash</code> can differ between processes, and Python has randomized <code>str</code> hashes per process since version 3.3. Two app servers would compute different homes for <code>"user:42"</code>, so one writes it where the other never looks.</p>`,
        },
        {
          type: "idea",
          html: `<p>Pass the key through a <strong>stable, well-mixing hash</strong> and give each partition a <strong>range of hash values</strong>. Similar keys scatter uniformly, but so do the records a range query wanted to read together, unless you hash only part of the key (a <strong>compound key</strong>).</p>`,
        },
        {
          type: "text",
          html: `<h3>What the hash has to do</h3>
<p>A partitioning hash has two jobs. It must <strong>spread</strong> keys uniformly, so that sequential or similar keys land far apart. And it must be <strong>stable</strong>: the same key gives the same hash in every process, on every machine, in every language and every library version, for as long as the data exists. It does not need to be cryptographically strong, because nobody is trying to reverse it.</p>
<p>Real systems use simple, well-known functions. Cassandra's older RandomPartitioner and MongoDB's hashed sharding use MD5. Cassandra's default since version 1.2, the Murmur3Partitioner, uses MurmurHash3 and produces tokens from -2<sup>63</sup> to 2<sup>63</sup>-1. Voldemort uses Fowler-Noll-Vo, and Redis Cluster uses CRC16.</p>`,
        },
        {
          type: "code",
          lang: "python",
          title: "An unstable hash and a stable one",
          code: `# Built-in hash() of a str is seeded randomly per process (Python 3.3+):
#   $ python3 -c 'print(hash("user:42") % 8)'    ->  e.g. 3
#   $ python3 -c 'print(hash("user:42") % 8)'    ->  e.g. 6   (new process, new seed)
# Two app servers would disagree about where "user:42" lives.

import hashlib

N_PARTITIONS = 8                    # a fixed partition count, never the node count
RANGE = 2**64 // N_PARTITIONS       # each partition owns one slice of the hash space

def partition_for(key: str) -> int:
    h = int.from_bytes(hashlib.md5(key.encode("utf-8")).digest()[:8], "big")
    return h // RANGE               # same answer in every process, on every machine`,
          caption: `The outputs in the comments are examples; yours will change from run to run, which is the point. Fixing PYTHONHASHSEED makes hash() repeatable, but a named algorithm over the key's bytes, MD5 here, gives the same answer from any language.`,
        },
        {
          type: "text",
          html: `<h3>Ranges of hash values</h3>
<p>Each partition now owns a <strong>range of hash values</strong> instead of a range of keys. With a 32-bit hash and 4 partitions, P0 owns hashes 0 to 2<sup>30</sup>-1, P1 the next quarter, and so on; a key goes to whichever partition's range contains its hash. The boundaries can be evenly spaced, as here, or chosen pseudo-randomly.</p>
<p>Notice what this is <em>not</em>: it is not <code>hash(key) mod number_of_nodes</code>. Taking the hash modulo a <em>fixed</em> number of partitions is fine (Redis Cluster computes CRC16 of the key mod 16,384 hash slots, and 16,384 never changes), but taking it modulo the number of nodes reshuffles almost every key whenever a node is added, as <a href="#/ch6/learn/rebalancing">rebalancing</a> shows.</p>
<p>Pseudo-randomly chosen boundaries are sometimes called <strong>consistent hashing</strong>, a term from Karger and colleagues' 1997 work on distributing web caches. The book argues that the name is confusing for databases and prefers plain <em>hash partitioning</em>. The "consistent" has nothing to do with replica consistency or the C in ACID; it refers to most keys staying where they are when the set of nodes changes.</p>`,
        },
        {
          type: "diagram",
          title: "Neighboring keys, scattered hashes",
          svg: `<style>.dd-diagram-body svg.ch6d-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d-w{display:none!important}.dd-diagram-body svg.ch6d-n{display:block!important}}</style><svg class="ch6d-w" viewBox="0 0 640 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three consecutive readings from sensor S1 hash to positions in partitions P2, P0 and P3 of a hash space split into four equal ranges.">
  <defs>
    <marker id="c6d-hash-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
  </defs>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)">
    <rect x="40" y="8" width="150" height="28" rx="6"/><rect x="245" y="8" width="150" height="28" rx="6"/><rect x="450" y="8" width="150" height="28" rx="6"/>
  </g>
  <g font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">
    <text x="115" y="27">S1 @ 10:00:01</text><text x="320" y="27">S1 @ 10:00:02</text><text x="525" y="27">S1 @ 10:00:03</text>
  </g>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="115" y="54">hash = 0xA3…</text><text x="320" y="54">hash = 0x1C…</text><text x="525" y="54">hash = 0xE7…</text>
  </g>
  <g stroke-width="1.5" marker-end="url(#c6d-hash-m)" style="stroke: var(--viz-c6)">
    <line x1="115" y1="60" x2="402" y2="98"/><line x1="320" y1="60" x2="86" y2="98"/><line x1="525" y1="60" x2="561" y2="98"/>
  </g>
  <g style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)">
    <rect x="20" y="100" width="150" height="28"/><rect x="170" y="100" width="150" height="28"/><rect x="320" y="100" width="150" height="28"/><rect x="470" y="100" width="150" height="28"/>
  </g>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <text x="95" y="119">P0</text><text x="245" y="119">P1</text><text x="395" y="119">P2</text><text x="545" y="119">P3</text>
  </g>
  <g font-size="12" style="fill: var(--viz-muted)">
    <text x="20" y="146">0</text><text x="170" y="146" text-anchor="middle">2³⁰</text><text x="320" y="146" text-anchor="middle">2³¹</text><text x="470" y="146" text-anchor="middle">3 × 2³⁰</text><text x="620" y="146" text-anchor="end">2³²</text>
  </g>
</svg><svg class="ch6d-n" viewBox="0 0 360 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three consecutive readings from sensor S1 hash to positions in partitions P2, P0 and P3 of a hash space split into four equal ranges.">
  <defs><marker id="c6d-hash-mn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker></defs>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"><rect x="8" y="8" width="108" height="28" rx="6"/><rect x="126" y="8" width="108" height="28" rx="6"/><rect x="244" y="8" width="108" height="28" rx="6"/></g>
  <g font-size="11" text-anchor="middle" style="font-family: var(--font-mono)"><text x="62" y="26">S1 @ 10:00:01</text><text x="180" y="26">S1 @ 10:00:02</text><text x="298" y="26">S1 @ 10:00:03</text></g>
  <g font-size="11" text-anchor="middle" style="fill: var(--viz-muted)"><text x="62" y="53">hash = 0xA3…</text><text x="180" y="53">hash = 0x1C…</text><text x="298" y="53">hash = 0xE7…</text></g>
  <g stroke-width="1.5" marker-end="url(#c6d-hash-mn)" style="stroke: var(--viz-c6)"><line x1="62" y1="60" x2="226.5" y2="98"/><line x1="180" y1="60" x2="47.2" y2="98"/><line x1="298" y1="60" x2="316.8" y2="98"/></g>
  <g style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"><rect x="10" y="100" width="85" height="28"/><rect x="95" y="100" width="85" height="28"/><rect x="180" y="100" width="85" height="28"/><rect x="265" y="100" width="85" height="28"/></g>
  <g font-size="12" font-weight="600" text-anchor="middle"><text x="52.5" y="119">P0</text><text x="137.5" y="119">P1</text><text x="222.5" y="119">P2</text><text x="307.5" y="119">P3</text></g>
  <g font-size="11" style="fill: var(--viz-muted)"><text x="10" y="146">0</text><text x="95" y="146" text-anchor="middle">2³⁰</text><text x="180" y="146" text-anchor="middle">2³¹</text><text x="265" y="146" text-anchor="middle">3 × 2³⁰</text><text x="350" y="146" text-anchor="end">2³²</text></g>
</svg>`,
          caption: `Three readings one second apart land in three different partitions (hash values illustrative). That is ideal for spreading writes and fatal for "S1 from 10:00:01 to 10:00:03", which can no longer go to one place.`,
        },
        {
          type: "text",
          html: `<h3>The price: order is gone</h3>
<p>A good hash scatters neighboring keys on purpose, so a range query on the key can no longer be sent to one partition. MongoDB's hashed sharding sends such range queries to every shard, and Riak, Couchbase and Voldemort don't support range queries on the primary key at all. You traded a write hot spot for a <strong>scatter-gather</strong> read.</p>
<p>The visualization below puts the two strategies side by side, plus a third. Eight sensors each write one reading a minute, keyed by (sensor, time), into four partitions. You choose how keys map to partitions, drag the clock, and fire two queries: one sensor's last 2 hours, and all sensors for one hour.</p>`,
        },
        {
          type: "viz",
          id: "ch6/range-vs-hash",
          title: "Range vs hash partitioning",
          caption: `Try the opening scene first: under <em>Time range</em> (four 6-hour ranges, as in the opening story), every write for today's 14:xx lands in P2 on node C, the story's overloaded third node. Drag the Clock and the hot spot moves with it. Switch to <em>Hash of key</em>: the bars even out, but <em>Query: S3, last 2 h</em> now asks all four partitions. Then pick <em>Sensor, then time</em> and run both queries. Notice that the per-sensor query becomes a single scan, while the all-sensors query needs eight. Finally turn on <em>S3 is 10x busier</em>: a key prefix spreads load only when traffic is spread evenly across its values.`,
        },
        {
          type: "text",
          html: `<p>Under <em>Time range</em> the first frame already shows the failure: one partition takes 100% of writes, and the clock only moves the fire. <em>Hash of key</em> fixes the writes, but S3's rows are now interleaved with everyone else's in every partition, so even a two-hour query for one sensor is a four-way scatter-gather. <em>Sensor, then time</em> gives you both properties for per-sensor queries: writes spread over sensors, and S3's readings are one sorted run inside one partition. Its weaknesses show twice. A busy sensor makes its partition hot, and the cross-sensor time query needs one scan per sensor.</p>
<h3>Compound keys: hash the entity, sort within it</h3>
<p>That third shape is so useful that several databases build it in. Cassandra's <strong>compound primary key</strong> hashes only the first part, the <strong>partition key</strong>, to decide where data lives; the remaining columns, the <strong>clustering columns</strong>, set the sort order of rows within that partition's SSTables. With <code>PRIMARY KEY ((user_id), posted_at)</code>, all of user 42's posts sit together, sorted by time, so "user 42's posts in March" is one partition and one contiguous slice, while different users still spread evenly across the cluster.</p>`,
        },
        {
          type: "diagram",
          title: "Anatomy of a compound key",
          svg: `<style>.dd-diagram-body svg.ch6d-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d-w{display:none!important}.dd-diagram-body svg.ch6d-n{display:block!important}}</style><svg class="ch6d-w" viewBox="0 0 640 262" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The key user_id = 42, posted_at = 2024-03-09 is split: the partition key goes through hash() to partition 7 of 16; inside partition 7, user 42's rows are contiguous and sorted by posted_at, so March is one contiguous scan.">
  <defs>
    <marker id="c6d-ckey-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
    <marker id="c6d-ckey-c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker>
  </defs>
  <rect x="20" y="14" width="158" height="34" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="182" y="14" width="248" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="99" y="36" font-size="13" text-anchor="middle" style="font-family: var(--font-mono)">user_id = 42</text>
  <text x="306" y="36" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">posted_at = 2024-03-09 10:00</text>
  <text x="99" y="66" font-size="12" font-weight="600" text-anchor="middle">partition key</text>
  <text x="306" y="66" font-size="12" font-weight="600" text-anchor="middle">clustering column</text>
  <line x1="99" y1="72" x2="99" y2="98" stroke-width="1.5" marker-end="url(#c6d-ckey-m)" style="stroke: var(--viz-muted)"/>
  <rect x="44" y="100" width="110" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="99" y="120" font-size="13" text-anchor="middle" style="font-family: var(--font-mono)">hash()</text>
  <line x1="99" y1="130" x2="99" y2="158" stroke-width="1.5" marker-end="url(#c6d-ckey-m)" style="stroke: var(--viz-muted)"/>
  <rect x="20" y="160" width="158" height="34" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="99" y="182" font-size="13" text-anchor="middle">partition 7 of 16</text>
  <line x1="178" y1="177" x2="218" y2="177" stroke-width="1.5" marker-end="url(#c6d-ckey-m)" style="stroke: var(--viz-muted)"/>
  <rect x="220" y="86" width="404" height="168" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="236" y="106" font-size="12" font-weight="600">inside partition 7</text>
  <rect x="232" y="151" width="160" height="72" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <g font-size="12" style="font-family: var(--font-mono)">
    <text x="240" y="128" style="fill: var(--viz-muted)">user 1187 · Jan 03</text>
    <text x="240" y="146">user 42 · Feb 27</text>
    <text x="240" y="164">user 42 · Mar 01</text>
    <text x="240" y="182">user 42 · Mar 03</text>
    <text x="240" y="200">user 42 · Mar 09</text>
    <text x="240" y="218">user 42 · Mar 28</text>
    <text x="240" y="236">user 42 · Apr 02</text>
  </g>
  <path d="M398,153 h8 v68 h-8" stroke-width="1.5" fill="none" style="stroke: var(--viz-c2)"/>
  <line x1="370" y1="70" x2="450" y2="156" stroke-width="1.5" marker-end="url(#c6d-ckey-c2)" style="stroke: var(--viz-c2)"/>
  <text x="416" y="172" font-size="12" font-weight="600">sorted by posted_at</text>
  <text x="416" y="190" font-size="12">one contiguous scan:</text>
  <text x="416" y="206" font-size="12">user 42, March</text>
</svg><svg class="ch6d-n" viewBox="0 0 360 366" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The key user_id = 42, posted_at = 2024-03-09 is split: the partition key goes through hash() to partition 7 of 16; inside partition 7, user 42's rows are contiguous and sorted by posted_at, so March is one contiguous scan.">
  <defs>
    <marker id="c6d-ckey-mn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
    <marker id="c6d-ckey-c2n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker>
  </defs>
  <rect x="8" y="10" width="118" height="32" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <rect x="132" y="10" width="220" height="32" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="67" y="31" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">user_id = 42</text>
  <text x="242" y="31" font-size="11" text-anchor="middle" style="font-family: var(--font-mono)">posted_at = 2024-03-09 10:00</text>
  <text x="67" y="60" font-size="12" font-weight="600" text-anchor="middle">partition key</text>
  <text x="242" y="60" font-size="12" font-weight="600" text-anchor="middle">clustering column</text>
  <line x1="67" y1="66" x2="67" y2="86" stroke-width="1.5" marker-end="url(#c6d-ckey-mn)" style="stroke: var(--viz-muted)"/>
  <rect x="22" y="88" width="90" height="28" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="67" y="107" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">hash()</text>
  <line x1="67" y1="116" x2="67" y2="136" stroke-width="1.5" marker-end="url(#c6d-ckey-mn)" style="stroke: var(--viz-muted)"/>
  <rect x="8" y="138" width="118" height="30" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="67" y="158" font-size="12" text-anchor="middle">partition 7 of 16</text>
  <line x1="67" y1="168" x2="67" y2="192" stroke-width="1.5" marker-end="url(#c6d-ckey-mn)" style="stroke: var(--viz-muted)"/>
  <rect x="8" y="194" width="344" height="164" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="20" y="214" font-size="12" font-weight="600">inside partition 7</text>
  <rect x="14" y="259" width="152" height="72" rx="4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <g font-size="12" style="font-family: var(--font-mono)">
    <text x="22" y="236" style="fill: var(--viz-muted)">user 1187 · Jan 03</text>
    <text x="22" y="254">user 42 · Feb 27</text>
    <text x="22" y="272">user 42 · Mar 01</text>
    <text x="22" y="290">user 42 · Mar 03</text>
    <text x="22" y="308">user 42 · Mar 09</text>
    <text x="22" y="326">user 42 · Mar 28</text>
    <text x="22" y="344">user 42 · Apr 02</text>
  </g>
  <path d="M172,261 h8 v68 h-8" stroke-width="1.5" fill="none" style="stroke: var(--viz-c2)"/>
  <line x1="262" y1="66" x2="262" y2="262" stroke-width="1.5" marker-end="url(#c6d-ckey-c2n)" style="stroke: var(--viz-c2)"/>
  <text x="188" y="282" font-size="12" font-weight="600">sorted by posted_at</text>
  <text x="188" y="300" font-size="12">one contiguous scan:</text>
  <text x="188" y="316" font-size="12">user 42, March</text>
</svg>`,
          caption: `Only the partition key is hashed, so it alone picks the partition; the clustering column orders rows inside it. User 42's March posts form one contiguous slice, even though partition 7 also holds many other users.`,
        },
        {
          type: "text",
          html: `<p>The pattern recurs everywhere. DynamoDB has a <strong>partition key</strong> plus an optional <strong>sort key</strong>. A Bigtable or HBase row key such as <code>user42#reversed_timestamp</code> keeps one user's rows together, newest first. Redis Cluster's <strong>hash tags</strong> hash only the part of a key between braces, so <code>{user42}.cart</code> and <code>{user42}.profile</code> share a slot. The design rule: make the <strong>partition key</strong> the entity your most important queries are scoped to, and the <strong>sort key</strong> the order you read in.</p>
<h3>Co-location: keep together what you use together</h3>
<p>The same thinking extends across tables. If every table that belongs to a tenant starts its key with <code>tenant_id</code>, one tenant's orders, invoices and users share a partition, so joins and transactions within a tenant stay on one machine. Spanner's <strong>interleaved tables</strong> store child rows inside their parent row's key range; Citus <strong>co-locates</strong> tables distributed by the same column; Figma groups tables that share a shard key into "colos". Whatever cannot be co-located pays later, in scatter-gather reads, global indexes or cross-partition transactions (Chapter 7, and two-phase commit in Chapter 9).</p>
<h3>Keeping each entity's partition bounded</h3>
<p>Per-entity partitions have one catch: an entity can grow forever. A busy chat channel accumulates years of messages in one partition, which eventually gets too big to read, compact or repair comfortably. The standard fix is a <strong>time bucket</strong> in the partition key. Discord partitioned messages by <code>(channel_id, bucket)</code>, where a bucket is a fixed 10-day window: reading recent messages touches one or two buckets, and old buckets stop growing.</p>
<p>And there is one thing hashing can never do: spread a single key. Identical keys produce identical hashes, so every request for one celebrity's counter still lands on one partition. The next section takes that on.</p>`,
        },
        {
          type: "table",
          title: "Three ways to map keys to partitions",
          headers: ["", "Key range", "Hash of the whole key", "Compound key (hash entity, sort within)"],
          rows: [
            ["Sequential or time-ordered keys", "All writes hit the newest range", "Spread evenly", "Spread across entities, if the entities are similarly busy"],
            ["Range scan over the key", "One or a few partitions", "Every partition (scatter-gather)", "Within one entity: one partition. Across entities: every partition"],
            ["Choosing boundaries", "Must follow the data (by hand or by automatic splits)", "Even hash ranges, no tuning", "Even hash ranges over the partition key"],
            ["One very hot key", "One partition", "One partition", "One partition"],
            ["Examples", "Bigtable, HBase, Spanner, CockroachDB, MongoDB ranged sharding", "MongoDB hashed sharding, Redis Cluster, Riak, Voldemort", "Cassandra, ScyllaDB, DynamoDB (partition key + sort key)"],
          ],
          note: "The last-but-one row is the point of the next section: no mapping can split a single key.",
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache Cassandra",
              tag: "Murmur3 + clustering",
              html: `Murmur3Partitioner has been the default since Cassandra 1.2 (the earlier RandomPartitioner used MD5). A CQL <code>PRIMARY KEY ((partition key), clustering columns...)</code> hashes only the partition key; rows within a partition are stored sorted by the clustering columns.`,
            },
            {
              org: "Amazon DynamoDB",
              tag: "partition + sort key",
              html: `The partition key's value is hashed to choose a storage partition. With a composite primary key, items that share a partition key are stored together, sorted by sort key, and a Query must give an exact partition key, optionally with a range condition on the sort key.`,
            },
            {
              org: "Discord",
              year: "2017",
              tag: "time buckets",
              html: `"How Discord Stores Billions of Messages": messages in Cassandra used the partition key <code>(channel_id, bucket)</code>, with the bucket a static 10-day window, and were clustered by a time-ordered Snowflake <code>message_id</code>. Reading a channel's recent messages hits one partition in order, and no partition grows without bound.`,
            },
            {
              org: "Redis Cluster",
              tag: "hash slots + tags",
              html: `The keyspace is split into 16,384 <strong>hash slots</strong>: slot = CRC16(key) mod 16384. A hash tag such as <code>{user42}.cart</code> and <code>{user42}.profile</code> hashes only the text between the first <code>{</code> and the next <code>}</code> (provided it is non-empty), forcing related keys into the same slot so multi-key operations work.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"We hash the key, so we can't have hot spots\"",
          html: `<p>Hashing spreads <em>distinct</em> keys evenly. It does nothing for a single key that receives a huge share of the traffic, and nothing for one entity under a compound key that is far bigger or busier than the rest. A second confusion often rides along: "consistent hashing" is a placement technique. It gives no guarantee about replicas agreeing or transactions keeping invariants, and on its own it doesn't even guarantee even load, as <a href="#/ch6/learn/rebalancing">rebalancing</a> shows.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Almost every design interview asks you to pick a partition key, and the strongest answers derive it rather than assert it. List the top two or three queries. Make the partition key the entity they are scoped to (user, tenant, channel, device) and the sort key the order they read in. Then check three things out loud: <strong>cardinality and balance</strong> (many distinct values, no single dominant one), <strong>growth</strong> (does one entity's partition grow forever? add a time bucket), and <strong>what becomes scatter-gather</strong> (the queries that don't include the partition key). Mention that you'd hash the partition key unless you need range scans across entities.</p>`,
        },
        {
          type: "quiz",
          q: "A Cassandra table has PRIMARY KEY ((user_id), posted_at). Which query is served from a single partition with one contiguous scan?",
          options: [
            "All posts made in March by any user",
            "Users whose user_id is between 1000 and 2000",
            "Posts by user 42 between March 1 and March 31",
            "The 10 newest posts across all users",
          ],
          answer: 2,
          explain: `Only user_id is hashed, so user 42's rows share one partition, sorted by posted_at, and a date range for that user is one contiguous slice. Option A is tempting because posted_at is sorted, but only within each user's partition: "March, any user" has to visit every partition. Option B asks for a range of the hashed column, which hashing scattered, and option D spans all users.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "hot-spots",
      title: "When one key is hotter than a whole partition",
      kicker: "Skew",
      concepts: ["hot-spot", "key-salting"],
      blocks: [
        {
          type: "problem",
          title: "One key, one partition, no escape",
          html: `<p>Even a perfect hash sends every request for the same key to the same partition. A celebrity's new post, a viral video's view counter, a flash-sale product or one enormous tenant can pour tens of thousands of requests per second onto a single key, and therefore onto a single partition, while the cluster-wide average looks perfectly healthy.</p>
<p>Adding nodes does nothing, because one key never spans two partitions. Most databases of the book's era couldn't compensate automatically, so the overloaded partition throttled or slowed down every other key unlucky enough to share it. Hashing fixed skew in the <em>keys</em>; this is skew in the <em>access pattern</em>, and the partitioner cannot see it.</p>`,
        },
        {
          type: "idea",
          html: `<p>A partitioner can only spread <strong>distinct keys</strong>. So the application has to turn one hot key into many keys, or many writes into fewer, and it pays for that on every read.</p>`,
        },
        {
          type: "text",
          html: `<h3>Where hot keys come from</h3>
<ul>
<li><strong>Celebrities.</strong> The book's example is a social-media account with millions of followers: when it does something, a storm of writes hits one key, such as the user's ID or the ID of the post everyone is reacting to.</li>
<li><strong>Counters.</strong> Likes, views, the stock level of a flash-sale item: every increment writes the same key.</li>
<li><strong>Time as the whole partition key.</strong> Partition by today's date and today's partition is hot even under hashing, because "today" is a single value.</li>
<li><strong>Giant tenants.</strong> In a multi-tenant system keyed by tenant ID, one customer can be bigger than the next thousand combined.</li>
</ul>
<h3>Salting: split one key into many</h3>
<p>The book's technique is to add a small random number to the hot key. With a two-digit suffix (00 to 99), writes for <code>post:42</code> become writes to <code>post:42#00</code> through <code>post:42#99</code>: up to 100 different keys that hash to different partitions. This is usually called <strong>salting</strong> or <strong>write sharding</strong>.</p>
<p>The bill arrives on reads. To count post 42's likes you must now read all 100 sub-keys and add them up: 100 requests, a merge, and a latency set by the slowest partition you touched (tail latency amplification, Chapter 1). So salt only the few keys that are actually hot. That takes bookkeeping: a registry of which keys are split and how many ways, and a careful way to move a key between split and unsplit without losing writes in flight.</p>
<p>The suffix can be <strong>random</strong>, which spreads writes as widely as possible but forces every read to ask all k sub-keys. Or it can be <strong>calculated</strong>, for example <code>hash(order_id) mod k</code> appended to a hot date key: writes still spread over k sub-keys, but a read for one specific order knows exactly which sub-key holds it.</p>
<p>In the sandbox below there are 8 partitions, each able to absorb 1,000 writes per second, the same figure as DynamoDB's documented per-partition write limit. Ordinary traffic fills each one to 50%. Then a viral post's like counter, <code>post:42</code>, starts taking 2,500 writes per second.</p>`,
        },
        {
          type: "viz",
          id: "ch6/hot-key-split",
          title: "Splitting a celebrity key",
          caption: `Try the opening scene: all 2,500 writes/s for post:42 carry one key, so P3 runs at 300% of its limit while the other seven idle at 50%. Raise <em>Split into k sub-keys</em> to 5, then 8, pressing <em>Read like count</em> each time, then try 9 and 16. Notice that 8 sub-keys already spread the writes as far as they can go: at 9, P3 holds two sub-keys and is over its limit again, and 16 looks just like 8, while every read keeps paying k requests. Then set k back to 1, push the hot key to 6,000/s and turn on <em>Combine writes in app</em>: the hot bar drops with no read fan-out, at the price of lag and possibly lost increments.`,
        },
        {
          type: "text",
          html: `<p>At k = 1, all 2,500 writes/s share one key and one partition: P3 throttles 2,000 writes/s while seven partitions sit at half load, and more partitions would change nothing. Splitting five ways puts exactly 1,000/s on each of five partitions, right at the limit; eight ways brings everything comfortably under it. Beyond 8 the writes cannot spread any further, because there are only 8 partitions: 16 sub-keys give exactly the same bars as 8, and in between, partitions holding two sub-keys get twice the share (at k = 9, P3 is over its limit again). Meanwhile the number of requests per read keeps climbing. Turning on <em>Salt every key</em> shows why salting is a scalpel, not a policy: every ordinary read now pays k requests too.</p>
<p>The other fix doesn't touch the key at all. <strong>Write combining</strong> buffers increments in each app server and flushes one "+n" write every 100 ms, so 20 servers send at most 200 writes/s for <code>post:42</code> however viral it gets, and reads stay single-request. The cost: the count lags by up to one flush interval, and increments buffered in a server that crashes are lost. That is fine for likes and unacceptable for payments.</p>
<h3>Read-hot and write-hot keys need different tools</h3>
<p>A <strong>read-hot</strong> key is the easier case: put a cache or CDN in front of it, or serve it from read replicas, since many copies can answer the same read. <strong>Request coalescing</strong> helps too: many identical concurrent reads become one database query. A <strong>write-hot</strong> key needs key splitting, write combining, or a data structure built for concurrent updates, such as sharded counters (or the CRDT counters of Chapter 5). Applications also special-case the extremes: Twitter's hybrid fan-out treats celebrity accounts differently from everyone else (Chapter 1).</p>
<h3>Skew in size, not just in traffic</h3>
<p>A key can be a problem because it is enormous rather than busy. A per-entity partition that grows forever, such as one chat channel's entire history, becomes a "wide" partition that is slow to read, compact and repair. The fix is the time bucket from the previous section: put a bounded time window into the partition key.</p>
<h3>Finding hot keys before they melt a partition</h3>
<p>Per-node CPU and throughput averages hide a single hot key; you need per-key sampling and top-N metrics. CloudWatch Contributor Insights reports DynamoDB's most-accessed and most-throttled keys. Key Visualizer draws heatmaps of reads and writes across Bigtable and Spanner key ranges over time, so hot rows and monotonically increasing keys stand out. <code>redis-cli --hotkeys</code> lists Redis's hottest keys, provided the server runs an LFU eviction policy.</p>`,
        },
        {
          type: "compare",
          title: "Three families of fixes, three different bills",
          items: [
            {
              title: "Split the key",
              tone: "warn",
              html: `Salting or write sharding: k sub-keys spread one key's writes over up to k partitions.<br><strong>Bill:</strong> every read fans out k ways and waits for the slowest; the app must track which keys are split.`,
            },
            {
              title: "Combine writes",
              tone: "ok",
              html: `Batch increments in app servers and flush "+n" periodically, so the database sees a bounded write rate.<br><strong>Bill:</strong> counts lag by a flush interval, and buffered increments die with their server.`,
            },
            {
              title: "Absorb reads",
              tone: "info",
              html: `Caches, CDNs, read replicas and request coalescing serve one hot value many times.<br><strong>Bill:</strong> staleness, and no help at all for a key that is hot because of writes.`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Amazon DynamoDB",
              tag: "per-partition limits",
              html: `Each partition serves at most <strong>3,000 read capacity units and 1,000 write capacity units</strong> per second, regardless of the table's total capacity. AWS documents write sharding (a random or calculated suffix on the partition key) for hot keys. Adaptive capacity and split-for-heat can isolate a busy item on its own partition, but they cannot lift a single key past the per-partition limits.`,
            },
            {
              org: "Discord",
              year: "2023",
              tag: "request coalescing",
              html: `"How Discord Stores Trillions of Messages" describes hot partitions (busy channels) in Cassandra degrading latency across the cluster, not just for the busy channel. Discord added Rust data services, routed by channel ID, that coalesce concurrent requests for the same row into one database query, and in 2022 moved from 177 Cassandra nodes to 72 ScyllaDB nodes; p99 latency for historical messages fell from 40–125 ms to about 15 ms.`,
            },
            {
              org: "Facebook memcache",
              year: "2013",
              tag: "leases",
              html: `"Scaling Memcache at Facebook" (NSDI 2013) introduced <strong>leases</strong>: when a popular key is missing from the cache, only one client is allowed to refill it from the database, while others wait briefly or accept slightly stale data. That stops a thundering herd of identical database reads for one hot key.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Databases that split hot ranges for you",
          html: `<p>Since the book, several databases detect hot ranges and react on their own. DynamoDB's adaptive capacity and split-for-heat move or split busy partitions, so a hot item can end up on a partition of its own. CockroachDB splits ranges by load as well as by size (512 MiB by default in current versions), so the two halves of a busy range can live on different nodes. Bigtable and Spanner's Key Visualizer makes hot ranges visible at a glance. None of them can push one key's write rate beyond what a single partition can serve: isolating a hot key is the best they can do, so a truly hot single key still needs splitting or combining in the application.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Salting a hot key",
          pros: [
            "Spreads one key's writes over up to k partitions, so its write rate is no longer capped by one partition.",
            "Works on any partitioned store, with no special database support.",
            "A calculated suffix keeps lookups of one specific item to a single request.",
          ],
          cons: [
            "Every read of the whole key fans out k ways and waits for the slowest sub-key.",
            "Reads must merge partial results (sum, union, latest-wins).",
            "Needs a registry of split keys and a safe way to split and unsplit them.",
            "Gains nothing beyond the number of partitions, and is the wrong tool for read-hot keys, where a cache is simpler.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>The celebrity problem appears in nearly every social-feed, counter or ticketing design. Interviewers probe whether you know that consistent hashing, more nodes or a different partitioner do nothing for one hot key. A strong answer separates read-hot from write-hot. Reads: cache, replicate, coalesce. Writes: split the key into k sub-keys (and state the read fan-out and bookkeeping), combine writes in memory (and state the lag and crash loss), or move work off the hot path the way hybrid fan-out does. Extra credit for saying how you would detect the hot key in the first place (per-key top-N metrics), and that managed split-for-heat still cannot exceed one partition's limit for one key.</p>`,
        },
        {
          type: "quiz",
          q: "A viral post's like counter receives 50,000 writes/s in a table hash-partitioned across 200 nodes. Which statement is true?",
          options: [
            "Hash partitioning already spreads those writes across the 200 nodes",
            "Adding another 200 nodes would halve the load on the hot partition",
            "Switching to key-range partitioning would spread the writes",
            "All writes to that key land on one partition; you must change the key (e.g., sub-keys) or combine writes before they reach it",
          ],
          answer: 3,
          explain: `The partitioner only spreads distinct keys, and one key maps to one partition under any scheme. Option B is the tempting one: more nodes do lower the average load per node, but the hot key still maps to exactly one partition, so its load doesn't move. Key ranges don't help either, since one key is one point in the range. Splitting the key into sub-keys (paying on reads) or batching increments in memory are the real fixes.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "secondary-indexes",
      title: "Secondary indexes: pay on writes or pay on reads",
      kicker: "Indexes",
      concepts: ["partitioning-secondary-indexes-local-by-document", "partitioning-secondary-indexes-global-by-term", "scatter-gather"],
      blocks: [
        {
          type: "problem",
          title: "Red cars live on every partition",
          html: `<p>Partitioning by primary key makes "get car #893" a single hop. But applications also ask "all red cars", "every order by customer 17" and "documents containing <em>kafka</em>", and the value <em>red</em> appears in records on every partition. A secondary index doesn't identify one record; it finds all records with a given value, and partitioning scattered those records on purpose.</p>
<p>Both naive options fail. Scanning every record on every partition for each query is hopeless at scale. Keeping one unpartitioned index on a single machine sends the whole index's read and write traffic to that one box, recreating exactly the bottleneck partitioning was supposed to remove.</p>`,
        },
        {
          type: "idea",
          html: `<p>Either partition the index <strong>with the documents</strong> (local: each write stays on one partition, but a query must ask all of them), or partition it <strong>by the indexed value</strong> (global: a query asks one place, but a write may touch several index partitions and is usually applied asynchronously). You choose which side pays.</p>`,
        },
        {
          type: "text",
          html: `<p>Secondary indexes are the bread and butter of relational and document databases, and the reason search servers such as Solr and Elasticsearch exist. Yet many key-value stores, HBase and Voldemort among them, have avoided them, precisely because they don't map neatly onto partitions.</p>
<h3>Local indexes: partition the index with the documents</h3>
<p>In a <strong>document-partitioned</strong> or <strong>local index</strong>, each partition maintains a secondary index over only its own documents. Picture a used-car site partitioned by listing ID: partition 0 holds cars #0–499 and knows that, among <em>its</em> cars, #112 and #388 are red. Adding, updating or removing a car touches exactly one partition, the one that holds it, and the car and its index entries change together.</p>
<p>Reading is the problem. Red cars could be on any partition, so "find red cars" must go to every partition and the partial answers must be merged: a <strong>scatter-gather</strong> read. Its cost grows with the number of partitions, and its latency is set by the slowest one, so tail latency amplification (Chapter 1) applies in full. Sending the requests in parallel doesn't fix that; with 100 partitions, every query waits for the worst of 100.</p>
<p>Local indexes are nonetheless everywhere: MongoDB, Riak, Cassandra, Elasticsearch, SolrCloud and VoltDB all keep secondary indexes per partition. Vendors advise structuring data so that common index queries can be served by one partition, and scatter-gather is avoidable whenever the query also names the partition key. If listings were partitioned by <code>dealer_id</code>, "red cars at dealer 17" would go to one partition and use its local index. That isn't always possible, especially when one query filters on several indexed fields at once.</p>`,
        },
        {
          type: "text",
          html: `<h3>Global indexes: partition the index by the term</h3>
<p>A <strong>global index</strong> covers all the data and is itself partitioned, by the indexed value rather than by document. Every entry for <em>red</em>, wherever those cars live, sits in one index partition. The index can be split by the term itself (colors a–r in one index partition, s–z in another), which keeps range queries over the indexed value possible, such as "price between 1,000 and 2,000", or by a hash of the term, which spreads load more evenly. Hence the other name, <strong>term-partitioned</strong> index. "Term" comes from full-text search, where the terms are the words in an inverted index; here it simply means a field value.</p>
<p>Reads become cheap: "find red cars" asks one index partition. Fetching the cars themselves may still touch several data partitions, unless the index stores the attributes the query needs, as DynamoDB's index projections can.</p>
<p>Writes become the problem. One document write may update several index partitions, because each indexed value can live on a different one. Repainting car #388 from red to silver touches the car's own partition plus two index partitions: remove 388 from <em>red</em>, add it to <em>silver</em>. Making all of that atomic needs a cross-partition (distributed) transaction, so many systems update global indexes <strong>asynchronously</strong> instead: the write is acknowledged once the record is stored, and the index catches up a little later. A read right after a write may not see it. DynamoDB's global secondary indexes work this way, and Oracle lets you choose local or global partitioned indexes per index.</p>
<h3>Uniqueness needs a global view</h3>
<p>Local indexes cannot enforce uniqueness on a column that isn't part of the partition key. If users are partitioned by user ID and two sign-ups with the same email land on different partitions, each partition checks its own index, finds no conflict, and accepts. Enforcing it takes a global index updated transactionally, or a separate record keyed by the email itself, written with a conditional "insert if absent" in the same transaction as the user record. The exception is a unique key that includes the partition key, which each partition can check alone. MongoDB, for instance, enforces a unique index across a sharded collection only when the index is prefixed by the shard key.</p>
<p>The visualization below has nine cars on three data partitions. You can switch between a local and a global index, slow one partition down, add and repaint cars, and race a query against an asynchronous index update.</p>`,
        },
        {
          type: "viz",
          id: "ch6/secondary-index",
          title: "Local vs global secondary indexes",
          caption: `Try <em>Find red cars</em> in Local mode, then turn on <em>P2 is slow</em> and repeat: the whole query waits for P2. Switch to Global and the same query asks one index partition. With Async updates, press <em>Add, then find at once</em>: the new car is missing. Drag <em>Index lag</em> to 0.9 s or less and press it again to see the race go the other way. Then press <em>Repaint a car</em>: the first repaint, #388 from red to silver, touches three partitions. The lag slider is slowed-down animation time; the latency stats are simulated milliseconds.`,
        },
        {
          type: "text",
          html: `<p>In Local mode the query always asks all three partitions, and with P2 slowed down the answer takes 110 ms instead of 20: a scatter-gather is only as fast as its slowest member. In Global mode one request to Index A answers it, and P2's slowness stops mattering for this query. The bill moves to writes. A synchronous global index commits the car and its index entries in one distributed transaction, so reads are never stale, but every indexed write pays extra round trips and holds locks on every participant until it commits. An asynchronous index acknowledges after the data write, so whether "add, then find" sees the new car depends on which arrives first, the index update or the query. That race is not something your code controls, and in production the lag tends to grow exactly when the system is busiest.</p>
<p>A third option takes index maintenance off the write path entirely: maintain the global index as <strong>derived data</strong>, built by a separate process from a change stream of the base table (Chapters 11 and 12). Writes stay single-partition and fast; the index lags, but the lag is explicit and measurable instead of hidden inside the database.</p>`,
        },
        {
          type: "table",
          title: "Local versus global secondary indexes",
          headers: ["", "Local index (by document)", "Global index (by term)"],
          rows: [
            ["Adding or updating a document", "One partition: the document and its index entries change together", "The data partition plus each index partition holding one of its values"],
            ["Repainting car #388 red → silver", "1 partition", "3 partitions: the car's own, \"red\" (remove) and \"silver\" (add)"],
            ["Query by indexed value", "Every partition (scatter-gather), unless the query also names the partition key", "One index partition, plus fetching documents unless the index stores the needed fields"],
            ["Latency is set by", "The slowest partition of all", "The index partition for reads; the slowest participant for synchronous writes"],
            ["Freshness of index reads", "Same as the data, since both change together", "Often asynchronous, so a read just after a write can miss it; fresh only with a distributed transaction"],
            ["Unique constraint on a non-partition-key column", "Not enforceable by the index alone", "Possible if the index is updated transactionally"],
            ["Examples", "MongoDB, Cassandra, Elasticsearch, SolrCloud, Riak, VoltDB, DynamoDB LSIs", "DynamoDB GSIs, Riak's search feature, Spanner, CockroachDB, TiDB, YugabyteDB"],
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Elasticsearch",
              tag: "document-partitioned",
              html: `Each shard is a self-contained Lucene index with its own inverted index over its own documents. A search goes to one copy of every shard, and a coordinating node merges the top hits (query-then-fetch), so every search is a scatter-gather and more shards mean more work per query.`,
            },
            {
              org: "MongoDB",
              tag: "broadcast queries",
              html: `Secondary indexes are maintained per shard. A query that doesn't include the shard key is broadcast by the <code>mongos</code> router to all shards and the results merged; one that includes it is targeted at the shard that owns that key.`,
            },
            {
              org: "Amazon DynamoDB",
              tag: "GSI vs LSI",
              html: `<strong>Global secondary indexes</strong> are updated asynchronously and support only eventually consistent reads; AWS says propagation normally takes a fraction of a second but can take longer, so there is no bound to rely on. An under-provisioned GSI applies back-pressure that throttles writes to the base table. <strong>Local secondary indexes</strong> share the table's partition key, allow strongly consistent reads, must be created with the table, and cap each partition-key value's item collection at 10 GB.`,
            },
            {
              org: "Google Spanner / CockroachDB",
              tag: "transactional index",
              html: `Secondary indexes are stored as separate key ranges and maintained inside the same transaction as the base-table write, so index reads are consistent with the data. The cost is a cross-range, and often cross-node, commit on every indexed write.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Distributed SQL chose the transactional global index",
          html: `<p>Spanner, CockroachDB, YugabyteDB and TiDB all store each secondary index as just another table: a separate key range, partitioned by the indexed columns, updated in the same distributed transaction as the row. Index reads are as fresh as anything else, and every indexed write pays a cross-partition commit. Cassandra went the other way and kept indexes local: its native secondary indexes and the Storage-Attached Indexing (SAI) added in Cassandra 5.0 are both per node, and its server-maintained global alternative, materialized views, was later marked experimental.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Orders are sharded by order ID; how do you list a customer's orders?" is a standard follow-up. A strong answer lays out both designs with their bills. A local index gives cheap writes and a scatter-gather on every query, as slow as the slowest shard. A global index partitioned by customer gives one-hop reads, but every order write also updates another partition, either transactionally (two-phase commit, slower writes) or asynchronously (stale reads). Then choose from the workload: read-heavy and tolerant of a little staleness suggests an async global index or a view derived from change data capture; strict freshness suggests a transactional index; often the best move is re-keying so the hot query includes the partition key. Bringing up uniqueness (a unique email needs a global view) is a strong signal.</p>`,
        },
        {
          type: "quiz",
          q: "A product catalog is split into 64 partitions by product ID. \"Find products by color\" is the busiest query and writes are rare. Which index fits, and what do you pay?",
          options: [
            "A local index, because each color query then hits a single partition",
            "A global index partitioned by color: a query hits one index partition, but each product write may also update a remote index partition, often asynchronously",
            "A local index, because each product write must update all 64 partitions",
            "A global index, even though color queries still have to ask all 64 partitions",
          ],
          answer: 1,
          explain: `With a read-heavy, rarely written workload, paying extra on writes to make reads single-partition is a good trade. Option A is the tempting one, but it has the costs backwards: with a local index, every partition might hold products of any color, so each color query is a 64-way scatter-gather. Option C is backwards too: it is the global index whose writes reach other partitions, while a local index write touches only one. And option D describes a local index, not a global one.`,
        },
      ],
    },
  ],
});
