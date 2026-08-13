package mcpcall

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type RequestMetadata struct {
	TraceID        string
	IdempotencyKey string
}

type headerTransport struct {
	base      http.RoundTripper
	tokenFile string
	metadata  RequestMetadata
}

func (transport headerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	if transport.tokenFile != "" {
		content, err := os.ReadFile(transport.tokenFile)
		if err != nil {
			return nil, fmt.Errorf("read MCP bearer token: %w", err)
		}
		token := strings.TrimSpace(string(content))
		if token == "" || strings.ContainsAny(token, "\r\n\x00") {
			return nil, errors.New("read MCP bearer token: invalid token")
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	}
	if transport.metadata.TraceID != "" {
		clone.Header.Set("X-Trace-ID", transport.metadata.TraceID)
	}
	if transport.metadata.IdempotencyKey != "" {
		clone.Header.Set("Idempotency-Key", transport.metadata.IdempotencyKey)
	}
	return transport.base.RoundTrip(clone)
}

func Call(ctx context.Context, serverName string, config ServerConfig, tool string, arguments map[string]any, artifactDir string, metadata RequestMetadata) (Output, error) {
	started := time.Now()
	ctx, cancelTotal := context.WithTimeout(ctx, config.TotalTimeout)
	defer cancelTotal()

	transport, err := newTransport(config)
	if err != nil {
		return Output{}, err
	}
	httpClient := &http.Client{Transport: headerTransport{base: transport, tokenFile: config.BearerTokenFile, metadata: metadata}}
	client := mcp.NewClient(&mcp.Implementation{Name: "aegis-dagu-mcp-call", Version: "1.0.0"}, nil)
	handshakeCtx, cancelHandshake := context.WithTimeout(ctx, config.HandshakeTimeout)
	session, err := client.Connect(handshakeCtx, &mcp.StreamableClientTransport{
		Endpoint:             config.URL,
		HTTPClient:           httpClient,
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}, nil)
	cancelHandshake()
	if err != nil {
		return Output{}, fmt.Errorf("connect to MCP server: %w", err)
	}
	defer session.Close()

	callCtx, cancelCall := context.WithTimeout(ctx, config.CallTimeout)
	result, err := session.CallTool(callCtx, &mcp.CallToolParams{Name: tool, Arguments: arguments})
	cancelCall()
	if err != nil {
		return Output{}, fmt.Errorf("call MCP tool %q: %w", tool, err)
	}
	output, err := normalizeResult(result, artifactDir, config)
	if err != nil {
		return Output{}, err
	}
	output.Meta = Meta{Server: serverName, Tool: tool, DurationMS: time.Since(started).Milliseconds(), TraceID: metadata.TraceID}
	if result.IsError {
		return output, fmt.Errorf("MCP tool %q returned an error", tool)
	}
	return output, nil
}

func newTransport(config ServerConfig) (*http.Transport, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if config.CAFile != "" {
		content, err := os.ReadFile(config.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read MCP CA: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(content) {
			return nil, errors.New("read MCP CA: no certificates found")
		}
		tlsConfig.RootCAs = roots
	}
	if config.ClientCertFile != "" {
		certificate, err := tls.LoadX509KeyPair(config.ClientCertFile, config.ClientKeyFile)
		if err != nil {
			return nil, fmt.Errorf("read MCP client certificate: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: config.ConnectTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   config.HandshakeTimeout,
		ResponseHeaderTimeout: config.CallTimeout,
		ForceAttemptHTTP2:     true,
	}, nil
}
