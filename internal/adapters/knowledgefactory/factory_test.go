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
		KnowledgeProvider: "raglite", KnowledgeTokenFile: tokenFile(t),
		KnowledgeTimeout: time.Second, Endpoints: map[config.Capability]string{config.CapabilityKnowledge: server.URL},
	}, codec(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFactoryKeepsRAGFlowFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/datasets" {
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
		_, _ = io.WriteString(w, `{"code":0,"data":[],"total_datasets":0}`)
	}))
	defer server.Close()
	provider, err := New(config.Config{
		KnowledgeProvider: "ragflow", KnowledgeTokenFile: tokenFile(t),
		KnowledgeEmbedding: "model@factory", KnowledgeTimeout: time.Second,
		Endpoints: map[config.Capability]string{config.CapabilityKnowledge: server.URL},
	}, codec(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFactoryRejectsUnknownProvider(t *testing.T) {
	_, err := New(config.Config{
		KnowledgeProvider: "unknown", KnowledgeTokenFile: tokenFile(t),
		Endpoints: map[config.Capability]string{config.CapabilityKnowledge: "http://provider"},
	}, codec(t))
	if err == nil {
		t.Fatal("unknown provider must fail")
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
