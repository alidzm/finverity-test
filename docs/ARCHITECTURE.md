# Architecture — Program Capacity & Invoice Reservation

This document records the design of the service and the reasoning behind each decision.
Short "Decision / Why / Rejected" blocks are used in place of separate ADR files.

## 1. Problem model

* A **program** has a credit limit `L` denominated in the program currency `P`.
* When an invoice is approved for early payment it **reserves** part of the capacity
  (the invoice amount converted to `P`). When the invoice is repaid, the amount is
  **released** — fully or in several partial repayments.
* `available = L − reserved`. Available may become negative when treasury lowers the
  limit below what is already reserved (an *over-limit* program): new reservations are
  rejected, existing ones are untouched.
* Two independent writers change program state:
  1. **This service's API** — synchronous, real-time reservations/releases from clients.
  2. **Treasury via Kafka** — program limits, repayments and periodic full
     **reconciliation snapshots** that are authoritative for the program state.

A useful analogy is card **authorization holds** (this service) versus the **core
ledger** (treasury): holds are placed in real time; settlement data from the ledger
periodically re-baselines them.

```
  Clients ──HTTPS + JWT──▶ HTTP API ─────────┐
                           (REST + SSE)       │
                                              ├──▶ Application services ──▶ Domain (pure TS)
  Treasury ──Kafka──▶ Treasury consumers ─────┘     reserve / release / query
    treasury.program-capacity.v1  (anti-corruption   upsert program / reconcile
    treasury.fx-rates.v1           layer, zod)               │
             └──▶ *.dlq                                      ▼
                                                     PostgreSQL (source of truth)
  capacity.events.v1 ◀── Outbox relay ◀── outbox_events      │
  SSE subscribers   ◀── LISTEN capacity_changed ◀── pg_notify┘
```

## 2. Key decisions

### 2.1 Concurrency control — per-program row lock, the aggregate decides

Every write to a program (reserve, release, limit change, repayment, reconciliation) is one
transaction of the same shape — here the reservation:

```ts
const program = await programs.lockById(programId);       // SELECT … FOR UPDATE
const winner = await reservations.findByInvoice(programId, invoiceId);
if (winner) return replay(winner);                         // a concurrent duplicate won
const change = program.reserve(request, context, now);     // status + capacity check → new state
await reservations.save(change.reservation);               // persist what the domain returned,
await programs.save(change.program);                       // then ledger, outbox and NOTIFY
```

* **Why.** The program row is the **per-program mutex**, and the capacity rule lives in one
  place — `Program.reserve()` — evaluated on the current, locked state. Concurrent requests
  cannot oversubscribe; no `SERIALIZABLE`, no retry loops. Idempotent replays are answered
  before the lock (fast path) and checked again under it, so a request that loses a race
  against its own retry gets the replay, not `INSUFFICIENT_CAPACITY`.
* Locks are always acquired in the order `programs → reservations`, which rules out
  deadlocks. Reads never lock (MVCC). FX rates are quoted before the lock is taken.
* **Known limit.** A single program serialises its writes on one hot row; throughput per
  program is bounded by how long the lock is held (the few statements of one transaction) —
  orders of magnitude above invoice-approval rates. Sharded counters would be the escape hatch.
* **Rejected.** A single conditional `UPDATE … SET reserved = reserved + $a WHERE limit −
  reserved >= $a` (atomic under `READ COMMITTED`, one round trip shorter under the lock, but
  the rule would live in SQL instead of the domain, and the reason for a rejection — or a
  concurrent duplicate — must be worked out afterwards); optimistic version + retry (retry
  storms under contention); `SERIALIZABLE` + `SUM()` (expensive, still needs retries); Redis
  counters (dual write, weaker durability — not for money); single-writer actor via Kafka
  (forces an asynchronous API, clients need a synchronous yes/no).

### 2.2 Money representation

* Amounts are stored as `bigint` **minor units** using the ISO 4217 exponent of the
  currency (JPY 0, USD 2, BHD 3). In TypeScript they are native `bigint`; on the wire they
  are **decimal strings** (`"1250000.00"`) because JSON numbers lose precision.
  Floating point is never used for money.
* Supported currencies are an explicit allow-list (`src/shared/domain/money/currency.ts`).
* DB constraints: `reserved_minor >= 0`, `credit_limit_minor >= 0`,
  `released_minor <= reserved_minor`. There is deliberately **no** `available >= 0`
  constraint — over-limit is a legal state created by treasury.

### 2.3 Multi-currency

* At reservation time the invoice amount is converted into the program currency using the
  latest treasury rate and the **rate is locked** on the reservation (original amount and
  currency, rate, rate timestamp, converted amount).
* Conversion rounds **up** (ceiling): we never reserve less than the invoice is worth.
* **Releases never use the current rate.** Re-converting at release time would leak or
  mint capacity whenever FX moves between reserve and release. A (partial) release of `r`
  in invoice currency releases
  `floor(reserved × cumulativeReleasedInvoice / invoiceAmount) − alreadyReleased`
  in program currency. This is equivalent to the locked rate, is cumulative (no rounding
  drift across many partial repayments) and the final repayment releases exactly the
  remainder — no dust.
* Rates come from treasury (`treasury.fx-rates.v1`, compacted topic) into the `fx_rates`
  table behind an `FxRateService`. Direct and inverse pairs are supported with exact
  rational arithmetic. A missing pair → `422 FX_RATE_NOT_FOUND`; a rate older than
  `FX_MAX_RATE_AGE_SECONDS` → `503 FX_RATE_STALE` (fail closed).
* Any residual FX difference versus treasury's books is corrected by reconciliation, which
  carries treasury's own program-currency amounts.

### 2.4 Idempotency

| Operation | Key | Behaviour on repeat |
|---|---|---|
| Reserve | natural key `UNIQUE(program_id, invoice_id)` | same amount/currency → `200` with the existing reservation; different → `409 RESERVATION_CONFLICT` |
| Release | `UNIQUE(program_id, release_id)` (`releaseId` = repayment id) | same invoice/amount → `200` with the original release; different → `409 RELEASE_CONFLICT` |
| Kafka message | `inbox_messages.message_id`, written in the same transaction as the state change | duplicate delivery is a no-op |
| Treasury stream | per-program `sequence`; messages with `sequence <= programs.treasury_sequence` are skipped | stale/replayed messages are ignored |

Offsets are committed only after the database transaction commits (at-least-once
delivery + transactional inbox ⇒ effectively-once processing).

### 2.5 Ledger

`capacity_ledger` is an append-only journal (`RESERVE`, `RELEASE`, `LIMIT_CHANGE`,
`RECONCILIATION_ADJUSTMENT`) with deltas, resulting balances, source (`API`/`TREASURY`),
actor (JWT client) and correlation id (request id / Kafka message id). It explains every
number the API returns. `programs.reserved_minor` is a materialised counter for O(1)
reads; the invariant `reserved_minor = Σ outstanding of ACTIVE reservations` is asserted
in tests and re-derived from scratch by every reconciliation.

## 3. Kafka contract (assumed — the assignment does not specify one)

### 3.1 Inbound: `treasury.program-capacity.v1`

All program-scoped messages share **one topic keyed by `programId`**, so Kafka guarantees
a total order per program: a snapshot can never overtake an earlier limit change or
repayment.

```json
{
  "messageId": "6f1c2a0e-…",
  "type": "ProgramUpserted | RepaymentReceived | ProgramReconciled",
  "schemaVersion": 1,
  "programId": "PRG-USD-001",
  "sequence": 1042,
  "occurredAt": "2026-10-13T10:00:00Z",
  "payload": {}
}
```

| type | payload |
|---|---|
| `ProgramUpserted` | `{ currency, creditLimit, status }` — creates the program or changes limit/status (currency is immutable) |
| `RepaymentReceived` | `{ invoiceId, repaymentId, amount: { value, currency } }` — release in invoice currency, same use case as the API |
| `ProgramReconciled` | `{ asOf, currency, creditLimit, status, reservations: [{ invoiceId, invoiceAmount, reservedAmount, releasedAmount, releasedInvoiceAmount }] }` — full state as of `asOf` |

`sequence` is a per-program monotonic number assigned by treasury.

### 3.2 Inbound: `treasury.fx-rates.v1` (compacted, key `BASE/QUOTE`)

`{ messageId, type: "FxRateUpdated", schemaVersion, occurredAt, payload: { base, quote, rate, asOf } }`
— `1 base = rate quote`. Upserted only if `asOf` is newer than the stored one.

### 3.3 Outbound: `capacity.events.v1` (key `programId`, transactional outbox)

`ReservationCreated`, `ReservationReleased`, `ProgramCapacityUpdated`, `ProgramReconciled`;
each carries the program capacity after the change. This lets treasury (and others) learn
about holds placed by this service.

### 3.4 Failure handling

* Schema-invalid messages, unknown types, business-rule violations (e.g. repayment for
  an unknown invoice, currency change) and broken aggregate invariants are **non-retryable**: forwarded to `<topic>.dlq`
  with error headers, then the offset is committed so the partition is not blocked.
* Infrastructure errors (DB unavailable…) are **retried in place** with backoff and
  without committing. Retry topics are deliberately not used — they would break per-program
  ordering.
* `sequence` is monotonic but not necessarily consecutive, so a missed message cannot be
  detected from it; the next snapshot heals any missed message.
* Snapshot size: one program's snapshot is assumed to fit into a Kafka message (1 MB by
  default, compressed ≈ tens of thousands of invoices). Larger programs would need
  chunked snapshots (`snapshotId`, `part/total`) — documented extension.

## 4. Reconciliation

**The problem.** Treasury takes the snapshot at `asOf`; it arrives at `asOf + Δ`. During
`Δ` the API kept accepting reservations and releases. Blindly overwriting would lose them
and could oversubscribe the program.

**The rule.** *The snapshot is authoritative for everything up to `asOf`; changes made
through this service's API after `asOf` are preserved on top of it.* Every reservation
tracks `api_modified_at` — the last mutation that originated from our API (treasury-driven
changes do not count: they are already contained in the ordered treasury stream).
Treasury learns about our changes asynchronously (outbound events), so "after `asOf`" is
widened by a grace window: `api_modified_at > asOf − grace` keeps the local state.

One transaction per program:

1. `SELECT … FOR UPDATE` the program (blocks concurrent writes for this program only).
   Skip if `sequence <= treasury_sequence`. Unknown program → created from the snapshot.
2. Credit limit and status ← snapshot (treasury owns them).
3. For each snapshot reservation:
   * unknown locally → create it (`source = TREASURY`); fully repaid unknown ones are skipped;
   * `api_modified_at > asOf − grace` → keep local state (possibly newer than the snapshot);
   * otherwise → adopt treasury amounts/status; any change is journaled as
     `RECONCILIATION_ADJUSTMENT`; the discrepancy flag is cleared.
4. Local `ACTIVE` reservations missing from the snapshot:
   * created after `asOf − grace` → in flight, keep;
   * older → **keep holding the capacity** and flag `discrepancy = true` (logged, included in
     the outbound event). Releasing capacity because of missing information would mint
     capacity that may not exist — the safe failure mode is to under-allocate.
5. `reserved_minor` ← recomputed `Σ outstanding` (self-heals any drift).
6. Store `treasury_sequence`, `last_reconciled_at`; inbox + outbox rows; commit.

The merge is a **pure function** (`planReconciliation`) covered by table-driven unit tests.
`Program.reconcile()` applies its decisions to the reservations (adopt, import, flag),
re-derives the reserved amount from them and builds the journal (`buildReconciliationLedger`);
the use case only loads, saves and publishes. The `grace` window
(`RECONCILIATION_GRACE_SECONDS`) absorbs ingestion lag and clock skew between treasury and
this service.

## 5. Data model

| Table | Purpose / key columns |
|---|---|
| `programs` | `id` (treasury id), `currency`, `credit_limit_minor`, `reserved_minor`, `status`, `version`, `treasury_sequence`, `last_reconciled_at` |
| `reservations` | `program_id + invoice_id` (unique), `program_currency` (denormalised, immutable), invoice amount/currency, `fx_rate`, `fx_rate_as_of`, `reserved_minor`, `released_minor`, `released_invoice_minor`, `status`, `source`, `discrepancy`, `api_modified_at`, `created_by` |
| `reservation_releases` | `program_id + release_id` (unique), amounts in both currencies, source, actor |
| `capacity_ledger` | append-only journal (see §2.5) |
| `fx_rates` | `(base, quote)` PK, `rate numeric`, `as_of` |
| `inbox_messages` | processed Kafka message ids |
| `outbox_events` | pending outbound events (`published_at IS NULL`) |

All timestamps are `timestamptz(3)` — millisecond precision matches JavaScript `Date`, so
keyset-pagination cursors round-trip losslessly. Migrations are generated by drizzle-kit
(`drizzle/`) and applied by a separate one-shot process under a PostgreSQL advisory lock.

## 6. API

All routes are versioned under `/v1`, require `Authorization: Bearer <JWT>` and a scope.

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/programs` | `capacity:read` | keyset pagination |
| GET | `/v1/programs/{programId}/capacity` | `capacity:read` | limit / reserved / available, version, last reconciliation |
| GET | `/v1/programs/{programId}/capacity/stream` | `capacity:read` | **SSE**: current value, then every change + heartbeats |
| POST | `/v1/programs/{programId}/reservations` | `capacity:reserve` | `201` created, `200` replay, `409`, `422 INSUFFICIENT_CAPACITY` |
| GET | `/v1/programs/{programId}/reservations` | `capacity:read` | filters `status`, `discrepancy`; keyset pagination |
| GET | `/v1/programs/{programId}/reservations/{invoiceId}` | `capacity:read` | includes releases |
| POST | `/v1/programs/{programId}/reservations/{invoiceId}/releases` | `capacity:release` | `{ releaseId, amount? }` — partial or full (amount omitted) |

* Errors use RFC 9457 `application/problem+json` with a stable machine-readable `code`.
* Programs are created only by treasury (`ProgramUpserted` / `ProgramReconciled`); there is
  no program-admin API.
* **Real-time push.** Each write transaction calls `pg_notify('capacity_changed', …)`,
  which PostgreSQL delivers only on commit and in commit order. Every instance holds one
  `LISTEN` connection and fans notifications out to its SSE subscribers, so the stream
  works across horizontally scaled instances without extra infrastructure. On listener
  reconnect, open streams re-read the current state (notifications may have been missed).

## 7. Authentication & authorization

* OAuth2 / OIDC bearer JWTs, verified against the issuer's JWKS (`jose`): signature,
  `iss`, `aud`, `exp`/`nbf`. Scopes are read from `scope` (space-delimited) or `scp`.
* A global guard denies by default; routes declare required scopes.
* Locally, **Keycloak** runs in docker-compose with an imported realm and
  `client_credentials` clients — the service validates tokens exactly as in production.
* Exceptions to "everything is authenticated": `/health/live` and `/health/ready`
  (orchestrator probes cannot carry tokens; they expose no data), the Swagger UI and the
  manual test console at `/ui/` — static pages, disabled unless `SWAGGER_ENABLED` /
  `DEV_UI_ENABLED` is set (local only); their API calls carry a bearer token like any client.
  For the console, the local Keycloak clients allow `http://localhost:3000` as a web origin.
* If the identity provider's JWKS endpoint is unreachable the API answers
  `503 AUTH_UNAVAILABLE` rather than pretending the caller's token is invalid.
* Out of scope: per-program authorization (e.g. a `programs` claim restricting which
  programs a client may touch). Kafka supports SASL/SSL via configuration.

## 8. Code structure — layered modules

The code is a modular monolith: each NestJS feature module (`capacity`, `fx`, `auth`) and
the cross-cutting `shared` code are split into the same four layers. Dependencies point
inwards only:

```
  presentation ──┐                        HTTP controllers, SSE, Kafka consumers
                 ├──▶ application ──▶ domain
  infrastructure ┘                        Drizzle repositories, LISTEN/NOTIFY, outbox, jose
```

| Layer | Contains | May depend on |
|---|---|---|
| `domain` | Aggregates `Program` and `Reservation` as immutable classes that guard their invariants and own every state change; pure functions for calculations (release math, reconciliation planner, FX quote selection, money); domain errors | other domain code only; **no framework or library imports** |
| `application` | Use cases (`ReserveCapacityUseCase`, `ReleaseCapacityUseCase`, `UpsertProgramUseCase`, `ApplyRepaymentUseCase`, `ReconcileProgramUseCase`), queries, **ports** (abstract classes) and output DTOs | domain, application (incl. other modules' public services, e.g. `FxRateService`) |
| `infrastructure` | Adapters implementing the ports: Drizzle repositories and table schemas, the capacity journal (ledger + outbox + NOTIFY), the LISTEN change feed, the jose token verifier, Kafka transport | domain, application, infrastructure |
| `presentation` | Inbound adapters: HTTP controllers + zod request schemas, the SSE stream, Kafka consumers + message contracts (anti-corruption layer), the auth guard | domain, application, presentation |

```
src/
  capacity/  domain/ · application/{ports,dto,use-cases,queries}/ · infrastructure/{persistence,notifications}/ · presentation/{http,messaging}/
  fx/        domain/ (quote selection) · application/ (FxRateService, port) · infrastructure/ (Drizzle) · presentation/messaging/
  auth/      domain/ (Principal, scopes) · application/ (TokenVerifier port) · infrastructure/ (jose) · presentation/ (guard, decorators)
  shared/    domain/ (money kernel, DomainError, InvariantViolationError) · application/ (TransactionManager, messaging contracts, inbox, deduplicator)
             infrastructure/ (database, Kafka transport, outbox/inbox) · presentation/ (problem+json filter, zod pipe, message decoding)
  config/    zod-validated environment → AppConfig        (cross-cutting, outside the layers)
  health/    liveness/readiness probes                      (operational, outside the layers)
```

### Ports and adapters

Ports are abstract classes, which double as Nest DI tokens; each module file binds them
(`{ provide: ProgramRepository, useClass: DrizzleProgramRepository }`).

| Port (application) | Adapter (infrastructure) |
|---|---|
| `ProgramRepository`, `ReservationRepository` | `DrizzleProgramRepository`, `DrizzleReservationRepository` |
| `CapacityJournal` | `PostgresCapacityJournal` — ledger rows, outbox event, `pg_notify` in one transaction |
| `CapacityChangeFeed` | `PostgresCapacityChangeFeed` — one `LISTEN` connection per instance |
| `FxRateRepository` | `DrizzleFxRateRepository` |
| `TokenVerifier` | `JoseTokenVerifier` |
| `TransactionManager` | `DrizzleTransactionManager` |
| `MessageInbox` | `DrizzleMessageInbox` |

Each module owns its tables (`*.schema.ts` next to its adapters); drizzle-kit collects them.

### Aggregates

`Program` (limit, reserved counter, status, treasury sequence) and `Reservation` (one invoice
and its append-only releases) are immutable classes:

* The constructor is private and checks the invariants — `0 ≤ released ≤ reserved`, a
  reservation is `RELEASED` exactly when all its capacity came back, the limit and the counter
  are never negative … — so no code can hold an aggregate in an invalid state. A violation is
  an `InvariantViolationError`: a bug or corrupt data, never a business rejection (on Kafka it
  goes to the DLQ like any deterministic failure).
* Every state change is a method that returns the new instance together with the journal lines
  explaining it: `program.reserve()`, `reservation.release()`, `program.applyTerms()`,
  `program.reconcile()` … The rules live there — rounding up on conversion, the
  `api_modified_at` precedence rule, the status after a release — not in the use cases.
* Repositories take aggregates, never patches, so a new state can only come from those methods.
  They rebuild aggregates with `Program.reconstitute(row)`: a row is structurally the aggregate's
  state (`ProgramState`, `ReservationState`; the Drizzle columns use the domain enums), so there
  are no field-by-field mappers.
* Calculations without state stay pure functions: release math, the reconciliation planner, FX
  quote selection, the money kernel.

TypeScript cannot make `reconstitute` or `Reservation.open` package-private, so the
architecture test does: only infrastructure rebuilds aggregates, and only the domain — that is,
`Program.reserve()`, which checks the capacity — opens a reservation.

### Transactions without leaking the persistence technology

Use cases call `TransactionManager.run(work)`; the open Drizzle transaction is kept in an
`AsyncLocalStorage`, and repositories pick it up implicitly. The application layer therefore
never handles a transaction object. Locking and writing repository methods require an
active transaction and fail fast otherwise. A nested `run()` joins the outer transaction as a
**savepoint** — e.g. `ApplyRepaymentUseCase` (sequence check) runs `ReleaseCapacityUseCase`
inside its own transaction. Aggregates are saved whole, so a use case must not save an
instance it loaded before another write to the same aggregate: `ApplyRepaymentUseCase` stores
the treasury sequence first, and the release then reads the program again under the lock.

### Inbound messaging

Kafka consumers live in each module's presentation layer and are marked `@MessageConsumer()`;
the generic `KafkaConsumerRunner` (shared infrastructure) discovers them through Nest's
`DiscoveryService`, so the transport knows nothing about business modules. Delivery semantics
stay at the edge: `MessageDeduplicator.processOnce()` records the message in the inbox and
runs the use case in the same transaction, so use cases contain no messaging concerns.

### Enforcement

`test/architecture.spec.ts` parses every import under `src/` and fails when a layer depends on
a layer it must not (or the domain imports any package, or the application imports drivers
such as `drizzle-orm`, `pg`, the Kafka client or `jose`), and when aggregate factories that
skip a rule are called outside their layer (see *Aggregates*). It runs with the unit tests.
Composition roots (`*.module.ts`, `main.ts`, `bootstrap.ts`, `migrate.ts`) and the
operational `config` / `health` modules are outside the layers and may wire anything.

### Imports and build

Source imports are extensionless and use the `@/` alias for anything outside the current
directory (`import { DomainError } from '@/shared/domain/domain-error'`). NestJS 12 is
ESM-only and Node's ESM resolver requires full file specifiers, which TypeScript does not
add. The project therefore type-checks with `moduleResolution: "bundler"` and builds with
Nest's **SWC builder**, which rewrites aliases to relative paths and appends `.js`
(`resolveFully`) in `dist/`; tsc runs as a type checker only (`typeCheck: true`). Vitest,
tsx and drizzle-kit resolve the same aliases from `tsconfig.json`.

### Runtime topology

The HTTP API, Kafka consumers and outbox relay run in one process by default but are
switchable via flags (`CONSUMERS_ENABLED`, `OUTBOX_RELAY_ENABLED`) so they can be deployed
as separate workloads from the same image. The outbox relay takes a PostgreSQL advisory
lock so only one instance publishes at a time (preserving event order).

## 9. Testing strategy

* **Unit** (`pnpm test`): money/FX rounding, FX quote selection, the `Program` and
  `Reservation` aggregates (invariants, transitions, reconciliation), release math,
  reconciliation planner and ledger, plus the architecture test.
* **Integration / e2e** (`pnpm test:e2e`, Testcontainers PostgreSQL + Kafka):
  * concurrency — many parallel reservations against a small limit: exactly the expected
    number succeed, `reserved == Σ outstanding`, never above the limit; duplicates racing for
    the last capacity are all answered as replays;
  * idempotent replays and conflicts; partial and full releases in foreign currency;
  * reconciliation: in-flight preservation, discrepancy flagging, treasury adoption;
  * Kafka: messages converge state, duplicates are no-ops, poison messages go to DLQ;
  * HTTP: 401/403, problem+json, SSE; the test console is served only when enabled.

## 10. Assumptions & trade-offs (summary)

1. Treasury publishes the contract in §3; per-program messages share one topic keyed by
   `programId` and carry a monotonic `sequence`.
2. An invoice reserves at most once per program (no re-reservation after release).
3. `releaseId` / `repaymentId` identify a repayment uniquely and are shared between the API
   client and treasury, so the same repayment arriving through both channels is applied once.
4. Release amounts are expressed in the invoice currency.
5. Program currency never changes.
6. Treasury is authoritative for limits and for reservation state as of a snapshot; on
   uncertainty the service errs towards holding capacity (under-allocation).
7. Clock skew between treasury and this service is bounded by the reconciliation grace window.
8. Out of scope: reservation expiry, per-program ACLs, outbox/inbox retention jobs,
   metrics endpoint, chunked snapshots, multi-region.
