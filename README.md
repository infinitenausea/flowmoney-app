# FlowMoney

Personal finance tracker built as a Telegram Mini App. Users log expenses directly inside Telegram — no separate app download required.

---

## Features

- **Expense tracking** — add transactions via a numpad UI, grouped by category
- **Budget limits** — set daily, weekly, and monthly spending limits with live progress indicators
- **Analytics** — donut chart for monthly spend by category + paginated transaction timeline
- **Currency converter** — exchange rates widget with live auto-recalculation of limits
- **Offline-first** — transactions are saved to `localStorage` and synced to the server when online
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

Create a `.env` file in the project root:

```env
BOT_TOKEN=your_telegram_bot_token
DATABASE_URL=postgres://flowmoney:flowmoney@postgres:5432/flowmoney?sslmode=disable
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

Migrations run automatically on startup via the custom shell runner (tracked in `_schema_migrations`).

---

## API

All protected routes require `Authorization: Telegram <initData>` header.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Liveness probe |
| `GET` | `/api/v1/bootstrap` | ✓ | Load initial state (currency, budget, categories) |
| `POST` | `/api/v1/sync` | ✓ | Batch upsert transactions |
| `GET` | `/api/v1/analytics/donut` | ✓ | Monthly spend by category |
| `GET` | `/api/v1/analytics/timeline` | ✓ | Paginated transaction history |

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
