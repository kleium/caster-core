# Caster's Tool API

Headless API and ingestion service for [Caster's Tool](https://casterstool.com) —
a FIRST Robotics Competition (FRC) and FIRST Tech Challenge (FTC) event dashboard
for broadcasters and commentators.

Fastify + TypeScript. Serves the web app, the iOS client, and (soon) Caster's
Terminal. **This service is API-only — it serves no HTML, CSS, or JS.**

## What it does

- **Ingestion workers** poll The Blue Alliance, the FIRST FRC/FTC Events APIs,
  Statbotics, FTC Scout and GATool, and normalise everything into Supabase.
  Browsers subscribe to Supabase Realtime directly, so live updates never pass
  through this service.
- **Read API** — events, teams, matches, alliances, rankings, awards,
  advancement, connections, world records, per-team stats and head-to-head, for
  both FRC and FTC.
- **Writes** — `POST /api/sync` (offline-first LWW delta reconciliation), caster
  notes, and TIMS overrides.
- **Auth** — password login and WebAuthn passkeys, both via Supabase.
- **AI storylines** — broadcast narratives over Anthropic, with SSE streaming.

## Origin

A port of the original Python/FastAPI backend, migrated route-by-route with every
response diffed against the FastAPI original until identical. All 83 API routes
are ported and parity-verified.

Two bugs in the original were deliberately **not** carried over:
`/live-event-status/{event_key}` returned 500 instead of 404 (an `HTTPException`
that was never imported), and `/api/status` always reported `ftc: false` because
its probe requested `/v2.0/v2.0`.

## Quick start

```bash
npm install
cp .env.example .env      # fill in at minimum TBA_API_KEY
npm run dev               # tsx watch, hot reload
```

Other scripts: `npm start` (run), `npm run build` (tsc → `dist/`),
`npm run typecheck`.

To run read-only with no background ingestion — useful when another instance
already owns the workers:

```bash
DISABLE_WORKERS=1 npm start
```

## Deploying to Render

Create a **Web Service** pointing at this repository.

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Set every variable from `.env.example` in the service's environment. At minimum:
`TBA_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`.

### Two constraints that will bite if missed

**Run exactly one instance.** Rate-limit buckets, passkey challenges and poller
state are all in-process. A second instance means duplicate ingestion, and
passkey challenges that fail whenever the two requests of a ceremony land on
different instances. Horizontal scaling requires moving that state to Redis first.

**`PASSKEY_RP_ID` must be the web app's domain, not this service's.** WebAuthn
binds credentials to the origin the browser runs on. If the web app lives at
`casterstool.com` and this API at `api.casterstool.com`, then `PASSKEY_RP_ID` is
`casterstool.com`. Pointing it at the API host **permanently invalidates every
existing passkey** and forces every user to re-register.

Optionally attach a disk and set `CACHE_DIR` to it so the payload cache survives
deploys. It is only a cache — losing it costs a rebuild on the next request.

## Architecture notes

- **No push gateway, by design.** Live updates flow worker → Supabase → Realtime
  → browser. This service holds no client WebSockets. The only real HTTP stream
  is the storyline token stream.
- **Resilience** — per-upstream circuit breakers, in-flight request coalescing, a
  two-tier disk payload cache, and retries on transient network errors.
- **Caching** — `data/saved_events/` (gitignored, regenerates on demand) plus a
  Supabase cache tier. `data/static/` holds committed read-only lookups.
- **Python parity helpers** — `lib/pysemantics.ts` and `lib/pyround.ts` replicate
  Python's `or` / `dict.get` / truthiness / banker's-rounding semantics. Ported
  code should use them rather than `??` or `||`, which differ in ways that
  silently change output.

## Known upstream fragility

- **Statbotics** is migrating to token-based auth and is intermittently offline.
  When that switch lands, unauthenticated requests will start failing and a token
  will need wiring in. A local EPA engine is planned to remove this dependency.
- **FTC Scout** rate-limits aggressively under heavy fan-out.

Routes degrade rather than fail hard where possible, but `/season-high-scores`,
`/season-most-wins` and the FTC world-record routes depend on these directly.

## Standalone verification (2026-08-09)

The full 83-route API surface was swept live with FastAPI stopped, to confirm Node has no
hidden dependency on the old backend. Result: 5 failures out of 69 routes checked in the
final pass, all real bugs (not test-harness mistakes) — root-caused and fixed:

- **Statbotics `epa.total_points` shape change.** Statbotics changed this field from
  `{mean: number}` to a bare `number` on `/team_years` and `/team_events`. Confirmed via
  direct `curl` to `api.statbotics.io` (200, bare float) and `/api/status` showing the
  Statbotics breaker closed — this was a real upstream schema change, not an outage. Fixed
  in `statboticsClient.ts` with an `epaTotal()` helper that accepts either shape. Three call
  sites were affected: `getSeasonHighScores` and `getMostWins` were throwing
  (`TypeError: Cannot use 'in' operator...`); `getEpaMap` was *not* throwing — it was
  silently returning `epa: 0` everywhere, since `undefined?.mean` doesn't throw in JS the way
  the equivalent would in Python.
- **FTC Scout GraphQL type-not-found.** Three queries (`getWorldRecord`,
  `getSeasonHighScores`, a `tepRecords` query) had inline fragments referencing
  `MatchScores2026`/`TeamEventStats2026`, types FTC Scout hasn't shipped yet (confirmed via
  a live `__schema` introspection query — newest available type is the 2025 variant).
  GraphQL validates the whole document, so this failed *every* request through those
  queries, not just 2026-season ones. Fixed in `ftcscoutClient.ts` by removing the 2026
  fragments; re-add once FTC Scout ships the type.
- **`match_poller.ts` corrupting live playoff data (the serious one).** Verifying that
  workers can actually write, by pointing the `POLL_EVENTS` test knob at a real
  already-ingested event, immediately deleted 15 real playoff match rows
  (`Purged 15 ghost matches from 2026azfg`). Root cause: the FRC Events API's 2023+ schema
  change unified all playoff levels under `tournamentLevel: "playoff"`, with the actual
  round encoded in a `description` string instead of a distinct level value. The old
  `compLevel` derivation (`level.includes('playoff') → 'sf'` for everything, `.slice(0,2)`
  fallback otherwise) produced wrong match keys for every 2023+ playoff match, so the
  orphan-sweep logic treated the correctly-keyed existing rows as stale and deleted them.
  Fixed by branching on `level === 'playoff'` and parsing `description` (`/^final/i` →
  `f1m{n}`, else `sf{matchNum}m1`) to derive `compLevel`/`setNumber`/`withinSetNum`
  correctly. Verified by dry-running the new logic against live FRC API data and diffing
  the derived keys against a pre-corruption disk-cached snapshot — zero discrepancies across
  98 matches — then letting the fixed poller self-heal the corrupted event (re-upserted the
  98 correct rows, orphan-swept the 17 bad rows it had itself created), and confirming via
  `GET /api/alliances/2026azfg` that `playoff_result`/`playoff_record` were restored.

  **⚠️ The Python original (`backend/app/workers/match_poller.py`) has the identical bug and
  has NOT been fixed** — out of scope by explicit instruction while Node-only work was in
  progress. If FastAPI's poller is still live anywhere, it will corrupt 2023+ playoff data
  the same way; port this fix over before relying on it again.

None of the three were porting regressions — the poller and Statbotics/FTC Scout clients were
faithful ports of behavior that stopped being correct only because an upstream API changed
shape after the original Python was written.

**Do not run `POLL_EVENTS` against a real, already-ingested event without the match_poller
fix above in place** — it's a legitimate way to verify worker writes, but only once the
comp-level derivation is correct; otherwise it's destructive.
