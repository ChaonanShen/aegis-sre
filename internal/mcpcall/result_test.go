package mcpcall

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestNormalizeAllSupportedMCPContent(t *testing.T) {
	dir := t.TempDir()
	result := &mcp.CallToolResult{Content: []mcp.Content{
		&mcp.TextContent{Text: "short"},
		&mcp.ImageContent{Data: []byte("png"), MIMEType: "image/png"},
		&mcp.AudioContent{Data: []byte("wav"), MIMEType: "audio/wav"},
		&mcp.ResourceLink{URI: "https://example.test/dashboard", Name: "dashboard", MIMEType: "text/html"},
		&mcp.EmbeddedResource{Resource: &mcp.ResourceContents{URI: "file:///report.md", MIMEType: "text/markdown", Text: "embedded"}},
	}}
	output, err := normalizeResult(result, dir, ServerConfig{MaxTextBytes: 1024, MaxStructured: 1024, MaxBinaryBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	if output.Text != "short\nembedded" || len(output.Artifacts) != 2 || len(output.Resources) != 1 {
		t.Fatalf("output = %#v", output)
	}
	for _, artifact := range output.Artifacts {
		if strings.Contains(artifact.Path, dir) {
			t.Fatalf("artifact path must be relative: %q", artifact.Path)
		}
		if _, err := os.Stat(filepath.Join(dir, artifact.Path)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNormalizeMovesLargeTextToArtifactAndEnforcesLimits(t *testing.T) {
	config := ServerConfig{MaxTextBytes: 3, MaxStructured: 32, MaxBinaryBytes: 16}
	output, err := normalizeResult(&mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "large text"}}}, t.TempDir(), config)
	if err != nil || len(output.Artifacts) != 1 || !strings.Contains(output.Text, "stored as artifact") {
		t.Fatalf("output = %#v, err = %v", output, err)
	}
	_, err = normalizeResult(&mcp.CallToolResult{Content: []mcp.Content{&mcp.ImageContent{Data: make([]byte, 17), MIMEType: "image/png"}}}, t.TempDir(), config)
	if err == nil || !strings.Contains(err.Error(), "binary") {
		t.Fatalf("error = %v", err)
	}
}
