package contracts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const opencode11818SHA256 = "5bbd6493a1a488ef4294889341c896e420f814ecea95822100aaa9f3f95ab2d1"

func TestPinnedOpenCodeContractContainsRequiredSessionOperations(t *testing.T) {
	content, err := os.ReadFile("../../api/providers/opencode/1.18.18/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	if got := hex.EncodeToString(sum[:]); got != opencode11818SHA256 {
		t.Fatalf("OpenCode contract checksum = %s", got)
	}
	versions, err := os.ReadFile("../../deploy/agents/versions.env")
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"OPENCODE_VERSION=1.18.18",
		"OPENCODE_OPENAPI_SHA256=" + opencode11818SHA256,
	} {
		if !strings.Contains(string(versions), expected) {
			t.Fatalf("agent versions do not contain %q", expected)
		}
	}

	var document struct {
		OpenAPI string                                `json:"openapi"`
		Paths   map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(content, &document); err != nil {
		t.Fatalf("OpenCode contract is invalid JSON: %v", err)
	}
	if document.OpenAPI != "3.1.0" {
		t.Fatalf("OpenCode contract version = %q", document.OpenAPI)
	}

	for _, operation := range []struct {
		path   string
		method string
	}{
		// V2 is limited to caller-owned session creation (and conflict recovery).
		{path: "/api/session", method: "post"},
		{path: "/api/session/{sessionID}", method: "get"},
		// V1 owns session listing, reads, prompts, cancellation and global events.
		{path: "/session", method: "get"},
		{path: "/session/{sessionID}", method: "get"},
		{path: "/session/{sessionID}", method: "patch"},
		{path: "/session/{sessionID}", method: "delete"},
		{path: "/session/{sessionID}/message", method: "get"},
		{path: "/session/{sessionID}/prompt_async", method: "post"},
		{path: "/session/{sessionID}/abort", method: "post"},
		{path: "/event", method: "get"},
		{path: "/config", method: "get"},
	} {
		methods := document.Paths[operation.path]
		if len(methods[operation.method]) == 0 {
			t.Errorf("OpenCode contract is missing %s %s", operation.method, operation.path)
		}
	}
}

func TestPinnedOpenCodeV2CreateUsesCallerIDButDoesNotAcceptTitle(t *testing.T) {
	content, err := os.ReadFile("../../api/providers/opencode/1.18.18/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(content, &document); err != nil {
		t.Fatal(err)
	}
	schema := nestedMap(t, document, "paths", "/api/session", "post", "requestBody", "content", "application/json", "schema")
	properties := nestedMap(t, schema, "properties")
	if _, ok := properties["id"]; !ok {
		t.Fatal("OpenCode V2 session create must accept a caller-supplied ID")
	}
	if _, ok := properties["title"]; ok {
		t.Fatal("OpenCode V2 session create unexpectedly accepts title; review the two-step create contract")
	}
	if additional, ok := schema["additionalProperties"].(bool); !ok || additional {
		t.Fatal("OpenCode V2 session create must reject unknown properties")
	}
}

func TestPinnedOpenCodeV1UpdateExposesArchiveTimestamp(t *testing.T) {
	content, err := os.ReadFile("../../api/providers/opencode/1.18.18/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(content, &document); err != nil {
		t.Fatal(err)
	}
	properties := nestedMap(t, document, "paths", "/session/{sessionID}", "patch", "requestBody", "content", "application/json", "schema", "properties")
	if _, ok := properties["title"]; !ok {
		t.Fatal("OpenCode V1 session update must expose title")
	}
	timeSchema := nestedMap(t, properties, "time", "properties")
	if _, ok := timeSchema["archived"]; !ok {
		t.Fatal("OpenCode V1 session update must expose the archive timestamp")
	}
}

func TestOpenCodeDeploymentPinsRuntimeAndModelWithoutSecrets(t *testing.T) {
	dockerfile, err := os.ReadFile("../../deploy/agents/opencode/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dockerfile), `ARG OPENCODE_VERSION=1.18.18`) || !strings.Contains(string(dockerfile), `opencode-ai@${OPENCODE_VERSION}`) {
		t.Fatal("OpenCode image must install the pinned runtime version")
	}
	config, err := os.ReadFile("../../deploy/agents/opencode/opencode.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), `"model": "deepseek/deepseek-chat"`) {
		t.Fatal("OpenCode deployment must select DeepSeek Chat")
	}
	if strings.Contains(strings.ToLower(string(config)), "sk-") {
		t.Fatal("OpenCode configuration must not contain an API key")
	}
}

func TestOpenCodeBaseConfigRegistersPlaybookMCPButNotKnowledge(t *testing.T) {
	content, err := os.ReadFile("../../deploy/agents/opencode/opencode.json")
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	if !strings.Contains(text, `"url": "http://control-plane:8080/mcp/playbooks"`) || !strings.Contains(text, "PLAYBOOK_MCP_TOKEN") {
		t.Fatal("base OpenCode config must register authenticated Playbook MCP")
	}
	if strings.Contains(text, "knowledge") {
		t.Fatal("base OpenCode config must not register Knowledge MCP")
	}
}

func nestedMap(t *testing.T, root map[string]any, path ...string) map[string]any {
	t.Helper()
	current := root
	for _, part := range path {
		next, ok := current[part].(map[string]any)
		if !ok {
			t.Fatalf("OpenCode contract path %q is not an object", part)
		}
		current = next
	}
	return current
}
