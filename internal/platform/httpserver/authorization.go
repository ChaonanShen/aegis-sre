package httpserver

import (
	"context"
	"net/http"
	"strings"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

const (
	headerFolderUID    = "X-Aegis-Folder-UID"
	headerFolderAccess = "X-Aegis-Folder-Access"
	headerRoles        = "X-Aegis-Roles"
)

type folderAccess uint8

const (
	folderAccessNone folderAccess = iota
	folderAccessRead
	folderAccessWrite
	folderAccessAdmin
)

type requestAuthorization struct {
	actor  domain.ActorContext
	folder folderAuthorization
}

type folderAuthorization struct {
	uid    string
	access folderAccess
}

type requestAuthorizationContextKey struct{}

// requireRequestAuthorization 只信任已通过 Plugin Token 校验的代理 Header，并一次性固化为请求上下文。
func requireRequestAuthorization(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authorization, status, detail := parseRequestAuthorization(request)
		if status != 0 {
			code := "forbidden"
			if status == http.StatusUnauthorized {
				code = "unauthenticated"
			}
			writeAPIProblem(w, request, status, code, detail, false)
			return
		}
		ctx := context.WithValue(request.Context(), requestAuthorizationContextKey{}, authorization)
		next.ServeHTTP(w, request.WithContext(ctx))
	})
}

func parseRequestAuthorization(request *http.Request) (requestAuthorization, int, string) {
	actor := domain.ActorContext{
		TenantID: safeID(request.Header.Get(headerTenantID)),
		OrgID:    safeID(request.Header.Get(headerOrgID)),
		UserID:   safeID(request.Header.Get(headerUserID)),
		Roles:    parseRoles(request.Header.Get(headerRoles)),
	}
	if err := actor.Validate(); err != nil {
		return requestAuthorization{}, http.StatusUnauthorized, "actor context is incomplete"
	}
	folderUID := safeID(request.Header.Get(headerFolderUID))
	accessValue := strings.TrimSpace(request.Header.Get(headerFolderAccess))
	if folderUID == "" && accessValue == "" {
		return requestAuthorization{actor: actor}, 0, ""
	}
	if folderUID == "" || accessValue == "" {
		return requestAuthorization{}, http.StatusForbidden, "trusted Folder context is incomplete"
	}
	if strings.ContainsAny(folderUID, "/\\") {
		return requestAuthorization{}, http.StatusForbidden, "trusted Folder context is invalid"
	}
	access, ok := parseFolderAccess(accessValue)
	if !ok {
		return requestAuthorization{}, http.StatusForbidden, "trusted Folder permission is invalid"
	}
	actor.FolderUID = folderUID
	return requestAuthorization{actor: actor, folder: folderAuthorization{uid: folderUID, access: access}}, 0, ""
}

func parseFolderAccess(value string) (folderAccess, bool) {
	switch value {
	case "read":
		return folderAccessRead, true
	case "write":
		return folderAccessWrite, true
	case "admin":
		return folderAccessAdmin, true
	default:
		return folderAccessNone, false
	}
}

func parseRoles(value string) []string {
	fields := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ';' })
	roles := make([]string, 0, len(fields))
	for _, field := range fields {
		if role := strings.TrimSpace(field); role != "" {
			roles = append(roles, role)
		}
	}
	return roles
}

func authorizationFromRequest(request *http.Request) (requestAuthorization, bool) {
	authorization, ok := request.Context().Value(requestAuthorizationContextKey{}).(requestAuthorization)
	return authorization, ok
}

func actorFromRequest(request *http.Request) domain.ActorContext {
	authorization, ok := authorizationFromRequest(request)
	if !ok {
		return domain.ActorContext{}
	}
	return authorization.actor
}

func requireFolderAccess(w http.ResponseWriter, request *http.Request, required folderAccess) (domain.ActorContext, bool) {
	authorization, ok := authorizationFromRequest(request)
	if !ok {
		writeAPIProblem(w, request, http.StatusUnauthorized, "unauthenticated", "trusted authorization context is required", false)
		return domain.ActorContext{}, false
	}
	if authorization.folder.uid == "" || authorization.folder.access < required {
		writeAPIProblem(w, request, http.StatusForbidden, "forbidden", "required Folder permission is unavailable", false)
		return domain.ActorContext{}, false
	}
	return authorization.actor, true
}
