package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBootstrapCreatesViewerToken(t *testing.T) {
	var accountRole, tokenName string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		username, password, ok := request.BasicAuth()
		if !ok || username != "admin" || password != "admin-secret" {
			t.Fatalf("unexpected basic auth")
		}
		switch request.URL.Path {
		case "/api/serviceaccounts":
			var body struct {
				Role string `json:"role"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			accountRole = body.Role
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":42}`))
		case "/api/serviceaccounts/42/tokens":
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			tokenName = body.Name
			_, _ = w.Write([]byte(`{"key":"generated-token"}`))
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	directory := t.TempDir()
	passwordFile := filepath.Join(directory, "password")
	outputFile := filepath.Join(directory, "token")
	if err := os.WriteFile(passwordFile, []byte("admin-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap(server.URL, "admin", passwordFile, outputFile, nil, server.Client()); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(outputFile)
	if err != nil || string(content) != "generated-token" || accountRole != "Viewer" || tokenName != "aegis-local-read" {
		t.Fatalf("token=%q role=%q name=%q err=%v", content, accountRole, tokenName, err)
	}
	info, err := os.Stat(outputFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("token mode=%v", info.Mode().Perm())
	}
}

func TestBootstrapMakesExistingTokenReadable(t *testing.T) {
	outputFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(outputFile, []byte("existing-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap("invalid", "", "", outputFile, nil, http.DefaultClient); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(outputFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("token mode=%v", info.Mode().Perm())
	}
}

func TestBootstrapEnsuresLocalFoldersEvenWhenTokenExists(t *testing.T) {
	var created []folderSpec
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		username, password, ok := request.BasicAuth()
		if !ok || username != "admin" || password != "admin-secret" {
			t.Fatalf("unexpected basic auth")
		}
		switch request.URL.Path {
		case "/api/folders/infra":
			http.NotFound(w, request)
		case "/api/folders/payment":
			w.WriteHeader(http.StatusOK)
		case "/api/folders":
			var body struct {
				UID   string `json:"uid"`
				Title string `json:"title"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			created = append(created, folderSpec{uid: body.UID, title: body.Title})
			w.WriteHeader(http.StatusCreated)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	directory := t.TempDir()
	passwordFile := filepath.Join(directory, "password")
	outputFile := filepath.Join(directory, "token")
	if err := os.WriteFile(passwordFile, []byte("admin-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputFile, []byte("existing-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	folders := []folderSpec{{uid: "infra", title: "Infrastructure"}, {uid: "payment", title: "Payments"}}
	if err := bootstrap(server.URL, "admin", passwordFile, outputFile, folders, server.Client()); err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || created[0] != folders[0] {
		t.Fatalf("created folders=%#v", created)
	}
}

func TestParseFoldersRejectsInvalidValues(t *testing.T) {
	if _, err := parseFolders([]string{"infra"}); err == nil {
		t.Fatal("expected invalid Folder argument to fail")
	}
}
