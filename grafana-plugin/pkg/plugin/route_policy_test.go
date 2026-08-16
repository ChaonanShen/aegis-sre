package plugin

import (
	"net/http"
	"net/url"
	"testing"
)

func TestRoutePolicyFor(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		access folderAccess
	}{
		{name: "capabilities", method: http.MethodGet, path: "/api/v1/capabilities"},
		{name: "session list", method: http.MethodGet, path: "/api/v1/sessions"},
		{name: "session create", method: http.MethodPost, path: "/api/v1/sessions"},
		{name: "session update", method: http.MethodPatch, path: "/api/v1/sessions/session-1"},
		{name: "canvas write", method: http.MethodPut, path: "/api/v1/sessions/session-1/canvas"},
		{name: "turn start", method: http.MethodPost, path: "/api/v1/sessions/session-1/turns:stream", access: folderAccessRead},
		{name: "turn cancel", method: http.MethodPost, path: "/api/v1/sessions/session-1/turns/turn-1:cancel"},
		{name: "agent approval", method: http.MethodPost, path: "/api/v1/sessions/session-1/approvals/approval-1:resolve", access: folderAccessAdmin},
		{name: "services", method: http.MethodGet, path: "/api/v1/services", access: folderAccessRead},
		{name: "knowledge search", method: http.MethodPost, path: "/api/v1/knowledge:search", access: folderAccessRead},
		{name: "knowledge list", method: http.MethodGet, path: "/api/v1/knowledge-bases", access: folderAccessRead},
		{name: "knowledge create", method: http.MethodPost, path: "/api/v1/knowledge-bases", access: folderAccessWrite},
		{name: "knowledge delete", method: http.MethodDelete, path: "/api/v1/knowledge-bases/kb-1", access: folderAccessAdmin},
		{name: "document list", method: http.MethodGet, path: "/api/v1/knowledge-bases/kb-1/documents", access: folderAccessRead},
		{name: "document update", method: http.MethodPatch, path: "/api/v1/knowledge-bases/kb-1/documents/doc-1", access: folderAccessWrite},
		{name: "document index", method: http.MethodPost, path: "/api/v1/knowledge-bases/kb-1/documents/doc-1:index", access: folderAccessWrite},
		{name: "document chunks", method: http.MethodGet, path: "/api/v1/knowledge-bases/kb-1/documents/doc-1/chunks", access: folderAccessRead},
		{name: "playbook list", method: http.MethodGet, path: "/api/v1/playbooks", access: folderAccessRead},
		{name: "playbook create", method: http.MethodPost, path: "/api/v1/playbooks", access: folderAccessWrite},
		{name: "playbook validate", method: http.MethodPost, path: "/api/v1/playbooks/validate", access: folderAccessWrite},
		{name: "playbook delete", method: http.MethodDelete, path: "/api/v1/playbooks/playbook-1", access: folderAccessAdmin},
		{name: "run start", method: http.MethodPost, path: "/api/v1/playbooks/playbook-1/runs", access: folderAccessWrite},
		{name: "run get", method: http.MethodGet, path: "/api/v1/runs/run-1", access: folderAccessRead},
		{name: "run cancel", method: http.MethodPost, path: "/api/v1/runs/run-1:cancel", access: folderAccessWrite},
		{name: "run events", method: http.MethodGet, path: "/api/v1/runs/run-1/events", access: folderAccessRead},
		{name: "artifact download", method: http.MethodGet, path: "/api/v1/runs/run-1/artifacts/download", access: folderAccessRead},
		{name: "human task", method: http.MethodPost, path: "/api/v1/runs/run-1/human-tasks/task-1:complete", access: folderAccessWrite},
		{name: "playbook approval", method: http.MethodPost, path: "/api/v1/runs/run-1/approvals/approval-1:resolve", access: folderAccessAdmin},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policy, ok := routePolicyFor(&http.Request{Method: test.method, URL: &url.URL{Path: test.path}})
			if !ok {
				t.Fatal("route unexpectedly rejected")
			}
			if policy.access != test.access {
				t.Fatalf("access = %q, want %q", policy.access, test.access)
			}
		})
	}
}

func TestRoutePolicyForAcceptsHeadAsRead(t *testing.T) {
	policy, ok := routePolicyFor(&http.Request{Method: http.MethodHead, URL: &url.URL{Path: "/api/v1/playbooks/playbook-1"}})
	if !ok || policy.access != folderAccessRead {
		t.Fatalf("policy = %+v, ok = %v", policy, ok)
	}
}

func TestRoutePolicyForRejectsUnknownRoutesAndMethods(t *testing.T) {
	tests := []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/unknown"},
		{method: http.MethodPost, path: "/api/v1/services"},
		{method: http.MethodGet, path: "/api/v1/playbooks/validate"},
		{method: http.MethodGet, path: "/api/v1/playbooks/"},
		{method: http.MethodGet, path: "/api/v1/playbooks/../runs"},
	}
	for _, test := range tests {
		if policy, ok := routePolicyFor(&http.Request{Method: test.method, URL: &url.URL{Path: test.path}}); ok {
			t.Fatalf("%s %s unexpectedly accepted as %+v", test.method, test.path, policy)
		}
	}
}

func TestRoutePolicyActions(t *testing.T) {
	tests := []struct {
		access folderAccess
		action string
	}{
		{access: folderAccessNone, action: ""},
		{access: folderAccessRead, action: actionFolderResourcesRead},
		{access: folderAccessWrite, action: actionFolderResourcesWrite},
		{access: folderAccessAdmin, action: actionFolderResourcesAdmin},
	}
	for _, test := range tests {
		if got := (routePolicy{access: test.access}).action(); got != test.action {
			t.Fatalf("action for %q = %q, want %q", test.access, got, test.action)
		}
	}
}
