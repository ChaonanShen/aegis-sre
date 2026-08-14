package contracts

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestControlPlaneImagePinsAndPersistsCodexRuntime(t *testing.T) {
	repositoryRoot := filepath.Join("..", "..")
	dockerfile := mustReadContractFile(t, filepath.Join(repositoryRoot, "deploy", "control-plane", "Dockerfile"))
	versions := mustReadContractFile(t, filepath.Join(repositoryRoot, "deploy", "agents", "versions.env"))
	codexClient := mustReadContractFile(t, filepath.Join(repositoryRoot, "internal", "adapters", "codex", "client.go"))

	versionPattern := regexp.MustCompile(`(?m)^CODEX_CLI_VERSION=([^\s]+)$`)
	match := versionPattern.FindStringSubmatch(versions)
	if len(match) != 2 {
		t.Fatal("deploy/agents/versions.env must pin CODEX_CLI_VERSION")
	}
	if !strings.Contains(codexClient, `const PinnedVersion = "`+match[1]+`"`) {
		t.Fatal("Codex runtime handshake version must match deploy/agents/versions.env")
	}
	for _, required := range []string{
		"ARG CODEX_CLI_VERSION=" + match[1],
		`npm install --global "@openai/codex@${CODEX_CLI_VERSION}"`,
		"CODEX_HOME=/var/lib/aegis/codex",
		`VOLUME ["/var/lib/aegis/codex"]`,
		"USER node",
	} {
		if !strings.Contains(dockerfile, required) {
			t.Fatalf("control-plane image is missing %q", required)
		}
	}
}

func mustReadContractFile(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
