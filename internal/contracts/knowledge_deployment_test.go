package contracts_test

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestKnowledgeComposePinsEveryProviderImageAndKeepsSecretsInFiles(t *testing.T) {
	content, err := os.ReadFile("../../compose.knowledge.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dockerfile, err := os.ReadFile("../../deploy/ragflow/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	text := string(content) + string(dockerfile)
	for _, expected := range []string{
		"infiniflow/ragflow:v0.26.4@sha256:", "mysql:8.0.39@sha256:",
		"elasticsearch:8.11.3@sha256:", "pgsty/minio:RELEASE.2026-03-25T00-00-00Z@sha256:",
		"valkey/valkey:8.1.3@sha256:", "text-embeddings-inference:cpu-1.8@sha256:",
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("Knowledge Compose is missing pinned image %q", expected)
		}
	}
	for _, forbidden := range []string{"ragflow-secret", "MYSQL_ROOT_PASSWORD:", "MINIO_ROOT_PASSWORD:", "REDIS_PASSWORD:"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("Knowledge Compose contains inline secret marker %q", forbidden)
		}
	}
}

func TestDaguKnowledgeMCPPolicyOnlyAllowsReadTools(t *testing.T) {
	content, err := os.ReadFile("../../deploy/local/mcp-servers.knowledge.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Servers map[string]struct {
			AllowedTools    []string `yaml:"allowed_tools"`
			BearerTokenFile string   `yaml:"bearer_token_file"`
		} `yaml:"servers"`
	}
	if err := yaml.Unmarshal(content, &config); err != nil {
		t.Fatal(err)
	}
	knowledge, ok := config.Servers["knowledge-read"]
	if !ok {
		t.Fatal("knowledge-read MCP server is missing")
	}
	want := []string{"knowledge.search", "knowledge.get_document", "knowledge.list_sources"}
	if strings.Join(knowledge.AllowedTools, ",") != strings.Join(want, ",") {
		t.Fatalf("allowed tools = %v", knowledge.AllowedTools)
	}
	if knowledge.BearerTokenFile != "/run/secrets/knowledge-mcp-token" {
		t.Fatalf("token file = %q", knowledge.BearerTokenFile)
	}
}

func TestOpenCodeRegistersKnowledgeMCPOnlyFromRuntimeSecret(t *testing.T) {
	entrypoint, err := os.ReadFile("../../deploy/agents/opencode/entrypoint.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(entrypoint)
	for _, expected := range []string{"KNOWLEDGE_MCP_URL", "/run/secrets/knowledge-mcp-token", "knowledge-read", "opencode mcp list --pure"} {
		if !strings.Contains(text, expected) {
			t.Errorf("OpenCode entrypoint is missing %q", expected)
		}
	}
	config, err := os.ReadFile("../../deploy/agents/opencode/opencode.json")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "knowledge-read") {
		t.Fatal("base OpenCode config must not claim Knowledge when the endpoint is disabled")
	}
}
