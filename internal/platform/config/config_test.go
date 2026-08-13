package config

import (
	"errors"
	"testing"
	"time"
)

func TestLoadDefaultsWithoutProviders(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.HTTPAddress != ":8080" || cfg.ShutdownTimeout != 10*time.Second {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if len(cfg.Endpoints) != 0 {
		t.Fatalf("providers must remain optional: %+v", cfg.Endpoints)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	tests := map[string]map[string]string{
		"address":  {EnvHTTPAddress: "bad address"},
		"timeout":  {EnvShutdownTimeout: "0s"},
		"endpoint": {EnvAgentURL: "file:///tmp/agent.sock"},
	}
	for name, values := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := Load(func(key string) string { return values[key] })
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("Load() error = %v, want ErrInvalid", err)
			}
		})
	}
}
