package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/flowmoney/app/pkg/tgauth"
)

type contextKey string

const telegramIDKey contextKey = "telegram_id"

// TelegramAuth validates the Telegram initData signature and injects telegram_id into the request context.
func TelegramAuth(botToken string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" || !strings.HasPrefix(authHeader, "Telegram ") {
				http.Error(w, "bad request: missing or malformed Authorization header", http.StatusBadRequest)
				return
			}

			initData := strings.TrimPrefix(authHeader, "Telegram ")

			_, err := tgauth.VerifyInitData(initData, botToken)
			if err != nil {
				if err == tgauth.ErrInvalidHash {
					http.Error(w, "unauthorized: invalid initData signature", http.StatusUnauthorized)
					return
				}
				http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
				return
			}

			params, err := url.ParseQuery(initData)
			if err != nil {
				http.Error(w, "bad request: cannot parse initData", http.StatusBadRequest)
				return
			}

			userJSON := params.Get("user")
			if userJSON == "" {
				http.Error(w, "bad request: user field missing in initData", http.StatusBadRequest)
				return
			}

			var userPayload struct {
				ID int64 `json:"id"`
			}
			if err := json.Unmarshal([]byte(userJSON), &userPayload); err != nil {
				http.Error(w, "bad request: cannot parse user JSON", http.StatusBadRequest)
				return
			}

			if userPayload.ID == 0 {
				http.Error(w, "bad request: user id is missing", http.StatusBadRequest)
				return
			}

			ctx := context.WithValue(r.Context(), telegramIDKey, userPayload.ID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetTelegramID extracts the telegram_id from the request context.
// Returns the id and true on success, or 0 and false if not present.
func GetTelegramID(ctx context.Context) (int64, bool) {
	id, ok := ctx.Value(telegramIDKey).(int64)
	return id, ok
}
