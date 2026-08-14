package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	EnvHTTPAddress          = "AEGIS_HTTP_ADDRESS"
	EnvShutdownTimeout      = "AEGIS_SHUTDOWN_TIMEOUT"
	EnvAgentProvider        = "AEGIS_AGENT_PROVIDER"
	EnvAgentURL             = "AEGIS_AGENT_URL"
	EnvAgentTenantID        = "AEGIS_AGENT_TENANT_ID"
	EnvAgentOrgID           = "AEGIS_AGENT_ORG_ID"
	EnvAgentUserID          = "AEGIS_AGENT_USER_ID"
	EnvAgentIDKeyFile       = "AEGIS_AGENT_ID_KEY_FILE"
	EnvAgentWorkDir         = "AEGIS_AGENT_WORKING_DIRECTORY"
	EnvCodexCommand         = "AEGIS_CODEX_COMMAND"
	EnvCodexInitTimeout     = "AEGIS_CODEX_INITIALIZE_TIMEOUT"
	EnvOpenCodeUsername     = "AEGIS_OPENCODE_USERNAME"
	EnvOpenCodePasswordFile = "AEGIS_OPENCODE_PASSWORD_FILE"
	EnvDaguURL              = "AEGIS_DAGU_URL"
	EnvDaguTokenFile        = "AEGIS_DAGU_TOKEN_FILE"
	EnvDaguBasicUser        = "AEGIS_DAGU_BASIC_AUTH_USERNAME"
	EnvDaguBasicPass        = "AEGIS_DAGU_BASIC_AUTH_PASSWORD_FILE"
	EnvRAGFlowURL           = "AEGIS_RAGFLOW_URL"
	EnvGrafanaMCPURL        = "AEGIS_GRAFANA_MCP_URL"
	EnvPluginTokenFile      = "AEGIS_PLUGIN_TOKEN_FILE"
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
	HTTPAddress          string
	ShutdownTimeout      time.Duration
	Endpoints            map[Capability]string
	PluginToken          string
	DaguTokenFile        string
	DaguBasicUser        string
	DaguBasicPass        string
	AgentProvider        string
	AgentTenantID        string
	AgentOrgID           string
	AgentUserID          string
	AgentIDKeyFile       string
	AgentWorkDir         string
	CodexCommand         string
	CodexInitTimeout     time.Duration
	OpenCodeUsername     string
	OpenCodePasswordFile string
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

	agentProvider := strings.ToLower(strings.TrimSpace(getenv(EnvAgentProvider)))
	if agentProvider != "" && agentProvider != "codex" && agentProvider != "opencode" {
		return Config{}, fmt.Errorf("%w: %s must be codex or opencode", ErrInvalid, EnvAgentProvider)
	}
	agentTenantID := strings.TrimSpace(getenv(EnvAgentTenantID))
	agentOrgID := strings.TrimSpace(getenv(EnvAgentOrgID))
	agentUserID := strings.TrimSpace(getenv(EnvAgentUserID))
	agentIDKeyFile := strings.TrimSpace(getenv(EnvAgentIDKeyFile))
	agentWorkDir := strings.TrimSpace(getenv(EnvAgentWorkDir))
	codexCommand := strings.TrimSpace(getenv(EnvCodexCommand))
	if codexCommand == "" {
		codexCommand = "codex"
	}
	codexInitTimeout := 15 * time.Second
	if raw := strings.TrimSpace(getenv(EnvCodexInitTimeout)); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("%w: %s must be a positive duration", ErrInvalid, EnvCodexInitTimeout)
		}
		codexInitTimeout = parsed
	}
	openCodeUsername := strings.TrimSpace(getenv(EnvOpenCodeUsername))
	if openCodeUsername == "" {
		openCodeUsername = "opencode"
	}
	openCodePasswordFile := strings.TrimSpace(getenv(EnvOpenCodePasswordFile))
	if agentProvider != "" {
		for name, value := range map[string]string{EnvAgentTenantID: agentTenantID, EnvAgentOrgID: agentOrgID, EnvAgentUserID: agentUserID, EnvAgentIDKeyFile: agentIDKeyFile} {
			if !validAgentConfigValue(value) {
				return Config{}, fmt.Errorf("%w: %s is required and invalid", ErrInvalid, name)
			}
		}
		if err := requireRegularFile(agentIDKeyFile, EnvAgentIDKeyFile); err != nil {
			return Config{}, err
		}
	}
	if agentProvider == "codex" {
		if agentWorkDir == "" || !filepath.IsAbs(agentWorkDir) {
			return Config{}, fmt.Errorf("%w: %s must be an absolute directory", ErrInvalid, EnvAgentWorkDir)
		}
		info, err := os.Stat(agentWorkDir)
		if err != nil || !info.IsDir() {
			return Config{}, fmt.Errorf("%w: %s must be an existing directory", ErrInvalid, EnvAgentWorkDir)
		}
		if endpoints[CapabilityAgent] != "" {
			return Config{}, fmt.Errorf("%w: %s is not used by the codex provider", ErrInvalid, EnvAgentURL)
		}
	}
	if agentProvider == "opencode" && endpoints[CapabilityAgent] == "" {
		return Config{}, fmt.Errorf("%w: %s is required by the opencode provider", ErrInvalid, EnvAgentURL)
	}
	if agentProvider == "opencode" {
		if !validAgentConfigValue(openCodeUsername) {
			return Config{}, fmt.Errorf("%w: %s is invalid", ErrInvalid, EnvOpenCodeUsername)
		}
		if err := requireRegularFile(openCodePasswordFile, EnvOpenCodePasswordFile); err != nil {
			return Config{}, err
		}
	}
	if agentProvider == "" && endpoints[CapabilityAgent] != "" {
		return Config{}, fmt.Errorf("%w: %s is required when %s is set", ErrInvalid, EnvAgentProvider, EnvAgentURL)
	}

	return Config{HTTPAddress: address, ShutdownTimeout: shutdownTimeout, Endpoints: endpoints, PluginToken: pluginToken, DaguTokenFile: daguTokenFile, DaguBasicUser: daguBasicUser, DaguBasicPass: daguBasicPass, AgentProvider: agentProvider, AgentTenantID: agentTenantID, AgentOrgID: agentOrgID, AgentUserID: agentUserID, AgentIDKeyFile: agentIDKeyFile, AgentWorkDir: agentWorkDir, CodexCommand: codexCommand, CodexInitTimeout: codexInitTimeout, OpenCodeUsername: openCodeUsername, OpenCodePasswordFile: openCodePasswordFile}, nil
}

func validAgentConfigValue(value string) bool {
	return value != "" && len(value) <= 128 && !strings.ContainsAny(value, "\r\n\x00")
}

func requireRegularFile(path, envName string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s must point to a readable regular file", ErrInvalid, envName)
	}
	return nil
}
