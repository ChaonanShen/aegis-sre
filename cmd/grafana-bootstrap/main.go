package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	baseURL := flag.String("grafana-url", "http://grafana:3000", "Grafana HTTP origin")
	username := flag.String("username", "admin", "Grafana bootstrap administrator")
	passwordFile := flag.String("password-file", "", "Grafana administrator password file")
	outputFile := flag.String("output-file", "", "service-account token output file")
	var rawFolders stringList
	flag.Var(&rawFolders, "ensure-folder", "ensure a local Grafana Folder exists (uid:title); repeatable")
	flag.Parse()
	folders, err := parseFolders(rawFolders)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "grafana-bootstrap:", err)
		os.Exit(1)
	}
	if err := bootstrap(*baseURL, *username, *passwordFile, *outputFile, folders, &http.Client{Timeout: 10 * time.Second}); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "grafana-bootstrap:", err)
		os.Exit(1)
	}
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }
func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type folderSpec struct {
	uid   string
	title string
}

func parseFolders(values []string) ([]folderSpec, error) {
	folders := make([]folderSpec, 0, len(values))
	for _, value := range values {
		uid, title, ok := strings.Cut(strings.TrimSpace(value), ":")
		uid, title = strings.TrimSpace(uid), strings.TrimSpace(title)
		if !ok || uid == "" || title == "" || strings.ContainsAny(uid, "/\\?&#\r\n\x00") || strings.ContainsAny(title, "\r\n\x00") {
			return nil, fmt.Errorf("invalid --ensure-folder %q; expected uid:title", value)
		}
		folders = append(folders, folderSpec{uid: uid, title: title})
	}
	return folders, nil
}

func bootstrap(rawURL, username, passwordFile, outputFile string, folders []folderSpec, client *http.Client) error {
	if token, _ := readSecret(outputFile); token != "" {
		// 共享卷中的消费者以非 root 身份运行，已有凭据也要修正为可读模式。
		if len(folders) == 0 {
			return os.Chmod(outputFile, 0o644)
		}
	}
	base, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return errors.New("Grafana URL must be an HTTP origin")
	}
	password, err := readSecret(passwordFile)
	if err != nil {
		return fmt.Errorf("read Grafana administrator password: %w", err)
	}
	if strings.TrimSpace(username) == "" || outputFile == "" {
		return errors.New("username and output file are required")
	}
	for _, folder := range folders {
		if err := ensureFolder(client, base, username, password, folder); err != nil {
			return fmt.Errorf("ensure Grafana Folder %q: %w", folder.uid, err)
		}
	}
	if token, _ := readSecret(outputFile); token != "" {
		return os.Chmod(outputFile, 0o644)
	}

	var account struct {
		ID int64 `json:"id"`
	}
	for attempt := 0; ; attempt++ {
		err = grafanaJSON(client, base, username, password, http.MethodPost, "/api/serviceaccounts", map[string]any{
			"name": "aegis-grafana-read", "role": "Viewer", "isDisabled": false,
		}, &account)
		if err == nil {
			break
		}
		if attempt >= 29 {
			return fmt.Errorf("create Grafana service account: %w", err)
		}
		time.Sleep(time.Second)
	}
	var token struct {
		Key string `json:"key"`
	}
	path := fmt.Sprintf("/api/serviceaccounts/%d/tokens", account.ID)
	if err := grafanaJSON(client, base, username, password, http.MethodPost, path, map[string]any{
		"name": "aegis-local-read", "secondsToLive": 0,
	}, &token); err != nil {
		return fmt.Errorf("create Grafana service account token: %w", err)
	}
	if token.Key == "" || strings.ContainsAny(token.Key, "\r\n\x00") {
		return errors.New("Grafana returned an invalid service account token")
	}
	if err := os.MkdirAll(filepath.Dir(outputFile), 0o700); err != nil {
		return fmt.Errorf("create token directory: %w", err)
	}
	// Token volume is mounted read-only into the non-root Grafana MCP container.
	if err := os.WriteFile(outputFile, []byte(token.Key), 0o644); err != nil {
		return fmt.Errorf("write service account token: %w", err)
	}
	return nil
}

func ensureFolder(client *http.Client, base *url.URL, username, password string, folder folderSpec) error {
	path := "/api/folders/" + url.PathEscape(folder.uid)
	for attempt := 0; ; attempt++ {
		status, err := grafanaStatus(client, base, username, password, http.MethodGet, path, nil)
		if err == nil && status == http.StatusOK {
			return nil
		}
		if err == nil && status == http.StatusNotFound {
			status, err = grafanaStatus(client, base, username, password, http.MethodPost, "/api/folders", map[string]string{"uid": folder.uid, "title": folder.title})
			if err == nil && (status == http.StatusOK || status == http.StatusCreated || status == http.StatusConflict) {
				return nil
			}
		}
		if attempt >= 29 {
			if err != nil {
				return err
			}
			return fmt.Errorf("Grafana API returned HTTP %d", status)
		}
		time.Sleep(time.Second)
	}
}

func grafanaStatus(client *http.Client, base *url.URL, username, password, method, path string, input any) (int, error) {
	var content io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return 0, err
		}
		content = bytes.NewReader(encoded)
	}
	endpoint := base.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequest(method, endpoint.String(), content)
	if err != nil {
		return 0, err
	}
	request.SetBasicAuth(username, password)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, nil
}

func grafanaJSON(client *http.Client, base *url.URL, username, password, method, path string, input, output any) error {
	content, err := json.Marshal(input)
	if err != nil {
		return err
	}
	endpoint := base.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequest(method, endpoint.String(), bytes.NewReader(content))
	if err != nil {
		return err
	}
	request.SetBasicAuth(username, password)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Grafana API returned HTTP %d", response.StatusCode)
	}
	if err := json.Unmarshal(body, output); err != nil {
		return errors.New("decode Grafana response")
	}
	return nil
}

func readSecret(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(content))
	if value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("secret is empty or invalid")
	}
	return value, nil
}
