# Spotify and selected-contract X verification

Checked on 2026-11-05 UTC. These are integration checks, separate from deployment verification and forecasting validation. No credentials or private account data are included.

## Confirmed live behavior

| Check | Result |
| --- | --- |
| Spotify client-credentials token | HTTP 200; Bearer token, 3,600-second provider lifetime. |
| Spotify US artist search | HTTP 200. The application retained the exact requested artist and excluded similar names. |
| Spotify US track search | HTTP 200. The application retained exact track-name matches by the identified artist. Separate releases may have different track IDs. |
| X recent search | HTTP 200 for one ten-post page, restricted to the two curated NBA authors and the selected Lakers/Celtics entity phrases. Returned author expansion identified NBA. |
| `https://api.spotify.com/` | Redirects to Spotify's developer site. Web API calls use the documented `/v1/` paths; a developer landing page is not a failed authenticated API request. |

The X smoke check requested at most ten posts and two author expansions: a conservative maximum of $0.07 at the checked public rates. No second paid read was made to repeat it. Spotify's implemented artist and track lookup paths were then exercised with the configured app credentials; the returned public links remain display-only.

## What changed

The selected-contract evidence panel previously downloaded only the five latest posts from each account and filtered them afterward. A busy league account could push an older, relevant selected-team report out of that tiny window. Evidence retrieval now issues one server-side recent-search query combining the selected names with at most two allowlisted authors. Distinct team nicknames and up to two reported player-availability names help find applicable posts. Search operators are built by the server; entity text cannot inject author or search operators.

The search reserves ten post reads and possible author-expansion reads before requesting data. Its query-scoped cache is shared for 30 minutes. The stored cursor uses fenced publication, exact integer IDs and incremental `since_id` requests. Only posts whose returned author identity matches the allowlist are retained. Missing author identity, incomplete schemas, lost leases, provider backoff and exhausted allowances have distinct outcomes. A returned pagination token is reported as incomplete coverage; pagination and a second timeline fallback are not followed. The existing monthly monetary, post-read and daily request caps still apply. Reservations deliberately overcount sparse responses and provider deduplication; they are an application allowance, not an authoritative provider invoice.

Spotify references now handle identified songs as track searches, rather than skipping those contracts or treating a song as an artist. Both artist and track responses require an exact normalized name match. Track references also check the artist when supplied. US chart context, song identity and artist identity remain distinct. Public URLs reject embedded credentials. A song with both structured artist and song fields must match both when selecting chart rows.

## Configuration choices

| Feature | Decision and benefit |
| --- | --- |
| App-only X public reads | In use. The successful read did not require user OAuth, posting or Direct Message access. |
| X recent search | In use on explicit selected-contract evidence retrieval. More relevant coverage within a bounded request count. |
| X filtered streaming / news subscriptions / webhooks | Not activated by this change. The screenshots' empty lists are consistent with request-driven retrieval. An always-running broad stream would fetch data while no contract is selected and needs an independently enforced paid-event budget. |
| Spotify artist / track catalog | In use for public identity references. No listener history, playback or new user authorization is needed. |
| Spotify popularity / followers / artist top tracks | Not used as substitute chart measurements. Development-mode endpoints and fields changed in 2026; availability of a search result does not supply daily streams or outcome labels. |
| Spotify / Billboard settlement history | Still a distinct data requirement. Apple song snapshots and the dated secondary Kworb US song chart provide source-labeled context, not full artist totals or a calibrated settlement forecast. Official chart links remain available for review. |

Source ranking still requires current, matching entity evidence, promotes publisher diversity and rejects promotional certainty claims. A curated identity or a high engagement count does not prove accuracy. No social or Spotify catalog content is used to adjust the numerical forecast.

## Validation

The focused suite covers author/entity query binding, operator injection, one-page quotas including expansions, shared cache reuse, denied allowances, unverified author rejection, lost lease handling, large-ID cursor advancement, pagination gaps, propagation of selected names, exact Spotify identities and song/artist separation. Existing evidence, research and MCP tests cover retrieval opt-in, source-ranking quality, missing chart histories and Spotify exclusion from assistant packets.

## Primary references

- [Spotify client credentials](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow): server-to-server access for endpoints that do not need user information.
- [Spotify February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026): development-mode search limits, removed endpoints and fields; the implemented limit of three remains within the reduced limit of ten.
- [X recent search endpoint](https://docs.x.com/x-api/posts/search-recent-posts): ten-post minimum, author expansions, incremental IDs and recent-history window.
- [X query construction](https://docs.x.com/x-api/posts/search/integrate/build-a-query): author, phrase and exclusion operators.
- [X pay-per-use pricing](https://docs.x.com/x-api/getting-started/pricing): checked rates of $0.005 per returned post and $0.010 per returned user. Rates can change; provider-console limits remain a separate cost control.
