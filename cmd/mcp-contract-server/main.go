package main

import (
	"context"
	"crypto/subtle"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoInput struct {
	Value string `json:"value" jsonschema:"value returned by the contract tool"`
}

type echoOutput struct {
	Value string `json:"value"`
}

func main() {
	address := flag.String("address", ":8090", "listen address")
	tokenFile := flag.String("token-file", "", "caller bearer token file")
	flag.Parse()
	server := mcp.NewServer(&mcp.Implementation{Name: "aegis-mcp-contract", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "contract.echo", Description: "Return deterministic structured content."}, func(_ context.Context, _ *mcp.CallToolRequest, input echoInput) (*mcp.CallToolResult, echoOutput, error) {
		return nil, echoOutput{Value: input.Value}, nil
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.Handle("/mcp", bearerFile(*tokenFile, mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)))
	log.Printf("MCP contract server listening on %s", *address)
	if err := http.ListenAndServe(*address, mux); err != nil {
		log.Fatal(err)
	}
}

func bearerFile(path string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if path == "" {
			http.Error(w, "caller authentication is not configured", http.StatusServiceUnavailable)
			return
		}
		content, err := os.ReadFile(path)
		expected := strings.TrimSpace(string(content))
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if err != nil || expected == "" || len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, fmt.Sprintf("unauthorized caller"), http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, request)
	})
}
