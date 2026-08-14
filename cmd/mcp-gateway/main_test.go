package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestGatewayAuthenticatesAndSanitizesUpstreamRequest(t *testing.T) {
	var authorization, host string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		host = request.Host
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()
	parsed, _ := url.Parse(upstream.URL)
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("caller-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := newGateway(parsed, tokenFile, slog.New(slog.NewTextHandler(io.Discard, nil)))

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("Authorization", "Bearer caller-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || authorization != "" || host != parsed.Host {
		t.Fatalf("status=%d upstream authorization=%q host=%q", response.Code, authorization, host)
	}
}

func TestGatewayRereadsRotatedToken(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer upstream.Close()
	parsed, _ := url.Parse(upstream.URL)
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("first-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := newGateway(parsed, tokenFile, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := os.WriteFile(tokenFile, []byte("second-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("Authorization", "Bearer second-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d", response.Code)
	}
}
