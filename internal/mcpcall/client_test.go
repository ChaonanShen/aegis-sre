package mcpcall

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoInput struct {
	Value string `json:"value"`
}
type echoOutput struct {
	Value string `json:"value"`
}

func TestCallUsesStreamableHTTPAndPropagatesMetadata(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("secret-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "contract", Version: "1"}, nil)
	mcp.AddTool(mcpServer, &mcp.Tool{Name: "echo"}, func(_ context.Context, _ *mcp.CallToolRequest, input echoInput) (*mcp.CallToolResult, echoOutput, error) {
		return nil, echoOutput{Value: input.Value}, nil
	})
	handler := mcp.NewStreamableHTTPHandler(func(request *http.Request) *mcp.Server {
		if request.Header.Get("Authorization") != "Bearer secret-token" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("X-Trace-ID") != "trace-1" || request.Header.Get("Idempotency-Key") != "operation-1" {
			t.Errorf("metadata headers are missing")
		}
		return mcpServer
	}, nil)
	server := httptest.NewServer(handler)
	defer server.Close()
	config := ServerConfig{URL: server.URL, BearerTokenFile: tokenPath, ConnectTimeout: time.Second, HandshakeTimeout: time.Second, CallTimeout: time.Second, TotalTimeout: 2 * time.Second, MaxTextBytes: 1024, MaxStructured: 1024, MaxBinaryBytes: 1024}
	output, err := Call(context.Background(), "contract", config, "echo", map[string]any{"value": "ok"}, t.TempDir(), RequestMetadata{TraceID: "trace-1", IdempotencyKey: "operation-1"})
	if err != nil {
		t.Fatal(err)
	}
	result, ok := output.Result.(map[string]any)
	if !ok || result["value"] != "ok" || output.Meta.TraceID != "trace-1" {
		t.Fatalf("output = %#v", output)
	}
}
