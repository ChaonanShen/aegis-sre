package config

import (
	"errors"
	"testing"
)

func TestLoadControlPlane(t *testing.T) {
	values := map[string]string{
		EnvControlPlaneURL:       "https://control-plane.internal/",
		EnvControlPlaneTokenFile: "/run/secrets/control-plane-token",
	}
	config, err := LoadControlPlane(func(key string) string { return values[key] }, func(path string) ([]byte, error) {
		if path != values[EnvControlPlaneTokenFile] {
			t.Fatalf("read unexpected path %q", path)
		}
		return []byte("secret-token\n"), nil
	})
	if err != nil {
		t.Fatalf("LoadControlPlane() error = %v", err)
	}
	if config.URL.String() != "https://control-plane.internal" || config.BearerToken != "secret-token" {
		t.Fatalf("unexpected config: %+v", config)
	}
}

func TestLoadControlPlaneRejectsUnsafeConfiguration(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"missing URL":        {},
		"credentials in URL": {EnvControlPlaneURL: "https://user:pass@control-plane.internal"},
		"path in URL":        {EnvControlPlaneURL: "https://control-plane.internal/api"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := LoadControlPlane(func(key string) string { return values[key] }, func(string) ([]byte, error) { return nil, nil })
			if !errors.Is(err, ErrInvalidControlPlane) {
				t.Fatalf("error = %v, want ErrInvalidControlPlane", err)
			}
		})
	}
}
