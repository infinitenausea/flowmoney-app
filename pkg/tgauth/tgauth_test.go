package tgauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strings"
	"testing"
)

const testBotToken = "7415063038:AAHDuRExQp1vTkBs0FgBr2Mrph6a0L5Bk4Y"

// buildInitData constructs a signed initData string from the given fields,
// simulating what the Telegram client sends to the Mini App.
func buildInitData(botToken string, fields map[string]string) string {
	pairs := make([]string, 0, len(fields))
	for k, v := range fields {
		pairs = append(pairs, k+"="+v)
	}
	sort.Strings(pairs)
	dataCheckString := strings.Join(pairs, "\n")

	mac := hmac.New(sha256.New, []byte("WebAppData"))
	mac.Write([]byte(botToken))
	secretKey := mac.Sum(nil)

	sig := hmac.New(sha256.New, secretKey)
	sig.Write([]byte(dataCheckString))
	hash := hex.EncodeToString(sig.Sum(nil))

	params := url.Values{}
	for k, v := range fields {
		params.Set(k, v)
	}
	params.Set("hash", hash)
	return params.Encode()
}

func TestVerifyInitData_Valid(t *testing.T) {
	fields := map[string]string{
		"auth_date": "1719619200",
		"user":      `{"id":123456789,"first_name":"Alice","language_code":"en"}`,
		"query_id":  "AAHdF6IQAAAAAN0XohDhrOrc",
	}
	initData := buildInitData(testBotToken, fields)

	ok, err := VerifyInitData(initData, testBotToken)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if !ok {
		t.Fatal("expected valid initData to return true")
	}
}

func TestVerifyInitData_WrongToken(t *testing.T) {
	fields := map[string]string{
		"auth_date": "1719619200",
		"user":      `{"id":123456789,"first_name":"Alice"}`,
	}
	initData := buildInitData(testBotToken, fields)

	ok, err := VerifyInitData(initData, "wrong_token")
	if err != ErrInvalidHash {
		t.Fatalf("expected ErrInvalidHash, got: %v", err)
	}
	if ok {
		t.Fatal("expected false for wrong token")
	}
}

func TestVerifyInitData_TamperedData(t *testing.T) {
	fields := map[string]string{
		"auth_date": "1719619200",
		"user":      `{"id":123456789,"first_name":"Alice"}`,
	}
	initData := buildInitData(testBotToken, fields)

	// Tamper: change auth_date after signing
	params, _ := url.ParseQuery(initData)
	params.Set("auth_date", "9999999999")
	tampered := params.Encode()

	ok, err := VerifyInitData(tampered, testBotToken)
	if err != ErrInvalidHash {
		t.Fatalf("expected ErrInvalidHash, got: %v", err)
	}
	if ok {
		t.Fatal("expected false for tampered data")
	}
}

func TestVerifyInitData_MissingHash(t *testing.T) {
	params := url.Values{}
	params.Set("auth_date", "1719619200")
	params.Set("user", `{"id":1}`)

	ok, err := VerifyInitData(params.Encode(), testBotToken)
	if err != ErrMissingHash {
		t.Fatalf("expected ErrMissingHash, got: %v", err)
	}
	if ok {
		t.Fatal("expected false when hash is missing")
	}
}

func TestVerifyInitData_MalformedInput(t *testing.T) {
	// percent-encoding error
	ok, err := VerifyInitData("key=%GG", testBotToken)
	if err == nil {
		t.Fatal("expected parse error for malformed input")
	}
	if ok {
		t.Fatal("expected false for malformed input")
	}
}
