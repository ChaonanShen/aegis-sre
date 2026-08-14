package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	EnvHTTPAddress     = "AEGIS_HTTP_ADDRESS"
	EnvShutdownTimeout = "AEGIS_SHUTDOWN_TIMEOUT"
	EnvAgentURL        = "AEGIS_AGENT_URL"
	EnvDaguURL         = "AEGIS_DAGU_URL"
	EnvDaguTokenFile   = "AEGIS_DAGU_TOKEN_FILE"
	EnvDaguBasicUser   = "AEGIS_DAGU_BASIC_AUTH_USERNAME"
	EnvDaguBasicPass   = "AEGIS_DAGU_BASIC_AUTH_PASSWORD_FILE"
	EnvRAGFlowURL      = "AEGIS_RAGFLOW_URL"
	EnvGrafanaMCPURL   = "AEGIS_GRAFANA_MCP_URL"
	EnvPluginTokenFile = "AEGIS_PLUGIN_TOKEN_FILE"
)

var ErrInvalid = errors.New("invalid configuration")

type Capability string

const (
	CapabilityAgent      Capability = "agent"
	CapabilityPlaybook   Capability = "playbook"
	CapabilityKnowledge  Capability = "knowledge"
	CapabilityGrafanaMCP Capability = "grafana_mcp"
)

type Config struct {
	HTTPAddress     string
	ShutdownTimeout time.Duration
	Endpoints       map[Capability]string
	PluginToken     string
	DaguTokenFile   string
	DaguBasicUser   string
	DaguBasicPass   string
}

func Load(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, fmt.Errorf("%w: environment reader is required", ErrInvalid)
	}

	address := strings.TrimSpace(getenv(EnvHTTPAddress))
	if address == "" {
		address = ":8080"
	}
	if _, err := net.ResolveTCPAddr("tcp", address); err != nil {
		return Config{}, fmt.Errorf("%w: %s must be a TCP address", ErrInvalid, EnvHTTPAddress)
	}

	shutdownTimeout := 10 * time.Second
	if raw := strings.TrimSpace(getenv(EnvShutdownTimeout)); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("%w: %s must be a positive duration", ErrInvalid, EnvShutdownTimeout)
		}
		shutdownTimeout = parsed
	}

	endpoints := make(map[Capability]string)
	for capability, envName := range map[Capability]string{
		CapabilityAgent:      EnvAgentURL,
		CapabilityPlaybook:   EnvDaguURL,
		CapabilityKnowledge:  EnvRAGFlowURL,
		CapabilityGrafanaMCP: EnvGrafanaMCPURL,
	} {
		raw := strings.TrimSpace(getenv(envName))
		if raw == "" {
			continue
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return Config{}, fmt.Errorf("%w: %s must be an HTTP origin", ErrInvalid, envName)
		}
		endpoints[capability] = raw
	}

	pluginToken := ""
	if tokenFile := strings.TrimSpace(getenv(EnvPluginTokenFile)); tokenFile != "" {
		content, err := os.ReadFile(tokenFile)
		if err != nil {
			return Config{}, fmt.Errorf("%w: read %s: %v", ErrInvalid, EnvPluginTokenFile, err)
		}
		pluginToken = strings.TrimSpace(string(content))
		if pluginToken == "" || strings.ContainsAny(pluginToken, "\r\n\x00") {
			return Config{}, fmt.Errorf("%w: %s content is invalid", ErrInvalid, EnvPluginTokenFile)
		}
	}

	daguTokenFile := strings.TrimSpace(getenv(EnvDaguTokenFile))
	if daguTokenFile != "" {
		info, err := os.Stat(daguTokenFile)
		if err != nil || !info.Mode().IsRegular() {
			return Config{}, fmt.Errorf("%w: %s must point to a readable regular file", ErrInvalid, EnvDaguTokenFile)
		}
	}
	daguBasicUser := strings.TrimSpace(getenv(EnvDaguBasicUser))
	daguBasicPass := strings.TrimSpace(getenv(EnvDaguBasicPass))
	if (daguBasicUser == "") != (daguBasicPass == "") {
		return Config{}, fmt.Errorf("%w: %s and %s must be configured together", ErrInvalid, EnvDaguBasicUser, EnvDaguBasicPass)
	}
	if daguTokenFile != "" && daguBasicPass != "" {
		return Config{}, fmt.Errorf("%w: Dagu bearer and basic authentication are mutually exclusive", ErrInvalid)
	}
	if daguBasicUser != "" {
		if strings.ContainsAny(daguBasicUser, "\r\n\x00") {
			return Config{}, fmt.Errorf("%w: %s is invalid", ErrInvalid, EnvDaguBasicUser)
		}
		info, err := os.Stat(daguBasicPass)
		if err != nil || !info.Mode().IsRegular() {
			return Config{}, fmt.Errorf("%w: %s must point to a readable regular file", ErrInvalid, EnvDaguBasicPass)
		}
	}

	return Config{HTTPAddress: address, ShutdownTimeout: shutdownTimeout, Endpoints: endpoints, PluginToken: pluginToken, DaguTokenFile: daguTokenFile, DaguBasicUser: daguBasicUser, DaguBasicPass: daguBasicPass}, nil
}
