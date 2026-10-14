// Chapter 8 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch8", {
  sections: [
    // ───────────────────────────────────────────────────────────── 6
    {
      id: "process-pauses",
      title: "The node that froze mid-sentence",
      kicker: "Process pauses",
      concepts: ["process-pauses", "lease", "hard-real-time"],
      blocks: [
        {
          type: "problem",
          html: `<p>The network and the clock have both let us down; the last thing a node might hope to trust is its own execution. Take a single-leader database, which must have exactly one leader at a time. How does a node know it is <em>still</em> the leader? A common answer is a <strong>lease</strong>: a lock with a timeout, granted by the other nodes or by a lock service. Only one node can hold it at a time, the holder must keep renewing it, and if the holder dies, the lease simply runs out and another node can take over.</p>
<p>The obvious request loop is: if the lease is about to expire, renew it; if the lease is valid, handle the request. Now freeze the leader's thread for 15 seconds right after the "is it valid?" check, perhaps in a garbage-collection pause. The lease expires during the freeze, another node acquires it and starts leading, and then the old leader's thread resumes and handles the request anyway. It has no lease, the cluster has two leaders, and nothing in the old leader's code noticed anything.</p>`,
        },
        {
          type: "idea",
          html: `<p>Any thread can be paused for an arbitrary length of time, at any point in its code, without noticing. So correctness must never depend on "nothing happened between my check and my action".</p>`,
        },
        {
          type: "code",
          lang: "java",
          title: "The naive leader loop",
          code: `// Runs forever on the node that believes it is the leader.
while (true) {
    Request req = inbox.next();              // block until a request arrives

    // Renew when fewer than 10 s remain.
    // FLAW 1: expiresAt was computed on the grantor's clock,
    // but it is compared against THIS machine's wall clock.
    if (lease.expiresAt - System.currentTimeMillis() < 10_000) {
        lease = renewLease(lease);
    }

    if (lease.isValid()) {
        // FLAW 2: the dangerous gap. A 15 s pause can land right here,
        // after the check and before the work, and nothing below notices.
        serve(req);                           // may act as leader with no lease
    }
}`,
          caption: "Pseudocode. A 10-second renewal margin looks generous when a request takes milliseconds; it is useless against a 15-second pause.",
        },
        {
          type: "text",
          html: `<h3>Two flaws in a dozen lines</h3>
<p>The first flaw is that the expiry time was computed on another machine's clock and is compared against the local time-of-day clock. As the section on two clocks shows, those clocks can be seconds apart, and NTP can make either of them jump. If the leader's clock runs a few seconds behind the grantor's, it keeps believing in its lease after the grantor has already handed it to someone else.</p>
<p>The second flaw survives every clock fix. The code assumes that almost no time passes between <code>lease.isValid()</code> and <code>serve(req)</code>, which is true nearly always, and "nearly" is the problem. If the thread stops for 15 seconds right after the check, the lease expires while the thread is frozen, and when it resumes, the next line of code runs exactly as it would have without the pause. The timeline below shows what the rest of the cluster sees in the meantime.</p>`,
        },
        {
          type: "diagram",
          title: "Checked, then frozen",
          svg: `<svg viewBox="0 0 420 224" style="max-width: 560px; margin: 0 auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline: node A checks its lease at 0 seconds with 10 seconds left, freezes in a GC pause from 1 to 16 seconds, its lease expires at 10 seconds, node B acquires the lease at 11 seconds, and node A acts as leader at 16 seconds without a lease">
<line x1="210" y1="26" x2="210" y2="196" stroke-width="1.5" stroke-dasharray="5 4" style="stroke: var(--viz-muted)"/>
<text x="210" y="16" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">t = 10 s: A's lease expires</text>
<text x="20" y="40" font-size="13" font-weight="700">Node A <tspan font-size="12" font-weight="400" style="fill: var(--viz-muted)">old leader</tspan></text>
<rect x="20" y="48" width="190" height="16" rx="4" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="115" y="60" text-anchor="middle" font-size="12">A's lease</text>
<rect x="39" y="70" width="285" height="24" rx="4" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="48" y="86" font-size="12" font-weight="600">GC pause: frozen 15 s</text>
<circle cx="24" cy="82" r="6" style="fill: var(--viz-ok); stroke: var(--viz-ok)"/>
<text x="14" y="112" font-size="12" font-weight="600" style="fill: var(--viz-ok)">checks lease: 10 s left</text>
<line x1="330" y1="76" x2="342" y2="88" stroke-width="3" style="stroke: var(--viz-bad)"/>
<line x1="342" y1="76" x2="330" y2="88" stroke-width="3" style="stroke: var(--viz-bad)"/>
<text x="406" y="112" text-anchor="end" font-size="12" font-weight="700" style="fill: var(--viz-bad)">acts as leader: no lease!</text>
<text x="20" y="140" font-size="13" font-weight="700">Node B <tspan font-size="12" font-weight="400" style="fill: var(--viz-muted)">new leader</tspan></text>
<text x="20" y="160" font-size="12" style="fill: var(--viz-muted)">follower; A silent from 1 s</text>
<rect x="229" y="148" width="171" height="16" rx="4" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="314" y="160" text-anchor="middle" font-size="12">B's lease</text>
<text x="406" y="182" text-anchor="end" font-size="12" font-weight="600">t = 11 s: B takes the lease</text>
<line x1="20" y1="200" x2="400" y2="200" stroke-width="1.2" style="stroke: var(--viz-line)"/>
<line x1="20" y1="196" x2="20" y2="204" style="stroke: var(--viz-line)"/>
<line x1="115" y1="196" x2="115" y2="204" style="stroke: var(--viz-line)"/>
<line x1="210" y1="196" x2="210" y2="204" style="stroke: var(--viz-line)"/>
<line x1="305" y1="196" x2="305" y2="204" style="stroke: var(--viz-line)"/>
<line x1="400" y1="196" x2="400" y2="204" style="stroke: var(--viz-line)"/>
<text x="20" y="218" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">0 s</text>
<text x="115" y="218" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">5 s</text>
<text x="210" y="218" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">10 s</text>
<text x="305" y="218" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">15 s</text>
<text x="400" y="218" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">20 s</text>
</svg>`,
          caption: "Nothing in A's code ran between the check and the action, yet 15 seconds passed: the lease expired, B legitimately became leader, and A then acted on a check that was no longer true.",
        },
        {
          type: "text",
          html: `<p>From node A's point of view there was no gap at all. Its program counter moved from one line to the next. A clock reading taken afterward would reveal the jump, but A has no reason to look until its next check. Meanwhile the rest of the cluster kept going: A's heartbeats stopped, B's timeout fired, the lease ran out, and B took over exactly as designed. Every node behaved correctly by its own lights, and the result is two leaders.</p>`,
        },
        {
          type: "callout",
          tone: "tip",
          title: "Fixing the clock flaw (but not the pause flaw)",
          html: `<p>A lease doesn't need synchronized clocks if both sides measure <em>durations</em> on their own monotonic clocks and each errs on the safe side. The holder records its monotonic time <strong>before</strong> sending the acquire or renew request, and treats the lease as valid until that start time plus the lease duration, minus a safety margin. It can't know how long the request and reply were in flight, so it counts from the earliest moment the grant could have happened. The grantor counts from the moment it granted, and waits the full duration plus a margin before granting the lease to anyone else.</p>
<p>That requires only a bound on how much faster one clock can run than the other, not agreement on what time it is. Chubby's paper describes its client-side lease timeout as exactly this kind of conservative estimate. It does nothing for the second flaw: a pause between the validity check and the action still breaks it.</p>`,
        },
        {
          type: "text",
          html: `<h3>Why would a thread stop for 15 seconds?</h3>
<p>It sounds far-fetched until you list the ways it happens on ordinary servers:</p>
<ul>
<li><strong>Garbage collection.</strong> Runtimes like the JVM sometimes stop every application thread while they collect ("stop the world"). On large heaps such pauses have lasted many seconds, occasionally minutes. Even collectors billed as concurrent, like HotSpot's old CMS, couldn't run entirely alongside the application and had to stop it now and then.</li>
<li><strong>Virtualization.</strong> A hypervisor can suspend a virtual machine and resume it later, or live-migrate it to another host, pausing it while the last memory pages are copied. When several VMs share a host, a VM simply gets no CPU while another one runs; Linux reports this as <em>steal time</em>, and noisy neighbors make it worse.</li>
<li><strong>The operating system and the device.</strong> The OS can switch to other threads at any moment, and a laptop suspends everything when its lid closes.</li>
<li><strong>Synchronous I/O in innocent code.</strong> A thread can block on disk without calling any I/O function: the JVM loads a class file lazily the first time the class is used. On network block devices like Amazon EBS, or on network filesystems, a "disk" read is really a network round trip, with network-sized delays.</li>
<li><strong>Swapping.</strong> When memory is short, touching a page can mean reading it back from disk, and a machine under heavy pressure can thrash, spending most of its time paging. Many operators disable swap on servers, preferring an out-of-memory kill to a crawl.</li>
<li><strong>Signals.</strong> An operator or a script can send <code>SIGSTOP</code> (or press Ctrl-Z, which sends the similar <code>SIGTSTP</code>). The process stays frozen until it receives <code>SIGCONT</code>, possibly hours later.</li>
</ul>
<p>Any of these can strike between any two lines of code. That puts distributed code in the same position as multi-threaded code on one machine, where a context switch can also happen anywhere. The difference is the toolbox. On one machine you have mutexes, semaphores, atomic counters, lock-free data structures and blocking queues, all built on shared memory. Across a network there is no shared memory, only messages on a channel that can delay or lose them, and none of those tools carry over.</p>`,
        },
        {
          type: "table",
          title: "Where pauses come from, and what helps",
          headers: ["Pause source", "Why it's surprising", "Mitigation"],
          rows: [
            ["Stop-the-world GC", "\"Concurrent\" collectors still stop the world sometimes; pauses grow with heap size", "Low-pause collectors, smaller heaps, planned GC drains"],
            ["VM suspend or live migration", "Invisible to the guest; decided by the hypervisor", "None inside the guest: design for it"],
            ["Hypervisor steal time", "Caused by other tenants on the same host", "Dedicated hosts or instances; monitor steal time"],
            ["Synchronous disk or network-block-device I/O", "Hides in innocent code: class loading, page faults, logging", "Async I/O, local disks, warm-up and prefetching"],
            ["Swapping and thrashing", "Triggered by memory pressure, possibly from another process", "Disable swap; cap heap and cache sizes"],
            ["<code>SIGSTOP</code>, laptop suspend", "An operator or user action, not a bug", "No local fix: fence at the resource"],
          ],
          note: "Every mitigation makes pauses rarer or shorter. None makes them impossible, which is why the protocol itself has to tolerate them.",
        },
        {
          type: "analogy",
          title: "Anesthesia mid-sentence",
          html: `<p>Imagine someone put under anesthesia in the middle of a sentence during a meeting. Hours later they wake up and finish the sentence, confidently handing out tasks, unaware that the meeting ended, everyone went home, and someone else was given their job. From the inside no time passed. Only evidence from outside (a clock on the wall, a colleague's puzzled look) can reveal it, and only if they think to check.</p>`,
        },
        {
          type: "text",
          html: `<h3>Could we just eliminate pauses?</h3>
<p>Some systems do. The controller that fires a car's airbag cannot answer "in a moment, after GC". <strong>Hard real-time</strong> systems, such as airbag controllers, flight control, rockets and industrial robots, guarantee that the software responds within a specified deadline, and a missed deadline counts as a failure of the whole system.</p>
<p>That guarantee is bought at every layer: a real-time operating system that schedules processes with guaranteed CPU time slices; library functions whose worst-case execution times are documented; dynamic memory allocation restricted or banned (real-time garbage collectors exist, but under tight constraints); and enormous amounts of testing and measurement. "Real-time" does not mean "high-performance": these systems often have <em>lower</em> throughput, because they put predictable timing ahead of everything else.</p>
<p>For a server-side database or web service that cost is out of the question, so pauses remain a fact of life. The realistic goals are to make them rarer and to make sure they can't do damage.</p>
<h3>Making GC pauses less harmful</h3>
<p>One trick is to treat a GC pause like a brief planned outage of one node. The runtime warns that a node will soon need a collection, the load balancer stops sending it new requests, and the node finishes its in-flight requests, collects with nobody waiting, and rejoins. Some latency-sensitive financial trading systems work this way.</p>
<p>A variant is to use the garbage collector only for short-lived objects, which are cheap to collect, and to restart each process before long-lived objects pile up enough to force a full collection. Restart one node at a time and shift traffic away first, as in a rolling upgrade.</p>
<p>Neither technique touches VM migration, steal time or disk stalls, so the protocols themselves must stay correct even when a node pauses for any length of time at the worst possible moment. That is what fencing tokens, two sections from now, are for.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache HBase",
              tag: "Expired lease",
              html: `<p>HBase's troubleshooting guide warns that RegionServers shut themselves down after GC pauses longer than the ZooKeeper session timeout. By then the master has already declared the server dead, so when it wakes up and reports in it receives a <code>YouAreDeadException</code> and aborts rather than carry on as if it still served its regions.</p>`,
            },
            {
              org: "Discord",
              year: "2020",
              tag: "GC spikes",
              html: `<p>Discord's Go-based Read States service showed latency spikes roughly every two minutes, because the Go runtime forces a garbage collection at least that often. The team rewrote the service in Rust, which has no garbage collector, and described the change in "Why Discord is switching from Go to Rust".</p>`,
            },
            {
              org: "Java ZGC and Shenandoah",
              year: "2020",
              tag: "Low-pause GC",
              html: `<p>Both collectors became production features in JDK 15. They do almost all collection work concurrently with the application, keeping pauses in the low milliseconds or below, largely independent of heap size.</p>`,
            },
            {
              org: "Hypervisor live migration",
              tag: "Invisible pause",
              html: `<p>Live migration (Xen, VMware vMotion and others) copies a running VM's memory to another host while it keeps running, then briefly pauses the VM to copy the last dirty pages and switch over. The guest experiences a gap in time it never "saw".</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Low-pause collectors shrink the problem, not the rule",
          html: `<p>Since the book was written, low-pause garbage collection has gone mainstream: ZGC and Shenandoah ship as production collectors, and generational ZGC arrived in JDK 21. Languages without a tracing GC, such as Rust and C++, avoid GC pauses entirely. But VM migration, steal time, page faults and I/O stalls pause a process in any language, so the design rule stands: never assume nothing happened between your check and your action.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Your leader just had a 40-second GC pause. Walk me through it.\"",
          html: `<p>Interviewers use this to test whether you know that the paused node is the last to find out. A strong answer narrates both sides. The followers stop receiving heartbeats, their election timeout fires, and they elect a new leader in a higher term (or the old leader's lease expires and someone else acquires it). The old leader's thread is frozen mid-function the whole time. When it wakes, it finishes what it was doing: sending a replication message, serving a read from local state, writing to storage.</p>
<p>Then explain what contains the damage: followers reject messages carrying an old term, which tells the old leader it was replaced and makes it step down; external resources reject its writes because they carry a stale fencing token; and any read it served locally "under the lease" right after waking may have been stale. Close with the principle: the fix can't be "pause less", because no amount of tuning bounds a pause. Weak answers stop at "use a faster GC" or "check the lease right before writing".</p>`,
        },
        {
          type: "quiz",
          q: "A leader calls <code>lease.isValid()</code> immediately before every single write it sends. Is it now safe from acting after its lease has expired?",
          options: [
            "Yes, because the check happens on every write",
            "Yes, as long as the check uses the monotonic clock",
            "No: the thread can pause between the check and the send, and the message can sit in network queues, so the write can still arrive after expiry; the receiver has to reject it",
            "No, because leases can't be renewed while requests are in flight",
          ],
          answer: 2,
          explain: "Check-then-act is never atomic across a pause: the pause can fall between the check and the write, and the write can also be delayed in the network after it leaves. The monotonic clock (the tempting second option) removes the dependency on synchronized clocks, but not the gap. The robust fix is for the resource to check a fencing token, the subject of the section on leases, locks and fencing tokens.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 7
    {
      id: "truth-by-majority",
      title: "A node cannot trust its own judgment",
      kicker: "Knowledge and truth",
      concepts: ["truth-is-defined-by-the-majority", "network-partition"],
      blocks: [
        {
          type: "problem",
          html: `<p>Add up everything so far: the network can delay or drop any message, clocks drift and jump, and any process can freeze for an unknown time. A node therefore can't <em>know</em> anything about the rest of the system for certain. It can only guess from the messages it has, or hasn't, received. If every node acts on its own guess ("I haven't heard from the leader, so I'll lead"; "I still hold the lock"), the cluster ends up with two leaders, two lock holders, or two users with the same username.</p>
<p>Worse, a node can be wrong about <em>itself</em>. Picture a node whose outgoing messages are dropped while incoming ones still arrive: it is healthy and keeps receiving requests, but the others hear nothing from it, time out and declare it dead. Or a node frozen in a one-minute garbage-collection pause: the others declare it dead and hand its work to someone else, and then it wakes up and carries on as though nothing happened. In both cases the node's belief about its own status is wrong, and nothing it can observe locally proves that.</p>`,
        },
        {
          type: "idea",
          html: `<p>Decisions are made by a <strong>quorum</strong>, usually a strict majority of the nodes. Any two majorities share at least one node, so at most one of two conflicting decisions can win, and every node must defer to the quorum's verdict, even about itself.</p>`,
        },
        {
          type: "text",
          html: `<h3>Belief versus verdict</h3>
<p>Follow the half-connected node. Because nobody acknowledges its messages, it can work out that something is wrong with the network. That insight changes nothing: it has no channel through which to object, so the others declare it dead and move on, and its certainty that it is alive and well counts for nothing. The cluster's verdict is assembled from messages, and its messages never arrive.</p>
<p>The paused node is worse off, because it doesn't even get to notice. While it is frozen the others time out, conclude it has died and reassign its leadership or its locks. Then it resumes mid-function, its memory still saying "I am the leader", and starts acting on that.</p>
<p>The moral: whatever a node concludes about its own status is only a guess, however confident it feels. And the system can't simply defer to some special node instead, because any single node may fail at any moment and leave the system stuck. So distributed algorithms put the authority somewhere no single failure can take away: in a vote.</p>`,
        },
        {
          type: "analogy",
          title: "Back from leave",
          html: `<p>An employee returns from three months of leave convinced they still run the team. While they were away, the company reorganized and appointed someone else. What counts is the org chart that was decided by others in their absence, not their memory of how things were. They can't vote themselves back into the role, and if they start giving orders, the team should check the org chart, not their confidence.</p>`,
        },
        {
          type: "text",
          html: `<p>The sandbox below makes the rule tangible. Nodes sit in a ring with the leader marked <strong>L</strong>; tap a node to move it to another network island or crash it, or pick a scenario. Each island tries to act, and a board shows which island, if any, has enough votes to decide. The "Require a majority" switch lets you see what happens when every node trusts its own judgment instead.</p>`,
        },
        {
          type: "viz",
          id: "ch8/majority-partition",
          title: "Who gets to decide?",
          caption: "Try Clean split and press Client writes to every island: only the side with 3 of 5 votes accepts. Then turn off Require a majority, write again, and Heal network. Notice that with the rule on, at most one island can ever decide; with it off you get split brain, and healing throws away acknowledged writes. Also try the two datacenter presets and Even split, which uses 4 nodes. The Nodes control replays the current scenario at another cluster size.",
        },
        {
          type: "text",
          html: `<h3>Why a majority, exactly?</h3>
<p>A decision needs a minimum number of votes, the <strong>quorum</strong>. The usual choice is an absolute majority, <span class="mono">q&nbsp;=&nbsp;⌊n/2⌋&nbsp;+&nbsp;1</span>. The reason is overlap: two groups that each contain more than half of the nodes must share at least one member, so there can only be one majority at a time. If one majority elected leader A, any other group that could elect leader B must include someone who already voted for A, and that node won't vote twice. Two conflicting decisions can never both collect a quorum.</p>
<p>Majorities also tolerate failures. With <span class="mono">n&nbsp;=&nbsp;2f&nbsp;+&nbsp;1</span> nodes the system keeps deciding with up to <em>f</em> nodes crashed, paused or cut off: 3 nodes tolerate 1 failure, 5 tolerate 2. Crucially, <em>n</em> means every configured voting member, not the nodes that happen to be reachable. The majority of a 5-node cluster stays 3 when two nodes crash, which is exactly why the 3 survivors can carry on and 2 survivors cannot.</p>
<p>Even sizes buy nothing. A 4-node cluster needs 3 votes, so it tolerates one failure, the same as 3 nodes, and a clean 2|2 split leaves neither half able to decide. That outcome is safe (nobody makes a conflicting decision) but unavailable until the network heals.</p>`,
        },
        {
          type: "table",
          title: "Majority quorums by cluster size",
          headers: ["Cluster size n", "Majority needed", "Failures tolerated"],
          rows: [
            ["3", "2", "1"],
            ["4", "3", "1"],
            ["5", "3", "2"],
            ["6", "4", "2"],
            ["7", "4", "3"],
          ],
          note: "Adding a node to an odd-sized cluster raises the quorum without improving fault tolerance, which is why coordination clusters are almost always 3, 5 or 7 nodes.",
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Counting the majority over the nodes you can see",
          html: `<p>"I can reach 2 of the 3 nodes still up, so I have a majority" is how split brain gets built. Each side of a partition can see a majority of what it can see. The quorum must be computed over the full configured membership, and changing that membership is itself a decision that needs a quorum (Raft's membership-change procedure exists for exactly this reason).</p>`,
        },
        {
          type: "text",
          html: `<h3>Where uniqueness needs a vote</h3>
<p>Anything that must be unique system-wide needs quorum agreement, because a single node's belief proves nothing:</p>
<ul>
<li><strong>One leader per partition.</strong> Two leaders accepting writes is split brain (Chapter 5), and their histories diverge.</li>
<li><strong>One lock holder per resource.</strong> Two clients writing the same file concurrently corrupt it.</li>
<li><strong>One user per username.</strong> Two sign-ups that each succeeded on a different node can't both keep the name.</li>
</ul>
<p>A node that believes it is "the chosen one" may simply be the last to hear otherwise. Under the majority rule, the minority side of a partition must refuse to act, and that has a visible cost: its clients get errors or blocked requests until the network heals. This trade of availability for consistency during partitions is the substance of the <a href="#/ch9/learn/cost-of-linearizability">CAP debate in Chapter 9</a>, where consensus algorithms such as Raft, Paxos and Zab build their elections and commits on exactly these majorities.</p>
<p>Don't confuse this with the <a href="#/ch5/learn/leaderless-quorums">read and write quorums of leaderless replication</a> in Chapter 5 (<span class="mono">w&nbsp;+&nbsp;r&nbsp;&gt;&nbsp;n</span>). Those use overlap so that a read sees at least one fresh copy; here overlap guarantees that a <em>decision</em> is made at most once.</p>
<p>Majorities also dictate placement. Spread 5 voters over two datacenters (3 + 2) and the larger datacenter becomes a single point of failure: lose it and the 2 survivors can never reach 3. With three sites (2 + 2 + 1, or a lightweight tiebreaker in a third location) no site holds a majority, so losing any one still leaves a quorum.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "etcd and ZooKeeper",
              tag: "Odd sizes",
              html: `<p>etcd's documentation recommends odd cluster sizes, typically 3 or 5: a 5-member cluster tolerates 2 failures, and adding a 6th member raises the quorum to 4 without improving fault tolerance. ZooKeeper ensembles follow the same majority rule.</p>`,
            },
            {
              org: "MongoDB replica sets",
              tag: "Step down",
              html: `<p>A primary that can no longer see a majority of the voting members steps down to secondary, so a partitioned minority stops accepting writes, and only a side holding a majority can elect a new primary.</p>`,
            },
            {
              org: "Cloudflare",
              year: "2020",
              tag: "Partial partition",
              html: `<p>Cloudflare's write-up "A Byzantine failure in the real world" describes a top-of-rack switch that failed partially on November 2, 2020, leaving one of three etcd nodes able to reach one peer but not the other. Its repeated elections kept the Raft cluster from settling on a leader, and so from accepting writes, for several minutes. The database cluster manager that relies on etcd then promoted new primaries, and the follow-up replica rebuilds overloaded an authentication database, degrading the API and dashboard for 6 hours 33 minutes. The title uses "Byzantine" loosely, as the post's own postscript concedes: no node lied, but different nodes saw different truths.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "warning",
          title: "Majorities assume honest voters",
          html: `<p>A majority protects you against nodes that are crashed, slow, partitioned or simply confused about their own status. It does not protect you against a node that lies, for example by telling different peers different things or voting twice. Tolerating that takes a larger quorum and a different kind of protocol, as the section on Byzantine faults shows.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Where would you put the five nodes of your coordination cluster?\"",
          html: `<p>The trap is two datacenters. With a 3 + 2 split, losing the datacenter with 3 nodes takes the whole cluster down even though 2 healthy nodes remain, so that site is a single point of failure; losing the 2-node site is fine, which makes the design look robust in casual testing. A strong answer spreads voters across three failure domains (2 + 2 + 1, or a witness in a third region) so that no single site holds a majority, and mentions that cross-site latency now sits on every write's critical path.</p>
<p>Then describe what clients on the minority side see: writes fail or time out, and reads either fail or, if the system offers a relaxed option (such as etcd's "serializable" reads, which despite the name have nothing to do with serializable isolation), may return stale data. Good candidates say this is the intended behavior, not a bug: refusing to act is how the minority avoids creating a conflicting history.</p>`,
        },
        {
          type: "quiz",
          q: "A 4-node cluster splits 2 | 2, and the old leader is on the left side. With majority voting, what happens?",
          options: [
            "Both halves elect leaders and reconcile their writes later",
            "Neither half can collect 3 votes, so no writes are accepted until the partition heals: safe, but unavailable",
            "The half with the old leader carries on, since it already has a leader",
            "The half with the lower node IDs wins",
          ],
          answer: 1,
          explain: "The majority of 4 is 3, which neither side has, so neither can decide: safety is preserved and liveness is lost until the network heals. The third option is tempting, but the old leader can't confirm its leadership without a majority, and its own belief doesn't count. This is also why a 4-node cluster tolerates no more failures than a 3-node one.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 8
    {
      id: "fencing-tokens",
      title: "Leases, locks and fencing tokens",
      kicker: "Protecting resources",
      concepts: ["fencing-token", "lease"],
      blocks: [
        {
          type: "problem",
          html: `<p>A lock service hands out a lease so that only one client at a time writes a particular file in shared storage. Client 1 acquires the lease, then stalls in a long GC pause. Its lease expires, client 2 acquires the lease and writes the file, and then client 1 wakes up, still convinced its lease is valid (it checked just before the pause), and writes too. The file is now corrupted.</p>
<p>Nobody did anything wrong locally. The lock service enforced expiry, client 2 held a valid lease, and client 1 checked before writing; it simply can't know that its pause outlasted the lease. The book notes that HBase used to have exactly this bug. The obvious patches all rely on timing: shorter leases, checking the lease right before each write, waiting a while before re-granting. They fail for the same reason: a pause or network delay can always be longer than whatever margin you chose.</p>`,
        },
        {
          type: "idea",
          html: `<p>Make the resource itself reject stale holders. With every grant the lock service hands out a <strong>fencing token</strong>, a number that increases each time, and the storage refuses any write carrying a token lower than one it has already seen.</p>`,
        },
        {
          type: "text",
          html: `<p>The scenario below replays the story step by step on a 30-second timeline: C1 takes the lease with token 33 and freezes, its lease runs out, C2 takes over with token 34, and then C1 returns with a late write. Run it first with storage accepting everything, then let storage check tokens. The "Why C1 is late" control swaps the GC pause for a write stuck in a congested network queue.</p>`,
        },
        {
          type: "viz",
          id: "ch8/fencing-token",
          title: "Fencing off a zombie leaseholder",
          caption: "Try pressing Play with fencing off and watch step 8 corrupt the file; then switch on Storage checks fencing tokens and replay. Then set Why C1 is late to Slow network and drag the delay slider. Notice that the outcome depends only on whether storage checks the token, never on how long C1 was late or why.",
        },
        {
          type: "text",
          html: `<p>The lease alone failed because the decision "may I write?" was made by the client, from information that went stale while it wasn't looking. Fencing moves that decision to the one place that sees every write in order: the resource. Storage doesn't need to know why C1 is late, how long it slept, or what any clock says; it compares two integers. That is also why the slow-network run ends the same way. Checking the lease right before sending was useless there, because the delay happened after the check.</p>`,
        },
        {
          type: "steps",
          title: "The fencing protocol",
          items: [
            "The lock service increments a counter on every grant and returns the new value as the <strong>fencing token</strong> along with the lease (C1 gets 33; later C2 gets 34).",
            "The client attaches its token to every request it sends to the protected resource.",
            "The resource compares the request's token with the highest token it has seen so far.",
            "If the token is at least that high, the resource performs the write and records the token, as one atomic step; if it is lower, the resource rejects the request.",
            "A client whose write is rejected has learned that it lost the lease: it stops acting as the holder and must acquire a new lease, with a new token, before trying again.",
          ],
        },
        {
          type: "text",
          html: `<h3>What must be true for fencing to work</h3>
<ul>
<li><strong>Tokens strictly increase per grant</strong>, so "newer holder" and "larger token" mean the same thing.</li>
<li><strong>Every write carries the token.</strong> A write without one can't be judged.</li>
<li><strong>The resource remembers the highest token it has seen and rejects lower ones.</strong> An <em>equal</em> token is the current holder writing again and must be accepted; rejecting it would lock out the legitimate holder after its first write.</li>
<li><strong>Check and write are one atomic step.</strong> If storage checks the token and then writes in a separate step, two requests can interleave between them, and the check-then-act race reappears inside the storage. Use a conditional, compare-and-set write.</li>
</ul>`,
        },
        {
          type: "code",
          lang: "sql",
          title: "Fencing at the resource, as one conditional write",
          code: `-- New rows start with fence = 0.
UPDATE files
   SET data  = :data,
       fence = :token
 WHERE id    = :id
   AND fence <= :token;   -- equal is allowed: the holder may write many times

-- 1 row updated  -> accepted, and fence now records :token
-- 0 rows updated -> fenced off: a newer holder has already written.
--                   Stop acting as the holder and re-acquire the lease.`,
          caption: "The comparison and the update happen in a single statement, so no other write can slip in between them.",
        },
        {
          type: "text",
          html: `<p>One subtlety: tokens <em>order</em> writes; they don't block a zombie that gets there first. If C1's stale write reaches storage before C2 has sent anything, storage has only ever seen 33, so it accepts the write, and C2's first write supersedes it later. For blind overwrites that's harmless. But if C2 does a read-modify-write, the zombie can slip in between C2's read and its write, so a new holder should present its token first, for example with a conditional "claim" write that raises the fence to 34 before it reads.</p>
<h3>Where tokens come from</h3>
<p>The counter must itself be fault-tolerant and linearizable, which in practice means a consensus-backed coordination service. With ZooKeeper, the transaction ID (<code>zxid</code>) or the node version (<code>cversion</code>) works, since both are guaranteed to increase monotonically; in etcd, a key's revision plays the same role. Google's Chubby calls its version a <strong>sequencer</strong>. Raft's term numbers and Kafka's producer and controller epochs are fencing tokens by another name (Chapters 9 and 11).</p>
<p>The resource has to take an active part: a lock service alone can't stop zombie writes. A store without native support needs a workaround, such as a conditional write on a version field, or the token embedded in the object's name with readers taking the highest. Even if every client is your own code, a service shouldn't assume its clients behave, since they are often run by other teams with different priorities and different bugs.</p>
<p>Some side effects can't check anything: a sent email or a card charged through a third-party API can't reject token 33. Those need idempotency keys and end-to-end deduplication (Chapter 12).</p>
<p>Fencing guards against nodes acting <em>in error</em>, zombies that honestly don't know their lease expired. It does nothing against a node that lies, say by inventing token 9999; that is the next section's subject. The word comes from Chapter 5, where fencing meant isolating a suspect node at the infrastructure level: STONITH ("shoot the other node in the head", that is, power it off) or shared storage revoking its access. Tokens are the fine-grained version: they need no control over the other machine, only a resource that checks. The section on system models turns this token service's guarantees into a worked example of specifying an algorithm.</p>`,
        },
        {
          type: "compare",
          title: "What is the lock protecting?",
          items: [
            {
              title: "Efficiency lock",
              tone: "ok",
              html: `<p>Stops two workers from doing the same job, such as regenerating a report or sending a digest twice. If it occasionally fails, you pay with wasted work or a duplicate notification.</p><p><strong>A simple lease is fine.</strong> A single Redis key with a timeout is a reasonable choice.</p>`,
            },
            {
              title: "Correctness lock",
              tone: "warn",
              html: `<p>Stops concurrent writers from corrupting data or violating an invariant. If it fails, data is lost or corrupted, perhaps silently.</p><p><strong>Use a consensus-backed lock service</strong> (ZooKeeper, etcd) <strong>plus fencing at the resource.</strong> Lease timing alone is never enough.</p>`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Chubby",
              year: "2006",
              tag: "Sequencers",
              html: `<p>A Chubby lock holder can request a <em>sequencer</em> (the lock's name, its mode and a lock-generation number) and pass it to servers, which check it before acting. For servers that can't check sequencers, Chubby's <em>lock-delay</em> stops a lock whose holder failed from being re-granted immediately: a timing-based fallback, explicitly weaker.</p>`,
            },
            {
              org: "Apache Kafka",
              tag: "Epochs",
              html: `<p>A transactional producer whose epoch is older than the latest one registered for its <code>transactional.id</code> is rejected with <code>ProducerFencedException</code>, so a restarted instance fences off its zombie predecessor. Brokers likewise ignore requests from a controller with a stale controller epoch.</p>`,
            },
            {
              org: "Kubernetes client-go",
              tag: "No fencing",
              html: `<p>The <code>leaderelection</code> package used by many Kubernetes controllers states in its documentation that it does not guarantee only one client acts as leader: there is no fencing, and each client judges the lease purely by timing measured on its own clock. Controllers built on it must tolerate brief overlap.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "history",
          title: "The 2016 Redlock debate",
          html: `<p>In February 2016 Martin Kleppmann, the book's author, published "How to do distributed locking", arguing that Redlock (which takes a lock on a majority of independent Redis instances) is unsafe as a correctness lock: it produces no fencing token, and its safety depends on bounded network delay, bounded pauses and bounded clock error. Salvatore Sanfilippo (antirez), the author of Redis, replied in "Is Redlock safe?", arguing that those timing assumptions are reasonable in practice and that Redlock needs clocks to run at roughly the same rate, not to be synchronized. The lesson isn't who won; both posts are an argument about which system model is realistic, which is exactly what the section on system models examines.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Fencing tokens",
          pros: [
            "Safe under arbitrarily long pauses and network delays: there is no margin to tune",
            "No clock assumptions at the resource; it compares integers",
            "Cheap: one integer per resource and one conditional write",
            "A rejected client learns it lost the lease and can stop cleanly",
          ],
          cons: [
            "Every protected resource must participate, and must check atomically",
            "External side effects (emails, payments, third-party APIs) can't be fenced",
            "The token source must itself be fault-tolerant and linearizable, which usually means running a consensus service",
            "Doesn't stop a node that forges tokens, or a zombie write that lands before the new holder's first request",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Can't we just use Redis SET NX PX as a lock?\"",
          html: `<p><code>SET lock:report &lt;random-id&gt; NX PX 30000</code> creates the key only if it doesn't exist and expires it after 30 seconds. A strong answer starts by asking what happens if two clients hold it at once. If the answer is "a job runs twice", it's a fine efficiency lock, provided you release it safely: delete the key only if it still holds your random value, atomically (typically with a Lua script), so you never release someone else's lock.</p>
<p>If the answer is "data gets corrupted", name the two failure paths: a holder paused or delayed past the 30 seconds, exactly as in the scenario above, and, with replicated Redis, a failover that loses the key because replication is asynchronous. Neither is fixable with timing. The fix is a consensus-backed lock service (etcd, ZooKeeper), a monotonically increasing token from it, and a resource that checks the token atomically, or redesigning the write as a conditional or idempotent operation that needs no lock at all.</p>`,
        },
        {
          type: "quiz",
          q: "Your lock service issues fencing tokens, but the data lands in a third-party blob store that ignores them. What actually protects you from a zombie writer?",
          options: [
            "The tokens themselves: they are unique and increasing",
            "Nothing, until the store participates: for example a conditional write on a version field, or the token embedded in the object name with readers taking the highest",
            "A short lease timeout",
            "Checking the lease immediately before each write",
          ],
          answer: 1,
          explain: "A fencing token protects you only if the resource compares it, atomically, with what it has already seen; tokens that nobody checks are just numbers, which is why the first option is tempting but wrong. Short leases and last-moment checks are timing arguments, and a pause or network delay can always be longer.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 9
    {
      id: "byzantine-faults",
      title: "When nodes lie: Byzantine faults",
      kicker: "Trust",
      concepts: ["byzantine-fault", "weak-lying"],
      blocks: [
        {
          type: "problem",
          html: `<p>Fencing tokens assume nodes are honest but possibly mistaken. A node that wanted to subvert the system could simply attach a fake, enormous token, and the storage would then reject every honest writer. More generally, a faulty node might tell different peers different things, claim to have stored data it never wrote, or, because of a hardware fault, return corrupted results while believing them correct.</p>
<p>Majority voting doesn't help either. The overlap argument from the section on majorities assumes each node casts one consistent vote; a node that tells half the cluster "yes" and the other half "no" can help two conflicting majorities form. "Every node follows the protocol" is a reasonable assumption inside one company's datacenter. It fails for flight computers exposed to radiation, and among organizations with no reason to trust each other.</p>`,
        },
        {
          type: "idea",
          html: `<p>Tolerating nodes that lie takes a supermajority (<span class="mono">n&nbsp;≥&nbsp;3f&nbsp;+&nbsp;1</span>, so more than two-thirds honest) and many more messages. Inside a datacenter, systems assume honest nodes and catch "weak lying" with checksums, validation and outlier rejection instead.</p>`,
        },
        {
          type: "text",
          html: `<h3>Arbitrary failure</h3>
<p>A <strong>Byzantine fault</strong> is a node behaving arbitrarily: sending corrupted or contradictory messages, lying about its state, or acting maliciously. A system is <strong>Byzantine fault-tolerant</strong> (BFT) if it keeps operating correctly even when some nodes malfunction or ignore the protocol, or when attackers interfere.</p>
<p>The name comes from the <em>Byzantine Generals Problem</em> (Lamport, Shostak and Pease, 1982), which generalizes the Two Generals Problem from the section on unreliable networks. There, honest generals struggle to agree because messengers get lost. Here, messages arrive, but some generals are traitors. A commander sends an order ("attack" or "retreat") to lieutenants, who relay to each other what they heard. Every loyal lieutenant must end up with the same plan, and if the commander is loyal, that plan must be the commander's order. The smallest cases show why lying is so expensive to tolerate.</p>`,
        },
        {
          type: "diagram",
          title: "Why three generals aren't enough",
          svg: `<svg viewBox="0 0 640 290" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: with three generals and a traitorous commander, lieutenant L1 cannot tell who is lying. Right: with four generals and one traitorous lieutenant, L1 takes the majority of three reports and attacks.">
<defs>
<marker id="ch8d2-byz-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
<marker id="ch8d2-byz-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
</defs>
<line x1="320" y1="10" x2="320" y2="282" stroke-dasharray="4 4" style="stroke: var(--viz-line)"/>
<text x="160" y="22" text-anchor="middle" font-size="13" font-weight="700">n = 3: the commander lies</text>
<path d="M145,78 L86,135" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch8d2-byz-arr)"/>
<path d="M175,78 L234,135" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#ch8d2-byz-bad)"/>
<path d="M228,150 L94,150" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch8d2-byz-arr)"/>
<circle cx="160" cy="64" r="20" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="160" y="69" text-anchor="middle" font-size="13" font-weight="700">C</text>
<text x="188" y="50" font-size="12" style="fill: var(--viz-bad)">traitor</text>
<circle cx="70" cy="150" r="20" stroke-width="1.6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="70" y="155" text-anchor="middle" font-size="13" font-weight="700">L1</text>
<circle cx="250" cy="150" r="20" stroke-width="1.6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="250" y="155" text-anchor="middle" font-size="13" font-weight="700">L2</text>
<text x="114" y="100" text-anchor="end" font-size="12">attack</text>
<text x="206" y="100" font-size="12" style="fill: var(--viz-bad)">retreat</text>
<text x="160" y="141" text-anchor="middle" font-size="12">"C said retreat"</text>
<rect x="20" y="208" width="280" height="48" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="160" y="228" text-anchor="middle" font-size="12">L1 hears: attack (from C)</text>
<text x="160" y="246" text-anchor="middle" font-size="12">and "C said retreat" (from L2)</text>
<text x="160" y="276" text-anchor="middle" font-size="12" font-weight="700">Same view if L2 were the liar: stuck</text>
<text x="480" y="22" text-anchor="middle" font-size="13" font-weight="700">n = 4: one lieutenant lies</text>
<path d="M465,77 L397,136" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch8d2-byz-arr)"/>
<path d="M480,84 L480,128" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch8d2-byz-arr)"/>
<path d="M495,77 L563,136" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch8d2-byz-arr)"/>
<path d="M458,150 L402,150" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch8d2-byz-arr)"/>
<path d="M566,166 Q480,214 394,166" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#ch8d2-byz-bad)"/>
<circle cx="480" cy="64" r="20" stroke-width="1.6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="480" y="69" text-anchor="middle" font-size="13" font-weight="700">C</text>
<text x="506" y="50" font-size="12">attack, to all</text>
<circle cx="380" cy="150" r="20" stroke-width="1.6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="380" y="155" text-anchor="middle" font-size="13" font-weight="700">L1</text>
<circle cx="480" cy="150" r="20" stroke-width="1.6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="480" y="155" text-anchor="middle" font-size="13" font-weight="700">L2</text>
<circle cx="580" cy="150" r="20" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="580" y="155" text-anchor="middle" font-size="13" font-weight="700">L3</text>
<text x="580" y="120" text-anchor="middle" font-size="12" style="fill: var(--viz-bad)">traitor</text>
<text x="430" y="141" text-anchor="middle" font-size="12">attack</text>
<text x="480" y="185" text-anchor="middle" font-size="12" class="viz-halo" style="fill: var(--viz-bad)">retreat</text>
<rect x="340" y="208" width="280" height="48" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="480" y="228" text-anchor="middle" font-size="12">L1 hears: attack, attack, retreat</text>
<text x="480" y="246" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-ok)">majority: attack</text>
<text x="480" y="276" text-anchor="middle" font-size="12" font-weight="700">Honest relays outvote the liar</text>
</svg>`,
          caption: "Only the messages that reach L1 are drawn. Left: if C were loyal (attack to both) and L2 lied about it, L1 would see exactly the same thing, so it can't decide safely. Right: with 4 generals each loyal lieutenant takes the majority of three reports; if C were the traitor instead, the loyal lieutenants would relay honestly, see the same three values, and still agree.",
        },
        {
          type: "text",
          html: `<h3>Why 3f + 1</h3>
<p>Follow L1 on the left. It hears "attack" from C and a report from L2 that C said "retreat". That fits two different worlds: either C is the traitor, or C loyally ordered "attack" and L2 is lying. In the second world L1 must attack, because loyal lieutenants obey a loyal commander, and since L1 can't tell the worlds apart, it must attack in the first world too. By the same reasoning L2, which heard "retreat", must retreat. Two loyal lieutenants now disagree. With unsigned ("oral") messages, no algorithm avoids this for three generals and one traitor.</p>
<p>In general more than two-thirds of the participants must be honest: <span class="mono">n&nbsp;≥&nbsp;3f&nbsp;+&nbsp;1</span>, so 4 nodes tolerate 1 liar and 7 tolerate 2. Crash faults need only a simple majority, <span class="mono">n&nbsp;≥&nbsp;2f&nbsp;+&nbsp;1</span>. The extra margin exists because a liar can show different faces to different peers, so two quorums must overlap in at least one <em>honest</em> node, not merely in some node. Unforgeable signatures change the math in the paper's idealized model, but practical BFT protocols for real networks, where messages can also be delayed, still need 3f + 1 replicas.</p>`,
        },
        {
          type: "table",
          title: "Who might lie, and what people do about it",
          headers: ["Setting", "Who might lie?", "Typical approach"],
          rows: [
            ["Your own datacenter", "Nobody on purpose; hardware, occasionally", "Crash-fault-tolerant protocols, plus checksums and validation"],
            ["Web app with browser clients", "The clients", "The server is the authority: validate and sanitize all input"],
            ["Aerospace", "Hardware corrupted by radiation", "Redundant computers that vote, plus independently written software"],
            ["Blockchain or multi-organization ledger", "Other participants", "BFT consensus, or proof of work / proof of stake"],
          ],
        },
        {
          type: "text",
          html: `<h3>Why your datacenter doesn't run BFT</h3>
<p>BFT protocols matter where the stakes or the distrust are high. In aerospace, radiation can flip bits in memory or CPU registers, and a flight control system must keep working regardless; building for that is very expensive. Peer-to-peer networks and blockchains such as Bitcoin let mutually untrusting participants agree on whether a transaction happened without any central authority.</p>
<p>Most server-side data systems use none of this. Their nodes are all run by one organization and can reasonably be trusted not to lie on purpose; radiation on the ground is low enough that memory corruption is rare (rare, not absent, as the cards below show); and BFT protocols are complicated and costly. They need more replicas for the same fault tolerance and far more messages: PBFT, for example, has every replica exchange messages with every other, O(n²) per decision.</p>
<p>Web applications show the usual compromise. Browsers are untrusted and may send anything, but the server is the authority: it validates and sanitizes whatever clients send and decides what is allowed. No BFT protocol is needed, because nobody asks the clients to vote.</p>
<h3>Weak lying, cheap defenses</h3>
<p>Even among honest nodes it pays to guard against <strong>weak forms of lying</strong>, where hardware or software corrupts data without malice:</p>
<ul>
<li><strong>Corrupted packets.</strong> Hardware faults and bugs in drivers, routers or operating systems occasionally corrupt packets in ways that slip past the weak TCP and UDP checksums. Application-level checksums (CRC32C, SHA-256) catch them.</li>
<li><strong>Bad input.</strong> A public-facing service must sanitize every input: check that values are in range and well formed, and cap string and message sizes so one malformed request can't exhaust memory.</li>
<li><strong>Outliers.</strong> NTP clients query several servers, estimate each one's error, check that a majority agree on some time range, and discard the outliers as faulty: a tiny, cheap form of Byzantine tolerance.</li>
</ul>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "NASA Space Shuttle",
              tag: "Design diversity",
              html: `<p>The Shuttle flew four computers running identical primary flight software that cross-checked each other by voting, which catches hardware faults, plus a fifth running independently developed Backup Flight System software, because voting among identical copies can't catch a bug they all share.</p>`,
            },
            {
              org: "Amazon S3",
              year: "2008",
              tag: "One flipped bit",
              html: `<p>On July 20, 2008, a few internal gossip messages carrying server state had a single bit corrupted, yet remained parseable. The bad state spread through the system and caused a multi-hour outage. Amazon's postmortem described adding checksums to those messages.</p>`,
            },
            {
              org: "Google and Meta",
              year: "2021",
              tag: "Silent data corruption",
              html: `<p>Google's "Cores that don't count" (HotOS 2021) and Meta's "Silent Data Corruptions at Scale" (2021) reported CPUs that occasionally compute wrong results without any error signal: a hardware form of lying that only end-to-end checks catch.</p>`,
            },
            {
              org: "Bitcoin",
              year: "2009",
              tag: "Proof of work",
              html: `<p>Bitcoin doesn't count votes, since anyone can create identities. Participants accept the chain with the most accumulated proof of work, so rewriting history requires out-computing the honest majority of computing power rather than outvoting a fixed set of nodes.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"BFT will protect us from bugs and attackers\"",
          html: `<p>If every node runs the same code, a software bug makes all of them "lie" the same way, and a protocol built to outvote <em>f</em> traitors is helpless when all <em>n</em> agree on the wrong answer. Surviving bugs would take independently written implementations, which almost nobody can afford. Likewise, an attacker who can compromise one node can probably compromise them all, since they run the same software. Authentication, access control, encryption and firewalls remain the main defense against attackers.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Hardware lies more than we thought; BFT moved to blockchains",
          html: `<p>At hyperscale, "radiation is low, so memory corruption isn't an issue" turned out to be incomplete: the 2021 studies of silent data corruption found faulty CPU cores that return wrong answers without errors, and the practical response has been end-to-end checksums, fleet-wide screening and verification rather than BFT. Meanwhile BFT research found its main customer in blockchains: protocols such as HotStuff (2019) cut the message cost of each decision from PBFT's quadratic to linear in the number of replicas, and Ethereum moved from proof of work to proof of stake in 2022.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"When would you design for Byzantine faults?\"",
          html: `<p>Start with the trust boundary. Inside one organization's datacenter the answer is almost always "we don't": use crash-fault-tolerant consensus (Raft, Paxos), checksums at every layer, authenticated and encrypted connections, and input validation. BFT earns its 3f + 1 replicas and extra messages when participants genuinely don't trust each other, as in a consortium of banks sharing a ledger or a public blockchain, or when hardware faults are expected, as in avionics.</p>
<p>A strong answer adds two caveats: BFT doesn't defend against a bug in code that every replica runs, and if what you really need is auditability rather than agreement, a tamper-evident, Merkle-tree-based log (as in Certificate Transparency) is often a cheaper fit. Weak answers reach for BFT whenever the word "security" comes up.</p>`,
        },
        {
          type: "quiz",
          q: "You run a 7-node cluster. How many arbitrarily faulty (Byzantine) nodes can a BFT protocol tolerate, and how many crashed nodes can a majority-based crash-fault-tolerant protocol tolerate?",
          options: [
            "3 Byzantine and 3 crashed",
            "2 Byzantine and 3 crashed",
            "3 Byzantine and 2 crashed",
            "1 Byzantine and 3 crashed",
          ],
          answer: 1,
          explain: "Byzantine agreement needs n ≥ 3f + 1, so 7 nodes tolerate f = 2 liars; crash tolerance with majorities needs n ≥ 2f + 1, so 7 nodes tolerate 3 crashes. The tempting answer is 3 and 3, which treats a liar like a crash; but a faulty node can tell different peers different things, so honest nodes need a larger overlap to outvote it.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 10
    {
      id: "system-models",
      title: "System models: writing down what can go wrong",
      kicker: "Theory meets practice",
      concepts: ["synchronous-vs-partially-synchronous-vs-asynchronous-models", "crash-stop-vs-crash-recovery-vs-byzantine", "system-model-safety-liveness"],
      blocks: [
        {
          type: "problem",
          html: `<p>Go back to the Redlock debate from the fencing section: two experienced engineers analyzed the same lock algorithm and reached opposite verdicts. Neither was careless; they started from different assumptions. Redlock is correct if network delays, process pauses and clock errors stay within known bounds, and it can fail if they occasionally don't. Kleppmann's point was that relying on those bounds amounts to assuming a synchronous system; Sanfilippo's rebuttal held that the bounds are reasonable for real deployments.</p>
<p>Every claim that "this algorithm is correct" carries a hidden "assuming that…". An algorithm proven correct with synchronized clocks breaks the first time NTP steps a clock; one that assumes nothing about timing can't even use a timeout. Testing only the happy path proves little, because the dangerous cases (a pause at exactly the wrong moment, a partial partition) are rare. You have to write down which faults the algorithm must tolerate and precisely what "correct" means, and then still test the implementation, because reality can break the model.</p>`,
        },
        {
          type: "idea",
          html: `<p>A <strong>system model</strong> states what an algorithm may assume about timing and faults. Pick a realistic one (usually partial synchrony with crash-recovery nodes) and design algorithms that never violate <em>safety</em> in any situation the model allows, while promising <em>liveness</em> only when the system behaves well enough.</p>`,
        },
        {
          type: "text",
          html: `<h3>Three ways to model time</h3>
<ul>
<li><strong>Synchronous.</strong> Network delay, process pauses and clock error all have known upper bounds. The bounds needn't be zero, only known. This is unrealistic for most practical systems because, as the earlier sections showed, delays and pauses are unbounded.</li>
<li><strong>Partially synchronous.</strong> Delays, pauses and clock error usually stay within bounds, but now and then they blow past them by an arbitrary amount, for an unknown length of time. This is the realistic model: networks and processes usually behave, and the algorithm must survive the times they don't.</li>
<li><strong>Asynchronous.</strong> No timing assumptions at all, not even a clock, so no timeouts. A few algorithms work under it, but it rules out a great deal.</li>
</ul>
<p>Don't confuse the synchronous <em>system model</em> with the synchronous <em>networks</em> of circuit-switched telephony from the section on timeouts and delays. A circuit is real infrastructure with bounded delay; the model is a set of assumptions an algorithm makes. A packet-switched datacenter has no circuit to back those assumptions up.</p>
<h3>Three ways to model failure</h3>
<ul>
<li><strong>Crash-stop.</strong> A node fails only by crashing: it stops responding and never comes back.</li>
<li><strong>Crash-recovery.</strong> Nodes may crash and restart after some unknown time. Data on stable storage survives; in-memory state is lost.</li>
<li><strong>Byzantine.</strong> Nodes may do anything, including lie, as in the previous section.</li>
</ul>
<p>For real datacenter systems, the most useful combination is partial synchrony with crash-recovery faults. It is what Raft, Paxos and ZooKeeper's Zab assume.</p>`,
        },
        {
          type: "diagram",
          title: "Choosing a system model",
          svg: `<svg viewBox="0 0 640 292" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A three by three grid of timing models against failure models. The synchronous column is unrealistic; the asynchronous column allows no timeouts; crash-recovery with partial synchrony is highlighted as what most real systems assume; Byzantine with partial synchrony holds BFT protocols.">
<text x="216" y="30" text-anchor="middle" font-size="13" font-weight="700">Synchronous</text>
<text x="216" y="48" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">bounded delays</text>
<text x="382" y="30" text-anchor="middle" font-size="13" font-weight="700">Partially synchronous</text>
<text x="382" y="48" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">usually bounded</text>
<text x="548" y="30" text-anchor="middle" font-size="13" font-weight="700">Asynchronous</text>
<text x="548" y="48" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">no timing at all</text>
<text x="8" y="94" font-size="13" font-weight="700">Crash-stop</text>
<text x="8" y="111" font-size="12" style="fill: var(--viz-muted)">never returns</text>
<text x="8" y="162" font-size="13" font-weight="700">Crash-recovery</text>
<text x="8" y="179" font-size="12" style="fill: var(--viz-muted)">restarts later</text>
<text x="8" y="230" font-size="13" font-weight="700">Byzantine</text>
<text x="8" y="247" font-size="12" style="fill: var(--viz-muted)">may lie</text>
<rect x="136" y="64" width="160" height="198" rx="8" style="fill: var(--viz-grid); stroke: var(--viz-line)"/>
<text x="216" y="140" text-anchor="middle" font-size="12">Unrealistic for</text>
<text x="216" y="157" text-anchor="middle" font-size="12">datacenter networks:</text>
<text x="216" y="174" text-anchor="middle" font-size="12">delays and pauses</text>
<text x="216" y="191" text-anchor="middle" font-size="12">are unbounded</text>
<rect x="302" y="64" width="160" height="62" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="382" y="91" text-anchor="middle" font-size="12">Simpler proofs, but</text>
<text x="382" y="108" text-anchor="middle" font-size="12">real nodes restart</text>
<rect x="302" y="132" width="160" height="62" rx="8" stroke-width="2.5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="382" y="152" text-anchor="middle" font-size="12" font-weight="700">Most real systems</text>
<text x="382" y="169" text-anchor="middle" font-size="12">Raft, Paxos,</text>
<text x="382" y="186" text-anchor="middle" font-size="12">ZooKeeper, etcd</text>
<rect x="302" y="200" width="160" height="62" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="382" y="226" text-anchor="middle" font-size="12" font-weight="700">BFT protocols</text>
<text x="382" y="243" text-anchor="middle" font-size="12">PBFT, HotStuff</text>
<rect x="468" y="64" width="160" height="198" rx="8" stroke-dasharray="5 4" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="548" y="122" text-anchor="middle" font-size="12">No clock, so</text>
<text x="548" y="139" text-anchor="middle" font-size="12">no timeouts.</text>
<text x="548" y="164" text-anchor="middle" font-size="12">FLP: deterministic</text>
<text x="548" y="181" text-anchor="middle" font-size="12">consensus can't</text>
<text x="548" y="198" text-anchor="middle" font-size="12">guarantee progress</text>
<text x="548" y="215" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">(Chapter 9)</text>
<text x="382" y="284" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">Green: the realistic default for datacenter systems</text>
</svg>`,
          caption: "Timing assumptions across, failure assumptions down. Moving right or down assumes less, so algorithms get harder and costlier. Most practical systems sit in the green cell: they tolerate crashes and restarts, and they rely on timeouts only for progress, never for correctness.",
        },
        {
          type: "text",
          html: `<h3>Writing down what "correct" means</h3>
<p>Correctness is defined by <strong>properties</strong>. For the fencing-token service from the section on leases, locks and fencing tokens, we might require:</p>
<ul>
<li><strong>Uniqueness:</strong> no two token requests return the same value.</li>
<li><strong>Monotonic sequence:</strong> if request <em>x</em> returned token t<sub>x</sub>, request <em>y</em> returned t<sub>y</sub>, and <em>x</em> completed before <em>y</em> began, then t<sub>x</sub> &lt; t<sub>y</sub>.</li>
<li><strong>Availability:</strong> a node that requests a token and doesn't crash eventually receives a response.</li>
</ul>
<p>An algorithm is correct in a system model if it satisfies its properties in <em>every</em> situation the model allows, not just in the runs we happened to test.</p>
<p>Uniqueness and monotonic sequence are <strong>safety</strong> properties: nothing bad happens. Availability is a <strong>liveness</strong> property: something good eventually happens, and liveness properties often contain the word "eventually". The precise distinction is this: if a safety property is violated, you can point at the moment it broke (here is the duplicate token), and the violation can't be undone. A liveness property may not hold at a given moment, say while a request is still waiting, but there is always hope that it will be satisfied later.</p>`,
        },
        {
          type: "table",
          title: "Safety or liveness?",
          headers: ["Property", "Kind, and why"],
          rows: [
            ["Tokens are unique", "<strong>Safety</strong>: a duplicate can be pointed at in the history, and it can't be undone"],
            ["Tokens increase monotonically", "<strong>Safety</strong>: one out-of-order token is a permanent violation"],
            ["A requester that doesn't crash eventually gets a token", "<strong>Liveness</strong>: unmet right now isn't violated, because it can still happen later"],
            ["Replicas eventually converge (eventual consistency)", "<strong>Liveness</strong>: promises convergence someday, with no deadline"],
            ["No two leaders in the same term", "<strong>Safety</strong>: split brain is damage that can't be taken back"],
            ["Every client write is eventually acknowledged", "<strong>Liveness</strong>: a statement about progress"],
          ],
          note: "Quick test: if a single finite stretch of a trace can show the property broken, beyond repair by anything that happens later, it is safety.",
        },
        {
          type: "callout",
          tone: "insight",
          title: "Eventual consistency is a liveness property",
          html: `<p>"Replicas eventually converge" promises that something good will happen, someday. By itself it says nothing about what you may read in the meantime (stale values, values that go backward) or how long "eventually" lasts. That's why Chapter 5 layers guarantees such as read-your-writes and monotonic reads on top of it: they constrain what can be observed at every moment, which a liveness promise alone never does.</p>`,
        },
        {
          type: "text",
          html: `<h3>Safety always, liveness when possible</h3>
<p>Distributed algorithms normally must keep their safety properties in every situation the model allows, even if every node crashes or the whole network fails. Liveness may come with conditions, such as "only while a majority of nodes are up and the network has recovered". Partial synchrony is built for this split: its definition promises that the system eventually returns to synchronous behavior for long enough, and that is when liveness is guaranteed. An algorithm may stall during a partition, but it must not lie.</p>
<h3>When reality leaves the model</h3>
<p>Models are simplifications, and reality violates them. The crash-recovery model assumes stable storage survives a crash, but disks get corrupted, hardware errors or misconfiguration wipe data, and firmware bugs can make a drive vanish after a reboot. A node that forgets data it acknowledged (amnesia) breaks the quorum overlap argument, because the node in the overlap no longer remembers its vote. So real implementations need code for the "impossible" case, even if all it does is log loudly and stop for a human to sort out. Halting beats silently breaking safety.</p>
<p>That's why theory and testing are both needed. Proofs show an algorithm is correct within its model and expose problems hiding in rare interleavings that no test would hit. Empirical testing (fault injection, Jepsen-style partition testing, deterministic simulation, model checking with TLA+) finds bugs in implementations and mismatches between model and reality. Chapter 9 builds on this vocabulary: the FLP result shows that in the asynchronous model no deterministic consensus algorithm can guarantee termination if even one node may crash, which is why practical consensus protocols rely on partial synchrony, and timeouts, to make progress.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Amazon Web Services",
              year: "2015",
              tag: "TLA+",
              html: `<p>AWS engineers have used TLA+ since 2011 to specify and model-check designs of systems including S3, DynamoDB and EBS. Newcombe et al. (CACM 2015) report subtle bugs found this way, including a DynamoDB replication bug whose shortest error trace took 35 steps, far beyond what ordinary testing would explore.</p>`,
            },
            {
              org: "Raft",
              year: "2014",
              tag: "Safety vs timing",
              html: `<p>The Raft paper makes it an explicit requirement that safety must not depend on timing. Timing, an election timeout well above the time to broadcast a message, affects only availability: the safety-always, liveness-when-the-network-behaves design in one sentence.</p>`,
            },
            {
              org: "FoundationDB",
              tag: "Deterministic simulation",
              html: `<p>FoundationDB was built around deterministic simulation: the whole cluster runs in a single process with simulated networks, disks and clocks while faults are injected, so engineers can replay a rare interleaving exactly and debug it.</p>`,
            },
            {
              org: "FAST 2017 study",
              tag: "Model vs reality",
              html: `<p>In "Redundancy Does Not Imply Fault Tolerance", Ganesan et al. injected a single file-system fault (a corrupted or unreadable block) on one node and found that it could lead to data loss, corruption or unavailability in widely used systems, including ZooKeeper, Kafka, Cassandra, MongoDB and Redis: crash-recovery's "stable storage survives" assumption breaking in practice.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Testing the gap between model and reality",
          html: `<p>Since the book was written, the testing half of the story has matured. Many database vendors have commissioned Jepsen analyses, and its open-source tooling is widely used in-house. Deterministic simulation testing, pioneered at FoundationDB, is used by newer systems such as TigerBeetle and sold as a service by Antithesis. TLA+ has moved from research into everyday design reviews, with the TLA+ Foundation formed in 2023 to steward the language.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Is this a safety or a liveness property?\"",
          html: `<p>Expect to classify on the spot: "no two leaders in the same term" (safety), "every request eventually gets a response" (liveness), "a committed write is never lost" (safety), "replicas eventually converge" (liveness). The quick test: if you can point at one bad moment in a trace that no future can repair, it's safety.</p>
<p>The usual follow-up: "Your consensus cluster stopped accepting writes during a partition. Is it broken?" A strong answer says no: it gave up liveness to keep safety, exactly as designed for partial synchrony, and it will resume once a majority can communicate again. It would be broken if both sides had kept accepting writes. Bonus points for naming the model you'd assume (partially synchronous, crash-recovery) and for noting that disk amnesia or clock jumps beyond the assumed bounds fall outside it, so they need detection and alarms, not just proofs.</p>`,
        },
        {
          type: "quiz",
          q: "During a network partition, an algorithm stops answering requests. When the partition heals it resumes, and it never returned a wrong result. Which properties did it maintain?",
          options: [
            "Both safety and liveness, throughout",
            "Safety throughout; liveness was suspended during the partition and restored afterwards, which is acceptable for an algorithm designed for partial synchrony",
            "Liveness but not safety",
            "Neither, because it stopped responding",
          ],
          answer: 1,
          explain: "Never returning a wrong result is safety, which must hold in every situation. Making progress is liveness, which practical algorithms promise only when the network behaves (partial synchrony). Stalling is allowed; lying is not. The first option is tempting because nothing went wrong, but the algorithm made no progress during the partition, so liveness was not maintained throughout; the last option confuses not responding with responding wrongly.",
        },
      ],
    },
  ],

  takeaways: [
    "<strong>Partial failure</strong> is what makes distributed systems different: some parts break while others work, nondeterministically, and you often can't tell which.",
    "A missing reply means <em>unknown</em>, not <em>failed</em>: the request, the node or the reply may be at fault, and the work may have been done anyway, so retries must be safe to repeat.",
    "Network delay is unbounded because packet networks and shared machines queue work to achieve high utilization. Timeouts are bets, best chosen from measured delay distributions or adaptively, and false positives can cascade.",
    "Use <strong>monotonic clocks</strong> for durations and treat wall-clock timestamps as approximate. Ordering events across nodes by wall-clock time silently loses data unless the uncertainty is bounded and waited out (TrueTime and commit wait).",
    "Any process can freeze for seconds at any line of code, so \"I checked, therefore it's still true\" is never safe in a distributed system.",
    "A node can't trust its own judgment: decisions belong to a <strong>majority quorum</strong>, and resources must reject stale actors with <strong>fencing tokens</strong>.",
    "Most datacenter systems assume crash-recovery faults, partial synchrony and honest nodes. Tolerating lying (Byzantine) nodes needs n ≥ 3f + 1 and is rarely worth it inside one organization.",
    "Correct algorithms guarantee <strong>safety</strong> always and <strong>liveness</strong> only when conditions allow. Proofs cover the model; fault-injection testing covers the reality the model misses.",
  ],

  connections: [
    {
      to: "ch1",
      html: "Faults versus failures and the meaning of reliability start in Chapter 1. Timeouts should be chosen from the latency percentiles introduced there, and tail latency explains why rare slowness is common at scale.",
    },
    {
      to: "ch4",
      html: "Chapter 4's warning that a remote call is not a local one (lost requests, timeouts with unknown outcomes, retries that do the work twice, variable latency) is where this chapter's unreliable networks begin; idempotent requests are the practical answer to an unknown outcome.",
    },
    {
      to: "ch5",
      html: "Failover and split brain (Chapter 5) are where unreliable failure detection does real damage. Last-write-wins conflict resolution is exactly where clock skew silently drops writes, and version vectors and CRDTs are the causality-based alternative. Read/write quorums (w + r &gt; n) use overlap for freshness, a different job from the majority decisions in this chapter.",
    },
    {
      to: "ch6",
      html: "A network partition has nothing to do with Chapter 6's data partitioning, but the two meet in rebalancing: a timeout that mistakes a slow node for a dead one can start partition moves that overload the survivors.",
    },
    {
      to: "ch7",
      html: "Snapshot isolation needs monotonically increasing transaction IDs; generating them across partitions is what motivates Spanner's TrueTime timestamps and commit wait.",
    },
    {
      to: "ch9",
      html: "This chapter's problems motivate Chapter 9: linearizability; consensus (Raft, Paxos, Zab) built on majority quorums under partial synchrony; leader election with terms acting as fencing tokens; Lamport timestamps as logical clocks; coordination services like ZooKeeper and etcd for locks and tokens; and the FLP impossibility result.",
    },
    {
      to: "ch11",
      html: "Kafka's producer and controller epochs are fencing tokens that stop \"zombie\" instances, which is part of what makes exactly-once stream processing safe across restarts.",
    },
    {
      to: "ch12",
      html: "Because a timeout leaves the outcome unknown, retries must be idempotent, using request IDs and end-to-end deduplication; the end-to-end argument explains why TCP-level guarantees aren't enough.",
    },
  ],

  furtherReading: [
    {
      title: "The Network is Reliable (Bailis & Kingsbury, ACM Queue, 2014)",
      note: "A catalog of real network partitions and their consequences: the empirical backbone of the section on unreliable networks.",
    },
    {
      title: "How to do distributed locking (Martin Kleppmann, 2016)",
      url: "https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html",
      note: "Fencing tokens, efficiency versus correctness locks, and the Redlock critique, by the book's author. Read it together with antirez's reply below.",
    },
    {
      title: "Is Redlock safe? (Salvatore Sanfilippo, 2016)",
      url: "http://antirez.com/news/101",
      note: "The Redis author's reply to Kleppmann's critique; read both to see a disagreement about system models argued in public.",
    },
    {
      title: "The Chubby lock service for loosely-coupled distributed systems (Burrows, OSDI 2006)",
      note: "Leases, sequencers (fencing tokens) and lock-delay in a production lock service.",
    },
    {
      title: "Spanner: Google's Globally-Distributed Database (Corbett et al., OSDI 2012)",
      note: "TrueTime, its error bounds and commit wait, straight from the source.",
    },
    {
      title: "The φ Accrual Failure Detector (Hayashibara et al., 2004)",
      note: "The adaptive failure detector behind Cassandra's and Akka's failure detection.",
    },
    {
      title: "The Byzantine Generals Problem (Lamport, Shostak & Pease, 1982)",
      note: "Where the term and the 3f + 1 bound come from; short and readable.",
    },
    {
      title: "Gray Failure: The Achilles' Heel of Cloud-Scale Systems (Huang et al., HotOS 2017)",
      note: "Why half-working components, not clean crashes, cause many real outages.",
    },
    {
      title: "An Analysis of Network-Partitioning Failures in Cloud Systems (Alquraan et al., OSDI 2018)",
      note: "A systematic study of how partitions, including partial ones, break real systems.",
    },
    {
      title: "Jepsen analyses (Kyle Kingsbury)",
      url: "https://jepsen.io/analyses",
      note: "Fault-injection testing of real databases: concrete evidence of what partitions and clock problems do to implementations.",
    },
    {
      title: "How Amazon Web Services Uses Formal Methods (Newcombe et al., CACM 2015)",
      note: "TLA+ model checking in industry: the theory-and-testing point of the section on system models.",
    },
    {
      title: "Logical Physical Clocks (Kulkarni et al., 2014)",
      note: "Hybrid logical clocks, the approach CockroachDB and others use to combine physical time with causality.",
    },
    {
      title: "How and why the leap second affected Cloudflare DNS (Cloudflare blog, 2017)",
      url: "https://blog.cloudflare.com/how-and-why-the-leap-second-affected-cloudflare-dns/",
      note: "A short, concrete postmortem of measuring a duration with the wall clock.",
    },
    {
      title: "Leap Smear (Google Public NTP documentation)",
      url: "https://developers.google.com/time/smear",
      note: "How and why Google spreads a leap second over 24 hours.",
    },
  ],
});
