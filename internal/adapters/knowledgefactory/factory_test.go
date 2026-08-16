package knowledgefactory

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
)

func TestFactoryBuildsRAGLiteProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/healthz" || request.Header.Get("Authorization") != "Bearer provider-secret" {
			t.Fatalf("unexpected request: %s %q", request.URL.Path, request.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	}))
	defer server.Close()
	provider, err := New(config.Config{
		KnowledgeTokenFile: tokenFile(t),
		KnowledgeTimeout:   time.Second, Endpoints: map[config.Capability]string{config.CapabilityKnowledge: server.URL},
	}, codec(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func tokenFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("provider-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
func codec(t *testing.T) *knowledgeid.Codec {
	t.Helper()
	value, err := knowledgeid.New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	return value
}
