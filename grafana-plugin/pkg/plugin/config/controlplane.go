package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

const (
	EnvControlPlaneURL       = "GF_PLUGIN_CONTROL_PLANE_URL"
	EnvControlPlaneTokenFile = "GF_PLUGIN_CONTROL_PLANE_TOKEN_FILE"
)

var ErrInvalidControlPlane = errors.New("invalid Control Plane configuration")

type ControlPlane struct {
	URL         *url.URL
	BearerToken string
}

func LoadControlPlane(getenv func(string) string, readFile func(string) ([]byte, error)) (ControlPlane, error) {
	if getenv == nil || readFile == nil {
		return ControlPlane{}, ErrInvalidControlPlane
	}
	parsed, err := url.Parse(strings.TrimSpace(getenv(EnvControlPlaneURL)))
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ControlPlane{}, fmt.Errorf("%w: %s must be an HTTP origin", ErrInvalidControlPlane, EnvControlPlaneURL)
	}
	parsed.Path = ""

	token := ""
	if tokenFile := strings.TrimSpace(getenv(EnvControlPlaneTokenFile)); tokenFile != "" {
		content, err := readFile(tokenFile)
		if err != nil {
			return ControlPlane{}, fmt.Errorf("%w: read token file: %v", ErrInvalidControlPlane, err)
		}
		token = strings.TrimSpace(string(content))
		if token == "" || strings.ContainsAny(token, "\r\n\x00") {
			return ControlPlane{}, fmt.Errorf("%w: token file is empty or invalid", ErrInvalidControlPlane)
		}
	}
	return ControlPlane{URL: parsed, BearerToken: token}, nil
}

func LoadControlPlaneFromEnvironment() (ControlPlane, error) {
	return LoadControlPlane(os.Getenv, os.ReadFile)
}
