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
		{path: "/api/session", method: "get"},
		{path: "/api/session", method: "post"},
		{path: "/api/session/{sessionID}", method: "get"},
		{path: "/api/session/{sessionID}/prompt", method: "post"},
		{path: "/api/session/{sessionID}/event", method: "get"},
		{path: "/api/session/{sessionID}/history", method: "get"},
		{path: "/api/session/{sessionID}/interrupt", method: "post"},
		{path: "/api/session/{sessionID}/permission/{requestID}/reply", method: "post"},
		{path: "/session/{sessionID}", method: "patch"},
		{path: "/session/{sessionID}", method: "delete"},
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
