package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/1024XEngineer/aegis-sre/internal/mcpcall"
)

func main() {
	serverName := flag.String("server", "", "logical MCP server name")
	tool := flag.String("tool", "", "MCP tool name")
	argumentsJSON := flag.String("args-json", "{}", "tool arguments as JSON")
	artifactDir := flag.String("artifact-dir", os.Getenv("DAG_RUN_ARTIFACTS_DIR"), "Dagu artifact directory")
	configPath := flag.String("config", envOr("MCP_CALL_CONFIG", "/etc/aegis/mcp-servers.yaml"), "MCP policy file")
	traceID := flag.String("trace-id", os.Getenv("AEGIS_TRACE_ID"), "trace ID propagated to MCP")
	idempotencyKey := flag.String("idempotency-key", os.Getenv("AEGIS_IDEMPOTENCY_KEY"), "idempotency key for reviewed write calls")
	flag.Parse()
	if *serverName == "" || *tool == "" {
		fail("--server and --tool are required")
	}
	var arguments map[string]any
	if err := json.Unmarshal([]byte(*argumentsJSON), &arguments); err != nil {
		fail("parse --args-json: " + err.Error())
	}
	policy, err := mcpcall.LoadConfig(*configPath)
	if err != nil {
		fail(err.Error())
	}
	server, err := policy.Resolve(*serverName, *tool)
	if err != nil {
		fail(err.Error())
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	output, err := mcpcall.Call(ctx, *serverName, server, *tool, arguments, *artifactDir, mcpcall.RequestMetadata{TraceID: *traceID, IdempotencyKey: *idempotencyKey})
	if err != nil {
		fail(err.Error())
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(output); err != nil {
		fail("encode output: " + err.Error())
	}
}

func fail(message string) {
	_, _ = fmt.Fprintln(os.Stderr, "mcp-call:", message)
	os.Exit(1)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
