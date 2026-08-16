package httpserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

func actorRequest(method, target, body string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set(headerTenantID, "tenant")
	request.Header.Set(headerOrgID, "org")
	request.Header.Set(headerUserID, "user")
	request.Header.Set("X-Aegis-Roles", "Editor")
	return request
}
