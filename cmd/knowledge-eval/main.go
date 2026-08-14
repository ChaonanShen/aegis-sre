package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/knowledgeeval"
	"github.com/1024XEngineer/aegis-sre/internal/mcpcall"
)

func main() {
	manifestPath := flag.String("manifest", "", "annotated Knowledge evaluation manifest")
	url := flag.String("url", "http://127.0.0.1:8080/mcp/knowledge", "Knowledge MCP URL")
	tokenFile := flag.String("token-file", "", "Knowledge MCP bearer token file")
	flag.Parse()
	if err := run(*manifestPath, *url, *tokenFile); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "knowledge-eval:", err)
		os.Exit(1)
	}
}

func run(manifestPath, url, tokenFile string) error {
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	var manifest knowledgeeval.Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return fmt.Errorf("decode manifest: %w", err)
	}
	if len(manifest.Cases) < knowledgeeval.MinimumCases {
		return fmt.Errorf("manifest must contain at least %d annotated cases", knowledgeeval.MinimumCases)
	}
	config := mcpcall.ServerConfig{URL: url, BearerTokenFile: tokenFile, ConnectTimeout: 5 * time.Second, HandshakeTimeout: 10 * time.Second, CallTimeout: 30 * time.Second, TotalTimeout: 45 * time.Second, MaxTextBytes: 32768, MaxStructured: 256 << 10, MaxBinaryBytes: 256 << 10}
	ctx := context.Background()
	sourcesRaw, err := call(ctx, config, "knowledge.list_sources", map[string]any{"folder_uid": manifest.FolderUID})
	if err != nil {
		return err
	}
	sources, err := parseSources(sourcesRaw)
	if err != nil {
		return err
	}
	results := make([]knowledgeeval.SearchResult, 0, len(manifest.Cases))
	for _, testCase := range manifest.Cases {
		arguments := map[string]any{"folder_uid": manifest.FolderUID, "query": testCase.Query, "knowledge_base_ids": manifest.KnowledgeBaseIDs, "limit": 5, "threshold": 0}
		if testCase.Service != "" {
			arguments["service"] = testCase.Service
		}
		raw, err := call(ctx, config, "knowledge.search", arguments)
		if err != nil {
			return fmt.Errorf("case %q: %w", testCase.Name, err)
		}
		parsed, err := parseHits(raw)
		if err != nil {
			return fmt.Errorf("case %q: %w", testCase.Name, err)
		}
		results = append(results, parsed)
	}
	report, err := knowledgeeval.Evaluate(manifest, sources, results)
	if err != nil {
		return err
	}
	encoded, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(encoded))
	if !report.MeetsTargets() {
		return fmt.Errorf("phase 8 quality targets were not met")
	}
	return nil
}

func call(ctx context.Context, config mcpcall.ServerConfig, tool string, arguments map[string]any) (map[string]any, error) {
	output, err := mcpcall.Call(ctx, "knowledge", config, tool, arguments, os.TempDir(), mcpcall.RequestMetadata{})
	if err != nil {
		return nil, err
	}
	value, ok := output.Result.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("tool %s returned invalid structured data", tool)
	}
	return value, nil
}

func parseSources(value map[string]any) ([]knowledgeeval.SourceStatus, error) {
	raw, ok := value["sources"].([]any)
	if !ok {
		return nil, fmt.Errorf("list_sources response is invalid")
	}
	result := make([]knowledgeeval.SourceStatus, 0, len(raw))
	for _, item := range raw {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("source is invalid")
		}
		status, ok := object["status"].(string)
		if !ok {
			return nil, fmt.Errorf("source status is invalid")
		}
		result = append(result, knowledgeeval.SourceStatus{Status: status})
	}
	return result, nil
}

func parseHits(value map[string]any) (knowledgeeval.SearchResult, error) {
	raw, ok := value["hits"].([]any)
	if !ok {
		return knowledgeeval.SearchResult{}, fmt.Errorf("search response is invalid")
	}
	result := knowledgeeval.SearchResult{DocumentIDs: make([]string, 0, len(raw))}
	for _, item := range raw {
		object, ok := item.(map[string]any)
		if !ok {
			return knowledgeeval.SearchResult{}, fmt.Errorf("hit is invalid")
		}
		citation, ok := object["citation"].(map[string]any)
		if !ok {
			return knowledgeeval.SearchResult{}, fmt.Errorf("citation is invalid")
		}
		id, ok := citation["document_id"].(string)
		if !ok {
			return knowledgeeval.SearchResult{}, fmt.Errorf("citation document ID is invalid")
		}
		result.DocumentIDs = append(result.DocumentIDs, id)
	}
	return result, nil
}
