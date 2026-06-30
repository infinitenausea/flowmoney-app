# FlowMoney — Architecture Document

> **Single Source of Truth.** Audited 2026-06-30 against the live codebase.  
> Supersedes scattered notes in `spec.md` and `system_state.md`.

---

## 1. System Overview & Tech Stack

| Layer | Technology | Version / Detail |
|---|---|---|
| Language | Go | 1.21 (go.mod) |
| HTTP router | chi | v5.1.0 |
| DB driver | pgx/v5 (pgxpool) | v5.6.0 |
| Database | PostgreSQL | 16-alpine (docker-compose) |
| Runtime deps | — | **Two** direct deps: chi, pgx. Zero ORM. |
| Frontend | Vanilla JS + CSS | No framework, no bundler, no transpiler |
| Container | Docker multi-stage | `golang:1.21-alpine` → `alpine:3.19` |
| Reverse proxy | Caddy | Not in repo; assumed from spec. Terminates TLS. |
| CI/CD | GitHub Actions | SSH → git pull → docker compose up --build |
| Migration tracker | Homegrown shell + `_schema_migrations` table | Not golang-migrate |
| Query generation | sqlc | `sqlc.yaml` → `internal/repository/postgres/` |
| Exposed port | 8082 | Both inside container and host-mapped |

### Chi middleware stack (applied globally, in order)

```
middleware.Logger → middleware.Recoverer → middleware.RealIP
```

`/api/v1/*` additionally wraps with `deliveryhttp.TelegramAuth`.

---

## 2. Core Workflow & Auth

### 2.1 Backend HMAC-SHA256 Auth (`pkg/tgauth/tgauth.go`)

Every protected endpoint requires the header:

```
Authorization: Telegram <initData>
```

`initData` is the raw URL-encoded string provided by `window.Telegram.WebApp.initData`.

**Verification algorithm** (exact implementation):

1. Parse `initData` as URL query string.
2. Extract and remove `hash` field.
3. Collect remaining `key=value` pairs, sort alphabetically, join with `\n` → `dataCheckString`.
4. `secret_key = HMAC-SHA256(key="WebAppData", data=botToken)`
5. `expectedHash = HMAC-SHA256(key=secret_key, data=dataCheckString)`
6. Compare `expectedHash` vs `hash` with `crypto/subtle.ConstantTimeCompare` (timing-safe).

**`telegram_id` extraction** (`internal/delivery/http/middleware.go`):

After HMAC passes, the middleware re-parses `initData`, extracts the `user` JSON field, unmarshals `{ "id": int64 }`, and injects `telegram_id` into the request context under the unexported key `"telegram_id"`. All handlers retrieve it via `GetTelegramID(ctx)`.

**Error response codes from middleware:**

| Condition | HTTP code |
|---|---|
| Missing or malformed `Authorization` header | 400 |
| Invalid HMAC signature | 401 |
| Malformed `initData` or missing `user` field | 400 |

### 2.2 Frontend State Init Sequence (`frontend/js/app.js`)

Exact order inside `init()`:

```
initTelegram()          tg.ready(), tg.expand(), body height lock, safe-area-bottom CSS var
initTheme()             applyTheme(tg.themeParams), subscribe themeChanged
StorageManager.init()   load transactions from localStorage, run UUID migration
Settings.init()         load budget limits from localStorage, wire currency/limit controls
initBindings()          reactive DOM ← Store subscriptions
Router.init()           wire nav tabs, set currentTab = 'home'
NumPad.init()           wire numpad pointerdown events
CategoryCarousel.init() render default categories, subscribe to Store.categories
initAnalytics()         subscribe currentTab/selectedAnalyticsCategory/transactions, init SwipeGesture
initNetworkWatcher()    window online/offline → Store.state.isOnline

await Promise.all([bootstrap(), wait 400ms])   // skeleton shown ≥ 400 ms

hideSkeleton()          fade-out skeleton (280 ms), reveal #app
SyncRunner.start()      immediate sync attempt + 15 s interval + online event
```

### 2.3 Theme Engine

`applyTheme()` maps 5 Telegram themeParams to CSS custom properties on `:root`:

| themeParam | CSS variable |
|---|---|
| `bg_color` | `--bg-color` |
| `secondary_bg_color` | `--secondary-bg-color` |
| `text_color` | `--text-color` |
| `hint_color` | `--hint-color` |
| `button_color` | `--accent-color` |

Theme changes dynamically (light/dark switch) without page reload via `tg.onEvent('themeChanged', ...)`.

### 2.4 SPA Routing

- **No URL hashes.** Tab state lives entirely in `Store.state.currentTab` (string: `'home'` | `'analytics'` | `'settings'`).
- Screen visibility is toggled via `screen.classList.add/remove('active')` + `aria-hidden` attribute.
- Transitions driven purely by CSS opacity/transform on `.active` class — no `display:none`.
- Tab clicks use `pointerdown` (not `click`) to eliminate the 300 ms tap delay.
- Each tab switch calls `tg.HapticFeedback.impactOccurred('light')`.

### 2.5 Zoom & Tap-Delay Blocking

Three guards wired before any other init (top of `app.js`):

| Event | Condition | Action |
|---|---|---|
| `touchstart` | `e.touches.length > 1` | `preventDefault()` — blocks pinch-zoom |
| `gesturestart` | always | `preventDefault()` — blocks Safari WebKit gesture zoom |
| `touchend` | `now - lastTap < 300 ms` | `preventDefault()` — blocks double-tap zoom |

### 2.6 Currency Options Bottom Sheet (`#currency-options-sheet`)

The single `<div id="currency-options-sheet">` element is a shared, reusable bottom sheet that serves **three distinct contexts** inside `settings.js`, disambiguated by the private module-level variable `_activeCurrencyTarget` (`'main' | 'from' | 'to'`):

| Trigger (`pointerdown`) | `_activeCurrencyTarget` | Effect on selection |
|---|---|---|
| `#custom-currency-select` (main currency button, Settings screen) | `'main'` | Calls `_handleCurrencyChange(newCur)` — updates `Store.state.currency`, recalculates all budget limits by the cross-rate factor `rateTo / rateFrom`, persists to localStorage, fires debounced `PUT /api/v1/settings` |
| `#custom-converter-from-select` (converter "From" button) | `'from'` | Sets `_converterFrom`, updates `#converter-from-label` text via `_CURRENCY_COMPACT`, calls `_updateConverterResult()` |
| `#custom-converter-to-select` (converter "To" button) | `'to'` | Sets `_converterTo`, updates `#converter-to-label` text via `_CURRENCY_COMPACT`, calls `_updateConverterResult()` |

**Open:** `_openCurrencySheet(target)` writes `_activeCurrencyTarget`, then toggles the `.selected` CSS class on the `.currency-sheet-option` matching the active currency for that context (`_converterFrom`, `_converterTo`, or `Store.state.currency`). The sheet becomes visible via `requestAnimationFrame(() => sheet.classList.add('active'))`.

**Close:** `_closeCurrencySheet()` removes `.active`; `aria-hidden="true"` is restored after a 340 ms CSS transition delay. The backdrop's `pointerdown` also triggers close.

**Selection dispatch:** The `pointerdown` listener on each `.currency-sheet-option` reads `opt.dataset.currency` and branches on `_activeCurrencyTarget`. All three code paths end with `_closeCurrencySheet()`. All bindings use `pointerdown` with `e.preventDefault()` — consistent with the rest of the app's tap-delay elimination strategy (see §2.5).

---

## 3. API Route Map

### 3.1 Public Endpoints

| Method | Path | Response codes | Body |
|---|---|---|---|
| `GET` | `/health` | 200 | `{"status":"ok"}` |
| `GET` | `/*` | 200 | Static files from `./frontend/`; unknown paths serve `index.html` |

### 3.2 Protected Endpoints (require `Authorization: Telegram <initData>`)

| Method | Path | Success | Errors |
|---|---|---|---|
| `GET` | `/api/v1/bootstrap` | 200 JSON | 401, 500 |
| `POST` | `/api/v1/sync` | 200 (empty body) | 400, 401, 500 |
| `PUT` | `/api/v1/settings` | 200 (empty body) | 400, 401, 500 |
| ~~`GET`~~ | ~~`/api/v1/analytics/donut`~~ **[REMOVED]** | — | — |
| `GET` | `/api/v1/analytics/timeline` | 200 JSON | 400, 401, 500 |

> **Архитектурное примечание:** Расчёт аналитики пончика полностью перенесён на сторону клиента (Offline-First) для устранения сетевых задержек и конфликтов часовых поясов сервера. Эндпоинт не вызывается фронтендом с коммита `f4232f2`. Логика агрегации — в `computeLocalDonutData()` (`app.js:420`); детали — в §7.

### 3.3 Response Structures

**`GET /api/v1/bootstrap`**

On first call for a new `telegram_id`, `UpsertUser` creates the user row (default currency: `"USD"`).

```json
{
  "currency": "USD",
  "budget": {
    "daily_limit": 0,
    "weekly_limit": 5000,
    "monthly_limit": 0
  },
  "categories": [
    {
      "id": "11111111-1111-1111-1111-111111111101",
      "user_id": 0,
      "name": "Еда",
      "color": "#FF6B6B",
      "icon": "🍕",
      "is_system": true,
      "sort_order": 1
    }
  ],
  "rates": {
    "USD": 1.0,
    "RUB": 90.0,
    "GEL": 2.72,
    "EUR": 0.92
  }
}
```

If no budget row exists, `budget` fields are all `0` (`pgx.ErrNoRows` is handled, not propagated as an error).

**`POST /api/v1/sync`**

The backend expects a **bare JSON array** (not an object wrapper). Each item:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "category_id": "11111111-1111-1111-1111-111111111101",
    "amount": 350.00,
    "created_at": "2026-06-30T14:22:00Z",
    "is_deleted": false
  }
]
```

All items are processed in a single `BEGIN/COMMIT` transaction. Each item is an `UpsertTransaction` (`ON CONFLICT (id) DO UPDATE`). On any error, the entire batch is rolled back.

**`PUT /api/v1/settings`**

```json
{
  "currency": "RUB",
  "daily_limit": 0,
  "weekly_limit": 5000,
  "monthly_limit": 20000
}
```

`currency` is optional (empty string = skip currency update). Validated against allowlist: `RUB`, `GEL`, `USD`, `EUR`.

~~**`GET /api/v1/analytics/donut`** **[REMOVED]**~~

> Эндпоинт выведен из эксплуатации. Серверная реализация сохранена в `internal/delivery/http/analytics.go` и `queries/queries.sql` (запрос `GetAnalyticsDonut`), но фронтенд её не вызывает. Агрегация выполняется локально функцией `computeLocalDonutData()` (`app.js:420`).

**`GET /api/v1/analytics/timeline?cursor=RFC3339&limit=N`**

Cursor-based pagination. Default limit: 20. Max limit: 200.

- `cursor` — RFC3339 timestamp; returns items with `created_at < cursor` (older than cursor).
- Response `next_cursor` — RFC3339Nano timestamp of the **oldest item in the current page**. Pass as `cursor` for the next page. `null` when there are no more items.

```json
{
  "items": [
    {
      "id": "uuid",
      "category_id": "uuid",
      "amount": 350.00,
      "created_at": "2026-06-30T14:22:00Z",
      "is_deleted": false
    }
  ],
  "next_cursor": "2026-06-29T10:15:00.123456789Z"
}
```

Only non-deleted transactions are returned. Query uses the partial composite index `idx_transactions_user_timeline`.

---

## 4. Data Model

### 4.1 DDL

```sql
-- Migration 000001_init_schema.up.sql

CREATE TABLE users (
    tg_id      BIGINT      PRIMARY KEY,
    currency   VARCHAR(10) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
-- composite partial: used by GetTimelineWithCursor and donut aggregation
CREATE INDEX idx_transactions_user_timeline
    ON transactions(user_id, created_at DESC) WHERE is_deleted = FALSE;

CREATE TABLE budgets (
    user_id       BIGINT         PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
    daily_limit   DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
    weekly_limit  DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (weekly_limit >= 0),
    monthly_limit DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (monthly_limit >= 0)
);
```

```sql
-- Migration 000002_seed_system_categories.up.sql
-- System user (tg_id = 0): sentinel owner of all shared system categories.
-- Real Telegram IDs are always positive, so 0 is a safe sentinel.

INSERT INTO users (tg_id, currency) VALUES (0, 'USD') ON CONFLICT DO NOTHING;

INSERT INTO categories (id, user_id, name, color, icon, is_system, sort_order) VALUES
  ('11111111-1111-1111-1111-111111111101', 0, 'Еда',       '#FF6B6B', '🍕', true, 1),
  ('11111111-1111-1111-1111-111111111102', 0, 'Транспорт', '#4ECDC4', '🚇', true, 2),
  ('11111111-1111-1111-1111-111111111103', 0, 'Покупки',   '#45B7D1', '🛍️', true, 3),
  ('11111111-1111-1111-1111-111111111104', 0, 'Здоровье',  '#96CEB4', '💊', true, 4),
  ('11111111-1111-1111-1111-111111111105', 0, 'Кафе',      '#FFEAA7', '☕', true, 5),
  ('11111111-1111-1111-1111-111111111106', 0, 'Спорт',     '#DDA0DD', '⚽', true, 6),
  ('11111111-1111-1111-1111-111111111107', 0, 'Дом',       '#98D8C8', '🏠', true, 7),
  ('11111111-1111-1111-1111-111111111108', 0, 'Другое',    '#B0C4DE', '💡', true, 8)
ON CONFLICT (id) DO NOTHING;
```

```sql
-- Homegrown migration tracker (created by CI script inline, not a migration file)
CREATE TABLE IF NOT EXISTS _schema_migrations (
    filename   TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
);
```

### 4.2 Key Constraints Explained

| Constraint | Table | Purpose |
|---|---|---|
| `ON DELETE CASCADE` | categories → users | Deleting a user wipes all their categories |
| `ON DELETE CASCADE` | transactions → users | Deleting a user wipes all their transactions |
| `ON DELETE CASCADE` | budgets → users | Deleting a user wipes their budget row |
| `ON DELETE RESTRICT` | transactions → categories | Prevents orphan transactions; category can't be deleted while in use |
| `CHECK (amount > 0)` | transactions | Enforces positive amounts at DB level |
| `CHECK (daily/weekly/monthly_limit >= 0)` | budgets | Limits can be zero (disabled) but not negative |
| `TIMESTAMPTZ` | all date columns | Stored as UTC; no timezone-aware confusion |

### 4.3 Query Notes

- `GetCategoriesByUserId`: `WHERE user_id = $1 OR is_system = true ORDER BY sort_order ASC` — every user sees the 8 system categories regardless of their own `user_id`.
- ~~`GetAnalyticsDonut`~~: aggregates current calendar month using `DATE_TRUNC('month', NOW())` on the server — month boundary is server-local timezone (UTC if `TZ` env var is not set). **[UNUSED]** — frontend switched to `computeLocalDonutData()` (client-side); see §7.
- `UpsertUser`: `ON CONFLICT (tg_id) DO UPDATE SET updated_at = NOW()` — acts as a login ping; updates `updated_at` on every bootstrap call.

---

## 5. Project Map

```
FlowMoney-app/
│
├── cmd/app/main.go              Entry point: config load, DB pool, chi router, file server, graceful shutdown
│
├── internal/
│   ├── config/config.go         Reads env vars; mustEnv() panics on missing required vars
│   ├── delivery/http/
│   │   ├── middleware.go        TelegramAuth middleware: HMAC verify → inject telegram_id into ctx
│   │   ├── bootstrap.go        GET /bootstrap: UpsertUser + GetBudget + GetCategories + rates
│   │   ├── sync.go             POST /sync: DB transaction wrapping batch UpsertTransaction
│   │   ├── settings.go         PUT /settings: UpdateUserCurrency + UpsertBudget
│   │   └── analytics.go        GET /analytics/donut + GET /analytics/timeline (cursor pagination)
│   ├── repository/postgres/
│   │   ├── db.go               sqlc-generated: DBTX interface (Pool or Tx)
│   │   ├── models.go           sqlc-generated: User, Category, Transaction, Budget structs
│   │   ├── querier.go          sqlc-generated: Querier interface
│   │   ├── queries.sql.go      sqlc-generated: all query implementations
│   │   └── queries/
│   │       └── queries.sql     Source SQL queries (8 named queries)
│   └── service/
│       └── rates.go            RatesManager: in-memory exchange rates, 12 h refresh from open.er-api.com
│
├── pkg/tgauth/
│   ├── tgauth.go               VerifyInitData: pure HMAC-SHA256 verification, no external deps
│   └── tgauth_test.go          Unit tests for VerifyInitData
│
├── migrations/
│   ├── 000001_init_schema.up.sql    Creates users, categories, transactions, budgets + indexes
│   └── 000002_seed_system_categories.up.sql  Seeds system user (tg_id=0) and 8 system categories
│
├── frontend/
│   ├── index.html              Single HTML shell; skeleton loader, three screen divs, bottom nav
│   ├── css/style.css           All styles; CSS custom properties for Telegram theme vars
│   └── js/
│       ├── store.js            Reactive Proxy-based Store; key-scoped subscriptions; batchUpdate
│       ├── storage.js          StorageManager: localStorage r/w; UUID migration; soft-delete
│       ├── sync.js             SyncRunner: 15 s interval + online event; _isSyncing mutex flag
│       ├── settings.js         Settings: currency/limit controls; debounced server sync (1500 ms); converter widget
│       ├── app.js              App entry: Telegram SDK init, Theme, Router, NumPad, CategoryCarousel, bindings
│       ├── charts.js           DonutChart: SVG donut + timeline DOM builder; _esc() XSS guard
│       └── gestures.js         SwipeGesture: pointer-based left/right swipe on timeline items
│
├── .github/workflows/deploy.yml    CI: SSH to VPS → git pull → docker compose up --build → migrations
├── Dockerfile                  Multi-stage: builder (golang:1.21-alpine) → runtime (alpine:3.19)
├── docker-compose.yml          postgres:16-alpine + app; port 8082:8082; healthcheck on postgres
├── sqlc.yaml                   sqlc codegen config
├── go.mod / go.sum             Module: github.com/flowmoney/app
└── .env.example                Documents required env vars
```

---

## 6. Security Standards & Debt

### 6.1 DB Error Masking

All handler functions return only `"internal server error"` to the client on DB failures:

```go
// Pattern used in bootstrap.go, sync.go, settings.go, analytics.go
http.Error(w, "internal server error", http.StatusInternalServerError)
```

Raw pgx errors (e.g., `pgx: no rows in result set`, constraint violation messages) are **never forwarded** to the client. They are absorbed silently; the chi `middleware.Logger` logs the HTTP exchange but not the error bodies.

**Partial exception:** `middleware.go` returns `"bad request: " + err.Error()` for parsing failures. The errors exposed are from the `tgauth` package (`"tgauth: hash field is missing from initData"`) and from `url.ParseQuery` — not from pgx. These do not expose DB internals.

### 6.2 XSS Protection Standards

**Safe pattern — timeline renderer (`charts.js`):**

```js
// All user-visible data via textContent — HTML injection impossible
const nameEl = document.createElement('div');
nameEl.textContent = categoryName;  // safe regardless of content

const iconEl = document.createElement('div');
iconEl.textContent = categoryIcon;  // emoji injected as text, not markup
```

The entire timeline DOM tree is built with `createElement` + `textContent`. Two `innerHTML` assignments in `charts.js` are safe:
1. SVG donut and legend — guarded by `_esc()` which escapes `&`, `<`, `>`, `"` before injection.
2. Swipe-delete overlay — static hardcoded SVG markup; zero user data.

**~~Vulnerable pattern — `CategoryCarousel.render()` in `app.js`~~ ✅ FIXED 2026-06-30:**

`CategoryCarousel.render()` was rewritten to use `createElement` + `textContent` + DOM style properties. No `innerHTML` or template literals remain. Safe for user-defined categories.

### 6.3 NumPad Input Limits

| Limit | Numpad (home screen) | Budget modal (settings) |
|---|---|---|
| Max integer digits | 6 | 7 |
| Max decimal digits | 2 | 2 |
| Max value | 999,999 | 9,999,999 |
| Source | `app.js MAX_DIGITS/MAX_AMOUNT` | `settings.js MAX_DIGITS/MAX_AMOUNT` |

The DB `CHECK (amount > 0)` is the only server-side amount guard; there is no server-side upper-bound validation.

### 6.4 Key Timings

| Behavior | Value |
|---|---|
| Double-tap zoom threshold | 300 ms |
| Numpad key press animation | 120 ms |
| Skeleton minimum display | 400 ms |
| Skeleton fade-out animation | 280 ms |
| Settings server sync debounce | 1500 ms |
| Budget modal close animation | 340 ms |
| SyncRunner interval | 15 000 ms |
| RatesManager refresh interval | 12 h |
| RatesManager HTTP timeout | 10 s |

### 6.5 Server Timeouts

| Timeout | Value |
|---|---|
| `ReadTimeout` | 15 s |
| `WriteTimeout` | 15 s |
| `IdleTimeout` | 60 s |
| DB pool `Ping` at startup | 10 s context |
| Graceful shutdown | 10 s context |

---

## 7. Hidden Architectural Weaknesses & Risks

### ~~Risk 1 — `auth_date` Not Validated → Replay Attack (CRITICAL)~~ ✅ FIXED 2026-06-30

`pkg/tgauth/tgauth.go` now validates `auth_date` after a successful HMAC check. If `auth_date` is missing, unparseable, or more than 86 400 seconds (24 hours) old, `VerifyInitData` returns `ErrExpired`. A captured `initData` is no longer replayable indefinitely. `tgauth_test.go` covers the expiry path with `TestVerifyInitData_Expired`.

---

### ~~Risk 2 — Sync Payload Format Mismatch → Data Never Reaches PostgreSQL (CRITICAL)~~ ✅ FIXED 2026-06-30

`internal/delivery/http/sync.go` now decodes the request body into a `syncRequest` wrapper struct:

```go
type syncRequest struct {
    Transactions []syncTransaction `json:"transactions"`
}
```

This matches the `{"transactions":[...]}` envelope the frontend has always sent. The ACID transaction logic is unchanged. Transactions now correctly reach PostgreSQL.

---

### ~~Risk 3 — Unbounded Sync Batch Size (MEDIUM)~~ ✅ FIXED 2026-06-30

`internal/delivery/http/sync.go` now applies `http.MaxBytesReader(w, r.Body, 1<<20)` before JSON decoding. Payloads exceeding 1 MB are rejected with HTTP 400 `"request body too large"` before any parsing or DB work occurs.

---

### ~~Risk 4 — CategoryCarousel XSS Surface for User-Defined Categories (MEDIUM, latent)~~ ✅ FIXED 2026-06-30

`CategoryCarousel.render()` in `app.js` has been fully rewritten to use `document.createElement` + `textContent`. No `innerHTML` or template literals remain. `cat.icon` and `cat.name` are injected via `textContent`; `cat.color` is applied via `element.style.background` and `element.style.color` (DOM property assignment — not HTML parsing). The container is cleared with `carousel.textContent = ''`. The function is now Stored XSS–safe for user-defined categories.

---

### ~~Risk 5 — Homegrown Migration Tracker Without Atomic Rollback (LOW)~~ ✅ FIXED 2026-06-30

`.github/workflows/deploy.yml` now pipes migration SQL together with the `INSERT INTO _schema_migrations` into a single `psql` invocation using `-v ON_ERROR_STOP=1`. Both the DDL and the tracker insert execute in the same implicit transaction; if any statement fails, `psql` aborts and the migration is not marked as applied — preventing double-application on the next deploy.

---

### ~~Risk 6 — RatesManager Depends on Unauthenticated Free-Tier External API (LOW)~~ ✅ FIXED 2026-06-30

`service/rates.go` fetches `https://open.er-api.com/v6/latest/USD` with no API key. At a 12-hour interval, a single instance consumes ~60 requests/month against the 1 500/month free tier — safe for the current scale.

On any fetch failure (network error, rate limit, API change, decode error), the manager now logs a `[RATES WARN]` message and retains the last known in-memory rates. Fallback rates updated to mid-2026 values: `USD=1.0, RUB=93.50, GEL=2.72, EUR=0.92`.

---

### ~~Risk 7 — Donut Chart: Cross-Currency Aggregation Bug + UX Deficiencies (MEDIUM)~~ ✅ FIXED 2026-06-30

**Root cause (math):** The former `GET /api/v1/analytics/donut` grouped raw transaction amounts server-side without currency conversion — totals were sums of amounts in different currencies. Additionally, `DATE_TRUNC('month', NOW())` used the server's UTC timezone, producing month-boundary mismatches for users in non-UTC locales.

**Fix — `computeLocalDonutData()` (`app.js:420`):**

All aggregation is now client-side (Offline-First). Each transaction is converted to the current app currency **exactly once**, before being added to its category bucket:

```js
amountInAppCurrency = (amount / rates[txCurrency]) * rates[currentAppCurrency]
```

The conversion is skipped when `txCurrency === Store.state.currency` (amounts already in app currency). Month boundary is evaluated using the user's local clock via `new Date().getFullYear()` / `.getMonth()` — no server timezone dependency. Only non-deleted (`!tx.is_deleted`) transactions within the current local calendar month are included. Per-category accumulated totals are emitted as `Number(groups[catId].toFixed(2))`.

**Fix — Donut UX (`charts.js`):**

- **SVG size:** `<svg class="donut-svg">` dimensions set to `width="100%" height="100%"` — the chart expands to the full width of its container element for improved readability on all screen sizes.
- **Center amount:** Rendered as `centerAmt.toFixed(2) + ' ' + currencySymbol` (e.g., `"12345.67 ₽"`). `centerAmt` equals `totalAll` — the sum of all category totals (`_lastData.reduce((s, d) => s + d.total, 0)`) — when no segment is selected; switches to the tapped segment's own `total` on category focus. Set via `svgTexts[1].textContent` — no HTML injection.
- **Legend amounts:** Replaced from percentage shares to absolute formatted values via `_fmtLegendAmt(item.total, currency)`. The helper uses `Number(amount).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` and appends the currency symbol string. Injected via `amtEl.textContent` — XSS-safe.

**Апдейт 2026-06-30 — Аналитика произвольных интервалов:**
- Логика `computeLocalDonutData()` расширена: жесткая фильтрация по текущему месяцу заменена на динамический диапазон. Фильтрация идет по условию `txTime >= start && txTime <= end`.
- Для реактивного стейта `Store.state.analyticsRange` использованы Unix-таймстампы (числа в мс) вместо объектов `Date`. Это предотвращает поломку внутренних механизмов JS-движка (`[[DateValue]]`) при рекурсивном оборачивании объектов в `Proxy`.
- Переключение периодов (`'day' | 'month'`) реализовано через делегирование pointerdown-событий на контейнере `.analytics-period-switcher`. Стили наследуют переменные Telegram-темы (`--accent-color`, `--hint-color`).

---

### ~~Risk 8 — Ограничение аналитики фиксированным месяцем и системными селектами~~ ✅ FIXED 2026-06-30

**Внедрение произвольных интервалов и кастомного календаря:**
- Логика `computeLocalDonutData()` расширена: жесткая фильтрация по текущему месяцу заменена на динамический диапазон. Фильтрация идет по условию `txTime >= start && txTime <= end`.
- Для реактивного стейта `Store.state.analyticsRange` использованы Unix-таймстампы (числа в мс) вместо объектов `Date`. Это предотвращает поломку внутренних механизмов JS-движка (`[[DateValue]]`) при рекурсивном оборачивании объектов в `Proxy`.
- Переключение периодов (`'day' | 'month' | 'custom'`) реализовано через делегирование pointerdown-событий на контейнере `.analytics-period-switcher`. При выборе `'custom'` отображается блок с двумя нативными HTML5-инпутами дат, стилизованными под переменные Telegram-темы. Рендеринг пончика триггерится автоматически за счет реактивных подписок на стейт.