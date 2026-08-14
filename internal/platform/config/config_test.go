package config

import (
	"errors"
	"os"
	"path/filepath"
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

func TestLoadKeepsDaguTokenAsRotatingFileReference(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dagu-token")
	if err := os.WriteFile(path, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(func(key string) string {
		if key == EnvDaguTokenFile {
			return path
		}
		return ""
	})
	if err != nil || cfg.DaguTokenFile != path {
		t.Fatalf("config = %+v, err = %v", cfg, err)
	}
}

func TestLoadAcceptsDaguBasicAuthPasswordFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dagu-password")
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case EnvDaguBasicUser:
			return "aegis-control-plane"
		case EnvDaguBasicPass:
			return path
		default:
			return ""
		}
	})
	if err != nil || cfg.DaguBasicUser != "aegis-control-plane" || cfg.DaguBasicPass != path {
		t.Fatalf("config = %+v, err = %v", cfg, err)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	tests := map[string]map[string]string{
		"address":            {EnvHTTPAddress: "bad address"},
		"timeout":            {EnvShutdownTimeout: "0s"},
		"endpoint":           {EnvAgentURL: "file:///tmp/agent.sock"},
		"partial basic auth": {EnvDaguBasicUser: "aegis"},
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
