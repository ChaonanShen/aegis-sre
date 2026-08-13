//go:build ignore

package config

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

const (
	EnvAICoreURL = "GF_PLUGIN_AI_CORE_URL"
	EnvAIModelID = "GF_PLUGIN_AI_MODEL_ID"
)

var ErrInvalidRuntimeConfig = errors.New("invalid plugin runtime configuration")

// Runtime contains server-owned plugin backend configuration.
type Runtime struct {
	AICoreURL string
	// AIModelID 是 Workbench Chat 固定使用的模型连接 ID，不是模型凭据。
	AIModelID string
}

// LoadRuntime reads and validates the AI Core HTTP origin.
func LoadRuntime(getenv func(string) string) (Runtime, error) {
	if getenv == nil {
		return Runtime{}, ErrInvalidRuntimeConfig
	}
	aiCoreURL, err := parseOrigin(getenv(EnvAICoreURL))
	if err != nil {
		return Runtime{}, err
	}
	aiModelID, err := requiredValue(getenv(EnvAIModelID), "AI model ID")
	if err != nil {
		return Runtime{}, err
	}
	return Runtime{AICoreURL: aiCoreURL, AIModelID: aiModelID}, nil
}

func requiredValue(raw, name string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("%w: %s is required", ErrInvalidRuntimeConfig, name)
	}
	return value, nil
}

func parseOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.Hostname() == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%w: AI Core URL must be an HTTP origin", ErrInvalidRuntimeConfig)
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return "", fmt.Errorf("%w: AI Core URL must be an HTTP origin", ErrInvalidRuntimeConfig)
	}
	parsed.Path = ""
	return parsed.String(), nil
}
