package tgauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/url"
	"sort"
	"strings"
)

var (
	ErrMissingHash  = errors.New("tgauth: hash field is missing from initData")
	ErrInvalidHash  = errors.New("tgauth: hash mismatch — initData is invalid or tampered")
)

// VerifyInitData validates the Telegram Mini App initData string using HMAC-SHA256.
// It returns true when the signature is valid, false (with ErrInvalidHash) when it is not.
// Any other error indicates a malformed input string.
func VerifyInitData(initDataRaw string, botToken string) (bool, error) {
	params, err := url.ParseQuery(initDataRaw)
	if err != nil {
		return false, err
	}

	receivedHash := params.Get("hash")
	if receivedHash == "" {
		return false, ErrMissingHash
	}

	// Build sorted key=value pairs, excluding "hash"
	pairs := make([]string, 0, len(params))
	for key, values := range params {
		if key == "hash" {
			continue
		}
		pairs = append(pairs, key+"="+values[0])
	}
	sort.Strings(pairs)
	dataCheckString := strings.Join(pairs, "\n")

	// secret_key = HMAC-SHA256("WebAppData", botToken)
	mac := hmac.New(sha256.New, []byte("WebAppData"))
	mac.Write([]byte(botToken))
	secretKey := mac.Sum(nil)

	// signature = HMAC-SHA256(dataCheckString, secretKey)
	sig := hmac.New(sha256.New, secretKey)
	sig.Write([]byte(dataCheckString))
	expectedHash := hex.EncodeToString(sig.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(expectedHash), []byte(receivedHash)) != 1 {
		return false, ErrInvalidHash
	}

	return true, nil
}
