-- Seed a system user (tg_id = 0) as the owner of shared system categories.
-- Real Telegram user IDs are always positive, so 0 is a safe sentinel value.
INSERT INTO users (tg_id, currency, created_at, updated_at)
VALUES (0, 'USD', NOW(), NOW())
ON CONFLICT (tg_id) DO NOTHING;

-- Seed default system categories with stable, well-known UUIDs.
-- The GetCategoriesByUserId query already returns rows WHERE is_system = true
-- for every user, so these categories appear in every user's carousel.
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
