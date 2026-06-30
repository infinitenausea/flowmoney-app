package http

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	repository "github.com/flowmoney/app/internal/repository/postgres"
)

type donutItem struct {
	CategoryID string  `json:"category_id"`
	Total      float64 `json:"total"`
}

type timelineItem struct {
	ID         string    `json:"id"`
	CategoryID string    `json:"category_id"`
	Amount     float64   `json:"amount"`
	CreatedAt  time.Time `json:"created_at"`
	IsDeleted  bool      `json:"is_deleted"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type timelineResponse struct {
	Items      []timelineItem `json:"items"`
	NextCursor *string        `json:"next_cursor"`
}

type deltaItem struct {
	ID         string    `json:"id"`
	CategoryID string    `json:"category_id"`
	Amount     float64   `json:"amount"`
	CreatedAt  time.Time `json:"created_at"`
	IsDeleted  bool      `json:"is_deleted"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type deltaResponse struct {
	Items []deltaItem `json:"items"`
}

func NewGetAnalyticsDonutHandler(q repository.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tgID, ok := GetTelegramID(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		rows, err := q.GetAnalyticsDonut(r.Context(), tgID)
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		result := make([]donutItem, 0, len(rows))
		for _, row := range rows {
			result = append(result, donutItem{
				CategoryID: uuidToString(row.CategoryID),
				Total:      numericToFloat64(row.Total),
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

func NewGetTimelineHandler(q repository.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tgID, ok := GetTelegramID(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Delta sync: ?since=<RFC3339> returns only changed records including deletions.
		if raw := r.URL.Query().Get("since"); raw != "" {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				http.Error(w, "bad request: since must be RFC3339", http.StatusBadRequest)
				return
			}

			rows, err := q.GetTransactionsDelta(r.Context(), repository.GetTransactionsDeltaParams{
				UserID:    tgID,
				UpdatedAt: pgtype.Timestamptz{Time: t, Valid: true},
			})
			if err != nil {
				http.Error(w, "internal server error", http.StatusInternalServerError)
				return
			}

			items := make([]deltaItem, 0, len(rows))
			for _, row := range rows {
				items = append(items, deltaItem{
					ID:         uuidToString(row.ID),
					CategoryID: uuidToString(row.CategoryID),
					Amount:     numericToFloat64(row.Amount),
					CreatedAt:  row.CreatedAt.Time,
					IsDeleted:  row.IsDeleted,
					UpdatedAt:  row.UpdatedAt.Time,
				})
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(deltaResponse{Items: items})
			return
		}

		// Standard cursor-based timeline (initial load, no deletions included).
		var cursor pgtype.Timestamptz
		if raw := r.URL.Query().Get("cursor"); raw != "" {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				http.Error(w, "bad request: cursor must be RFC3339", http.StatusBadRequest)
				return
			}
			cursor = pgtype.Timestamptz{Time: t, Valid: true}
		}

		limit := int32(20)
		if raw := r.URL.Query().Get("limit"); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n <= 0 || n > 200 {
				http.Error(w, "bad request: limit must be 1–200", http.StatusBadRequest)
				return
			}
			limit = int32(n)
		}

		rows, err := q.GetTimelineWithCursor(r.Context(), repository.GetTimelineWithCursorParams{
			UserID:  tgID,
			Column2: cursor,
			Limit:   limit,
		})
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		items := make([]timelineItem, 0, len(rows))
		for _, row := range rows {
			items = append(items, timelineItem{
				ID:         uuidToString(row.ID),
				CategoryID: uuidToString(row.CategoryID),
				Amount:     numericToFloat64(row.Amount),
				CreatedAt:  row.CreatedAt.Time,
				IsDeleted:  row.IsDeleted,
				UpdatedAt:  row.UpdatedAt.Time,
			})
		}

		var nextCursor *string
		if len(items) > 0 {
			oldest := items[len(items)-1].CreatedAt.UTC().Format(time.RFC3339Nano)
			nextCursor = &oldest
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(timelineResponse{
			Items:      items,
			NextCursor: nextCursor,
		})
	}
}
