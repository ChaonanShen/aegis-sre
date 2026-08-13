package mcpcall

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestVersionedGrafanaPolicyIsReadOnlyAndBounded(t *testing.T) {
	t.Parallel()
	_, file, _, _ := runtime.Caller(0)
	policy, err := LoadConfig(filepath.Join(filepath.Dir(file), "..", "..", "deploy", "mcp", "v1", "servers.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := policy.Resolve("grafana-read", "query_prometheus")
	if err != nil {
		t.Fatal(err)
	}
	if server.AllowWrite || server.BearerTokenFile == "" || server.MaxBinaryBytes > 8<<20 {
		t.Fatalf("unsafe Grafana policy: %#v", server)
	}
	for _, tool := range []string{"update_dashboard", "create_annotation", "delete_alert_rule"} {
		if _, err := policy.Resolve("grafana-read", tool); err == nil {
			t.Fatalf("write tool %q must not be allowed", tool)
		}
	}
}

func TestGrafanaMCPComposePinsOfficialImageAndKeepsReadServicePrivate(t *testing.T) {
	t.Parallel()
	_, file, _, _ := runtime.Caller(0)
	content, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "deploy", "grafana-mcp", "compose.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	for _, required := range []string{"grafana/mcp-grafana:1.0.0@sha256:", "--disable-write", "GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE", "internal: true"} {
		if !strings.Contains(text, required) {
			t.Fatalf("compose is missing %q", required)
		}
	}
	if strings.Contains(text, "ports:") || strings.Contains(text, ":latest") {
		t.Fatal("Grafana MCP must not publish a direct port or use a floating image tag")
	}
}
