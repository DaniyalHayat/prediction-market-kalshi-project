# Quant research source ledger

Source review completed on November 4, 2026 ET. The review covers three source inputs, their cited references, and additional primary literature. The [machine-readable ledger](../review/quant-research-sources.json) records source identities, access outcomes, and reading scope.

## Coverage and interpretation

- **161 supplied occurrences → 97 distinct domain/title entries across 61 requested domains.** All 97 received a public open attempt or an explicit unresolved-target lookup. Two supplied titles map to arXiv 2403.09267, leaving 96 canonical URL slots; mirrors of the same paper are still separately tracked for requested-site coverage.
- **78 exact targets opened; 6 resolved targets blocked; 13 ambiguous or unresolved entries.** An open checkbox means the exact public page was reached. It does **not** mean its full contents were read or its claims were validated. Of the requested entries, 11 received selected-section reading and 9 received abstract reading; the rest are metadata/excerpt checks or incomplete targets. The duplicate arXiv entry is not counted as another substantive reading.
- **20 additional unique primary papers or official documents** were checked, across 9 canonical domains. All have an explicit reading scope below. The Hawkes 1971 publisher was unavailable, so its original published PDF was read through a public mirror. This is one paper, not two sources for the unique count.
- Three additional URLs were already cited in project documents: Gneiting–Raftery, Kalshi WebSocket sequence semantics, and PostgreSQL clock semantics. The remaining **17 canonical URLs were absent from the scanned docs/review Markdown and JSON before this ledger**. This is a reference-coverage observation, not a claim of research originality or first discovery. “Additional” below means additional to the supplied list.
- No videos were watched, gated downloads retrieved, authenticated pages bypassed, credentials accessed, paid feeds called, deployment performed or profitability/latency certified. A failed open was not retried through access evasion.

## Attachment provenance

| Input | Bytes | SHA-256 | Reading |
|---|---:|---|---|
| attachment_1 | 33689 | `f85a71ac30e8537471623f22f4d3ade1d3007c3848306083b3994027886669bc` | Complete, bounded segments |
| attachment_2 | 5240 | `629b329c825f5e7af4239c30ec475106699b50e4ebc418a9eb427c2b4db62fae` | Complete, bounded segments |
| attachment_3 | 19361 | `81ef662dcce21063b2a7147155c5760f756e5ca74b14f0f2afd433f7b959f2b6` | Complete, bounded segments |

Attachment 1 is a synthesis with equations and architectural assertions. Attachments 2–3 are repeated source titles and research notes, generally without authors or full URLs. Statements that research was being performed in those notes are not treated as independent evidence that a source was actually checked.

## Corrections and application implications

<a id="f01"></a>

### F01: Kalshi matching versus LMSR

**Mechanisms must be separated.** Kalshi documents limit-order entry and complementary YES/NO bid ladders. LMSR is a cost-function market maker with its own state and liquidity parameter.

Keep LMSR as an explicitly illustrative mechanism. Paper fills must consume actual order-book depth and current fee/rounding rules; LMSR marginal prices are not Kalshi fills. [Primary source 1](https://docs.kalshi.com/fix/order-entry), [Primary source 2](https://docs.kalshi.com/getting_started/orderbook_responses), [Primary source 3](https://mason.gmu.edu/~rhanson/mktscore.pdf).

<a id="f02"></a>

### F02: Reservation-price direction

**Reversed trading intuition.** In A–S, r=s−qγσ²(T−t). Positive inventory lowers reservation value to favor selling. With other conditions fixed, a lower bid discourages sellers hitting it, while a lower ask attracts buyers lifting it.

Test sign symmetry and units. Do not apply an unbounded Brownian stock-price model to binary probabilities without boundary/settlement treatment. Read scope: Reservation definitions and Eq. 2.6–2.7 / 3.17, PDF pp3 and 9. [Primary source](https://people.orie.cornell.edu/sfs33/LimitOrderBook.pdf).

<a id="f03"></a>

### F03: GLFT bid sign and HJB transform

**Bid sign error plus an overbroad methods claim.** Theorem 1 defines bid offset δb=s−bid and ask offset δa=ask−s. Both include c=log(1+γ/k)/γ. When adjacent v values coincide, bid=s−c and ask=s+c. The paper explicitly transforms its HJB system into linear ODEs.

Derive prices from offsets consistently. Separate finite-horizon solutions from asymptotic approximations and do not promise nanosecond runtime. Read scope: Abstract and Theorem 1, PDF p6. [Primary source](https://arxiv.org/pdf/1105.3115).

<a id="f04"></a>

### F04: Classic OFI, queue imbalance and conflation

**Incorrect data requirement and missing transport condition.** Cont et al. use changes in best bid/ask prices and queue sizes (Level 1). MLOFI extends across levels. Static depth imbalance is different. Kalshi may net per-price changes during conflation while keeping seq contiguous, so exact event ordering can still be lost.

Label observed-stream estimates with sampling/conflation limitations. Maintain bounded pre-throttle event windows only under stated transport assumptions; clear on snapshots/gaps. Contemporaneous explanation is not automatically future-return prediction. Read scope: Cont data section p7; Kalshi conflation and gap-recovery rules. [Primary source 1](https://arxiv.org/pdf/1011.6402), [Primary source 2](https://arxiv.org/abs/1907.06230), [Primary source 3](https://docs.kalshi.com/websockets/orderbook-updates).

<a id="f05"></a>

### F05: Almgren–Chriss discreteness and finite risk

**Continuous-limit approximation was presented as exact; variance claim is overstated.** The discrete paper defines 2[cosh(κτ)−1]/τ²=κ̃² and obtains the square-root expression as τ tends to zero. Its optimal path solves expected execution cost plus λ times variance under specified impact/price assumptions; it does not establish a directional entry signal.

Show the continuous approximation explicitly or use the discrete relation. Retain finite variance and impact assumptions; realized cost estimates need actual depth, fees and fill uncertainty. Read scope: Expected cost/variance and efficient frontier; Eq. 17–19, PDF pp10–14. [Primary source](https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf).

<a id="f06"></a>

### F06: DeepLOB and GPU/inference claims

**Conflates distinct studies and training with inference.** DeepLOB uses ten price/volume levels and reports training on one Tesla P100; a different 2016 spatial-network paper reports 50 GPUs across nearly 500 stocks. The digital-asset paper reports commodity-GPU training and a two-second forecast horizon. Those are not app inference p99 measurements.

Benchmark actual model/hardware/batch/cold/warm runtime and memory. DeepLOB's simplified gross-before-fee exercise does not establish live profitability. Read scope: DeepLOB data and experimental-setup sections; other papers' abstracts. [Primary source 1](https://arxiv.org/pdf/1808.03668), [Primary source 2](https://arxiv.org/abs/1601.01987), [Primary source 3](https://arxiv.org/abs/2010.01241).

<a id="f07"></a>

### F07: Forecast quality versus tradability

**Unsupported inference.** The requested microstructural forecasting guide explicitly separates machine-learning metrics from complete-transaction practicability and calls for cross-exchange validation. Proper scores evaluate probabilities; trial selection can inflate backtest statistics.

Keep chronological splits, overlapping-label precautions, baselines, calibration, trial records, fees, slippage, queue/fill assumptions and confidence intervals. None of these papers certifies the application's profit or novelty. [Primary source 1](https://arxiv.org/html/2403.09267v3), [Primary source 2](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf), [Primary source 3](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf), [Primary source 4](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf).

<a id="f08"></a>

### F08: Hawkes feasibility and stability

**Overbroad computational and mathematical claims.** Exponential-kernel likelihood/derivatives admit recursive evaluation. Required performance depends on event rate, dimension, optimizer and update cadence. Nonnegative linear Hawkes stationarity conditions do not transfer unchanged to every inhibitory/nonlinear variant.

Fit and benchmark bounded models with residual/held-out checks. Do not treat fitted event intensity as a calibrated contract-resolution probability. Read scope: Laub estimation/branching sections; Bonnet et al. abstract; Bacry survey Appendix C.1 (quant agent read). [Primary source 1](https://arxiv.org/pdf/1507.02822), [Primary source 2](https://arxiv.org/abs/2103.05299), [Primary source 3](https://arxiv.org/abs/1502.04592).

<a id="f09"></a>

### F09: CPU isolation, cache lines and locks

**Multiple systems overstatements.** Linux documents housekeeping and workload constraints; the C++ draft defines implementation-dependent constexpr interference sizes. Layout and access patterns matter for false sharing. Linux futex fast paths can stay in userspace. The Disruptor's default wait strategy explicitly uses locks/conditions.

Use workload-specific profiling and latency distributions. NIC/kernel tuning is not a demonstrated optimization for a hosted Node/REST app, and busy polling spends CPU. [Primary source 1](https://docs.kernel.org/admin-guide/cpu-isolation.html), [Primary source 2](https://docs.kernel.org/admin-guide/kernel-parameters.html), [Primary source 3](https://eel.is/c++draft/hardware.interference), [Primary source 4](https://docs.kernel.org/kernel-hacking/false-sharing.html), [Primary source 5](https://docs.kernel.org/locking/robust-futexes.html), [Primary source 6](https://lmax-exchange.github.io/disruptor/user-guide/index.html).

<a id="f10"></a>

### F10: LMSR scope and loss bound

**Requires explicit outcome/state assumptions.** For one mutually exclusive exhaustive n-outcome market with zero initial inventory, C(q)=b log Σexp(qi/b) implies max_i qi−C(q)+C(0)≤b log(n). This is a derivation under that payout model, not a claim about all linked contracts, fees, or Kalshi.

Define outcome sets, initial state and settlement compatibility. Separate local price normalization from cross-contract no-arbitrage and operational risk. Mathematical inference from the stated cost/payout assumptions. [Primary source](https://mason.gmu.edu/~rhanson/mktscore.pdf).

These corrections do not prove that other HJB/Feynman–Kac formulations are impossible or universally interchangeable. No viscosity-solution proof or exhaustive stochastic-control treatment was completed in this source lane. The specific GLFT transformation is sufficient to reject the paper’s categorical impossibility claim. Likewise, market-making inventory control, optimal liquidation and event-outcome probability prediction have different objectives; combining their names does not establish a unified profitable strategy.

## Requested source checklist

`[x]` = exact target opened, with reading scope stated. `[ ]` = blocked or unresolved/ambiguous. Public-site or near-title candidates for unchecked entries do not count as successful target retrieval. Secondary pages are discovery/context only unless explicitly indicated; the corrections above rely on original papers or official documentation.

- [x] **R001 — reddit.com: r/quant on Reddit: Solarflare ef_vi vs Onload benchmarked on** ([source](https://www.reddit.com/r/quant/comments/1wqsbi2/solarflare_ef_vi_vs_onload_benchmarked_on/)). **opened; metadata/excerpt.** One self-reported Solarflare X2522-Plus benchmark; hardware and traffic details prevent treating its timing table as a universal latency guarantee.

- [x] **R002 — docs.amd.com: ef_vi - UG1586** ([source](https://docs.amd.com/r/en-US/ug1586-onload-user/ef_vi)). **opened; selected sections.** Official Onload UG1586 appendix for ef_vi; vendor scope is compatible adapters and layer-2 access, not cloud HTTP latency.

- [x] **R003 — ramcloud.atlassian.net: View Source** ([source](https://ramcloud.atlassian.net/wiki/plugins/viewsource/viewpagesrc.action?pageId=6848672)). **opened; metadata/excerpt.** RAMCloud engineering notes resolve the generic 'View Source' title to ef_vi ring-buffer setup; project notes are not universal benchmark evidence.

- [x] **R004 — amd.com: ef_vi User Guide \| AMD** ([source](https://docs.amd.com/v/u/en-US/SF-114063-CD-ef_vi_User_Guide)). **opened; metadata/excerpt.** Resolved AMD's guide through its official download index; current guide is SF-114063-CD revision 20, distinct from Onload UG1586.

- [x] **R005 — github.com: The latency of ef_eventq_poll() and ef_vi_transmit() is not stable. #48** ([source](https://github.com/Xilinx-CNS/onload/issues/48)). **opened; metadata/excerpt.** Issue #48 is a user report of unstable polling/transmit timings, useful as a counterexample to deterministic-latency claims, not a controlled benchmark.

- [x] **R006 — docs.kernel.org: CPU Isolation - The Linux Kernel documentation** ([source](https://docs.kernel.org/admin-guide/cpu-isolation.html)). **opened; selected sections.** CPU isolation requires housekeeping/offloading and workload restrictions; it does not prohibit all kernel work or interruptions.

- [x] **R007 — docs.kernel.org: The kernel's command-line parameters** ([source](https://docs.kernel.org/admin-guide/kernel-parameters.html)). **opened; selected sections.** Read nohz_full/isolcpus portions, not all 8,630 lines; flags have configuration and workload conditions.

- [x] **R008 — access.redhat.com: An overview and comparison of the isolcpus kernel parameter** ([source](https://access.redhat.com/solutions/480473)). **opened; metadata/excerpt.** Customer-portal solution opened; subscriber-only material is not treated as read or bypassed.

- [x] **R009 — nimrod.blog: A Subtle Bug Before C++17 \| Nimrod's Coding Lab** ([source](https://nimrod.blog/posts/a-subtle-bug-before-cpp17/)). **opened; metadata/excerpt.** Metadata/excerpt addresses pre-C++17 allocation of over-aligned types; implementation details must be checked against the language version.

- [x] **R010 — ryonaldteofilo.medium.com: Cache Line Alignment in C++ — How It Makes Your Program Faster.** ([source](https://ryonaldteofilo.medium.com/cache-line-alignment-in-c-1aac85e4482f)). **opened; metadata/excerpt.** Blog article opened; cache-alignment discussion is secondary to the C++ draft and measured structure layout.

- [ ] **R011 — medium.com: Data Alignment in C++ — What It Is, Why It Hurts When Ignored, and** ([site/candidate](https://medium.com/@sagar.necindia/list/abfe4deca285)). **unresolved/ambiguous; target not read.** Exact article/author URL unresolved. A Medium curated-list discovery page opened but exposed no target article content.

- [x] **R012 — reddit.com: Idiomatic way to avoid false sharing : r/cpp - Reddit** ([source](https://www.reddit.com/r/cpp/comments/13spubk)). **opened; metadata/excerpt.** Public r/cpp thread opened; discussion provides examples, not a language-standard guarantee.

- [x] **R013 — moderncpp.dev: Cache-Line Archaeology: Finding and Fixing False Sharing in** ([source](https://www.moderncpp.dev/articles/cache-line-false-sharing/)). **opened; metadata/excerpt.** Secondary article opened; its own CPU benchmark cannot establish a universal 64-byte cache line or app-wide speedup.

- [x] **R014 — stackoverflow.com: How does LMAX's disruptor pattern work? - Stack Overflow** ([source](https://stackoverflow.com/questions/6559308/how-does-lmaxs-disruptor-pattern-work)). **opened; metadata/excerpt.** Discussion page opened; LMAX's official guide is authoritative for selectable producers/wait strategies.

- [x] **R015 — medium.com: Pattern for concurrency in latency-sensitive systems \| by Aniket Bidgar** ([source](https://medium.com/@miniproject2019/pattern-for-concurrency-in-latency-sensitive-systems-7a5675a1b8b2)). **opened; metadata/excerpt.** Aniket Bidgar article resolved and opened; implementation commentary is secondary, not proof of end-to-end latency.

- [x] **R016 — sanjeev.pages.dev: The LMAX Disruptor Codebase \| Stay Tuned - Sanjeev Sarda** ([source](https://sanjeev.pages.dev/lmax-disruptor/)). **opened; metadata/excerpt.** Codebase walkthrough opened; not used as authority for profit or portable performance.

- [x] **R017 — lmax-exchange.github.io: LMAX Disruptor User Guide** ([source](https://lmax-exchange.github.io/disruptor/user-guide/index.html)). **opened; selected sections.** Read wait-strategy section: default BlockingWaitStrategy uses a lock/condition variable; claiming all Disruptor configurations avoid locks is incorrect.

- [ ] **R018 — medium.com: From Wall Street to Code: The Performance Secrets of LMAX - Medium** ([site/candidate](https://medium.com/)). **unresolved/ambiguous; target not read.** Exact Medium article unresolved despite exact-title searches. Medium homepage opened; similarly titled Substack index is only a discovery candidate.

- [x] **R019 — semicolony.dev: How Ring Buffers Work: Single-Producer, Multi-Consumer, Lock-Free** ([source](https://semicolony.dev/how-it-works/ring-buffer)). **opened; metadata/excerpt.** Interactive explainer opened; producer/consumer model and memory ordering still need implementation-specific checks.

- [ ] **R020 — ora.ox.ac.uk: Multi-Level Order-Flow Imbalance in a Limit Order Book** ([site/candidate](https://ora.ox.ac.uk/objects/uuid:9b7d0422-4ef1-48e7-a2d4-4eaa8a0a7ec1/files/m89dedb16194e627a2c92d14e3329bd48)). **blocked; target not read.** Oxford repository file returned 403. The same paper's arXiv abstract was read through an alternate public host. [Public alternative](https://arxiv.org/abs/1907.06230).

- [x] **R021 — microalphas.com: Order Flow Imbalance (OFI): Reading Short-Horizon Price Pressure** ([source](https://microalphas.com/order-flow-imbalance/)). **opened; metadata/excerpt.** Secondary OFI explainer opened; classical formula and required inputs were verified in Cont et al.'s original paper.

- [x] **R022 — scribd.com: Price Impact of Order Flow Imbalance \| PDF \| Econometrics - Scribd** ([source](https://www.scribd.com/document/815190826/The-Price-Impact-of-Order-Book-Events)). **opened; metadata/excerpt.** Scribd page metadata opened; no gated download attempted. Same intellectual work as Cont et al. arXiv 1011.6402. [Public alternative](https://arxiv.org/pdf/1011.6402).

- [x] **R023 — arxiv.org: Maximum Likelihood Estimation for Hawkes Processes with self** ([source](https://arxiv.org/abs/2103.05299)). **opened; abstract.** Abstract read: univariate likelihood method explicitly handles excitation or inhibition; do not generalize nonnegative-kernel stationarity rules to every variant.

- [x] **R024 — spiral.imperial.ac.uk: Parameter Estimation of Binned Hawkes Processes - Spiral** ([source](https://spiral.imperial.ac.uk/server/api/core/bitstreams/1ea0b220-3ab1-4e8d-88a8-4be9548c79c0/content)). **opened; metadata/excerpt.** Imperial accepted-paper PDF opened; title/abstract excerpt checked. Binned-count estimation differs from exact event-time likelihood.

- [ ] **R025 — tandfonline.com: Full article: Parameter Estimation of Binned Hawkes Processes** ([site/candidate](https://www.tandfonline.com/doi/full/10.1080/10618600.2022.2050247)). **blocked; target not read.** Publisher returned 403. Accepted-manuscript alternative R024 is public; publisher full text was not read.

- [ ] **R026 — mdpi.com: Quantitative and Comparative Analyses of Limit Order Books ... - MDPI** ([site/candidate](https://www.mdpi.com/2227-9091/7/4/110)). **blocked; target not read.** Publisher returned 429; stopped. Search metadata resolves He and Svischuk's 2019 compound-Hawkes LOB paper; full text not read.

- [ ] **R027 — paperswithbacktest.com: Hawkes Process in Trading: Self-Exciting Models of Trade Clustering** ([site/candidate](https://paperswithbacktest.com/)). **unresolved/ambiguous; target not read.** Exact Hawkes article URL unresolved. Site homepage opened; a guessed wiki route also failed and is not represented as a resolved source.

- [x] **R028 — lup.lub.lu.se: PARAMETER ESTIMATION FOR HAWKE'S PROCESSES** ([source](https://lup.lub.lu.se/student-papers/search/publication/9214287)). **opened; metadata/excerpt.** Lund student-paper record opened; student thesis metadata is not peer-reviewed market-performance evidence.

- [x] **R029 — scribd.com: DeepLOB: CNNs for Limit Order Books \| PDF - Scribd** ([source](https://www.scribd.com/document/659028248/1808-03668)). **opened; metadata/excerpt.** Scribd metadata opened; original DeepLOB arXiv paper used for technical checks.

- [x] **R030 — arxiv.org: DeepLOB: Deep Convolutional Neural Networks for Limit Order Books** ([source](https://arxiv.org/abs/1808.03668)). **opened; selected sections.** Read abstract and selected original-PDF sections: ten price/volume levels, single P100 training, and simplified gross-before-fee experiments. [Public alternative](https://arxiv.org/pdf/1808.03668).

- [ ] **R031 — scholar.google.com: ‪Zihao Zhang‬ - ‪Google Scholar‬** ([site/candidate](https://scholar.google.com/)). **unresolved/ambiguous; target not read.** Exact Zihao Zhang Scholar profile unresolved. Scholar homepage reports inability to perform operation; author's publication page is an alternate discovery source. [Alternative candidate](https://zihao-z.com/publications/).

- [x] **R032 — arxiv.org: Deep Limit Order Book Forecasting A microstructural guide - arXiv** ([source](https://arxiv.org/abs/2403.09267)). **opened; selected sections.** Read abstract and selected HTML conclusion; high classification performance need not yield actionable transactions; cross-exchange validation remains necessary. [Public alternative](https://arxiv.org/html/2403.09267v3).

- [x] **R033 — arxiv.org: [1601.01987] Deep Learning for Limit Order Books - arXiv** ([source](https://arxiv.org/abs/1601.01987)). **opened; abstract.** Abstract read. This separate 2016 spatial-network paper reports a 50-GPU training cluster; do not attribute that configuration to DeepLOB.

- [x] **R034 — maths.ox.ac.uk: Algorithmic market making for options** ([source](https://www.maths.ox.ac.uk/system/files/media/slides%20-%20london.pdf)). **opened; metadata/excerpt.** Author's Oxford options-market-making slide deck opened; metadata/intro checked, not all 83 slides.

- [x] **R035 — stanford.edu: Optimal High-Frequency Market Making - Stanford University** ([source](https://stanford.edu/class/msande448/2018/Final/Presentations/gr5.pdf)). **opened; metadata/excerpt.** Stanford course-project presentation opened; student simulation results are not a general theorem or independently replicated trading result.

- [x] **R036 — people.orie.cornell.edu: High-frequency trading in a limit order book** ([source](https://people.orie.cornell.edu/sfs33/LimitOrderBook.pdf)). **opened; selected sections.** Read reservation-price definitions and approximation sections. Positive inventory lowers reservation value to encourage liquidation. [Public alternative](https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf).

- [x] **R037 — riskhub.org: Hamilton-Jacobi-Bellman Equations Explained - Risk Hub** ([source](https://riskhub.org/blogs/hamilton-jacobi-bellman-equations-explained)). **opened; metadata/excerpt.** Secondary HJB explainer opened; it cannot justify blanket impossibility claims about stochastic-control methods.

- [x] **R038 — arxiv.org: High-frequency market-making with inventory constraints and ... - arXiv** ([source](https://arxiv.org/abs/1206.4810)). **opened; abstract.** Abstract read: extends inventory-constrained market making to directional mid-price dynamics under stated utility assumptions.

- [x] **R039 — hftbacktest.readthedocs.io: Guéant–Lehalle–Fernandez-Tapia Market Making Model - HftBacktest** ([source](https://hftbacktest.readthedocs.io/en/latest/tutorials/GLFT%20Market%20Making%20Model%20and%20Grid%20Trading.html)). **opened; metadata/excerpt.** Official HftBacktest tutorial opened; library-specific approximation/calibration instructions require their own simulation assumptions.

- [x] **R040 — researchgate.net: Dealing with the Inventory Risk: A Solution to the Market Making** ([source](https://www.researchgate.net/publication/51957950_Dealing_with_the_Inventory_Risk_A_Solution_to_the_Market_Making_Problem)). **opened; metadata/excerpt.** ResearchGate metadata/abstract opened; original GLFT arXiv used instead of the mirror for mathematical verification.

- [x] **R041 — api.pageplace.de: The Financial Mathematics of Market Liquidity** ([source](https://api.pageplace.de/preview/DT0400.9781498725484_A37766086/preview-9781498725484_A37766086.pdf)). **opened; metadata/excerpt.** Publisher book preview opened; only preview portions are available, not the entire book.

- [x] **R042 — quantmemo.com: Gueant, Lehalle and Fernandez-Tapia on Inventory Risk** ([source](https://quantmemo.com/writing/paper-gueant-lehalle-inventory-risk)). **opened; metadata/excerpt.** Secondary inventory-risk article opened; GLFT original governs formula signs and assumptions.

- [x] **R043 — medium.com: Deep Dive into IS: The Almgren-Chriss Framework \| by Anboto Labs** ([source](https://medium.com/@anboto_labs/deep-dive-into-is-the-almgren-chriss-framework-be45a1bde831)). **opened; metadata/excerpt.** Anboto Labs article opened; implementation/marketing claims are not independent validation of execution savings.

- [x] **R044 — metricgate.com: Almgren-Chriss Optimal Execution Calculator - MetricGate** ([source](https://metricgate.com/docs/almgren-chriss-execution/)). **opened; metadata/excerpt.** Calculator documentation opened; parameter units, discrete/continuous formulas, and transaction-cost assumptions need explicit validation.

- [x] **R045 — quantt.co.uk: Almgren-Chriss Optimal Execution Explained (2026) - Quantt** ([source](https://www.quantt.co.uk/resources/almgren-chriss-optimal-execution)). **opened; metadata/excerpt.** Secondary 2026 guide opened; publication freshness alone does not validate model calibration.

- [x] **R046 — quantum-blog.medium.com: Almgren-Chriss Optimal Execution Model - Quantum - Medium** ([source](https://quantum-blog.medium.com/almgren-chriss-optimal-execution-model-5a85b66555d2)). **opened; metadata/excerpt.** Secondary model article opened; use the original Almgren–Chriss paper for the mathematical result.

- [ ] **R047 — imperial.ac.uk: Market impact models and optimal execution algorithms** ([site/candidate](https://www.imperial.ac.uk/media/imperial-college/research-centres-and-groups/cfm-imperial-institute-of-quantitative-finance/events/Lillo-Imperial-Lecture1.pdf)). **blocked; target not read.** Imperial Lecture1 PDF returned 403; search metadata resolves lecture sequence. Full slide content not read.

- [x] **R048 — dm13450.github.io: Solving the Almgren Chris Model - Dean Markwick** ([source](https://dm13450.github.io/2024/06/06/Solving-the-Almgren-Chris-Model.html)). **opened; metadata/excerpt.** Implementation walkthrough opened; not independently executed or numerically audited in this source-only lane.

- [x] **R049 — gensyn.ai: LMSR (Logarithmic Market Scoring Rule) - Gensyn** ([source](https://www.gensyn.ai/guides/lmsr-logarithmic-market-scoring-rule)). **opened; metadata/excerpt.** Gensyn's LMSR guide opened; describes that mechanism, not evidence Kalshi uses it.

- [x] **R050 — cultivatelabs.com: How does the Logarithmic Market Scoring Rule (LMSR) work?** ([source](https://www.cultivatelabs.com/crowdsourced-forecasting-guide/how-does-logarithmic-market-scoring-rule-lmsr-work)). **opened; metadata/excerpt.** Vendor LMSR explanation opened; original Hanson's paper supplies primary mathematical provenance.

- [x] **R051 — predictionmarketmath.org: Logarithmic Market Scoring Rules: Hanson's LMSR Cost Function** ([source](https://predictionmarketmath.org/en/learn/lmsr-market-maker-math/)). **opened; metadata/excerpt.** Exact article found through English homepage link and opened. Site's self-described peer-review/team credentials were not independently verified.

- [x] **R052 — github.com: Build Interactive LMSR (Logarithmic Market Scoring Rule ... - GitHub** ([source](https://github.com/xuy/pile/issues/2)). **opened; metadata/excerpt.** GitHub issue is a pedagogical-demo request, not an original LMSR derivation or verified production implementation.

- [ ] **R053 — community.nasscom.in: How Prediction Market Algorithms Work: LMSR Explained** ([site/candidate](https://community.nasscom.in/)). **unresolved/ambiguous; target not read.** Exact community article unresolved; community homepage returned 406. Dailyhunt syndication title appeared in discovery, not read as primary evidence.

- [ ] **R054 — researchgate.net: LOGARITHMIC MARKETS CORING RULES FOR MODULAR** ([site/candidate](https://www.researchgate.net/)). **unresolved/ambiguous; target not read.** Exact ResearchGate record unresolved. Homepage is a login page; original Hanson author-hosted paper is available at R083. [Public alternative 1](https://mason.gmu.edu/~rhanson/mktscore.pdf), [Public alternative 2](https://www.ubplj.org/index.php/jpm/article/view/417/448).

- [x] **R055 — quant.stackexchange.com: Market Making Strategies Found by Hamilton-Jacobi-Bellman** ([source](https://quant.stackexchange.com/questions/40589/market-making-strategies-found-by-hamilton-jacobi-bellman-equation)). **opened; metadata/excerpt.** Quant Stack Exchange question resolved and opened; discussion is not primary proof of HJB correctness.

- [x] **R056 — ideas.repec.org: Macroscopic Market Making - IDEAS/RePEc** ([source](https://ideas.repec.org/p/arx/papers/2307.14129.html)). **opened; metadata/excerpt.** RePEc metadata/abstract opened; routes to Guo, Jin and Nam's Macroscopic Market Making, arXiv 2307.14129.

- [ ] **R057 — youtube.com: The Avellaneda-Stoikov Market Making Model - YouTube** ([site/candidate](https://www.youtube.com/watch?v=GOeeAQXuk-Q)). **unresolved/ambiguous; target not read.** One plausible exact-titled YouTube video identified; open was throttled. No video/audio/transcript watched or accuracy certification made.

- [x] **R058 — web.stanford.edu: Stochastic Control for Optimal Market-Making - Stanford University** ([source](https://web.stanford.edu/~ashlearn/RLForFinanceBook/MarketMaking.pdf)). **opened; metadata/excerpt.** Ashwin Rao's Stanford teaching slides opened; notation/intro checked, not a peer-reviewed model-performance study.

- [x] **R059 — arxiv.org: [2403.09267] Deep Limit Order Book Forecasting - arXiv** ([source](https://arxiv.org/abs/2403.09267)). **opened; metadata/excerpt.** Canonical duplicate of R032 (arXiv 2403.09267); supplied short and subtitle-bearing titles refer to the same paper.

- [x] **R060 — ideas.repec.org: DeepLOB: Deep Convolutional Neural Networks for Limit Order Books** ([source](https://ideas.repec.org/p/arx/papers/1808.03668.html)). **opened; metadata/excerpt.** RePEc metadata opened; same intellectual work as DeepLOB R030.

- [x] **R061 — arxiv.org: Market Making with Deep Reinforcement Learning from Limit Order** ([source](https://arxiv.org/abs/2305.15821)). **opened; abstract.** Abstract read: Attn-LOB reinforcement-learning agent, continuous actions and hybrid reward; no reproduction or live profitability established.

- [x] **R062 — quantmemo.com: Optimal Execution, Explained - Quant Memo** ([source](https://quantmemo.com/concepts/optimal-execution)). **opened; metadata/excerpt.** Secondary optimal-execution overview opened; does not validate a fill model or projected savings.

- [x] **R063 — arxiv.org: Optimal order execution subject to reference strategies - arXiv** ([source](https://arxiv.org/abs/2401.03305)). **opened; abstract.** Abstract read: client reference strategies under execution risk; closed forms depend on the stated broker-dealer utility objective.

- [x] **R064 — scribd.com: Almgren - Chriss - Optimal Execution \| PDF \| Market (Economics)** ([source](https://www.scribd.com/document/1004647641/Almgren-Chriss-Optimal-Execution)). **opened; metadata/excerpt.** Scribd metadata opened; no gated download or authenticated retrieval attempted.

- [x] **R065 — github.com: Optimal-Portfolio-Transactions/Almgren and Chriss Model.ipynb at** ([source](https://github.com/viai957/Optimal-Portfolio-Transactions/blob/master/Almgren%20and%20Chriss%20Model.ipynb)). **opened; metadata/excerpt.** Notebook page opened; metadata checked, notebook not executed or accepted as calibrated trading evidence.

- [x] **R066 — arthur.bagourd.com: A Tale of Two Models: Implementing the Almgren-Chriss framework** ([source](https://www.arthur.bagourd.com/wp-content/uploads/2022/08/A_Tale_of_Two_Models__Implementing_the_Almgren_Chriss_framework_through_nonlinear_and_dynamic_programming.pdf)). **opened; metadata/excerpt.** Author's 29-page implementation report opened; title/abstract excerpt checked, not the full report or notebooks.

- [x] **R067 — smallake.kr: Optimal Execution of Portfolio Transactions∗** ([source](https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf)). **opened; selected sections.** Original Almgren–Chriss paper hosted by a third party; selected sections on expected cost, variance, optimal path and discrete kappa read.

- [ ] **R068 — researchgate.net: FPGA Based Low-Latency Market Data Feed Handler - ResearchGate** ([site/candidate](https://www.researchgate.net/publication/221173597_Low-latency_FPGA_Based_Financial_Data_Feed_Handler)). **unresolved/ambiguous; target not read.** Exact requested ResearchGate work unresolved. Opened near-title Allred feed-handler page is a different work; Zhou et al.'s matching title found in Springer book contents. [Alternative candidate](https://link.springer.com/book/10.1007/978-3-662-45815-0).

- [x] **R069 — scribd.com: 3-Optimal Market Making - Applied Mathematical Finance - Scribd** ([source](https://www.scribd.com/document/1055426335/3-Optimal-Market-Making)). **opened; metadata/excerpt.** Scribd page metadata opened; Guéant's Optimal Market Making paper is the primary alternative, arXiv 1605.01862. [Public alternative](https://arxiv.org/abs/1605.01862).

- [x] **R070 — arxiv.org: [1105.3115] Dealing with the Inventory Risk. A solution to the market** ([source](https://arxiv.org/abs/1105.3115)). **opened; selected sections.** Read original abstract and Theorem 1: linear ODE transform and bid/ask offset signs. Closed-form approximations are not portable nanosecond guarantees. [Public alternative](https://arxiv.org/pdf/1105.3115).

- [x] **R071 — arxiv.org: Closed-form approximations in multi-asset market making - arXiv** ([source](https://arxiv.org/abs/1810.04383)). **opened; abstract.** Abstract read: multi-asset approximations/proxies, finite-horizon and ergodic regimes; not exact universal solutions.

- [x] **R072 — ideas.repec.org: Dealing with the Inventory Risk. A solution to the market making** ([source](https://ideas.repec.org/p/arx/papers/1105.3115.html)). **opened; metadata/excerpt.** RePEc metadata opened; same intellectual work as GLFT R070.

- [x] **R073 — emergentmind.com: Order-Flow Imbalance (OFI) - Emergent Mind** ([source](https://www.emergentmind.com/topics/order-flow-imbalance-ofi-7dff1686-44cf-4cf4-a602-b24df2b7c56e)). **opened; metadata/excerpt.** Aggregator OFI article opened; not a substitute for original formula, sampling requirements or held-out evaluation.

- [x] **R074 — scribd.com: Solarflare Ef Vi User Guide \| PDF - Scribd** ([source](https://www.scribd.com/document/275660886/Solarflare-Ef-Vi-User-Guide)). **opened; metadata/excerpt.** Scribd metadata opened; current AMD guide used for authoritative API provenance.

- [x] **R075 — github.com: openonload/src/include/etherfabric/ef_vi.h at master - GitHub** ([source](https://github.com/majek/openonload/blob/master/src/include/etherfabric/ef_vi.h)). **opened; metadata/excerpt.** Historical majek OpenOnload fork header opened; fork age/API compatibility matters. Not the current vendor-support contract.

- [x] **R076 — redhawk.concurrent-rt.com: Onload User Guide - Concurrent Real-Time Software Portal** ([source](https://redhawk.concurrent-rt.com/docs/root/1Linux/1RedHawk/9.2/AMD-Onload-User-Guide-1.2.pdf)). **opened; metadata/excerpt.** Public mirror of Onload UG1586 v1.2 July 2023 opened; not current revision and not all 424 pages read.

- [ ] **R077 — news.ycombinator.com: It's an absolutely wonderful article - perhaps one of the best I've** ([site/candidate](https://news.ycombinator.com/)). **unresolved/ambiguous; target not read.** Exact HN comment unresolved despite distinctive-quote searches. HN homepage opened; Algolia public-search attempt was inaccessible.

- [ ] **R078 — adaptivesupport.amd.com: multicast packet loss in ef_vi processes while onload processes are** ([site/candidate](https://adaptivesupport.amd.com/)). **unresolved/ambiguous; target not read.** Exact AMD support thread unresolved. Public support homepage renders Loading/CSS Error; no login or workaround attempted.

- [x] **R079 — blog.hieunt.me: LMAX Disruptor: A Superior Alternative to Bounded Queues for** ([source](https://blog.hieunt.me/blog/lmax-disruptor-a-superior-alternative-to-bounded-queues-for-exchanging-data-between-concurrent-t)). **opened; metadata/excerpt.** Secondary Disruptor walkthrough opened; cannot replace official wait-strategy semantics.

- [x] **R080 — lmax-exchange.github.io: LMAX Disruptor: High performance alternative to bounded queues** ([source](https://lmax-exchange.github.io/disruptor/)). **opened; metadata/excerpt.** Official project landing page opened; library throughput claims remain workload-dependent.

- [x] **R081 — martinfowler.com: The LMAX Architecture - Martin Fowler** ([source](https://martinfowler.com/articles/lmax.html)). **opened; metadata/excerpt.** Fowler architecture article opened; architecture exposition is not a promise of equivalent Node/cloud performance.

- [ ] **R082 — youtube.com: LMAX Disruptor and the Concepts of Mechanical Sympathy - YouTube** ([site/candidate](https://www.youtube.com/)). **unresolved/ambiguous; No video/audio/transcript consumed.** Exact YouTube video URL unresolved. Matching Jamie Allen Vimeo page found; video/transcript was not watched/read. [Alternative candidate](https://vimeo.com/40775233).

- [x] **R083 — mason.gmu.edu: Logarithmic Market Scoring Rules for Modular Combinatorial** ([source](https://mason.gmu.edu/~rhanson/mktscore.pdf)). **opened; selected sections.** Author-hosted Hanson paper opened; selected cost/scoring-rule discussion checked. Discrete finite-outcome LMSR needs its own assumptions.

- [x] **R084 — mathoverflow.net: Asymptotic bounds on the maximum loss of Logarithmic Market** ([source](https://mathoverflow.net/questions/510777/asymptotic-bounds-on-the-maximum-loss-of-logarithmic-market-scoring-rules-lmsr)). **opened; metadata/excerpt.** Exact canonical MathOverflow question opened after correcting discovery slug; continuous-state discussion is distinct from finite-outcome b log(n).

- [x] **R085 — docs.kalshi.com: Order Entry - Kalshi's API Documentation** ([source](https://docs.kalshi.com/fix/order-entry)). **opened; selected sections.** Read FIX new-order section: limit orders, post-only option, quantity/price conventions. This is exchange order entry, not an LMSR pricing specification.

- [x] **R086 — stackoverflow.com: Aligning to cache line and knowing the cache line size** ([source](https://stackoverflow.com/questions/7281699/aligning-to-cache-line-and-knowing-the-cache-line-size)). **opened; metadata/excerpt.** Discussion page opened; platform cache-line detection and alignment are not universally equivalent.

- [x] **R087 — stackoverflow.com: False sharing prevention with alignas is broken - Stack Overflow** ([source](https://stackoverflow.com/questions/63706666/false-sharing-prevention-with-alignas-is-broken)). **opened; metadata/excerpt.** Discussion page opened; aligning a containing structure does not automatically separate every independently written field.

- [x] **R088 — arxiv.org: Optimal Execution of Limit and Market Orders with Trade ... - arXiv** ([source](https://arxiv.org/abs/1604.04963)). **opened; abstract.** Abstract read: permanent/temporary impact plus fill uncertainty, terminal penalty and parameter conditions; not guaranteed limit fills.

- [ ] **R089 — tandfonline.com: Full article: Optimal Execution: A Review** ([site/candidate](https://www.tandfonline.com/doi/full/10.1080/1350486X.2022.2161588)). **blocked; target not read.** Publisher full text returned 403; metadata/abstract discoverable only. No paywall bypass.

- [ ] **R090 — resolve.cambridge.org: Optimal Execution - Cambridge University Press & Assessment** ([site/candidate](https://resolve.cambridge.org/)). **unresolved/ambiguous; target not read.** Supplied generic resolve.cambridge title is ambiguous and root returned 403. Public Cambridge chapter candidate opened; exact intended chapter remains unconfirmed. [Alternative candidate](https://www.cambridge.org/core/books/abs/trades-quotes-and-prices/optimal-execution/CBEFAF66FB040C76D1127FC9AFDC0482).

- [ ] **R091 — math-evry.cnrs.fr: Optimal execution cost for liquidation through a limit order market** ([site/candidate](https://www.maths.univ-evry.fr/prepubli/412.pdf)). **blocked; target not read.** Supplied CNRS domain's title resolved to an Evry author-repository PDF, but open timed out. No full-text read.

- [ ] **R092 — researchgate.net: Optimal execution with limit and market orders \| Request PDF** ([site/candidate](https://www.researchgate.net/publication/276530255_Optimal_execution_with_limit_and_market_orders)). **unresolved/ambiguous; target not read.** ResearchGate metadata opened for an exact-title candidate; more than one paper has this generic title, so intended identity remains ambiguous.

- [x] **R093 — github.com: Almgren-Chriss - DYNAMIC PROGRAMMING.ipynb - GitHub** ([source](https://github.com/IlluvatarEru/ElectronicMarkets/blob/master/Almgren-Chriss%20-%20DYNAMIC%20PROGRAMMING.ipynb)). **opened; metadata/excerpt.** Notebook page opened; not executed, audited or claimed to match the optimal strategy.

- [x] **R094 — mathematicsconsultants.com: Optimal Liquidation Algorithms - the Almgren-Chriss Model** ([source](https://mathematicsconsultants.com/2021/10/23/optimal-liquidation-algorithms-the-almgren-chriss-model/)). **opened; metadata/excerpt.** Secondary consultant explainer opened; not evidence of realized client savings or calibrated app behavior.

- [x] **R095 — simtrade.fr: Understanding the Almgren-Chriss Model for Optimal Trade Execution** ([source](https://www.simtrade.fr/blog_simtrade/understanding-almgren-chriss-model-for-optimal-trade-execution/)). **opened; metadata/excerpt.** Exact SimTrade article resolved and opened; secondary pedagogy, not original mathematical proof.

- [x] **R096 — arxiv.org: Optimal Execution with Dynamic Order Flow Imbalance - arXiv** ([source](https://arxiv.org/abs/1409.2618)). **opened; abstract.** Abstract read: execution control includes informational and instantaneous impact, with approximate receding-horizon solutions.

- [x] **R097 — arxiv.org: Deep Learning for Digital Asset Limit Order Books - arXiv** ([source](https://arxiv.org/abs/2010.01241)). **opened; abstract.** Abstract read: commodity-GPU training, two-second Bitcoin forecast horizon and reported walk-forward accuracy are market/study-specific.

## Twenty additional primary sources

These are distinct papers or documents, not alternate hosts counted twice. Abstract-only reads support the described study scope; they do not imply independent replication or a full theorem audit. The original Cont OFI paper, authoritative alternatives for Scribd/ResearchGate items, and blocked Brier paper are excluded from this count.

- [x] **A001: [Queue Imbalance as a One-Tick-Ahead Price Predictor in a Limit Order Book](https://arxiv.org/abs/1512.03492)** — abstract_read. Paper abstract; logistic-regression prediction with stock-dependent results, not executable P&L.

- [x] **A002: [Price dynamics in a Markovian limit order market](https://arxiv.org/abs/1104.4596)** — abstract_read. Stylized best-queue model; transition assumptions require calibration.

- [x] **A003: [A Correction Note for Price Dynamics in a Markovian Limit Order Market](https://epubs.siam.org/doi/10.1137/16M1057437)** — Publisher correction abstract. Published correction must accompany original model; do not silently rely on old formulas.

- [x] **A004: [Simulating and analyzing order book data: The queue-reactive model](https://arxiv.org/abs/1312.0563)** — abstract_read. Queue-state-dependent order intensities; simulator assumptions and execution probabilities require market-specific validation.

- [x] **A005: [Spectra of some self-exciting and mutually exciting point processes](https://academic.oup.com/biomet/article-abstract/58/1/83/224809)** — Published-paper summary/model introduction via public mirror. Original Hawkes paper; covariance and excitation theory, not a profitability theorem. [Public alternative](https://www.dcscience.net/Hawkes-Biometrika-1971.pdf).

- [x] **A006: [Hawkes processes in finance](https://arxiv.org/abs/1502.04592)** — abstract_read. Author survey; multivariate excitation, kernels, estimation and empirical limits.

- [x] **A007: [Hawkes Processes](https://arxiv.org/abs/1507.02822)** — Abstract, branching-ratio and recursive likelihood sections. Author review; simulation, likelihood estimation and validation need event timestamps. [Public alternative](https://arxiv.org/pdf/1507.02822).

- [x] **A008: [Hawkes Models And Their Applications](https://arxiv.org/abs/2405.10527)** — abstract_read. Updated author survey; estimation and application assumptions differ across domains.

- [x] **A009: [Strictly Proper Scoring Rules, Prediction, and Estimation](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf)** — selected_sections_read. Proper scores encourage honest probability distributions; retain outcomes and compare against baselines without claiming classification accuracy is calibration. Previously referenced in `web/docs/nba-challenger-validation.json`, `web/docs/NBA_RESEARCH.md`.

- [x] **A010: [The probability of backtest overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)** — selected_sections_read. Research-selection bias requires recorded trials and validation; no universal safe backtest count.

- [x] **A011: [The Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)** — selected_sections_read. Selection and non-normality adjustment relies on sample and trial assumptions; not proof of future profit.

- [x] **A012: [Kalshi Orderbook Responses](https://docs.kalshi.com/getting_started/orderbook_responses)** — selected_sections_read. YES/NO bid ladders imply complementary asks; static depth imbalance is not event-level OFI.

- [x] **A013: [Kalshi Orderbook Updates](https://docs.kalshi.com/websockets/orderbook-updates)** — Sequence, snapshot/gap recovery and conflation rules. Apply deltas in subscription seq order; replace on snapshot or gap. Conflation nets changes and loses individual events even with contiguous seq. [Public alternative](https://docs.kalshi.com/getting_started/quick_start_websockets). Previously referenced in `web/docs/RUNTIME_RESEARCH.md`.

- [x] **A014: [Kalshi Rate Limits and Tiers](https://docs.kalshi.com/getting_started/rate_limits)** — selected_sections_read. Token budgets and 429 backoff must be read from current docs, not assumed legacy fixed request counts.

- [x] **A015: [Kalshi Fee Rounding](https://docs.kalshi.com/getting_started/fee_rounding)** — selected_sections_read. Paper execution must match current rounding and fee units.

- [x] **A016: [C++ draft hardware interference sizes](https://eel.is/c++draft/hardware.interference)** — selected_sections_read. Implementation-defined constexpr constants are neither universal 64 bytes nor runtime cache-line discovery.

- [x] **A017: [Linux Kernel False Sharing](https://docs.kernel.org/kernel-hacking/false-sharing.html)** — selected_sections_read. Profile actual shared cache lines and structure layouts before padding.

- [x] **A018: [Linux Kernel Robust Futexes](https://docs.kernel.org/locking/robust-futexes.html)** — selected_sections_read. Uncontended lock fast paths can remain in userspace; blocking contention may enter the kernel.

- [x] **A019: [PostgreSQL 17 Date/Time Functions](https://www.postgresql.org/docs/17/functions-datetime.html)** — selected_sections_read. clock_timestamp changes during a statement; now/current_timestamp use transaction start. Previously referenced in `docs/postgres-query-hardening.md`.

- [x] **A020: [PostgreSQL 17 Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html)** — selected_sections_read. Locks and transaction ordering matter for quota and lease publication; isolation is not latency determinism.

## Remaining limits and verification

Exact-target incompleteness is retained above rather than filled with lookalike links. In particular, the FPGA ResearchGate near-title is a different work; the generic Cambridge and ResearchGate execution titles lack enough bibliographic detail to certify their intended identity. Dynamic AMD support and Scholar pages supplied no usable target content. Publisher 403/429 responses and video throttling remain genuine retrieval limits.

The source manifest was checked for complete attachment digests, unique identifiers, all 97 requested entries, valid public HTTPS URL shapes, truthful checkbox/scope consistency, canonical duplicate handling and 20 additional unique URLs. Every quotation is short and attributed in the JSON; the ledger otherwise paraphrases. Source-only documentation changes do not require app tests. There is no repository pre-commit configuration at this review point. Other agents own the concurrent implementation and runtime validation.
