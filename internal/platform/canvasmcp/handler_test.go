package canvasmcp

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	canvasapp "github.com/1024XEngineer/aegis-sre/internal/application/canvas"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

func TestHandlerRequiresIndependentTokenAndActor(t *testing.T) {
	if _, err := NewHandler(nil, Config{TokenFile: "token", TenantID: "t", OrgID: "o", UserID: "u"}); err == nil {
		t.Fatal("nil service accepted")
	}
	if _, err := NewHandler(canvasapp.New(&contracttest.AgentProvider{}, nil), Config{TenantID: "t", OrgID: "o", UserID: "u"}); err == nil {
		t.Fatal("missing token accepted")
	}
}

func TestHandlerRejectsMissingOrWrongBearerToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "canvas-token")
	if err := os.WriteFile(path, []byte("canvas-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(canvasapp.New(&contracttest.AgentProvider{}, nil), Config{TokenFile: path, TenantID: "t", OrgID: "o", UserID: "u"})
	if err != nil {
		t.Fatal(err)
	}
	for _, authorization := range []string{"", "Bearer wrong"} {
		request := httptest.NewRequest(http.MethodPost, "/mcp/canvas", nil)
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("authorization=%q status=%d", authorization, response.Code)
		}
	}
}
