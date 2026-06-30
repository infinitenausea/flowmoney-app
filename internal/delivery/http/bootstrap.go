package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	repository "github.com/flowmoney/app/internal/repository/postgres"
	"github.com/flowmoney/app/internal/service"
)

type categoryResponse struct {
	ID        string `json:"id"`
	UserID    int64  `json:"user_id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	Icon      string `json:"icon"`
	IsSystem  bool   `json:"is_system"`
	SortOrder int32  `json:"sort_order"`
}

type budgetResponse struct {
	WeeklyLimit  float64 `json:"weekly_limit"`
	MonthlyLimit float64 `json:"monthly_limit"`
}

type bootstrapResponse struct {
	Currency   string             `json:"currency"`
	Budget     budgetResponse     `json:"budget"`
	Categories []categoryResponse `json:"categories"`
	Rates      map[string]float64 `json:"rates"`
}

func NewBootstrapHandler(q repository.Querier, rm *service.RatesManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tgID, ok := GetTelegramID(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		user, err := q.UpsertUser(r.Context(), repository.UpsertUserParams{
			TgID:     tgID,
			Currency: "USD",
		})
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		budget, err := q.GetBudgetsByUserId(r.Context(), tgID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		categories, err := q.GetCategoriesByUserId(r.Context(), tgID)
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		catResp := make([]categoryResponse, 0, len(categories))
		for _, c := range categories {
			catResp = append(catResp, categoryResponse{
				ID:        uuidToString(c.ID),
				UserID:    c.UserID,
				Name:      c.Name,
				Color:     c.Color,
				Icon:      c.Icon,
				IsSystem:  c.IsSystem,
				SortOrder: c.SortOrder,
			})
		}

		resp := bootstrapResponse{
			Currency: user.Currency,
			Budget: budgetResponse{
				WeeklyLimit:  numericToFloat64(budget.WeeklyLimit),
				MonthlyLimit: numericToFloat64(budget.MonthlyLimit),
			},
			Categories: catResp,
			Rates:      rm.Rates(),
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

func uuidToString(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	b := u.Bytes
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func numericToFloat64(n pgtype.Numeric) float64 {
	if !n.Valid {
		return 0
	}
	f, err := n.Float64Value()
	if err != nil || !f.Valid {
		return 0
	}
	return f.Float64
}
