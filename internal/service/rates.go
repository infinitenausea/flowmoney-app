package service

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

var supportedCurrencies = []string{"USD", "RUB", "GEL", "EUR"}

// RatesManager держит курсы валют относительно USD в памяти и обновляет их каждые 12 часов.
type RatesManager struct {
	mu    sync.RWMutex
	rates map[string]float64
}

// NewRatesManager возвращает экземпляр со встроенными fallback-курсами.
// Реальные курсы загрузятся при вызове Start.
func NewRatesManager() *RatesManager {
	return &RatesManager{
		rates: map[string]float64{
			"USD": 1.0,
			"RUB": 93.50,
			"GEL": 2.72,
			"EUR": 0.92,
		},
	}
}

// Start выполняет первую загрузку курсов и запускает фоновое обновление каждые 12 часов.
// Останавливается при отмене ctx.
func (rm *RatesManager) Start(ctx context.Context) {
	rm.fetch()
	go func() {
		ticker := time.NewTicker(12 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				rm.fetch()
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Rates возвращает копию текущей карты курсов (потокобезопасно).
func (rm *RatesManager) Rates() map[string]float64 {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	out := make(map[string]float64, len(rm.rates))
	for k, v := range rm.rates {
		out[k] = v
	}
	return out
}

type erAPIResponse struct {
	Result string             `json:"result"`
	Rates  map[string]float64 `json:"rates"`
}

func (rm *RatesManager) fetch() {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://open.er-api.com/v6/latest/USD")
	if err != nil {
		log.Printf("[RATES WARN] Failed to fetch actual rates from external API: %v. Retaining last known or fallback rates.", err)
		return
	}
	defer resp.Body.Close()

	var data erAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		log.Printf("[RATES WARN] Failed to fetch actual rates from external API: %v. Retaining last known or fallback rates.", err)
		return
	}

	if data.Result != "success" {
		log.Printf("[RATES WARN] Failed to fetch actual rates from external API: unexpected result field %q. Retaining last known or fallback rates.", data.Result)
		return
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()
	for _, code := range supportedCurrencies {
		if v, ok := data.Rates[code]; ok {
			rm.rates[code] = v
		}
	}
	log.Printf("[RatesManager] rates refreshed: %v", rm.rates)
}
