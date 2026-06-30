package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flowmoney/app/internal/config"
	deliveryhttp "github.com/flowmoney/app/internal/delivery/http"
	repository "github.com/flowmoney/app/internal/repository/postgres"
	"github.com/flowmoney/app/internal/service"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// App-level context — cancelled on graceful shutdown to stop background goroutines.
	appCtx, appCancel := context.WithCancel(context.Background())
	defer appCancel()

	dbCtx, dbCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dbCancel()

	pool, err := pgxpool.New(dbCtx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("failed to create db pool: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(dbCtx); err != nil {
		log.Fatalf("failed to ping database: %v", err)
	}
	log.Println("database connection established")

	// ONE-SHOT CLEANUP: remove legacy system/shared categories; revert after deploy
	if _, err := pool.Exec(dbCtx, `DELETE FROM categories WHERE user_id = 0 OR is_system = true`); err != nil {
		log.Printf("startup cleanup warning: %v", err)
	} else {
		log.Println("startup cleanup: stale system categories removed")
	}

	queries := repository.New(pool)

	rm := service.NewRatesManager()
	rm.Start(appCtx)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"status":"ok"}`)
	})

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(deliveryhttp.TelegramAuth(cfg.BotToken))
		r.Get("/bootstrap", deliveryhttp.NewBootstrapHandler(queries, rm))
		r.Post("/sync", deliveryhttp.NewSyncHandler(pool))
		r.Put("/settings", deliveryhttp.NewSettingsHandler(queries))
		r.Get("/analytics/donut", deliveryhttp.NewGetAnalyticsDonutHandler(queries))
		r.Get("/analytics/timeline", deliveryhttp.NewGetTimelineHandler(queries))
	})

	// Раздаём SPA из ./frontend/; все неизвестные пути отдают index.html
	frontendDir := http.Dir("./frontend")
	fileServer := http.FileServer(frontendDir)
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		// Если файл существует — отдаём его; иначе отдаём index.html для SPA-роутинга
		path := r.URL.Path
		if path != "/" {
			f, err := frontendDir.Open(path)
			if err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("server listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-quit
	log.Println("shutting down...")
	appCancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("server stopped")
}
