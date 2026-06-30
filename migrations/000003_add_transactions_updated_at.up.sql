ALTER TABLE transactions
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- backfill: treat created_at as updated_at for existing rows
UPDATE transactions SET updated_at = created_at;

CREATE INDEX idx_transactions_user_updated_at
    ON transactions(user_id, updated_at ASC);
