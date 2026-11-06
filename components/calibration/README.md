# Settled forecast calibration

Score a frozen binary forecast cohort using Java 17. The program reads UTF-8 NDJSON from standard input or an input path and writes one JSON receipt. It accepts up to 100,000 unique contracts, 4,096 bytes per row and 64 MiB per input. Empty lines are ignored. An invalid row rejects the entire evaluation without writing a partial receipt.

## Run

Download [Jackson Core 2.21.6](https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-core/2.21.6/jackson-core-2.21.6.jar) from Maven Central. Its SHA-256 is `36111c3a4372cd5c2be6f4ec44a050382487920f3fc38ca3015c9c1678bd7c56`. Use the downloaded file as the classpath and run from the repository root.

```text
java -cp jackson-core-2.21.6.jar components/calibration/Calibration.java held-out.ndjson
```

Each input line contains exactly these fields.

| Field | Meaning |
| --- | --- |
| `ticker` | Exact market identity. Repeated tickers are rejected case-insensitively. |
| `forecast_at` | ISO-8601 instant when the frozen forecast became available. |
| `settled_at` | Later ISO-8601 instant when the exchange settlement became available. |
| `probability_yes` | Finite JSON number between 0 and 1 inclusive. |
| `outcome_yes` | JSON boolean from a verified binary settlement. |

Supply one forecast per contract. Select the cohort and forecast horizon upstream, before scoring. Keep partial payouts, voids, unresolved markets and unknown settlement timestamps out of this binary evaluation. The CLI checks schema, chronology and duplicate identity. Publication-time provenance, holdout design and related-market dependence need validation in the producing pipeline.

The receipt contains sample size, mean squared probability error (Brier score), mean natural-log loss, and the scores of a fixed 50% YES baseline on the same observations. An assigned outcome probability below `1e-15` is floored only for log loss. The ten reliability bins use lower-inclusive, upper-exclusive deciles, with 1 included in the last bin. Empty bins contain null observed rates and mean probabilities. Scores describe the submitted cohort.

## Test

Compile both source files into a temporary directory, then run `CalibrationTest` with that directory and the Jackson jar on the classpath. Java uses a semicolon between entries on Windows and a colon on Linux and macOS.

```powershell
$classes = Join-Path $env:TEMP ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $classes | Out-Null
javac -cp jackson-core-2.21.6.jar -d $classes components/calibration/Calibration.java components/calibration/CalibrationTest.java
java -cp "$classes;jackson-core-2.21.6.jar" CalibrationTest
```
