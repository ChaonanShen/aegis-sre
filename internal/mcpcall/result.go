package mcpcall

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Output struct {
	Result    any            `json:"result"`
	Text      string         `json:"text"`
	Artifacts []Artifact     `json:"artifacts"`
	Resources []ResourceLink `json:"resources"`
	Meta      Meta           `json:"meta"`
}

type Artifact struct {
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	MediaType string `json:"media_type"`
	Size      int    `json:"size"`
}

type ResourceLink struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MediaType   string `json:"media_type,omitempty"`
}

type Meta struct {
	Server     string `json:"server"`
	Tool       string `json:"tool"`
	DurationMS int64  `json:"duration_ms"`
	TraceID    string `json:"trace_id,omitempty"`
}

func normalizeResult(result *mcp.CallToolResult, artifactDir string, config ServerConfig) (Output, error) {
	output := Output{Artifacts: []Artifact{}, Resources: []ResourceLink{}}
	structured, err := json.Marshal(result.StructuredContent)
	if err != nil {
		return Output{}, errors.New("encode MCP structured result")
	}
	if int64(len(structured)) > config.MaxStructured {
		return Output{}, errors.New("MCP structured result exceeds configured limit")
	}
	output.Result = result.StructuredContent
	var texts []string
	textBytes := int64(0)
	artifactIndex := 0
	for _, item := range result.Content {
		switch content := item.(type) {
		case *mcp.TextContent:
			textBytes += int64(len(content.Text))
			if textBytes <= config.MaxTextBytes {
				texts = append(texts, content.Text)
				continue
			}
			artifact, err := writeArtifact(artifactDir, "text", "text/plain", []byte(content.Text), artifactIndex, config.MaxBinaryBytes)
			if err != nil {
				return Output{}, err
			}
			artifactIndex++
			output.Artifacts = append(output.Artifacts, artifact)
			texts = append(texts, fmt.Sprintf("[large text stored as artifact: %s]", artifact.Path))
		case *mcp.ImageContent:
			artifact, err := writeArtifact(artifactDir, "image", content.MIMEType, content.Data, artifactIndex, config.MaxBinaryBytes)
			if err != nil {
				return Output{}, err
			}
			artifactIndex++
			output.Artifacts = append(output.Artifacts, artifact)
		case *mcp.AudioContent:
			artifact, err := writeArtifact(artifactDir, "audio", content.MIMEType, content.Data, artifactIndex, config.MaxBinaryBytes)
			if err != nil {
				return Output{}, err
			}
			artifactIndex++
			output.Artifacts = append(output.Artifacts, artifact)
		case *mcp.ResourceLink:
			output.Resources = append(output.Resources, ResourceLink{URI: content.URI, Name: content.Name, Title: content.Title, Description: content.Description, MediaType: content.MIMEType})
		case *mcp.EmbeddedResource:
			if content.Resource == nil {
				continue
			}
			if content.Resource.Text != "" {
				textBytes += int64(len(content.Resource.Text))
				if textBytes <= config.MaxTextBytes {
					texts = append(texts, content.Resource.Text)
					continue
				}
			}
			data := content.Resource.Blob
			if len(data) == 0 {
				data = []byte(content.Resource.Text)
			}
			artifact, err := writeArtifact(artifactDir, "resource", content.Resource.MIMEType, data, artifactIndex, config.MaxBinaryBytes)
			if err != nil {
				return Output{}, err
			}
			artifactIndex++
			output.Artifacts = append(output.Artifacts, artifact)
		}
	}
	output.Text = strings.Join(texts, "\n")
	if output.Result == nil {
		if output.Text != "" && json.Unmarshal([]byte(output.Text), &output.Result) != nil {
			output.Result = map[string]any{"text": output.Text}
		}
		if output.Result == nil {
			output.Result = map[string]any{}
		}
	}
	return output, nil
}

func writeArtifact(dir, kind, mediaType string, data []byte, index int, limit int64) (Artifact, error) {
	if int64(len(data)) > limit {
		return Artifact{}, errors.New("MCP binary result exceeds configured limit")
	}
	if dir == "" {
		return Artifact{}, errors.New("artifact directory is required for MCP binary or large content")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return Artifact{}, fmt.Errorf("create MCP artifact directory: %w", err)
	}
	name := fmt.Sprintf("mcp-%d%s", index+1, extensionForMediaType(mediaType))
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o640); err != nil {
		return Artifact{}, fmt.Errorf("write MCP artifact: %w", err)
	}
	return Artifact{Kind: kind, Path: name, MediaType: mediaType, Size: len(data)}, nil
}

func extensionForMediaType(value string) string {
	switch strings.ToLower(strings.Split(value, ";")[0]) {
	case "text/plain":
		return ".txt"
	case "text/markdown":
		return ".md"
	case "application/json":
		return ".json"
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "audio/mpeg":
		return ".mp3"
	case "audio/wav":
		return ".wav"
	default:
		return ".bin"
	}
}
