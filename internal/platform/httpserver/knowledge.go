package httpserver

import (
	"net/http"

	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func registerKnowledgeHandlers(_ *http.ServeMux, provider ports.KnowledgeProvider, ids ports.KnowledgeIDGenerator) {
	if provider == nil || ids == nil {
		return
	}
}
