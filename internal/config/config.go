package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	Port       string
	BotToken   string
	DatabaseURL string
	DB         DBConfig
}

type DBConfig struct {
	Host     string
	Port     int
	User     string
	Password string
	Name     string
	SSLMode  string
}

func Load() (*Config, error) {
	dbPort, err := strconv.Atoi(getEnv("DB_PORT", "5432"))
	if err != nil {
		return nil, fmt.Errorf("invalid DB_PORT: %w", err)
	}

	db := DBConfig{
		Host:     getEnv("DB_HOST", "localhost"),
		Port:     dbPort,
		User:     mustEnv("DB_USER"),
		Password: mustEnv("DB_PASSWORD"),
		Name:     mustEnv("DB_NAME"),
		SSLMode:  getEnv("DB_SSLMODE", "disable"),
	}

	return &Config{
		Port:        getEnv("PORT", "8080"),
		BotToken:    mustEnv("TELEGRAM_BOT_TOKEN"),
		DatabaseURL: fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s", db.User, db.Password, db.Host, db.Port, db.Name, db.SSLMode),
		DB:          db,
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required environment variable %q is not set", key))
	}
	return v
}
