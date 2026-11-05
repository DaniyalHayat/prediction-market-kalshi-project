# Owner account and guest sessions, pending activation

The review branch implements `GET /api/session`, `POST /api/account/login`, `POST /api/account/logout`, `GET /api/account/profile`, and `GET`/`PUT /api/account/portfolio`. Public signup has no application route. No real account has been created and no Supabase/Auth configuration has been changed.

Guests receive a six-hour encrypted identity cookie. It contains no saved ledger. The paper UI separates guest and owner browser caches, and applies the guest data lifetime/inactivity rules independently. A guest cookie cannot be substituted for an owner cookie because encryption keys are purpose-separated. Production cookies use the `__Host-` prefix, Secure, HttpOnly, Path=/, SameSite=Strict and bounded Max-Age; no Domain attribute is set. [Cookie semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

Owner login accepts only the configured email, delegates password verification to Supabase Auth and requires a confirmed matching user. It does not implement its own password hash database. Tokens stay inside an authenticated encrypted cookie; the backend retains only a hashed session identifier, user ID, expiry and revocation marker. Each protected action validates the retained session and obtains a verified user from Supabase Auth; near-expiry tokens refresh without extending the seven-day application session. Logout revokes the retained session and clears the browser cookie. Invalid owner cookies are cleared on the next session read. Upstream error bodies and tokens never appear in account responses. [Supabase verified-user API](https://supabase.com/docs/reference/javascript/auth-getuser).

Mutating account requests require an allowed application Origin, and cross-site Fetch Metadata is rejected. The frontend proxy validates and forwards this metadata along with private cookies, preserving multiple Set-Cookie headers on the response. Account traffic is not routed through the public data fallback. Login and account quotas use keyed hashes, not email/IP values in operational logs.

Saved ledgers are owner-scoped in SQL. Writes carry an observed revision; initial insert and subsequent compare-and-swap updates each use one atomic statement. Concurrent or stale writes return HTTP 409 with the retained version, preserving both browser and account versions for an explicit UI choice. The backend validates row counts, identifiers, matching trade/position contracts, cash movements, watchlist shape and payload bounds. This remains a user-controlled simulated ledger, not a signed exchange execution history.

## Exact activation prerequisites

After separate approval, apply reviewed migration `004_owner_portfolios.sql` to the backend database, using the existing migration preview/apply workflow. The Supabase migration mirror has identical content. The table enables RLS and grants only the existing backend application role. Browser clients receive no direct table privileges. Keep that role's 12-connection limit and the current pool of four plus one LISTEN connection.

Private backend settings needed are `MARKET_OWNER_EMAIL`, a separate high-entropy `ACCOUNT_COOKIE_SECRET` of at least 32 characters, existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL`. The cookie handler supports the existing backend service secret as a fallback, but a separate account secret is preferred. Changing that secret signs out retained cookies. No secret belongs in a `NEXT_PUBLIC_` setting, browser bundle, committed example, report or workflow artifact.

Disable public signups in the hosted Supabase Auth project before initial activation. The application's `signup_enabled:false` does not change the project's global Auth setting. Review that setting separately; this implementation does not claim it is disabled remotely.

`node tools/setup_owner.mjs` previews the initial account operation. A later explicitly approved `--apply` also requires private `MARKET_OWNER_SETUP_PASSWORD`, 12–200 characters. It requests a confirmed user through Supabase's server-only admin API and does not send an invitation or confirmation email. It never overwrites an existing account, logs a password or configures hosted signup settings. Remove the temporary setup password from the process environment afterward. Do not execute this against real credentials until account activation is approved. [Supabase admin user creation](https://supabase.com/docs/reference/javascript/auth-admin-createuser).

No password-recovery or public registration workflow is provided in this owner-only phase. Such workflows require their own email and account-security review.

## Verified locally

Tests use fixture credentials and an injected Auth client, with no real Supabase account changes. Coverage includes cookie tampering/purpose separation, guest expiry, cookie flags, owner allowlisting, CSRF rejection, token refresh, logout/revocation, generic provider errors, setup preview without side effects, backend/proxy cookie forwarding and service-only telemetry access. Disposable PG17 tests apply migration 004 and verify concurrent initial writes, concurrent updates, stale revision conflicts and owner isolation. Production data and accounts remain unchanged.
