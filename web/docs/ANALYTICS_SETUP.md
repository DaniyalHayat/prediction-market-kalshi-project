# Analytics setup and verification

Reviewed November 4, 2026, America/New_York. Google configuration is saved; the v3 application remains a local review branch and has not been deployed.

## Destination and container

- GA4 property: `562468214`, web stream `16274535760`, measurement ID `G-NJN43KL0FQ`.
- Existing upgraded Tag Manager container: `GTM-5635HXLP`.
- Published container version **2**, **Public workspace measurement**. Its publication and live version were verified in the Google interface. The public `gtm.js` request returned HTTP 200 and contained the expected destination, public events and consent checks.
- The repository copy is `config/analytics/gtm-container.json`. Import with **Merge / overwrite conflicting names** into the existing workspace, review the diff, then publish. The original container was exported as a rollback copy before editing. No new Google account, paid service, permission grant or advertising account was created.

For a future release, configure `NEXT_PUBLIC_GTM_CONTAINER_ID=GTM-5635HXLP` and retain `NEXT_PUBLIC_GA_MEASUREMENT_ID=G-NJN43KL0FQ` so the revocation kill switch names the same destination. GTM takes precedence over the alternative direct GA loader; only one loader runs. Deployment remains held until application review. Do not add another pasted tag snippet to the layout.

## Explicit measurement and privacy

The app loads analytics only after consent. DNT/GPC keep it off. Both published tags additionally require `analytics_storage` consent. Automatic form, browser-history, scroll, video, download and outbound-link detection are disabled. User-provided data collection, including automatic email, address and phone detection, is disabled. Google signals and ad personalization are disabled; no advertising destination is connected by this configuration.

One explicit `page_view` is sent per document; the initialization tag has `send_page_view=false`. Page URLs omit query strings, fragments and arbitrary private paths; referrers contain only their origin. The app resets optional public event fields on each event so an earlier category or market does not bleed into unrelated actions.

The event trigger accepts only `page_view`, `market_select`, `category_select`, `analysis_read_mode`, `news_read_mode`, `paper_cash_adjustment`, `paper_entry`, `paper_close` and `saved_market`. Parameters are limited to sanitized page context, public tickers/categories, summary/long-read mode and add/decrease/save/remove action labels. Amounts, balances, quantities, P/L, probabilities, account identity, passwords, tokens, chat and journals are excluded.

## Reporting interface

The Reports snapshot uses the User behavior template with ten selected cards: top pages, first-user source/medium, session source/medium, new versus returning users, event count by event name, key events by event name, session key-event rate by source/medium, device category, realtime users and retention. Generic city, audience, platform-only and automated insight cards were removed from this snapshot. The saved cards were verified again after a page reload.

Four event-scoped custom dimensions are registered: **Market category** (`market_category`), **Reading mode** (`reading_mode`), **Saved market action** (`save_action`) and **Paper cash action** (`cash_action`). A ticker dimension is deliberately omitted from GA's custom-definition quota; the public ticker remains an event parameter for debugging without making every contract a report grouping.

`paper_entry` is registered as a key event counted once per session, with **no default monetary value**. It measures use of the simulator, never revenue, a purchase or an actual exchange order. The standard `purchase` key event is not emitted by the app.

The property currently has no established visitor dataset. Zero/empty cards are preserved. Custom dimensions are prospective, and the new loader is awaiting the held application release; populated production reports are not claimed. Aggregate visits cannot establish whether a visitor is a recruiter or their identity. Attribution here measures acquisition and product use; it is separate from the held advertising-optimizer project and from trading-return attribution.

## Reproduction

Run `node --test tests/analytics-policy.test.mjs tests/analytics-container.test.mjs` for privacy and container regression checks. Browser review separately verified the saved Google settings. The import contains public configuration identifiers only and no Google credential. Google documentation: [container IDs](https://support.google.com/tagmanager/answer/17070049), [manual page views](https://developers.google.com/analytics/devguides/collection/ga4/views), [consent mode](https://developers.google.com/tag-platform/security/guides/consent).
