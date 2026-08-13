package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

const (
	EnvHTTPAddress     = "AEGIS_HTTP_ADDRESS"
	EnvShutdownTimeout = "AEGIS_SHUTDOWN_TIMEOUT"
	EnvDatabaseURL     = "AEGIS_DATABASE_URL"
	EnvAgentURL        = "AEGIS_AGENT_URL"
	EnvDaguURL         = "AEGIS_DAGU_URL"
	EnvRAGFlowURL      = "AEGIS_RAGFLOW_URL"
	EnvGrafanaMCPURL   = "AEGIS_GRAFANA_MCP_URL"
)

var ErrInvalid = errors.New("invalid configuration")

type Capability string

const (
	CapabilityDatabase   Capability = "database"
	CapabilityAgent      Capability = "agent"
	CapabilityPlaybook   Capability = "playbook"
	CapabilityKnowledge  Capability = "knowledge"
	CapabilityGrafanaMCP Capability = "grafana_mcp"
)

type Config struct {
	HTTPAddress     string
	ShutdownTimeout time.Duration
	Endpoints       map[Capability]string
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
		CapabilityDatabase:   EnvDatabaseURL,
		CapabilityAgent:      EnvAgentURL,
		CapabilityPlaybook:   EnvDaguURL,
		CapabilityKnowledge:  EnvRAGFlowURL,
		CapabilityGrafanaMCP: EnvGrafanaMCPURL,
	} {
		raw := strings.TrimSpace(getenv(envName))
		if raw == "" {
			continue
		}
		if capability != CapabilityDatabase {
			parsed, err := url.Parse(raw)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return Config{}, fmt.Errorf("%w: %s must be an HTTP origin", ErrInvalid, envName)
			}
		}
		endpoints[capability] = raw
	}

	return Config{HTTPAddress: address, ShutdownTimeout: shutdownTimeout, Endpoints: endpoints}, nil
}
