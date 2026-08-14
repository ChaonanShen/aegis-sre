package main

import (
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

func main() {
	address := flag.String("address", ":8080", "listen address")
	upstreamValue := flag.String("upstream", "", "upstream MCP HTTP origin")
	tokenFile := flag.String("token-file", "", "caller bearer token file")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	upstream, err := parseOrigin(*upstreamValue)
	if err != nil {
		logger.Error("configure MCP gateway", "error", err)
		os.Exit(1)
	}
	if strings.TrimSpace(*tokenFile) == "" {
		logger.Error("configure MCP gateway", "error", "token file is required")
		os.Exit(1)
	}

	handler := newGateway(upstream, *tokenFile, logger)
	server := &http.Server{
		Addr:              *address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	logger.Info("MCP gateway listening", "address", *address, "upstream", upstream.Host)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("MCP gateway stopped", "error", err)
		os.Exit(1)
	}
}

func newGateway(upstream *url.URL, tokenFile string, logger *slog.Logger) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.Host = upstream.Host
		request.Header.Del("Authorization")
		request.Header.Del("X-Forwarded-For")
		request.Header.Del("X-Forwarded-Host")
		request.Header.Del("X-Forwarded-Proto")
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, request *http.Request, err error) {
		logger.Error("MCP upstream request failed", "method", request.Method, "path", request.URL.Path, "error", err)
		http.Error(w, "MCP upstream unavailable", http.StatusBadGateway)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/healthz" {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if request.URL.Path != "/mcp" {
			http.NotFound(w, request)
			return
		}
		expected, err := readToken(tokenFile)
		if err != nil {
			logger.Error("read MCP caller token", "error", err)
			http.Error(w, "MCP gateway unavailable", http.StatusServiceUnavailable)
			return
		}
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		proxy.ServeHTTP(w, request)
	})
}

func parseOrigin(value string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("upstream must be an HTTP origin")
	}
	parsed.Path = ""
	return parsed, nil
}

func readToken(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	token := strings.TrimSpace(string(content))
	if token == "" || strings.ContainsAny(token, "\r\n\x00") {
		return "", errors.New("token file is empty or invalid")
	}
	return token, nil
}
