# Deployment and model reference review

Reviewed November 5, 2026 UTC. This record covers the supplied Railway screenshots and fifteen additional model references. Provider settings and live release verification belong in the release record; the local checks below do not establish that production has changed.

## Deployment findings

**Confirmed configuration gap:** the repository contains `web/Dockerfile`, whose `COPY` paths expect `web/` as the build context. A GitHub source with an empty root directory and Dockerfile path `Dockerfile` cannot reproduce the earlier CLI upload of `web/`. Use Root Directory `/web`, Config File Path `/web/railway.toml`, and Dockerfile path `Dockerfile`. Railway documents that the config-file path does not inherit the selected root directory. [Monorepo guide](https://docs.railway.com/deployments/monorepo).

The web CI now uses Node 26.12.1, matching the hosted image, and builds and starts that image on every push/PR. Previously, the regular web check used Node 24 and did not exercise the container; the separate infrastructure workflow built it only for a narrower set of paths. The TOML watch pattern restricts automatic source rebuilds to `/web/**`. Wait for CI is useful once the GitHub integration is authorized and the correct source is connected.

Legacy TOML remains compatible with the existing service during the current release. Railway's current documentation sets December 1, 2026 as the legacy cutoff. Use `railway config migrate`, inspect the generated ownership plan, and preserve the existing service and secret variables when migrating to `.railway/railway.ts`. This review does not apply or claim a completed IaC migration. [Railway configuration reference](https://docs.railway.com/config-as-code/reference), [IaC migration guide](https://docs.railway.com/infrastructure-as-code).

Four local PostgreSQL containers are isolated test environments, not evidence of four deployed managed databases. Consolidating them would remove test isolation without reducing the existing managed Supabase bill. Production uses the configured Supabase connection; a local fixture's memory use cannot estimate production capacity or cost.

The frontend's server proxy uses `MARKET_BACKEND_URL`. Adding a new `NEXT_PUBLIC_API_URL` would not repair that existing path. Backend `/api/health` checks process readiness; its success alone does not prove database, catalog or upstream exchange availability. The end-to-end release must also exercise the public catalog and a selected contract.

### Local verification

- Docker image built successfully with the existing `web/` context and pinned Node 26.12.1 base.
- A new credential-free container returned HTTP 200 from `/api/health` and reported `status: ok`; `id` returned UID/GID 1000. With no exchange credentials configured, streaming correctly remained disconnected.
- The test container was removed after verification. No application credential, database or paid resource was used in this check.
- Workflow YAML and Railway TOML parsed successfully; `git diff --check` passed. Hosted CI and production verification are separate release steps.

## Additional reference checklist

Access descriptions are deliberate: an abstract review is not a full-paper replication. Ranking below is an implementation assessment for this app, rather than a ranking of the papers' academic quality.

| # | Primary reference and access checked | Practical decision |
|---|---|---|
| 1 | [DeepLOB](https://arxiv.org/abs/1808.03668), author abstract | High-value future challenger: spatial book filters plus temporal state. Needs continuous depth histories and a trained, held-out artifact. Published equity results do not validate prediction-market settlement odds. |
| 2 | [Jang/Lee DOI](https://doi.org/10.1109/ACCESS.2017.2779181), publisher unavailable; [author lab bibliography](https://slcf.snu.ac.kr/publications/digital-finance) checked | Domain-specific blockchain predictors need timestamped on-chain inputs and target alignment before evaluation. No reported paper result imported. Author bibliography dates the volume to 2018. |
| 3 | [Alessandretti et al.](https://onlinelibrary.wiley.com/doi/10.1155/2018/8983590), publisher abstract and introduction | Supports cross-asset baselines as a research comparison. Daily cryptocurrency panels are different from live binary-contract books. Reproduce costs and time splits before transfer. |
| 4 | [McNally et al. DOI](https://doi.org/10.1109/PDP2018.2018.00060), publisher bot wall; [author's 2016 MSc antecedent](https://norma.ncirl.ie/2496/1/seanmcnally.pdf), abstract checked | Useful reminder to compare neural forecasts with ARIMA/simple baselines. The accessible thesis is a different document from the 2018 proceedings paper; no full-paper review or replication claimed. |
| 5 | [Tsantekidis et al.](https://pure.au.dk/portal/en/publications/forecasting-stock-prices-from-the-limit-order-book-using-convolut/), author institution abstract | CNN book experiments are relevant when large, aligned event histories exist. Compare against the simpler current OFI model under the same labels and costs. |
| 6 | [Niño et al.](https://link.springer.com/chapter/10.1007/978-3-030-02686-8_34), publisher abstract; full chapter paywalled | Image-like LOB encoding is a candidate representation. Its reported directional accuracy is not a settlement probability or post-fee return. |
| 7 | [Sirignano](https://arxiv.org/abs/1601.01987), author abstract | Deeper book levels may contain information. Requires depth retention and missing-level masks rather than extrapolating from the current best queue alone. |
| 8 | [Nousi et al.](https://arxiv.org/abs/1809.07861), author abstract | High-value comparison design: engineered and learned features must share the same evaluation target and protocol. |
| 9 | [Wallbridge](https://arxiv.org/abs/2003.00130), author abstract | Causal convolution and masked attention are plausible challengers; full attention is not a demonstrated latency or accuracy improvement here. |
| 10 | [Bai/Kolter/Koltun](https://arxiv.org/abs/1803.01271), author abstract | Highest-priority compact neural candidate: a small causal dilated TCN, benchmarked against ridge before considering a larger Transformer. |
| 11 | [keras-tcn](https://github.com/philipperemy/keras-tcn), maintainer README and causal-padding guidance | Useful reference implementation. Causal padding and receptive-field length need explicit checks; noncausal padding cannot be used for live inference. |
| 12 | [Keras](https://keras.io/), official overview and examples | Training framework option, not an independent signal or accuracy improvement. Keep offline training dependencies outside the API image. |
| 13 | [He et al., residual learning](https://arxiv.org/abs/1512.03385), author abstract | Residual connections are a candidate optimization technique for a trained temporal network. Image-recognition benchmarks do not establish market forecasting value. |
| 14 | [TensorFlow](https://www.tensorflow.org/), official overview and workflow examples | Offline tooling option; adding the framework to the live service without a tested artifact would increase weight without evidence of improved forecasts. |
| 15 | [Ntakaris et al., FI-2010](https://arxiv.org/abs/1705.03233), author abstract | Highest-priority evaluation lesson: anchored day-based validation and explicit horizons. FI-2010 equity data may test the pipeline, but is not Kalshi validation. |

## Measurable path from research to a release

The current execution lab already separates short-horizon book pressure from settlement probability, fits OFI chronologically, checks calibration residuals, compares Hawkes arrivals with a Poisson baseline, and reports assumptions for execution schedules. Its synthetic and stock-path experiments are described in `review/execution-research-validation.json`; they are not a live-profitability backtest.

The next neural experiment should first produce an immutable event dataset with contract ID, receive/exchange time, reconnect generation, price levels, sizes, missing-data masks and the exact label horizon. Fit scalers on training data only. Split by time and contract/day; purge labels whose future horizon crosses a split. Retain reconnect and stale-book gates. Compare a small causal TCN with current ridge and zero-change baselines on paired untouched samples. Record directional/class-balanced scores, regression loss, calibration, spread/fees/slippage, p95/p99 CPU time, RSS and artifact size. Promote only an improvement that survives its uncertainty interval and execution costs; report negative results too.

Those are concrete acceptance criteria, not a claimed percentage uplift. No DeepLOB/TCN/Transformer weights were trained or installed by this reference review, and no public-equity or cryptocurrency accuracy figure was substituted for the app's independent probabilities.
