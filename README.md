# Spikerz rate limiter

A NestJS rate limiter with an exact rolling hour and a live React admin dashboard. [DESIGN.md](DESIGN.md) describes the rolling window, persistent bypass, and persistent extra quota.

## Run the demo

Requires Docker Engine with Compose. The first build downloads Node, PostgreSQL, nginx, and npm dependencies.

```sh
cp .env.example .env
# Edit .env and set DEMO_PASSWORD to your chosen local demo password.
docker compose up --build -d --wait
```

Open [localhost:8080](http://localhost:8080). Sign in as the seeded **admin** using the `DEMO_PASSWORD` you set in `.env`. The issuer also seeds **alice**, **bob**, and **charlie**. These accounts exist immediately; users appear in the observed registry after traffic. To populate three example usage levels, use Node 24:

```sh
npm ci
npm run demo:seed
```

The seed command reads `.env` automatically. An existing `DEMO_PASSWORD` environment variable takes precedence. Both Compose and the seed script require a nonempty password; `.env.example` contains an empty placeholder and can be committed. The `.env` file is excluded from Git, Docker build contexts, and submission archives.

Alternatively use **Send requests** in the dashboard. Sending 101 requests to a fresh user admits 100 and returns one 429. Select a user to view history and change its limit, extra quota, bypass, or usage epoch. Admin requests wait for the data plane to apply the change and return the committed state. The inspector shows the applied revision and recent audit outcomes. Extra quota and bypass have **no expiry**.

```sh
docker compose logs -f data-api control-api management-api
docker compose down
```

`down` preserves database and signing-key volumes. `docker compose down -v` discards this demo's data and keys. The web entry point is bound to `127.0.0.1:8080`. PostgreSQL ports are published on loopback for local database tools: data on 5433, control on 5434, and management on 5435. Each database has its own private network, credentials, and volume. Internal HTTP routes are excluded from the web proxy.

### Connect from PyCharm

Open **View → Tool Windows → Database**, then **+ → Data Source → PostgreSQL**. Create one data source per database using host `127.0.0.1` and these development defaults:

| Database   | Port | User       | Password                  | JDBC URL                                      |
| ---------- | ---- | ---------- | ------------------------- | --------------------------------------------- |
| data       | 5433 | data       | local-data-password       | `jdbc:postgresql://127.0.0.1:5433/data`       |
| control    | 5434 | control    | local-control-password    | `jdbc:postgresql://127.0.0.1:5434/control`    |
| management | 5435 | management | local-management-password | `jdbc:postgresql://127.0.0.1:5435/management` |

Use any password overrides from your environment or `.env` instead of these defaults. Click **Download missing driver files** if prompted, then **Test Connection → OK**. In the **Schemas** tab, select `public` if tables are not visible. Enable the **Database Tools and SQL** plugin in PyCharm settings if the Database tool window is unavailable.

For Python clients, the connection URLs are:

```text
postgresql://data:local-data-password@127.0.0.1:5433/data
postgresql://control:local-control-password@127.0.0.1:5434/control
postgresql://management:local-management-password@127.0.0.1:5435/management
```

The default Compose configuration is explicitly a **local development demo**. Copy `.env.example` to `.env` and configure `DEMO_PASSWORD` before starting; `.env.example` also documents the other configuration values. For an external deployment, remove the demo issuer, configure `AUTH_PUBLIC_KEY`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `WEB_ORIGIN`, and unique service/database credentials, and provide TLS at the ingress. The development issuer refuses to run with `NODE_ENV=production`. Its RSA private key is mounted only in its own container; the APIs obtain only the public key. Login tokens expire after an hour; sign in again when needed. Demo traffic uses the current admin token to request a user token for alice, bob, or charlie; These user tokens expire after at most five minutes and never outlive the authorizing admin token. The browser clears the password after successful login. No access tokens are placed in URLs or events.

## Architecture

| Component             | Owns                                                                                                        | Storage                |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| `apps/data-api`       | Verified user identity, interceptor, atomic admission, applied policy, expiry refresh, event outbox         | Data PostgreSQL        |
| `apps/control-api`    | Admin authorization, synchronous command delivery, audit records and idempotency                            | Control PostgreSQL     |
| `apps/management-api` | Deduplicated history, current projections, analytics, change notifications, authenticated WebSocket gateway | Management PostgreSQL  |
| `apps/admin-web`      | React + TypeScript + MUI dashboard, filters, user inspector, history, admin actions, demo traffic           | Browser session        |
| `apps/dev-issuer`     | Explicitly enabled local token issuer for the four seeded identities                                        | Private RSA key volume |

`packages/contracts` contains API types and boundary validation; `packages/auth` verifies JWTs and roles; `packages/quota-math` documents the pure quota/status calculations. Each plane has its own database repository and migrations under `infra/sql`. No plane connects to another plane's database.

The guard verifies RS256 signatures, issuer, audience, expiration, and role. Identity is an unambiguous JSON tuple of verified issuer and subject. Headers such as `X-User-ID` cannot choose the requesting user's bucket. All demo business routes share that bucket.

Admission calls the PostgreSQL `consume_quota` function once. Its first state update establishes database write ordering for the user; subsequent statements sample fresh database time, delete/refund expired charges, conditionally decrement a positive balance, and insert the charge plus decision outbox event. All of these effects commit together. Business handlers execute only after committed admission. There is no application mutex, explicit `SELECT FOR UPDATE`, Redis, or message broker.

Every writer follows the same accounting protocol. A limit reduction preserves negative balance as debt. Reset advances a quota epoch, so old charges can never refund into the new quota. Admin command receipts prevent duplicate effects after an acknowledgment is lost. The control API sends each change directly to `POST /internal/commands` and returns 200 only after the data plane commits and the control plane saves the receipt. The data transaction assigns revisions in application order. Concurrent edits take effect in that order; the last applied edit to a field wins. There is no desired-policy table, control worker, command queue, or automatic delivery retry.

Small observability workers poll committed work: outbox delivery every 250 ms, due quota expirations on each outbox tick, browser feed every 100 ms, and health heartbeat every second. A cross-replica advisory lock allows one outbox dispatcher. The internal management feed uses a transactional singleton counter to allocate positions in commit order, so a worker restart can still notify committed changes. Delivery is at least once; event IDs and per-user versions prevent duplicate analytics and detect gaps. WebSocket change notifications contain only a user ID; the browser fetches current data over HTTP after subscribing or reconnecting. Notifications coalesce into dashboard refreshes every 200 ms and selected-user refreshes every 250 ms. A 30-second fallback refresh also covers missed notifications and activity aging out without quota changes. No browser replay cursor or event buffer is needed.

## Quota behavior

- Default capacity: **100 per user**. Capacity is base limit plus persistent extra quota.
- Charged requests count while `admitted_at > database_time - 1 hour`, in the current reset epoch. The lower boundary is exclusive.
- Bypassed requests and denied requests are observable but do not consume quota. Existing charges continue expiring during bypass. Business failures remain charged after admission.
- `x-count` reports remaining quota after the decision, including bypassed requests. CORS exposes it and `Retry-After`. Concurrent responses can arrive out of order.
- A 429 includes `x-count: 0`, rounded-up `Retry-After` seconds, and a UTC `retryAt`. After a capacity reduction, it waits for enough charges to expire, rather than simply the oldest charge.
- Status: OK below 90%, Warning from 90% to below 100%, Exceeded at or above 100%. Bypass is an independent badge.
- **Next quota change** is the earliest outstanding charge's expiry, rather than a scheduled full reset. **Last manual reset** is nullable.
- Analytics count distinct authenticated observed users; near-limit percentage includes Warning users; today's 429 count uses UTC day boundaries. Rankings count all admitted requests in the past hour, including bypassed traffic, with charged usage shown separately. History retains 26 hours and separates regular, bypassed, and denied decisions.

Data/database errors fail closed with **503** and skip the business handler. An uncertain commit is never retried automatically. A management outage leaves admission available and accumulates durable events; a control outage leaves the last applied policy active. Storage capacity is the practical bound on outage buffering. The dashboard displays connectivity, stale source health, snapshot time, outbox backlog, and command audit outcomes. Sub-second update latency is a target under normal local load, not a guarantee.

## API reference

Public paths through the local proxy:

| Route                                                                   | Purpose                                                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /auth/token`                                                      | Development only: `{ "subject": "admin", "password": "<configured DEMO_PASSWORD>" }` → access token |
| `POST /auth/demo-token`                                                 | Development only, admin bearer token required: `{ "subject": "alice" }` → demo user token           |
| `GET /data/demo`                                                        | Protected request with `Authorization: Bearer <token>`                                              |
| `GET /data/demo/second-route`                                           | Shares the same user bucket                                                                         |
| `GET /data/demo/fail`                                                   | Demonstrates a charged admission followed by business failure                                       |
| `GET /management/users?search=&status=&lastActiveSince=&cursor=&limit=` | Search/filter and keyset pagination; default page 100, max 500                                      |
| `GET /management/users/:id`                                             | Current observed state                                                                              |
| `GET /management/users/:id/requests?range=hour\|day&cursor=`            | History, chart buckets, and next page cursor                                                        |
| `GET /management/analytics/summary`                                     | User/near-limit/UTC-denial metrics                                                                  |
| `GET /management/analytics/top-users`                                   | Past-hour admission rankings                                                                        |
| `GET /management/status`                                                | Ingestion/expiry-worker health and outbox backlog                                                   |
| `PUT /control/admin/users/:id/limit`                                    | `{ "value": 100 }`                                                                                  |
| `PUT /control/admin/users/:id/extra-quota`                              | `{ "value": 50 }`; zero removes extra quota                                                         |
| `PUT /control/admin/users/:id/bypass`                                   | `{ "enabled": true }`                                                                               |
| `POST /control/admin/users/:id/reset`                                   | `{}`                                                                                                |
| `GET /control/admin/commands/:id`                                       | Applied/failed/unconfirmed command audit record                                                     |
| `GET /control/admin/users/:id/commands`                                 | Recent command audit records                                                                        |

Management and control routes require an admin token. URL-encode the complete user ID. Mutating admin calls require a unique `Idempotency-Key` header. They return 200 with `{ commandId, revision, state }` after application. Reusing a key for another action, target, or administrator returns 409. On a data-plane failure or timeout they return an error (503 when the result cannot be confirmed), with no background delivery. A lost response may follow a committed change: retry the same request with the same key to obtain its receipt without applying it twice. Audit status `unconfirmed` means the result is unknown, not queued. A failed/unconfirmed action does not block other commands. There is no `expectedRevision` field; the data plane assigns the applied revision.

Socket.IO uses WebSocket transport at `/socket.io/`, with the admin token in `auth.token`. Emit `subscribe` without a payload and wait for the `{ subscribed: true }` acknowledgment before fetching current HTTP data. `rate:update` (allowed decisions or state changes) and `rate:limit_exceeded` (denied decisions) both carry only `{ userId }`. Both trigger a grouped dashboard GET refresh, plus a detail/history refresh when that user is selected. On every reconnect, fetch fresh data instead of replaying missed events. `rate:heartbeat` continues to carry source health for the live-update indicator. Connections are disconnected when their token expires.

## Verify

Node 24 is required for local development; Docker contains its own runtime. NestJS 12 uses ESM. TypeScript 6.0.3 is pinned because `jest-mock-extended` supports TypeScript through v6. All resolved versions are in the lockfile.

```sh
npm ci
npm run typecheck
npm run build
npm run format:check
npm test

# Dedicated disposable PostgreSQL instances, separate from the demo data.
docker compose -f infra/compose.test.yml up -d --wait
npm run test:integration
docker compose -f infra/compose.test.yml down
```

The unit suite uses `jest-mock-extended` for storage mocks. The integration suite requires real PostgreSQL; it does not silently skip unavailable databases. It truncates its isolated test tables and requires database names ending in `_test`. Optional `TEST_DATA_DATABASE_URL`, `TEST_CONTROL_DATABASE_URL`, and `TEST_MANAGEMENT_DATABASE_URL` override the default loopback ports 55431–55433.

Tests cover quota boundaries, debt/retry math, 200 concurrent requests through two HTTP replicas, simultaneous user creation, bypassed traffic, persistence across reset/reconnection, request/admin/expiry races, failure rollback, authentication, synchronous command application, explicit retries after outages/lost responses, concurrent idempotent commands, schema upgrade, outbox recovery, analytics deduplication, event gaps, socket authorization/expiry, notification payloads, feed-worker restart, idle heartbeats, and HTTP recovery after reconnect. Boundary tests seed database timestamps and matching balances; they do not wait an hour.

To run services outside Docker, point each `DATABASE_URL` to its own PostgreSQL instance, configure authentication/service URLs from Compose, run `npm run build:server`, and start `node dist/apps/<service>/src/main.js` from the repository root. Run `npm run dev:web` for Vite on port 5173 and set `WEB_ORIGIN=http://localhost:5173` on the APIs. SQL migrations are idempotent and applied at API startup under a migration lock. The control-schema upgrade removes `desired_policies` and queue-only columns while preserving command IDs and audit records. Legacy pending commands become `unconfirmed` and require an explicit retry; they are not sent automatically. Bring both data and control APIs to the new version together: command revisions are now assigned by the data plane.

To package the project for distribution, run:

```sh
npm run package
```

The archive is written to `output/spikerz-rate-limiter.zip` and includes the design, source, lockfile, infrastructure, and tests.
