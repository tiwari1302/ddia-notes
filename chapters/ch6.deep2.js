// Chapter 6 deep dive, part 2 (rebalancing, rebalancing strategies and operations,
// request routing) plus takeaways, connections and further reading.
// Part 1 (hook, why partition, key ranges, hashing, hot spots, secondary indexes) is ch6.deep.js.
// Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch6", {
  sections: [
    // ------------------------------------------------------------------ 6
    {
      id: "rebalancing",
      title: "Rebalancing without moving everything",
      kicker: "Growth",
      concepts: ["rebalancing", "hash-mod-n", "consistent-hashing"],
      blocks: [
        {
          type: "problem",
          title: "The day you add a node",
          html: `<p>A cluster never stays the size you built it. Data grows and needs more disks, traffic grows and needs more CPUs, and machines die, so their partitions need a new home. Each of these changes means <strong>rebalancing</strong>: moving data and request load from some nodes to others, over the same network links and disks that are busy serving production traffic.</p>
<p>The obvious way to place keys turns this into a disaster. If a key lives on node <code>hash(key) mod N</code>, every key's location depends on N. Picture a cache tier (illustrative numbers): 10 memcached servers absorb 200,000 reads per second with a 95% hit rate, so the database behind them sees about 10,000 queries per second. Add an 11th server and about 91% of keys now hash to a different server, one that doesn't have them cached. The hit rate collapses below 10%, and the database is suddenly asked for roughly 180,000 queries per second, eighteen times its normal load, at the very moment you were trying to add capacity.</p>`,
        },
        {
          type: "idea",
          html: `<p>Decouple keys from nodes. Map each key to a <strong>partition</strong> with a function that never changes, then move whole partitions (or small hash ranges) between nodes. Adding a node then moves only about its fair share, roughly <strong>1/(N+1)</strong> of the data, and all of it goes to the new node.</p>`,
        },
        {
          type: "keypoints",
          title: "What a good rebalancing scheme must do",
          items: [
            "<strong>Leave the load fair afterwards.</strong> Storage, reads and writes should end up shared evenly across the nodes, including the new one.",
            "<strong>Keep serving during the move.</strong> The database must keep accepting reads and writes while partitions are in transit, which can take hours.",
            "<strong>Move no more than necessary.</strong> Every byte moved costs network bandwidth and disk I/O that production traffic also needs, so the fastest and cheapest rebalance moves only the new node's fair share.",
          ],
        },
        {
          type: "text",
          html: `<h3>Why hash mod N moves almost everything</h3>
<p>Take a key whose hash is 123456. With 10 nodes it lives on node 6 (123456 mod 10). Add a node and it moves to node 3 (mod 11); add another and it moves again, to node 0 (mod 12). Nothing about the key changed. Only the divisor did.</p>
<p>How many keys move? A key stays put only if <code>h mod N</code> equals <code>h mod (N+1)</code>. For well-mixed hashes the pair of remainders is spread evenly over all N × (N+1) combinations, and only N of those combinations have equal remainders, so a key stays with probability 1/(N+1). Everything else moves:</p>
<span class="formula">fraction moved when going from N to N+1 nodes ≈ N / (N+1)</span>
<p>That is 80% going from 4 nodes to 5, and 91% going from 10 to 11. The least any scheme can move is the new node's fair share, 1/(N+1): 20% and 9% respectively. So mod N moves about N times more data than necessary. Shrinking is no better: removing one of N nodes moves about (N−1)/N of the keys, 75% for 4 → 3, although only the 25% on the departing node had to go anywhere.</p>
<p>Worse, most of those moves are <strong>pure waste</strong>. Only 1/(N+1) of keys move <em>to the new node</em>. Everything else that moves travels between two nodes that were already in the cluster, only because the divisor changed: going from 10 to 11 nodes, about 82% of all keys shuffle between old nodes and do nothing for balance.</p>
<p>As the hashing section noted, <code>mod</code> itself is not the problem: Redis Cluster's CRC16 mod 16,384 is fine because 16,384 never changes. The anti-pattern is taking the modulus by the number of <em>nodes</em>, a number you will certainly change. The few lines below measure both.</p>`,
        },
        {
          type: "code",
          lang: "python",
          title: "Counting the keys that move",
          code: `import hashlib

def h(key: str) -> int:
    # Stable across processes, machines and versions (unlike Python's hash()).
    return int.from_bytes(hashlib.md5(key.encode()).digest()[:8], "big")

keys = [f"user:{i}" for i in range(100_000)]

# Anti-pattern: a key's node depends on how many nodes there are.
moved = sum(h(k) % 10 != h(k) % 11 for k in keys)
print(f"mod N, 10 -> 11 nodes: {moved / len(keys):.1%} of keys move")   # 90.7%

# Fix: hash into a FIXED number of partitions, then look the partition up.
P = 1024
partition = {k: h(k) % P for k in keys}   # never changes, whatever the cluster size
owner = {p: p % 10 for p in range(P)}     # partition -> node: all that rebalancing edits

# Node 10 joins: give it every 11th partition (94 of them, 9 or 10 from each old node).
for p in range(0, P, 11):
    owner[p] = 10
moved = sum(owner[partition[k]] == 10 for k in keys)
print(f"fixed partitions: {moved / len(keys):.1%} of keys move, all to node 10")  # 9.3%`,
          caption: "The printed numbers are from a real run. MD5 is used only because it is stable everywhere; any well-mixed, stable hash works.",
        },
        {
          type: "text",
          html: `<p>The sandbox below runs the same experiment on 10,000 keys and draws 120 of them as dots, each labelled with the node that owns it. Pick a strategy and press <em>+ Add node</em>. Dots that moved to the new node turn amber (necessary moves); dots that moved between two nodes that were already there turn red (wasted moves). The bars underneath compare each node's share of keys with the ideal.</p>`,
        },
        {
          type: "viz",
          id: "ch6/rebalance-moves",
          title: "Add a node: what moves?",
          caption: "Try <em>+ Add node</em> under hash mod N, then switch to Fixed partitions and Ring + tokens and add a node again. Notice the red dots under mod N: keys shuffled between old nodes for no reason. Finally press Reset (back to 4 nodes), choose Ring + tokens with 1 token per node, and see one node own more than half the ring while another owns about 2%; raise the tokens and the shares even out.",
        },
        {
          type: "text",
          html: `<h3>Decouple keys from nodes</h3>
<p>The two strategies that behave well share one idea: <strong>a key's partition never changes; only the partition's node does.</strong> With fixed partitions, the key-to-partition step (hash mod 24 in the sandbox, mod 16,384 in Redis Cluster) is frozen forever, and a small separate table records which node holds each partition. Adding a node edits a few rows of that table: the newcomer takes whole partitions from the busiest nodes, every moved key goes to it, and nothing moves between old nodes. (The sandbox's 24 partitions are deliberately coarse, so the new node gets 4 of them rather than exactly a fifth; real systems use hundreds or thousands.)</p>
<h3>The hash ring</h3>
<p>The ring, usually called <strong>consistent hashing</strong>, gets the same result without a table. Bend the whole hash space into a circle. Each node owns one or more points on it, called <strong>tokens</strong>, and a key belongs to the first token at or after its hash, going clockwise and wrapping around at the top. A joining node's tokens land inside existing arcs, and each one takes over the stretch of ring just before it from the node whose token comes next. Only keys on those stretches move, and every one of them moves to the newcomer. When a node leaves, its arcs fall to the next tokens clockwise, so again only its own keys move.</p>
<p>The sandbox also exposes the ring's weak spot. With <strong>one token per node</strong>, tokens land at random positions and the arcs between them are wildly unequal: in the sandbox's starting 4-node cluster, one node owns about 55% of the keys and another under 2%, where 25% each would be fair. A single token also means a joining node takes its whole share from one neighbor, and a leaving node dumps its whole load on one neighbor. Giving each node many tokens, usually called <strong>virtual nodes</strong>, fixes both: many small arcs average out to near-equal shares, and a join or departure spreads its work across many peers.</p>
<p>In the book's taxonomy, this random-token scheme (used by Cassandra and ketama) is "partitioning proportionally to nodes", strategy 3 in <a href="#/ch6/learn/rebalancing-strategies">the next section</a>. (Why the book prefers not to call it consistent hashing at all is covered in <a href="#/ch6/learn/hash-partitioning">the hashing section</a>.)</p>
<h3>What a move really costs</h3>
<p>Bytes on the wire are only the start. A move reads from one disk and writes to another, competing with production I/O, and the receiving node starts with cold caches. In a cache tier the real damage isn't the copy at all but the misses: every key that lands on a server that doesn't hold it becomes a database query. That is why "how much moves" matters so much.</p>`,
        },
        {
          type: "diagram",
          title: "Adding a node to a hash ring",
          svg: `<style>.dd-diagram-body svg.ch6d2-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d2-w{display:none!important}.dd-diagram-body svg.ch6d2-n{display:block!important}}</style><svg class="ch6d2-w" viewBox="0 0 640 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hash ring before and after node D joins. Before: tokens A1, B1, C1, A2, B2, C2 split the ring into arcs; each key belongs to the next token clockwise. After: D1 and D2 are inserted; only the keys on the two arcs just before D1 and D2 move, all of them to D, one arc taken from C and one from B."><defs><marker id="c6d2-ring-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ink)"/></marker></defs><rect x="8" y="8" width="304" height="264" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><rect x="328" y="8" width="304" height="264" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="160" y="30" font-size="13" text-anchor="middle" font-weight="700">Before: A, B, C, two tokens each</text><text x="480" y="30" font-size="13" text-anchor="middle" font-weight="700">After: D joins with D1 and D2</text><circle cx="160" cy="152" r="80" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/><path d="M103.4,95.4 A80,80 0 0 1 180.7,74.7" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M180.7,74.7 A80,80 0 0 1 237.3,131.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M237.3,131.3 A80,80 0 0 1 211.4,213.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><path d="M211.4,213.3 A80,80 0 0 1 139.3,229.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M139.3,229.3 A80,80 0 0 1 82.7,172.7" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M82.7,172.7 A80,80 0 0 1 103.4,95.4" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><circle cx="167" cy="72.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="205.9" cy="86.5" r="3.5" style="fill: var(--viz-ink)"/><circle cx="223" cy="102.7" r="3.5" style="fill: var(--viz-ink)"/><circle cx="240" cy="152" r="3.5" style="fill: var(--viz-ink)"/><circle cx="239.2" cy="163.1" r="3.5" style="fill: var(--viz-ink)"/><circle cx="227.8" cy="194.4" r="3.5" style="fill: var(--viz-ink)"/><circle cx="176.6" cy="230.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="151.6" cy="231.6" r="3.5" style="fill: var(--viz-ink)"/><circle cx="115.3" cy="218.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="106.5" cy="211.5" r="3.5" style="fill: var(--viz-ink)"/><circle cx="87.5" cy="185.8" r="3.5" style="fill: var(--viz-ink)"/><circle cx="81.7" cy="135.4" r="3.5" style="fill: var(--viz-ink)"/><circle cx="90.7" cy="112" r="3.5" style="fill: var(--viz-ink)"/><circle cx="132.6" cy="76.8" r="3.5" style="fill: var(--viz-ink)"/><line x1="177.9" y1="85.4" x2="183.6" y2="64.1" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="187.2" y="54.6" font-size="12" text-anchor="middle" font-weight="700">A1</text><line x1="226.6" y1="134.1" x2="247.9" y2="128.4" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="261.4" y="128.8" font-size="12" text-anchor="middle" font-weight="700">B1</text><line x1="204.4" y1="204.9" x2="218.5" y2="221.7" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="227.5" y="236.4" font-size="12" text-anchor="middle" font-weight="700">C1</text><line x1="142.1" y1="218.6" x2="136.4" y2="239.9" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="132.8" y="257.4" font-size="12" text-anchor="middle" font-weight="700">A2</text><line x1="93.4" y1="169.9" x2="72.1" y2="175.6" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="58.6" y="183.2" font-size="12" text-anchor="middle" font-weight="700">B2</text><line x1="111.2" y1="103.2" x2="95.7" y2="87.7" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="85.8" y="81.8" font-size="12" text-anchor="middle" font-weight="700">C2</text><path d="M199.9,104.5 A62,62 0 0 1 218.3,130.8" stroke-width="1.5" marker-end="url(#c6d2-ring-w-a)" style="fill: none; stroke: var(--viz-ink)"/><text x="184.4" y="106.1" font-size="12" text-anchor="middle" class="viz-halo">key</text><text x="160" y="146" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">a key belongs to the</text><text x="160" y="162" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">next token clockwise</text><circle cx="480" cy="152" r="80" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/><path d="M423.4,95.4 A80,80 0 0 1 500.7,74.7" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M500.7,74.7 A80,80 0 0 1 557.3,131.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M557.3,131.3 A80,80 0 0 1 557.3,172.7" stroke-width="12" opacity="0.6" style="fill: none; stroke: var(--viz-warn)"/><path d="M557.3,172.7 A80,80 0 0 1 531.4,213.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><path d="M531.4,213.3 A80,80 0 0 1 459.3,229.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M459.3,229.3 A80,80 0 0 1 418.7,203.4" stroke-width="12" opacity="0.6" style="fill: none; stroke: var(--viz-warn)"/><path d="M418.7,203.4 A80,80 0 0 1 402.7,172.7" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M402.7,172.7 A80,80 0 0 1 423.4,95.4" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><circle cx="487" cy="72.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="525.9" cy="86.5" r="3.5" style="fill: var(--viz-ink)"/><circle cx="543" cy="102.7" r="3.5" style="fill: var(--viz-ink)"/><circle cx="560" cy="152" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="559.2" cy="163.1" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="547.8" cy="194.4" r="3.5" style="fill: var(--viz-ink)"/><circle cx="496.6" cy="230.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="471.6" cy="231.6" r="3.5" style="fill: var(--viz-ink)"/><circle cx="435.3" cy="218.3" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="426.5" cy="211.5" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="407.5" cy="185.8" r="3.5" style="fill: var(--viz-ink)"/><circle cx="401.7" cy="135.4" r="3.5" style="fill: var(--viz-ink)"/><circle cx="410.7" cy="112" r="3.5" style="fill: var(--viz-ink)"/><circle cx="452.6" cy="76.8" r="3.5" style="fill: var(--viz-ink)"/><line x1="497.9" y1="85.4" x2="503.6" y2="64.1" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="507.2" y="54.6" font-size="12" text-anchor="middle" font-weight="700">A1</text><line x1="546.6" y1="134.1" x2="567.9" y2="128.4" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="581.4" y="128.8" font-size="12" text-anchor="middle" font-weight="700">B1</text><line x1="546.6" y1="169.9" x2="567.9" y2="175.6" stroke-width="3.5" style="stroke: var(--viz-warn)"/><text x="581.4" y="183.2" font-size="12" text-anchor="middle" font-weight="700">D1</text><line x1="524.4" y1="204.9" x2="538.5" y2="221.7" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="547.5" y="236.4" font-size="12" text-anchor="middle" font-weight="700">C1</text><line x1="462.1" y1="218.6" x2="456.4" y2="239.9" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="452.8" y="257.4" font-size="12" text-anchor="middle" font-weight="700">A2</text><line x1="427.1" y1="196.4" x2="410.3" y2="210.5" stroke-width="3.5" style="stroke: var(--viz-warn)"/><text x="399.6" y="223.5" font-size="12" text-anchor="middle" font-weight="700">D2</text><line x1="413.4" y1="169.9" x2="392.1" y2="175.6" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="378.6" y="183.2" font-size="12" text-anchor="middle" font-weight="700">B2</text><line x1="431.2" y1="103.2" x2="415.7" y2="87.7" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="405.8" y="81.8" font-size="12" text-anchor="middle" font-weight="700">C2</text><text x="480" y="146" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">only the amber arcs</text><text x="480" y="162" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">move: all to D</text><text x="600" y="156" font-size="12" text-anchor="middle" font-weight="700" style="fill: var(--viz-warn)">from C</text><text x="408" y="257.8" font-size="12" text-anchor="middle" font-weight="700" style="fill: var(--viz-warn)">from B</text></svg><svg class="ch6d2-n" viewBox="0 0 360 528" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hash ring before and after node D joins. Before: tokens A1, B1, C1, A2, B2, C2 split the ring into arcs; each key belongs to the next token clockwise. After: D1 and D2 are inserted; only the keys on the two arcs just before D1 and D2 move, all of them to D, one arc taken from C and one from B."><defs><marker id="c6d2-ring-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ink)"/></marker></defs><rect x="6" y="6" width="348" height="252" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><rect x="6" y="270" width="348" height="252" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="180" y="28" font-size="13" text-anchor="middle" font-weight="700">Before: A, B, C, two tokens each</text><text x="180" y="292" font-size="13" text-anchor="middle" font-weight="700">After: D joins with D1 and D2</text><circle cx="180" cy="145" r="78" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/><path d="M124.8,89.8 A78,78 0 0 1 200.2,69.7" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M200.2,69.7 A78,78 0 0 1 255.3,124.8" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M255.3,124.8 A78,78 0 0 1 230.1,204.8" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><path d="M230.1,204.8 A78,78 0 0 1 159.8,220.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M159.8,220.3 A78,78 0 0 1 104.7,165.2" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M104.7,165.2 A78,78 0 0 1 124.8,89.8" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><circle cx="186.8" cy="67.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="224.7" cy="81.1" r="3.5" style="fill: var(--viz-ink)"/><circle cx="241.5" cy="97" r="3.5" style="fill: var(--viz-ink)"/><circle cx="258" cy="145" r="3.5" style="fill: var(--viz-ink)"/><circle cx="257.2" cy="155.9" r="3.5" style="fill: var(--viz-ink)"/><circle cx="246.1" cy="186.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="196.2" cy="221.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="171.8" cy="222.6" r="3.5" style="fill: var(--viz-ink)"/><circle cx="136.4" cy="209.7" r="3.5" style="fill: var(--viz-ink)"/><circle cx="127.8" cy="203" r="3.5" style="fill: var(--viz-ink)"/><circle cx="109.3" cy="178" r="3.5" style="fill: var(--viz-ink)"/><circle cx="103.7" cy="128.8" r="3.5" style="fill: var(--viz-ink)"/><circle cx="112.5" cy="106" r="3.5" style="fill: var(--viz-ink)"/><circle cx="153.3" cy="71.7" r="3.5" style="fill: var(--viz-ink)"/><line x1="197.3" y1="80.3" x2="203" y2="59" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="206.4" y="50.5" font-size="12" text-anchor="middle" font-weight="700">A1</text><line x1="244.7" y1="127.7" x2="266" y2="122" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="278.5" y="122.6" font-size="12" text-anchor="middle" font-weight="700">B1</text><line x1="223.1" y1="196.3" x2="237.2" y2="213.2" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="245.6" y="227.1" font-size="12" text-anchor="middle" font-weight="700">C1</text><line x1="162.7" y1="209.7" x2="157" y2="231" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="153.6" y="247.5" font-size="12" text-anchor="middle" font-weight="700">A2</text><line x1="115.3" y1="162.3" x2="94" y2="168" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="81.5" y="175.4" font-size="12" text-anchor="middle" font-weight="700">B2</text><line x1="132.6" y1="97.6" x2="117.1" y2="82.1" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="107.9" y="76.9" font-size="12" text-anchor="middle" font-weight="700">C2</text><path d="M218.6,99 A60,60 0 0 1 236.4,124.5" stroke-width="1.5" marker-end="url(#c6d2-ring-n-a)" style="fill: none; stroke: var(--viz-ink)"/><text x="203.5" y="100.9" font-size="12" text-anchor="middle" class="viz-halo">key</text><text x="180" y="140" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">a key belongs to the</text><text x="180" y="156" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">next token clockwise</text><circle cx="180" cy="409" r="78" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/><path d="M124.8,353.8 A78,78 0 0 1 200.2,333.7" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M200.2,333.7 A78,78 0 0 1 255.3,388.8" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M255.3,388.8 A78,78 0 0 1 255.3,429.2" stroke-width="12" opacity="0.6" style="fill: none; stroke: var(--viz-warn)"/><path d="M255.3,429.2 A78,78 0 0 1 230.1,468.8" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><path d="M230.1,468.8 A78,78 0 0 1 159.8,484.3" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c2)"/><path d="M159.8,484.3 A78,78 0 0 1 120.2,459.1" stroke-width="12" opacity="0.6" style="fill: none; stroke: var(--viz-warn)"/><path d="M120.2,459.1 A78,78 0 0 1 104.7,429.2" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c5)"/><path d="M104.7,429.2 A78,78 0 0 1 124.8,353.8" stroke-width="9" opacity="0.3" style="fill: none; stroke: var(--viz-c8)"/><circle cx="186.8" cy="331.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="224.7" cy="345.1" r="3.5" style="fill: var(--viz-ink)"/><circle cx="241.5" cy="361" r="3.5" style="fill: var(--viz-ink)"/><circle cx="258" cy="409" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="257.2" cy="419.9" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="246.1" cy="450.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="196.2" cy="485.3" r="3.5" style="fill: var(--viz-ink)"/><circle cx="171.8" cy="486.6" r="3.5" style="fill: var(--viz-ink)"/><circle cx="136.4" cy="473.7" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="127.8" cy="467" r="5" stroke-width="1.5" style="fill: var(--viz-warn); stroke: var(--viz-ink)"/><circle cx="109.3" cy="442" r="3.5" style="fill: var(--viz-ink)"/><circle cx="103.7" cy="392.8" r="3.5" style="fill: var(--viz-ink)"/><circle cx="112.5" cy="370" r="3.5" style="fill: var(--viz-ink)"/><circle cx="153.3" cy="335.7" r="3.5" style="fill: var(--viz-ink)"/><line x1="197.3" y1="344.3" x2="203" y2="323" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="206.4" y="314.5" font-size="12" text-anchor="middle" font-weight="700">A1</text><line x1="244.7" y1="391.7" x2="266" y2="386" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="278.5" y="386.6" font-size="12" text-anchor="middle" font-weight="700">B1</text><line x1="244.7" y1="426.3" x2="266" y2="432" stroke-width="3.5" style="stroke: var(--viz-warn)"/><text x="278.5" y="439.4" font-size="12" text-anchor="middle" font-weight="700">D1</text><line x1="223.1" y1="460.3" x2="237.2" y2="477.2" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="245.6" y="491.1" font-size="12" text-anchor="middle" font-weight="700">C1</text><line x1="162.7" y1="473.7" x2="157" y2="495" stroke-width="3.5" style="stroke: var(--viz-c2)"/><text x="153.6" y="511.5" font-size="12" text-anchor="middle" font-weight="700">A2</text><line x1="128.7" y1="452.1" x2="111.8" y2="466.2" stroke-width="3.5" style="stroke: var(--viz-warn)"/><text x="101.9" y="478.6" font-size="12" text-anchor="middle" font-weight="700">D2</text><line x1="115.3" y1="426.3" x2="94" y2="432" stroke-width="3.5" style="stroke: var(--viz-c5)"/><text x="81.5" y="439.4" font-size="12" text-anchor="middle" font-weight="700">B2</text><line x1="132.6" y1="361.6" x2="117.1" y2="346.1" stroke-width="3.5" style="stroke: var(--viz-c8)"/><text x="107.9" y="340.9" font-size="12" text-anchor="middle" font-weight="700">C2</text><text x="180" y="404" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">only the amber arcs</text><text x="180" y="420" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">move: all to D</text><text x="294" y="413" font-size="12" text-anchor="middle" font-weight="700" style="fill: var(--viz-warn)">from C</text><text x="108.3" y="511.5" font-size="12" text-anchor="middle" font-weight="700" style="fill: var(--viz-warn)">from B</text></svg>`,
          caption: "Each token owns the arc that ends at it. D1 lands inside C1's arc and D2 inside B2's arc, so D takes over two stretches of ring, one from C and one from B. Every other key stays exactly where it was.",
        },
        {
          type: "realworld",
          title: "Where consistent hashing came from",
          items: [
            {
              org: "Karger et al.",
              title: "Consistent Hashing and Random Trees",
              year: "1997",
              tag: "Origin",
              html: `<p>Introduced consistent hashing at STOC 1997 to spread web-cache load over a changing set of cache machines, so that a cache joining or leaving remaps only a small fraction of URLs. The work underpinned Akamai's content delivery network, which two of the authors co-founded.</p>`,
            },
            {
              org: "Last.fm",
              title: "libketama",
              year: "2007",
              tag: "Cache clients",
              html: `<p>Released ketama, a consistent-hashing library for memcached clients, so adding or removing a cache server remaps only a small share of keys instead of nearly all of them, avoiding a flood of misses on the database. Many memcached client libraries adopted ketama-compatible hashing.</p>`,
            },
            {
              org: "Amazon Dynamo",
              title: "Virtual nodes on a ring",
              year: "2007",
              tag: "Databases",
              html: `<p>Dynamo places nodes on a consistent-hashing ring and gives each physical node many virtual nodes. Load evens out, a more powerful machine can take more virtual nodes, and a failed node's load spreads across many peers instead of landing on one neighbor.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Beyond the ring",
          html: `<p>Several placement functions now compete with, or refine, the classic ring:</p>
<ul>
<li><strong>Rendezvous (highest-random-weight) hashing</strong>, from the 1990s: each key scores every node with hash(key, node) and picks the top score. There is no ring to store, and removing a node moves only that node's keys, at the cost of scoring every node on each lookup.</li>
<li><strong>Jump consistent hash</strong> (Lamping and Veach, Google, 2014): a few lines of code, no stored state, near-perfect balance, and only about 1/n of keys move when the n-th bucket is added. The catch is that buckets are numbered 0 to n−1, so you can only add or remove at the end. That suits replicated storage shards better than a pool of servers that fail at random.</li>
<li><strong>Maglev hashing</strong> (Google, 2016): a lookup-table scheme that lets a software load balancer spread connections almost perfectly evenly, with little disruption when backends change.</li>
<li><strong>Consistent hashing with bounded loads</strong> (Mirrokni, Thorup and Zadimoghaddam): caps every server at (1 + ε) times the average load by passing overflow to the next server on the ring; Vimeo described adding it to HAProxy in 2016.</li>
</ul>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"Consistent hashing balances load\"",
          html: `<p>A ring minimizes <em>movement</em>; it does not by itself balance <em>load</em>. With one token per node the arcs are random and shares can differ several-fold, and even "adding a node moves about 1/(N+1) of the data" is an average, not a promise for every node. Evenness comes from many tokens per node or from an algorithm that places tokens deliberately (Cassandra added one in version 3.0). And no ring can help a single hot key: every request for it hashes to the same point, as <a href="#/ch6/learn/hot-spots">hot spots</a> showed.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"What happens when you add a cache server?\"",
          html: `<p>A weak answer says "consistent hashing" and stops. A strong answer quantifies: with <code>hash mod N</code>, going from 9 to 10 servers remaps about 90% of keys and the database absorbs the misses; with a ring and many virtual nodes, or a fixed set of partitions, only the newcomer's share (about 10%) moves. Then it handles the follow-ups: expect a short dip in hit rate or warm the new server gradually, use virtual nodes so a failed server's load spreads over many peers, give bigger machines more virtual nodes, and point out that none of this fixes one hot key.</p>`,
        },
        {
          type: "quiz",
          q: "A cache tier routes with hash(key) mod N and has 9 servers. You add a 10th. Roughly what fraction of keys now map to a different server?",
          options: ["About 10%", "About 50%", "About 90%", "100%"],
          answer: 2,
          explain: "A key stays only if hash mod 9 equals hash mod 10, which happens for about 1 key in 10, so about 90% move and miss at once. 10% is the tempting answer, but that is the minimum any scheme could achieve (the new server's fair share), which a token ring or fixed partitions get close to; mod N does far worse. 100% is too pessimistic: about one key in ten keeps its server by coincidence.",
        },
      ],
    },
    // ------------------------------------------------------------------ 7
    {
      id: "rebalancing-strategies",
      title: "Three ways to decide what moves",
      kicker: "Strategies",
      concepts: ["rebalancing-strategies", "dynamic-partitioning", "pre-splitting", "virtual-nodes"],
      blocks: [
        {
          type: "problem",
          title: "Every partition count is wrong eventually",
          html: `<p>Say you fixed the partition count up front: 8 partitions, because you had 4 nodes (illustrative). Three years later each partition holds 600 GB. Moving one to a new node means streaming 600 GB while it keeps serving traffic, which at a polite 50 MB/s takes more than three hours; re-replicating after a disk failure takes just as long; and you can never use more than 8 nodes, because a partition cannot be split across machines.</p>
<p>Pick 10,000 partitions instead and a small cluster drowns in per-partition overhead: files, metadata, replication streams and leader elections, all multiplied by 10,000. Let partitions grow and split on their own instead, and a brand-new table starts life as a single partition on a single node that takes every write. Every strategy has to answer two questions: <strong>how many partitions exist</strong>, and <strong>what happens to that number</strong> as data and nodes change.</p>`,
        },
        {
          type: "idea",
          html: `<p>There are three answers. Create <strong>many partitions up front</strong> and move them whole; let partitions <strong>split and merge with the data</strong>; or give each node <strong>a fixed number of partitions</strong> that split when nodes join. Each trades predictability against adaptability, and each has its own characteristic trap.</p>`,
        },
        {
          type: "text",
          html: `<h3>Strategy 1: many more partitions than nodes</h3>
<p>Create far more partitions than nodes, up front, and never change the count. The book's example is 1,000 partitions on 10 nodes, about 100 each. When an 11th node joins, it steals a few whole partitions from every existing node until shares are even (about 91 each, so roughly 9 from each); when a node leaves, the reverse happens.</p>
<p>Key → partition never changes; only partition → node does. A move takes time, so the <strong>old owner keeps serving reads and writes</strong> for the partition until the new owner is ready (how requests then find the new owner is the subject of <a href="#/ch6/learn/request-routing">request routing</a>). The assignment also handles <strong>mismatched hardware</strong>: a machine twice as powerful simply takes twice as many partitions.</p>
<p>The hard part is choosing the number. The partition count is effectively the <strong>maximum number of nodes</strong> you can ever use, so you choose it for the cluster you might have years from now. But every partition has fixed costs (files, in-memory structures, metadata, often its own replication stream), so too many waste resources on a small cluster, while too few grow huge and make every rebalance and every recovery from a node failure slow. Getting it right requires knowing how big the data will get, which nobody does.</p>
<p>Changing the count later is painful. Elasticsearch fixes an index's primary shard count at creation; its split and shrink APIs build a new index, and otherwise you reindex. Adding partitions to a Kafka topic changes which partition a key hashes to, breaking per-key ordering (Chapter 11). Riak, Elasticsearch, Couchbase and Voldemort work this way, as do Redis Cluster's 16,384 hash slots and the "logical shards" of Instagram and Notion, packed many to a physical database.</p>
<p>Watch the naming: Riak calls its partitions vnodes, but their total number (the ring size) is fixed, so Riak belongs here. Cassandra's vnodes are a fixed number <em>per node</em>, which puts it in strategy 3.</p>
<h3>Strategy 2: split and merge as the data changes</h3>
<p>Key ranges fit strategy 1 badly: boundaries fixed in advance will be wrong because real keys bunch up (as <a href="#/ch6/learn/key-range">key ranges</a> showed), and moving them by hand is tedious. So HBase and RethinkDB create partitions <strong>dynamically</strong>. A partition that grows past a size threshold (10 GB by default in HBase) splits in two at a key near its middle; one that shrinks below a threshold merges with a neighbor. It is a B-tree page split (Chapter 3) applied to whole machines.</p>
<p>After a split, one half can move to another node. HBase keeps region files in HDFS, so handing a region to another RegionServer transfers responsibility for files rather than copying data. (In detail, both daughter regions first stay on the parent's RegionServer, and the balancer moves regions later.) The big win: the <strong>partition count follows the data</strong>, from a few small partitions for a small dataset to thousands for a huge one, each bounded in size.</p>
<p>The catch is the beginning. An empty database starts as <strong>one partition</strong>, so until it fills and splits, one node takes every write while the others idle. HBase and MongoDB let you <strong>pre-split</strong> an empty table into initial ranges, which works only if you already know the key distribution. (Newer HBase versions soften the cold start: their default split policy splits a table's first regions at much smaller sizes than the 10 GB maximum.)</p>
<p>Dynamic partitioning isn't limited to key ranges: MongoDB has supported hashed as well as range sharding since 2.4, and in the book's era split chunks dynamically in both cases. Notice what splitting by size does <em>not</em> fix: with sequential keys such as timestamps, only the partition holding the newest keys grows. It fills, splits, its upper half fills and splits again, and the hot spot hops from partition to partition, leaving older ones half-full.</p>
<p>The sandbox below is a toy dynamically partitioned database: keys 0–999, three nodes, and a split threshold in rows rather than gigabytes. The top bar is the keyspace, cut into partitions colored by host node; each node's box lists its partitions and whether it is taking writes right now.</p>`,
        },
        {
          type: "viz",
          id: "ch6/dynamic-splitting",
          title: "Dynamic splitting and merging",
          caption: "Try <em>Start writes</em> and watch P0 fill up and split; then turn on Pre-split, switch Keys to Sequential (timestamps), and finally press <em>Delete two-thirds of rows</em>. Notice that with sequential keys exactly one partition on one node takes the writes, however many splits happen. For clarity the viz moves each new upper half at once; HBase first keeps both halves on the parent's server and lets its balancer move one later.",
        },
        {
          type: "text",
          html: `<p>What the sandbox shows: with uniform keys nobody chose a boundary by hand, yet after just two splits all three nodes were taking writes. With sequential keys, splitting produced plenty of partitions but never more than one hot one at a time. Pre-splitting helped only when its guess matched the keys. And deleting data let neighbors merge, so the count shrank with the data.</p>
<h3>Strategy 3: a fixed number of partitions per node</h3>
<p>Cassandra and ketama make the number of partitions <strong>proportional to the number of nodes</strong>: each node owns a fixed number of token ranges. With a fixed node count, partitions grow with the data; adding nodes makes them smaller again, so partition size stays fairly stable.</p>
<p>A joining node picks that many existing partitions at random, splits each, and takes over one half of each. A single random split can be unfair, but averaged over many partitions (Cassandra's default used to be 256 tokens per node) the newcomer gets roughly a fair share. Cassandra 3.0 added a token-allocation algorithm that places new tokens deliberately, and Cassandra 4.0 lowered the default to 16 tokens per node, relying on it.</p>
<p>Random split points require <strong>hash-based partitioning</strong>: a random hash value is a sensible boundary, a random string in a skewed key space is not. This scheme is the closest match to consistent hashing as Karger defined it.</p>
<p>Systems do switch strategies. The Dynamo paper describes moving from random tokens per node to a fixed set of equal-sized partitions spread over the nodes, which balanced load best and simplified bootstrapping new nodes, archiving and membership metadata, because partitions became fixed units handed over whole.</p>`,
        },
        {
          type: "table",
          title: "The three strategies side by side",
          headers: ["", "Fixed number of partitions", "Dynamic partitioning", "Fixed partitions per node"],
          rows: [
            ["What stays fixed", "The total number of partitions", "The size thresholds for splitting and merging", "The number of partitions per node"],
            ["Partition size", "Grows with the total data", "Bounded between the merge and split thresholds", "Grows with the data per node; shrinks when nodes join"],
            ["When the count changes", "Never, short of a painful re-shard", "Whenever data grows or shrinks", "When nodes join or leave"],
            ["When a node joins", "It takes whole partitions from every node", "The balancer moves some existing partitions to it", "It splits random partitions and takes half of each"],
            ["Works with", "Mostly hash partitioning", "Key ranges or hashed keys", "Hash partitioning only (random split points)"],
            ["Examples", "Riak, Elasticsearch, Couchbase, Voldemort, Redis Cluster", "HBase, Bigtable, RethinkDB, MongoDB, CockroachDB", "Cassandra, ketama"],
            ["Main trap", "Choosing the count: too few caps growth, too many waste overhead", "A new table starts as one partition on one node", "Random splits are unfair without many tokens or an allocator"],
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Redis Cluster, Couchbase, Elasticsearch",
              tag: "Fixed count",
              html: `<p>All use a fixed set of partitions moved whole between nodes: Redis Cluster has 16,384 hash slots, Couchbase 1,024 vBuckets per bucket, and each Elasticsearch index has a primary shard count fixed at creation (1 by default since version 7.0, 5 before).</p>`,
            },
            {
              org: "Notion",
              year: "2021–2023",
              tag: "Fixed count",
              html: `<p>Notion sharded Postgres by workspace ID into 480 logical shards, placed 15 per database on 32 physical databases. Its later "Great Re-shard" moved to 96 physical instances, 5 logical shards each, without changing the logical shard count: a textbook fixed-partition rebalance.</p>`,
            },
            {
              org: "HBase, MongoDB, CockroachDB",
              tag: "Dynamic",
              html: `<p>HBase splits a region when it exceeds <code>hbase.hregion.max.filesize</code> (10 GB by default) and supports pre-splitting at table creation. MongoDB's default chunk (range) size was 64 MB, rising to 128 MB in 6.0. CockroachDB splits ranges at 512 MiB by default (64 MiB before v20.1) and merges small ones.</p>`,
            },
            {
              org: "Apache Cassandra",
              tag: "Per node",
              html: `<p>Set per node with <code>num_tokens</code>. With V random tokens, a node's share of the ring varies by roughly 1/&radic;V of the average: about 6% at the old default of 256, about 25% at 16. That is why 4.0's default of 16 ships together with the token allocator (<code>allocate_tokens_for_local_replication_factor: 3</code> in <code>cassandra.yaml</code>) rather than relying on randomness.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Splitting by traffic, and splitting less",
          html: `<p>Dynamic partitioning has become load-aware since the book: CockroachDB, DynamoDB and Spanner split a range that is busy, not just one that is big, so its halves can live on different nodes (and, as <a href="#/ch6/learn/hot-spots">hot spots</a> explained, none of them can split a single key). MongoDB went the other way: since 6.0.3 its balancer evens out data <em>size</em> across shards and no longer splits chunks automatically, so the book's description of MongoDB's chunk splitting applies only to earlier versions.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"How many shards should we create?\"",
          html: `<p>A favorite follow-up in sharding designs. A strong answer separates <strong>logical</strong> from <strong>physical</strong> shards: create many more logical partitions than machines, map them to physical nodes with a table, and rebalance by moving whole logical shards. Size the count so each partition stays small enough to move or rebuild quickly at your largest projected data size, and prefer a number with many divisors so it spreads evenly over many machine counts: Notion's 480 divides evenly by both 32 and 96, the physical database counts it has actually used. Then name the alternative: if the eventual size is unknowable, dynamic splitting avoids the guess, but bulk loads into a new table need pre-splitting.</p>`,
        },
        {
          type: "quiz",
          q: "You bulk-load a brand-new HBase table whose row keys are spread evenly. For the first minutes one RegionServer is pegged while the others idle. What is going on?",
          options: [
            "Dynamic partitioning starts the table as a single region, so one server takes every write until splits happen; pre-split the table",
            "The row keys hash badly, so all of them land in one region",
            "HBase uses a fixed number of partitions and the count was set too low",
            "ZooKeeper routes every client to the same RegionServer",
          ],
          answer: 0,
          explain: "HBase partitions dynamically: a new table is one region on one server until it grows enough to split. Pre-splitting with known boundaries spreads the load from the start. Evenly spread keys rule out a bad key distribution (and HBase doesn't hash row keys anyway); HBase doesn't use a fixed partition count; and ZooKeeper only helps clients find where regions live. With one region there is only one place to send writes.",
        },
      ],
    },
    // ------------------------------------------------------------------ 8
    {
      id: "rebalancing-operations",
      title: "Who presses the rebalance button?",
      kicker: "Operations",
      concepts: ["automatic-rebalancing"],
      blocks: [
        {
          type: "problem",
          title: "The cure that spreads the disease",
          html: `<p>Rebalancing copies gigabytes or terabytes over the same network and disks that serve production traffic, and it changes routing while requests are in flight. Now let it start automatically whenever a node looks unhealthy. Node C stalls for 40 seconds in a garbage-collection pause (or is simply overloaded), its peers' requests time out, and the cluster declares it dead.</p>
<p>Moving C's partitions away means nodes A and B must serve C's traffic <em>and</em> stream C's data at the same time. They slow down, their requests start timing out too, and the failure detector declares one of them dead next. The automation built to heal the cluster has become the mechanism that takes it down, all to work around a node that would have been back in under a minute.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat rebalancing as an <strong>expensive, risky operation</strong>. Let the system propose plans, but throttle, delay or require a human for the execution, and be especially careful when failure detection is what triggers it.</p>`,
        },
        {
          type: "text",
          html: `<h3>From fully automatic to fully manual</h3>
<p>Rebalancing can be <strong>fully automatic</strong>, with the system deciding when to move partitions and doing it with no administrator involved, or <strong>fully manual</strong>, with an administrator explicitly assigning partitions to nodes. In between sits a popular middle ground: the system computes a suggested assignment, and a human reviews and commits it. The book names Couchbase, Riak and Voldemort as working this way.</p>
<p>Automation is attractive: less operational work, and a fast response when data grows or a hot spot appears at 3 a.m. Its costs are easy to underestimate, though. A rebalance reroutes requests and moves large amounts of data, so it loads the very nodes and network that serve production traffic, and request latency suffers while it runs. When it runs automatically, that cost lands at a moment nobody chose, possibly at peak load.</p>
<h3>When automation meets failure detection</h3>
<p>The dangerous combination is automatic rebalancing triggered by automatic failure detection. A node that is merely slow, because it is overloaded or stuck in a long pause, looks exactly like a dead one to its peers: as <a href="#/ch8/learn/timeouts-and-delays">Chapter 8</a> explains, a timeout cannot tell the two apart. Declare it dead and start moving its partitions, and the remaining nodes take on its traffic plus the copy work. If that pushes them into timeouts, they are declared dead as well, and each lap of the loop moves more data onto fewer healthy machines.</p>`,
        },
        {
          type: "diagram",
          title: "How automatic rebalancing can cascade",
          svg: `<style>.dd-diagram-body svg.ch6d2-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d2-w{display:none!important}.dd-diagram-body svg.ch6d2-n{display:block!important}}</style><svg class="ch6d2-w" viewBox="0 0 640 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A cascading rebalancing loop: node C is overloaded or paused, requests to it time out, the failure detector declares it dead, automatic rebalancing streams its partitions to A and B, A, B and the network get busier, and now A looks dead too. Brakes between detection and rebalancing: a delay, throttling and human approval."><defs><marker id="c6d2-cas-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ink)"/></marker><marker id="c6d2-cas-w-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs><rect x="10" y="18" width="180" height="62" rx="8" stroke-width="1.5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="100" y="45" font-size="12" text-anchor="middle">Node C overloaded</text><text x="100" y="62" font-size="12" text-anchor="middle">or paused (GC)</text><circle cx="14" cy="20" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="14" y="24" font-size="12" text-anchor="middle" font-weight="700">1</text><rect x="230" y="18" width="180" height="62" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="320" y="45" font-size="12" text-anchor="middle">Requests to C</text><text x="320" y="62" font-size="12" text-anchor="middle">time out</text><circle cx="234" cy="20" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="234" y="24" font-size="12" text-anchor="middle" font-weight="700">2</text><rect x="450" y="18" width="180" height="62" rx="8" stroke-width="1.5" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/><text x="540" y="45" font-size="12" text-anchor="middle">Failure detector:</text><text x="540" y="62" font-size="12" text-anchor="middle">“C is dead”</text><circle cx="454" cy="20" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="454" y="24" font-size="12" text-anchor="middle" font-weight="700">3</text><rect x="450" y="180" width="180" height="62" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="540" y="207" font-size="12" text-anchor="middle">Auto-rebalance streams</text><text x="540" y="224" font-size="12" text-anchor="middle">C’s partitions to A, B</text><circle cx="454" cy="182" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="454" y="186" font-size="12" text-anchor="middle" font-weight="700">4</text><rect x="230" y="180" width="180" height="62" rx="8" stroke-width="1.5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="320" y="207" font-size="12" text-anchor="middle">A, B and the network</text><text x="320" y="224" font-size="12" text-anchor="middle">get busier</text><circle cx="234" cy="182" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="234" y="186" font-size="12" text-anchor="middle" font-weight="700">5</text><line x1="190" y1="49" x2="228" y2="49" stroke-width="1.6" marker-end="url(#c6d2-cas-w-a)" style="stroke: var(--viz-ink)"/><line x1="410" y1="49" x2="448" y2="49" stroke-width="1.6" marker-end="url(#c6d2-cas-w-a)" style="stroke: var(--viz-ink)"/><line x1="540" y1="80" x2="540" y2="104" stroke-width="1.6" style="stroke: var(--viz-ink)"/><rect x="446" y="104" width="188" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/><text x="540" y="124" font-size="12" text-anchor="middle" font-weight="700">Brakes go here:</text><text x="540" y="141" font-size="12" text-anchor="middle">delay, throttle, human OK</text><line x1="540" y1="154" x2="540" y2="178" stroke-width="1.6" marker-end="url(#c6d2-cas-w-a)" style="stroke: var(--viz-ink)"/><line x1="450" y1="211" x2="412" y2="211" stroke-width="1.6" marker-end="url(#c6d2-cas-w-a)" style="stroke: var(--viz-ink)"/><path d="M230,211 L100,211 L100,82" stroke-width="2" marker-end="url(#c6d2-cas-w-b)" style="fill: none; stroke: var(--viz-bad)"/><text x="112" y="134" font-size="12" text-anchor="start" font-weight="700" style="fill: var(--viz-bad)">repeat with A:</text><text x="112" y="151" font-size="12" text-anchor="start" font-weight="700" style="fill: var(--viz-bad)">now A looks dead</text><text x="112" y="172" font-size="12" text-anchor="start" style="fill: var(--viz-muted)">each loop moves</text><text x="112" y="189" font-size="12" text-anchor="start" style="fill: var(--viz-muted)">more data</text></svg><svg class="ch6d2-n" viewBox="0 0 360 490" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A cascading rebalancing loop: node C is overloaded or paused, requests to it time out, the failure detector declares it dead, automatic rebalancing streams its partitions to A and B, A, B and the network get busier, and now A looks dead too. Brakes between detection and rebalancing: a delay, throttling and human approval."><defs><marker id="c6d2-cas-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ink)"/></marker><marker id="c6d2-cas-n-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs><rect x="80" y="10" width="250" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="205" y="31" font-size="12" text-anchor="middle">Node C overloaded</text><text x="205" y="47" font-size="12" text-anchor="middle">or paused (GC)</text><circle cx="82" cy="12" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="82" y="16" font-size="12" text-anchor="middle" font-weight="700">1</text><rect x="80" y="86" width="250" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="205" y="107" font-size="12" text-anchor="middle">Requests to C</text><text x="205" y="123" font-size="12" text-anchor="middle">time out</text><circle cx="82" cy="88" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="82" y="92" font-size="12" text-anchor="middle" font-weight="700">2</text><rect x="80" y="162" width="250" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/><text x="205" y="183" font-size="12" text-anchor="middle">Failure detector:</text><text x="205" y="199" font-size="12" text-anchor="middle">“C is dead”</text><circle cx="82" cy="164" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="82" y="168" font-size="12" text-anchor="middle" font-weight="700">3</text><rect x="80" y="312" width="250" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="205" y="333" font-size="12" text-anchor="middle">Auto-rebalance streams</text><text x="205" y="349" font-size="12" text-anchor="middle">C’s partitions to A, B</text><circle cx="82" cy="314" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="82" y="318" font-size="12" text-anchor="middle" font-weight="700">4</text><rect x="80" y="388" width="250" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="205" y="409" font-size="12" text-anchor="middle">A, B and the network</text><text x="205" y="425" font-size="12" text-anchor="middle">get busier</text><circle cx="82" cy="390" r="10" style="fill: var(--viz-bg); stroke: var(--viz-muted)" stroke-width="1.2"/><text x="82" y="394" font-size="12" text-anchor="middle" font-weight="700">5</text><line x1="205" y1="60" x2="205" y2="84" stroke-width="1.6" marker-end="url(#c6d2-cas-n-a)" style="stroke: var(--viz-ink)"/><line x1="205" y1="136" x2="205" y2="160" stroke-width="1.6" marker-end="url(#c6d2-cas-n-a)" style="stroke: var(--viz-ink)"/><line x1="205" y1="212" x2="205" y2="234" stroke-width="1.6" style="stroke: var(--viz-ink)"/><rect x="90" y="234" width="230" height="54" rx="8" stroke-width="1.5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/><text x="205" y="256" font-size="12" text-anchor="middle" font-weight="700">Brakes go here:</text><text x="205" y="273" font-size="12" text-anchor="middle">delay, throttle, human OK</text><line x1="205" y1="288" x2="205" y2="310" stroke-width="1.6" marker-end="url(#c6d2-cas-n-a)" style="stroke: var(--viz-ink)"/><line x1="205" y1="362" x2="205" y2="386" stroke-width="1.6" marker-end="url(#c6d2-cas-n-a)" style="stroke: var(--viz-ink)"/><path d="M80,413 L36,413 L36,35 L78,35" stroke-width="2" marker-end="url(#c6d2-cas-n-b)" style="fill: none; stroke: var(--viz-bad)"/><text x="205" y="462" font-size="12" text-anchor="middle" font-weight="700" style="fill: var(--viz-bad)">repeat: now A looks dead too</text><text x="205" y="480" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(each loop moves more data)</text></svg>`,
          caption: "Each lap moves more data onto fewer healthy nodes. The cheapest place to break the loop is between detection and action: wait, throttle, or ask a human.",
        },
        {
          type: "text",
          html: `<h3>Two jobs with very different urgency</h3>
<p>It helps to separate what rebalancing is <em>for</em>. <strong>Restoring redundancy</strong> after a node is truly gone is urgent: until the lost replicas are rebuilt elsewhere, one more failure could lose data. <strong>Evening out load</strong> is optional: an imbalance of 10% or even 30% hurts nobody tonight, and it can wait for a quiet hour or a human decision. Systems that treat both as the same emergency are the ones that melt down.</p>
<p>Well-run systems put brakes on both:</p>
<ul>
<li><strong>Wait before reacting.</strong> A node that disappears for 30 seconds during a restart should not trigger hours of copying. Short absences can be handled without changing ownership at all: Chapter 5's hinted handoff, for example, keeps writes meant for an unreachable replica on another node and hands them over when the replica returns.</li>
<li><strong>Throttle the copy.</strong> Cap the bandwidth used for moves and the number of partitions moving at once per node, so production traffic always wins.</li>
<li><strong>Ignore small imbalances.</strong> Thresholds and hysteresis stop the planner from chasing noise by moving partitions back and forth.</li>
<li><strong>Grow gradually.</strong> Add nodes one at a time, let each rebalance finish, and schedule large moves for quiet periods.</li>
<li><strong>Keep a human in the loop</strong> for big plans: the system computes the plan, a person decides when to run it.</li>
</ul>
<p>Without brakes, recovery itself becomes the outage. AWS's April 2011 EBS "re-mirroring storm", in which nodes cut off from their replicas all re-replicated at once, is the classic case of automatic recovery overloading a cluster (<a href="#/ch8/learn/timeouts-and-delays">Chapter 8</a>). The DynamoDB incident below has the same shape: a mechanism meant to restore health amplified a small disturbance into a long outage.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Couchbase, Riak, Voldemort",
              tag: "Human commits",
              html: `<p>Per the book, these systems generate a suggested partition assignment automatically but require an administrator to commit it before any data moves.</p>`,
            },
            {
              org: "Elasticsearch",
              tag: "Delay and throttle",
              html: `<p>When a node leaves, reallocating its shards is delayed by <code>index.unassigned.node_left.delayed_timeout</code> (1 minute by default), so a brief restart doesn't trigger a full shard shuffle. Recovery traffic is throttled (<code>indices.recovery.max_bytes_per_sec</code>, 40 MB/s by default on most nodes) and the number of concurrent recoveries per node is limited.</p>`,
            },
            {
              org: "Amazon DynamoDB, us-east-1",
              year: "September 2015",
              tag: "Incident",
              html: `<p>After a brief network disruption, storage servers simultaneously asked the metadata service for their partition membership. Some membership lists had grown large with the adoption of global secondary indexes, so requests timed out; servers took themselves out of service and kept retrying, and the retries overloaded the metadata service further until AWS paused requests to add capacity.</p>`,
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "Automatic rebalancing",
          prosLabel: "What automation gives you",
          consLabel: "What it risks",
          pros: [
            "Less operational work: nobody computes assignments or runs moves by hand.",
            "Fast reaction to data growth, new nodes and hot spots, at any hour.",
            "Redundancy restored quickly when a node really is gone.",
            "Repeatable decisions instead of a tired human improvising at 3 a.m.",
          ],
          cons: [
            "Moves start at unpredictable times, possibly at peak load.",
            "Copy traffic competes with production for network and disk, raising latency.",
            "Paired with timeout-based failure detection, one slow node can become a cascading failure.",
            "A planner bug acts on the whole cluster at once; a human review catches absurd plans.",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Automatic, but on a leash",
          html: `<p>Managed and distributed-SQL databases such as DynamoDB, Spanner and CockroachDB now rebalance continuously and automatically; nobody presses a button. What makes that tolerable is the planner: moves are driven by measured load and size, rate-limited and spread out over time. Apache Kafka sits at the other end: partitions move only when an operator runs a reassignment (<code>kafka-reassign-partitions</code>), optionally with a replication throttle. LinkedIn open-sourced Cruise Control in 2017 to compute and execute goal-based Kafka rebalancing plans automatically, with goals such as rack awareness and disk, network and CPU balance.</p>`,
        },
        {
          type: "text",
          html: `<h3>The move no rebalancer makes: changing the key itself</h3>
<p>Everything so far moves whole partitions and leaves the key → partition function alone. Some changes rewrite the function: sharding a database that was never sharded, switching the partition key (say from <code>order_id</code> to <code>customer_id</code> because the main query changed), or splitting a fixed set of partitions into more. Now nearly every row needs a new home, and no rebalancer setting does that for you. Teams run it as a migration between two live layouts, keeping the old one as the source of truth until the very end.</p>`,
        },
        {
          type: "steps",
          title: "Re-partitioning a live system",
          items: [
            "<strong>Keep the new layout current.</strong> Either the application writes to both layouts, or the new layout consumes the old one's change stream (logical replication, binlog, CDC). The log-based copy has a single source of truth; application dual-writes can diverge when one of the two writes fails.",
            "<strong>Backfill.</strong> Copy existing rows in throttled batches, so the copy doesn't starve production traffic. Make the apply idempotent and version-aware, so a backfilled row never overwrites a newer change.",
            "<strong>Verify.</strong> Compare counts and checksums per partition, and send a sample of reads to both layouts (shadow reads), logging every mismatch until there are none.",
            "<strong>Cut over.</strong> Move reads first, behind a flag. Then switch writes in a short fenced window: stop writes on the old layout, let the copy catch up completely, flip the routing, resume. Only one layout accepts writes at any moment.",
            "<strong>Keep a way back.</strong> Replicate from the new layout back to the old one for a while so you can roll back, and delete the old copy only after a grace period.",
          ],
        },
        {
          type: "text",
          html: `<p>Notion described its 2021 Postgres sharding in the same phases: double-write, backfill, verify, switch over. Vitess packages the sequence for MySQL: its Reshard and MoveTables workflows copy the data, catch up from the binlog, compare both sides with VDiff and switch traffic, with reverse replication available for rollback. This is also why the logical-shard advice in the previous section matters: if the key → shard function never has to change, growth is an ordinary rebalance instead of this migration.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"What happens when a node dies?\"",
          html: `<p>Expect this in any storage design. A strong answer distinguishes a <strong>blip</strong> from a <strong>death</strong>. Short absences are absorbed: other replicas serve reads, and hinted handoff or the replication log catches the node up when it returns. Only after a deliberate delay does the system re-replicate the node's partitions, throttled and from many peers in parallel. Good answers also mention headroom (every node keeps enough spare capacity to absorb a neighbor's share), the different urgency of re-replication and load balancing, and that a timeout cannot tell slow from dead, so automatic responses need limits. Citing a real cascade, such as the 2011 EBS re-mirroring storm, shows you know why.</p>`,
        },
        {
          type: "quiz",
          q: "A node stalls for 40 seconds in a long garbage-collection pause. Failure detection marks it dead, and automatic rebalancing starts streaming its partitions to the other nodes. What is the main risk?",
          options: [
            "None: this is exactly what automatic rebalancing is for",
            "Data loss, because the stalled node's partitions are deleted immediately",
            "The extra copy traffic slows the remaining nodes, which may then be declared dead too: a cascading failure",
            "Clients will route requests to the wrong node forever",
          ],
          answer: 2,
          explain: "The node was slow, not dead: it will be back within a minute, yet the cluster now pays for a large data movement on top of its normal load, which can push healthy nodes into the same timeouts. A delay before reacting, throttling or human approval avoids the spiral. The first option is tempting because the system is \"self-healing\", but healing a node that isn't broken only adds load. Copies are not deleted before a move completes, and routing is updated along with the move.",
        },
      ],
    },
    // ------------------------------------------------------------------ 9
    {
      id: "request-routing",
      title: "Finding the right partition when it keeps moving",
      kicker: "Routing",
      concepts: ["request-routing", "parallel-query-execution"],
      blocks: [
        {
          type: "problem",
          title: "Yesterday's address book",
          html: `<p>Partitions move. A client holding the key <code>user:77</code> has to reach the node that owns partition P3 <em>now</em>, not the node that owned it before yesterday's rebalance. Hard-coding addresses is impossible, asking every node is wasteful, and letting every component keep its own independent idea of the map lets them disagree.</p>
<p>During a move, that disagreement is dangerous. A read sent to a node that no longer has the data returns nothing or something stale. Worse, a write sent to the old owner may be accepted by a leftover copy that is about to be deleted, or two nodes may both accept writes for the same partition. Routing is not just a lookup; it is part of correctness.</p>`,
        },
        {
          type: "idea",
          html: `<p>Keep <strong>one authoritative, versioned partition map</strong>, held by a coordination service or agreed via gossip. Whoever routes requests (any node, a routing tier, or the client itself) follows a cached copy, and <strong>nodes refuse requests for partitions they no longer own</strong>, so a stale cache turns into a cheap retry instead of a wrong answer.</p>`,
        },
        {
          type: "text",
          html: `<h3>Service discovery with a moving target</h3>
<p>Every partitioned system must answer, for every request: which node owns this key right now? This is a case of <strong>service discovery</strong>, which any networked software faces, but stricter: the answer changes during every rebalance, and all participants must agree on it, because a request sent to the wrong node is at best wasted and at worst applied to a copy nobody will read again.</p>
<p>There are three places to put the routing decision:</p>
<ol>
<li><strong>Any node.</strong> Clients contact any node, for example through a round-robin load balancer. If that node owns the partition it handles the request; otherwise it forwards the request to the owner and relays the reply.</li>
<li><strong>A routing tier.</strong> All requests go to a partition-aware router that stores no data; it only decides which node should handle each request and forwards it there.</li>
<li><strong>Partition-aware clients.</strong> The client library knows the partition map and connects directly to the owner, with no intermediary.</li>
</ol>`,
        },
        {
          type: "diagram",
          title: "Three places to make the routing decision",
          svg: `<style>.dd-diagram-body svg.ch6d2-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d2-w{display:none!important}.dd-diagram-body svg.ch6d2-n{display:block!important}}</style><svg class="ch6d2-w" viewBox="0 0 640 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three ways to route a request for a key in partition P3, owned by node B. Any node: client to load balancer to node A, which forwards to node B (up to 2 hops; Cassandra, Riak). Routing tier: client to router to node B (2 hops; mongos, Vitess VTGate). Partition-aware client: client straight to node B (1 hop; Redis Cluster and Kafka clients)."><defs><marker id="c6d2-ra-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker></defs><rect x="8" y="8" width="200" height="254" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="108" y="30" font-size="13" text-anchor="middle" font-weight="700">Any node</text><rect x="58" y="42" width="100" height="30" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="108" y="62" font-size="12" text-anchor="middle" font-weight="700">Client</text><rect x="53" y="92" width="110" height="28" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="108" y="111" font-size="12" text-anchor="middle">Load balancer</text><line x1="108" y1="72" x2="108" y2="90" stroke-width="1.6" marker-end="url(#c6d2-ra-w-a)" style="stroke: var(--viz-c6)"/><line x1="88" y1="120" x2="66" y2="142" stroke-width="1.6" marker-end="url(#c6d2-ra-w-a)" style="stroke: var(--viz-c6)"/><rect x="22" y="144" width="76" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="60" y="167" font-size="12" text-anchor="middle" font-weight="700">Node A</text><rect x="118" y="144" width="76" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="156" y="160" font-size="12" text-anchor="middle" font-weight="700">Node B</text><text x="156" y="174" font-size="12" text-anchor="middle">owns P3</text><path d="M60,181 Q108,210 152,183" stroke-width="1.6" marker-end="url(#c6d2-ra-w-a)" style="fill: none; stroke: var(--viz-c6)"/><text x="108" y="214" font-size="12" text-anchor="middle" class="viz-halo" style="fill: var(--viz-muted)">forward</text><text x="108" y="234" font-size="12" text-anchor="middle" font-weight="700">up to 2 hops</text><text x="108" y="251" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Cassandra, Riak</text><rect x="220" y="8" width="200" height="254" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="320" y="30" font-size="13" text-anchor="middle" font-weight="700">Routing tier</text><rect x="270" y="42" width="100" height="30" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="320" y="62" font-size="12" text-anchor="middle" font-weight="700">Client</text><rect x="275" y="96" width="90" height="28" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/><text x="320" y="115" font-size="12" text-anchor="middle" font-weight="700">Router</text><line x1="320" y1="72" x2="320" y2="94" stroke-width="1.6" marker-end="url(#c6d2-ra-w-a)" style="stroke: var(--viz-c6)"/><line x1="340" y1="120" x2="362" y2="142" stroke-width="1.6" marker-end="url(#c6d2-ra-w-a)" style="stroke: var(--viz-c6)"/><rect x="234" y="144" width="76" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="272" y="167" font-size="12" text-anchor="middle" font-weight="700">Node A</text><rect x="330" y="144" width="76" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="368" y="160" font-size="12" text-anchor="middle" font-weight="700">Node B</text><text x="368" y="174" font-size="12" text-anchor="middle">owns P3</text><text x="320" y="234" font-size="12" text-anchor="middle" font-weight="700">2 hops</text><text x="320" y="251" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">mongos, Vitess VTGate</text><rect x="432" y="8" width="200" height="254" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="532" y="30" font-size="13" text-anchor="middle" font-weight="700">Partition-aware client</text><rect x="482" y="42" width="100" height="30" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="532" y="62" font-size="12" text-anchor="middle" font-weight="700">Client + map</text><line x1="552" y1="72" x2="580" y2="142" stroke-width="1.6" marker-end="url(#c6d2-ra-w-a)" style="stroke: var(--viz-c6)"/><text x="564" y="106" font-size="12" text-anchor="start" class="viz-halo" style="fill: var(--viz-muted)">direct</text><rect x="446" y="144" width="76" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="484" y="167" font-size="12" text-anchor="middle" font-weight="700">Node A</text><rect x="542" y="144" width="76" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="580" y="160" font-size="12" text-anchor="middle" font-weight="700">Node B</text><text x="580" y="174" font-size="12" text-anchor="middle">owns P3</text><text x="532" y="234" font-size="12" text-anchor="middle" font-weight="700">1 hop</text><text x="532" y="251" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Redis Cluster, Kafka clients</text></svg><svg class="ch6d2-n" viewBox="0 0 360 486" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three ways to route a request for a key in partition P3, owned by node B. Any node: client to load balancer to node A, which forwards to node B (up to 2 hops; Cassandra, Riak). Routing tier: client to router to node B (2 hops; mongos, Vitess VTGate). Partition-aware client: client straight to node B (1 hop; Redis Cluster and Kafka clients)."><defs><marker id="c6d2-ra-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker></defs><rect x="6" y="6" width="348" height="150" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="180" y="28" font-size="13" text-anchor="middle" font-weight="700">Any node</text><rect x="14" y="50" width="62" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="45" y="75" font-size="12" text-anchor="middle" font-weight="700">Client</text><rect x="96" y="50" width="62" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="127" y="75" font-size="12" text-anchor="middle">LB</text><rect x="182" y="50" width="70" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="217" y="75" font-size="12" text-anchor="middle" font-weight="700">Node A</text><rect x="276" y="50" width="70" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="311" y="67" font-size="12" text-anchor="middle" font-weight="700">Node B</text><text x="311" y="82" font-size="11" text-anchor="middle">owns P3</text><line x1="76" y1="70" x2="94" y2="70" stroke-width="1.6" marker-end="url(#c6d2-ra-n-a)" style="stroke: var(--viz-c6)"/><line x1="158" y1="70" x2="180" y2="70" stroke-width="1.6" marker-end="url(#c6d2-ra-n-a)" style="stroke: var(--viz-c6)"/><line x1="252" y1="70" x2="274" y2="70" stroke-width="1.6" marker-end="url(#c6d2-ra-n-a)" style="stroke: var(--viz-c6)"/><text x="180" y="124" font-size="12" text-anchor="middle" font-weight="700">up to 2 hops</text><text x="180" y="142" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Cassandra, Riak</text><rect x="6" y="166" width="348" height="150" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="180" y="188" font-size="13" text-anchor="middle" font-weight="700">Routing tier</text><rect x="14" y="210" width="70" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="49" y="235" font-size="12" text-anchor="middle" font-weight="700">Client</text><rect x="112" y="210" width="80" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/><text x="152" y="235" font-size="12" text-anchor="middle" font-weight="700">Router</text><rect x="220" y="210" width="54" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="247" y="235" font-size="12" text-anchor="middle" font-weight="700">A</text><rect x="284" y="210" width="62" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="315" y="227" font-size="12" text-anchor="middle" font-weight="700">Node B</text><text x="315" y="242" font-size="11" text-anchor="middle">owns P3</text><line x1="84" y1="230" x2="110" y2="230" stroke-width="1.6" marker-end="url(#c6d2-ra-n-a)" style="stroke: var(--viz-c6)"/><path d="M192,244 Q240,276 296,252" stroke-width="1.6" marker-end="url(#c6d2-ra-n-a)" style="fill: none; stroke: var(--viz-c6)"/><text x="180" y="284" font-size="12" text-anchor="middle" font-weight="700">2 hops</text><text x="180" y="302" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">mongos, Vitess VTGate</text><rect x="6" y="326" width="348" height="150" rx="10" stroke-width="1" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="180" y="348" font-size="13" text-anchor="middle" font-weight="700">Partition-aware client</text><rect x="14" y="370" width="110" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="69" y="395" font-size="12" text-anchor="middle" font-weight="700">Client + map</text><rect x="150" y="370" width="70" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="185" y="395" font-size="12" text-anchor="middle" font-weight="700">Node A</text><rect x="276" y="370" width="70" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="311" y="387" font-size="12" text-anchor="middle" font-weight="700">Node B</text><text x="311" y="402" font-size="11" text-anchor="middle">owns P3</text><path d="M124,404 Q210,440 292,412" stroke-width="1.6" marker-end="url(#c6d2-ra-n-a)" style="fill: none; stroke: var(--viz-c6)"/><text x="180" y="444" font-size="12" text-anchor="middle" font-weight="700">1 hop</text><text x="180" y="462" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Redis Cluster, Kafka clients</text></svg>`,
          caption: "Shown for a key in partition P3, owned by node B; the reply returns along the same path. The fewer the hops, the more of the routing logic, and of the staleness problem, lives in the client.",
        },
        {
          type: "text",
          html: `<h3>Who knows the map?</h3>
<p>All three approaches share one hard question: when partitions move, how does whoever routes requests find out? Getting every participant to agree on the current map is a distributed agreement problem, the consensus problem of <a href="#/ch9/learn/coordination-services">Chapter 9</a>, and real systems answer it in two main ways.</p>
<p><strong>A coordination service.</strong> Each node registers with a service such as ZooKeeper or etcd, which stores the authoritative map of partitions to nodes, replicated and strongly consistent. Routers or clients subscribe to it and are notified whenever the map changes. HBase, SolrCloud and Kafka (before KRaft) use ZooKeeper this way, and LinkedIn's Espresso uses Helix, a cluster manager built on ZooKeeper. MongoDB has a similar architecture with its own pieces: config servers hold the metadata, and <code>mongos</code> processes act as the routing tier.</p>`,
        },
        {
          type: "diagram",
          title: "A coordination service holds the partition map",
          svg: `<style>.dd-diagram-body svg.ch6d2-n{display:none!important}@media (max-width:600px){.dd-diagram-body svg.ch6d2-w{display:none!important}.dd-diagram-body svg.ch6d2-n{display:block!important}}</style><svg class="ch6d2-w" viewBox="0 0 640 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A coordination service such as ZooKeeper or etcd holds the authoritative partition map, version 42: keys a to f in P0 on node 1, g to m in P1 on node 3, n to s in P2 on node 2, t to z in P3 on node 1. Nodes register with it, the routing tier watches it for changes, and a client's get(kim) goes to the routing tier, which sends it to node 3."><defs><marker id="c6d2-co-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker><marker id="c6d2-co-w-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c5)"/></marker><marker id="c6d2-co-w-k" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs><rect x="180" y="10" width="270" height="128" rx="8" stroke-width="1.5" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="315" y="30" font-size="13" text-anchor="middle" font-weight="700">ZooKeeper / etcd</text><text x="315" y="47" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">partition map v42</text><text x="234" y="68" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">keys</text><text x="315" y="68" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">partition</text><text x="396" y="68" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">node</text><text x="234" y="85" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">a–f</text><text x="315" y="85" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">P0</text><text x="396" y="85" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">node 1</text><rect x="188" y="89" width="254" height="17" rx="4" stroke-width="1" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="234" y="102" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">g–m</text><text x="315" y="102" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">P1</text><text x="396" y="102" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">node 3</text><text x="234" y="119" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">n–s</text><text x="315" y="119" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">P2</text><text x="396" y="119" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">node 2</text><text x="234" y="136" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t–z</text><text x="315" y="136" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">P3</text><text x="396" y="136" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">node 1</text><rect x="510" y="16" width="120" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="570" y="43" font-size="12" text-anchor="middle" font-weight="700">Node 1</text><rect x="510" y="102" width="120" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="570" y="129" font-size="12" text-anchor="middle" font-weight="700">Node 2</text><rect x="510" y="196" width="120" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="570" y="223" font-size="12" text-anchor="middle" font-weight="700">Node 3</text><line x1="508" y1="38" x2="452" y2="50" stroke-width="1.6" marker-end="url(#c6d2-co-w-k)" style="stroke: var(--viz-muted)"/><line x1="508" y1="124" x2="452" y2="108" stroke-width="1.6" marker-end="url(#c6d2-co-w-k)" style="stroke: var(--viz-muted)"/><line x1="530" y1="194" x2="452" y2="134" stroke-width="1.6" marker-end="url(#c6d2-co-w-k)" style="stroke: var(--viz-muted)"/><text x="480" y="82" font-size="12" text-anchor="middle" class="viz-halo" style="fill: var(--viz-muted)">register</text><rect x="220" y="196" width="190" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/><text x="315" y="216" font-size="12" text-anchor="middle" font-weight="700">Routing tier</text><text x="315" y="232" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cached map v42</text><line x1="300" y1="194" x2="300" y2="140" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#c6d2-co-w-m)" style="stroke: var(--viz-c5)"/><line x1="330" y1="142" x2="330" y2="194" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#c6d2-co-w-m)" style="stroke: var(--viz-c5)"/><text x="338" y="172" font-size="12" text-anchor="start" class="viz-halo" style="fill: var(--viz-muted)">notify on change</text><text x="292" y="172" font-size="12" text-anchor="end" class="viz-halo" style="fill: var(--viz-muted)">watch</text><rect x="14" y="196" width="110" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="69" y="223" font-size="12" text-anchor="middle" font-weight="700">Client</text><line x1="124" y1="218" x2="218" y2="218" stroke-width="1.6" marker-end="url(#c6d2-co-w-a)" style="stroke: var(--viz-c6)"/><text x="171" y="210" font-size="12" text-anchor="middle" class="viz-halo" style="font-family: var(--font-mono)">get(kim)</text><line x1="410" y1="218" x2="508" y2="218" stroke-width="1.6" marker-end="url(#c6d2-co-w-a)" style="stroke: var(--viz-c6)"/><text x="459" y="210" font-size="12" text-anchor="middle" font-weight="700" class="viz-halo" style="font-family: var(--font-mono)">P1</text></svg><svg class="ch6d2-n" viewBox="0 0 360 392" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A coordination service such as ZooKeeper or etcd holds the authoritative partition map, version 42: keys a to f in P0 on node 1, g to m in P1 on node 3, n to s in P2 on node 2, t to z in P3 on node 1. Nodes register with it, the routing tier watches it for changes, and a client's get(kim) goes to the routing tier, which sends it to node 3."><defs><marker id="c6d2-co-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker><marker id="c6d2-co-n-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c5)"/></marker><marker id="c6d2-co-n-k" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs><rect x="10" y="8" width="300" height="128" rx="8" stroke-width="1.5" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="160" y="28" font-size="13" text-anchor="middle" font-weight="700">ZooKeeper / etcd</text><text x="160" y="45" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">partition map v42</text><text x="70" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">keys</text><text x="160" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">partition</text><text x="250" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">node</text><text x="70" y="83" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">a–f</text><text x="160" y="83" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">P0</text><text x="250" y="83" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">node 1</text><rect x="18" y="87" width="284" height="17" rx="4" stroke-width="1" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="70" y="100" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">g–m</text><text x="160" y="100" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">P1</text><text x="250" y="100" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">node 3</text><text x="70" y="117" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">n–s</text><text x="160" y="117" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">P2</text><text x="250" y="117" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">node 2</text><text x="70" y="134" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t–z</text><text x="160" y="134" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">P3</text><text x="250" y="134" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">node 1</text><rect x="120" y="196" width="160" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/><text x="200" y="216" font-size="12" text-anchor="middle" font-weight="700">Routing tier</text><text x="200" y="232" font-size="11" text-anchor="middle" style="font-family: var(--font-mono)">cached map v42</text><line x1="186" y1="194" x2="186" y2="138" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#c6d2-co-n-m)" style="stroke: var(--viz-c5)"/><line x1="214" y1="138" x2="214" y2="194" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#c6d2-co-n-m)" style="stroke: var(--viz-c5)"/><text x="180" y="170" font-size="12" text-anchor="end" class="viz-halo" style="fill: var(--viz-muted)">watch</text><text x="220" y="170" font-size="12" text-anchor="start" class="viz-halo" style="fill: var(--viz-muted)">notify</text><rect x="10" y="196" width="80" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="50" y="223" font-size="12" text-anchor="middle" font-weight="700">Client</text><line x1="90" y1="218" x2="118" y2="218" stroke-width="1.6" marker-end="url(#c6d2-co-n-a)" style="stroke: var(--viz-c6)"/><text x="104" y="262" font-size="12" text-anchor="middle" class="viz-halo" style="font-family: var(--font-mono)">get(kim)</text><rect x="10" y="320" width="90" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="55" y="345" font-size="12" text-anchor="middle" font-weight="700">Node 1</text><rect x="112" y="320" width="90" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="157" y="345" font-size="12" text-anchor="middle" font-weight="700">Node 2</text><rect x="214" y="320" width="90" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="259" y="345" font-size="12" text-anchor="middle" font-weight="700">Node 3</text><line x1="250" y1="240" x2="262" y2="318" stroke-width="1.6" marker-end="url(#c6d2-co-n-a)" style="stroke: var(--viz-c6)"/><text x="272" y="286" font-size="12" text-anchor="start" font-weight="700" class="viz-halo" style="font-family: var(--font-mono)">P1</text><path d="M304,340 L338,340 L338,72 L312,72" stroke-width="1.6" marker-end="url(#c6d2-co-n-k)" style="fill: none; stroke: var(--viz-muted)"/><text x="332" y="380" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">nodes register</text></svg>`,
          caption: "The map is small, versioned and stored in one strongly consistent place. Nodes register, routers watch for changes and keep a cached copy, and requests never pass through ZooKeeper itself.",
        },
        {
          type: "text",
          html: `<p><strong>Gossip.</strong> Cassandra and Riak instead have nodes spread cluster state among themselves with a gossip protocol, so every node learns about membership and ownership changes within a few rounds. Any node can accept a request and forward it to the owner, as in approach 1; in practice Cassandra drivers usually add a token-aware policy and send each request straight to a replica that owns the key. Gossip puts more complexity into the database nodes but removes the dependency on an external coordination service. Couchbase, per the book, doesn't rebalance automatically, which simplifies its design; it uses a routing tier called moxi that learns routing changes from the cluster nodes.</p>
<p>Finding a node's IP address is a much easier problem, because addresses change rarely. Plain DNS is usually good enough for that part.</p>
<h3>Stale maps are normal; acting on them is not</h3>
<p>Notifications take time to arrive and clients cache maps, so during a move some router or client always holds a stale copy for a moment. Robust systems assume this and design the protocol around it:</p>
<ul>
<li>The map carries a <strong>version or epoch number</strong> that increases on every change.</li>
<li>A node <strong>refuses or redirects</strong> requests for partitions it no longer owns: Redis Cluster replies <code>MOVED</code> or <code>ASK</code>, Kafka brokers return a "not leader" error, and MongoDB shards reject operations tagged with a stale routing version.</li>
<li>The router or client <strong>refreshes its map and retries</strong>. A stale cache costs an extra round trip, never a wrong answer.</li>
</ul>
<p>The move itself needs the same care. The old owner keeps serving the partition until cut-over; after cut-over it must stop accepting writes for it, or two nodes would accept writes for the same partition, a form of split brain. That is why robust systems keep the map in linearizable storage (Chapter 9) and check a version on every request, the same idea as Chapter 8's fencing tokens.</p>
<p>The scenario below plays one partition move in each routing style. Key <code>user:77</code> lives in P3, which moves from node B to a newly joined node C while a client keeps reading and writing; the stats count hops, wrong-node requests and lost writes.</p>`,
        },
        {
          type: "viz",
          id: "ch6/request-routing",
          title: "Routing through a partition move",
          caption: "Try Play in each Routing mode, then switch <em>Old owner checks ownership</em> off and play again. Notice where the stale map is caught in each mode (a MOVED redirect, a stale-version rejection, an extra forward), and that without the check node B acknowledges a write that the final read never sees.",
        },
        {
          type: "text",
          html: `<p>In every mode the stale map was caught in the same place: at the old owner, B. The partition-aware client paid one redirect; the routing tier paid one rejection and a retry; in the gossip cluster, B forwarded the write onward, an extra hop instead of an error. With the check off, every mode fails the same way: B still holds a leftover copy of P3, applies the write and says OK, and the write vanishes because nobody reads B's copy again. The client did nothing wrong. <strong>Correctness during a move comes from the old owner checking ownership</strong>, not from keeping every cache perfectly fresh.</p>`,
        },
        {
          type: "table",
          title: "Comparing the three approaches",
          headers: ["", "Any node + forwarding", "Routing tier", "Partition-aware client"],
          rows: [
            ["Hops per request", "1 if you reach the owner, otherwise 2", "Always 2", "1"],
            ["Who holds the map", "Every node (often learned by gossip)", "The routers, watching a coordinator", "Every client, fetched from the cluster"],
            ["Client complexity", "Minimal: any node will do", "Minimal: one address to know", "Highest: the library routes, caches and retries"],
            ["Extra moving parts", "None, but nodes must forward", "A router fleet to scale and keep available", "None, but every language needs a smart driver"],
            ["Where staleness is caught", "The owner rejects or forwards again", "The owner rejects; the router refreshes", "The owner redirects; the client refreshes"],
            ["Examples", "Cassandra, Riak", "MongoDB mongos, Vitess VTGate, Couchbase moxi", "Redis Cluster and Kafka clients, Cassandra token-aware drivers"],
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Redis Cluster",
              tag: "Smart clients",
              html: `<p>Clients cache the hash-slot → node map and talk to the owner directly. A node that doesn't own a slot replies <code>-MOVED &lt;slot&gt; &lt;host:port&gt;</code> for a permanent move (update the map) or <code>-ASK</code> during an in-progress migration (retry once at the target, without updating the map).</p>`,
            },
            {
              org: "MongoDB",
              tag: "Routing tier",
              html: `<p><code>mongos</code> routers cache the routing table from the config servers. Shards check the routing version attached to each operation and reject operations sent with a stale version; the <code>mongos</code> then refreshes its table and retries.</p>`,
            },
            {
              org: "Apache Kafka",
              tag: "Smart clients",
              html: `<p>Clients ask any broker for metadata (which broker leads each partition), send requests directly to the leaders, and refresh their metadata when a broker answers "not leader."</p>`,
            },
            {
              org: "Vitess (YouTube, Slack)",
              tag: "Routing tier",
              html: `<p>Vitess, built at YouTube in 2010 to scale MySQL and a CNCF graduated project since 2019, routes queries through VTGate proxies that read shard topology from a topology service (etcd, ZooKeeper or Consul). Slack began migrating to it in 2017 and by 2020 reported it serving 99% of its query load, 2.3 million queries per second at peak.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Kafka drops ZooKeeper",
          html: `<p>Kafka once kept its cluster metadata, including which broker leads each partition, in ZooKeeper. KIP-500 replaced it with <strong>KRaft</strong>, a Raft-based quorum of controller nodes inside Kafka itself: production-ready in Kafka 3.3 (2022), with ZooKeeper mode removed entirely in Kafka 4.0 (2025). The authoritative map still lives in a consensus-replicated log, now one Kafka runs itself, and clients still route the same way: fetch leader metadata from any broker, then talk to partition leaders directly.</p>`,
        },
        {
          type: "text",
          html: `<h3>Beyond single-key requests: parallel query execution</h3>
<p>Everything so far assumed a request touches one key in one partition, which holds for most key-value and document lookups. Analytics databases go much further. <strong>Massively parallel processing (MPP)</strong> relational databases, used for data warehousing, accept complex queries with joins, filters, grouping and aggregation. The query optimizer breaks such a query into stages and partitioned pieces that run in parallel on many nodes, shuffling intermediate results between them. Routing there is not "find the one owner" but "spread the work over all owners"; Chapter 10 covers the techniques, which overlap heavily with batch processing.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"How does a request find its shard?\"",
          html: `<p>This comes right after you propose sharding. A strong answer picks one of the three approaches and says why (a smart client for the lowest latency, a router such as <code>mongos</code> or VTGate to keep clients simple), then addresses the real question: <strong>how the map stays correct</strong>. Keep the authoritative, versioned map in a consensus-backed store (ZooKeeper, etcd or a Raft-based controller), cache it in routers or clients, and never consult the coordinator on the hot path. Have nodes reject requests for partitions they don't own, so stale caches cause a retry rather than a lost write, and fence the old owner after cut-over. Weak answers stop at "put a load balancer in front" or "use DNS", which find machines, not partitions.</p>`,
        },
        {
          type: "quiz",
          q: "A partition-aware client caches the partition map. Partition P3 moves from node B to node C. What makes the client's next request for a P3 key correct?",
          options: [
            "The client process must be restarted to reload the map",
            "DNS is updated so that B's hostname now points at C",
            "The coordination service intercepts the request and forwards it to C",
            "B refuses or redirects requests for P3 (naming the new owner or returning a version error), so the client refreshes its map and retries at C",
          ],
          answer: 3,
          explain: "Caches will be stale at some point, so correctness comes from the old owner refusing to serve what it no longer owns and the client refreshing on that signal (Redis MOVED, Kafka \"not leader\", MongoDB stale version). The coordination-service option is tempting, but ZooKeeper or etcd store and publish the map; they never sit in the request path. DNS tracks node addresses, not partition ownership, and restarting clients would be neither necessary nor safe for requests already in flight.",
        },
      ],
    },
  ],

  takeaways: [
    "Partitioning spreads data and load across machines. The hard part is not splitting but <strong>choosing the key from your access patterns</strong>, so that load stays even, your most important queries stay on one partition, and data used together is co-located.",
    "Key-range partitioning keeps order (cheap range scans) but turns sequential keys into a moving hot spot; hashing spreads keys evenly but scatters every range query. A <strong>compound key</strong> (hash the entity, sort within it) gets both for per-entity queries.",
    "<strong>No partitioner can split a single hot key.</strong> The application must split it into sub-keys (paying on every read) or combine writes before they reach the database.",
    "Secondary indexes force a choice: <strong>local indexes</strong> keep writes cheap but make queries scatter-gather, as slow as the slowest partition; <strong>global indexes</strong> make queries one hop, but writes touch other partitions and are usually asynchronous or need distributed transactions.",
    "Never place data by <strong>hash mod number-of-nodes</strong>: one new node moves about N/(N+1) of the data. Map keys to partitions with a stable function and move whole partitions or hash ranges, so only about 1/(N+1) moves.",
    "Fixed, dynamic and per-node partitioning differ in <strong>what stays constant</strong>, and each has a characteristic trap: choosing the count, a new table's single partition, random unfair splits.",
    "Rebalancing is expensive and risky: <strong>automate the plan, throttle the execution</strong>, and don't let failure detection trigger large moves blindly, because a timeout cannot tell a slow node from a dead one.",
    "Routing needs <strong>one authoritative, versioned partition map</strong> and nodes that refuse requests for partitions they no longer own, so stale caches heal themselves instead of losing writes.",
  ],

  connections: [
    { to: "ch1", html: "Partitioning is the main tool for scaling out, Chapter 1's scalability. Scatter-gather queries over many partitions suffer tail latency amplification, and Twitter's celebrity fan-out is a hot-key problem solved at the application level." },
    { to: "ch3", html: "Within each partition, keys are stored sorted in SSTables, LSM-trees or B-trees, which is what makes key-range scans and Cassandra's clustering columns efficient. Dynamic partition splits mirror B-tree page splits." },
    { to: "ch5", html: "Every partition is itself replicated, and a node is leader for some partitions and follower for others. Hinted handoff and sloppy quorums handle temporary unavailability without changing partition ownership." },
    { to: "ch7", html: "Transactions that touch several partitions, including keeping a global secondary index in sync, are much harder than single-partition ones; this is why many systems keep global indexes asynchronous." },
    { to: "ch8", html: "Timeouts cannot tell a slow node from a dead one, which is how automatic rebalancing triggers cascading failures, and after a partition moves, fencing stops the old owner from accepting writes. Also: \"partition\" in this chapter is unrelated to a network partition." },
    { to: "ch9", html: "Agreeing on the partition → node map is a consensus problem: ZooKeeper, etcd and Raft-based controllers such as Kafka's KRaft store it linearizably. Atomic commit across partitions needs two-phase commit." },
    { to: "ch10", html: "Batch jobs repartition data by key (the shuffle) and join datasets that are partitioned the same way; MPP databases run parallel query execution across partitions." },
    { to: "ch11", html: "Kafka topics are partitioned logs: ordering holds only within a partition, the key → partition mapping changes if partitions are added, and change data capture can maintain global indexes as derived data." },
    { to: "ch12", html: "Global secondary indexes and other cross-partition views can be treated as derived data maintained asynchronously from a log, which makes the consistency and latency trade-off explicit." },
  ],

  furtherReading: [
    { title: "Dynamo: Amazon's Highly Available Key-value Store (SOSP 2007)", url: "https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf", note: "Consistent hashing with virtual nodes, preference lists and partition placement in a production system, including the move from random tokens to equal-sized partitions; the ancestor of Cassandra's and Riak's partitioning." },
    { title: "Bigtable: A Distributed Storage System for Structured Data (OSDI 2006)", url: "https://research.google/pubs/bigtable-a-distributed-storage-system-for-structured-data/", note: "The canonical key-range design: sorted row keys, tablets that split dynamically, and row-key design such as reversed hostnames." },
    { title: "Karger et al., Consistent Hashing and Random Trees (STOC 1997)", note: "Where consistent hashing comes from, and why it was designed for web caches rather than databases." },
    { title: "Lamping and Veach, A Fast, Minimal Memory, Consistent Hash Algorithm (2014)", url: "https://arxiv.org/abs/1406.2294", note: "Jump consistent hash: balanced placement with no ring metadata, and its limitation that buckets must be numbered sequentially." },
    { title: "Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service (USENIX ATC 2022)", url: "https://www.usenix.org/conference/atc22/presentation/elhemali", note: "How DynamoDB partitions, splits for size and heat, enforces per-partition limits and routes requests at scale." },
    { title: "How Discord Stores Billions of Messages (2017)", url: "https://discord.com/blog/how-discord-stores-billions-of-messages", note: "A clear real-world compound partition key with time buckets." },
    { title: "How Discord Stores Trillions of Messages (2023)", url: "https://discord.com/blog/how-discord-stores-trillions-of-messages", note: "Hot partitions in production, and how request coalescing and a migration to ScyllaDB addressed them." },
    { title: "Herding elephants: Lessons learned from sharding Postgres at Notion (2021)", url: "https://www.notion.com/blog/sharding-postgres-at-notion", note: "Choosing a partition key (workspace ID), logical versus physical shards, and why 480." },
    { title: "The Great Re-shard: adding Postgres capacity (again) with zero downtime (Notion, 2023)", url: "https://www.notion.com/blog/the-great-re-shard", note: "A fixed-logical-shard rebalance in practice: 480 logical shards moved from 32 to 96 machines." },
    { title: "Sharding & IDs at Instagram (2012)", note: "Logical shards mapped to physical servers, and IDs that encode their shard." },
    { title: "How Figma's databases team lived to tell the scale (Figma, 2024)", url: "https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/", note: "Vertical partitioning first, then horizontal sharding with colos, logical-before-physical sharding and a routing proxy." },
    { title: "Redis Cluster specification", url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/", note: "Hash slots, hash tags, and MOVED/ASK redirections: a compact, well-documented partition-aware client protocol." },
    { title: "Scaling Datastores at Slack with Vitess (Slack, 2020)", url: "https://slack.engineering/scaling-datastores-at-slack-with-vitess/", note: "A routing tier (VTGate) in front of sharded MySQL, and what it took to migrate onto it." },
  ],
});
