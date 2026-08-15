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
	EnvKnowledgeEnabled     = "AEGIS_KNOWLEDGE_ENABLED"
	EnvKnowledgeProvider    = "AEGIS_KNOWLEDGE_PROVIDER"
	EnvKnowledgeURL         = "AEGIS_KNOWLEDGE_URL"
	EnvKnowledgeTokenFile   = "AEGIS_KNOWLEDGE_TOKEN_FILE"
	EnvKnowledgeTimeout     = "AEGIS_KNOWLEDGE_TIMEOUT"
	EnvRAGFlowURL           = "AEGIS_RAGFLOW_URL"
	EnvRAGFlowAPIKeyFile    = "AEGIS_RAGFLOW_API_KEY_FILE"
	EnvKnowledgeIDKeyFile   = "AEGIS_KNOWLEDGE_ID_KEY_FILE"
	EnvKnowledgeEmbedding   = "AEGIS_KNOWLEDGE_EMBEDDING_MODEL"
	EnvRAGFlowTimeout       = "AEGIS_RAGFLOW_TIMEOUT"
	EnvKnowledgeMCPToken    = "AEGIS_KNOWLEDGE_MCP_TOKEN_FILE"
	EnvKnowledgeMCPTenant   = "AEGIS_KNOWLEDGE_MCP_TENANT_ID"
	EnvKnowledgeMCPOrg      = "AEGIS_KNOWLEDGE_MCP_ORG_ID"
	EnvKnowledgeMCPUser     = "AEGIS_KNOWLEDGE_MCP_USER_ID"
	EnvKnowledgeMCPFolders  = "AEGIS_KNOWLEDGE_MCP_FOLDER_UIDS"
	EnvPlaybookMCPToken     = "AEGIS_PLAYBOOK_MCP_TOKEN_FILE"
	EnvPlaybookMCPFolders   = "AEGIS_PLAYBOOK_MCP_FOLDER_UIDS"
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
	HTTPAddress           string
	ShutdownTimeout       time.Duration
	Endpoints             map[Capability]string
	PluginToken           string
	DaguTokenFile         string
	DaguBasicUser         string
	DaguBasicPass         string
	AgentProvider         string
	AgentTenantID         string
	AgentOrgID            string
	AgentUserID           string
	AgentIDKeyFile        string
	AgentWorkDir          string
	CodexCommand          string
	CodexInitTimeout      time.Duration
	OpenCodeUsername      string
	OpenCodePasswordFile  string
	KnowledgeEnabled      bool
	KnowledgeProvider     string
	KnowledgeTokenFile    string
	RAGFlowAPIKeyFile     string
	KnowledgeIDKeyFile    string
	KnowledgeEmbedding    string
	RAGFlowTimeout        time.Duration
	KnowledgeTimeout      time.Duration
	KnowledgeMCPTokenFile string
	KnowledgeMCPTenantID  string
	KnowledgeMCPOrgID     string
	KnowledgeMCPUserID    string
	KnowledgeMCPFolders   []string
	PlaybookMCPTokenFile  string
	PlaybookMCPFolders    []string
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

	knowledgeEnabled, err := parseBool(getenv(EnvKnowledgeEnabled), false)
	if err != nil {
		return Config{}, fmt.Errorf("%w: %s must be true or false", ErrInvalid, EnvKnowledgeEnabled)
	}

	endpoints := make(map[Capability]string)
	for capability, envName := range map[Capability]string{
		CapabilityAgent:      EnvAgentURL,
		CapabilityPlaybook:   EnvDaguURL,
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
	knowledgeURL := strings.TrimSpace(getenv(EnvKnowledgeURL))
	legacyKnowledgeURL := strings.TrimSpace(getenv(EnvRAGFlowURL))
	if knowledgeURL != "" && legacyKnowledgeURL != "" && knowledgeURL != legacyKnowledgeURL {
		return Config{}, fmt.Errorf("%w: %s and %s cannot disagree", ErrInvalid, EnvKnowledgeURL, EnvRAGFlowURL)
	}
	if knowledgeURL == "" {
		knowledgeURL = legacyKnowledgeURL
	}
	if knowledgeEnabled && knowledgeURL != "" {
		parsed, err := url.Parse(knowledgeURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return Config{}, fmt.Errorf("%w: %s must be an HTTP origin", ErrInvalid, EnvKnowledgeURL)
		}
		endpoints[CapabilityKnowledge] = knowledgeURL
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

	knowledgeProvider := strings.ToLower(strings.TrimSpace(getenv(EnvKnowledgeProvider)))
	legacyAPIKeyFile := strings.TrimSpace(getenv(EnvRAGFlowAPIKeyFile))
	knowledgeTokenFile := strings.TrimSpace(getenv(EnvKnowledgeTokenFile))
	if knowledgeTokenFile != "" && legacyAPIKeyFile != "" && knowledgeTokenFile != legacyAPIKeyFile {
		return Config{}, fmt.Errorf("%w: %s and %s cannot disagree", ErrInvalid, EnvKnowledgeTokenFile, EnvRAGFlowAPIKeyFile)
	}
	if knowledgeTokenFile == "" {
		knowledgeTokenFile = legacyAPIKeyFile
	}
	if knowledgeProvider == "" && (legacyKnowledgeURL != "" || legacyAPIKeyFile != "") {
		knowledgeProvider = "ragflow"
	}
	if knowledgeProvider != "" && knowledgeProvider != "ragflow" && knowledgeProvider != "raglite" {
		return Config{}, fmt.Errorf("%w: %s must be ragflow or raglite", ErrInvalid, EnvKnowledgeProvider)
	}
	if knowledgeProvider == "raglite" && (legacyKnowledgeURL != "" || legacyAPIKeyFile != "") {
		return Config{}, fmt.Errorf("%w: RAGFlow compatibility settings cannot configure the raglite provider", ErrInvalid)
	}
	knowledgeIDKeyFile := strings.TrimSpace(getenv(EnvKnowledgeIDKeyFile))
	knowledgeEmbedding := strings.TrimSpace(getenv(EnvKnowledgeEmbedding))
	knowledgeTimeout := 30 * time.Second
	rawKnowledgeTimeout := strings.TrimSpace(getenv(EnvKnowledgeTimeout))
	legacyTimeout := strings.TrimSpace(getenv(EnvRAGFlowTimeout))
	if rawKnowledgeTimeout != "" && legacyTimeout != "" && rawKnowledgeTimeout != legacyTimeout {
		return Config{}, fmt.Errorf("%w: %s and %s cannot disagree", ErrInvalid, EnvKnowledgeTimeout, EnvRAGFlowTimeout)
	}
	if rawKnowledgeTimeout == "" {
		rawKnowledgeTimeout = legacyTimeout
	}
	if rawKnowledgeTimeout != "" {
		parsed, err := time.ParseDuration(rawKnowledgeTimeout)
		if err != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("%w: %s must be a positive duration", ErrInvalid, EnvKnowledgeTimeout)
		}
		knowledgeTimeout = parsed
	}
	knowledgeConfigured := knowledgeProvider != "" || knowledgeURL != "" || knowledgeTokenFile != "" || knowledgeIDKeyFile != "" || knowledgeEmbedding != "" || strings.TrimSpace(getenv(EnvKnowledgeMCPToken)) != "" || strings.TrimSpace(getenv(EnvKnowledgeMCPTenant)) != "" || strings.TrimSpace(getenv(EnvKnowledgeMCPOrg)) != "" || strings.TrimSpace(getenv(EnvKnowledgeMCPUser)) != "" || strings.TrimSpace(getenv(EnvKnowledgeMCPFolders)) != ""
	if knowledgeConfigured && !knowledgeEnabled {
		return Config{}, fmt.Errorf("%w: %s must be true before Knowledge can be configured", ErrInvalid, EnvKnowledgeEnabled)
	}
	if endpoints[CapabilityKnowledge] != "" {
		if knowledgeProvider == "" {
			return Config{}, fmt.Errorf("%w: %s is required when Knowledge is configured", ErrInvalid, EnvKnowledgeProvider)
		}
		if err := requireRegularFile(knowledgeTokenFile, EnvKnowledgeTokenFile); err != nil {
			return Config{}, err
		}
		if err := requireRegularFile(knowledgeIDKeyFile, EnvKnowledgeIDKeyFile); err != nil {
			return Config{}, err
		}
		if knowledgeProvider == "ragflow" && (knowledgeEmbedding == "" || len(knowledgeEmbedding) > 255 || !strings.Contains(knowledgeEmbedding, "@") || strings.ContainsAny(knowledgeEmbedding, "\r\n\x00")) {
			return Config{}, fmt.Errorf("%w: %s must be a model_name@model_factory value", ErrInvalid, EnvKnowledgeEmbedding)
		}
		if pluginToken == "" {
			return Config{}, fmt.Errorf("%w: %s is required when Knowledge is configured", ErrInvalid, EnvPluginTokenFile)
		}
	} else if knowledgeProvider != "" || knowledgeTokenFile != "" || knowledgeIDKeyFile != "" || knowledgeEmbedding != "" {
		return Config{}, fmt.Errorf("%w: %s is required when Knowledge credentials are configured", ErrInvalid, EnvKnowledgeURL)
	}

	knowledgeMCPTokenFile := strings.TrimSpace(getenv(EnvKnowledgeMCPToken))
	knowledgeMCPTenantID := strings.TrimSpace(getenv(EnvKnowledgeMCPTenant))
	knowledgeMCPOrgID := strings.TrimSpace(getenv(EnvKnowledgeMCPOrg))
	knowledgeMCPUserID := strings.TrimSpace(getenv(EnvKnowledgeMCPUser))
	knowledgeMCPFolders, folderErr := parseKnowledgeMCPFolders(getenv(EnvKnowledgeMCPFolders))
	mcpConfigured := knowledgeMCPTokenFile != "" || knowledgeMCPTenantID != "" || knowledgeMCPOrgID != "" || knowledgeMCPUserID != "" || len(knowledgeMCPFolders) > 0
	if mcpConfigured {
		if endpoints[CapabilityKnowledge] == "" {
			return Config{}, fmt.Errorf("%w: %s is required when Knowledge MCP is configured", ErrInvalid, EnvKnowledgeURL)
		}
		if err := requireRegularFile(knowledgeMCPTokenFile, EnvKnowledgeMCPToken); err != nil {
			return Config{}, err
		}
		if folderErr != nil || !validAgentConfigValue(knowledgeMCPTenantID) || !validAgentConfigValue(knowledgeMCPOrgID) || !validAgentConfigValue(knowledgeMCPUserID) || len(knowledgeMCPFolders) == 0 {
			return Config{}, fmt.Errorf("%w: Knowledge MCP actor and Folder allowlist must be complete and valid", ErrInvalid)
		}
	}

	playbookMCPTokenFile := strings.TrimSpace(getenv(EnvPlaybookMCPToken))
	playbookMCPFolders, playbookFolderErr := parseKnowledgeMCPFolders(getenv(EnvPlaybookMCPFolders))
	playbookMCPConfigured := playbookMCPTokenFile != "" || len(playbookMCPFolders) > 0
	if playbookMCPConfigured {
		if endpoints[CapabilityPlaybook] == "" || agentTenantID == "" || agentOrgID == "" || agentUserID == "" {
			return Config{}, fmt.Errorf("%w: Playbook MCP requires Dagu endpoint and Agent actor", ErrInvalid)
		}
		if err := requireRegularFile(playbookMCPTokenFile, EnvPlaybookMCPToken); err != nil {
			return Config{}, err
		}
		if playbookFolderErr != nil || len(playbookMCPFolders) == 0 {
			return Config{}, fmt.Errorf("%w: Playbook MCP Folder allowlist must be complete and valid", ErrInvalid)
		}
	}

	return Config{HTTPAddress: address, ShutdownTimeout: shutdownTimeout, Endpoints: endpoints, PluginToken: pluginToken, DaguTokenFile: daguTokenFile, DaguBasicUser: daguBasicUser, DaguBasicPass: daguBasicPass, AgentProvider: agentProvider, AgentTenantID: agentTenantID, AgentOrgID: agentOrgID, AgentUserID: agentUserID, AgentIDKeyFile: agentIDKeyFile, AgentWorkDir: agentWorkDir, CodexCommand: codexCommand, CodexInitTimeout: codexInitTimeout, OpenCodeUsername: openCodeUsername, OpenCodePasswordFile: openCodePasswordFile, KnowledgeEnabled: knowledgeEnabled, KnowledgeProvider: knowledgeProvider, KnowledgeTokenFile: knowledgeTokenFile, RAGFlowAPIKeyFile: knowledgeTokenFile, KnowledgeIDKeyFile: knowledgeIDKeyFile, KnowledgeEmbedding: knowledgeEmbedding, KnowledgeTimeout: knowledgeTimeout, RAGFlowTimeout: knowledgeTimeout, KnowledgeMCPTokenFile: knowledgeMCPTokenFile, KnowledgeMCPTenantID: knowledgeMCPTenantID, KnowledgeMCPOrgID: knowledgeMCPOrgID, KnowledgeMCPUserID: knowledgeMCPUserID, KnowledgeMCPFolders: knowledgeMCPFolders, PlaybookMCPTokenFile: playbookMCPTokenFile, PlaybookMCPFolders: playbookMCPFolders}, nil
}

func parseBool(raw string, defaultValue bool) (bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultValue, nil
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, ErrInvalid
	}
}

func parseKnowledgeMCPFolders(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	seen := map[string]struct{}{}
	result := make([]string, 0)
	for _, item := range strings.Split(raw, ",") {
		uid := strings.TrimSpace(item)
		if !validAgentConfigValue(uid) {
			return nil, ErrInvalid
		}
		if _, exists := seen[uid]; exists {
			continue
		}
		seen[uid] = struct{}{}
		result = append(result, uid)
	}
	return result, nil
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
