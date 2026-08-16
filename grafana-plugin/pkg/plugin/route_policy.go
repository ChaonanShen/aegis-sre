package plugin

import (
	"net/http"
	"strings"
)

const (
	actionFolderResourcesRead  = "grafana-plugin-app.folder-resources:read"
	actionFolderResourcesWrite = "grafana-plugin-app.folder-resources:write"
	actionFolderResourcesAdmin = "grafana-plugin-app.folder-resources:admin"
	actionKnowledgeRead        = "grafana-plugin-app.knowledge:read"
	actionKnowledgeWrite       = "grafana-plugin-app.knowledge:write"
)

type folderAccess string

const (
	folderAccessNone  folderAccess = ""
	folderAccessRead  folderAccess = "read"
	folderAccessWrite folderAccess = "write"
	folderAccessAdmin folderAccess = "admin"
)

type routePolicy struct {
	access folderAccess
}

func (policy routePolicy) action() string {
	switch policy.access {
	case folderAccessRead:
		return actionFolderResourcesRead
	case folderAccessWrite:
		return actionFolderResourcesWrite
	case folderAccessAdmin:
		return actionFolderResourcesAdmin
	default:
		return ""
	}
}

// routePolicyFor 是插件代理的权限白名单；新增 Control Plane 路由时必须在这里明确归类。
func routePolicyFor(request *http.Request) (routePolicy, bool) {
	segments, ok := apiPathSegments(request.URL.Path)
	if !ok {
		return routePolicy{}, false
	}
	switch segments[0] {
	case "capabilities":
		return policyForCapabilities(request.Method, segments)
	case "sessions":
		return policyForSessions(request.Method, segments)
	case "services":
		return routePolicy{access: folderAccessRead}, len(segments) == 1 && methodMatches(request.Method, http.MethodGet)
	case "knowledge:search":
		return routePolicy{access: folderAccessRead}, len(segments) == 1 && request.Method == http.MethodPost
	case "knowledge-bases":
		return policyForKnowledge(request.Method, segments)
	case "playbooks":
		return policyForPlaybooks(request.Method, segments)
	case "runs":
		return policyForRuns(request.Method, segments)
	default:
		return routePolicy{}, false
	}
}

func policyForCapabilities(method string, segments []string) (routePolicy, bool) {
	return routePolicy{}, len(segments) == 1 && methodMatches(method, http.MethodGet)
}

func policyForSessions(method string, segments []string) (routePolicy, bool) {
	switch len(segments) {
	case 1:
		return routePolicy{}, methodMatches(method, http.MethodGet) || method == http.MethodPost
	case 2:
		return routePolicy{}, methodMatches(method, http.MethodGet) || method == http.MethodPatch || method == http.MethodDelete
	case 3:
		switch segments[2] {
		case "canvas":
			return routePolicy{}, methodMatches(method, http.MethodGet) || method == http.MethodPut
		case "turns:stream":
			return routePolicy{access: folderAccessRead}, method == http.MethodPost
		}
	case 4:
		if segments[2] == "turns" && strings.HasSuffix(segments[3], ":cancel") {
			// 取消只能减少已有执行的影响，Session owner 不应因 Folder 权限撤销而失去停止能力。
			return routePolicy{}, method == http.MethodPost
		}
		if segments[2] == "approvals" && strings.HasSuffix(segments[3], ":resolve") {
			return routePolicy{access: folderAccessAdmin}, method == http.MethodPost
		}
	}
	return routePolicy{}, false
}

func policyForKnowledge(method string, segments []string) (routePolicy, bool) {
	switch len(segments) {
	case 1:
		if methodMatches(method, http.MethodGet) {
			return routePolicy{access: folderAccessRead}, true
		}
		return routePolicy{access: folderAccessWrite}, method == http.MethodPost
	case 2:
		switch {
		case methodMatches(method, http.MethodGet):
			return routePolicy{access: folderAccessRead}, true
		case method == http.MethodPut:
			return routePolicy{access: folderAccessWrite}, true
		case method == http.MethodDelete:
			return routePolicy{access: folderAccessAdmin}, true
		}
	case 3:
		if segments[2] == "scope-migrations" {
			return routePolicy{access: folderAccessAdmin}, method == http.MethodPost
		}
		if segments[2] != "documents" {
			break
		}
		if methodMatches(method, http.MethodGet) {
			return routePolicy{access: folderAccessRead}, true
		}
		return routePolicy{access: folderAccessWrite}, method == http.MethodPost
	case 4:
		if segments[2] != "documents" {
			break
		}
		if strings.HasSuffix(segments[3], ":index") || strings.HasSuffix(segments[3], ":stop") {
			return routePolicy{access: folderAccessWrite}, method == http.MethodPost
		}
		if methodMatches(method, http.MethodGet) {
			return routePolicy{access: folderAccessRead}, true
		}
		return routePolicy{access: folderAccessWrite}, method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
	case 5:
		if segments[2] == "documents" && (segments[4] == "chunks" || segments[4] == "content") {
			return routePolicy{access: folderAccessRead}, methodMatches(method, http.MethodGet)
		}
	}
	return routePolicy{}, false
}

func policyForPlaybooks(method string, segments []string) (routePolicy, bool) {
	switch len(segments) {
	case 1:
		if methodMatches(method, http.MethodGet) {
			return routePolicy{access: folderAccessRead}, true
		}
		return routePolicy{access: folderAccessWrite}, method == http.MethodPost
	case 2:
		if segments[1] == "validate" {
			return routePolicy{access: folderAccessWrite}, method == http.MethodPost
		}
		switch {
		case methodMatches(method, http.MethodGet):
			return routePolicy{access: folderAccessRead}, true
		case method == http.MethodPut:
			return routePolicy{access: folderAccessWrite}, true
		case method == http.MethodDelete:
			return routePolicy{access: folderAccessAdmin}, true
		}
	case 3:
		if segments[2] == "migrations" {
			return routePolicy{access: folderAccessAdmin}, method == http.MethodPost
		}
		if segments[2] == "validate" {
			return routePolicy{access: folderAccessWrite}, method == http.MethodPost
		}
		if segments[2] == "runs" {
			if methodMatches(method, http.MethodGet) {
				return routePolicy{access: folderAccessRead}, true
			}
			return routePolicy{access: folderAccessWrite}, method == http.MethodPost
		}
	}
	return routePolicy{}, false
}

func policyForRuns(method string, segments []string) (routePolicy, bool) {
	switch len(segments) {
	case 2:
		if strings.HasSuffix(segments[1], ":cancel") || strings.HasSuffix(segments[1], ":retry") {
			return routePolicy{access: folderAccessWrite}, method == http.MethodPost
		}
		return routePolicy{access: folderAccessRead}, methodMatches(method, http.MethodGet)
	case 3:
		if segments[2] == "events" || segments[2] == "artifacts" {
			return routePolicy{access: folderAccessRead}, methodMatches(method, http.MethodGet)
		}
	case 4:
		if segments[2] == "artifacts" && (segments[3] == "preview" || segments[3] == "download") {
			return routePolicy{access: folderAccessRead}, methodMatches(method, http.MethodGet)
		}
		if segments[2] == "human-tasks" && strings.HasSuffix(segments[3], ":complete") {
			return routePolicy{access: folderAccessWrite}, method == http.MethodPost
		}
		if segments[2] == "approvals" && strings.HasSuffix(segments[3], ":resolve") {
			return routePolicy{access: folderAccessAdmin}, method == http.MethodPost
		}
	}
	return routePolicy{}, false
}

func apiPathSegments(path string) ([]string, bool) {
	const prefix = "/api/v1/"
	if !strings.HasPrefix(path, prefix) || strings.HasSuffix(path, "/") {
		return nil, false
	}
	segments := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(segments) == 0 {
		return nil, false
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return nil, false
		}
	}
	return segments, true
}

func methodMatches(actual, expected string) bool {
	return actual == expected || expected == http.MethodGet && actual == http.MethodHead
}
