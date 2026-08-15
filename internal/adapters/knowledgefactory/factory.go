package knowledgefactory

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/ragflow"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/raglite"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func New(cfg config.Config, ids *knowledgeid.Codec) (ports.KnowledgeProvider, error) {
	if ids == nil {
		return nil, errors.New("knowledge ID codec is required")
	}
	endpoint := cfg.Endpoints[config.CapabilityKnowledge]
	if endpoint == "" {
		return nil, errors.New("knowledge provider endpoint is required")
	}
	timeout := cfg.KnowledgeTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = timeout
	httpClient := &http.Client{Transport: transport, Timeout: timeout}
	tokenSource := func() (string, error) {
		content, err := os.ReadFile(cfg.KnowledgeTokenFile)
		return strings.TrimSpace(string(content)), err
	}
	switch cfg.KnowledgeProvider {
	case "ragflow":
		client, err := ragflow.NewClient(endpoint, tokenSource, ragflow.ClientOptions{
			HTTPClient: httpClient, ReadAttempts: 2,
		})
		if err != nil {
			return nil, err
		}
		return ragflow.NewProvider(client, ids, cfg.KnowledgeEmbedding)
	case "raglite":
		client, err := raglite.NewClient(endpoint, tokenSource, httpClient)
		if err != nil {
			return nil, err
		}
		return raglite.NewProvider(client, ids)
	default:
		return nil, errors.New("unsupported knowledge provider")
	}
}
