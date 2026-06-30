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
7. Validate `auth_date` — must be present, parseable, and ≤ 86 400 s (24 h) old. Returns `ErrExpired` if stale.

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
updateAnalyticsRange()  вычисляет start/end Unix-мс для 'month'; ранний вызов гарантирует
                        заполнение Store.state.analyticsRange до StorageManager и первого рендера
StorageManager.init()   load transactions from localStorage, run UUID migration
Settings.init()         load budget limits from localStorage, wire currency/limit controls
initBindings()          reactive DOM ← Store subscriptions
Router.init()           wire nav tabs, set currentTab = 'home'
NumPad.init()           wire numpad pointerdown events
CategoryCarousel.init() render default categories, subscribe to Store.categories
initAnalytics()         initPeriodSwitcher() + CalendarSheet.init() + SwipeGesture.init();
                        subscribe currentTab / selectedAnalyticsCategory / transactions
initNetworkWatcher()    window online/offline → Store.state.isOnline

await Promise.all([bootstrap(), wait 400ms])   // skeleton shown ≥ 400 ms

hideSkeleton()          fade-out skeleton (280 ms), reveal #app
initialPull()           GET /api/v1/analytics/timeline?limit=200 если localStorage пуст;
                        StorageManager.bulkLoad() → реактивное обновление Store + UI
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

**Open:** `_openCurrencySheet(target)` writes `_activeCurrencyTarget`, then toggles the `.selected` CSS class on the `.currency-sheet-option` matching the active currency for that context. The sheet becomes visible via `requestAnimationFrame(() => sheet.classList.add('active'))`.

**Close:** `_closeCurrencySheet()` removes `.active`; `aria-hidden="true"` is restored after a 340 ms CSS transition delay. The backdrop's `pointerdown` also triggers close.

**Selection dispatch:** The `pointerdown` listener on each `.currency-sheet-option` reads `opt.dataset.currency` and branches on `_activeCurrencyTarget`. All three code paths end with `_closeCurrencySheet()`. All bindings use `pointerdown` with `e.preventDefault()` — consistent with the tap-delay elimination strategy (see §2.5).

### 2.7 Кастомный календарь-шторка (`#calendar-sheet`)

`CalendarSheet` — приватный IIFE-модуль в `app.js`, инициализируемый из `initAnalytics()`. Управляет вводом кастомных дат без вызова системной клавиатуры устройства.

**DOM-элементы:**

| Элемент | Роль |
|---|---|
| `#calendar-sheet` | Bottom Sheet; `classList.add/remove('active')` для показа/скрытия |
| `#calendar-start-trigger` | `pointerdown` → `CalendarSheet.open('start')` |
| `#calendar-end-trigger` | `pointerdown` → `CalendarSheet.open('end')` |
| `#calendar-start-label` / `#calendar-end-label` | Текст выбранных дат (`DD.MM.YYYY`); обновляется через `textContent` |
| `#calendar-month-label` | Заголовок месяца; `textContent = MONTHS_RU[viewMonth] + ' ' + viewYear` |
| `#calendar-grid` | Контейнер сетки; очищается `grid.textContent = ''` перед каждым рендером |
| `.calendar-weekdays` | Заголовки дней недели; строятся один раз в `init()` через `createElement + textContent` |
| `#calendar-prev` / `#calendar-next` | `pointerdown` — навигация по месяцам |
| `.bottom-sheet-backdrop` | `pointerdown` → `close()` |

**Механика открытия (`open(target)`):**
1. Записывает `currentTarget` (`'start'` | `'end'`).
2. Вычисляет стартовый месяц из `Store.state.analyticsRange[target]` (или текущей даты, если `null`).
3. Вызывает `renderGrid()`, затем `sheet.classList.add('active')` + убирает `aria-hidden`.

**Рендер сетки (`renderGrid()`):**
- Вычисляет смещение первого дня (пн=0): `(firstDow + 6) % 7` — без привязки к воскресенью как нулевому дню.
- Для каждого дня создаёт `div.calendar-day` и число через **`document.createTextNode(String(day))`** — строго без HTML-парсинга (XSS-защита, см. §8.2).
- Классы `today`, `range-start`, `range-end`, `in-range` проставляются сравнением нормализованных Unix-таймстампов (`new Date(year, month, day).getTime()`).
- Дни строятся в `DocumentFragment` и вставляются единственным `appendChild`.

**Выбор дня (`handleDayTap(day)`):**
- `dayStart` = `new Date(viewYear, viewMonth, day).getTime()` (00:00:00.000 в мс).
- `dayEnd` = `new Date(viewYear, viewMonth, day, 23, 59, 59, 999).getTime()`.
- При `currentTarget === 'start'`: пишет `newStart`; если `newStart > newEnd` — принудительно подтягивает `newEnd = dayEnd` (корректировка инверсии).
- При `currentTarget === 'end'`: пишет `newEnd`; если `newEnd < newStart` — принудительно подтягивает `newStart = dayStart`.
- Записывает `Store.state.analyticsRange = { start: newStart, end: newEnd }` — только числа в мс, без `Date`-объектов.
- Устанавливает `Store.state.analyticsPeriod = 'custom'`.
- Если `Store.state.currentTab === 'analytics'` — немедленно вызывает `loadAnalyticsData()`.
- Вызывает `close()`.

**Навигация по месяцам:** `#calendar-prev` / `#calendar-next` — `pointerdown` + `e.preventDefault()` + Haptic `'light'`; декремент/инкремент `viewMonth` с перемоткой `viewYear` на границах `0 ↔ 11`; перерисовка сетки.

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

> **Архитектурное примечание:** Расчёт аналитики пончика полностью перенесён на сторону клиента (Offline-First). Эндпоинт не вызывается фронтендом. Логика агрегации — в `computeLocalDonutData()` (`app.js`); детали — в §5.

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
    "RUB": 93.50,
    "GEL": 2.72,
    "EUR": 0.92
  }
}
```

If no budget row exists, `budget` fields are all `0` (`pgx.ErrNoRows` is handled, not propagated as an error).

**`POST /api/v1/sync`**

Body is a JSON **object with a `transactions` array** (1 MB cap enforced via `http.MaxBytesReader`):

```json
{
  "transactions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "category_id": "11111111-1111-1111-1111-111111111101",
      "amount": 350.00,
      "currency": "RUB",
      "created_at": "2026-06-30T14:22:00Z",
      "is_deleted": false
    }
  ]
}
```

All items are processed in a single `BEGIN/COMMIT` transaction. Each item is an `UpsertTransaction` (`ON CONFLICT (id) DO UPDATE`). If `currency` is empty string, the handler defaults it to `"USD"`. On any error, the entire batch is rolled back.

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

> Эндпоинт выведен из эксплуатации. Серверная реализация сохранена в `internal/delivery/http/analytics.go` и `queries/queries.sql` (запрос `GetAnalyticsDonut`), но фронтенд её не вызывает.

**`GET /api/v1/analytics/timeline`**

The endpoint has **two distinct operating modes** determined by query parameters:

**Mode A — Delta Pull (`?since=RFC3339`)**

Returns all records (including soft-deleted) whose `updated_at > since`, ordered by `updated_at ASC`. Used by `SyncRunner._pull()` on subsequent syncs. Backed by `GetTransactionsDelta` query and `idx_transactions_user_updated_at` index.

```json
{
  "items": [
    {
      "id": "uuid",
      "category_id": "uuid",
      "amount": 350.00,
      "currency": "RUB",
      "created_at": "2026-06-30T14:22:00Z",
      "is_deleted": false,
      "updated_at": "2026-06-30T14:22:00Z"
    }
  ]
}
```

**Mode B — Cursor-based Timeline (`?cursor=RFC3339&limit=N`)**

Returns only non-deleted transactions with `created_at < cursor`, ordered `created_at DESC`. Used for initial data load. Default limit: 20. Max limit: 200. Backed by `GetTimelineWithCursor` query and `idx_transactions_user_timeline` partial index.

- `cursor` — RFC3339 timestamp; returns items older than cursor.
- Response `next_cursor` — RFC3339Nano timestamp of the **oldest item in the current page**. `null` when no more items.

```json
{
  "items": [
    {
      "id": "uuid",
      "category_id": "uuid",
      "amount": 350.00,
      "currency": "RUB",
      "created_at": "2026-06-30T14:22:00Z",
      "is_deleted": false,
      "updated_at": "2026-06-30T14:22:00Z"
    }
  ],
  "next_cursor": "2026-06-29T10:15:00.123456789Z"
}
```

---

## 4. Delta Sync Protocol

The sync system is **bidirectional** and **Offline-First**: local state is always consistent, and server sync happens in the background without blocking UI.

### 4.1 SyncRunner Architecture (`frontend/js/sync.js`)

`SyncRunner` is a private IIFE module exposed as `window.SyncRunner`.

**Triggers:**
- `SyncRunner.start()` wires two triggers: `setInterval(syncWithBackend, 15_000)` and `window.addEventListener('online', syncWithBackend)`.
- An immediate attempt fires if `navigator.onLine === true` at startup.
- `SyncRunner.syncWithBackend()` is also called out-of-band (without waiting for the interval) immediately after every transaction save in `app.js`.

**Mutex:** `_isSyncing` boolean flag prevents concurrent sync cycles. If a cycle is already running, `syncWithBackend()` returns immediately. The flag is released in a `finally` block.

**Error handling:** All network errors are silently swallowed (`console.warn`). The cycle fails gracefully — the next interval or online event retries automatically.

### 4.2 Push Phase (`_push`)

```
pending = StorageManager.getUnsyncedTransactions()  // filter: !tx.synced
if pending.length === 0 → early return (no network request made)

POST /api/v1/sync  { "transactions": pending }
→ 200 OK   → StorageManager.markAsSynced(pending.map(tx => tx.id))
→ non-2xx  → throw Error → caught by syncWithBackend, will retry next cycle
```

**Idempotency:** The backend uses `UpsertTransaction` (`ON CONFLICT (id) DO UPDATE`). Retrying the same batch is safe.

**Optimistic UI:** `saveTransactionLocally()` writes to localStorage and updates `Store.state.transactions` immediately. The `synced: false` flag causes the `.sync-pending` indicator to appear in the timeline until `markAsSynced()` flips it.

### 4.3 Pull Phase (`_pull`)

The pull phase uses **two different API modes** depending on whether a prior sync has occurred:

| Condition | URL | Backend query | Includes `is_deleted: true`? |
|---|---|---|---|
| First sync (`getLastSyncedAt() === null`) | `?limit=200` | `GetTimelineWithCursor` | No |
| Subsequent syncs | `?since=<last_updated_at>` | `GetTransactionsDelta` | **Yes** |

`getLastSyncedAt()` reads `localStorage['flowmoney_last_synced_at']` (an RFC3339 string).

After a successful delta pull, `mergeFromServer(data.items)` updates `last_synced_at` with the **maximum `updated_at`** among returned items, advancing the delta window for the next cycle.

### 4.4 Conflict Resolution (`StorageManager.mergeFromServer`)

The client-side merge algorithm (`storage.js`) applies the following rules per server record:

| Condition | Action |
|---|---|
| `serverTx.is_deleted === true` | Remove from `localMap` (hard delete from client state) |
| `serverTx.id` not in `localMap` | Insert as new record (`synced: true, _pending: false`) |
| `localMap[id]._pending === true` | **Skip** — local record is in-flight; server must not overwrite |
| `localMap[id]._pending === false` | Replace with server version (`synced: true`) |

**Currency field preservation:** The merge prefers the local `currency` value over the server's:

```js
const currency = (local && local.currency) || serverTx.currency || Store.state.currency || 'RUB';
```

Priority: `local.currency` › `serverTx.currency` › current app currency › `'RUB'`.

**`last_synced_at` update:** After iterating all items, the maximum `updated_at` seen across all server records is persisted to `localStorage['flowmoney_last_synced_at']`. This value becomes the `since` parameter for the next delta pull.

---

## 5. Multi-Currency Engine

### 5.1 Backend: RatesManager (`internal/service/rates.go`)

`RatesManager` holds exchange rates **relative to USD** (USD = 1.0) in a thread-safe in-memory map. It is initialized with hardcoded fallback rates and fetches live rates on startup and every 12 hours.

**Supported currencies:** `USD`, `RUB`, `GEL`, `EUR` (hardcoded allowlist; enforced in both `fetch()` and `PUT /settings` handler).

**Data source:** `GET https://open.er-api.com/v6/latest/USD` (unauthenticated free tier; ~60 req/month at 12h interval; free tier limit: 1 500 req/month).

**Failure behavior:** On any error (network, decode, non-`"success"` result field), `[RATES WARN]` is logged and last known in-memory rates are retained unchanged. The bootstrap response always returns some rates — never null or empty.

**Thread safety:** `sync.RWMutex` — `Rates()` takes a read lock and returns a **copy** of the map; `fetch()` takes a write lock only during the update loop.

**Hardcoded fallback values:**

| Currency | Rate vs USD |
|---|---|
| USD | 1.0 |
| RUB | 93.50 |
| GEL | 2.72 |
| EUR | 0.92 |

### 5.2 Transaction Currency Isolation

Each transaction carries its own `currency` field, set at creation time and **never changed** for the life of the record. This separates the transaction's native currency from the system display currency:

- **At save time** (`StorageManager.saveTransactionLocally()`): `currency = Store.state.currency || 'RUB'` — locked to the app currency at the moment the user confirms the transaction.
- **At sync time** (`POST /api/v1/sync`): `currency` is sent in the payload and stored in the `transactions.currency` column.
- **At display time** (timeline): amounts are converted on-the-fly to the current display currency using live rates from `Store.state.rates`.
- **At analytics time** (`computeLocalDonutData()`): amounts are converted to the current app currency before category aggregation.

### 5.3 `computeLocalDonutData()` — Math Model

All aggregation is client-side (Offline-First). The function filters transactions by `Store.state.analyticsRange` (`{ start: number, end: number }` in Unix-ms) and groups by `category_id`.

**Conversion formula (exact implementation):**

```js
const appCur     = (Store.state.currency || 'RUB').toUpperCase(); // forced UPPERCASE
const txCurrency = (tx.currency || appCur).toUpperCase();          // forced UPPERCASE

let amountInAppCurrency = parseFloat(tx.amount) || 0;

if (txCurrency !== appCur && rates[txCurrency] && rates[appCur]) {
  amountInAppCurrency = (amountInAppCurrency / rates[txCurrency]) * rates[appCur];
}

groups[tx.category_id] = (groups[tx.category_id] || 0) + amountInAppCurrency;
```

**Key invariants:**

- Both `txCurrency` and `appCur` are **forcibly uppercased** before being used as keys into the `rates` map. This prevents mismatches between mixed-case values that may be stored locally and the UPPERCASE keys returned by the exchange rate API and the backend.
- Conversion is skipped (no floating-point rounding applied) when `txCurrency === appCur`.
- Missing rate keys (`!rates[txCurrency]` or `!rates[appCur]`) also skip conversion — the raw amount is used as-is (safe degradation, no crash).
- Soft-deleted transactions (`tx.is_deleted === true`) are excluded before grouping.
- Per-category totals are rounded to 2 decimal places via `Number(groups[catId].toFixed(2))`.

**Date range:** Filtering uses `txTime >= start && txTime <= end`. The `start`/`end` values are Unix-ms numbers from `Store.state.analyticsRange`. When `analyticsPeriod` is `'custom'`, `updateAnalyticsRange()` performs an early return (`if (period === 'custom') return`) to prevent overwriting user-selected dates on Store subscription re-fires.

**Output:** `Array<{ category_id: string, total: number }>` — totals denominated in the current app currency.

### 5.4 UI Optimization: `refreshCurrencyLabels()` (`charts.js`)

When the user changes the display currency, SVG segment geometry does not need to change — only the **text amounts** in the donut center and legend change. `refreshCurrencyLabels()` avoids a full `renderDonutChart()` redraw:

**What it does:**
1. Accepts `freshData` (output of `computeLocalDonutData()` with new-currency totals) and updates the module-private `_lastData`, so that subsequent segment taps also reflect correct converted amounts.
2. Recalculates `total = _lastData.reduce((s, d) => s + d.total, 0)`.
3. Sets `svgTexts[1].textContent` (center amount line) to `centerAmt.toFixed(2) + ' ' + sym`.
4. For each `.donut-legend-item`, matches by `data-cat-id` attribute and updates only the `.donut-legend-amt` span's `textContent`.

**What it does NOT do:**
- Does not touch SVG `<circle>` elements — no segment geometry change, no reflow of arc math.
- Does not rebuild the legend DOM — only mutates text nodes.
- Does not call `container.innerHTML = ...`.

**Trigger path:**

```
Settings: user selects new currency
  → _handleCurrencyChange(newCur)
  → Store.state.currency = newCur
    → Store 'currency' subscription fires (initBindings())
      → if (Store.state.currentTab === 'analytics')
          freshData = computeLocalDonutData()          // recompute with new currency
          DonutChart.refreshCurrencyLabels(newCur, freshData)  // text-only update
```

> **Known debt (Risk 9):** `refreshCurrencyLabels()` currently contains a debug diagnostic line that replaces `svgTexts[0]` (center label) with a UUID summary string on every currency change. See §9.

---

## 6. Data Model

### 6.1 DDL (All Migrations, In Order)

```sql
-- 000001_init_schema.up.sql

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
-- 000002_seed_system_categories.up.sql
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
-- 000003_add_transactions_updated_at.up.sql

ALTER TABLE transactions
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE transactions SET updated_at = created_at;  -- backfill existing rows

CREATE INDEX idx_transactions_user_updated_at
    ON transactions(user_id, updated_at ASC);
```

```sql
-- 000004_add_transactions_currency.up.sql

ALTER TABLE transactions
    ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'USD';
```

```sql
-- Homegrown migration tracker (created by CI script inline, not a migration file)
CREATE TABLE IF NOT EXISTS _schema_migrations (
    filename   TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
);
```

### 6.2 Full Transaction Schema (Post All Migrations)

```sql
transactions (
    id          UUID           PRIMARY KEY,
    user_id     BIGINT         NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
    category_id UUID           NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    amount      DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    is_deleted  BOOLEAN        NOT NULL DEFAULT FALSE,
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),   -- migration 000003
    currency    VARCHAR(10)    NOT NULL DEFAULT 'USD'    -- migration 000004
)
```

**Indexes on `transactions`:**

| Index | Columns | Condition | Used by |
|---|---|---|---|
| `idx_transactions_user_id` | `(user_id)` | — | General user scoping |
| `idx_transactions_created_at` | `(created_at DESC)` | — | Sort-only queries |
| `idx_transactions_user_timeline` | `(user_id, created_at DESC)` | `WHERE is_deleted = FALSE` | `GetTimelineWithCursor` (cursor pagination) |
| `idx_transactions_user_updated_at` | `(user_id, updated_at ASC)` | — | `GetTransactionsDelta` (delta sync) |

### 6.3 Key Constraints Explained

| Constraint | Table | Purpose |
|---|---|---|
| `ON DELETE CASCADE` | categories → users | Deleting a user wipes all their categories |
| `ON DELETE CASCADE` | transactions → users | Deleting a user wipes all their transactions |
| `ON DELETE CASCADE` | budgets → users | Deleting a user wipes their budget row |
| `ON DELETE RESTRICT` | transactions → categories | Prevents orphan transactions; category can't be deleted while in use |
| `CHECK (amount > 0)` | transactions | Enforces positive amounts at DB level |
| `CHECK (daily/weekly/monthly_limit >= 0)` | budgets | Limits can be zero (disabled) but not negative |
| `TIMESTAMPTZ` | all date columns | Stored as UTC; no timezone-aware confusion |

### 6.4 Query Notes

- `GetCategoriesByUserId`: `WHERE user_id = $1 OR is_system = true ORDER BY sort_order ASC` — every user sees all 8 system categories regardless of their own `user_id`.
- `UpsertUser`: `ON CONFLICT (tg_id) DO UPDATE SET updated_at = NOW()` — acts as a login ping; updates `updated_at` on every bootstrap call.
- `UpsertTransaction`: `ON CONFLICT (id) DO UPDATE SET ... updated_at = NOW()` — `updated_at` is always server-assigned at upsert time, never client-supplied. This is what `GetTransactionsDelta` tracks to identify changed records.
- `GetTransactionsDelta`: `WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at ASC` — returns all records including soft-deleted ones; `ASC` ordering ensures client can safely advance `last_synced_at` to the last item's `updated_at`.
- ~~`GetAnalyticsDonut`~~: aggregates current calendar month using `DATE_TRUNC('month', NOW())` on the server. **[UNUSED]** — frontend switched to `computeLocalDonutData()` (client-side); see §5.3.

---

## 7. Project Map

```
FlowMoney-app/
│
├── cmd/app/main.go              Entry point: config load, DB pool, chi router, file server, graceful shutdown
│
├── internal/
│   ├── config/config.go         Reads env vars; mustEnv() panics on missing required vars
│   ├── delivery/http/
│   │   ├── middleware.go        TelegramAuth middleware: HMAC verify + auth_date expiry → inject telegram_id
│   │   ├── bootstrap.go        GET /bootstrap: UpsertUser + GetBudget + GetCategories + rates
│   │   ├── sync.go             POST /sync: 1 MB cap; DB transaction wrapping batch UpsertTransaction
│   │   ├── settings.go         PUT /settings: UpdateUserCurrency + UpsertBudget
│   │   └── analytics.go        GET /analytics/timeline: ?since= (delta) or ?cursor= (cursor pagination)
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
│   ├── tgauth.go               VerifyInitData: HMAC-SHA256 + auth_date expiry (ErrExpired)
│   └── tgauth_test.go          Unit tests: TestVerifyInitData_Expired and happy paths
│
├── migrations/
│   ├── 000001_init_schema.up.sql                  users, categories, transactions, budgets + indexes
│   ├── 000002_seed_system_categories.up.sql       system user (tg_id=0) and 8 system categories
│   ├── 000003_add_transactions_updated_at.up.sql  updated_at column + idx_transactions_user_updated_at
│   └── 000004_add_transactions_currency.up.sql    currency column on transactions
│
├── frontend/
│   ├── index.html              Single HTML shell; skeleton loader, three screen divs, bottom nav
│   ├── css/style.css           All styles; CSS custom properties for Telegram theme vars
│   └── js/
│       ├── store.js            Reactive Proxy-based Store; key-scoped subscriptions; batchUpdate;
│       │                       State: analyticsPeriod ('day'|'month'|'custom'),
│       │                       analyticsRange ({start, end} — Unix-таймстампы в мс)
│       ├── storage.js          StorageManager: localStorage r/w; UUID migration; soft-delete;
│       │                       bulkLoad(), mergeFromServer(), getLastSyncedAt()
│       ├── sync.js             SyncRunner: 15 s interval + online event; _isSyncing mutex; _push/_pull
│       ├── settings.js         Settings: currency/limit controls; debounced server sync (1500 ms); converter
│       ├── app.js              App entry: Telegram SDK init, Theme, Router, NumPad, CategoryCarousel,
│       │                       computeLocalDonutData(), updateAnalyticsRange(), CalendarSheet, bindings
│       ├── charts.js           DonutChart: SVG donut + legend + refreshCurrencyLabels(); timeline DOM
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

## 8. Security Standards & Debt

### 8.1 DB Error Masking

All handler functions return only `"internal server error"` to the client on DB failures:

```go
// Pattern used in bootstrap.go, sync.go, settings.go, analytics.go
http.Error(w, "internal server error", http.StatusInternalServerError)
```

Raw pgx errors are **never forwarded** to the client. The chi `middleware.Logger` logs the HTTP exchange. The sync handler additionally logs `log.Printf("SYNC ERROR: ...")` before returning 500.

**Partial exception:** `middleware.go` returns `"bad request: " + err.Error()` for parsing failures. The exposed errors originate from the `tgauth` package (`"tgauth: hash field is missing from initData"`) and from `url.ParseQuery` — not from pgx. DB internals are never exposed.

### 8.2 XSS Protection Standards

**Safe pattern — timeline renderer (`charts.js`):**

```js
// All user-visible data via textContent — HTML injection impossible
const nameEl = document.createElement('div');
nameEl.textContent = categoryName;

const iconEl = document.createElement('div');
iconEl.textContent = categoryIcon;  // emoji injected as text, not markup
```

The entire timeline DOM tree is built with `createElement` + `textContent`. Two `innerHTML` assignments in `charts.js` are safe:
1. SVG donut structure — guarded by `_esc()` which escapes `&`, `<`, `>`, `"` before injection.
2. Swipe-delete overlay — static hardcoded SVG markup; zero user data.

**`CategoryCarousel.render()` in `app.js` ✅ FIXED 2026-06-30:**

Rewritten to use `createElement` + `textContent` + DOM style properties. No `innerHTML` or template literals remain. Stored XSS–safe for user-defined categories.

**`CalendarSheet.renderGrid()` in `app.js`:**

Day numbers rendered via `document.createTextNode(String(day))` — HTML parsing excluded, markup injection impossible.

### 8.3 NumPad Input Limits

| Limit | Numpad (home screen) | Budget modal (settings) |
|---|---|---|
| Max integer digits | 6 | 7 |
| Max decimal digits | 2 | 2 |
| Max value | 999,999 | 9,999,999 |
| Source | `app.js MAX_DIGITS/MAX_AMOUNT` | `settings.js MAX_DIGITS/MAX_AMOUNT` |

The DB `CHECK (amount > 0)` is the only server-side amount guard; there is no server-side upper-bound validation.

### 8.4 Key Timings

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

### 8.5 Server Timeouts

| Timeout | Value |
|---|---|
| `ReadTimeout` | 15 s |
| `WriteTimeout` | 15 s |
| `IdleTimeout` | 60 s |
| DB pool `Ping` at startup | 10 s context |
| Graceful shutdown | 10 s context |

---

## 9. Hidden Architectural Weaknesses & Risks

### ~~Risk 1 — `auth_date` Not Validated → Replay Attack (CRITICAL)~~ ✅ FIXED 2026-06-30

`pkg/tgauth/tgauth.go` now validates `auth_date` after a successful HMAC check. If `auth_date` is missing, unparseable, or more than 86 400 seconds (24 hours) old, `VerifyInitData` returns `ErrExpired`. A captured `initData` is no longer replayable indefinitely. `tgauth_test.go` covers the expiry path with `TestVerifyInitData_Expired`.

---

### ~~Risk 2 — Sync Payload Format Mismatch → Data Never Reaches PostgreSQL (CRITICAL)~~ ✅ FIXED 2026-06-30

`internal/delivery/http/sync.go` decodes the request body into a `syncRequest` struct (`json:"transactions"`), matching the `{"transactions":[...]}` envelope the frontend sends. The ACID transaction logic is unchanged.

---

### ~~Risk 3 — Unbounded Sync Batch Size (MEDIUM)~~ ✅ FIXED 2026-06-30

`internal/delivery/http/sync.go` applies `http.MaxBytesReader(w, r.Body, 1<<20)` before JSON decoding. Payloads exceeding 1 MB are rejected with HTTP 400 `"request body too large"` before any parsing or DB work occurs.

---

### ~~Risk 4 — CategoryCarousel XSS Surface for User-Defined Categories (MEDIUM)~~ ✅ FIXED 2026-06-30

`CategoryCarousel.render()` in `app.js` fully rewritten to use `document.createElement` + `textContent`. No `innerHTML` or template literals remain.

---

### ~~Risk 5 — Homegrown Migration Tracker Without Atomic Rollback (LOW)~~ ✅ FIXED 2026-06-30

`.github/workflows/deploy.yml` now pipes migration SQL together with the `INSERT INTO _schema_migrations` into a single `psql -v ON_ERROR_STOP=1` invocation. Both the DDL and the tracker insert execute in the same implicit transaction; failure aborts without marking the migration as applied.

---

### ~~Risk 6 — RatesManager Depends on Unauthenticated Free-Tier External API (LOW)~~ ✅ MITIGATED 2026-06-30

~60 req/month at 12h interval against the 1 500/month free tier — safe for current scale. On any fetch failure, last known rates are retained (logged as `[RATES WARN]`).

---

### ~~Risk 7 — Donut Chart: Cross-Currency Aggregation Bug + UX Deficiencies (MEDIUM)~~ ✅ FIXED 2026-06-30

Aggregation moved client-side to `computeLocalDonutData()`. Cross-rate conversion applied per transaction before category bucketing. Month boundary uses client local clock. See §5.3.

---

### ~~Risk 8 — Proxy Date Objects in `Store.state.analyticsRange` (MEDIUM)~~ ✅ FIXED 2026-06-30

`Store.state.analyticsRange` stores `{ start: number, end: number }` in Unix-ms — primitive numbers, not `Date` objects. The reactive Proxy in `store.js` wraps nested objects in new Proxy instances, which destroys the non-transferable `[[DateValue]]` internal slot of `Date`. Primitive numbers are unaffected. CalendarSheet provides keyboard-free date input using `createTextNode` for XSS safety. See §2.7 and §5.3.

---

### ~~Risk 9 — Debug Code in `refreshCurrencyLabels()` (LOW)~~ ✅ FIXED 2026-06-30

`charts.js` → `refreshCurrencyLabels()` debug block removed. Center label now uses the same production logic as `renderDonutChart()` to resolve category name from `Store.state.categories` with fallback to transaction name or `'Месяц'`, maintaining the 12-character slice limit.
