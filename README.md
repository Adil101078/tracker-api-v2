# tracker-api

Robust NestJS service for recording **api-hits / api-calls** using **BullMQ + Redis** for async ingestion and **MongoDB (Mongoose)** for storage.

## Architecture

```
POST /api/tracker ──▶ ValidationPipe ──▶ TrackerService.enqueue()
                                              │
                                              ▼
                                     BullMQ queue (Redis)
                                              │
                                              ▼
                              TrackerProcessor (worker) ──▶ MongoDB
```

The HTTP endpoint validates the payload, pushes a job onto the queue, and returns **202 Accepted** immediately. A BullMQ worker drains the queue and writes each record to MongoDB with automatic retries (5 attempts, exponential backoff). This keeps the request path fast and absorbs traffic spikes.

## Requirements

- Node.js 18+
- Redis 6+
- MongoDB 5+

## Setup

```bash
npm install
cp .env.example .env   # adjust values
npm run start:dev
```

## Environment

See `.env.example`. Key vars: `MONGO_URI`, `REDIS_HOST`, `REDIS_PORT`, `TRACKER_QUEUE_CONCURRENCY`.

## Data sources — where each field comes from

The tracker runs in **self-instrumented mode**: a global `TrackingInterceptor`
records every HTTP request handled by this service. There is no manual
ingestion path — `POST /api/tracker` is just an acknowledged request that the
interceptor logs like any other (its body is captured for search metadata).

| Field group | Source | Notes |
|---|---|---|
| `endpoint`, `httpMethod`, `statusCode`, `success`, `responseTimeMs`, `userAgent`, `IP` | Auto-captured by `TrackingInterceptor` from the request/response | Zero caller effort |
| `companyCode`, `origin`, `destination`, ... | Request body, or `X-Company-Code` header (defaults to `UNKNOWN`) | Caller-supplied |
| `country`, `city`, `lat`, `lon`, `isp`, `org`, `timezone`, ... | Resolved from `IP` by the **worker** via `ip-api.com` | Best-effort; never fails the job |
| `isBlocked`, `isBot` | Only your gateway/WAF knows blocking; pass explicitly. `isBot` defaults `false` | Not auto-derivable |

### ip-api.com rate limits

The free `ip-api.com` endpoint is **HTTP-only** and **~45 req/min per source IP**.
Mitigations in place: a 24h in-process **per-IP cache** (same IP never looked up
twice while warm), non-routable IPs skipped, 3s timeout, and graceful fallback
(geo failure stores the hit without geo). For production scale, switch to the
paid pro endpoint (`pro.ip-api.com` with key) or self-host MaxMind GeoLite2.

> Self-instrumented mode tracks calls **to this service**. To track your real
> product APIs, have them call this endpoint (the interceptor still logs it),
> or deploy this service in their request path.

## Dashboard endpoints

All are read-only and `@SkipTracking()` (excluded from api-hit data):

| Endpoint | Powers | Extra params |
|---|---|---|
| `GET /api/tracker/stats/summary` | Top metric cards: total hits, success/error rate, avg response time, blocked | — |
| `GET /api/tracker/stats/top-endpoints` | "Top API Endpoints" table | `limit` |
| `GET /api/tracker/stats/status-distribution` | Status code donut (2xx/4xx/5xx) | — |
| `GET /api/tracker/stats/hits-by-country` | Geography / Hits by Country | `limit` |
| `GET /api/tracker/stats/traffic-over-time` | Traffic Over Time chart / Heatmap | `granularity=minute\|hour\|day` (default `hour`) |
| `GET /api/tracker/stats/recent-summary` | "Recent API Hit Summary" table (per-company rows) | `search`, `page`, `pageSize` |
| `GET /api/tracker` | Raw recent hit documents | `limit` |
| `GET /api/tracker/companies` | "Company Code" filter dropdown (distinct, sorted codes) | — |
| `GET /api/health` | "System Health" panel | — |

`GET /api/health` returns `{ overall, message, components[], checkedAt }`;
each component: `{ name, status: 'operational'\|'down', uptimePercent }`.
Components checked: **API Gateway, Database (Mongo), Cache Server (Redis),
Message Queue (BullMQ)**. The mock UI's "Search Engine" is omitted — no
search engine exists in this stack. Always HTTP 200 (read `overall`).
Note: if Redis is unreachable the app won't boot at all, so a
"Cache Server: down" state only appears if Redis fails *after* startup.

**Every endpoint accepts the UI filters `?companyCode=&from=&to=`**
(`from`/`to` are ISO dates). Omitting `companyCode` (or sending it empty)
= the dropdown's **"All Companies"**. The Recent Summary table's date
range, search box and pagination are all server-side.

**UI traffic preset → `granularity` mapping** (do on the FE):
`15m`/`1H` → `minute`, `6H`/`24H`/`7D` → `hour`, `30D`/`Custom` → `day`.

`recent-summary` returns `{ data, page, pageSize, total, totalPages }`;
each row: `companyCode, totalHits, avgHitsPerSec, successRate, errorRate,
avgResponseTimeMs, date`. `avgHitsPerSec` = hits ÷ (first→last hit span);
meaningful at real traffic volumes, inflated for tiny bursty samples.

## Indexing (built for millions of rows)

Every dashboard query filters by `companyCode` (equality) + a `createdAt`
range, then groups by one telemetry/geo field. Indexes follow the **ESR
rule** (Equality → Sort/Range → grouped field) so these pipelines use an
`IXSCAN`, never a collection scan:

| Index | Serves |
|---|---|
| `{companyCode:1, createdAt:-1}` | `findRecent`, `list` (also covers `companyCode`-only) |
| `{companyCode:1, createdAt:1}` | `summary`, `traffic-over-time` |
| `{companyCode:1, createdAt:1, endpoint:1}` | `top-endpoints` |
| `{companyCode:1, createdAt:1, statusCode:1}` | `status-distribution` |
| `{companyCode:1, createdAt:1, country:1}` | `hits-by-country` |
| `{companyCode:1, success:1, createdAt:1}` | success/error breakdown |
| `{companyCode:1, isBlocked:1, createdAt:1}` | blocked-requests metric |
| `{searchId:1}` (sparse), `{IP:1, createdAt:-1}` | request tracing |

Verified: `explain()` shows `IXSCAN` on `companyCode_1_createdAt_-1` for the
recent-hits query. Single-field indexes were deliberately **removed** —
each extra index slows every insert, and these fields are only queried
behind `companyCode`, so the compound-index prefixes cover them.

> ⚠️ **Leftover indexes:** Mongoose only *creates* indexes; it never drops
> ones removed from the schema. If you ran an earlier version, drop the
> stale single-field indexes manually:
> `db.trackers.dropIndex("endpoint_1")` etc. A fresh DB won't have them.
> In production, disable `autoIndex` and manage indexes via a migration.

**Retention:** set `TRACKER_TTL_DAYS` to auto-expire old raw hits (off by
default — it deletes history; roll into summaries first if you need it).

## API

### Record an api-hit

`POST /api/tracker`

```json
{
  "companyCode": "ACME",
  "credentialCode": "CRED-1",
  "secretKey": "xxx",
  "IP": "1.2.3.4",
  "referralUrl": "https://example.com",
  "searchId": "s-123",
  "origin": "DXB",
  "destination": "LHR",
  "classOfService": "Y",
  "adults": "2",
  "child": "1",
  "infants": "0",
  "currency": "USD",
  "departureDate": "2026-06-01",
  "returnDate": "2026-06-10"
}
```

Response `202`:

```json
{ "success": true, "message": "Tracker accepted for processing", "jobId": "12" }
```

Only `companyCode` is required; all other fields are optional strings.

### List recent api-hits

`GET /api/tracker?companyCode=ACME&limit=50`

```json
{ "success": true, "count": 1, "data": [ ... ] }
```

## Project structure

```
src/
  main.ts
  app.module.ts
  core/
    config/configuration.ts
    constants/index.ts
  modules/
    tracker/
      tracker.module.ts
      tracker.controller.ts
      tracker.service.ts        # queue producer + DB reads
      tracker.processor.ts      # BullMQ worker -> MongoDB
      dto/create-tracker.dto.ts
      schemas/tracker.schema.ts
```

## Scripts

| Command | Description |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run compiled build |
| `npm run lint` | ESLint |
