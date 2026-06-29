-- name: UpsertUser :one
INSERT INTO users (tg_id, currency, created_at, updated_at)
VALUES ($1, $2, NOW(), NOW())
ON CONFLICT (tg_id) DO UPDATE
    SET updated_at = NOW()
RETURNING tg_id, currency, created_at, updated_at;

-- name: GetBudgetsByUserId :one
SELECT user_id, daily_limit, weekly_limit, monthly_limit
FROM budgets
WHERE user_id = $1;

-- name: GetCategoriesByUserId :many
SELECT id, user_id, name, color, icon, is_system, sort_order
FROM categories
WHERE user_id = $1 OR is_system = true
ORDER BY sort_order ASC;
