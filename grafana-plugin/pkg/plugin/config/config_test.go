//go:build ignore

package config_test

import (
	"errors"
	"testing"

	"github.com/1024XEngineer/Torchbearing/grafana-plugin-app/pkg/plugin/config"
)

func TestLoadRuntimeAcceptsHTTPOrigins(t *testing.T) {
	tests := map[string]struct {
		raw  string
		want string
	}{
		"https":             {raw: "https://aicore.internal", want: "https://aicore.internal"},
		"http":              {raw: "http://aicore:8080", want: "http://aicore:8080"},
		"surrounding space": {raw: "  https://aicore.internal/  ", want: "https://aicore.internal"},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			runtime, err := config.LoadRuntime(func(key string) string {
				switch key {
				case config.EnvAICoreURL:
					return test.raw
				case config.EnvAIModelID:
					return "model-1"
				default:
					t.Fatalf("environment key = %q", key)
					return ""
				}
			})
			if err != nil {
				t.Fatalf("LoadRuntime() error = %v", err)
			}
			if runtime.AICoreURL != test.want {
				t.Fatalf("AICoreURL = %q, want %q", runtime.AICoreURL, test.want)
			}
			if runtime.AIModelID != "model-1" {
				t.Fatalf("AIModelID = %q", runtime.AIModelID)
			}
		})
	}
}

func TestLoadRuntimeUsesGrafanaPluginConfigBridge(t *testing.T) {
	if config.EnvAICoreURL != "GF_PLUGIN_AI_CORE_URL" {
		t.Fatalf("EnvAICoreURL = %q", config.EnvAICoreURL)
	}
	if config.EnvAIModelID != "GF_PLUGIN_AI_MODEL_ID" {
		t.Fatalf("EnvAIModelID = %q", config.EnvAIModelID)
	}
}

func TestLoadRuntimeRejectsInvalidOrigins(t *testing.T) {
	origins := map[string]string{
		"empty":        "",
		"relative":     "aicore.internal",
		"missing host": "https://",
		"missing name": "https://:8443",
		"credentials":  "https://user:password@aicore.internal",
		"path":         "https://aicore.internal/api",
		"query":        "https://aicore.internal?target=other",
		"fragment":     "https://aicore.internal#fragment",
		"ftp":          "ftp://aicore.internal",
	}
	for name, origin := range origins {
		t.Run(name, func(t *testing.T) {
			_, err := config.LoadRuntime(func(key string) string {
				if key == config.EnvAICoreURL {
					return origin
				}
				return "model-1"
			})
			if !errors.Is(err, config.ErrInvalidRuntimeConfig) {
				t.Fatalf("LoadRuntime() error = %v", err)
			}
		})
	}
}

func TestLoadRuntimeRejectsInvalidModelID(t *testing.T) {
	for name, modelID := range map[string]string{
		"empty":   "",
		"spaces":  "   ",
		"newline": "model-1\nX-User-Id: forged",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := config.LoadRuntime(func(key string) string {
				if key == config.EnvAICoreURL {
					return "http://aicore:8080"
				}
				return modelID
			})
			if !errors.Is(err, config.ErrInvalidRuntimeConfig) {
				t.Fatalf("LoadRuntime() error = %v", err)
			}
		})
	}
}

func TestLoadRuntimeRejectsNilEnvironmentReader(t *testing.T) {
	_, err := config.LoadRuntime(nil)
	if !errors.Is(err, config.ErrInvalidRuntimeConfig) {
		t.Fatalf("LoadRuntime() error = %v", err)
	}
}
