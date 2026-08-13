package mcpcall

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPolicyDefaultsToReadOnlyAndRejectsRecursiveDaguExecution(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.yaml")
	content := `servers:
  grafana-read:
    url: https://grafana-mcp.example/mcp
    allowed_tools: [query_prometheus]
    write_tools: [update_dashboard]
  dagu:
    url: https://dagu.example/mcp
    allowed_tools: [list_dags, start_dag]
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	read, err := policy.Resolve("grafana-read", "query_prometheus")
	if err != nil || read.CallTimeout != 30*time.Second || read.MaxBinaryBytes != 8<<20 {
		t.Fatalf("server = %#v, err = %v", read, err)
	}
	if _, err := policy.Resolve("grafana-read", "update_dashboard"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("write error = %v", err)
	}
	if _, err := policy.Resolve("dagu", "start_dag"); err == nil || !strings.Contains(err.Error(), "recursive") {
		t.Fatalf("recursive error = %v", err)
	}
	if _, err := policy.Resolve("missing", "tool"); err == nil {
		t.Fatal("unknown server must be rejected")
	}
}

func TestPolicyRejectsUnknownFieldsAndIncompleteMTLS(t *testing.T) {
	for name, content := range map[string]string{
		"unknown": `servers: {test: {url: https://example.test/mcp, allowed_tools: [read], typo: true}}`,
		"mtls":    `servers: {test: {url: https://example.test/mcp, allowed_tools: [read], client_cert_file: cert.pem}}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "policy.yaml")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadConfig(path); err == nil {
				t.Fatal("invalid policy must fail")
			}
		})
	}
}

func TestProductionDaguImageWiresMCPCallActionAndPolicy(t *testing.T) {
	repositoryRoot := filepath.Join("..", "..")
	policyPath := filepath.Join(repositoryRoot, "deploy", "mcp", "v1", "servers.yaml")
	policy, err := LoadConfig(policyPath)
	if err != nil {
		t.Fatalf("load production MCP policy: %v", err)
	}
	if _, err := policy.Resolve("grafana-read", "query_prometheus"); err != nil {
		t.Fatalf("resolve production Grafana tool: %v", err)
	}

	base, err := os.ReadFile(filepath.Join(repositoryRoot, "deploy", "dagu", "base.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"mcp.call:", "command: /usr/local/bin/mcp-call", "--artifact-dir", "--idempotency-key"} {
		if !strings.Contains(string(base), required) {
			t.Errorf("Dagu base config is missing %q", required)
		}
	}

	dockerfile, err := os.ReadFile(filepath.Join(repositoryRoot, "deploy", "dagu", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"deploy/dagu/base.yaml /etc/aegis/dagu-base.yaml",
		"deploy/mcp/v1/servers.yaml /etc/aegis/mcp-servers.yaml",
		"DAGU_BASE_CONFIG=/etc/aegis/dagu-base.yaml",
		"MCP_CALL_CONFIG=/etc/aegis/mcp-servers.yaml",
	} {
		if !strings.Contains(string(dockerfile), required) {
			t.Errorf("Dagu runtime image is missing %q", required)
		}
	}
}
