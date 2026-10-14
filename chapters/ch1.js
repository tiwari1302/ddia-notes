// Chapter 1: Reliable, Scalable, and Maintainable Applications
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch1",
  part: 1,
  number: 1,
  title: "Reliable, Scalable, and Maintainable Applications",
  tagline: "What it really means for a data system to keep working, keep up, and keep changing as faults, load and years pile up.",
  overview: `<p>Many applications today are limited not by CPU but by data: how much of it there is, how complex it is and how fast it changes. They are assembled from standard pieces (databases, caches, search indexes, stream and batch processors), and once application code stitches those pieces together behind an API, its authors have built a new <strong>data system</strong> whose cross-component guarantees nobody else provides. This chapter sets up the vocabulary for judging any such system, and the rest of the book leans on it.</p>
<p>Three concerns frame it. <strong>Reliability</strong>: keep working correctly when hardware, software and people fail. <strong>Scalability</strong>: have a plan for growth along a named load parameter. <strong>Maintainability</strong>: let many people operate, understand and change the system for years. The central tension is that they pull against each other: redundancy and scale-out add moving parts that make a system harder to operate and reason about, while the simplest design, one machine, has no fault tolerance and a hard capacity ceiling.</p>
<p>The ideas build in sequence. Faults are inevitable, so the goal is to stop them from becoming failures; because correlated faults (a shared bug, a change pushed everywhere) defeat redundancy, change management matters as much as spare hardware. Scalability starts with describing load (Twitter's fan-out) and performance (percentiles, not averages), which leads to queueing, tail latency amplification and the choice between scaling up and scaling out. Maintainability closes the loop: most of the cost arrives after launch, and simplicity through good abstractions is what lets a system keep evolving.</p>`,

  concepts: [
    // ── data-systems ─────────────────────────────────────────────
    {
      id: "data-intensive",
      term: "Data-intensive application",
      def: `An application whose main challenges are the <em>amount</em> of data, its <em>complexity</em>, and the <em>speed at which it changes</em>, rather than raw CPU power. It is assembled from standard building blocks: databases, caches, search indexes, stream processing and batch processing.`,
      problem: `CPU stopped being the bottleneck for many applications; data volume, variety and rate of change did, and no single tool handles all of it.`,
      why: `It changes the engineering question from "how do I compute this quickly?" to "how do I store, find, keep consistent and move this data as it grows and changes?" The tool categories also blur: Redis, a datastore, is widely used as a job queue, and Kafka, a message log, is used as a durable system of record. So it pays to reason about <strong>data systems</strong> in general rather than product categories.`,
      ex: `A photo-sharing app spends little CPU per request but must durably store originals, cache feeds, index captions for search, queue thumbnail jobs and run nightly analytics: five data jobs, each usually served by a different tool (for example PostgreSQL, Redis, Elasticsearch, a queue such as Kafka or SQS, and a batch engine such as Spark).`,
      section: "data-systems",
    },
    {
      id: "composite-data-system",
      term: "Composite data system",
      def: `A special-purpose data system that application code builds by combining general-purpose components (e.g. database + cache + search index + queue) behind its own API. The application, not any one component, must provide guarantees such as "the cache is invalidated or updated on every write".`,
      problem: `Each tool does one job well, so applications combine several, but nothing makes the combination correct unless the designer does.`,
      why: `Every component keeps its own promises, but promises <em>between</em> components exist only in your code. Getting them wrong produces bugs that no individual component considers a bug: a crash between "write the database" and "invalidate the cache", or a race where a slow reader puts a stale value back into the cache just after a writer deleted it. Chapters 11 and 12 show sturdier ways to keep derived data in sync, such as change data capture.`,
      ex: `Facebook's look-aside memcache ("Scaling Memcache at Facebook", NSDI 2013): web servers read memcache, fall back to MySQL on a miss and fill the cache; on a write they update MySQL and delete the cache key. Daemons (mcsqueal) tail each database's commit log and broadcast deletes to the cache clusters in that region, and "leases" were added to prevent stale sets and thundering herds.`,
      section: "data-systems",
    },
    {
      id: "nonfunctional-requirements",
      term: "Functional vs nonfunctional requirements",
      def: `Functional requirements say what the system does (store, retrieve, search, process data). Nonfunctional requirements are properties it must have while doing it: reliability, scalability and maintainability, plus security, compliance and compatibility.`,
      problem: `Feature checklists pass on launch day; systems fail later on properties that nobody wrote down.`,
      why: `Nonfunctional properties drive the architecture: two systems with identical features can need entirely different designs because one must survive a zone outage, serve 100× the traffic or be changed weekly by 50 engineers. Putting numbers on them early turns arguments about "quality" into requirements you can test. Non-technical forces shape them too: team skills, legacy dependencies, time to market, risk tolerance and regulation.`,
      ex: `An illustrative checkout service. Functional: charge the card and record the order. Nonfunctional: never charge twice even if the client retries (reliability); p99 under 500 ms at 10× normal peak traffic (scalability); any engineer can safely change the tax rules (maintainability); PCI DSS compliance (security and compliance).`,
      section: "data-systems",
    },

    // ── reliability ─────────────────────────────────────────────
    {
      id: "reliability",
      term: "Reliability",
      def: `Continuing to work correctly even when things go wrong. Users expect four things: the application does what they expected; it tolerates their mistakes and unexpected use; its performance is good enough for the use case at the expected load and data volume; and it prevents unauthorized access and abuse. Reliability is broader than uptime: wrong answers, lost data and security breaches are reliability failures even while the service is "up".`,
      problem: `Systems built assuming nothing goes wrong lose data or go down when (not if) components fail, users err, or attackers probe.`,
      why: `Faults can't be driven to zero, so reliability is a design property (how the system behaves while parts are broken), not a hope. It matters beyond "critical" systems: bugs in business applications cost productivity and can create legal risk when figures are reported wrongly, e-commerce outages cost revenue and reputation, and a photo app that loses a family's pictures has failed its users. Cutting reliability to save cost (a prototype, a thin-margin service) can be valid, but it should be a conscious choice.`,
      ex: `Netflix's Chaos Monkey randomly terminates production instances during business hours so that every service must survive instance loss; its sibling Chaos Kong simulates losing an entire AWS region.`,
      section: "reliability",
    },
    {
      id: "fault-vs-failure",
      term: "Fault vs failure",
      def: `A <strong>fault</strong> is one component deviating from its spec (a disk dies, a process crashes, a dependency returns garbage). A <strong>failure</strong> is the system as a whole no longer providing the required service to users. Fault tolerance is the machinery between the two: detection, containment and recovery that stop faults from becoming failures.`,
      problem: `Without separating a broken component from a user-visible outage, teams either chase zero faults (impossible) or ignore faults until they become outages.`,
      why: `It changes the goal from "no faults" to "no failures from the faults we expect", and it changes what you measure: track failures (user-visible errors, SLO burn) and treat faults as routine signals, as long as redundancy and headroom remain.`,
      ex: `A disk dying is a fault; the site returning errors is a failure. If one of 12 app servers crashes and the load balancer routes around it before any request fails, a fault occurred and no failure did. If the health check takes two minutes to notice, about 1 in 12 requests fails meanwhile: the fault leaked into a partial failure.`,
      section: "reliability",
    },
    {
      id: "fault-tolerance",
      term: "Fault tolerance (resilience)",
      def: `The ability to keep providing correct service despite certain kinds of faults. It is always relative to a stated set of faults: no system tolerates every possible fault.`,
      problem: `At scale some component is always broken; preventing every fault is impossible, so systems must keep working through them.`,
      why: `Because tolerance is relative, a reliability design must state which faults it survives (one machine? one zone? a bad deploy?) and which it doesn't; the book's joke is that surviving the Earth being swallowed by a black hole would need hosting in space. Prefer tolerating faults over preventing them, except where no cure exists: leaked sensitive data can't be un-leaked, so security relies on prevention.`,
      ex: `A PostgreSQL primary with a synchronous standby in another availability zone, plus automatic failover, survives losing the primary's machine or its whole zone without losing committed writes. It does not tolerate an operator dropping a table, because the drop replicates to the standby within moments; that fault needs backups and point-in-time recovery instead.`,
      section: "reliability",
    },
    {
      id: "chaos-engineering",
      term: "Deliberate fault injection (chaos engineering)",
      def: `Triggering faults on purpose (e.g. killing random processes or instances in production) so error-handling and recovery paths are exercised continuously and can be trusted when a real fault happens. Netflix's Chaos Monkey is the classic example.`,
      problem: `Many serious outages come from poorly tested error handling: recovery code that runs once a year doesn't work when it is finally needed.`,
      why: `Error-handling paths are the least exercised code in a system, and many critical bugs hide there. Injecting faults turns "we think failover works" into evidence and forces designs that assume any instance can vanish. Start small (staging, business hours, limited blast radius), inject latency as well as crashes, and widen the scope as confidence grows.`,
      ex: `Netflix first described Chaos Monkey in a December 2010 blog post, expanded on it in the 2011 "Simian Army" post and open-sourced it in 2012. Google runs company-wide Disaster Recovery Testing (DiRT) exercises (ACM Queue, 2012). AWS sells fault injection as a managed service (Fault Injection Simulator, launched 2021, now AWS Fault Injection Service).`,
      section: "reliability",
    },
    {
      id: "availability",
      term: "Availability and the nines",
      def: `The fraction of time (or of requests) for which a service is usable, usually written as nines: 99.9% allows about 8.8 hours of downtime a year (≈44 minutes a month), 99.99% about 53 minutes a year. Roughly MTTF / (MTTF + MTTR), so faster recovery raises it as much as rarer failures. Dependencies a request needs multiply; independent redundant replicas combine as 1 − Π(1 − aᵢ), but only if their failures really are independent. (Standard SRE arithmetic, beyond the book.)`,
      problem: `"Highly available" means nothing until it is a number with a downtime budget, and teams that fight only failure frequency ignore the cheaper lever: recovery time.`,
      why: `Nines turn reliability goals into budgets: going from 99.9% to 99.99% cuts allowed downtime from about 8.8 hours to about 53 minutes a year, which rules out slow manual recovery. The formulas expose two traps: every hard dependency on the request path lowers the ceiling, and redundancy helps only as much as failures are independent. Availability is still only one slice of reliability: a service that is up but returns wrong data is unreliable.`,
      ex: `Four serial dependencies at 99.9% each give at most 0.999⁴ ≈ 99.6%, about 35 hours of downtime a year. Two independent replicas at 99% each give 1 − 0.01² = 99.99%, but a bad config pushed to both at once takes them down together and drags you back toward 99%.`,
      section: "reliability",
    },

    // ── fault-types ─────────────────────────────────────────────
    {
      id: "hardware-software-human-faults",
      term: "Hardware, software and human faults",
      def: `Three classes of fault that behave differently. <strong>Hardware</strong>: disks crash, RAM goes bad, power fails, someone unplugs the wrong cable; mostly random and independent across machines. <strong>Software</strong>: systematic errors such as a bug that crashes every node on one bad input, a runaway process exhausting a shared resource, a dependency that slows down or returns corrupt responses, and cascading failures; correlated across nodes, so they cause many more outages than hardware. <strong>Human</strong>: mistakes by the people who build and operate the system; one study of large internet services (Oppenheimer et al., 2003) found operator configuration errors were the leading cause of outages, while hardware played a role in only 10–25% of them.`,
      problem: `Each class behaves differently (independent vs correlated vs change-induced), so one defense, redundancy, can't cover all of them.`,
      why: `Each class needs its own defenses. Hardware: redundancy, and increasingly software that tolerates losing whole machines. Software: questioning assumptions, thorough testing, process isolation, letting processes crash and restart, monitoring production, and self-checks (e.g. a queue verifying messages in = messages out). Human: interfaces that make the right thing easy, sandboxes with real data, testing at every level, fast rollback and gradual rollout, tools to recompute data, clear telemetry, and training.`,
      ex: `Hardware: in a 10,000-disk cluster with a 30-year MTTF, about 0.9 disks die per day, i.e. roughly one. Software: the June 30, 2012 leap second triggered a Linux kernel bug that sent many Java and MySQL processes into high-CPU spinning at the same moment. Human: on February 28, 2017 a mistyped input to an established playbook command removed far more Amazon S3 servers in us-east-1 than intended, causing an outage of about four hours.`,
      section: "fault-types",
    },
    {
      id: "mttf",
      term: "MTTF at fleet scale",
      def: `Mean time to failure of one component (hard disks: roughly 10 to 50 years). Across N components expect about N / (MTTF × 365) failures per day: 10,000 / (30 × 365) ≈ 0.9 a day, i.e. roughly one dead disk per day in a 10,000-disk cluster.`,
      problem: `Per-component reliability figures sound reassuring but mislead at scale: a "once in 30 years" event becomes a daily chore.`,
      why: `Fleet arithmetic is why large systems moved from redundancy inside one box (RAID, dual power supplies) to software that tolerates losing whole machines, with replacement as a routine automated workflow. Use field data, not datasheets: Schroeder and Gibson (FAST 2007) found annual disk replacement rates of typically 2–4% in the field, versus under 1% implied by datasheet MTTFs.`,
      ex: `Jeff Dean's often-cited "first year of a new cluster" list (LADIS 2009 talk) includes roughly 1,000 individual machine failures and thousands of hard drive failures. With 20,000 disks at a 30-year MTTF you would plan for about 1.8 failures a day.`,
      section: "fault-types",
    },
    {
      id: "correlated-faults",
      term: "Systematic (correlated) faults",
      def: `Faults that hit many nodes at once because they share a cause: the same software bug, the same bad input, the same dependency or the same configuration. Unlike random hardware faults, they defeat redundancy.`,
      problem: `Redundancy assumes failures are independent; identical replicas running identical code fail together.`,
      why: `The redundancy formula 1 − Π(1 − a) assumes independence, so correlated faults are why real systems are far less available than the math promises. Defenses try to break the correlation: staged rollouts so a change reaches one cell first, isolated failure domains, diversity (hardware batches, firmware versions), watchdogs, and end-to-end checks. Hardware can correlate too: same batch, same firmware, same rack power.`,
      ex: `The 2012 leap second hit every server running the affected kernel at the same moment. Cloudflare (July 2, 2019) deployed a WAF rule containing a catastrophically backtracking regex globally at once, exhausting CPU and causing about 27 minutes of errors. CrowdStrike (July 19, 2024) pushed a faulty content file (Channel File 291) at once to every online Windows host running its Falcon sensor and crashed about 8.5 million devices, by Microsoft's estimate.`,
      section: "fault-types",
    },
    {
      id: "cascading-failure",
      term: "Cascading failure",
      def: `A small fault in one component triggers faults in others, which trigger more: e.g. a slow dependency causes timeouts, retries overload the next tier, which fails and shifts load onto the remaining nodes until they fail too.`,
      problem: `Components are coupled through load, retries and shared resources, so a local fault can spread system-wide.`,
      why: `It explains why a slow dependency is often worse than a dead one: a dead one fails fast, a slow one holds threads and connections (by Little's Law, in-flight requests = rate × latency). Standard defenses: timeouts on every remote call; bounded retries with exponential backoff and jitter (retry budgets); circuit breakers with fallbacks; separate pools per dependency (bulkheads); bounded queues and load shedding; graceful degradation of non-critical features.`,
      ex: `Illustrative: a recommendation service slows from 30 ms to 3 s. Product pages call it synchronously, so the web tier's shared thread pool fills with waiting calls and every other page queues behind them; callers retry, health checks time out, instances are pulled from the load balancer, and the survivors fall over too. A short timeout plus a circuit breaker that hides the widget would have contained it.`,
      section: "fault-types",
    },
    {
      id: "rolling-upgrade",
      term: "Rolling upgrade",
      def: `Upgrading or patching a multi-node system one node at a time while the rest keep serving, so the service never goes down.`,
      problem: `A single-server system needs planned downtime for every patch; once a system tolerates losing a machine, maintenance no longer requires downtime.`,
      why: `It is a dividend of software fault tolerance: if the system survives losing a node, you can take nodes down on purpose for OS security patches and upgrades. Old and new versions must coexist during the rollout, so data encodings and APIs need backward and forward compatibility (ch4). It pairs naturally with staged rollout: upgrade a canary, watch, then continue.`,
      ex: `Kubernetes Deployments use a RollingUpdate strategy by default, replacing pods a few at a time within the maxUnavailable and maxSurge limits; Cassandra and Elasticsearch clusters are routinely upgraded node by node while serving traffic.`,
      section: "fault-types",
    },

    // ── describing-load ─────────────────────────────────────────
    {
      id: "scalability",
      term: "Scalability",
      def: `A system's ability to cope with increased load (traffic, data volume or complexity). It is not a one-dimensional label: "X is scalable" says nothing. The useful questions are "if load grows along this dimension, what are our options?" and "how do we add resources to handle it?" Answering them needs a description of load (<em>load parameters</em>) and of performance (response-time percentiles, throughput).`,
      problem: `Load grows (users, data, traffic) and a design that works today can fall over at 10×; vague claims like "X scales" give no plan.`,
      why: `Growth along different dimensions breaks different things: 10× users may be fine while 10× data per user breaks the indexes, or a few accounts with 10× more followers break fan-out. Naming the dimension turns "will it scale?" into a plan with numbers and a known next bottleneck.`,
      ex: `Twitter in 2012 could absorb 12k tweets/s at peak without trouble; what stressed it was 300k timeline reads/s and the fan-out of each tweet to followers. Planning around request rate alone would have scaled the wrong thing.`,
      section: "describing-load",
    },
    {
      id: "load-parameters",
      term: "Load parameters",
      def: `The few numbers that describe load on a system, chosen to fit its architecture: requests/s to a web server, the read/write ratio of a database, simultaneously active users in a chat room, the hit rate of a cache, the fan-out per post in a feed. Often you need the <strong>distribution</strong> and the extremes, not just the average, because a handful of extreme cases may dominate the bottleneck.`,
      problem: `You can't reason about growth without naming the number that drives the work, and the obvious number (requests/s) is often not it.`,
      why: `The right load parameter is the one that dominates cost for your design. Pick the wrong one and capacity plans, benchmarks and optimizations all target a number that doesn't matter.`,
      ex: `Twitter, November 2012: 4.6k tweets/s on average (12k+ at peak) vs 300k timeline reads/s. With an average of 75 followers, fan-out turns that into 345k timeline writes/s, and some accounts had over 30M followers. The key parameter was the distribution of followers per user (weighted by how often they tweet), not the tweet rate.`,
      section: "describing-load",
    },
    {
      id: "twitter-home-timeline",
      term: "Twitter home timeline",
      def: `The book's scalability case study (data from Raffi Krikorian's November 2012 talk). <strong>Approach 1, fan-out on read</strong>: a tweet is one insert into a global table; reading a home timeline looks up everyone the user follows and merges their tweets by time. <strong>Approach 2, fan-out on write</strong>: each user has a cached home timeline (an inbox); posting looks up the author's followers and inserts the tweet into each inbox, so a read is one lookup. Twitter's first version used approach 1, switched to approach 2, and in 2012 was moving to a hybrid.`,
      problem: `Reads outnumbered tweets about 65 to 1 and computing timelines on read could not keep up, but pushing every tweet to every follower explodes for celebrity accounts.`,
      why: `Reads dominated (300k/s vs 4.6k tweets/s), so doing work at write time paid off: 4.6k × 75 = 345k inbox writes/s. But the average hides skew: an account with 30M+ followers turns one tweet into 30M+ writes, while Twitter aimed to deliver tweets within 5 seconds. Hence the hybrid: fan out most users' tweets on write, but fetch tweets from a small number of accounts with huge followings at read time and merge them in. The lesson: let the load distribution choose the strategy and treat the skewed head differently. Modern ranked feeds differ again, doing heavy candidate retrieval and ranking at read time.`,
      ex: `One tweet from a 30M-follower account under pure push means 30M+ timeline-cache writes; at an assumed (illustrative) 1M inbox writes/s that takes about 30 s, far past the 5-second goal, and delays everyone else's deliveries. Under the hybrid it is a single write, and each follower's read merges in that account's recent tweets.`,
      section: "describing-load",
    },
    {
      id: "fan-out",
      term: "Fan-out",
      def: `The number of requests to other services, or writes to other places, needed to serve one incoming request. Twitter's fan-out on write copies a tweet into every follower's home timeline; a search query fans out to every index shard.`,
      problem: `One user action can multiply into thousands of internal operations, so capacity must be planned for the multiplied work, not the user actions.`,
      why: `Fan-out multiplies both work and risk. Write fan-out sets how much background work one post creates; read fan-out sets how many backends one request waits on, which is what makes tail latency amplification bite. Its skew (celebrities, hot keys) usually matters more than its average, and the same problem returns as hot spots in partitioning (ch6).`,
      ex: `Twitter 2012: 4.6k tweets/s × 75 average followers = 345k inbox writes/s. A web search query is sent to every index shard, and the user waits for the slowest one.`,
      section: "describing-load",
    },

    // ── describing-performance ──────────────────────────────────
    {
      id: "response-time-vs-latency",
      term: "Response time vs latency",
      def: `<strong>Response time</strong> is what the client sees: network delays + queueing delays + <strong>service time</strong> (the time actually spent processing the request). <strong>Latency</strong>, in the book's sense, is the duration a request spends waiting to be handled, during which it is latent. In everyday use the two words are often interchangeable, so say which one you mean.`,
      problem: `Teams quoting "latency" often mean different things; separating waiting from work explains where slow requests actually spend their time.`,
      why: `Splitting waiting from work explains most slow requests: at high percentiles queueing often dominates, and a timer inside the handler (service time) can't see it. That is why response time should be measured on the client side, or at least at the load balancer.`,
      ex: `A handler that does 10 ms of work can produce a 900 ms response time for the client if the request waited behind a slow request, a GC pause or a saturated thread pool: service time 10 ms, response time 900 ms.`,
      section: "describing-performance",
    },
    {
      id: "percentiles",
      term: "Percentiles (p50, p95, p99, p99.9)",
      def: `Sort response times from fastest to slowest: the <strong>median (p50)</strong> is the halfway point; <strong>p95, p99 and p99.9</strong> are the thresholds that 95%, 99% and 99.9% of requests are faster than (the <em>tail</em>). Percentiles are per request, so a user who makes many requests is much more likely to hit the tail at least once (1 − 0.99<sup>k</sup> for k requests at p99). Amazon sets internal response-time targets at p99.9 because its slowest requests tend to belong to customers with long purchase histories, the ones it can least afford to annoy.`,
      problem: `Averages hide how many users actually waited a long time, and they are distorted by outliers.`,
      why: `The mean doesn't tell you how many users waited; tail percentiles track what slow users actually feel. The book reports Amazon's observation that a 100 ms increase in response time reduced sales by about 1% (and a separate report tying a one-second delay to a 16% drop in a customer-satisfaction score). Returns diminish, though: Amazon judged optimizing p99.99 too expensive, since the extreme tail is dominated by random events outside your control. Percentiles can't be averaged across hosts or time windows; aggregate histograms instead.`,
      ex: `If each backend call has a 1% chance of being slower than X and a page makes 100 calls, about 63% of pages are slower than X (1 − 0.99<sup>100</sup> ≈ 0.634). Amazon's Dynamo paper (2007) gives a typical internal SLA: respond within 300 ms for 99.9% of requests at a peak of 500 requests/s.`,
      section: "describing-performance",
    },
    {
      id: "throughput",
      term: "Throughput",
      def: `Work completed per unit time (records/s, requests/s, bytes/s). The main performance measure for batch systems; online systems care more about response time.`,
      problem: `Batch jobs and online services degrade in different ways, so "performance" needs a metric suited to each.`,
      why: `Throughput and response time are linked but not interchangeable: pushing a server toward maximum throughput raises utilization, and queueing then makes response time climb non-linearly. For batch jobs the ideal running time is dataset size ÷ throughput, but skew and waiting for the slowest task (stragglers, ch10) make it longer.`,
      ex: `A Spark job is judged by records per second or total time for its input; a checkout API by its p99 at peak. 100,000 requests/s of 1 kB each and 3 requests/minute of 2 GB each are both about 100 MB/s of throughput, yet need completely different architectures.`,
      section: "describing-performance",
    },
    {
      id: "slo-sla",
      term: "SLIs, SLOs and SLAs",
      def: `A service level indicator (SLI) is what you measure (e.g. the fraction of requests served in under 300 ms); a service level objective (SLO) is the internal target on it (e.g. 99.9% over 30 days); a service level agreement (SLA) is a contract with consequences, such as refunds, if targets like "median under 200 ms, p99 under 1 s, up 99.9% of the time" are missed. Latency targets are written with percentiles, not means. (The book uses SLO and SLA; SLI and error budgets come from Google's SRE practice.)`,
      problem: `"Fast" and "available" must be made precise and measurable before teams (and customers) can agree on whether a service is healthy.`,
      why: `Explicit targets make trade-offs decidable. An <strong>error budget</strong> (100% − SLO; 0.1% of 30 days ≈ 43 minutes) tells a team when to ship features and when to stop and fix reliability. Internal SLOs are set tighter than external SLAs so you get warned before you owe refunds. Latency SLIs should be percentiles or "fraction under a threshold", never the mean.`,
      ex: `The book's example SLA: the service counts as up if the median response time is under 200 ms and p99 is under 1 s, and it must be up at least 99.9% of the time. Google's "Site Reliability Engineering" book (2016) popularized SLIs, SLOs and error budgets as the contract between product velocity and reliability.`,
      section: "describing-performance",
    },
    {
      id: "percentile-aggregation",
      term: "Aggregating percentiles",
      def: `Percentiles from different machines or time windows can't be averaged. Combine the underlying distributions (add histograms, or merge sketches such as HdrHistogram, t-digest or DDSketch) and compute the percentile from the result.`,
      problem: `Dashboards combine hundreds of hosts and roll minutes up into hours; averaging p99s produces numbers that correspond to no real request and can hide a degraded host.`,
      why: `Dashboards always aggregate (across hosts, endpoints and time), so this is where tails get lost. The average of p99s can be too low or too high depending on the data; when one degraded host serves a slice of traffic it is typically too low, and the dashboard stays green while users suffer. Mergeable histograms and sketches make correct aggregation cheap; "fraction of requests under a threshold" adds up exactly.`,
      ex: `Prometheus documents that summary quantiles can't be meaningfully aggregated across instances, while histogram buckets can be summed and passed to histogram_quantile(). DDSketch (VLDB 2019) is a mergeable quantile sketch with relative-error guarantees built for exactly this.`,
      section: "describing-performance",
    },

    // ── queueing ────────────────────────────────────────────────
    {
      id: "head-of-line-blocking",
      term: "Head-of-line blocking (queueing delay)",
      def: `A server works on only a few requests at a time; the rest wait. One slow request at the head of the queue delays every request behind it, so clients see slow responses even for cheap requests. Waiting time grows sharply as utilization approaches 100%.`,
      problem: `Profiling shows a fast handler, yet users see slow responses: the missing time is waiting, which server-side timers don't measure.`,
      why: `At high percentiles queueing delay often makes up most of the response time, so the fix is usually less waiting, not a faster handler: keep headroom, separate slow and fast work into different queues or pools (bulkheads), bound queues and shed load, and set timeouts that account for waiting. For a textbook M/M/1 queue, response time = service time / (1 − utilization): 2× at 50% busy, 10× at 90% (standard queueing theory, beyond the book).`,
      ex: `One core, a 200 ms request at the head, four 10 ms requests behind it: the fast ones see about 210, 220, 230 and 240 ms although each needed 10 ms of work. Protocols have the same problem: HTTP/2 multiplexes streams over one TCP connection, but a lost packet still stalls all of them; HTTP/3 over QUIC (RFC 9114, 2022) removes that transport-level blocking.`,
      section: "queueing",
    },
    {
      id: "coordinated-omission",
      term: "Coordinated omission",
      def: `A load-testing error (term coined by Gil Tene): a generator that waits for each response before sending the next sends fewer requests exactly when the server is slow, so it records few slow samples and under-reports tail latency. Fix: send requests on a schedule that doesn't depend on responses and measure from the intended send time.`,
      problem: `Benchmarks showed excellent p99s while production suffered, because the test client politely paused whenever the server stalled.`,
      why: `Benchmarks decide capacity and compare designs. A closed-loop generator that pauses during a 2-second stall records one slow sample instead of one for every request real users would have sent meanwhile (2,000 at 1,000 req/s), so its tail can be off by orders of magnitude. The book states the rule without the name: the load-generating client must keep sending requests independently of response times.`,
      ex: `wrk2, Gil Tene's constant-throughput variant of the wrk HTTP benchmark, sends at a fixed rate and measures latency from each request's intended send time, recording into HdrHistogram. HdrHistogram can also approximately correct closed-loop data (recording with an expected interval back-fills the missing samples), though that is not identical to running an open-loop test.`,
      section: "queueing",
    },
    {
      id: "littles-law",
      term: "Little's Law",
      def: `For any stable system, the average number of requests in it equals arrival rate × average time each spends inside (L = λW). 20,000 req/s × 40 ms = 800 requests in flight. Standard queueing theory, not from the book.`,
      problem: `Capacity plans need to turn throughput and latency targets into threads, connections and servers, and to predict what happens to them when a dependency slows down.`,
      why: `It holds for long-run averages of any stable system regardless of arrival or service distributions, which makes it the workhorse of capacity estimates. It also explains cascades: if a dependency becomes 10× slower, W and therefore the number of occupied threads or connections grow about 10× at the same traffic, exhausting pools long before CPU is busy.`,
      ex: `800 requests in flight at 32 threads per server is 25 servers only at 100% utilization; at a 60–70% target it is about 36–42 servers, before adding headroom for losing a node or a zone. If the database behind it slows so that W goes from 40 ms to 310 ms, in-flight requests jump from 800 to about 6,200.`,
      section: "queueing",
    },

    // ── tail-latency ────────────────────────────────────────────
    {
      id: "tail-latency-amplification",
      term: "Tail latency amplification",
      def: `When one end-user request waits for many backend calls (even in parallel), it is as slow as the slowest call. If each call is slow with probability p, a request making n calls is slow with probability 1 − (1 − p)<sup>n</sup>: with p = 1% and about 70 calls (1 − 0.99<sup>69</sup> ≈ 0.50) a backend's p99 becomes the user's median; with 100 calls, 63% of requests are slow. Sequential calls add up as well.`,
      problem: `Pages and queries fan out to many backends; tuning each backend's average doesn't help because users wait for the slowest call.`,
      why: `Per-backend targets must be far tighter than the user-facing one: for a page making 50 parallel calls to be fast 99% of the time, each call must be fast about 99.98% of the time (0.99<sup>1/50</sup>). You can reduce fan-out (batching, caching, precomputing) or make the system tail-tolerant (hedged or tied requests, partial results), which is often cheaper than removing every source of backend slowness.`,
      ex: `Dean and Barroso, "The Tail at Scale" (CACM, 2013), which the book cites: a server that usually answers in 10 ms but takes a second for 1 request in 100 makes 63% of user requests slow when each must collect responses from 100 such servers. Batch jobs show the same effect: a job waits for its slowest task (stragglers, ch10).`,
      section: "tail-latency",
    },
    {
      id: "hedged-requests",
      term: "Hedged requests",
      def: `A tail-tolerant technique from Dean and Barroso's "The Tail at Scale" (beyond the book's own text): if a request hasn't returned within (say) the p95 latency, send a duplicate to another replica and use whichever answers first. Costs a few percent extra load; only safe for idempotent requests.`,
      problem: `With large fan-out, rare backend slowness dominates user latency, and eliminating every source of backend slowness is impossible.`,
      why: `A rescued call costs about the hedge delay plus one normal reply, far below the slow tail, and the extra load equals the fraction of calls that exceed the delay (at most about 5% with a p95 delay). It relies on slowness being independent across replicas: when all replicas are slow for a shared reason (overload, a bad deploy), hedging adds load exactly when the system can least afford it, so cap the hedge rate. Related techniques: tied requests (two servers cancel each other once one starts), partial results, and temporarily excluding slow machines.`,
      ex: `In The Tail at Scale's BigTable benchmark (reading 1,000 keys spread over 100 servers), hedging after a 10 ms delay cut p99.9 latency from 1,800 ms to 74 ms while sending only 2% more requests. Cassandra's per-table speculative_retry option (default 99p) and gRPC's hedging policy build the same idea into infrastructure.`,
      section: "tail-latency",
    },

    // ── coping-with-load ────────────────────────────────────────
    {
      id: "scaling-up-vs-scaling-out",
      term: "Scaling up vs scaling out",
      def: `<strong>Scaling up (vertical)</strong>: move to a more powerful machine; simple single-node semantics, but cost rises faster than capacity and there is a ceiling. <strong>Scaling out (horizontal)</strong>: spread load across many smaller machines, a <strong>shared-nothing</strong> architecture; no hard ceiling, but state must be partitioned and replicated. Good architectures are usually a pragmatic mixture: a few fairly powerful machines can be simpler and cheaper than many small VMs.`,
      problem: `One machine eventually runs out of capacity or becomes prohibitively expensive, but distributing state brings partitioning, replication and consistency problems.`,
      why: `Stateless services scale out easily; stateful data systems don't, so the common wisdom when the book was written (2017) was to keep the database on one node until cost or availability requirements force you to distribute it. Scaling up gives no fault tolerance (one machine is one failure domain), so availability often forces replication before load does. Since then, distributed SQL and managed serverless databases have made scale-out easier to adopt, while single machines kept getting bigger.`,
      ex: `Nick Craver's 2016 Stack Overflow architecture write-up described about 209 million HTTP requests a day served by nine primary web servers and four SQL Server machines (scale up); WhatsApp reported over 2 million concurrent connections on a single FreeBSD server in 2012. At very large scale, shared-nothing scale-out becomes unavoidable.`,
      section: "coping-with-load",
    },
    {
      id: "shared-nothing",
      term: "Shared-nothing architecture",
      def: `Scaling out across machines that each have their own CPU, memory and disks and coordinate only over the network (horizontal scaling).`,
      problem: `A single machine has a size and cost ceiling; beyond it, load must be spread across independent machines.`,
      why: `Nodes use commodity hardware and fail independently, so capacity and fault tolerance both grow by adding nodes, which can sit in different zones or regions. The price: data must be partitioned and replicated and nodes must coordinate over an unreliable network, the subject of Part II. The alternatives are shared-memory (one big machine) and shared-disk (several machines sharing one storage array).`,
      ex: `Cassandra, Kafka, Elasticsearch and CockroachDB clusters are shared-nothing: each node owns some partitions on its own disks and talks to the others only over the network.`,
      section: "coping-with-load",
    },
    {
      id: "elasticity",
      term: "Elastic vs manual scaling",
      def: `Elastic systems add or remove resources automatically as load changes; manually scaled systems change capacity when a human decides to. Elastic suits unpredictable load; manual scaling is simpler and has fewer operational surprises.`,
      problem: `Provisioning for the peak wastes money most of the day; provisioning for the average fails at the peak.`,
      why: `Auto-scaling saves money on gradual, unpredictable change, but it reacts after load rises (detection plus start-up time), so a sudden spike can outrun it; predictable peaks are better handled by scheduled pre-scaling. Manual scaling avoids feedback loops that thrash or follow a misleading metric. Stateless tiers are easy to make elastic; stateful ones need data rebalancing (ch6).`,
      ex: `AWS Auto Scaling groups and the Kubernetes Horizontal Pod Autoscaler add or remove capacity based on metrics such as CPU; AWS Lambda and DynamoDB on-demand (2018) scale per request. Many teams still scale databases by hand and pre-scale web tiers before a known launch or sale.`,
      section: "coping-with-load",
    },

    // ── operability ─────────────────────────────────────────────
    {
      id: "maintainability",
      term: "Maintainability",
      def: `Making it possible for many different people to work on the system productively over its lifetime: keeping it running, fixing bugs, adapting it to new requirements. The book splits it into three design principles: <strong>operability</strong> (easy to run), <strong>simplicity</strong> (easy to understand) and <strong>evolvability</strong> (easy to change).`,
      problem: `Most software cost comes after launch (operations, bug fixes, adaptation); systems not designed for it become legacy that everyone fears to touch.`,
      why: `The bulk of a system's cost is ongoing: keeping it operational, investigating failures, fixing bugs, moving to new platforms, adding use cases and repaying technical debt. No two legacy systems hurt in quite the same way, so there is no universal fix, but designing for the three principles from the start keeps a system from becoming one.`,
      ex: `Knight Capital (August 1, 2012): a manual deployment missed one of eight servers, where a repurposed flag reactivated long-dead code; in about 45 minutes the firm lost roughly $440–460 million (sources differ). Manual deploys, dead code and a reused flag are maintainability debts that became a business failure.`,
      section: "operability",
    },
    {
      id: "operability",
      term: "Operability",
      def: `Making it easy for operations teams to keep the system running smoothly. A data system helps by exposing its runtime behavior and internals (good monitoring); supporting automation and standard tools; not depending on any individual machine; offering good documentation and an easy-to-understand operational model ("if I do X, Y will happen"); providing good defaults that administrators can override; healing itself where appropriate while allowing manual control; and behaving predictably.`,
      problem: `Human error is a leading cause of outages and operations work never ends; systems that are opaque or unpredictable to operate are unreliable in practice.`,
      why: `A common observation, which the book repeats: a strong operations team can often make up for weak or unfinished software, while even excellent software fails when it is operated badly. Since human and configuration errors are a leading cause of outages, operability is a reliability feature: tools that make the safe action easy prevent the next outage. Automation helps, but people still have to set it up and check that it works.`,
      ex: `GitLab, January 31, 2017: during a replication incident an engineer deleted data on the primary database instead of the secondary, and recovery revealed that the regular backups had not been working; about 6 hours of database data (issues, merge requests, comments) were lost, though Git repositories were not. After S3's 2017 outage, AWS changed its capacity-removal tool to work more slowly and refuse to take a subsystem below its minimum capacity.`,
      section: "operability",
    },

    // ── simplicity-evolvability ─────────────────────────────────
    {
      id: "simplicity",
      term: "Simplicity (managing complexity)",
      def: `Making the system easy for new engineers to understand by removing <em>accidental</em> complexity: complexity the problem (as users see it) doesn't require. Simplicity doesn't mean fewer features, and it isn't the same as a simple user interface. The main tool is <strong>abstraction</strong>: a clean facade that hides implementation detail and doesn't lie about its properties.`,
      problem: `Large systems accumulate accidental complexity (coupling, special cases, hacks) that makes every change slow and risky.`,
      why: `The symptoms (state-space explosion, tight coupling, tangled dependencies, inconsistent naming, performance hacks, special cases) slow every change and raise the risk of bugs, because hidden assumptions and unexpected interactions are easy to miss. Simple systems are also easier to operate and to evolve.`,
      ex: `SQL hides on-disk data structures, concurrent access by other clients and recovery after crashes behind a declarative query; high-level languages hide machine code, registers and syscalls. Segment's 2018 "Goodbye Microservices" post describes collapsing over 140 per-destination services back into one because the split had added more complexity than it removed.`,
      section: "simplicity-evolvability",
    },
    {
      id: "evolvability",
      term: "Evolvability (extensibility)",
      def: `The ease of adapting a data system to new requirements: agility at the level of a whole data system (several applications or services), not a single codebase; also called extensibility, modifiability or plasticity. It depends heavily on simplicity and good abstractions, and on practices such as automated tests and refactoring.`,
      problem: `Requirements always change (features, regulations, scale), and systems that can't absorb change get rewritten at great cost.`,
      why: `New facts emerge, unanticipated use cases appear, priorities shift, platforms change, regulations change and growth forces architectural change. Simple, well-abstracted systems absorb these; brittle ones get rewritten. Later chapters supply the tools: schema evolution (ch4) and reprocessing derived data (ch10–12).`,
      ex: `Twitter "refactored" its timeline architecture from fan-out on read to fan-out on write while serving traffic. Stripe's "Online migrations at scale" (2017) describes a four-phase pattern for changing a live data model: dual-write to old and new, move reads, move writes, then remove the old data.`,
      section: "simplicity-evolvability",
    },
    {
      id: "accidental-complexity",
      term: "Accidental vs essential complexity",
      def: `Essential complexity is inherent in the problem as users see it; accidental complexity arises only from the implementation (Brooks, 1986; Moseley and Marks, 2006). Simplicity means removing the accidental kind, not removing features.`,
      problem: `Large systems turn into a "big ball of mud" where change is slow and risky, and much of that difficulty was never required by the problem.`,
      why: `The distinction tells you what you are allowed to remove. Essential complexity has to be handled somewhere (tax rules per country are part of the problem), but accidental complexity (workarounds for a leaky tool, duplicated logic, special cases) can be engineered away without cutting features. A useful design-review test: would a user notice if this complexity disappeared?`,
      ex: `Essential: ensuring an account balance never goes negative. Accidental: retry-and-dedupe code that exists only because a home-grown cache sometimes returns stale data. Amazon Prime Video (2023) reported cutting a monitoring pipeline's infrastructure cost by about 90% by moving it from a distributed Step Functions and Lambda design to a single process.`,
      section: "simplicity-evolvability",
    },
    {
      id: "abstraction",
      term: "Abstraction",
      def: `A clean interface that hides implementation detail and can be reused by many applications; e.g. SQL hides on-disk data structures, concurrency and crash recovery. Good abstractions don't lie about their properties.`,
      problem: `Without reusable abstractions every team re-solves the same hard problems, inconsistently and with bugs.`,
      why: `Good abstractions are reusable (one well-built component instead of many reimplementations), and improvements inside them benefit every user without code changes. Finding them is hard, especially for distributed systems, and much of the book is a search for good ones: transactions (ch7), consensus (ch9), logs (ch11). Leaky ones hide details you actually need, like an RPC framework that makes a network call look local and hides timeouts and partial failure (ch4, ch8).`,
      ex: `In December 2020 Amazon S3 became strongly consistent for read-after-write and list operations with no API change and no extra cost, so every application built on S3 benefited without changing a line.`,
      section: "simplicity-evolvability",
    },
  ],

  cheatsheet: [
    {
      title: "The three concerns at a glance",
      type: "table",
      headers: ["Concern", "Question it answers", "How to make it concrete", "Main tools"],
      rows: [
        [`<span style="white-space:nowrap">Reliability</span>`, "Does it keep working <em>correctly</em> when hardware, software or people fail?", "A named fault model; availability (nines), error rates, correctness and data-loss targets", "Redundancy, software fault tolerance, fault injection, staged rollout, fast rollback, monitoring"],
        [`<span style="white-space:nowrap">Scalability</span>`, "Do we have options when load grows along a named dimension?", "Load parameters (with their distribution); response-time percentiles; throughput", "Find the dominant parameter, scale up or out, caching, precomputation (fan-out on write), partitioning"],
        [`<span style="white-space:nowrap">Maintainability</span>`, "Can many people run, understand and change it for years?", "Operability, simplicity, evolvability", "Monitoring and automation with overrides, good abstractions, removing accidental complexity, compatible data formats"],
      ],
      note: "They pull against each other: redundancy and scale-out add moving parts; the simplest design (one machine) has no fault tolerance and a ceiling.",
    },
    {
      title: "Availability math (beyond the book)",
      type: "table",
      headers: ["Availability", "Downtime per year", "Downtime per month", "Failed requests allowed per 1M"],
      rows: [
        ["99% (two nines)", "3.65 days", "≈ 7.3 h", "10,000"],
        ["99.9% (three nines)", "8.77 h", "43.8 min", "1,000"],
        ["99.95%", "4.38 h", "21.9 min", "500"],
        ["99.99% (four nines)", "52.6 min", "4.4 min", "100"],
        ["99.999% (five nines)", "5.26 min", "26 s", "10"],
      ],
      note: "Needs all k dependencies → multiply (0.999⁴ ≈ 99.6%). Needs any of k replicas → 1 − Π(1 − aᵢ) (two 99% replicas → 99.99%), but only if failures are independent: treat it as an upper bound. Availability ≈ MTTF / (MTTF + MTTR), so halving recovery time is worth as much as halving failure frequency. Year = 365.25 days; month ≈ 30.4 days.",
    },
    {
      title: "Fault types and their defenses",
      type: "table",
      headers: ["Fault class", "Examples", "Correlated across nodes?", "Defenses"],
      rows: [
        [`<span style="white-space:nowrap">Hardware</span>`, "Disk crash (MTTF 10–50 years → about 0.5–2.7 a day per 10,000 disks, ≈ 0.9 at 30 years), bad RAM, power or PDU loss, unplugged cable, cloud VM vanishing without warning", "Mostly no (weak links: same batch, firmware, rack power)", "Redundancy (RAID, dual PSUs, generators) and, above all, software that tolerates losing whole machines; replicas across failure domains; rolling upgrades"],
        [`<span style="white-space:nowrap">Software</span>`, "Bug triggered on every node by one input or event (2012 leap second), runaway process eating CPU/memory/disk, slow or corrupt dependency, cascading failure", "Yes: every node runs the same code", "Testing, process isolation, crash-and-restart, monitoring, self-checks (e.g. messages in = messages out), timeouts and circuit breakers against cascades"],
        [`<span style="white-space:nowrap">Human</span>`, "Configuration errors (leading outage cause in Oppenheimer et al. 2003; hardware involved in only 10–25%), mistyped commands (S3 2017), bad deploys", "Yes, when a change is pushed everywhere at once", "Good abstractions and admin UIs, sandboxes with real data, staged rollout + fast rollback, tools to recompute data, telemetry, training, blameless postmortems"],
      ],
      note: "Redundancy fixes only the first row. Correlated faults need a limited blast radius (staging, cells) and fast recovery.",
    },
    {
      title: "Incidents worth citing",
      type: "table",
      headers: ["Incident", "What happened", "Fault class", "Lesson"],
      rows: [
        ["Leap second (June 30, 2012)", "A Linux kernel bug sent many Java and MySQL processes into high-CPU spinning at the same moment; rebooting or resetting the clock fixed it, restarting the process often didn't", "Software, correlated", "Identical replicas fail together; test time edge cases; automate reboots"],
        ["Knight Capital (Aug 1, 2012)", "A manual deploy missed 1 of 8 servers; a repurposed flag woke dead code; about 45 minutes; loss of roughly $440–460M", "Human + software", "Automate and verify deploys; delete dead code; never reuse flags"],
        ["GitLab (Jan 31, 2017)", "Data deleted on the primary instead of the secondary; backups turned out not to be working; about 6 h of database data lost (Git repos safe)", "Human, operability", "Test restores, not just backups; make destructive commands hard to misdirect"],
        ["AWS S3 us-east-1 (Feb 28, 2017)", "A mistyped input to a playbook command removed far more servers than intended; about 4 hours of disruption", "Human", "Tools should rate-limit and refuse unsafe operations"],
        ["Cloudflare (July 2, 2019)", "A WAF rule with a catastrophically backtracking regex was deployed globally at once and exhausted CPU; about 27 minutes of errors", "Software shipped as config, correlated", "Stage config and rules like code"],
        ["CrowdStrike (July 19, 2024)", "A faulty content file (Channel File 291) pushed at once to every online Windows host running the Falcon sensor crashed about 8.5M devices (Microsoft's estimate)", "Software shipped as content, correlated", "Staged rollout applies to data and content updates too"],
      ],
    },
    {
      title: "Stopping cascading failures",
      type: "list",
      items: [
        "<strong>Timeouts</strong> on every remote call, sized from the dependency's latency distribution: a missing timeout turns slow into stuck",
        "<strong>Bounded retries</strong> with exponential backoff and jitter, plus a retry budget, so retries can't multiply load on a struggling service",
        "<strong>Circuit breakers</strong>: after repeated failures, fail fast and return a fallback (hide the widget, serve cached data)",
        "<strong>Bulkheads</strong>: separate thread and connection pools per dependency, so one slow dependency can't occupy them all",
        "<strong>Bounded queues + load shedding</strong>: reject early (429/503) rather than queue forever",
        "<strong>Graceful degradation</strong>: decide in advance which features can be switched off",
        "<strong>Verify with fault injection</strong>: inject latency, not just crashes; these defenses are code paths that must be exercised",
        "Little's Law reminder: a 10× slower dependency means about 10× more requests in flight at the same traffic",
      ],
    },
    {
      title: "Twitter home timeline (November 2012): three approaches",
      type: "table",
      headers: ["Approach", "Read cost", "Write cost", "When it fits"],
      rows: [
        ["Fan-out on read (pull): Twitter v1", "Expensive: one lookup per followed account, then merge by time", "Cheap: one insert into the global tweets table", "Reads are rare relative to writes; or, inside a hybrid, for the few accounts with huge followings"],
        ["Fan-out on write (push): Twitter's second design, in use by 2012", "Cheap: read one precomputed timeline cache", "Expensive: one insert per follower; 4.6k × 75 = 345k writes/s, 30M+ for the biggest accounts", "Reads far outnumber writes (300k vs 4.6k/s ≈ 65:1) and fan-out is bounded"],
        ["Hybrid: what Twitter was moving to in 2012", "Inbox read + fetch and merge recent tweets of the few huge accounts you follow", "Push for most accounts; huge accounts' tweets are not fanned out", "Skewed follower distribution: a small head of accounts dominates fan-out cost"],
      ],
      note: "Key load parameter = distribution of followers per user (weighted by how often they tweet), not tweets/s. Goal: deliver within 5 s; fan-out runs asynchronously after the tweet is stored. Modern ranked feeds add heavy read-time candidate retrieval and ranking.",
    },
    {
      title: "Latency vocabulary",
      type: "table",
      headers: ["Term", "What it means", "Measured where / watch out"],
      rows: [
        ["Response time", "What the client sees: network delays + queueing delays + service time", "On the client or load balancer; the number users feel"],
        ["Service time", "Time actually spent processing the request", "A timer inside the handler; blind to queueing"],
        ["Latency (book's sense)", "Time a request spends waiting to be handled (latent)", "Often used loosely as a synonym for response time; say which you mean"],
        ["Queueing delay", "Time waiting for a worker, thread or connection", "Dominates high percentiles near saturation; invisible to server-side timers"],
        ["Throughput", "Work completed per unit time (records/s, requests/s, bytes/s)", "The main batch metric; pushing it up raises utilization and response time"],
        ["Tail latency", "High percentiles (p99, p99.9) of response time", "Amplified by fan-out; per request, not per user"],
      ],
    },
    {
      title: "Describing performance",
      type: "list",
      items: [
        "<strong>Describe load first</strong> with parameters that fit your architecture (requests/s, read/write ratio, active users, cache hit rate, fan-out), including their distribution and extremes",
        "<strong>Two questions</strong>: if load grows and resources stay fixed, how does performance change? How much must resources grow to keep performance unchanged?",
        "<strong>Batch → throughput</strong> (records/s, job duration); <strong>online → response time</strong>",
        "<strong>Response time is a distribution</strong>: the same request varies with GC pauses, packet loss and TCP retransmits, page faults, context switches and queueing",
        "<strong>Percentiles over mean</strong>: p50 for the typical request, p95/p99/p99.9 for the tail; the mean says nothing about how many users waited",
        "<strong>Amazon</strong>: internal targets at p99.9 (the slowest requests often belong to customers with the most data); p99.99 judged not worth optimizing",
        "<strong>SLA example</strong> (book): up if median &lt; 200 ms and p99 &lt; 1 s, and up at least 99.9% of the time",
        "<strong>Queueing delay grows non-linearly</strong> as utilization → 100% (M/M/1: response ≈ service time / (1 − utilization): 2× at 50%, 5× at 80%, 10× at 90%). No magic threshold; keep headroom",
      ],
    },
    {
      title: "Measuring latency correctly",
      type: "list",
      items: [
        "Measure response time on the <strong>client</strong> (or load balancer), not inside the handler, so queueing is included",
        "Load-test with an <strong>open-loop, constant-rate</strong> generator (e.g. wrk2) that measures from the intended send time; a closed-loop one that waits for replies hides stalls (coordinated omission)",
        "Report percentiles over <strong>rolling windows</strong> (e.g. the last 10 minutes, recomputed every minute), split per endpoint so cheap calls don't hide expensive ones",
        "<strong>Never average percentiles</strong> across hosts or time windows: add histograms or merge sketches (HdrHistogram, t-digest, forward decay, DDSketch), then compute the percentile",
        "Prometheus: summary quantiles can't be aggregated across instances; histograms can (sum buckets, then histogram_quantile)",
        "\"Fraction of requests under X ms\" adds up exactly across hosts and windows (make X a bucket boundary)",
        "Percentiles are <strong>per request</strong>: a user making k requests sees at least one above p99 with probability 1 − 0.99<sup>k</sup> (≈ 18% for 20 requests)",
        "Percentile definitions differ between tools (nearest rank, interpolation, bucket bounds), so small differences are normal",
      ],
    },
    {
      title: "Queueing: why utilization hurts (standard queueing theory, beyond the book)",
      type: "table",
      headers: ["Utilization", "M/M/1 response time", "Share of response time spent waiting"],
      rows: [
        ["50%", "2 × service time", "50%"],
        ["80%", "5 × service time", "80%"],
        ["90%", "10 × service time", "90%"],
        ["95%", "20 × service time", "95%"],
        ["99%", "100 × service time", "99%"],
      ],
      note: "M/M/1 (random arrivals, exponential service): response ≈ S / (1 − ρ), where S is service time and ρ utilization; waiting share = ρ. Real systems differ in the numbers, not the shape: there is no magic '70% rule', just a hockey stick that gets worse when service times are more variable. Little's Law L = λW holds for any stable system.",
    },
    {
      title: "Tail latency amplification math",
      type: "table",
      headers: ["Parallel calls n", "P(request slow) if each call is slow 1% of the time", "Each call must be fast this often for a request-level p99"],
      rows: [
        ["1", "1%", "99%"],
        ["10", "9.6%", "99.90%"],
        ["20", "18.2%", "99.95%"],
        ["50", "39.5%", "99.98%"],
        ["69", "50%: the backend's p99 is now the user's median", "99.985%"],
        ["100", "63.4%", "99.99%"],
      ],
      note: "P(slow) = 1 − (1 − p)<sup>n</sup>; required per-call success = 0.99<sup>1/n</sup>. Assumes independent calls; sequential calls add their latencies on top.",
    },
    {
      title: "Tail-tolerant techniques (from The Tail at Scale, beyond the book)",
      type: "list",
      items: [
        "<strong>Hedged requests</strong>: after about the p95 latency, send a backup to another replica, use the first reply, cancel the other; extra load ≤ about 5%",
        "BigTable example: a 10 ms hedge cut p99.9 from 1,800 ms to 74 ms for 2% more requests",
        "<strong>Tied requests</strong>: queue on two servers that cancel each other when one starts work",
        "<strong>Partial results</strong>: return a good-enough answer when a few leaves are slow (search, feeds)",
        "<strong>Reduce fan-out</strong>: batch, cache, precompute",
        "<strong>Per-backend SLOs</strong> much tighter than the page SLO",
        "Caveats: idempotent requests only; useless or harmful when slowness is correlated (shared overload); cap the hedge rate",
      ],
    },
    {
      title: "Scaling vocabulary",
      type: "table",
      headers: ["Choice", "Option A", "Option B", "Rule of thumb"],
      rows: [
        [`<span style="white-space:nowrap">Direction</span>`, "Scale up (vertical): a bigger machine; single-node semantics; cost rises faster than capacity; one failure domain", "Scale out (horizontal, shared-nothing): more machines; no hard ceiling; state must be partitioned and replicated", "Pragmatic mix: a few fairly powerful machines often beat many small VMs"],
        [`<span style="white-space:nowrap">Trigger</span>`, "Elastic: resources added or removed automatically from load signals", "Manual: humans analyze capacity and add machines", "Elastic for unpredictable, gradual change; manual for fewer surprises; pre-scale for known events"],
        [`<span style="white-space:nowrap">State</span>`, "Stateless (web and app tiers): easy to distribute", "Stateful (databases): distributing brings partitioning, replication, consistency", "Book (2017): keep the database on one node until cost or availability forces you out"],
        [`<span style="white-space:nowrap">Lifespan</span>`, "An architecture built around today's load parameters", "The same system at 10× the load", "Expect to rethink the architecture at each order of magnitude; there is no generic scalable architecture"],
      ],
    },
    {
      title: "Maintainability: three design principles",
      type: "table",
      headers: ["Principle", "Goal", "Practices", "Example"],
      rows: [
        [`<span style="white-space:nowrap">Operability</span>`, "Easy for operations to keep it running", "Monitoring and visibility, automation with manual override, no single-machine dependency, docs and a clear operational model, good defaults, self-healing, predictable behavior", "After S3's 2017 outage, AWS made its capacity-removal tool slower and floor-protected"],
        [`<span style="white-space:nowrap">Simplicity</span>`, "Easy for new engineers to understand", "Remove accidental complexity with good abstractions; consistent naming; few special cases", "SQL hides storage structures, concurrency and crash recovery"],
        [`<span style="white-space:nowrap">Evolvability</span>`, "Easy to change for unanticipated needs", "Simplicity and abstractions, tests and refactoring at data-system scale, compatible data formats (ch4), reprocessing (ch10–12)", "Migrating Twitter timelines from pull to push; Stripe's dual-write online migrations"],
      ],
    },
    {
      title: "Formulas to know",
      type: "table",
      headers: ["Formula", "Use it for", "Worked example"],
      rows: [
        ["failures/day ≈ N / (MTTF in years × 365)", "Fleet hardware failures", "10,000 disks, 30-year MTTF → ≈ 0.9/day"],
        ["inbox writes/s = posts/s × average followers", "Fan-out on write", "4.6k × 75 = 345k/s"],
        ["P(slow) = 1 − (1 − p)<sup>n</sup>", "Tail amplification over n calls", "p = 1%, n = 100 → 63%"],
        ["L = λ × W (Little's Law)", "Threads or connections in flight", "20k req/s × 40 ms = 800"],
        ["R ≈ S / (1 − ρ) (M/M/1)", "Queueing near saturation", "ρ = 90% → 10 × service time"],
        ["A<sub>serial</sub> = Π aᵢ; A<sub>redundant</sub> = 1 − Π(1 − aᵢ)", "Composing availability (independent faults only)", "0.999⁴ ≈ 99.6%; two 99% replicas → 99.99%"],
        ["A ≈ MTTF / (MTTF + MTTR)", "Recovery vs prevention", "MTTF 30 days, MTTR 1 h → 99.86%"],
        ["Error budget = (1 − SLO) × window", "Release decisions", "99.9% over 30 days → 43.2 min"],
        ["Throughput = rate × size", "Comparing workloads", "100k req/s × 1 kB ≈ 3 req/min × 2 GB ≈ 100 MB/s"],
      ],
      note: "Little's Law, M/M/1 and the availability formulas are standard queueing and reliability math, not from the book.",
    },
    {
      title: "Numbers worth remembering",
      type: "list",
      items: [
        "Disk MTTF ≈ 10–50 years → about one disk failure per day per 10,000 disks (≈ 0.9/day at 30 years); field replacement rates are often 2–4% a year (Schroeder and Gibson, 2007)",
        "Twitter, November 2012: 4.6k tweets/s average, 12k+ peak; 300k timeline reads/s (≈ 65:1); average 75 followers → 345k inbox writes/s; some accounts with 30M+ followers; 5 s delivery goal",
        "1 − 0.99<sup>100</sup> ≈ 63%; 1 − 0.99<sup>69</sup> ≈ 50%; 1 − 0.99<sup>50</sup> ≈ 39.5%; 1 − 0.99<sup>20</sup> ≈ 18%",
        "Amazon: internal targets at p99.9; reported 100 ms slower → about 1% fewer sales; p99.99 judged not worth optimizing",
        "Dynamo paper (2007): 300 ms at p99.9 at a peak of 500 requests/s",
        "Oppenheimer et al. (2003): operator configuration errors the leading cause of outages; hardware involved in only 10–25%",
        "99.9% ≈ 8.77 h/year (≈ 43.8 min/month); 99.99% ≈ 52.6 min/year",
        "Little's Law: 20k req/s × 40 ms = 800 in flight",
        "M/M/1: 2× service time at 50% busy, 10× at 90%",
        "BigTable hedging: p99.9 1,800 → 74 ms for 2% more requests",
      ],
    },
  ],

  interview: [
    // ── data-systems ─────────────────────────────────────────────
    {
      id: "q01",
      q: "What is the difference between reliability, scalability, and maintainability?",
      diff: "easy",
      a: `<p><strong>Reliability</strong>: the system keeps working <em>correctly</em> when things go wrong: hardware faults, software bugs, human mistakes. It is broader than availability: wrong answers, lost data or an attacker getting in are reliability failures even while the service is "up". Users expect it to do what they asked, tolerate their mistakes, perform well enough at the expected load, and prevent unauthorized access.</p>
<p><strong>Scalability</strong>: having reasonable options for coping with growth. It only means something relative to a named <strong>load parameter</strong> (requests/s, read/write ratio, followers per user, data volume) and a performance measure (e.g. p99 response time). "It scales" is not an answer; "if writes grow 10×, we partition by user ID and here is the next bottleneck" is.</p>
<p><strong>Maintainability</strong>: many different people can work on the system productively over its lifetime. Three principles: <strong>operability</strong> (easy to run), <strong>simplicity</strong> (easy to understand), <strong>evolvability</strong> (easy to change).</p>
<p><strong>They interact.</strong> Multi-region replication improves availability but adds operational complexity and consistency questions; scaling a database out buys capacity at the cost of simplicity; a single-node system is easy to maintain but is one failure domain with a capacity ceiling. Since most of a system's lifetime cost is maintenance, it usually deserves more weight than it gets at design time.</p>`,
      followups: [
        "Give an example where improving one of the three hurts another.",
        "Which of the three dominates cost over a system's lifetime?",
      ],
      pitfalls: [
        "Defining scalability as \"handles lots of traffic\" with no load parameter",
        "Treating reliability as just uptime",
      ],
      section: "data-systems",
    },

    // ── reliability ─────────────────────────────────────────────
    {
      id: "q05",
      q: "What is the difference between a fault and a failure?",
      diff: "easy",
      a: `<p>A <strong>fault</strong> is one component deviating from its spec: a disk dies, a process crashes, a dependency returns errors, an operator mistypes a command. A <strong>failure</strong> is the system as a whole no longer providing the required service to users. <strong>Fault tolerance</strong> (resilience) is the machinery that stops the first from becoming the second.</p>
<ul>
<li><strong>Tolerance is relative to named faults.</strong> No system tolerates everything, so a design should state what it survives (one machine, one zone, one bad deploy) and what it doesn't.</li>
<li><strong>Tolerate rather than prevent</strong>, because fault probability can't reach zero. The exception is security: a breach can't be undone, so prevention matters there.</li>
<li><strong>Some faults defeat redundancy.</strong> A correlated software bug (the 2012 leap second) or a bad config pushed to every replica hits all copies at once; more replicas don't help.</li>
<li><strong>Exercise the machinery.</strong> Teams inject faults on purpose (Netflix's Chaos Monkey kills production instances) because error-handling code that rarely runs tends not to work.</li>
<li><strong>Recovery speed is part of tolerance.</strong> Availability ≈ MTTF / (MTTF + MTTR), so fast detection, failover and rollback matter as much as failing less often (see the availability-math question).</li>
</ul>
<p><strong>Example:</strong> one of 12 app servers crashes and the load balancer routes around it before any request fails: a fault, no failure. If the health check takes two minutes to notice, about 1 in 12 requests fails in the meantime, and the fault has leaked into a partial failure.</p>`,
      followups: [
        "Give a fault that adding replicas cannot tolerate.",
        "Why would anyone inject faults in production?",
      ],
      pitfalls: [
        "Using fault and failure interchangeably",
        "Claiming a design tolerates \"any failure\" without naming which faults",
      ],
      section: "reliability",
    },
    {
      id: "q-availability-math",
      q: "Every request to your API needs a database, a cache, an auth service and a payment provider, each 99.9% available. What availability can you promise, and how would you raise it?",
      diff: "medium",
      a: `<p><strong>Serial dependencies multiply.</strong> If every request needs all four, availability is at most 0.999<sup>4</sup> ≈ <strong>99.6%</strong>, about 35 hours of downtime a year, before counting your own bugs and deploys. So you can't honestly promise 99.9%: the system is <em>worse</em> than its weakest dependency.</p>
<p><strong>Levers to raise it:</strong></p>
<ul>
<li><strong>Take hard dependencies off the critical path.</strong> Make the cache optional (fall back to the database; serve slightly stale data if the database is briefly down); accept the order and confirm payment asynchronously; cache auth decisions or validate signed tokens locally for a short time; degrade gracefully instead of failing the whole request.</li>
<li><strong>Add redundancy.</strong> Two replicas at 99.9% give 1 − 0.001<sup>2</sup> = 99.9999% in theory, but only if their failures are independent. Shared code, config, region or operator actions correlate them, so spread replicas across failure domains and stage changes. Treat the formula as an upper bound.</li>
<li><strong>Cut MTTR.</strong> Availability ≈ MTTF / (MTTF + MTTR): halving recovery time is worth as much as halving failure frequency. Fast detection, automatic failover and quick rollback pay off directly.</li>
</ul>
<p><strong>Translate into budgets:</strong> 99.9% ≈ 8.8 h a year or ≈ 43.8 min a month; 99.99% ≈ 52.6 min a year. Finally, availability is not the whole of reliability: wrong answers and lost data count too. (Nines arithmetic is standard SRE practice rather than material from the book.)</p>`,
      followups: [
        "Why is the redundancy formula only an upper bound in practice?",
        "Would you measure availability by time or by fraction of successful requests? Why?",
        "What monthly downtime does a 99.95% SLA allow?",
      ],
      pitfalls: [
        "Assuming the system is as available as its weakest dependency (it's worse: they multiply)",
        "Multiplying in redundancy as if replica failures were independent",
        "Ignoring recovery time",
      ],
      section: "reliability",
    },

    // ── fault-types ─────────────────────────────────────────────
    {
      id: "q-fleet-failures",
      q: "Your disks have an MTTF of about 30 years and you run 20,000 of them. How many failures should you expect, and what does that imply for the design?",
      diff: "easy",
      a: `<p><strong>Arithmetic:</strong> expected failures ≈ N / MTTF = 20,000 / (30 × 365) ≈ <strong>1.8 per day</strong>, roughly 670 a year. A "30-year" component fails daily at fleet scale.</p>
<p><strong>Implications:</strong></p>
<ul>
<li><strong>A dead disk is routine maintenance, not an incident.</strong> Data must be redundant across machines and failure domains (rack, power feed, zone), not only RAID inside one box, because whole machines fail too.</li>
<li><strong>Re-replication must be automatic</strong> and fast enough that a second failure during recovery doesn't lose data; spreading the copy work across many nodes (as HDFS does for missing blocks) beats rebuilding onto a single replacement disk.</li>
<li><strong>Alert on redundancy level</strong> (data with fewer copies than intended, re-replication backlog), not on every disk; humans swap hardware in batches.</li>
<li><strong>Plan with field data.</strong> Schroeder and Gibson (FAST 2007) found annual disk replacement rates typically of 2–4% in the field, versus under 1% implied by datasheet MTTFs.</li>
<li><strong>Failures aren't perfectly independent</strong>: same manufacturing batch, firmware, rack or power. Spread replicas across failure domains and stagger hardware batches and firmware upgrades.</li>
</ul>
<p>This arithmetic is why the industry moved from hardware redundancy inside one machine to software fault tolerance across machines, which as a bonus enables rolling upgrades without downtime.</p>`,
      followups: [
        "How would a bad firmware batch change your plan?",
        "Why is software fault tolerance preferred over bigger RAID arrays in the cloud?",
      ],
      pitfalls: [
        "Reading a 30-year MTTF as 'nothing fails for 30 years'",
        "Paging a human for every disk failure",
        "Assuming failures are independent",
      ],
      section: "fault-types",
    },
    {
      id: "q-blast-radius",
      q: "Many of the largest outages were caused by changes (code or configuration) rather than hardware. How would you design deployment and config changes to limit the blast radius?",
      diff: "medium",
      a: `<p>Hardware faults are mostly independent and absorbed by redundancy, but a change pushed everywhere is a <strong>correlated</strong> fault that hits every replica at once. So the goal is that each change reaches a small slice first, and that undoing it is fast.</p>
<ul>
<li><strong>Treat config as code</strong>: version control, review, schema validation and automated tests, including for "data-like" config such as rules, feature flags and content updates.</li>
<li><strong>Stage every change</strong>: canary hosts → one cell or zone → one region → global, with bake times between stages.</li>
<li><strong>Automated canary analysis</strong>: compare the canary against a baseline (error rate, latency percentiles, saturation, key business metrics) and roll back automatically.</li>
<li><strong>Fast, rehearsed rollback</strong>, plus feature flags and kill switches decoupled from deploys.</li>
<li><strong>Cell-based architecture</strong>: independent copies of the stack, each serving a subset of customers, so a bad change hits one cell.</li>
<li><strong>Safe tooling</strong>: rate-limit dangerous operations and refuse ones that cross safety floors, as AWS did after S3's 2017 outage.</li>
<li><strong>Health checks that test behavior</strong>, not just liveness; otherwise a bad config passes them while serving errors.</li>
</ul>
<p><strong>Evidence:</strong> Cloudflare (July 2, 2019) deployed a WAF rule with a catastrophically backtracking regex globally at once, exhausting CPU for about 27 minutes; CrowdStrike (July 19, 2024) pushed a faulty content file at once to every online Windows host running its sensor and crashed about 8.5 million devices (Microsoft's estimate); at AWS S3 (February 28, 2017) a mistyped command input removed far more capacity than intended. Each was a kind of change that lacked the staging or guardrails code changes got. For urgent fixes, compress the stages but don't skip the canary.</p>`,
      followups: [
        "How do you ship an urgent security fix fast but safely?",
        "Which metrics would your automated canary judge?",
        "How do you handle config that must change everywhere at once?",
      ],
      pitfalls: [
        "Staging code but pushing config globally",
        "A rollback path that has never been tested",
        "Relying on liveness health checks to catch wrong behavior",
      ],
      section: "fault-types",
    },
    {
      id: "q-cascading-failure",
      q: "A downstream recommendation service gets slow, and within minutes your whole site is down, even pages that show no recommendations. Explain the mechanism and how you would prevent it.",
      diff: "medium",
      a: `<p><strong>Mechanism</strong>, step by step:</p>
<ul>
<li>Calls to the slow dependency hold threads and connections much longer. By Little's Law (in flight = rate × latency), a 10× slower dependency means about 10× more occupied threads at the same traffic.</li>
<li>The shared pool fills, so unrelated requests (pages without recommendations) queue behind them: head-of-line blocking.</li>
<li>Callers time out and <strong>retry</strong>, multiplying load on the struggling service.</li>
<li>Health checks time out, instances are pulled from the load balancer, and the survivors take their load until they fail too.</li>
</ul>
<p><strong>Defenses:</strong></p>
<ul>
<li><strong>Timeouts</strong> on every remote call, sized from the dependency's latency distribution.</li>
<li><strong>Bounded retries</strong> with exponential backoff and jitter, plus a retry budget.</li>
<li><strong>Circuit breakers</strong> that fail fast and return a fallback (hide the widget).</li>
<li><strong>Bulkheads</strong>: separate pools per dependency so one can't starve the rest.</li>
<li><strong>Bounded queues and load shedding</strong>; <strong>graceful degradation</strong> of non-critical features.</li>
<li><strong>Fault-injection tests</strong> that inject latency (not just crashes) to prove these paths work.</li>
</ul>
<p>This is the book's "cascading failure" class of software fault: a small root cause spread through coupling (shared pools, retries, health checks). Fixing the slow service is necessary but not sufficient; callers must be designed to survive it.</p>`,
      followups: [
        "Why can retries turn a slowdown into an outage, and how does jitter help?",
        "Where would you put a circuit breaker, and what should it return when open?",
      ],
      pitfalls: [
        "No timeouts, or unbounded retries",
        "One shared thread pool for every dependency",
        "Treating the slow dependency as the only thing to fix",
      ],
      section: "fault-types",
    },

    // ── describing-load ─────────────────────────────────────────
    {
      id: "q08",
      q: "How would you choose load parameters for a new system?",
      diff: "medium",
      a: `<p>Pick the numbers that <strong>dominate the work your architecture does</strong>, not a generic list.</p>
<ul>
<li><strong>Trace the expensive path</strong>: for each main operation, what does one request cost (queries, writes, fan-out, bytes)? Then multiply by its rate.</li>
<li><strong>Look at distributions and extremes</strong>, not averages: a few heavy users, hot keys or celebrity accounts often set the bottleneck.</li>
<li><strong>Ask "if this grew 10×, what breaks first?"</strong> for each candidate.</li>
</ul>
<p><strong>Examples:</strong></p>
<ul>
<li>Cache-fronted database: <strong>cache hit rate</strong> (falling from 99% to 95% multiplies database reads by 5) and the read/write ratio.</li>
<li>Chat server: <strong>concurrent connections</strong> and messages/s per room, since large rooms fan out.</li>
<li>Social feed: <strong>followers per author (the distribution) × post rate</strong>. Twitter in 2012 had a modest tweet rate (4.6k/s average) but 75 followers per tweet on average and 30M+ for some accounts.</li>
<li>Database: read/write ratio, working set vs RAM, transaction rate.</li>
<li>Batch pipeline: input size and skew of the key distribution.</li>
</ul>
<p><strong>Confirm empirically:</strong> profile production, load-test to see which resource saturates first, and track how cost per request changes as each parameter grows.</p>`,
      followups: [
        "Which load parameter would you watch for a chat application?",
        "How would you discover the dominant parameter empirically?",
      ],
      pitfalls: [
        "Listing generic metrics without tying them to the bottleneck",
        "Quoting only averages and ignoring skew",
      ],
      section: "describing-load",
    },
    {
      id: "q04",
      q: "Walk me through the Twitter home timeline problem and how you would scale it.",
      diff: "hard",
      a: `<p><strong>The load</strong> (November 2012, from Raffi Krikorian's talk as cited in the book): posting ran at 4.6k tweets/s on average and over 12k/s at peak; home-timeline reads at 300k/s, about 65× more. Absorbing 12k writes/s is easy; the hard part is <strong>fan-out</strong>, because each user follows many people and is followed by many.</p>
<ol>
<li><strong>Fan-out on read (pull), Twitter's first version.</strong> A tweet is one insert into a global table. A timeline read looks up everyone the user follows, fetches their recent tweets and merges them by time. Writes are cheap, but at 300k reads/s the read-side work couldn't keep up.</li>
<li><strong>Fan-out on write (push), what Twitter switched to.</strong> Keep a cached home timeline per user. Posting looks up the author's followers and inserts the tweet into each cache, so a read is one lookup. With 75 followers on average, 4.6k tweets/s become <strong>345k cache writes/s</strong>, a good trade because reads dominate.</li>
<li><strong>Hybrid, what Twitter was moving to in 2012.</strong> The average hides skew: accounts with 30M+ followers turn one tweet into 30M+ writes, while the goal was delivery within 5 seconds. So most tweets are still fanned out on write, but tweets from a small number of accounts with huge followings are fetched at read time and merged in.</li>
</ol>
<p><strong>Key load parameter:</strong> the distribution of followers per user, weighted by how often they tweet, not tweets/s.</p>
<p><strong>Details that strengthen the answer:</strong> fan-out runs asynchronously after the tweet is stored, so the 5-second goal is about background backlog, not POST latency; caches hold tweet IDs rather than bodies (Krikorian's talk described Redis lists, reportedly capped at about 800 entries), hydrated at read time; follows need backfill, and unfollows and deletes need filtering or cleanup.</p>
<p>The general pattern: when load is skewed, use different strategies for the head and the tail of the distribution. Modern ranked feeds differ again, retrieving and ranking candidates at read time.</p>`,
      followups: [
        "What happens on follow, unfollow and delete?",
        "How would you pick the celebrity threshold?",
        "Would you maintain timelines for inactive users?",
      ],
      pitfalls: [
        "Quoting the average fan-out and ignoring the skewed distribution",
        "Storing full tweets in every inbox instead of IDs",
        "Presenting the 2012 numbers as current figures",
      ],
      section: "describing-load",
    },
    {
      id: "q-design-home-timeline",
      q: "Design the home timeline for a social network with 300M users. How do you decide between fan-out on write and fan-out on read?",
      diff: "hard",
      a: `<p><strong>1. Clarify the load parameters.</strong> Daily active users (say 100M of the 300M), posts/s on average and at peak, timeline reads/s, and above all the <strong>distribution of followers per author</strong> (heavily skewed), plus a freshness target such as "visible to followers within 5 s".</p>
<p><strong>2. Compare the strategies.</strong></p>
<ul>
<li><strong>Pull</strong>: cheap writes; each read = one lookup per followed account + merge. Expensive at high read rates, and read latency grows with the number of accounts followed.</li>
<li><strong>Push</strong>: each post = one insert per follower; a read = one cache lookup. Great when reads dominate, but celebrity posts explode.</li>
<li><strong>Hybrid</strong>: push for normal accounts, pull-and-merge for accounts above a follower threshold. Usually the answer.</li>
</ul>
<p><strong>3. Do the math.</strong> With Twitter's 2012 numbers as a reference: 4.6k posts/s × 75 average followers = 345k inbox writes/s, which is manageable; one post by a 30M-follower account = 30M writes, a backlog that blows a 5-second target and delays everyone else's deliveries. That skew sets the threshold.</p>
<p><strong>4. Storage.</strong> Inboxes hold post IDs (plus author ID and timestamp), not bodies, in an in-memory store, capped at a few hundred entries (Krikorian's 2012 talk described Redis lists of tweet IDs, reportedly capped at about 800). Bodies come from a post cache or store at read time (hydration). Partition inboxes by user ID and replicate them for availability.</p>
<p><strong>5. Write path.</strong> Store the post durably, acknowledge the author, then enqueue fan-out work (e.g. a log such as Kafka consumed by fan-out workers). The freshness target is about this asynchronous backlog, not the POST latency, so monitor fan-out lag against it.</p>
<p><strong>6. Edge cases.</strong> <strong>Follow</strong>: backfill the new followee's recent posts. <strong>Unfollow and delete</strong>: filter at read or hydration time (cheap and immediate), and clean inboxes lazily or fan out tombstones. <strong>Inactive users</strong>: don't maintain their inboxes; rebuild on login (Mastodon does this). <strong>Celebrity reads</strong>: cache each celebrity's recent posts so the merge is cheap.</p>
<p><strong>7. Ranked feeds.</strong> For a non-chronological feed the inbox becomes one candidate source; read time adds candidate retrieval from other sources plus ML ranking, which moves work back onto the read path.</p>`,
      followups: [
        "How do you choose the celebrity threshold, and could it be dynamic?",
        "A user follows 5,000 accounts, 200 of them celebrities. What happens to read latency in the hybrid?",
        "How do you remove a deleted post that is already in 30M inboxes?",
        "What changes for a ranked (non-chronological) feed?",
      ],
      pitfalls: [
        "Designing for the average fan-out and ignoring the skew",
        "Storing full post bodies in every inbox",
        "Forgetting follow/unfollow/delete and inactive users",
        "No back-of-the-envelope numbers",
      ],
      section: "describing-load",
    },

    // ── describing-performance ──────────────────────────────────
    {
      id: "q02",
      q: "Why do we prefer percentiles over averages for measuring performance?",
      diff: "easy",
      a: `<p>Response time is a <strong>distribution</strong>: the same request is fast most of the time and occasionally very slow (GC pauses, packet loss and TCP retransmits, page faults, queueing). The mean blends them into one number that is distorted by outliers and doesn't tell you how many users actually waited. A service can have a fine mean while 1% of requests time out.</p>
<ul>
<li><strong>p50 (median)</strong>: half of requests are faster; the typical experience.</li>
<li><strong>p95 / p99</strong>: the tail; what slow-but-common cases look like.</li>
<li><strong>p99.9</strong>: where Amazon sets internal service targets, because its slowest requests tend to come from customers with long purchase histories and data-heavy accounts, the ones it most wants to keep. Going further, to p99.99, was judged not worth the cost: the extreme tail is dominated by random events outside your control.</li>
</ul>
<p><strong>Why it matters commercially:</strong> the book reports Amazon's observation that a 100 ms increase in response time reduced sales by about 1%. That is about response time in general, not specifically p99.</p>
<p><strong>Two subtleties strong answers mention:</strong></p>
<ul>
<li>Percentiles are <strong>per request</strong>. A user whose page view makes 20 requests sees at least one above p99 with probability 1 − 0.99<sup>20</sup> ≈ 18%, so heavy users meet the tail far more often than "1%" suggests.</li>
<li>Percentiles <strong>can't be averaged</strong> across hosts or time windows. Add histograms (or merge sketches such as HdrHistogram, t-digest, DDSketch) and compute the percentile from the merged data.</li>
</ul>`,
      followups: [
        "How would you compute p99 across 200 servers?",
        "Why might p99.99 not be worth optimizing?",
      ],
      pitfalls: [
        "Averaging per-host p99s",
        "Saying p99 means 99% of users are fine",
      ],
      section: "describing-performance",
    },
    {
      id: "q-latency-throughput",
      q: "What is the difference between latency, response time and throughput, and how are they related?",
      diff: "easy",
      a: `<p><strong>Response time</strong> is what the client measures, from sending a request to receiving the reply: network delays + time waiting in queues + <strong>service time</strong> (the work itself). <strong>Latency</strong>, in the book's strict sense, is only the waiting part, the time a request sits latent before it is handled. In everyday use "latency" usually means response time, so say which you mean. <strong>Throughput</strong> is work completed per unit time: requests/s, records/s, bytes/s.</p>
<ul>
<li><strong>Different systems care about different ones.</strong> Online services are judged by response-time percentiles, because a user waits for every request. Batch jobs are judged by throughput: records per second, or the total time to process a dataset of a given size.</li>
<li><strong>They are coupled through utilization.</strong> Driving a server toward its maximum throughput keeps it busy more of the time, so arriving requests wait longer, and the waiting grows non-linearly. In the textbook M/M/1 queue, response time ≈ service time / (1 − utilization): 2× at 50% busy, 10× at 90%. A maximum throughput quoted without the response time at that load is a number you can't run at.</li>
<li><strong>Little's Law ties them together:</strong> requests in flight = throughput × response time (L = λW). At 1,000 req/s and 50 ms about 50 requests are in progress; if responses slow to 500 ms at the same rate, 500 are, which is how a slow dependency exhausts thread and connection pools.</li>
<li><strong>Improving one doesn't automatically improve the other.</strong> Batching raises throughput but makes each item wait for its batch; adding servers raises throughput without making any single request faster; a cache or a faster algorithm cuts service time and helps both.</li>
</ul>
<p><strong>Example:</strong> 100,000 requests/s of 1 kB and 3 requests a minute of 2 GB are both about 100 MB/s of throughput, yet one is dominated by per-request overhead and concurrency, the other by transfer time. (M/M/1 and Little's Law are standard queueing theory, beyond the book.)</p>`,
      followups: [
        "Why does response time climb steeply as a server approaches full utilization?",
        "How can batching increase throughput yet hurt latency?",
        "Where should response time be measured, and why not inside the handler?",
      ],
      pitfalls: [
        "Treating throughput as simply the inverse of latency",
        "Quoting maximum throughput without the response time at that load",
        "Measuring only service time and calling it latency",
      ],
      section: "describing-performance",
    },
    {
      id: "q-dashboard-p99",
      q: "Your SLO is p99 &lt; 200 ms. The dashboard shows the average of each host's p99 every minute, and it's green, but users complain. What's wrong, and how would you fix the measurement?",
      diff: "medium",
      a: `<p><strong>The bug: percentiles can't be averaged.</strong> The mean of per-host p99s isn't the p99 of anything. If one degraded host serves 10% of traffic 300 ms slower, its p99 is high and the others' are low, and the average lands well below the true p99 of all requests, so the dashboard stays green. (In general the error can go either way; with one bad host it typically hides the problem.) Averaging per-minute p99s into hourly figures has the same flaw.</p>
<p><strong>Fix the aggregation:</strong></p>
<ul>
<li>Record <strong>histograms</strong> on each host (fixed buckets, HdrHistogram, Prometheus histograms), sum buckets across hosts and time, then compute p99 (e.g. histogram_quantile over summed buckets), or merge <strong>sketches</strong> such as t-digest or DDSketch.</li>
<li>Better, define the SLI as <strong>"fraction of requests under 200 ms"</strong>: counts add up exactly across hosts and windows (make 200 ms a bucket boundary).</li>
</ul>
<p><strong>Fix what is measured:</strong></p>
<ul>
<li>Measure at the <strong>client or load balancer</strong>, not inside the handler, so queueing is included.</li>
<li>Split <strong>per endpoint</strong>: mixing cheap and expensive endpoints hides tails.</li>
<li>Align the dashboard window with the SLO window, and keep a per-host breakdown to spot the outlier.</li>
<li>Remember heavy users make many requests and hit the tail far more often than once per 100 page views.</li>
</ul>`,
      followups: [
        "Why can't Prometheus summaries be aggregated across instances while histograms can?",
        "How would you choose bucket boundaries for a 200 ms SLO?",
        "How does an error budget turn this into a release decision?",
      ],
      pitfalls: [
        "Averaging percentiles",
        "Measuring only server-side handler time",
        "Using the mean as the SLI",
      ],
      section: "describing-performance",
    },
    {
      id: "q-sli-slo-sla",
      q: "What's the difference between an SLI, an SLO and an SLA, and how does an error budget change engineering decisions?",
      diff: "easy",
      a: `<ul>
<li><strong>SLI</strong> (indicator): what you measure, from the user's point of view, e.g. the fraction of requests that succeed in under 300 ms, measured at the load balancer or client.</li>
<li><strong>SLO</strong> (objective): the internal target on an SLI over a window, e.g. 99.9% of requests under 300 ms over 30 days.</li>
<li><strong>SLA</strong> (agreement): an external contract, usually looser than the SLO, with consequences such as service credits or refunds. The book's example: the service counts as up if the median is under 200 ms and p99 under 1 s, and it must be up at least 99.9% of the time.</li>
</ul>
<p>Latency SLIs use percentiles or "fraction under a threshold", never averages.</p>
<p><strong>Error budget</strong> = 100% − SLO. At 99.9% over 30 days that is 0.1% of requests, or about 43 minutes of complete outage. While budget remains, the team ships features and takes risks; once it is spent, releases slow down and reliability work takes priority. It turns "how reliable should we be?" from an argument into a shared, measurable rule.</p>
<p><strong>Why not 100%?</strong> Beyond some point users can't tell the difference (their own network is less reliable), each extra nine costs far more, and a 100% target forbids change. SLIs and error budgets come from Google's SRE book (2016), not from DDIA.</p>`,
      followups: [
        "Why should the internal SLO be stricter than the SLA?",
        "Why is 100% the wrong reliability target?",
      ],
      pitfalls: [
        "Using the mean as the SLI",
        "Setting SLOs from what the system happens to do today rather than what users need",
      ],
      section: "describing-performance",
    },

    // ── queueing ────────────────────────────────────────────────
    {
      id: "q-load-test-lies",
      q: "Your load test reports p99 = 20 ms at 1,000 req/s, but production users see multi-second spikes at the same traffic. What could explain the gap?",
      diff: "hard",
      a: `<p>Mostly, the test didn't measure what users experience:</p>
<ol>
<li><strong>Coordinated omission</strong> (Gil Tene's term). A closed-loop generator waits for each reply before sending the next, so when the server stalls for 2 s it stops sending and records one slow sample, instead of the roughly 2,000 requests real users would have queued at 1,000 req/s. Use an open-loop, constant-rate generator (e.g. wrk2) that measures from the intended send time, or approximately correct with HdrHistogram's expected-interval recording.</li>
<li><strong>Server-side timing excludes queueing.</strong> If the 20 ms came from inside the handler, it is service time. Measure on the client.</li>
<li><strong>Bursty arrivals.</strong> Production traffic arrives in bursts, so queues form even at the same average rate; effective utilization is higher than the average suggests, and queueing delay grows non-linearly with utilization.</li>
<li><strong>Periodic stalls a short test misses</strong>: GC pauses (Discord reported latency spikes about every two minutes from Go's forced garbage collection), compaction, cron jobs, backups, noisy neighbours.</li>
<li><strong>Unrealistic setup</strong>: warm caches, a dataset that fits in memory, a different request mix, mocked dependencies (which removes the tail amplification of real fan-out).</li>
</ol>
<p><strong>Approach:</strong> rerun with an open-loop test on production-like data and request mix, measure client-side percentiles, and correlate spikes with GC logs, compaction and dependency latency.</p>`,
      followups: [
        "How does wrk2 correct for coordinated omission?",
        "What is head-of-line blocking and how would you mitigate it inside the server?",
      ],
      pitfalls: [
        "Blaming the network without evidence",
        "Not knowing whether the load generator is open- or closed-loop",
        "Reporting averages",
      ],
      section: "queueing",
    },
    {
      id: "q-capacity-littles-law",
      q: "Your service must handle 20,000 requests/s at peak, and each request occupies a server thread for 40 ms on average (mostly waiting on the database). How many threads do you need, and how many 32-thread servers would you provision?",
      diff: "medium",
      a: `<p><strong>Little's Law:</strong> L = λ × W = 20,000/s × 0.04 s = <strong>800 requests in flight</strong> on average, so about 800 threads (or async connections) busy at any moment.</p>
<p><strong>Don't provision for 100%.</strong> 800 / 32 = 25 servers only if every thread is always busy. Queueing delay grows non-linearly near saturation (for an M/M/1 queue, response ≈ S / (1 − ρ)), and averages hide bursts. At a 60–70% utilization target that is 800 / 0.7 / 32 ≈ 36 up to 800 / 0.6 / 32 ≈ 42 servers. Then add <strong>failure headroom</strong>: N+2, or across 3 zones enough that any 2 zones carry the peak (×1.5, about 54–63 servers).</p>
<ul>
<li><strong>W includes time blocked on I/O</strong>, which is why I/O-bound services need far more threads than cores, or async I/O (which changes what each in-flight request costs, not the law).</li>
<li><strong>If the database slows</strong> from 30 ms to 300 ms, W rises from 40 ms to about 310 ms and L from 800 to about 6,200: pools exhaust and you get a cascading failure unless timeouts, bounded pools and load shedding cap it.</li>
<li><strong>Little's Law is about averages.</strong> For a p99 SLO, validate with an open-loop load test that measures client-side percentiles.</li>
</ul>
<p>(Little's Law and M/M/1 are standard queueing theory, not from the book.)</p>`,
      followups: [
        "What happens to the thread count when the database's latency grows 10×?",
        "Why does async I/O change the thread count but not Little's Law?",
      ],
      pitfalls: [
        "Sizing for 100% utilization",
        "Forgetting headroom for node or zone loss",
        "Using average latency to reason about a p99 SLO",
      ],
      section: "queueing",
    },

    // ── tail-latency ────────────────────────────────────────────
    {
      id: "q03",
      q: "Explain tail latency amplification with an example.",
      diff: "medium",
      a: `<p>When one end-user request needs many backend calls, it is as slow as the <strong>slowest</strong> of them, even if they run in parallel. If each call is slow with probability p, a request making n calls is slow with probability 1 − (1 − p)<sup>n</sup>:</p>
<ul>
<li>p = 1%, n = 100: 1 − 0.99<sup>100</sup> ≈ <strong>63.4%</strong> of requests are slow.</li>
<li>n = 69: 1 − 0.99<sup>69</sup> ≈ 50%, so the backend's p99 has become the user's <strong>median</strong>.</li>
</ul>
<p><strong>Example:</strong> a search query fans out to every index shard and waits for the slowest. Dean and Barroso's "The Tail at Scale" (2013), which the book cites, uses exactly this case: servers that are slow for 1 request in 100, called 100 at a time in parallel, make 63% of user requests slow.</p>
<p><strong>Consequence:</strong> per-backend targets must be far tighter than the page target (each of 50 calls must be fast about 99.98% of the time for a page-level p99), and making backend averages faster doesn't help.</p>
<p><strong>Mitigations</strong> (from The Tail at Scale, beyond the book's own text):</p>
<ul>
<li><strong>Hedged requests</strong>: if a call hasn't returned within about the p95 latency, send a backup to another replica and use whichever answers first. A rescued call costs roughly the delay plus one normal reply, far below the tail, and the extra load equals the fraction of calls exceeding the delay (at most about 5%). In their BigTable test a 10 ms hedge cut p99.9 from 1,800 ms to 74 ms for 2% more requests.</li>
<li><strong>Tied requests</strong>: queue on two servers that cancel each other when one starts.</li>
<li><strong>Partial results</strong> when a few leaves are slow, and <strong>less fan-out</strong> (batching, caching, precomputing).</li>
</ul>
<p><strong>Caveats:</strong> hedge only idempotent requests, and hedging fails (while adding load) when slowness is correlated, e.g. all replicas overloaded.</p>`,
      followups: [
        "What does hedging cost and when can it backfire?",
        "Why must per-backend SLOs be much tighter than the page SLO?",
      ],
      pitfalls: [
        "Optimizing average backend latency",
        "Hedging non-idempotent writes",
      ],
      section: "tail-latency",
    },
    {
      id: "q-fanout-tail",
      q: "A page calls 50 backend services in parallel; each has a median of 10 ms and a p99 of 100 ms. What does the page's latency look like, and how would you improve it?",
      diff: "hard",
      a: `<p><strong>Page latency</strong> is the maximum of 50 draws. P(at least one call &gt; 100 ms) = 1 − 0.99<sup>50</sup> ≈ <strong>39.5%</strong>, so about 40% of page loads exceed 100 ms: the backends' p99 sits near the page's p60. Even the page median corresponds to each backend's p98.6 (0.5<sup>1/50</sup> ≈ 0.986), so it sits far above the 10 ms backend median and, for a typical long-tailed backend, not far below 100 ms.</p>
<p><strong>Target math:</strong> for the page's p99 to be under 100 ms, each backend must answer within 100 ms with probability 0.99<sup>1/50</sup> ≈ 99.98%, i.e. its p99.98 must be under 100 ms.</p>
<p><strong>Improvements</strong>, roughly in order of preference:</p>
<ul>
<li><strong>Reduce fan-out</strong>: batch calls, cache or precompute aggregates, move non-essential calls off the critical path.</li>
<li><strong>Hedged requests</strong> for idempotent reads, sent after about each backend's p95 (a few percent extra load). In The Tail at Scale's BigTable example, p99.9 fell from 1,800 ms to 74 ms for 2% more requests.</li>
<li><strong>Tied requests</strong>, so a duplicate doesn't double the work.</li>
<li><strong>Per-call deadlines with partial results</strong>: render the page without a slow widget rather than wait for it.</li>
<li><strong>Fix the root causes</strong> of backend tails: GC pauses, queueing at high utilization, noisy neighbours.</li>
</ul>
<p><strong>Caveat:</strong> hedging assumes slowness is independent across replicas. When it is correlated (shared overload), hedges add load to an already struggling system, so cap the hedge rate.</p>`,
      followups: [
        "What per-backend percentile must you target for the page p99?",
        "When can hedging make an incident worse?",
        "How do you pick the hedge delay?",
      ],
      pitfalls: [
        "Adding latencies of parallel calls instead of reasoning about the maximum",
        "Hedging non-idempotent writes",
        "Optimizing medians",
      ],
      section: "tail-latency",
    },

    // ── coping-with-load ────────────────────────────────────────
    {
      id: "q06",
      q: "What is the difference between scaling up and scaling out? When would you pick each?",
      diff: "medium",
      a: `<p><strong>Scaling up (vertical)</strong>: a more powerful machine. You keep single-node semantics: no partitioning, no distributed transactions, simpler operations. Limits: cost rises faster than capacity at the high end, there is a ceiling, and <strong>one machine is one failure domain</strong>, so it gives no fault tolerance.</p>
<p><strong>Scaling out (horizontal, shared-nothing)</strong>: many machines, each with its own CPU, memory and disks, coordinating over the network. No hard ceiling, and nodes fail independently, but state must be partitioned and replicated, which brings consistency and coordination problems (the rest of the book).</p>
<p><strong>How to choose:</strong></p>
<ul>
<li><strong>Stateless tiers</strong>: scale out; it is cheap and easy.</li>
<li><strong>Stateful data systems</strong>: the common wisdom when the book was written (2017) was to keep the database on one node until scaling cost or availability requirements force you to distribute it. Availability usually forces replication before load forces partitioning.</li>
<li><strong>Pragmatic mixture</strong>: a few fairly powerful machines are often simpler and cheaper than many small VMs. Stack Overflow served its traffic from a handful of large servers; WhatsApp reported over 2 million connections on a single server in 2012.</li>
<li><strong>Elastic vs manual</strong>: auto-scaling suits unpredictable load; manual scaling is simpler and has fewer operational surprises.</li>
<li><strong>Rethink at each order of magnitude</strong>: a design right for today's load rarely survives 10× that load.</li>
</ul>
<p>Since the book, distributed SQL and serverless databases have made scale-out easier to adopt, while single machines grew to hundreds of cores and terabytes of RAM, keeping scale-up viable for longer.</p>`,
      followups: [
        "When would you choose manual scaling over auto-scaling?",
        "Why is scaling out a database harder than scaling out a web tier?",
      ],
      pitfalls: [
        "Claiming scale-out is always better",
        "Ignoring operational complexity",
      ],
      section: "coping-with-load",
    },
    {
      id: "q-scale-up-or-out",
      q: "Your single PostgreSQL primary runs at 60% CPU and traffic grows 3x per year. What do you do over the next 12-24 months?",
      diff: "medium",
      a: `<p><strong>Do the growth arithmetic first.</strong> At 3× a year, 60% CPU reaches 100% in about six months (0.6 × 3<sup>t</sup> = 1 gives t ≈ 0.46 years), and load is about 9× today's within two years. Latency degrades well before 100% CPU because of queueing, so the real deadline is earlier still: this is a "within months" problem, and you should expect to rethink the architecture once in the period.</p>
<p><strong>Measure the load parameters:</strong> read/write ratio, hottest queries, working set vs RAM, connection count, and which dimension is growing (users, data per user, write rate).</p>
<p><strong>Plan in stages:</strong></p>
<ol>
<li><strong>Cheap wins (weeks):</strong> query and index tuning, connection pooling (e.g. PgBouncer), caching hot reads, moving analytics and reporting off the primary.</li>
<li><strong>Scale up to buy time:</strong> a bigger instance, knowing cost rises non-linearly and there is a ceiling.</li>
<li><strong>Read replicas</strong> if the load is read-heavy; accept replication lag and route read-your-own-writes cases to the primary (ch5).</li>
<li><strong>Partition</strong> by tenant or user (ch6), or adopt a distributed SQL database, only when write volume or data size demands it. Weigh the operational complexity, and design the migration (dual writes, backfill, cutover) early because it takes months.</li>
</ol>
<p>Keep a standing headroom target at peak and revisit the plan at each order of magnitude.</p>`,
      followups: [
        "Which metric tells you read replicas won't help?",
        "How would you migrate to sharding without downtime?",
      ],
      pitfalls: [
        "Jumping straight to sharding",
        "Ignoring that latency degrades well before 100% CPU",
        "No growth arithmetic",
      ],
      section: "coping-with-load",
    },

    {
      id: "q-autoscaling-spike",
      q: "Your stateless web tier auto-scales on CPU, yet a flash sale that started at noon still caused about ten minutes of errors. Why, and what would you change?",
      diff: "medium",
      a: `<p><strong>Reactive auto-scaling is always late.</strong> The autoscaler acts only after load has risen, and the delays add up: the metric must stay above its threshold for a while (to avoid flapping), the policy fires, instances boot, the application starts and warms its caches and connection pools, and the load balancer's health checks admit it. That commonly takes minutes, while a sale's traffic arrives as a step within seconds. In the gap the existing fleet runs near 100% utilization, queueing delay explodes, timeouts and client retries add even more load, and errors follow.</p>
<p><strong>Other common culprits:</strong></p>
<ul>
<li><strong>The wrong signal.</strong> CPU can look moderate while the real bottleneck is a thread or connection pool, or a downstream dependency. Request rate per instance, concurrency or queue depth track the load more directly.</li>
<li><strong>The bottleneck isn't elastic.</strong> More web servers mean more connections and queries against a database that can't scale out in minutes, so the errors simply move downstream.</li>
<li><strong>Limits.</strong> A maximum group size, account quotas or a shortage of instances in the zone cap how far it can grow.</li>
</ul>
<p><strong>What to change:</strong></p>
<ul>
<li><strong>Pre-scale for known events</strong> with a scheduled capacity floor that starts before the sale. Elasticity is for load you can't predict; a sale on the calendar is predictable.</li>
<li><strong>Keep headroom</strong> with a lower target utilization, so the running fleet can absorb a jump while new instances boot, and shorten boot time with pre-built images and pre-initialized (warm) instances.</li>
<li><strong>Scale on a leading signal</strong>, scale out fast and scale in slowly.</li>
<li><strong>Protect the system while capacity catches up</strong>: rate limits, load shedding or a waiting room, and switching off non-essential features, so overload produces fast rejections for some users instead of timeouts for everyone.</li>
<li><strong>Provision the stateful tiers for the peak in advance</strong> and let caches absorb read spikes; databases are scaled deliberately, not reactively.</li>
</ul>
<p>This is the book's trade-off in practice: elastic scaling suits unpredictable load, manual (planned) scaling is simpler and has fewer surprises, and real systems combine them.</p>`,
      followups: [
        "What metric would you scale a fleet of queue consumers on?",
        "Why is auto-scaling a database much harder than auto-scaling a web tier?",
        "How do you stop an autoscaler from flapping?",
      ],
      pitfalls: [
        "Assuming auto-scaling makes capacity planning unnecessary",
        "Scaling on CPU when the bottleneck is a pool, a queue or the database",
        "Forgetting that new instances take minutes to become useful",
      ],
      section: "coping-with-load",
    },

    // ── operability ─────────────────────────────────────────────
    {
      id: "q07",
      q: "What makes a system maintainable?",
      diff: "medium",
      a: `<p>Most of a system's cost arrives after launch: operations, bug fixes, investigating failures, adapting to new platforms and requirements, repaying technical debt. The book splits maintainability into three principles:</p>
<ul>
<li><strong>Operability: easy to run.</strong> Strong operations can often make up for weak software, but even excellent software fails when operated badly. Help operators with visibility into runtime behavior, support for automation and standard tools, no dependency on individual machines (so nodes can be taken down for maintenance), good docs and a predictable operational model ("if I do X, Y happens"), sensible defaults that can be overridden, and self-healing with manual control when needed.</li>
<li><strong>Simplicity: easy to understand.</strong> Remove <strong>accidental complexity</strong>, the kind that comes from the implementation rather than the problem (Moseley and Marks, "Out of the Tar Pit", building on Brooks). The main tool is abstraction: SQL hides storage structures, concurrency and crash recovery. Simplicity is not fewer features.</li>
<li><strong>Evolvability: easy to change.</strong> Agility at the level of a whole data system, not one codebase: how would you move Twitter's timelines from pull to push while serving traffic? Simple, well-abstracted systems are easier to change, and compatible data formats (ch4) make gradual changes possible.</li>
</ul>
<p><strong>A concrete story:</strong> Knight Capital (August 1, 2012) deployed new code manually and missed one of eight servers; a repurposed flag reactivated dead code there, and the firm lost roughly $440–460 million in about 45 minutes. Manual deploys, dead code and reused flags are maintainability debts that became a business failure. GitLab's 2017 data loss, where backups turned out not to have been working, is the operability version.</p>`,
      followups: [
        "Give an example of accidental complexity you removed.",
        "What would make a database easy to operate?",
      ],
      pitfalls: [
        "Equating simplicity with fewer features",
        "Treating operations as a separate team's problem",
      ],
      section: "operability",
    },

    // ── simplicity-evolvability ─────────────────────────────────
    {
      id: "q-good-abstraction",
      q: "What makes an abstraction good for a data system? Give an example of a good one and a leaky one.",
      diff: "medium",
      a: `<p><strong>A good abstraction:</strong></p>
<ul>
<li><strong>Hides a lot of detail behind a simple interface</strong>, so users reason about <em>what</em>, not <em>how</em>.</li>
<li><strong>Is reusable</strong> across many applications, so one high-quality implementation replaces many ad hoc ones and its improvements benefit everyone. When S3 became strongly consistent for read-after-write in December 2020, with no API change, every application gained without code changes.</li>
<li><strong>Doesn't lie about its properties</strong>: what it hides must be safe to ignore, and what you can't ignore (latency, cost, consistency) should be visible or configurable.</li>
</ul>
<p><strong>Good example: SQL with transactions.</strong> It hides on-disk data structures, concurrent clients and crash recovery; application code states what it wants and the database handles the rest. It removes accidental complexity (Brooks; Moseley and Marks) without removing features.</p>
<p><strong>Leaky examples:</strong></p>
<ul>
<li><strong>RPC frameworks</strong> that make a network call look like a local function call: timeouts, retries, partial failure and latency leak through (ch4, ch8).</li>
<li><strong>ORMs</strong> that hide query patterns until an innocent loop issues N+1 queries.</li>
<li>A <strong>key-value API over an eventually consistent store</strong> that looks strongly consistent until a read returns stale data.</li>
</ul>
<p>Good abstractions also make systems evolvable: you can change what's behind the interface (a new storage engine, a stronger consistency guarantee) without touching callers. Much of the book is a search for such abstractions: transactions, consensus, logs.</p>`,
      followups: [
        "When should an abstraction expose something rather than hide it (e.g. consistency level)?",
        "How do good abstractions make a system more evolvable?",
      ],
      pitfalls: [
        "Equating abstraction with adding layers",
        "Confusing simplicity with fewer features",
      ],
      section: "simplicity-evolvability",
    },
  ],
});
