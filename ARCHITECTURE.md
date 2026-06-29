# FlowMoney — Architecture Reference

**Status:** MVP complete. Last updated: 2026-06-30.

---

## 1. System Overview & Tech Stack

| Layer | Technology | Version / Notes |
|---|---|---|
| Language (backend) | Go | 1.21 (module: `github.com/flowmoney/app`) |
| HTTP router | `go-chi/chi` | v5.1.0 |
| Database driver | `jackc/pgx` | v5.6.0 (pool via `pgxpool`) |
| Query layer | `sqlc` | Generated code in `internal/repository/postgres/` |
| Database | PostgreSQL | 16-alpine (Docker) |
| Frontend | Vanilla JS (ES6+) / Vanilla CSS | No frameworks, no bundler |
| Telegram SDK | `telegram-web-app.js` | Loaded from Telegram CDN in `index.html` |
| Containerisation | Docker (multi-stage build) | Builder: `golang:1.21-alpine` → Runtime: `alpine:3.19` |
| Compose | `docker-compose.yml` | Two services: `app` (port 8082) + `postgres` |
| Reverse proxy | Caddy | Pre-configured on host VPS; not in repo |
| CI/CD | GitHub Actions | `.github/workflows/deploy.yml` — push to `main` → SSH deploy |
| Migration runner | Custom shell (in deploy workflow) | `_schema_migrations` table tracks applied files |

**Binary size optimisation:** `CGO_ENABLED=0 -ldflags="-s -w"` strips debug symbols, producing a self-contained static binary.

---

## 2. Core Workflow & Auth

### 2.1 HMAC-SHA256 Auth Flow

Every request to `/api/v1/*` must carry:
```
Authorization: Telegram <initData>
```
where `initData` is the URL-encoded string provided by `window.Telegram.WebApp.initData`.

**Validation algorithm** (`pkg/tgauth/tgauth.go`):

```
1. Parse initData as URL query string.
2. Extract `hash` field; abort with ErrMissingHash if absent.
3. Build sorted key=value pairs from all fields EXCEPT `hash`, joined by "\n".
4. secret_key = HMAC-SHA256(key="WebAppData", data=botToken)
5. expected   = HMAC-SHA256(key=secret_key, data=dataCheckString)
6. Compare expected vs received hash with crypto/subtle.ConstantTimeCompare (timing-safe).
```

`ErrInvalidHash` → `401 Unauthorized`. Parse errors → `400 Bad Request`.

**`telegram_id` extraction** (`internal/delivery/http/middleware.go`):

After signature passes, the middleware parses the `user` field from `initData` (JSON object), extracts `.id` (`int64`), and injects it into the request context under the private key `telegramIDKey`. Downstream handlers call `GetTelegramID(ctx)` — zero value or missing → `401`.

### 2.2 Frontend Bootstrap Sequence

```
DOMContentLoaded
  └─ init()
       ├─ initTelegram()         → tg.ready() + tg.expand() + disableVerticalSwipes()
       ├─ initTheme()            → applyTheme(tg.themeParams) + subscribe themeChanged event
       ├─ StorageManager.init()  → load transactions from localStorage → Store.state.transactions
       ├─ Settings.init()        → load limits from localStorage, bind sliders
       ├─ initBindings()         → Store.subscribe() → DOM mutations
       ├─ Router.init()          → bind pointerdown on .nav-tab elements
       ├─ NumPad.init()          → bind pointerdown on .numpad
       ├─ CategoryCarousel.init()→ render defaults, subscribe Store.categories
       ├─ initAnalytics()        → SwipeGesture.init(), Store subscriptions
       ├─ initNetworkWatcher()   → online/offline → Store.state.isOnline
       └─ Promise.all([
              bootstrap(),           → GET /api/v1/bootstrap → Store.batchUpdate()
              setTimeout(400ms)      → skeleton visible minimum 400 ms
          ])
       └─ hideSkeleton() + SyncRunner.start()
```

### 2.3 Theme Engine

`applyTheme(params)` maps Telegram `themeParams` to CSS custom properties on `:root`:

| CSS variable | Telegram field | Fallback (CSS default) |
|---|---|---|
| `--bg-color` | `tg.themeParams.bg_color` | `#ffffff` |
| `--secondary-bg-color` | `tg.themeParams.secondary_bg_color` | `#f1f1f1` |
| `--text-color` | `tg.themeParams.text_color` | `#000000` |
| `--hint-color` | `tg.themeParams.hint_color` | `#999999` |
| `--accent-color` | `tg.themeParams.button_color` | `#2AABEE` |
| `--danger-color` | Fixed `#F87171` | — |
| `--success-color` | Fixed `#10B981` | — |

Theme changes arrive via `tg.onEvent('themeChanged', ...)` — no page reload required.

### 2.4 SPA Router

Navigation uses `pointerdown` (no 300ms click delay) on `.nav-tab[data-tab="<id>"]` elements. Screen transitions use only `opacity` + CSS classes (no `display:none` toggling). `requestAnimationFrame` ensures transitions fire after class application. Active tab state is also written to `Store.state.currentTab` so other modules (analytics) can react.

---

## 3. API Route Map

### Public

| Method | Path | Auth | Description | Response codes |
|---|---|---|---|---|
| `GET` | `/health` | None | Liveness probe | `200` |
| `GET` | `/*` (static) | None | SPA static files from `./frontend/`; unknown paths → `index.html` | `200` |

### Protected (`/api/v1/*` — all behind `TelegramAuth` middleware)

| Method | Path | Description | Response codes |
|---|---|---|---|
| `GET` | `/api/v1/bootstrap` | Initial state load | `200`, `400`, `401`, `500` |
| `POST` | `/api/v1/sync` | Batch upsert transactions | `200`, `400`, `401`, `500` |
| `GET` | `/api/v1/analytics/donut` | Monthly spend by category | `200`, `401`, `500` |
| `GET` | `/api/v1/analytics/timeline` | Paginated transaction history | `200`, `400`, `401`, `500` |

### JSON Contracts

**GET /api/v1/bootstrap → 200**
```json
{
  "currency": "USD",
  "budget": {
    "daily_limit": 500.00,
    "weekly_limit": 3000.00,
    "monthly_limit": 12000.00
  },
  "categories": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "user_id": 123456789,
      "name": "Еда",
      "color": "#FF6B6B",
      "icon": "🍕",
      "is_system": false,
      "sort_order": 0
    }
  ]
}
```
Notes: `budget` defaults to `{0,0,0}` if user has no budget row (pgx.ErrNoRows is swallowed). User is upserted on every bootstrap call.

**POST /api/v1/sync — Request body**
```json
{
  "transactions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "category_id": "660e8400-e29b-41d4-a716-446655440001",
      "amount": 125.50,
      "created_at": "2026-06-30T10:15:00Z",
      "is_deleted": false
    }
  ]
}
```
`→ 200 OK` (empty body). Each item is upserted atomically inside a single DB transaction (`BeginTx` / `Commit`). Any invalid UUID or `amount ≤ 0` causes full rollback and `400`.

**GET /api/v1/analytics/donut → 200**
```json
[
  { "category_id": "550e8400-...", "total": 4250.00 },
  { "category_id": "660e8400-...", "total": 1800.50 }
]
```
Aggregates current calendar month (`DATE_TRUNC('month', NOW())`) only, excludes soft-deleted rows.

**GET /api/v1/analytics/timeline → 200**
```
Query params:
  cursor  string  RFC3339 timestamp (exclusive upper bound), omit for first page
  limit   int     1–200, default 20
```
```json
{
  "items": [
    {
      "id": "550e8400-...",
      "category_id": "660e8400-...",
      "amount": 125.50,
      "created_at": "2026-06-30T10:15:00Z",
      "is_deleted": false
    }
  ],
  "next_cursor": "2026-06-29T22:00:00.000000000Z"
}
```
`next_cursor` is the `created_at` of the oldest item in the current page (RFC3339Nano). `null` when no more pages exist. Only non-deleted transactions are returned.

---

## 4. Data Model

### DDL (from `migrations/000001_init_schema.up.sql`)

```sql
-- users
CREATE TABLE users (
    tg_id      BIGINT      PRIMARY KEY,
    currency   VARCHAR(10) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- categories
CREATE TABLE categories (
    id         UUID        PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
    name       VARCHAR(64) NOT NULL,
    color      VARCHAR(16) NOT NULL,
    icon       VARCHAR(64) NOT NULL,
    is_system  BOOLEAN     NOT NULL DEFAULT FALSE,
    sort_order INT         NOT NULL DEFAULT 0
);

CREATE INDEX idx_categories_user_id ON categories(user_id);

-- transactions
CREATE TABLE transactions (
    id          UUID           PRIMARY KEY,
    user_id     BIGINT         NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
    category_id UUID           NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    amount      DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    is_deleted  BOOLEAN        NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_transactions_user_id    ON transactions(user_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
-- Composite partial index for the hot query: user's active transactions ordered by time
CREATE INDEX idx_transactions_user_timeline
    ON transactions(user_id, created_at DESC)
    WHERE is_deleted = FALSE;

-- budgets (one row per user, upserted)
CREATE TABLE budgets (
    user_id       BIGINT         PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
    daily_limit   DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
    weekly_limit  DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (weekly_limit >= 0),
    monthly_limit DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (monthly_limit >= 0)
);
```

### Constraint rationale

| Constraint | Table | Reason |
|---|---|---|
| `ON DELETE CASCADE` | `categories.user_id`, `transactions.user_id`, `budgets.user_id` | Full data wipe when user is deleted |
| `ON DELETE RESTRICT` | `transactions.category_id` | Prevents orphan transactions; category must be soft-hidden, not deleted |
| `CHECK (amount > 0)` | `transactions.amount` | DB-level guard; frontend caps at 999,999 |
| `CHECK (*_limit >= 0)` | `budgets.*` | Budgets can be zero (unlimited) but never negative |
| `TIMESTAMPTZ` | All timestamp columns | Stores UTC; avoids DST ambiguity |
| Partial index `WHERE is_deleted = FALSE` | `transactions` | The timeline query never reads deleted rows; keeps index small |

### Migration management

CI/CD applies migrations via a custom shell loop that tracks applied files in `_schema_migrations (filename TEXT PRIMARY KEY)`. This is a **homegrown tracker** — not `golang-migrate` or `flyway`.

---

## 5. Project Map

```
FlowMoney-app/
│
├── cmd/app/
│   └── main.go                   # Entry point: config, DB pool, chi router, graceful shutdown
│
├── internal/
│   ├── config/
│   │   └── config.go             # Env-var loader; mustEnv() panics on missing required vars
│   │
│   ├── delivery/http/
│   │   ├── middleware.go         # TelegramAuth() middleware + GetTelegramID() context helper
│   │   ├── bootstrap.go          # GET /api/v1/bootstrap handler; upserts user on every call
│   │   ├── sync.go               # POST /api/v1/sync handler; single DB transaction for batch upsert
│   │   └── analytics.go          # GET /api/v1/analytics/donut + /timeline handlers
│   │
│   └── repository/postgres/
│       ├── queries/
│       │   └── queries.sql       # sqlc source: UpsertUser, GetBudgets, GetCategories,
│       │                         #   UpsertTransaction, GetAnalyticsDonut, GetTimelineWithCursor
│       ├── db.go                 # Generated: DBTX interface + New() constructor
│       ├── models.go             # Generated: User, Category, Budget, Transaction structs
│       ├── querier.go            # Generated: Querier interface (for DI / mocking)
│       └── queries.sql.go        # Generated: concrete sqlc query implementations
│
├── pkg/tgauth/
│   └── tgauth.go                 # VerifyInitData(): HMAC-SHA256 validation, timing-safe compare
│
├── migrations/
│   └── 000001_init_schema.up.sql # DDL: users, categories, transactions, budgets + indexes
│
├── frontend/
│   ├── index.html                # SPA shell: Telegram SDK script tag, three screen divs,
│   │                             #   nav tabs, skeleton overlay, numpad markup
│   ├── css/
│   │   └── style.css             # Vanilla CSS; CSS vars for theming; safe-area insets;
│   │                             #   skeleton shimmer animation; transform-only transitions
│   └── js/
│       ├── store.js              # Reactive singleton Store via Proxy; subscribe/batchUpdate/reset
│       ├── app.js                # initTelegram, initTheme, Router, NumPad, CategoryCarousel,
│       │                         #   bootstrap(), loadAnalyticsData(), init() orchestrator
│       ├── storage.js            # StorageManager: localStorage CRUD; UUID via crypto.randomUUID()
│       ├── sync.js               # SyncRunner: 15 s interval + 'online' event → POST /api/v1/sync
│       ├── charts.js             # DonutChart: SVG stroke-dasharray donut + timeline renderer
│       ├── gestures.js           # SwipeGesture: pointer-event delegation, left=delete, right=duplicate
│       └── settings.js           # Settings: budget sliders, progress bars, dailyAvailable compute
│
├── .github/workflows/
│   └── deploy.yml                # Push-to-main → SSH → git pull → docker compose up --build
│                                 #   → shell-loop migration runner
│
├── docker-compose.yml            # Services: app (8082) + postgres:16-alpine; healthcheck on postgres
├── Dockerfile                    # Multi-stage: golang:1.21-alpine builder → alpine:3.19 runtime
├── go.mod                        # Module: github.com/flowmoney/app, Go 1.21
├── go.sum
├── sqlc.yaml                     # sqlc config: queries → internal/repository/postgres/queries/
├── .env.example                  # PORT, DB_*, TELEGRAM_BOT_TOKEN placeholders
├── spec.md                       # Product & technical specification (source of truth)
└── system_state.md               # Development roadmap and session log
```

---

## 6. Security Standards & Debt

### 6.1 DB Error Masking

All handler error paths return only generic strings to the client:
```go
http.Error(w, "internal server error", http.StatusInternalServerError)
```
Raw `pgx` errors (containing table names, column values, constraint names) never reach the HTTP response. The only exception is `pgx.ErrNoRows`, which is explicitly swallowed in `bootstrap.go` (budget row may not exist for new users).

Errors are currently written to `log.Printf` via `chi/middleware.Logger` — no structured logging or log aggregation is wired up.

### 6.2 Stored XSS Prevention

**Category carousel** (`app.js:206`): category data is interpolated into a template literal via `.innerHTML = categories.map(...)`. This is the primary XSS surface. Mitigation: category `name`, `icon`, and `color` are system-seeded server-side; user-submitted category data is not yet implemented. When the settings screen's "category builder" is implemented, this render path **must** switch to `createElement + textContent`.

**Timeline / donut chart** (`charts.js`): transaction data rendered into SVG elements. Verify that category names and amounts use `textContent` / attribute setting, not raw HTML injection.

**NumPad double-tap zoom (iOS WebKit)**: mitigated via `touch-action: manipulation` on numpad buttons in CSS, and `e.preventDefault()` on `pointerdown`. The `<meta name="viewport" content="..., user-scalable=no">` tag provides a second layer.

**Input validation summary:**

| Input | Frontend limit | Backend constraint |
|---|---|---|
| Amount (numpad) | Max 6 integer digits; max 2 decimal digits; cap at 999,999 | `CHECK (amount > 0)`, `DECIMAL(18,2)` |
| Cursor (timeline) | RFC3339 string | Server rejects non-RFC3339 with 400 |
| Limit param (timeline) | — | Server enforces 1–200 range |
| UUID (sync) | `crypto.randomUUID()` v4 | `pgtype.UUID.Scan()` rejects malformed strings |

### 6.3 Dependency Surface

Zero runtime JS dependencies. Backend direct dependencies: `chi` (router) and `pgx` (DB). No Redis, no external cache, no message queue. Attack surface is minimal.

---

## 7. Hidden Architectural Weaknesses & Risks

### Risk 1: No `auth_date` Expiry Check — Replay Attack Vector

**Current state:** `tgauth.VerifyInitData()` validates only the HMAC signature. It does **not** read or validate the `auth_date` field in `initData`.

**Threat:** A valid `initData` token intercepted from any past session (via man-in-the-middle, clipboard, log leak, etc.) can be replayed indefinitely. Telegram's own docs recommend rejecting tokens where `auth_date` is older than a few minutes.

**Fix:** Add to `tgauth.go`:
```go
authDateStr := params.Get("auth_date")
authDate, err := strconv.ParseInt(authDateStr, 10, 64)
if err != nil || time.Since(time.Unix(authDate, 0)) > 24*time.Hour {
    return false, ErrExpiredInitData
}
```

---

### Risk 2: SyncRunner Batch Size Unbounded — Memory & Timeout Risk

**Current state:** `SyncRunner.syncWithBackend()` calls `StorageManager.getUnsyncedTransactions()` and sends the entire pending array as a single JSON body to `POST /api/v1/sync`. The server loops over all items in a single DB transaction.

**Threat:** If the device stays offline for an extended period and accumulates thousands of transactions (theoretically possible — no client-side cap on pending queue depth), the sync payload can be arbitrarily large. The server's `ReadTimeout: 15s` may cause the request to be cut off mid-transaction, leaving the DB transaction rolled back but the client unaware (the `fetch` will timeout, retry triggers, infinite loop risk).

**Fix:** Chunk the sync payload on the client (e.g., batches of 50), confirm each chunk before sending the next.

---

### Risk 3: In-Flight Sync Race Condition

**Current state:** `_isSyncing` boolean is the only guard against concurrent sync runs. However:
- The `'online'` event and the `setInterval` tick can fire nearly simultaneously.
- `SyncRunner.syncWithBackend()` is also called immediately after `handleAddTransaction()`.

If `markAsSynced()` is called while a second sync attempt has already collected the same `pending` array (before the first run's `markAsSynced` ran), the server will receive duplicate batches. The server handles this correctly (`ON CONFLICT DO UPDATE`), but the client-side `_isSyncing` flag is the only race protection — if the JS event loop yields between the `_isSyncing = true` assignment and the `fetch`, a concurrent call could slip through on the same task-queue microtask.

In practice this is low-risk due to single-threaded JS, but the `_isSyncing` flag should be set **synchronously before any `await`** (it already is — `_isSyncing = true` precedes the first `await fetch`), so this pattern is currently safe. Worth documenting as a constraint: **never insert an `await` before the `_isSyncing = true` line.**

---

### Risk 4: Migration System Has No Down-Migration or Idempotency for DDL Failures

**Current state:** The CI/CD loop applies `.up.sql` files tracked by a simple `filename TEXT PRIMARY KEY` table. There are no `.down.sql` rollback scripts. If a migration partially fails (e.g., index creation fails after table creation succeeds), the filename is not recorded in `_schema_migrations` (the `INSERT` is a separate `psql` call after the SQL file runs), so the broken migration will be re-attempted on the next deploy — potentially causing a `CREATE TABLE` error because the table already exists.

**Fix:** Wrap each migration in an explicit `BEGIN; ... COMMIT;` block within the SQL file itself, or migrate to `golang-migrate` which handles atomicity and rollback natively.

---

### Risk 5: Category Render Uses `innerHTML` with Server Data

**Current state:** `CategoryCarousel.render()` in `app.js:206` builds HTML using a template literal and assigns it to `carousel.innerHTML`. The `cat.icon` field can contain arbitrary strings (emoji or SVG glyph names from the spec's "24 system glyphs" palette). If a future backend change or a compromised category record injects `<script>` or event-handler attributes into `name` or `icon`, this becomes a stored XSS vector.

**Fix (when category builder is implemented):** Replace the template-literal approach with `createElement('div')` + `element.textContent = cat.name` for all user-controlled fields.
