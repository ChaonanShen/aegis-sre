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
