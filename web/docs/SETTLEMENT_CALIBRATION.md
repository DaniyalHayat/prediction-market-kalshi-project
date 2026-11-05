# Exchange midpoint calibration replay

The challenger applies one pooled, identity-regularized logistic transform to early traded exchange midpoints. The public replay used 28 anonymous read-only Kalshi requests. Its 16 series span eight requested categories, and 105 observed events passed the frozen price and timing filters. The same market prices underlie the benchmark and challenger. [Kalshi market metadata](https://docs.kalshi.com/api-reference/market/get-markets) · [Batch candle reference](https://docs.kalshi.com/api-reference/market/batch-get-market-candlesticks)

The sample selects one binary-settled contract per event with a fixed ticker hash, then caps each category and opening-week stratum at four contracts. The first qualifying hourly candle has at least one reported contract of volume, both quotes, a spread of at most 25¢ and a timestamp within 48 hours of listing. It precedes recorded close, expected expiration when supplied, and settlement by six hours. The metadata lack point-in-time publication timestamps for the underlying outcome.

Forty earlier settled events train the transform. Forty-eight later observations form the holdout after October 1, 2026. Seventeen overlapping events remain outside both sets. The holdout spans sports, travel, weather, science and culture. The one macro observation overlaps the cutoff. The sampled crypto and climate series yielded no qualifying observations. Both crypto catalog pages were capped.

| Held-out measure | Exchange midpoint | Challenger |
| --- | ---: | ---: |
| Brier score | 0.146842 | 0.149709 |
| Log loss | 0.433735 | 0.448625 |

The paired mean Brier gain is −0.002867, with a seeded week-block interval from −0.006776 to 0.000883. The exchange midpoint won this replay. The transform remains an exchange-derived diagnostic outside the sizing and recommendation model.

From `web`, run `node tools/validate_settlement_calibration.mjs` to regenerate the public receipt from the normalized archive. `--fetch` repeats the bounded capture. The archive records source URLs, response hashes, sample counts and event timestamps. The receipt separates missing category coverage from successful observation and scores.
