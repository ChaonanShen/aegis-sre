package httpserver

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestRequestAuthorizationBuildsTrustedContext(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
	request.Header.Set(headerTenantID, "tenant-a")
	request.Header.Set(headerOrgID, "org-a")
	request.Header.Set(headerUserID, "user-a")
	request.Header.Set(headerRoles, "Viewer, Editor ; Admin")
	request.Header.Set(headerFolderUID, "folder-a")
	request.Header.Set(headerFolderAccess, "admin")

	called := false
	handler := requireRequestAuthorization(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		called = true
		authorization, ok := authorizationFromRequest(request)
		if !ok {
			t.Fatal("authorization context is missing")
		}
		if authorization.actor.TenantID != "tenant-a" || authorization.actor.OrgID != "org-a" || authorization.actor.UserID != "user-a" || authorization.actor.FolderUID != "folder-a" {
			t.Fatalf("actor = %+v", authorization.actor)
		}
		if !reflect.DeepEqual(authorization.actor.Roles, []string{"Viewer", "Editor", "Admin"}) {
			t.Fatalf("roles = %#v", authorization.actor.Roles)
		}
		if authorization.folder.uid != "folder-a" || authorization.folder.access != folderAccessAdmin {
			t.Fatalf("folder = %+v", authorization.folder)
		}
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !called {
		t.Fatalf("status = %d, called = %v", response.Code, called)
	}
}

func TestRequestAuthorizationRejectsInvalidAssertions(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*http.Request)
		status int
	}{
		{name: "missing actor", mutate: func(request *http.Request) { request.Header.Del(headerUserID) }, status: http.StatusUnauthorized},
		{name: "folder without access", mutate: func(request *http.Request) { request.Header.Del(headerFolderAccess) }, status: http.StatusForbidden},
		{name: "access without folder", mutate: func(request *http.Request) { request.Header.Del(headerFolderUID) }, status: http.StatusForbidden},
		{name: "unknown access", mutate: func(request *http.Request) { request.Header.Set(headerFolderAccess, "owner") }, status: http.StatusForbidden},
		{name: "unsafe folder", mutate: func(request *http.Request) { request.Header.Set(headerFolderUID, "../folder-a") }, status: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
			request.Header.Set(headerTenantID, "tenant-a")
			request.Header.Set(headerOrgID, "org-a")
			request.Header.Set(headerUserID, "user-a")
			request.Header.Set(headerFolderUID, "folder-a")
			request.Header.Set(headerFolderAccess, "write")
			test.mutate(request)
			response := httptest.NewRecorder()
			requireRequestAuthorization(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("invalid authorization reached handler")
			})).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, test.status, response.Body.String())
			}
		})
	}
}

func TestRequireFolderAccessUsesHierarchy(t *testing.T) {
	tests := []struct {
		name     string
		granted  string
		required folderAccess
		status   int
	}{
		{name: "read grants read", granted: "read", required: folderAccessRead, status: http.StatusNoContent},
		{name: "read denies write", granted: "read", required: folderAccessWrite, status: http.StatusForbidden},
		{name: "write grants read", granted: "write", required: folderAccessRead, status: http.StatusNoContent},
		{name: "write denies admin", granted: "write", required: folderAccessAdmin, status: http.StatusForbidden},
		{name: "admin grants write", granted: "admin", required: folderAccessWrite, status: http.StatusNoContent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/test", nil)
			request.Header.Set(headerTenantID, "tenant-a")
			request.Header.Set(headerOrgID, "org-a")
			request.Header.Set(headerUserID, "user-a")
			request.Header.Set(headerFolderUID, "folder-a")
			request.Header.Set(headerFolderAccess, test.granted)
			response := httptest.NewRecorder()
			handler := requireRequestAuthorization(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				actor, ok := requireFolderAccess(w, request, test.required)
				if ok {
					if actor.FolderUID != "folder-a" {
						t.Fatalf("actor = %+v", actor)
					}
					w.WriteHeader(http.StatusNoContent)
				}
			}))
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
		})
	}
}
