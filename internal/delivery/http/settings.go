package http

import (
	"encoding/json"
	"net/http"
	"strings"

	repository "github.com/flowmoney/app/internal/repository/postgres"
)

type settingsRequest struct {
	Currency     string  `json:"currency"`
	DailyLimit   float64 `json:"daily_limit"`
	WeeklyLimit  float64 `json:"weekly_limit"`
	MonthlyLimit float64 `json:"monthly_limit"`
}

var validCurrencies = map[string]bool{
	"RUB": true, "GEL": true, "USD": true, "EUR": true,
}

func NewSettingsHandler(q repository.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tgID, ok := GetTelegramID(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		var req settingsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request: invalid JSON", http.StatusBadRequest)
			return
		}

		req.Currency = strings.ToUpper(strings.TrimSpace(req.Currency))
		if req.Currency != "" && !validCurrencies[req.Currency] {
			http.Error(w, "bad request: unsupported currency", http.StatusBadRequest)
			return
		}

		if req.Currency != "" {
			if err := q.UpdateUserCurrency(r.Context(), repository.UpdateUserCurrencyParams{
				TgID:     tgID,
				Currency: req.Currency,
			}); err != nil {
				http.Error(w, "internal server error", http.StatusInternalServerError)
				return
			}
		}

		if err := q.UpsertBudget(r.Context(), repository.UpsertBudgetParams{
			UserID:       tgID,
			DailyLimit:   float64ToNumeric(req.DailyLimit),
			WeeklyLimit:  float64ToNumeric(req.WeeklyLimit),
			MonthlyLimit: float64ToNumeric(req.MonthlyLimit),
		}); err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	}
}
