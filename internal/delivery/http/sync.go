package http

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	repository "github.com/flowmoney/app/internal/repository/postgres"
)

type syncTransaction struct {
	ID         string    `json:"id"`
	CategoryID string    `json:"category_id"`
	Amount     float64   `json:"amount"`
	CreatedAt  time.Time `json:"created_at"`
	IsDeleted  bool      `json:"is_deleted"`
}

func NewSyncHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tgID, ok := GetTelegramID(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB cap

		type syncRequest struct {
			Transactions []syncTransaction `json:"transactions"`
		}
		var req syncRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			if err.Error() == "http: request body too large" {
				http.Error(w, "request body too large", http.StatusBadRequest)
				return
			}
			http.Error(w, "bad request: invalid JSON", http.StatusBadRequest)
			return
		}

		tx, err := pool.BeginTx(r.Context(), pgx.TxOptions{})
		if err != nil {
			log.Printf("SYNC ERROR: begin tx: %v", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		qtx := repository.New(tx)

		for _, t := range req.Transactions {
			id, err := stringToUUID(t.ID)
			if err != nil {
				tx.Rollback(r.Context())
				http.Error(w, "bad request: invalid transaction id", http.StatusBadRequest)
				return
			}

			categoryID, err := stringToUUID(t.CategoryID)
			if err != nil {
				tx.Rollback(r.Context())
				http.Error(w, "bad request: invalid category_id", http.StatusBadRequest)
				return
			}

			err = qtx.UpsertTransaction(r.Context(), repository.UpsertTransactionParams{
				ID:         id,
				UserID:     tgID,
				CategoryID: categoryID,
				Amount:     float64ToNumeric(t.Amount),
				CreatedAt:  pgtype.Timestamptz{Time: t.CreatedAt, Valid: true},
				IsDeleted:  t.IsDeleted,
			})
			if err != nil {
				log.Printf("SYNC ERROR: upsert tx %s: %v", t.ID, err)
				tx.Rollback(r.Context())
				http.Error(w, "internal server error", http.StatusInternalServerError)
				return
			}
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Printf("SYNC ERROR: commit: %v", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	}
}

func stringToUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	err := u.Scan(s)
	return u, err
}

func float64ToNumeric(f float64) pgtype.Numeric {
	var n pgtype.Numeric
	_ = n.Scan(strconv.FormatFloat(f, 'f', -1, 64))
	return n
}
