// Chapter 8 deep dive, part 1 (hook + partial failure, networks, timeouts, clocks, timestamps).
// Part 2 lives in ch8.deep2.js. Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch8", {
  hook: `<p><a href="#/ch5/learn/node-outages">Chapter 5</a> opened with GitHub's outage of October 21, 2018: a <strong>43-second</strong> network cut between its East Coast network hub and its primary East Coast data center, an automatic failover that promoted database primaries on the West Coast, and 24 hours and 11 minutes of degraded service while two divergent sets of writes were restored and reconciled. That chapter followed the data. This one follows the servers.</p>
<p>Now sit inside one of those servers during the 43 seconds. Nothing arrives. Is the other side dead, slow, frozen, or cut off? You can't know, yet the automation must decide, and whatever it decides may be wrong. This chapter catalogues what a node can't trust (the network, the clock, its own uninterrupted execution, other nodes' honesty) and then the few tools that make correct systems possible anyway: carefully chosen timeouts, majorities, fencing tokens and explicit system models.</p>`,
  sections: [
    // ------------------------------------------------------------------ 1
    {
      id: "partial-failure",
      title: "Partial failure: the problem one computer never had",
      kicker: "Motivation",
      concepts: ["partial-failure", "gray-failure"],
      blocks: [
        {
          type: "problem",
          html: `<p>A program on one computer lives in a forgiving world. Call a function and it returns a result or raises an error; it never ends in an unknown state. When the hardware itself goes wrong (a memory error that can't be corrected, a failing bus), the machine is built to halt with a kernel panic or a blue screen rather than keep running and hand back a wrong answer. So a programmer can treat the computer as either <em>working</em> or <em>dead</em>.</p>
<p>Spread the same program across a few hundred machines and that picture breaks. At any moment most machines are fine, one is rebooting, one has a disk that answers in two seconds instead of two milliseconds, and a switch is quietly dropping some of its packets. The naive response is to write remote calls as if they were local function calls and treat failure as exotic. That code hangs forever when a reply never comes, charges a customer twice when it retries, and corrupts state the first time the network hiccups.</p>`,
        },
        {
          type: "idea",
          html: `<p>In a distributed system failure is <strong>partial</strong> and <strong>nondeterministic</strong>, so reliability has to be built in software out of unreliable parts, by assuming from the start that anything that can go wrong will.</p>`,
        },
        {
          type: "text",
          html: `<p>The single-machine guarantee is a <strong>design choice</strong>, not a law of physics. The hardware inside one box is far from perfect; computer designers simply decided that when something is wrong, crashing completely beats being subtly incorrect. That decision turns every hardware fault into a <em>total</em> failure, and total failures are easy to reason about: the program either ran or it didn't, and the same operation on the same input gives the same result. Much of the confidence we carry over from single-node programming comes from this one decision.</p>
<p>A distributed system has no such luxury. It suffers <strong>partial failure</strong>: some components break while others keep working, and which ones break, and when, is <strong>nondeterministic</strong>. The same request may succeed one moment and fail the next, and, worst of all, it may finish with an outcome nobody knows, because the message that would have reported the result never arrived. Often you can't even find out afterwards whether something succeeded. That uncertainty, more than any single fault, is what makes distributed systems hard.</p>`,
        },
        {
          type: "diagram",
          title: "One machine vs. many",
          svg: `<svg viewBox="0 0 420 250" style="max-width: 560px; margin: 0 auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a single server that is either working or crashed. Right: a client linked to five nodes, two OK, one crashed, one slow and one unreachable, with question marks on the uncertain links">
  <text x="10" y="20" font-size="13" font-weight="700">One computer</text>
  <rect x="15" y="38" width="110" height="44" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="70" y="65" font-size="13" font-weight="600" text-anchor="middle">Server</text>
  <line x1="70" y1="82" x2="70" y2="102" style="stroke: var(--viz-muted)"/>
  <rect x="30" y="102" width="80" height="26" rx="13" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="70" y="119" font-size="12" text-anchor="middle">works</text>
  <text x="70" y="146" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">or</text>
  <rect x="30" y="154" width="80" height="26" rx="13" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="70" y="171" font-size="12" text-anchor="middle">crashed</text>
  <text x="70" y="204" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Deterministic:</text>
  <text x="70" y="219" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">it either runs</text>
  <text x="70" y="234" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">or it doesn't.</text>
  <line x1="148" y1="8" x2="148" y2="242" stroke-dasharray="4 4" style="stroke: var(--viz-line)"/>
  <text x="166" y="20" font-size="13" font-weight="700">A distributed system</text>
  <rect x="160" y="36" width="146" height="28" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-c6)"/>
  <polygon points="186,64 200,64 194,114" style="fill: var(--viz-panel); stroke: var(--viz-c6)"/>
  <rect x="187" y="62" width="12" height="4" style="fill: var(--viz-panel); stroke: none"/>
  <text x="233" y="55" font-size="12" text-anchor="middle">Did my write succeed?</text>
  <line x1="215.5" y1="126.1" x2="309.8" y2="58.7" style="stroke: var(--viz-muted)"/>
  <line x1="218.6" y1="131.9" x2="307.9" y2="100.0" style="stroke: var(--viz-muted)"/>
  <line x1="220.0" y1="140.0" x2="307.0" y2="140.0" style="stroke: var(--viz-muted)"/>
  <line x1="218.6" y1="148.1" x2="307.9" y2="180.0" style="stroke: var(--viz-muted)"/>
  <line x1="215.5" y1="153.9" x2="309.8" y2="221.3" stroke-dasharray="5 4" style="stroke: var(--viz-muted)"/>
  <circle cx="196" cy="140" r="24" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="196" y="144" font-size="12" font-weight="600" text-anchor="middle">Client</text>
  <text x="264" y="146" font-size="17" font-weight="700" text-anchor="middle" class="viz-halo" style="fill: var(--viz-warn)">?</text>
  <text x="263" y="170" font-size="17" font-weight="700" text-anchor="middle" class="viz-halo" style="fill: var(--viz-warn)">?</text>
  <text x="263" y="194" font-size="17" font-weight="700" text-anchor="middle" class="viz-halo" style="fill: var(--viz-warn)">?</text>
  <circle cx="322" cy="50" r="15" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <circle cx="322" cy="95" r="15" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <circle cx="322" cy="140" r="15" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <line x1="314" y1="132" x2="330" y2="148" stroke-width="2.5" style="stroke: var(--viz-bad)"/>
  <line x1="330" y1="132" x2="314" y2="148" stroke-width="2.5" style="stroke: var(--viz-bad)"/>
  <circle cx="322" cy="185" r="15" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <circle cx="322" cy="230" r="15" stroke-dasharray="4 3" style="fill: var(--viz-node); stroke: var(--viz-muted)"/>
  <text x="344" y="54" font-size="12">OK</text>
  <text x="344" y="99" font-size="12">OK</text>
  <text x="344" y="144" font-size="12">crashed</text>
  <text x="344" y="189" font-size="12">slow?</text>
  <text x="344" y="234" font-size="12">unreachable?</text>
</svg>`,
          caption: `One computer is designed to fail completely. A cluster is always partly broken, nondeterministically, and the client's only evidence is whether replies come back. A crashed node, a slow one and an unreachable one all look the same from where the client sits.`,
        },
        {
          type: "text",
          html: `<h3>Two philosophies of large-scale computing</h3>
<p>At one end sits <strong>high-performance computing</strong> (HPC): supercomputers running long batch jobs such as weather simulation or molecular dynamics. They sidestep partial failure by refusing to have it. The job periodically <strong>checkpoints</strong> its state to durable storage; if any node fails, the whole cluster stops and the job restarts from the last checkpoint. A supercomputer behaves like one giant computer with a kernel panic: partial failure is escalated to total failure on purpose.</p>
<p>At the other end sit <strong>internet services</strong>: online systems that must answer users with low latency at all hours. Stopping the world to restart isn't an option, and the environment makes partial failure unavoidable:</p>
<ul>
<li><strong>Commodity machines.</strong> Services run on many inexpensive servers, which give better cost per unit of work but fail more often than specialized hardware.</li>
<li><strong>Commodity networks.</strong> Datacenters use IP and Ethernet in Clos-style topologies built for high bisection bandwidth, not the specialized meshes and toruses of supercomputer interconnects. Every packet passes through switches with queues, which the timeouts section returns to.</li>
<li><strong>Scale.</strong> With thousands of nodes, it's reasonable to assume <em>something</em> is broken at every moment. A stop-and-restart strategy would spend more time recovering than working.</li>
<li><strong>Continuous operation.</strong> Rolling upgrades, restarts and machine replacements have to happen while the service keeps serving.</li>
<li><strong>Geography.</strong> Keeping data close to users means datacenters on several continents talking over the internet, which is slower and less reliable than a local network.</li>
</ul>`,
        },
        {
          type: "compare",
          title: "Two ways to live with failing nodes",
          items: [
            {
              title: "Supercomputer (HPC)",
              tone: "info",
              html: `Batch jobs on specialized hardware and interconnects. Checkpoint state regularly; if any node fails, stop everything and restart from the last checkpoint. Partial failure becomes total failure, which is simple to reason about and acceptable because nobody is waiting on a reply right now.`,
            },
            {
              title: "Online service (cloud)",
              tone: "warn",
              html: `Interactive traffic on commodity machines and networks. Something is always failing, and users expect answers in milliseconds, so the system must keep serving while parts of it are down, slow or unreachable. Tolerating partial failure in software is the only option.`,
            },
          ],
        },
        {
          type: "analogy",
          title: "A phone call that goes quiet",
          html: `<p>You're on a call and the other end goes silent. Are they thinking? Did they put the phone down to answer the door? Did the line drop? From your side, all three sound the same. You can say "hello?", wait, or call back; what you can't do is learn the answer from the silence itself. Every node in a distributed system is permanently in this position with respect to every other node.</p>`,
        },
        {
          type: "text",
          html: `<h3>Reliable systems from unreliable parts</h3>
<p>The goal, then, is <strong>fault tolerance in software</strong>: a system that keeps working, perhaps in a degraded way, while some of its parts fail. That sounds paradoxical, but it's ordinary engineering. <strong>Error-correcting codes</strong> let a disk or a radio link deliver correct bits over a channel that occasionally flips some. <strong>TCP</strong> gives applications an ordered, deduplicated, retransmitted byte stream on top of IP, which may drop, delay, duplicate and reorder packets.</p>
<p>There's always a limit. An error-correcting code fixes a few flipped bits, not interference that wipes out a whole block. TCP can hide loss and reordering, but not <em>delay</em>: a retransmitted packet simply arrives late, and if the link is cut, TCP can only report, eventually, that the connection died. A well-built system is more reliable than its parts, never perfectly reliable, and the faults it can't mask surface to whatever sits above it.</p>
<p>The mindset that follows is deliberately pessimistic: assume that anything that can go wrong will, and decide in advance what the system does in each case. If you don't know how your software behaves when a link fails, assume the answer is "badly", and find out by <strong>injecting faults on purpose</strong>: kill processes, cut links, slow disks and skew clocks, in testing and sometimes in production. Many of the assumptions such testing exposes were written down decades ago as the <strong>fallacies of distributed computing</strong>: the network is reliable, latency is zero, bandwidth is infinite, the network is secure, topology doesn't change, there is one administrator, transport cost is zero, the network is homogeneous.</p>
<p>The rest of this chapter takes those assumptions apart in order: networks (the next two sections), clocks (two sections), process pauses, and then what any node can know for sure (majorities, fencing tokens, lying nodes) and how system models make all of it precise. It's a gloomy tour on purpose. Chapter 9 builds the positive tools, consensus above all, on the foundation laid here.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Gray failure: partial even inside one component",
          html: `<p>Real failures are often partial <em>within</em> a single component: a disk that serves most reads in milliseconds and a few in seconds, a network card that drops a small fraction of packets, a server that passes every health check while timing out for one client's requests. Huang et al. (HotOS 2017, drawing on experience at Microsoft) named this <strong>gray failure</strong> and traced it to <strong>differential observability</strong>: the failure detector sees a healthy component while its users see a broken one. They argue that such half-alive components, rather than clean crashes, are behind many major cloud incidents, and that detecting them means measuring health from the users' side, not only from a heartbeat.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Gunawi et al.",
              year: "FAST 2018",
              tag: "fail-slow",
              html: `"Fail-Slow at Scale" collected 101 reports, from large production clusters at 12 institutions, of hardware that kept working but ran far below its expected speed. Every kind of component did it: disks, SSDs, CPUs, memory and network gear. Faults could change form and cascade, so one slow part could drag down a whole system built to survive crashes, because nothing had technically failed.`,
            },
            {
              org: "Sun Microsystems",
              year: "1990s",
              tag: "fallacies",
              html: `L Peter Deutsch and colleagues at Sun listed the false assumptions newcomers make about networked systems; James Gosling later added an eighth. The first two, "the network is reliable" and "latency is zero", are the subject of the next two sections.`,
            },
            {
              org: "Netflix",
              year: "2010–2012",
              tag: "fault injection",
              html: `Deliberate fault injection, popularized by Netflix's Chaos Monkey (<a href="#/ch1/learn/reliability">Chapter 1</a>), is how teams prove their partial-failure handling actually works.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>The strongest signal in a system-design interview comes early: before drawing boxes, say that every network call has three outcomes (success, failure and <em>unknown</em>) and that some part of the system will be failing at all times. Then let it shape the design: a timeout on every remote call, retries only for operations that are safe to repeat, a plan for dependencies that are slow rather than down, and a clear statement of which failures you tolerate and which you merely alert on. Weak answers treat the network like a function call and discover failure only when the interviewer asks "what if this box dies?"</p>`,
        },
        {
          type: "quiz",
          q: "A 10,000-node online service borrows the supercomputer strategy: if any node fails, stop everything and restart from the last checkpoint. What goes wrong?",
          options: [
            "Nothing: checkpointing makes the cluster behave like a single reliable machine",
            "At that scale some node is almost always failing, so the service would spend most of its time restarting, and online users can't wait for restarts",
            "Checkpoints cannot be written to commodity disks",
            "Restarting from a checkpoint violates the CAP theorem",
          ],
          answer: 1,
          explain: `Escalating partial failure to total failure works for batch jobs that can pause and resume from a checkpoint. With 10,000 machines failures are continuous, so the cluster would rarely get useful work done between restarts, and an online service can't make users wait in any case. Option A is tempting because it's exactly what HPC does, but HPC jobs can afford to stop; a website can't. Commodity disks store checkpoints perfectly well (C), and CAP describes behavior during network partitions, not restarts (D).`,
        },
      ],
    },
    // ------------------------------------------------------------------ 2
    {
      id: "unreliable-networks",
      title: "A missing reply tells you almost nothing",
      kicker: "Unreliable networks",
      concepts: ["unreliable-networks", "network-partition", "two-generals-problem"],
      blocks: [
        {
          type: "problem",
          html: `<p>A checkout service sends <code>charge $10</code> to the payment service and waits. Nothing comes back. The tempting conclusion is that the payment service is down, so checkout either retries or fails over to another payment node.</p>
<p>Both reactions can be wrong. If the charge went through and only the reply was lost, the retry charges the customer twice. If the payment node is merely frozen in a garbage-collection pause, failing over leaves two nodes that each believe they're responsible, and the frozen one wakes up and finishes its work anyway. From the sender's side, these situations, and several others, look exactly alike.</p>`,
        },
        {
          type: "idea",
          html: `<p>When a request goes unanswered, the sender can't tell whether the request, the remote node or the reply failed. The honest answer is <strong>outcome unknown</strong>, and the system has to be designed around that.</p>`,
        },
        {
          type: "text",
          html: `<h3>Six fates of a request</h3>
<p>The machines in a typical distributed system share nothing (no memory, no disks) and cooperate only by sending messages over an <strong>asynchronous packet network</strong>, usually Ethernet and IP. "Asynchronous" means the network promises nothing about <em>when</em> a packet arrives, or whether it arrives at all. Send a request, expect a response, and any of these can happen:</p>
<ol>
<li>The <strong>request is lost</strong>: a cable was unplugged, or a switch dropped it.</li>
<li>The request is <strong>waiting in a queue</strong> and will be delivered later, because the network or the recipient is overloaded.</li>
<li>The remote node has <strong>crashed</strong> or been powered off.</li>
<li>The remote node has <strong>temporarily stopped responding</strong>, for example in a long garbage-collection pause, and will carry on later.</li>
<li>The remote node <strong>processed the request, but the response was lost</strong>, perhaps by a misconfigured switch.</li>
<li>The remote node processed it, but the <strong>response is delayed</strong>, because the network or your own machine is overloaded.</li>
</ol>
<p>Now count the cases where the work got done. In cases 2, 4, 5 and 6 the request was processed, or will be once it leaves a queue or the pause ends. Case 3 is ambiguous on its own, since a node can crash just before or just after performing a side effect. So the truthful summary of a missing reply is <strong>"outcome unknown"</strong>, and in most of the ways it can happen the work may well have been done.</p>
<p>The sender has exactly one tool: a <strong>timeout</strong>. After a while it stops waiting and assumes no response is coming. But a timeout ends the waiting, not the uncertainty: the request may still be sitting in a queue and arrive after the sender has given up. In the visualization below, you are the sender.</p>`,
        },
        {
          type: "viz",
          id: "ch8/no-reply",
          title: "What happened to my request?",
          caption: `Try Mystery mode first: press Send, watch only the client side, and guess whether the customer was charged before the truth is revealed. Then pick Reply lost, Send, and press Retry once the timeout fires. Notice the charge counter reaches 2. Finally turn on "Server remembers request IDs" and repeat with Request queued: the duplicate is answered from the saved result, and the customer is charged once whatever the timing.`,
        },
        {
          type: "text",
          html: `<p>The client's view never changed: a request left, a timer ran out. Everything you learned about lost requests, GC pauses and dropped replies came from the server's side of the picture, which a real client can't see. Retrying blindly turned an unknown outcome into a double charge whenever the first attempt had in fact succeeded, including the nasty case where the original request was merely delayed and landed <em>after</em> the retry.</p>
<p>The fix you switched on at the end, a request ID that the server remembers, makes the retry <strong>idempotent</strong>: performing it twice has the same effect as performing it once. It answers <a href="#/ch4/learn/dataflow-services">Chapter 4</a>'s warning that retrying a remote call may do the work twice, and <a href="#/ch12/learn/end-to-end-argument">Chapter 12</a> develops it into end-to-end deduplication. The point here is that safe retries must be designed in, because the network will never tell you which case you're in.</p>`,
        },
        {
          type: "callout",
          tone: "history",
          title: "The Two Generals problem",
          html: `<p>Why can't the client simply reach certainty by sending more messages? Picture two generals on opposite hills who must attack together, communicating only by messengers who may be captured on the way. General A sends "attack at dawn", but can't attack unless she knows it arrived, so B sends an acknowledgment. Now B can't be sure <em>his</em> message arrived, so A acknowledges the acknowledgment, and so on. Whoever sends the last message can never know it got through, so no finite number of messages makes both sides certain. The puzzle was first described in 1975, and Jim Gray gave it its name in 1978.</p>
<p>Real systems don't escape it; they work around it: by asking again (a status query, an idempotent retry), by reconciling afterwards, or by letting a majority decide, as the section on majorities shows. Don't confuse it with the <strong>Byzantine Generals</strong> problem, where messages arrive but some generals lie (covered later in this chapter), or with the <strong>FLP</strong> impossibility result about asynchrony and crashes (Chapter 9).</p>`,
        },
        {
          type: "text",
          html: `<h3>Network faults are not rare</h3>
<p>It's tempting to file all of this under edge cases. Experience says otherwise, even inside a single datacenter run by one company. One study cited in the book found about 12 network faults a month in a medium-sized datacenter, half of them cutting off a single machine and half an entire rack. <strong>Human error</strong>, such as a misconfigured switch, is a major cause, which is why redundant network gear helps less than you'd hope: two switches configured by the same mistaken change fail together.</p>
<p>The list of other causes is long. Public clouds such as EC2 are known for frequent transient network glitches. A switch software upgrade can trigger a topology reconfiguration during which packets are delayed for more than a minute. Sharks have bitten undersea cables. And a network interface can fail in <strong>one direction only</strong>, dropping every inbound packet while sending outbound ones perfectly, so the node looks alive to some observers and dead to others.</p>
<p>When one part of the network is cut off from another, that's a <strong>network partition</strong>, or netsplit. Partitions are often <strong>partial</strong>: A can reach B and B can reach C, yet A can't reach C; or traffic flows one way but not the other. Each node then has a different picture of who is alive, and any algorithm that assumes everyone sees the same thing goes wrong.</p>
<p>You don't necessarily have to <em>tolerate</em> every network fault. If your network is usually reliable, showing users an error during the rare outage can be a fine design. What you can't skip is knowing how your software reacts, because undefined behavior here can be arbitrarily bad: a cluster may deadlock and stay unable to serve requests even after the network recovers, or it may lose data. Find out by injecting network faults deliberately, which is exactly how Jepsen tests databases.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "Two different kinds of \"partition\"",
          html: `<p>A <strong>network partition</strong> is a communication failure: some nodes can't reach others. It has nothing to do with <strong>data partitioning</strong> (sharding) from Chapter 6, which deliberately splits a dataset across nodes. The shared word causes real confusion, especially around the "P" in CAP, which always means the network kind. And a network partition need not be clean or symmetric: partial and one-way partitions are common and especially nasty, because the nodes disagree about who is reachable.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Jepsen (Kyle Kingsbury)",
              year: "2013–",
              tag: "fault injection",
              html: `Since 2013 Jepsen has tested real databases by injecting network partitions while recording client operations, repeatedly finding acknowledged writes lost or stale data served. Early analyses of MongoDB, Elasticsearch and Redis Sentinel are well-known examples.`,
            },
            {
              org: "Alquraan et al.",
              year: "OSDI 2018",
              tag: "study",
              html: `"An Analysis of Network-Partitioning Failures in Cloud Systems" examined 136 partition-induced failures across 25 widely used distributed systems. 80% had catastrophic effects, data loss most often, and 29% were triggered by <em>partial</em> partitions, where only some nodes can't reach each other.`,
            },
            {
              org: "Bailis & Kingsbury",
              year: "2014",
              tag: "survey",
              html: `"The Network is Reliable" (ACM Queue) collected public postmortems of partitions caused by misconfigured switches, failed network cards, maintenance mistakes and bugs in network gear, both inside single datacenters and between them. It's the empirical answer to "partitions are rare".`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Detecting faults: the rare cases where you get a hint</h3>
<p>Many systems must detect faulty nodes automatically: a load balancer should stop routing to a dead backend, and a single-leader database should promote a follower when its leader fails (Chapter 5). Sometimes the environment hands you explicit feedback, summarized below. Each signal answers a narrow question, and each tends to vanish in exactly the situations where you need it most, such as the whole machine losing power or the network itself being what broke.</p>
<p>None of them tells you that a request <em>succeeded</em>; for that you need a positive response from the application on the other side. And when something has gone wrong, you may get an error at some level of the stack, but in general you must assume you'll get no response at all: retry a few times, wait for a timeout, and eventually declare the node dead if you still hear nothing.</p>`,
        },
        {
          type: "table",
          title: "Signals a sender might get",
          headers: ["Signal", "What it tells you", "What it doesn't"],
          rows: [
            ["Connection refused (TCP RST)", "The machine is reachable but no process is listening on the port, so the process has probably died", "Whether requests sent before the crash were processed"],
            ["Peer notification script (HBase does this)", "The process crashed but the OS is still running, so other nodes can take over without waiting for a timeout", "Anything at all if the whole machine died or lost power"],
            ["Switch reports a link down", "A hardware-level link failure, for example a powered-off machine, if you can query the switches' management interfaces", "Not available over the internet, in shared datacenters without switch access, or when the management network is itself unreachable"],
            ["ICMP Destination Unreachable", "A router believes the destination can't be reached", "Routers have no special insight into failures: they can be wrong, or say nothing"],
            ["Silence", "Something, somewhere, went wrong, or is merely slow", "Which of the six fates it was. This is the common case."],
          ],
        },
        {
          type: "callout",
          tone: "warning",
          title: "A TCP acknowledgment is not a success",
          html: `<p>TCP gives you retransmission, deduplication and ordering of bytes <em>within one connection</em>. It gives no bound on delay, and an acknowledgment only means the remote <strong>kernel</strong> received the bytes into a buffer: the application may crash before reading them, or read them and crash before committing. When a connection breaks, you also can't tell how much of what you sent the other side actually processed. Only an application-level reply, or an application-level status query, tells you the operation happened. That is the end-to-end argument of Chapter 12.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A classic prompt: "Your call to the payment provider timed out. What do you do?" A strong answer starts from <em>unknown outcome</em>, not failure, and never assumes the charge didn't happen. Attach a unique <strong>idempotency key</strong> to every charge (Stripe's API accepts one per request) so a retry with the same key returns the original result instead of charging again, or query the provider for that key's status before deciding. Retry with backoff and a bounded number of attempts; if the outcome stays unknown, park the order as <em>pending</em> for reconciliation rather than telling the user it failed. Bonus point: failing over to another region is also a retry, with the same duplication risk.</p>`,
        },
        {
          type: "quiz",
          q: "A client's POST /transfer times out after 5 seconds. Which conclusion is justified?",
          options: [
            "The transfer did not happen, so it is safe to retry",
            "The server is down, so the client should fail over to a replica",
            "The transfer may or may not have happened; only the server (via a status query or an idempotent retry) can settle it",
            "The network dropped the request",
          ],
          answer: 2,
          explain: `Silence is consistent with a lost request, a crashed or paused server, a lost reply and a delayed reply, and in several of those the transfer was performed (or will be, once a queued request or a paused server gets going again). Assuming it didn't happen (A) risks a double transfer, which is the trap most people fall into. Assuming the server is down (B) may trigger a failover while it is merely paused, so two nodes could act. D is only one of several possibilities. The question can be settled only by the server: through a status query, or a retry it recognizes as a duplicate.`,
        },
      ],
    },
    // ------------------------------------------------------------------ 3
    {
      id: "timeouts-and-delays",
      title: "Every timeout is a bet",
      kicker: "Failure detection",
      concepts: ["timeouts", "queueing-delays", "phi-accrual-failure-detector", "circuit-vs-packet-switching"],
      blocks: [
        {
          type: "problem",
          html: `<p>Automatic failure detection is everywhere. A load balancer must stop sending traffic to a dead backend, a database must promote a follower when its leader dies, and a storage system must re-replicate data from a failed disk. Since silence is the only general signal, all of them come down to a timeout. The tempting choice is a short, fixed one, say 500 ms, "so failover is fast".</p>
<p>Then the evening peak arrives. Queues lengthen, a few healthy nodes miss the 500 ms deadline and are declared dead. Their traffic moves onto the remaining nodes, which slow down and miss the deadline too: a <strong>cascading failure</strong> built entirely out of nodes that were working. A node that was merely paused gets replaced while it's still mid-task, so its work happens twice. Make the timeout long instead, and a node that really died leaves users staring at errors for a long time before anyone notices.</p>`,
        },
        {
          type: "idea",
          html: `<p>Packet networks and shared machines queue work, so delays have no upper bound. A timeout therefore trades false alarms against slow detection; choose it from <strong>measured latency distributions</strong>, ideally adaptively, and never mistake it for proof of death.</p>`,
        },
        {
          type: "text",
          html: `<h3>The timeout that would be perfect, if networks cooperated</h3>
<p>Suppose the network guaranteed that every packet is delivered within some time <span class="mono">d</span> or lost, never later, and that every working node handles a request within time <span class="mono">r</span>. Then every successful request would get its response within <span class="mono">2d&nbsp;+&nbsp;r</span>, and a timeout of exactly that length would be a perfect failure detector: no false alarms, and detection as fast as physics allows.</p>
<p>Real systems offer neither guarantee. Asynchronous networks have <strong>unbounded delays</strong>: they try to deliver packets quickly, but there's no upper limit on how long it can take. Most server software can't promise a maximum response time either, as the section on process pauses explains. And a bound that holds 99.99% of the time doesn't rescue the scheme: a detector that declares nodes dead whenever <span class="mono">d</span> is exceeded will flap between "dead" and "alive" every time the bound is broken.</p>`,
        },
        {
          type: "diagram",
          title: "Where a packet waits",
          svg: `<svg viewBox="0 0 640 258" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A packet's path from sender app through TCP buffer, NIC and switch to the receiver's NIC, hypervisor, OS run queue and application thread pool; five of the eight stages are queues">
  <defs>
    <marker id="c8d-pw-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
    <marker id="c8d-pw-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
  </defs>
  <path d="M551,54 C551,22 243,22 243,51" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c8d-pw-b)" style="fill: none; stroke: var(--viz-bad)"/>
  <text x="397" y="16" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">packet dropped? TCP resends it after a timeout</text>
  <rect x="22" y="56" width="134" height="62" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="89" y="80" font-size="13" font-weight="600" text-anchor="middle">Sender app</text>
  <text x="89" y="99" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">calls send()</text>
  <rect x="176" y="56" width="134" height="62" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="243" y="80" font-size="13" font-weight="600" text-anchor="middle">TCP send buffer</text>
  <text x="243" y="97" font-size="12" text-anchor="middle">flow control:</text>
  <text x="243" y="112" font-size="12" text-anchor="middle">sender throttled</text>
  <rect x="330" y="56" width="134" height="62" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="397" y="80" font-size="13" font-weight="600" text-anchor="middle">Sender NIC</text>
  <text x="397" y="99" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">onto the wire</text>
  <rect x="484" y="56" width="134" height="62" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="551" y="80" font-size="13" font-weight="600" text-anchor="middle">Switch</text>
  <text x="551" y="97" font-size="12" text-anchor="middle">busy output port:</text>
  <text x="551" y="112" font-size="12" text-anchor="middle">queue or drop</text>
  <line x1="157" y1="87" x2="174" y2="87" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="stroke: var(--viz-muted)"/>
  <line x1="311" y1="87" x2="328" y2="87" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="stroke: var(--viz-muted)"/>
  <line x1="465" y1="87" x2="482" y2="87" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="stroke: var(--viz-muted)"/>
  <path d="M551,119 V144 H89 V167" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="320" y="161" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">into the receiving machine</text>
  <rect x="22" y="170" width="134" height="62" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="89" y="194" font-size="13" font-weight="600" text-anchor="middle">Receiver NIC</text>
  <text x="89" y="213" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">packet arrives</text>
  <rect x="176" y="170" width="134" height="62" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="243" y="194" font-size="13" font-weight="600" text-anchor="middle">Hypervisor</text>
  <text x="243" y="211" font-size="12" text-anchor="middle">VM descheduled:</text>
  <text x="243" y="226" font-size="12" text-anchor="middle">tens of ms</text>
  <rect x="330" y="170" width="134" height="62" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="397" y="194" font-size="13" font-weight="600" text-anchor="middle">OS run queue</text>
  <text x="397" y="213" font-size="12" text-anchor="middle">all cores busy</text>
  <rect x="484" y="170" width="134" height="62" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="551" y="194" font-size="13" font-weight="600" text-anchor="middle">App thread pool</text>
  <text x="551" y="213" font-size="12" text-anchor="middle">all workers busy</text>
  <line x1="157" y1="201" x2="174" y2="201" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="stroke: var(--viz-muted)"/>
  <line x1="311" y1="201" x2="328" y2="201" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="stroke: var(--viz-muted)"/>
  <line x1="465" y1="201" x2="482" y2="201" stroke-width="1.5" marker-end="url(#c8d-pw-m)" style="stroke: var(--viz-muted)"/>
  <rect x="22" y="241" width="16" height="11" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="46" y="251" font-size="12" style="fill: var(--viz-muted)">a queue: the wait here has no fixed upper bound</text>
</svg>`,
          caption: `Every amber box is a queue, and queues are why network delay has no upper bound. The hypervisor stage applies only in virtualized environments; the dashed red arc is a dropped packet, which the application sees not as loss but as extra delay.`,
        },
        {
          type: "text",
          html: `<h3>Where the delay comes from: queues</h3>
<p>Variable network delay is mostly <strong>queueing</strong>, as the diagram shows. TCP's flow control and congestion avoidance hold data in the sender's buffer before it touches the network. A switch whose output port receives packets from several senders at once must queue them, and drops them when the queue is full; TCP then resends after a timeout, so the application never sees the loss, only the delay. In a virtualized environment a guest may be descheduled for tens of milliseconds while another VM uses the core, with incoming data buffered by the hypervisor. And if every CPU core is busy, the receiving OS queues the request until a thread can take it.</p>
<p>On shared infrastructure, other people fill many of those queues. In a multi-tenant datacenter or public cloud, your traffic shares links, switches and sometimes CPUs with other customers' workloads, and a neighbor's batch job (a big MapReduce shuffle, say) can saturate a link you depend on. These <strong>noisy neighbors</strong> make delays vary wildly, and you can't control them.</p>
<p>Queueing also explains <em>when</em> things go wrong. In the simplest queueing model (M/M/1: one server, random arrivals), a request's average time in the system is its service time divided by (1 − utilization): twice the service time at 50% load, ten times at 90%, a hundred times at 99%. Latency explodes near saturation, so timeouts misfire at your busiest moments, exactly when a spurious failover hurts most.</p>
<p>Some applications deliberately opt out of part of this. Video calls and voice over IP generally use <strong>UDP</strong> rather than TCP: an audio packet resent a second late is worthless, so the application skips it (a moment of silence) rather than wait. UDP can't remove switch queues, but it removes TCP's flow-control and retransmission delays, trading reliability for predictability.</p>
<p>In the sandbox below, a monitor <strong>M</strong> expects a heartbeat from node <strong>B</strong> every second. The chart plots each heartbeat's gap since the previous one against the detector's threshold; a red band means M has declared B dead. You control the timeout (or, in Adaptive mode, the φ threshold), the network load and how often B pauses for garbage collection, and you can crash B for real to see how long detection takes.</p>`,
        },
        {
          type: "viz",
          id: "ch8/failure-detector",
          title: "Tuning a failure detector",
          caption: `A simplified φ accrual model. Try raising Network load to 90% with a 1.2 s timeout and press Run: each red band is a moment when M declared a live B dead. Drag the timeout up until the false alarms stop, then press Crash B and read off how long detection now takes. Notice that no fixed timeout gives both zero false alarms and fast detection. Switch to Adaptive (φ) and watch the threshold climb as load rises, and keep climbing with frequent GC pauses.`,
        },
        {
          type: "text",
          html: `<h3>Choosing a timeout: measure, then adapt</h3>
<p>There's no correct value: a short timeout catches crashes fast and cries wolf under load, while a long one rarely cries wolf and leaves dead nodes unnoticed for seconds. What you <em>can</em> do is choose with data. Measure the distribution of round-trip times over an extended period and across many machines, looking at the tail percentiles from Chapter 1 rather than the average, and pick a timeout from that distribution and from what each kind of mistake costs your application.</p>
<p>Better still, keep measuring. An <strong>adaptive timeout</strong> tracks response times and their variability (<strong>jitter</strong>) and moves the threshold to match; TCP's retransmission timeout, a smoothed round-trip time plus four times its mean deviation, works this way. The <strong>φ accrual failure detector</strong> (Hayashibara et al., 2004), used by Akka and Cassandra, outputs a <em>suspicion level</em> instead of a yes/no verdict. It models heartbeat inter-arrival times and reports φ, where φ = 8 means the model gives a heartbeat this late a probability of about 10<sup>−8</sup>; the application chooses the threshold at which to act.</p>
<p>Two cautions. φ is only as good as its model, and real delays are heavy-tailed, so normal or exponential approximations are overconfident; that's why practical thresholds sit at 8 or higher. And a detector that has learned long pauses are normal (try 6 GC pauses a minute in Adaptive mode) is correspondingly slower to notice a real crash. Adaptivity moves the trade-off; it doesn't remove it.</p>
<p>Production systems add more defenses: a <strong>suspected</strong> state before <strong>declared dead</strong>; confirmation from several observers, or indirect probes through other nodes, so a fault in one observer's link can't condemn a healthy peer; and <strong>rate-limited recovery</strong>, because re-replication and failover add load just when the system is struggling.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Choosing a timeout (a longer one is the mirror image)",
          prosLabel: "What a shorter timeout buys",
          consLabel: "What a shorter timeout costs",
          pros: [
            "Crashed nodes are detected sooner, so users see hangs or errors for less time",
            "Faster failover, and faster removal of dead backends from a load balancer",
            "Callers wait less, so threads and connections aren't tied up by a dead peer",
          ],
          cons: [
            "False alarms whenever queues or GC pauses stretch a response past the deadline",
            "Duplicate actions: a node declared dead mid-task may still finish it while its replacement redoes it",
            "Failover churn, with the risks Chapter 5 describes (split brain, lost writes)",
            "Cascading failure: a \"dead\" node's load lands on nodes that are already struggling",
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "AWS EBS (US-East)",
              year: "2011",
              tag: "re-mirroring storm",
              html: `On April 21, 2011, a network configuration change shifted traffic onto a lower-capacity network. Many EBS storage nodes lost contact with their replicas and, all at once, searched for new space to re-mirror their data. The resulting "re-mirroring storm" exhausted the cluster's capacity, and some volumes stayed impaired for days. A detector that fires for everyone simultaneously turns a network blip into a load spike.`,
            },
            {
              org: "Amazon DynamoDB (US-East)",
              year: "2015",
              tag: "retry amplification",
              html: `DynamoDB's September 2015 outage had the same shape, driven by retries: storage servers that timed out fetching their partition membership retried into an already overloaded metadata service (<a href="#/ch6/learn/rebalancing-operations">Chapter 6</a> tells the full story).`,
            },
            {
              org: "Apache Cassandra and Akka",
              tag: "φ accrual",
              html: `Both use a φ accrual failure detector. Cassandra decides whether a peer is down from the history of gossip heartbeat inter-arrival times rather than a fixed timeout, and exposes the threshold as <code>phi_convict_threshold</code> (default 8).`,
            },
            {
              org: "Linux TCP",
              tag: "the default is too long",
              html: `With <code>tcp_retries2</code> at its default of 15, Linux keeps retransmitting on an established connection for roughly 15 minutes before giving up; the kernel documentation cites a hypothetical timeout of about 924.6 seconds. Applications need their own, much shorter timeouts.`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Why not build a network that promises a deadline?</h3>
<p>Bounded delay isn't impossible: the telephone network delivered it. A call on a circuit-switched network sets up a <strong>circuit</strong>, a fixed slice of bandwidth reserved along the whole route for as long as the call lasts. An ISDN line, for example, runs at a fixed 4,000 frames per second, and each call gets 16 bits of every frame in each direction. Nobody else can use that slot, so there's no queueing and end-to-end delay has a fixed maximum: a <strong>synchronous</strong> network.</p>
<p>Datacenters and the internet use <strong>packet switching</strong> instead, because their traffic is <strong>bursty</strong>. A voice call needs a steady trickle of bandwidth for minutes; a web page, an email or a file transfer has no fixed bandwidth need and just wants to finish as quickly as possible. A circuit sized for the burst would sit idle most of the time, and a small one would make transfers needlessly slow. Packets let each sender use whatever capacity is free, and TCP adapts its rate to it. The price of that efficiency is queueing, and with it unbounded delay.</p>
<p>Hybrids exist. ATM, a 1980s rival to Ethernet, mixed circuit and packet ideas; InfiniBand's link-layer flow control reduces queueing in the network, though links can still congest; and quality-of-service prioritization plus admission control (rate-limiting senders) can emulate circuits on a packet network. None of it is enabled in today's multi-tenant datacenters, public clouds or the internet, so assume that congestion, queueing and unbounded delays will happen.</p>`,
        },
        {
          type: "compare",
          title: "Two ways to share a wire",
          items: [
            {
              title: "Telephone circuit",
              tone: "info",
              html: `Bandwidth reserved end to end for each call (ISDN: 16 bits in each of 4,000 frames per second). No queueing, so delay is bounded and predictable. Reserved capacity is wasted whenever the call is silent, and a call can't go faster than its slot.`,
            },
            {
              title: "Datacenter packet network",
              tone: "warn",
              html: `Every sender shares every link, and TCP grabs whatever capacity is free. Excellent utilization and fast bulk transfers. Delay depends on everyone else's traffic, queues build up at busy ports, and there is no upper bound on how long a packet takes.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "insight",
          title: "Variable delay is a cost decision",
          html: `<p>Unbounded delay isn't a law of nature; it follows from a choice. <strong>Static partitioning</strong> of a resource, such as a circuit or a fixed CPU slice per tenant, gives bounded latency and wastes whatever capacity goes unused. <strong>Dynamic sharing</strong>, such as packets, thread scheduling or multi-tenant clouds, gets far more work out of the same hardware and pays with variable delay. Most systems choose utilization, and that's usually right, but it means your software, not the network, has to cope with the tail.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Gossip-based failure detection",
          html: `<p>Large clusters rarely rely on one monitor watching everyone. In <strong>SWIM</strong> (Das, Gupta and Motivala, 2002) each node pings a random peer every round; if no ack arrives, it asks <em>k</em> other members to ping the suspect on its behalf (an <strong>indirect probe</strong>) and only marks it suspect if none of them get through. The suspicion spreads by gossip, and the suspect can refute it if it's alive. This filters out problems with the observer's own link and keeps per-node load constant as the cluster grows. HashiCorp's memberlist library, which underpins Consul and Serf, implements SWIM with its <strong>Lifeguard</strong> extensions, which make a node that is itself struggling slower to accuse others.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design failure detection for a 5,000-node cluster." A strong answer covers heartbeats or probes with a timeout derived from the measured latency distribution (tail percentiles, not averages), ideally adaptive per peer (φ accrual). It adds a <em>suspect</em> state before <em>dead</em>; indirect probes or several independent observers, so one bad link doesn't condemn a healthy node; gossip dissemination (SWIM) so no single monitor watches 5,000 nodes; and rate-limited recovery actions. Then it names the hard parts: gray failures that pass health checks while failing real traffic, and the fact that declaring a node dead doesn't stop it from acting, which is why fencing tokens (later in this chapter) exist.</p>`,
        },
        {
          type: "quiz",
          q: "Your p99.9 round-trip time is 80 ms, but during nightly batch jobs it reaches 900 ms. You set the failure-detection timeout to 200 ms. What happens at night?",
          options: [
            "Nothing: timeouts only fire when a node crashes",
            "Healthy nodes get declared dead; failover moves their load onto others, which slow down further, risking cascading failure",
            "TCP fails because packets are dropped",
            "Only the batch job slows down",
          ],
          answer: 1,
          explain: `A timeout can't distinguish slow from dead. At night the tail latency is far above 200 ms, so live nodes are declared dead, and moving their work elsewhere makes the remaining nodes slower still: the shape of AWS's 2011 re-mirroring storm. Option A is the tempting misconception that a timeout detects crashes specifically; it only detects lateness. C is wrong because TCP retransmits dropped packets (which adds delay rather than failing), and D ignores that the batch jobs share the network with everything else.`,
        },
      ],
    },
    // ------------------------------------------------------------------ 4
    {
      id: "two-clocks",
      title: "Two clocks, two different questions",
      kicker: "Unreliable clocks",
      concepts: ["monotonic-vs-time-of-day-clocks", "clock-skew-ntp-drift", "leap-second-smearing"],
      blocks: [
        {
          type: "problem",
          html: `<p>Programs ask two quite different questions about time. <em>How long did this take?</em> drives timeouts, latency percentiles, cache expiry and rate limits. <em>When did this happen?</em> drives log timestamps, <code>created_at</code> columns and certificate expiry dates. The naive approach answers both with the wall clock: <code>System.currentTimeMillis()</code>, <code>time.Now()</code>, <code>Date.now()</code>.</p>
<p>That works until the wall clock moves in a way real time doesn't. NTP notices the clock is 800 ms fast and steps it back, or a leap second makes the clock repeat a second. A duration computed as "now minus start" comes out negative or wildly wrong: a timeout fires instantly or never, a rate limiter lets a burst through, and code that assumes elapsed time is positive crashes, which is exactly how part of Cloudflare's DNS service failed on January 1, 2017. And even when nothing jumps, the quartz crystals in two machines tick at slightly different rates, so they never quite agree on what time it is.</p>`,
        },
        {
          type: "idea",
          html: `<p>Use the <strong>monotonic clock</strong> to measure how long something took and the <strong>time-of-day clock</strong> to record when something happened, and remember that the latter is only roughly synchronized and can jump.</p>`,
        },
        {
          type: "text",
          html: `<p>Every computer has its own clock hardware, usually a <strong>quartz crystal oscillator</strong>, and no two crystals run at exactly the same rate. To keep machines roughly in agreement, the <strong>Network Time Protocol</strong> (NTP) adjusts each computer's clock according to the time reported by a group of servers, which in turn get their time from more accurate sources such as GPS receivers. Operating systems expose this hardware through two kinds of clock, one for each question.</p>
<p><strong>Time-of-day clocks</strong>, or wall clocks, return the current date and time, usually as seconds or milliseconds since the <strong>epoch</strong>: midnight UTC on January 1, 1970, by the Gregorian calendar, not counting leap seconds. On Linux that's <code>clock_gettime(CLOCK_REALTIME)</code>; in Java, <code>System.currentTimeMillis()</code>. Because NTP synchronizes them, a timestamp from one machine ideally means the same as one from another. But if the local clock gets too far ahead of the NTP server, it may be forcibly reset and appear to <strong>jump back in time</strong>. Those jumps, and leap seconds, make wall clocks unsuitable for measuring elapsed time. Some systems also had coarse resolution: older Windows clocks advanced in steps of about 10 ms.</p>
<p><strong>Monotonic clocks</strong> are guaranteed always to move forward. On Linux that's <code>clock_gettime(CLOCK_MONOTONIC)</code>; in Java, <code>System.nanoTime()</code>. Their absolute value is meaningless (it might be the time since boot), so you can only subtract two readings taken on the same machine; comparing values from two computers tells you nothing. NTP still disciplines them, but only by <strong>slewing</strong>: it may speed the clock up or slow it down by up to 0.05%, never make it jump. Resolution is usually microseconds or better. One caveat: a server with several CPU sockets may have a separate timer per CPU, not necessarily synchronized with the others; the OS compensates, but it's wise not to lean on the guarantee too hard.</p>
<p>The rule that follows is simple: <strong>measure durations with the monotonic clock</strong>. It needs no synchronization between nodes, which is why it works fine even in distributed systems. On Linux there's one more nuance: <code>CLOCK_MONOTONIC</code> stops while the machine is suspended, whereas <code>CLOCK_BOOTTIME</code> keeps counting, which matters more for laptops and phones than for servers.</p>`,
        },
        {
          type: "table",
          title: "The two clocks side by side",
          headers: ["", "Time-of-day (wall clock)", "Monotonic clock"],
          rows: [
            ["Answers", "\"When did it happen?\"", "\"How long did it take?\""],
            ["Example APIs", "<code>CLOCK_REALTIME</code>, Java's <code>System.currentTimeMillis()</code>, Python's <code>time.time()</code>", "<code>CLOCK_MONOTONIC</code>, Java's <code>System.nanoTime()</code>, Python's <code>time.monotonic()</code>"],
            ["Can it jump?", "Yes, backwards or forwards: NTP steps, leap seconds, manual changes", "Never backwards; NTP may slew its rate by up to 0.05%"],
            ["Comparable across machines?", "Roughly: expect milliseconds, sometimes seconds, of skew", "No: the absolute value is arbitrary, such as time since boot"],
            ["Use it for", "Timestamps for people and logs, expiry dates", "Timeouts, latencies, rate limits"],
          ],
        },
        {
          type: "code",
          lang: "java",
          title: "Measuring elapsed time",
          code: `// WRONG: measures a duration with the time-of-day clock
long start = System.currentTimeMillis();
doWork();
long elapsedMs = System.currentTimeMillis() - start;
// If NTP steps the clock back 800 ms during doWork(),
// elapsedMs comes out too small, possibly negative.
// A step forward inflates it instead.

// RIGHT: measures a duration with the monotonic clock
long t0 = System.nanoTime();
doWork();
long elapsedNs = System.nanoTime() - t0;
// Unaffected by NTP steps and leap seconds.
// nanoTime()'s absolute value means nothing: only differences
// taken within the same JVM are meaningful. Never store it,
// and never compare values from two machines.`,
        },
        {
          type: "diagram",
          title: "Two clocks on one machine",
          svg: `<svg viewBox="0 0 420 312" style="max-width: 560px; margin: 0 auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Clock reading plotted against true time: a drifting time-of-day clock that steps back at minute 4 and stalls for a leap second at minute 8, and a smooth monotonic clock whose rate is slewed after minute 4">
  <line x1="44" y1="10" x2="44" y2="200" style="stroke: var(--viz-muted)"/>
  <line x1="44" y1="200" x2="400" y2="200" style="stroke: var(--viz-muted)"/>
  <g style="stroke: var(--viz-muted)">
    <line x1="115.2" y1="200" x2="115.2" y2="205"/><line x1="186.4" y1="200" x2="186.4" y2="205"/><line x1="257.6" y1="200" x2="257.6" y2="205"/><line x1="328.8" y1="200" x2="328.8" y2="205"/><line x1="400" y1="200" x2="400" y2="205"/>
  </g>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="44" y="218">0</text><text x="115.2" y="218">2</text><text x="186.4" y="218">4</text><text x="257.6" y="218">6</text><text x="328.8" y="218">8</text><text x="400" y="218">10</text>
    <text x="222" y="236">true time (minutes; not to scale)</text>
    <text transform="translate(28,105) rotate(-90)">clock reading</text>
  </g>
  <line x1="44" y1="184.1" x2="400" y2="49" stroke-width="1.5" stroke-dasharray="6 5" style="stroke: var(--viz-muted)"/>
  <polyline points="44,163.4 186.4,102.2 400,21.1" stroke-width="2.5" style="fill: none; stroke: var(--viz-c2)"/>
  <polyline points="44,179.3 186.4,118.1 186.4,130.1 328.8,68.8 346.2,68.8 400,45.6" stroke-width="2.5" stroke-linejoin="round" style="fill: none; stroke: var(--viz-c3)"/>
  <line x1="186.4" y1="118.1" x2="186.4" y2="130.1" stroke-width="3.5" style="stroke: var(--viz-bad)"/>
  <line x1="328.8" y1="68.8" x2="346.2" y2="68.8" stroke-width="3.5" style="stroke: var(--viz-warn)"/>
  <text x="80" y="58" font-size="12">NTP slews its rate,</text>
  <text x="80" y="72" font-size="12">never jumps it</text>
  <line x1="196" y1="76" x2="203" y2="90" style="stroke: var(--viz-muted)"/>
  <line x1="190" y1="133" x2="202" y2="148" style="stroke: var(--viz-muted)"/>
  <text x="204" y="162" font-size="12" style="fill: var(--viz-bad)">NTP step: the clock</text>
  <text x="204" y="176" font-size="12" style="fill: var(--viz-bad)">jumps back 0.8 s</text>
  <line x1="338" y1="73" x2="352" y2="111" style="stroke: var(--viz-muted)"/>
  <text x="410" y="124" font-size="12" text-anchor="end" style="fill: var(--viz-warn)">23:59:60 leap second:</text>
  <text x="410" y="138" font-size="12" text-anchor="end" style="fill: var(--viz-warn)">a second repeats or stalls</text>
  <line x1="20" y1="257" x2="38" y2="257" stroke-width="3" style="stroke: var(--viz-c2)"/>
  <text x="46" y="261" font-size="13"><tspan font-weight="700">monotonic clock</tspan><tspan style="fill: var(--viz-muted)">: how long did it take?</tspan></text>
  <line x1="20" y1="280" x2="38" y2="280" stroke-width="3" style="stroke: var(--viz-c3)"/>
  <text x="46" y="284" font-size="13"><tspan font-weight="700">time-of-day clock</tspan><tspan style="fill: var(--viz-muted)">: when did it happen?</tspan></text>
  <line x1="20" y1="303" x2="38" y2="303" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-muted)"/>
  <text x="46" y="307" font-size="13">true time</text>
</svg>`,
          caption: `Schematic, with the errors exaggerated. Both clocks come from the same drifting crystal. The time-of-day clock (amber) is stepped back by NTP and stalls during a leap second, so subtracting two of its readings can give nonsense. The monotonic clock (cyan) starts at an arbitrary value and only has its rate adjusted, so differences between its readings stay trustworthy.`,
        },
        {
          type: "text",
          html: `<h3>How far off can a clock be?</h3>
<p>Further than most people assume. Quartz drift depends on temperature, among other things. Google assumes a drift of up to <strong>200 parts per million</strong> for its servers: about 6 ms of error for a clock resynchronized every 30 seconds, or about 17 seconds for one resynchronized once a day (200 × 10<sup>−6</sup> × 86,400 s ≈ 17.3 s). Synchronization itself is fragile, too:</p>
<ul>
<li>If the local clock differs too much from the NTP server, NTP may refuse to synchronize, or step the clock abruptly, so applications see time jump forwards or backwards.</li>
<li>A node accidentally firewalled off from its NTP servers can drift for a long time before anyone notices.</li>
<li>NTP can be no more accurate than the network delay allows. One experiment cited in the book measured a minimum error of about 35 ms when synchronizing over the internet, with occasional spikes to around a second when the network was congested.</li>
<li>Some NTP servers are simply wrong, reporting time hours off. Clients defend themselves by querying several servers and discarding outliers, but it's unsettling to have correctness depend on strangers' servers.</li>
<li><strong>Leap seconds</strong> make a minute 59 or 61 seconds long, which software assuming 60-second minutes has repeatedly mishandled. The cleanest fix is a <strong>leap smear</strong>: NTP servers deliberately report slightly wrong time, spreading the extra second over a whole day so no clock ever shows 23:59:60. Whether a given NTP server smears varies, and mixing smeared and unsmeared sources gives clocks that disagree by up to a second.</li>
<li>In a <strong>virtual machine</strong> the hardware clock is virtualized. When the VM is paused for tens of milliseconds while another uses the CPU core, the application sees the clock suddenly jump forward.</li>
<li>On devices you don't control, such as phones and embedded devices, the clock may be deliberately wrong: users change the date to get around time limits in games. Never trust a client's clock for anything important.</li>
</ul>
<p>High accuracy is achievable when someone pays for it. The European MiFID II regulation requires high-frequency trading firms to keep their clocks within <strong>100 microseconds</strong> of UTC, so that market events can be reconstructed afterwards. Meeting it takes GPS receivers, the <strong>Precision Time Protocol</strong> (PTP), and careful deployment and monitoring. Everyone else gets milliseconds on a good day, and nothing warns you when it's worse: the next section shows what that silence costs.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Measuring a timeout with the wall clock",
          html: `<p><code>if (System.currentTimeMillis() - lastHeartbeat &gt; 10_000) markDead(peer)</code> looks harmless. But if NTP steps the clock forward a few seconds, every peer is suddenly "dead"; step it back, and a dead peer stays "alive" until the clock catches up. The same applies to measuring a GC pause, a lease's remaining time, or request latency for a p99 dashboard. Whenever you subtract two timestamps to get a duration, use the monotonic clock. Wall-clock time is for labels that people or other machines will read.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Cloudflare",
              year: "2017",
              tag: "leap second",
              html: `During the leap second at the start of January 1, 2017, Cloudflare's Go-based DNS service (RRDNS) computed a duration from two wall-clock readings and got a negative number. Passing it to <code>rand.Int63n</code> caused a panic, and some DNS lookups failed. Go had no monotonic clock API at the time, so the patch simply stopped negative values from reaching the code that picks an upstream resolver. (The 2012 leap second struck through a Linux kernel bug instead; that correlated fault is in <a href="#/ch1/learn/fault-types">Chapter 1</a>.)`,
            },
            {
              org: "Google",
              tag: "leap smear",
              html: `Google smears each leap second linearly over 24 hours, from noon to noon UTC, so its servers never see 23:59:60, and its public NTP service serves the same smeared time. Because non-smearing servers step the clock instead, Google advises clients not to mix smeared and non-smeared NTP sources.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Three things have changed since 2017. <strong>Languages fixed the default</strong>: Go 1.9 (August 2017) made <code>time.Now()</code> record a monotonic reading alongside the wall time, so <code>time.Since</code> and <code>Sub</code> measure elapsed time correctly even when the wall clock is stepped, a change prompted partly by bugs like Cloudflare's. <strong>Leap seconds are being phased out</strong>: in November 2022 the General Conference on Weights and Measures (CGPM) resolved that the difference between UT1 and UTC may grow beyond one second by or before 2035, which in effect ends new leap seconds; until then they can still occur. <strong>Microsecond time became a cloud feature</strong>: Meta has described rolling out PTP across its datacenters, and in 2023 AWS began offering microsecond-accurate time through the Amazon Time Sync Service on supported EC2 instances.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A favorite code-review question shows a snippet that computes a timeout, a retry backoff or a request latency with <code>System.currentTimeMillis()</code> (or <code>Date.now()</code>, or Python's <code>time.time()</code>) and asks what could go wrong. A strong answer names the sources of jumps (NTP steps, leap seconds, an operator fixing the date), describes the symptoms (negative or inflated durations, timeouts that fire instantly or never, broken percentiles), and fixes it with the monotonic API: <code>System.nanoTime()</code>, <code>performance.now()</code>, <code>time.monotonic()</code>. Then it adds the other half: monotonic values mean nothing across machines, so they must never be stored or compared between nodes.</p>`,
        },
        {
          type: "quiz",
          q: "Which use of a clock is safe?",
          options: [
            "Comparing System.nanoTime() values from two servers to decide which request arrived first",
            "Enforcing a 30-second request timeout using differences of System.nanoTime() within one process",
            "Measuring a GC pause using differences of System.currentTimeMillis()",
            "Storing System.nanoTime() as a row's created_at so rows sort by creation time",
          ],
          answer: 1,
          explain: `A monotonic clock is for durations within one process, which is exactly B. Its absolute value is arbitrary and differs from machine to machine (and from one boot to the next), so comparing readings across servers (A) or storing them as timestamps (D) is meaningless. C is the tempting one because it looks like ordinary timing code, but wall-clock differences can come out negative or inflated if NTP steps the clock during the pause being measured.`,
        },
      ],
    },
    // ------------------------------------------------------------------ 5
    {
      id: "ordering-by-timestamps",
      title: "Timestamps lie unless you know the error bars",
      kicker: "Relying on clocks",
      concepts: ["clock-skew-ntp-drift", "clock-confidence-interval", "physical-vs-logical-clocks", "google-truetime-bounded-uncertainty", "commit-wait"],
      blocks: [
        {
          type: "problem",
          html: `<p>Many systems need to decide which of two events, on two different nodes, happened first. <strong>Last-write-wins</strong> (LWW) conflict resolution keeps whichever write carries the highest timestamp; Cassandra uses it, and Riak offers it as an option. Snapshot isolation spread across partitions needs transaction IDs that reflect which transaction committed first. The tempting approach is to stamp each event with the local wall clock.</p>
<p>With only a few milliseconds of clock skew, that silently loses data. A write that happened later, and even depended on an earlier write, can receive the smaller timestamp and be discarded on every replica. The database acknowledged it, and no error was ever raised. Handing out timestamps from one global counter instead avoids clocks altogether, but that counter becomes a bottleneck and a single point of failure as the system grows.</p>`,
        },
        {
          type: "idea",
          html: `<p>A clock reading is really an <strong>interval</strong>, so two events can be ordered by time only when their intervals don't overlap. Spanner makes that true by <strong>waiting out the uncertainty</strong> before a commit becomes visible.</p>`,
        },
        {
          type: "text",
          html: `<h3>How a later write loses</h3>
<p>Take three replicas of a key x under last-write-wins, where node 1's clock runs <strong>3 ms ahead</strong> of the others, an entirely ordinary amount of NTP skew. Client A writes <code>x = 1</code> through node 1 at a true time of 42.001 s, and node 1 stamps it with its own clock: <strong>42.004</strong>. The write replicates to nodes 2 and 3. Client B then reads <code>x = 1</code> from node 3, increments it, and writes <code>x = 2</code> through node 3 at a true time of 42.003 s, which node 3's accurate clock stamps <strong>42.003</strong>.</p>
<p>B's write happened later in real time and causally depended on A's: B read A's value before writing. Yet its timestamp is smaller. Every replica compares 42.003 with 42.004 and keeps A's value, node 3 included. The replicas converge, exactly as LWW promises, on <code>x = 1</code>. The increment is gone, and client B was told it succeeded. The book walks through the same scenario; below you can bend the clocks yourself.</p>`,
        },
        {
          type: "viz",
          id: "ch8/clock-skew-lww",
          title: "Skewed clocks eat writes",
          caption: `Try the Book example first: Node 1's clock is 3 ms ahead, so A's earlier write carries the larger timestamp, and B's increment is discarded on every replica even though B got an acknowledgment. Drag Node 1's clock back to 0 and x = 2 survives; set it to +2 ms and the timestamps tie, so the winner is decided by the node-ID tiebreaker rather than by what happened first. Then pick Lagging writer and notice that B's retries are thrown away until Node 3's clock catches up with A's timestamp.`,
        },
        {
          type: "text",
          html: `<h3>Three ways last-write-wins goes wrong</h3>
<ol>
<li><strong>Writes vanish without an error.</strong> A node with a lagging clock can't overwrite a value written by a node with a fast clock until the skew between them has elapsed. Until then, its writes and any retries of them are acknowledged and dropped: arbitrary data loss.</li>
<li><strong>It can't tell "one after another" from "concurrent".</strong> B's write was a causal successor of A's, yet LWW treated it as just another competing value. Telling sequential writes from truly concurrent ones takes causality tracking, such as Chapter 5's <a href="#/ch5/learn/concurrent-writes">version vectors</a>.</li>
<li><strong>Timestamps collide.</strong> Two nodes can produce the same timestamp, especially at millisecond resolution. A tiebreaker such as a random number or a node ID then picks the winner arbitrarily, possibly against causality.</li>
</ol>
<p>Generating timestamps on the client doesn't help; it moves the skewed clock somewhere you control even less. Nor does better NTP fix it in general. LWW would be safe only if clock error were much smaller than the gap between causally related writes, and NTP's accuracy is limited by network round-trip times, which can easily be as long as those gaps. The underlying flaw is that "most recent" is defined by a local clock that may be wrong.</p>
<p>The alternative is to stop asking clocks about order. Time-of-day and monotonic clocks are <strong>physical clocks</strong>: they measure elapsed time. <strong>Logical clocks</strong> are counters that increment on events; they capture only relative order (which event happened before which), carry no time-of-day meaning, and are immune to skew. Chapter 9's <strong>Lamport timestamps</strong> give a total order consistent with causality but can't detect concurrency; Chapter 5's <strong>version vectors</strong> can.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "Clock faults are silent",
          html: `<p>A cut cable announces itself: requests fail and alerts fire. A drifting clock doesn't. Everything keeps working while writes quietly lose comparisons they should have won, leases expire early or late, and logs fall out of order. If you run software that depends on synchronized clocks, treat clock offset as a health metric: monitor it on every node, and declare a node dead (stop sending it writes) when its clock drifts past a threshold, before it can do damage.</p>`,
        },
        {
          type: "text",
          html: `<h3>A clock reading is really an interval</h3>
<p>A timestamp like 42.003817 looks precise to the microsecond. But if the clock was last synchronized by NTP over a congested network, the reading may be off by tens of milliseconds, and most of those digits are noise. It's more honest to treat each reading as a <strong>confidence interval</strong>: "the true time is somewhere between 41.993 and 42.013, probably near 42.003".</p>
<p>The width of that interval can actually be computed. For a GPS receiver or an atomic clock, the manufacturer quotes an expected error range. For an NTP-synchronized server, the uncertainty is the quartz drift accumulated since the last synchronization, plus the NTP server's own uncertainty, plus the network round-trip time to that server. The trouble is that everyday APIs such as <code>clock_gettime()</code> and <code>System.currentTimeMillis()</code> return a bare number and say nothing about how wrong it might be, so systems silently treat a guess as a fact.</p>`,
        },
        {
          type: "diagram",
          title: "When can you trust timestamp order?",
          svg: `<svg viewBox="0 0 420 256" style="max-width: 560px; margin: 0 auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two pairs of clock-reading intervals on a time axis from 10.0 to 11.0 seconds: disjoint intervals give a certain order, overlapping intervals leave the order unknown">
  <text x="20" y="18" font-size="13" font-weight="700">Disjoint <tspan font-weight="600" style="fill: var(--viz-ok)">· A before B, for certain</tspan></text>
  <rect x="20" y="28" width="152" height="22" rx="4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="28" y="44" font-size="12" font-weight="700">A</text>
  <circle cx="96" cy="39" r="5" style="fill: var(--viz-c6); stroke: var(--viz-bg)"/>
  <rect x="248" y="28" width="152" height="22" rx="4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <text x="256" y="44" font-size="12" font-weight="700">B</text>
  <circle cx="324" cy="39" r="5" style="fill: var(--viz-c5); stroke: var(--viz-bg)"/>
  <text x="20" y="86" font-size="13" font-weight="700">Overlapping <tspan font-weight="600" style="fill: var(--viz-warn)">· order unknown</tspan></text>
  <rect x="134" y="94" width="114" height="54" rx="4" stroke-dasharray="4 3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <rect x="20" y="100" width="228" height="18" rx="4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="28" y="113" font-size="12" font-weight="700">A</text>
  <circle cx="134" cy="109" r="5" style="fill: var(--viz-c6); stroke: var(--viz-bg)"/>
  <rect x="134" y="124" width="228" height="18" rx="4" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/>
  <text x="146" y="137" font-size="12" font-weight="700">B</text>
  <circle cx="248" cy="133" r="5" style="fill: var(--viz-c5); stroke: var(--viz-bg)"/>
  <text x="191" y="163" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-warn)">overlap</text>
  <line x1="20" y1="176" x2="400" y2="176" style="stroke: var(--viz-muted)"/>
  <g style="stroke: var(--viz-muted)">
    <line x1="20" y1="176" x2="20" y2="181"/><line x1="96" y1="176" x2="96" y2="181"/><line x1="172" y1="176" x2="172" y2="181"/><line x1="248" y1="176" x2="248" y2="181"/><line x1="324" y1="176" x2="324" y2="181"/><line x1="400" y1="176" x2="400" y2="181"/>
  </g>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="22" y="196">10.0 s</text><text x="96" y="196">10.2</text><text x="172" y="196">10.4</text><text x="248" y="196">10.6</text><text x="324" y="196">10.8</text><text x="398" y="196">11.0 s</text>
  </g>
  <rect x="20" y="214" width="24" height="12" rx="3" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="52" y="224" font-size="12">band: where the true time could be</text>
  <circle cx="32" cy="244" r="5" style="fill: var(--viz-ink); stroke: none"/>
  <text x="52" y="248" font-size="12">dot: the one number clock_gettime() returns</text>
</svg>`,
          caption: `Top: the intervals don't overlap, so A happened before B whatever the clock errors were. Bottom: the dots (10.3 and 10.6) suggest A came first, but the intervals overlap, so the true order could be either way. An ordinary clock API hands you only the dots.`,
        },
        {
          type: "text",
          html: `<h3>Why anyone wants clock-based order: transaction IDs</h3>
<p>Trustworthy timestamps would be worth a lot. <strong>Snapshot isolation</strong> (Chapter 7) needs monotonically increasing transaction IDs, so a snapshot can tell which writes came before it (visible) and which after (invisible). On one node a counter does the job. Across partitions and datacenters, a single counter that every transaction must consult is a bottleneck and a single point of failure, yet independent per-node counters won't do either, because the IDs must respect causality: if transaction B read what A wrote, B needs the larger ID.</p>
<p>Distributed ID generators are a compromise. <strong>Twitter's Snowflake</strong>, for example, builds each 64-bit ID from a millisecond timestamp, a worker ID and a per-worker sequence number, so nodes mint IDs independently and they come out roughly sorted by time. "Roughly" is the catch: the IDs inherit clock skew, so they aren't consistent with causality across machines (Chapter 9 examines generators like this).</p>
<h3>TrueTime: put the error bars in the API</h3>
<p>Google's <strong>Spanner</strong> takes the other route: know how wrong the clock is, and act on it. Its <strong>TrueTime</strong> API returns an interval rather than a number: <code>TT.now()</code> gives <code>[earliest, latest]</code>, and under its stated assumptions the true time lies inside. Call the interval's half-width <strong>ε</strong> (epsilon). As in the diagram, if A's <em>latest</em> is before B's <em>earliest</em>, B definitely happened after A; if the intervals overlap, Spanner can't tell. It uses this to give read-write transactions timestamps whose order matches real time, through <strong>commit wait</strong>:</p>`,
        },
        {
          type: "steps",
          title: "Commit wait, step by step",
          items: [
            `Transaction T1 is ready to commit. Its coordinator calls <code>TT.now()</code> and picks the commit timestamp <span class="mono">s1&nbsp;=&nbsp;TT.now().latest</span>, a time no earlier than the true present.`,
            `It then <strong>waits</strong> until <code>TT.now().earliest &gt; s1</code>: until even the most pessimistic reading of the clock says s1 is in the past. Starting from an interval 2ε wide, that takes about <strong>2ε</strong>. Paxos replication of the commit runs in parallel with the wait.`,
            `Only then does T1 become visible: its locks are released and the client is told it committed.`,
            `Any transaction T2 that starts after that moment, on any node, takes its timestamp from its own <code>TT.now().latest</code>, which is at least the true time, which is already past s1. So <span class="mono">s2&nbsp;&gt;&nbsp;s1</span>, wherever T2 runs.`,
          ],
        },
        {
          type: "text",
          html: `<p>The wait turns "my clock is probably right" into a guarantee, and it costs about 2ε on every read-write commit, so Google works hard to keep ε small. Each datacenter has time-master servers with GPS receivers or atomic clocks, and every machine runs a daemon that polls them. The book puts Spanner's synchronization at about 7 ms. The 2012 Spanner paper shows ε as a sawtooth between roughly 1 and 7 ms: it grows at the assumed 200 ppm drift rate over the 30-second polling interval (up to 6 ms), on top of about 1 ms for communicating with the time masters, and averages about 4 ms.</p>
<p>In the sandbox below, two transactions run on two nodes whose clocks are wrong by amounts the nodes themselves don't know. T2 starts only after T1 is visible, as if a user saw T1's confirmation and then acted.</p>`,
        },
        {
          type: "viz",
          id: "ch8/commit-wait",
          title: "TrueTime and commit wait",
          caption: `Try the opening state: with commit wait off and worst-case clock errors, T2 starts after T1 is visible yet gets the smaller timestamp, so its snapshot misses T1. Turn on Commit wait and the order is fixed, at a visible cost of 2ε of latency; drag ε to watch the price grow. Then pick Broken clock, where both clocks are off by more than the ε they promise: even with commit wait on, T2 gets the smaller timestamp again, unless you drag the gap long enough to cover the error by luck.`,
        },
        {
          type: "text",
          html: `<p>Two lessons come out of the sandbox. First, commit wait works <em>whatever</em> the actual clock errors are, as long as they stay within ±ε: a node never needs to know how wrong its clock is, only the bound. Second, everything rests on that bound being true. If a clock's real error exceeds ε, its interval no longer contains the true time, the wait ends too early, and ordering breaks silently. That's why Spanner's time daemons assume a conservative drift rate and why machines whose clocks misbehave are evicted.</p>
<p>Because the wait overlaps with the Paxos replication a commit needs anyway, it costs less than it seems, but it still sets a floor of about 2ε under commit latency. The book (2017) called clock-based transaction ordering an area of active research outside Google; the cards below show where it has gone since.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache Cassandra",
              tag: "LWW per cell",
              html: `Cassandra resolves conflicting writes per cell by timestamp, in microseconds, assigned by the coordinator or supplied by the client (CQL even has <code>USING TIMESTAMP</code>). A node or client with a fast clock makes its writes win over later ones, and writes stamped by a slow clock can be silently ignored.`,
            },
            {
              org: "Google Spanner",
              year: "OSDI 2012",
              tag: "TrueTime",
              html: `TrueTime is backed by time masters with GPS receivers or atomic clocks in every datacenter, plus a time daemon on every machine. Read-write transactions perform commit wait of roughly 2ε, overlapped with Paxos replication, which is how Spanner offers externally consistent (strictly serializable) transactions across continents.`,
            },
            {
              org: "Twitter Snowflake",
              year: "2010",
              tag: "ID generation",
              html: `Snowflake packs a 41-bit millisecond timestamp, a 10-bit worker ID and a 12-bit sequence number into a 64-bit ID: roughly time-sortable across machines, but not causally ordered. The original implementation refuses to generate IDs if it sees its clock move backwards.`,
            },
            {
              org: "CockroachDB",
              tag: "HLC + uncertainty",
              html: `Uses hybrid logical clocks with a configured maximum clock offset (500 ms by default). A read that meets a value inside its uncertainty window restarts at a higher timestamp instead of guessing, and a node whose clock drifts too far from the rest of the cluster shuts itself down rather than risk violating consistency.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Clock-aware transactions have spread well beyond Google. <strong>CockroachDB</strong> and <strong>YugabyteDB</strong> use <strong>hybrid logical clocks</strong> (HLC; Kulkarni et al., 2014): timestamps that pair physical time with a logical counter, so they stay close to wall-clock time while never going backwards and always respecting causality between messages. Instead of commit wait, they bound clock offset by configuration and restart reads that land in the uncertainty window, which is cheaper per commit but means correctness again depends on the offset bound holding. On the infrastructure side, AWS's open-source <strong>ClockBound</strong> exposes time as an interval with an error bound, TrueTime-style, and AWS's microsecond-accurate time sync narrows that interval on supported instances.</p>`,
        },
        {
          type: "compare",
          title: "Three ways to order events across nodes",
          items: [
            {
              title: "Wall-clock timestamps",
              tone: "bad",
              html: `Cheap and local, and they look like real time. With skew, a later write can get a smaller timestamp and be discarded silently. Fine for logs and display; dangerous for deciding which write wins.`,
            },
            {
              title: "Logical clocks",
              tone: "ok",
              html: `Lamport timestamps or version vectors: counters that follow causality and are immune to skew. They say nothing about real time, so an event that happened later on another node, with no message between them, may still get the smaller value.`,
            },
            {
              title: "TrueTime + commit wait",
              tone: "info",
              html: `Real-time order across the planet: if T1 finished before T2 started, s1 &lt; s2. Costs about 2ε of latency on every read-write commit, plus GPS and atomic-clock infrastructure to keep ε small, and holds only while clock errors stay within ε.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Two prompts come up often. First: "Users say their edits sometimes don't save, but we never see errors" on a last-write-wins store. A strong answer suspects clock skew between coordinators, explains how a later write with a smaller timestamp is acknowledged and then shadowed, and proposes fixes in order of strength: alert on clock offset; stop using LWW where losing an update matters (conditional writes such as Cassandra's lightweight transactions, version vectors with merges, or CRDTs); route causally related writes through one leader. Second: "How does Spanner get externally consistent transactions across continents?" Answer with TrueTime intervals, s = TT.now().latest, and a wait until TT.now().earliest &gt; s (about 2ε) before acknowledging, overlapped with Paxos, and the caveat that it holds only while every clock's error really stays within ε.</p>`,
        },
        {
          type: "quiz",
          q: "Spanner's uncertainty ε is 5 ms. T1 commits on a node in Iowa; 1 ms after T1's commit is acknowledged, T2 starts on a node in Belgium. Why is T2 guaranteed a larger timestamp than T1?",
          options: [
            "Atomic clocks keep all Spanner servers perfectly synchronized",
            "T1 waited until true time was guaranteed to be past its timestamp before acknowledging, and any node's TT.now().latest is at least the true time, so T2's timestamp must be larger",
            "T2 asks T1's node for its latest timestamp before starting",
            "The Paxos leader in Iowa assigns all timestamps in order",
          ],
          answer: 1,
          explain: `The guarantee comes from commit wait. T1's timestamp is TT.now().latest at commit time, and T1 isn't acknowledged until TT.now().earliest has passed it, so by then the true time is already later than s1. Every node's interval contains the true time, so the timestamp T2 later takes (its own TT.now().latest) must be larger, wherever it runs. A is the tempting answer, but GPS and atomic clocks only make ε small, never zero; that's why the wait is needed at all. No cross-node query happens (C), and Paxos orders writes within one replica group (D), while T2 may involve entirely different groups. The guarantee holds only while every clock's error really stays within ε.`,
        },
      ],
    },
  ],
});
