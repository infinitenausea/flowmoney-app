-- name: UpsertUser :one
INSERT INTO users (tg_id, currency, created_at, updated_at)
VALUES ($1, $2, NOW(), NOW())
ON CONFLICT (tg_id) DO UPDATE
    SET updated_at = NOW()
RETURNING tg_id, currency, created_at, updated_at;

-- name: GetBudgetsByUserId :one
SELECT user_id, weekly_limit, monthly_limit
FROM budgets
WHERE user_id = $1;

-- name: GetCategoriesByUserId :many
SELECT id, user_id, name, color, icon, is_system, sort_order
FROM categories
WHERE user_id = $1
ORDER BY sort_order ASC;

-- name: GetAnalyticsDonut :many
SELECT category_id, SUM(amount)::FLOAT8 AS total
FROM transactions
WHERE user_id   = $1
  AND is_deleted = false
  AND created_at >= DATE_TRUNC('month', NOW())
  AND created_at  < DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
GROUP BY category_id;

-- name: GetTimelineWithCursor :many
SELECT id, user_id, category_id, amount, created_at, is_deleted, updated_at, currency, comment
FROM transactions
WHERE user_id   = $1
  AND is_deleted = false
  AND ($2::TIMESTAMPTZ IS NULL OR created_at < $2)
ORDER BY created_at DESC
LIMIT $3;

-- name: UpsertTransaction :exec
INSERT INTO transactions (id, user_id, category_id, amount, created_at, is_deleted, currency, comment)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO UPDATE
SET category_id = EXCLUDED.category_id,
    amount      = EXCLUDED.amount,
    is_deleted  = EXCLUDED.is_deleted,
    currency    = EXCLUDED.currency,
    comment     = EXCLUDED.comment,
    updated_at  = NOW();

-- name: GetTransactionsDelta :many
SELECT id, category_id, amount, created_at, is_deleted, updated_at, currency, comment
FROM transactions
WHERE user_id = $1 AND updated_at > $2
ORDER BY updated_at ASC;

-- name: UpdateUserCurrency :exec
UPDATE users SET currency = $2, updated_at = NOW() WHERE tg_id = $1;

-- name: UpsertBudget :exec
INSERT INTO budgets (user_id, weekly_limit, monthly_limit)
VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE
SET weekly_limit  = EXCLUDED.weekly_limit,
    monthly_limit = EXCLUDED.monthly_limit;

-- name: UpsertCategory :exec
INSERT INTO categories (id, user_id, name, color, icon, sort_order)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO UPDATE
SET name       = EXCLUDED.name,
    color      = EXCLUDED.color,
    icon       = EXCLUDED.icon,
    sort_order = EXCLUDED.sort_order
WHERE categories.user_id = EXCLUDED.user_id;
