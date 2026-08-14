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

func TestLoadAcceptsCompleteCodexAgentScope(t *testing.T) {
	workDir := t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "agent-id-key")
	if err := os.WriteFile(keyFile, []byte("0123456789abcdef0123456789abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		EnvAgentProvider: "codex", EnvAgentTenantID: "tenant-a", EnvAgentOrgID: "org-a", EnvAgentUserID: "user-a",
		EnvAgentIDKeyFile: keyFile, EnvAgentWorkDir: workDir, EnvCodexCommand: "/opt/aegis/bin/codex", EnvCodexInitTimeout: "20s",
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentProvider != "codex" || cfg.AgentTenantID != "tenant-a" || cfg.AgentIDKeyFile != keyFile || cfg.AgentWorkDir != workDir || cfg.CodexCommand != "/opt/aegis/bin/codex" || cfg.CodexInitTimeout != 20*time.Second {
		t.Fatalf("config = %+v", cfg)
	}
	if cfg.Endpoints[CapabilityAgent] != "" {
		t.Fatalf("Codex must not be represented as an HTTP endpoint: %+v", cfg.Endpoints)
	}
}

func TestLoadRejectsIncompleteOrConflictingAgentConfiguration(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "agent-id-key")
	if err := os.WriteFile(keyFile, []byte("0123456789abcdef0123456789abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := map[string]string{EnvAgentProvider: "codex", EnvAgentTenantID: "tenant", EnvAgentOrgID: "org", EnvAgentUserID: "user", EnvAgentIDKeyFile: keyFile, EnvAgentWorkDir: t.TempDir()}
	tests := map[string]map[string]string{
		"unknown provider":     {EnvAgentProvider: "unknown"},
		"missing actor":        {EnvAgentProvider: "codex", EnvAgentIDKeyFile: keyFile, EnvAgentWorkDir: base[EnvAgentWorkDir]},
		"relative workdir":     {EnvAgentProvider: "codex", EnvAgentTenantID: "tenant", EnvAgentOrgID: "org", EnvAgentUserID: "user", EnvAgentIDKeyFile: keyFile, EnvAgentWorkDir: "relative"},
		"codex HTTP URL":       mergeAgentConfig(base, map[string]string{EnvAgentURL: "http://codex.invalid"}),
		"opencode no URL":      mergeAgentConfig(base, map[string]string{EnvAgentProvider: "opencode", EnvAgentWorkDir: ""}),
		"opencode no password": mergeAgentConfig(base, map[string]string{EnvAgentProvider: "opencode", EnvAgentURL: "http://opencode.internal", EnvAgentWorkDir: ""}),
		"URL no provider":      {EnvAgentURL: "http://agent.internal"},
		"invalid init time":    mergeAgentConfig(base, map[string]string{EnvCodexInitTimeout: "0s"}),
	}
	for name, values := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := Load(func(key string) string { return values[key] })
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestLoadAcceptsAuthenticatedOpenCodeProvider(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "agent-id-key")
	passwordFile := filepath.Join(t.TempDir(), "opencode-password")
	if err := os.WriteFile(keyFile, []byte("0123456789abcdef0123456789abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(passwordFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		EnvAgentProvider: "opencode", EnvAgentURL: "https://opencode.internal", EnvAgentTenantID: "tenant", EnvAgentOrgID: "org", EnvAgentUserID: "user",
		EnvAgentIDKeyFile: keyFile, EnvOpenCodeUsername: "aegis", EnvOpenCodePasswordFile: passwordFile,
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil || cfg.AgentProvider != "opencode" || cfg.OpenCodeUsername != "aegis" || cfg.OpenCodePasswordFile != passwordFile {
		t.Fatalf("config = %+v, err = %v", cfg, err)
	}
}

func TestLoadAcceptsCompleteKnowledgeConfiguration(t *testing.T) {
	directory := t.TempDir()
	apiKey := filepath.Join(directory, "ragflow-api-key")
	idKey := filepath.Join(directory, "knowledge-id-key")
	pluginToken := filepath.Join(directory, "plugin-token")
	for path, value := range map[string]string{apiKey: "ragflow-secret", idKey: "01234567890123456789012345678901", pluginToken: "plugin-secret"} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	values := map[string]string{
		EnvRAGFlowURL: "https://ragflow.internal", EnvRAGFlowAPIKeyFile: apiKey, EnvKnowledgeIDKeyFile: idKey,
		EnvKnowledgeEmbedding: "Qwen/Qwen3-Embedding-0.6B@OpenAI-API-Compatible", EnvRAGFlowTimeout: "45s", EnvPluginTokenFile: pluginToken,
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Endpoints[CapabilityKnowledge] != values[EnvRAGFlowURL] || cfg.RAGFlowAPIKeyFile != apiKey || cfg.KnowledgeIDKeyFile != idKey || cfg.RAGFlowTimeout != 45*time.Second || cfg.PluginToken != "plugin-secret" {
		t.Fatalf("config = %+v", cfg)
	}
}

func TestLoadRejectsIncompleteKnowledgeConfiguration(t *testing.T) {
	directory := t.TempDir()
	apiKey := filepath.Join(directory, "ragflow-api-key")
	idKey := filepath.Join(directory, "knowledge-id-key")
	pluginToken := filepath.Join(directory, "plugin-token")
	for path, value := range map[string]string{apiKey: "ragflow-secret", idKey: "01234567890123456789012345678901", pluginToken: "plugin-secret"} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	base := map[string]string{EnvRAGFlowURL: "https://ragflow.internal", EnvRAGFlowAPIKeyFile: apiKey, EnvKnowledgeIDKeyFile: idKey, EnvKnowledgeEmbedding: "model@factory", EnvPluginTokenFile: pluginToken}
	tests := map[string]map[string]string{
		"missing API key":     mergeAgentConfig(base, map[string]string{EnvRAGFlowAPIKeyFile: ""}),
		"missing ID key":      mergeAgentConfig(base, map[string]string{EnvKnowledgeIDKeyFile: ""}),
		"invalid embedding":   mergeAgentConfig(base, map[string]string{EnvKnowledgeEmbedding: "model-without-factory"}),
		"missing proxy token": mergeAgentConfig(base, map[string]string{EnvPluginTokenFile: ""}),
		"credentials no URL":  {EnvRAGFlowAPIKeyFile: apiKey},
	}
	for name, values := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(func(key string) string { return values[key] }); !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestLoadBindsKnowledgeMCPTokenToActorAndFolderAllowlist(t *testing.T) {
	directory := t.TempDir()
	files := map[string]string{
		EnvRAGFlowAPIKeyFile: "ragflow-secret", EnvKnowledgeIDKeyFile: "01234567890123456789012345678901",
		EnvPluginTokenFile: "plugin-secret", EnvKnowledgeMCPToken: "mcp-secret",
	}
	values := map[string]string{
		EnvRAGFlowURL: "https://ragflow.internal", EnvKnowledgeEmbedding: "model@factory",
		EnvKnowledgeMCPTenant: "tenant", EnvKnowledgeMCPOrg: "org", EnvKnowledgeMCPUser: "knowledge-agent",
		EnvKnowledgeMCPFolders: "ops, payments,ops",
	}
	for envName, content := range files {
		path := filepath.Join(directory, envName)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		values[envName] = path
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KnowledgeMCPTokenFile != values[EnvKnowledgeMCPToken] || cfg.KnowledgeMCPUserID != "knowledge-agent" || len(cfg.KnowledgeMCPFolders) != 2 {
		t.Fatalf("config = %+v", cfg)
	}
}

func TestLoadRejectsPartialKnowledgeMCPBinding(t *testing.T) {
	values := map[string]string{EnvKnowledgeMCPFolders: "ops"}
	if _, err := Load(func(key string) string { return values[key] }); !errors.Is(err, ErrInvalid) {
		t.Fatalf("error = %v", err)
	}
}

func mergeAgentConfig(base, override map[string]string) map[string]string {
	result := make(map[string]string, len(base)+len(override))
	for key, value := range base {
		result[key] = value
	}
	for key, value := range override {
		result[key] = value
	}
	return result
}
