# Program Capacity Service

A NestJS service that tracks the capacity of financing programs in real time. Each program has a credit limit. Approved invoices **reserve** part of it, and repayments **release** it again, fully or partially. Clients can read the current **availability** or subscribe to it. An external **treasury** system feeds limits, FX rates, repayments and periodic full **reconciliation snapshots** over Kafka. Programs and invoices may use different currencies.

The design rationale, the assumed Kafka contract and the reconciliation algorithm are in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Highlights

| Concern | How it is handled |
|---|---|
| No oversubscription under concurrency | Every write locks the program row (`SELECT … FOR UPDATE`), and the `Program` aggregate checks status and capacity on that current state. Covered by tests with 250 parallel requests and with duplicates racing for the last capacity. |
| Exact money | `bigint` minor units (ISO 4217 exponents), decimal strings on the wire, rational FX rates, no floats |
| Multi-currency | Conversion at the treasury rate, rounded up; the rate is **locked** per reservation; releases never re-convert |
| Idempotency | Natural key per invoice for reservations, `releaseId` per release, transactional inbox + per-program sequence for Kafka |
| Treasury reconciliation | Pure, unit-tested merge planner: the snapshot wins up to `asOf`, later local changes are preserved, and missing data never frees capacity |
| Reliability | Manual offset commits, blocking retries (per-program order is kept), DLQ for poison messages, transactional outbox for outbound events |
| Real time | `GET …/capacity` reads from the primary; **SSE** stream fed by PostgreSQL `LISTEN/NOTIFY`, delivered on commit and across instances |
| Auditability | Append-only ledger with running balances, actor and correlation id for every change |
| Security | OAuth2 bearer JWTs (JWKS), global deny-by-default guard with per-route scopes, RFC 9457 problem responses |
| Layered architecture | Each module is split into domain → application → infrastructure / presentation; ports and adapters; `Program` and `Reservation` are immutable aggregates that guard their invariants and own every state change; the dependency rule is enforced by a test |

**Stack:** Node 24 · NestJS 12 (ESM, SWC builder) · TypeScript 6 · PostgreSQL 17 + Drizzle ORM · Kafka 4 (KRaft) via `@confluentinc/kafka-javascript` · Keycloak 26 · zod 4 · pino · Vitest + Testcontainers.

## Quick start (Docker)

Requires Docker with Compose v2. The helper scripts and tests also need Node 24 (`nvm use` reads `.nvmrc`) and pnpm via corepack (`corepack enable`).

```bash
docker compose up -d --build     # postgres, kafka (+topics), keycloak (+realm), migrations, app
pnpm install                     # only needed for the helper scripts below
pnpm treasury seed               # "treasury" publishes 3 programs and FX rates via Kafka

export TOKEN=$(./scripts/get-token.sh)            # invoice-service: read + reserve + release
curl -s localhost:3000/v1/programs -H "Authorization: Bearer $TOKEN"
```

* API: <http://localhost:3000>. Swagger UI: <http://localhost:3000/docs>; use **Authorize** and paste the token.
* Test console: <http://localhost:3000/ui/> — a static page (`dev-ui/index.html`) that gets a token from Keycloak
  (or takes a pasted one) and lets you reserve, release, fire a burst of parallel reservations and watch the
  capacity live over SSE. If **Get token** fails with a Keycloak started before the realm allowed this origin,
  recreate it: `docker compose up -d --force-recreate keycloak`.
* Keycloak admin console: <http://localhost:8080> (admin / admin), realm `capacity`.
* OAuth clients (client-credentials grant):

  | client | secret | scopes |
  |---|---|---|
  | `invoice-service` | `invoice-service-secret` | `capacity:read capacity:reserve capacity:release` |
  | `capacity-reader` | `capacity-reader-secret` | `capacity:read` |

### Walkthrough

```bash
P=localhost:3000/v1/programs/PRG-USD-001
AUTH="Authorization: Bearer $TOKEN"

# Reserve a EUR invoice in a USD program (converted at the treasury rate, rounded up, rate locked)
curl -s -X POST $P/reservations -H "$AUTH" -H 'content-type: application/json' \
  -d '{"invoiceId":"INV-1","amount":{"value":"100000.00","currency":"EUR"}}'
curl -s -X POST $P/reservations -H "$AUTH" -H 'content-type: application/json' \
  -d '{"invoiceId":"INV-2","amount":{"value":"250000.00","currency":"USD"}}'

# Same request again → 200 with the same reservation; different amount → 409
curl -s $P/capacity -H "$AUTH"

# Live updates (Server-Sent Events) — keep it open in another terminal
curl -N $P/capacity/stream -H "$AUTH"

# Partial repayment (invoice currency), then release everything outstanding
curl -s -X POST $P/reservations/INV-1/releases -H "$AUTH" -H 'content-type: application/json' \
  -d '{"releaseId":"RPM-1","amount":{"value":"30000.00","currency":"EUR"}}'
curl -s -X POST $P/reservations/INV-1/releases -H "$AUTH" -H 'content-type: application/json' \
  -d '{"releaseId":"RPM-2"}'

# Treasury side (via Kafka)
pnpm treasury program PRG-USD-001 USD 12000000.00              # limit change
pnpm treasury repayment PRG-USD-001 INV-2 RPM-9 100.00 USD     # repayment from treasury
pnpm treasury snapshot PRG-USD-001 scripts/examples/snapshot-PRG-USD-001.json   # reconciliation
pnpm treasury fx EUR USD 1.0912                                # new FX rate

# Read-only client cannot reserve → 403 problem+json
READER=$(./scripts/get-token.sh capacity-reader)
curl -s -X POST $P/reservations -H "Authorization: Bearer $READER" -H 'content-type: application/json' \
  -d '{"invoiceId":"INV-X","amount":{"value":"1.00","currency":"USD"}}'
```

Outbound events can be watched with:
`docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic capacity.events.v1 --from-beginning`.

## Running the service on the host

Infrastructure in Docker, the service in watch mode:

```bash
docker compose up -d postgres kafka kafka-init keycloak
docker compose stop app          # if it is running from the quick start (port 3000)
cp .env.example .env             # also enables Swagger and the test console
pnpm install
pnpm db:migrate
pnpm start:dev
```

### Stopping and resetting

```bash
docker compose stop              # stop everything, keep the data
docker compose down -v           # remove containers and the database volume (then pnpm treasury seed again)
```

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **Get token** in the test console fails with a CORS error | Keycloak was started with an older realm, and the realm is imported only on first start: `docker compose up -d --force-recreate keycloak` |
| `/ui/` returns 404 | The image predates the console (`docker compose up -d --build`), or `DEV_UI_ENABLED=true` is missing from `.env` |
| A EUR or GBP reservation gets `503 FX_RATE_STALE` | The rates are older than `FX_MAX_RATE_AGE_SECONDS` (24 h): publish fresh ones, e.g. `pnpm treasury fx EUR USD 1.0834` |
| `401` after a while | Tokens live 15 minutes: get a new one (the console renews its own) |
| `GET /v1/programs` returns no programs | `pnpm treasury seed` has not run yet, or Kafka is still starting |
| pnpm or syntax errors in the scripts | Wrong Node version: `nvm use` |

## Tests

```bash
pnpm test          # unit: domain rules (money/FX, program, reservation, reconciliation) + architecture test
pnpm test:e2e      # integration/e2e: real PostgreSQL + Kafka via Testcontainers (Docker required)
pnpm typecheck && pnpm lint
```

The e2e suite boots the real `AppModule`; only the JWKS source is swapped for a local key pair. It covers:

* **Concurrency:** 250 parallel reservations against a limit that fits 100, so exactly 100 succeed. Also concurrent duplicate requests (including duplicates racing for the last capacity, which must all get the replay), concurrent identical releases and a mixed reserve/release load. After each scenario the invariants are checked: `reserved = Σ outstanding = Σ ledger deltas`, and never above the limit.
* **API:** FX conversion and rounding, idempotent replays and conflicts, partial/full releases at the locked rate, pagination, problem+json errors.
* **Auth:**
  * 401 for missing, malformed, expired, wrong-audience, wrong-issuer and foreign-key tokens;
  * 403 for a missing scope;
  * only the probes are public; the test console page is served only when enabled, and its API calls still need a token.
* **Reconciliation:**
  * bootstrap from a snapshot;
  * adopting treasury state;
  * keeping newer local changes and in-flight reservations;
  * discrepancy flagging without releasing capacity;
  * stale and duplicate snapshots;
  * over-limit programs.
* **Kafka:** end-to-end ingestion, a duplicate message applied once, poison messages routed to the DLQ while consumption continues, outbox publication.
* **SSE:** the initial state, then every committed change, plus heartbeats, 404 and 401.

## API summary

All routes require `Authorization: Bearer <JWT>` except the `/health/*` probes (the optional `/docs` and `/ui/` pages are static and call the API with a token). Amounts are decimal strings.

| Method | Path | Scope |
|---|---|---|
| GET | `/v1/programs?limit&cursor` | `capacity:read` |
| GET | `/v1/programs/{programId}/capacity` | `capacity:read` |
| GET | `/v1/programs/{programId}/capacity/stream` (SSE) | `capacity:read` |
| POST | `/v1/programs/{programId}/reservations` `{ invoiceId, amount: { value, currency } }` | `capacity:reserve` |
| GET | `/v1/programs/{programId}/reservations?status&discrepancy&limit&cursor` | `capacity:read` |
| GET | `/v1/programs/{programId}/reservations/{invoiceId}` | `capacity:read` |
| POST | `/v1/programs/{programId}/reservations/{invoiceId}/releases` `{ releaseId, amount? }` | `capacity:release` |

Errors are `application/problem+json` documents with a stable `code`:

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `INVALID_AMOUNT`, `BAD_REQUEST` |
| 401 / 403 | `UNAUTHENTICATED` / `FORBIDDEN` |
| 404 | `PROGRAM_NOT_FOUND`, `RESERVATION_NOT_FOUND` |
| 409 | `RESERVATION_CONFLICT`, `RELEASE_CONFLICT` |
| 422 | `INSUFFICIENT_CAPACITY`, `PROGRAM_SUSPENDED`, `UNSUPPORTED_CURRENCY`, `CURRENCY_MISMATCH`, `FX_RATE_NOT_FOUND`, `RELEASE_EXCEEDS_OUTSTANDING`, `RESERVATION_ALREADY_RELEASED` |
| 503 | `FX_RATE_STALE`, `AUTH_UNAVAILABLE` |

## Kafka topics

| Topic | Direction | Key | Content |
|---|---|---|---|
| `treasury.program-capacity.v1` | in | `programId` | `ProgramUpserted`, `RepaymentReceived`, `ProgramReconciled`, each with a per-program `sequence` |
| `treasury.fx-rates.v1` (compacted) | in | `BASE/QUOTE` | `FxRateUpdated` |
| `<topic>.dlq` | out | original | unprocessable inbound messages + `x-dlq-*` headers |
| `capacity.events.v1` | out | `programId` | `ReservationCreated`, `ReservationReleased`, `ProgramCapacityUpdated`, `ProgramReconciled` |

The message schemas are documented in [ARCHITECTURE.md §3](docs/ARCHITECTURE.md#3-kafka-contract-assumed--the-assignment-does-not-specify-one) and enforced in [`treasury-capacity.messages.ts`](src/capacity/presentation/messaging/treasury-capacity.messages.ts) and [`fx-rate.messages.ts`](src/fx/presentation/messaging/fx-rate.messages.ts).

## Configuration

Configuration is validated at startup, and the service fails fast with a list of problems if it is wrong. See [`.env.example`](.env.example) for the full list. The key variables are:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` / `AUTH_JWKS_URI` | — | Token validation |
| `KAFKA_BROKERS` | — | Comma-separated brokers; `KAFKA_SSL` and `KAFKA_SASL_*` for secured clusters |
| `CONSUMERS_ENABLED` / `OUTBOX_RELAY_ENABLED` | `true` | Run consumers and relay in this process; disable them to split API and workers into separate deployments |
| `FX_MAX_RATE_AGE_SECONDS` | `86400` | Older rates are rejected (`503 FX_RATE_STALE`) |
| `RECONCILIATION_GRACE_SECONDS` | `300` | Ingestion-lag / clock-skew window used by reconciliation |
| `SWAGGER_ENABLED` | `false` | Serve `/docs` (enabled in docker-compose for local use) |
| `DEV_UI_ENABLED` | `false` | Serve the manual test console at `/ui/` (enabled in docker-compose for local use) |

## Assumptions & trade-offs

The full reasoning is in the architecture document. In short:

1. **Kafka contract.** The assignment does not define one, so the contract in ARCHITECTURE.md §3 is assumed. All program messages share one topic keyed by `programId`, and each carries a monotonic per-program `sequence` from treasury.
2. **One reservation per invoice.** An invoice reserves at most once per program, so the invoice id is the idempotency key. There is no re-reservation after a release.
3. **Shared repayment ids.** `releaseId` / `repaymentId` identify a repayment uniquely, and the API client and treasury use the same id. A repayment that arrives through both channels is applied once.
4. **Release currency.** Release amounts are in the invoice currency, and capacity is released at the rate locked on the reservation.
5. **Fixed program currency.** A program's currency never changes. Programs are created by treasury only; there is no admin API.
6. **Treasury owns limits and snapshot state.** Treasury is authoritative for limits and for reservation state as of a snapshot. When information is missing, the service keeps capacity reserved and flags a `discrepancy` (under-allocation over over-allocation).
7. **Over-limit is allowed.** Treasury may lower a limit below the reserved amount. `available` can then be negative, and new reservations are rejected.
8. **FX fails closed.** If a rate is missing or stale, the reservation is rejected. Only direct and inverse pairs are used; there is no cross-rate triangulation.
9. **Hot row per program.** All writes to a program serialise on one row. This keeps correctness simple; throughput per program is bounded by transaction latency, which is far above invoice-approval rates.
10. **Public probes.** `/health/*` are public because orchestrator probes cannot carry tokens. Swagger and the test console are off unless enabled.

## Not in scope / next steps for production

* Metrics and tracing (OpenTelemetry, Kafka lag, discrepancy and drift alerts). Today these signals are only structured logs.
* Retention jobs for `inbox_messages` and published `outbox_events`.
* Per-program authorization (e.g. a token claim listing allowed programs) and rate limiting.
* Reservation expiry; chunked snapshots for very large programs; a schema registry (Avro/Protobuf) for Kafka contracts.
* Hardened runtime image (distroless, vulnerability scanning), Helm/Kubernetes manifests, CI pipeline.

## Project layout

Every module is split into the same layers; dependencies point inwards only (presentation /
infrastructure → application → domain). Details: [ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-code-structure--layered-modules).

```
src/
  capacity/                       core bounded context
    domain/                       Program and Reservation aggregates, release math, reconciliation planner (pure TS)
    application/
      use-cases/                  reserve, release, upsert program, apply repayment, reconcile program
      queries/                    capacity/reservation reads, live capacity stream
      ports/                      ProgramRepository, ReservationRepository, CapacityJournal, CapacityChangeFeed
      dto/                        output models shared by HTTP, SSE and outbound events
    infrastructure/
      persistence/                Drizzle tables + repositories, journal (ledger + outbox + NOTIFY)
      notifications/              LISTEN-based change feed
    presentation/
      http/                       controllers (REST + SSE), zod request schemas
      messaging/                  treasury Kafka consumer + message contract (anti-corruption layer)
  fx/                             exchange rates: domain (quote selection) · application · infrastructure · presentation (Kafka)
  auth/                           domain (principal, scopes) · application (TokenVerifier port) · infrastructure (jose) · presentation (guard)
  shared/
    domain/                       money kernel (currencies, amounts, exact FX math), DomainError, InvariantViolationError
    application/                  TransactionManager port, messaging contracts, inbox port, deduplicator
    infrastructure/               database (pool, ALS transactions, migrations), Kafka transport, outbox/inbox
    presentation/                 RFC 9457 filter, zod pipe, OpenAPI helper, message decoding
  config/ · health/               typed configuration · orchestrator probes
test/                             e2e/integration suites (Testcontainers) + architecture test
drizzle/                          generated SQL migrations
dev-ui/                           manual test console (one static page, served at /ui/ when enabled)
docker/                           Kafka topic bootstrap, Keycloak realm
scripts/                          treasury simulator, token helper
```

Imports are extensionless and use the `@/` alias (`@/shared/domain/money/money`). NestJS 12 is
ESM-only and Node's ESM resolver needs full `.js` specifiers; the SWC builder adds them when it
compiles to `dist/`, so the source stays clean.
