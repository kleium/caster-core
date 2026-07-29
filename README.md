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
