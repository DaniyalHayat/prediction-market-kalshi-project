# Predictir research components

The research pipeline runs off the interactive request path. PostgreSQL owns paper positions, ledger events and app state. MongoDB optionally archives public run receipts by content digest. Reprocessing a run yields the same ID and does not create a second document.

| Layer | Responsibility |
| --- | --- |
| Go | Bounded exact-ticker quote replay. Fixed-point arithmetic produces count, midpoint, spread and change without rounding at each input step. |
| Java | Time-checked binary forecast evaluation with Brier score, log loss, a fixed 50% reference and reliability bins. An empty sample or repeated ticker fails validation. |
| Ruby | Validates the two output envelopes, writes a human-readable or JSON receipt, and optionally stores and verifies it in MongoDB. |
| TypeScript | Runs the workers without a shell, applies the archived holdout cutoff, and rejects oversized input or failed workers before producing a receipt. |

## Run the tracked public holdout

Use Node 26, Go 1.26, JDK 17 and Ruby 3.3. Get and verify the pinned Jackson Core JAR using the [Java setup](calibration/README.md), then point `PREDICTIR_JACKSON_JAR` to that file.

```sh
node components/run-research.mts
node components/run-research.mts --format markdown
node components/run-research.mts --quotes /path/to/quotes.ndjson --forecasts /path/to/forecasts.ndjson
```

The default run scores the **48 binary holdout observations** in the tracked public archive. The probability input is the exchange midpoint observed before settlement. This is a market-derived reference and the result does not measure an independently trained model. The archive contains one eligible quote per contract, so that run has zero per-contract midpoint change. Supply a chronological multi-quote file to measure movement. [Archive](../web/research-data/settlement-calibration-archive.json)

Set `PREDICTIR_DEPTH_EXE` to use a prebuilt Go binary. If Ruby is unavailable locally, set `PREDICTIR_RECEIPTS_DOCKER_IMAGE=ruby:3.3.10-bookworm` for the JSON or Markdown run. The coordinator passes only the component source and two report files into the container with read-only mounts.

## Archive and read a receipt

Install the locked dependencies under [receipts](receipts/README.md), set `PREDICTIR_RECEIPTS_MONGODB_URI` in the process environment and run:

```sh
node components/run-research.mts --archive
cd components/receipts
bundle exec ruby receipt.rb get <digest>
```

Run and readback use the official MongoDB driver. Use a database-specific service account with access limited to the receipt collection. For a local integration test, point `PREDICTIR_RECEIPTS_TEST_MONGODB_URI` at a disposable MongoDB instance. Existing Azure Container Apps continue to serve the web app. MongoDB is an optional research store, so a MongoDB outage has no effect on the live Ask Why or portfolio paths.

[MongoDB Ruby driver](https://www.mongodb.com/docs/ruby-driver/current/) · [Azure MongoDB compatibility considerations](https://learn.microsoft.com/en-us/azure/cosmos-db/mongodb/introduction)
