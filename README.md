# FlowMoney

Personal finance tracker built as a Telegram Mini App. Users log expenses directly inside Telegram — no separate app download required.

---

## Features

- **Expense tracking** — add transactions via a numpad UI, grouped by category
- **Expense tracking with comments** — add transactions via a numpad UI, grouped by user-defined category; optional free-text comment per transaction
- **Custom categories** — create, edit, and soft-delete personal categories (icon + color picker); synced across devices
- **Budget limits** — set weekly and monthly spending limits with live progress indicators
- **Analytics** — donut chart for any date range (day / month / custom) aggregated client-side + paginated transaction timeline; swipe left to delete, swipe right to duplicate
- **Currency converter** — exchange rates widget (USD/RUB/GEL/EUR) with live auto-recalculation of limits
- **Offline-first** — transactions and categories are saved to `localStorage` and synced to the server when online; 15 s background tick + online-event trigger
- **Telegram-native** — follows Telegram theme (dark/light), respects system gestures, no zoom

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Go 1.21, `go-chi/chi` v5 |
| Database | PostgreSQL 16, `pgx` v5, `sqlc` |
| Frontend | Vanilla JS (ES6+), Vanilla CSS — no framework, no bundler |
| Auth | HMAC-SHA256 Telegram `initData` validation |
| Container | Docker multi-stage build + Docker Compose |
| Reverse proxy | Caddy (on host VPS, not in repo) |
| CI/CD | GitHub Actions → SSH deploy on push to `main` |

---

## Project Structure

```
FlowMoney-app/
├── cmd/app/              # main.go — server entrypoint
├── internal/
│   ├── delivery/http/    # handlers, middleware, router
│   ├── service/          # business logic
│   └── repository/postgres/  # sqlc-generated queries
├── pkg/tgauth/           # HMAC-SHA256 Telegram auth package
├── frontend/             # SPA (index.html + JS modules + CSS)
├── migrations/           # SQL migration files
├── docker-compose.yml
└── ARCHITECTURE.md       # detailed architecture reference
```

---

## Getting Started

### Prerequisites

- Docker & Docker Compose
- A Telegram Bot token ([@BotFather](https://t.me/BotFather))

### Environment Variables

Create a `.env` file in the project root (see `.env.example`):

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
DB_USER=flowmoney
DB_PASSWORD=secret
DB_NAME=flowmoney
DB_HOST=postgres
DB_PORT=5432
DB_SSLMODE=disable
PORT=8082
```

### Run with Docker Compose

```bash
docker-compose up --build
```

The app listens on port `8082`. Point your reverse proxy (Caddy/nginx) at it and configure your Telegram Bot's Mini App URL to your domain.

### Run without Docker (local dev)

```bash
# Start Postgres separately, then:
go run ./cmd/app
```

Migrations are applied by the CI/CD pipeline (`deploy.yml`) after each deploy via a homegrown shell runner tracked in `_schema_migrations`. They do **not** run automatically on Go startup — apply manually with `psql` when developing locally.

---

## API

All protected routes require `Authorization: Telegram <initData>` header.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Liveness probe |
| `GET` | `/api/v1/bootstrap` | ✓ | Load initial state (currency, budget, categories, exchange rates) |
| `POST` | `/api/v1/sync` | ✓ | Batch upsert transactions **and categories** in a single DB transaction |
| `PUT` | `/api/v1/settings` | ✓ | Update currency and budget limits |
| `GET` | `/api/v1/analytics/timeline` | ✓ | Delta sync (`?since=`) or cursor pagination (`?cursor=&limit=`) |
| `GET` | `/api/v1/analytics/donut` | ✓ | Server-side monthly aggregation — **registered but unused**; frontend uses client-side computation |

See [ARCHITECTURE.md](ARCHITECTURE.md) for full JSON contracts and data model.

---

## CI/CD

Pushing to `main` triggers `.github/workflows/deploy.yml`:

1. Build Docker image on the runner
2. SSH into the VPS
3. Pull latest, run pending migrations, restart the container

---

## License

MIT
