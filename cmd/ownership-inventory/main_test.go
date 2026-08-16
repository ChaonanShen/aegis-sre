package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListGrafanaFoldersUsesAuthoritativeAPIAndSortsUIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		user, password, ok := request.BasicAuth()
		if !ok || user != "admin" || password != "secret" || request.URL.Query().Get("limit") != "1000" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`[{"uid":"payment"},{"uid":"infra"}]`))
	}))
	defer server.Close()
	folders, err := listGrafanaFolders(context.Background(), server.Client(), server.URL, "admin", "secret")
	if err != nil || len(folders) != 2 || folders[0] != "infra" || folders[1] != "payment" {
		t.Fatalf("folders=%v err=%v", folders, err)
	}
}
