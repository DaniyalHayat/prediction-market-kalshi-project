# Security and data handling

## Credentials and public APIs

I request public Kalshi market data through server-side routes or the separate Python connector. The optional `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` belong in runtime secret settings or an ignored local environment file. The browser does not need those values, and I do not put them in browser storage, source files, exports or API responses.

The application exposes selected public-data and research endpoints. It has no account-balance, account-position or real-order submission route. Research-only forward-test POST routes create or checkpoint simulated research cohorts; they do not submit exchange orders. The Python connector supplies public-data GET routes and needs no Kalshi credentials.

I restrict a separately hosted connector's `ALLOWED_ORIGINS` to the actual dashboard origin. CORS is a browser access control rather than authentication. The public service still needs normal hosting controls, request limits and monitoring.

## Paper positions and exports

Paper positions and their execution journal are stored in the current browser under this application's origin. They contain virtual trades, source timestamps, prices and fee assumptions. They are not synchronized with a Kalshi account or another browser.

I treat a paper journal as private research data. The JSON and CSV downloads may reveal contract choices, timing, sizing and outcomes, so I review them before sharing. CSV exports neutralize formula-leading text; recipients should still open externally supplied files with their normal spreadsheet precautions.

Clearing browser storage removes the journal. A new domain, preview origin or browser has a separate journal. Server-side forward-research cohorts may live in temporary storage and should not be treated as a durable backup. I export records I need to retain and keep private cohorts, warehouse files and journal exports out of Git.

## Simulation boundaries

Paper execution requires an exact matching public book under 90 seconds old. It consumes visible asks for entries and bids for closes, retains partial fills, and records conservative fee assumptions. These checks protect the simulation's interpretation; they cannot guarantee a real fill, preserve a quote, reproduce every exchange billing rule or establish profitable alpha.

Independent model estimates, linked headlines and financial scenarios remain research inputs. No feature proves a future outcome, profitable strategy, operator revenue impact or investment recommendation. Missing and stale evidence must remain visible rather than being replaced with a fabricated observation.

## Repository hygiene

I exclude local environment files, private keys, dependency/build folders, browser-journal exports, private cohorts, warehouse outputs, caches and logs with the repository's `.gitignore`. An ignore rule does not remove a secret from existing Git history. If a credential is exposed, I revoke it at its provider and replace it through the server's secret settings.

For a suspected issue, I avoid posting credentials or private journals in a public issue. I share the smallest reproducible example with secret values and personal research records removed.
