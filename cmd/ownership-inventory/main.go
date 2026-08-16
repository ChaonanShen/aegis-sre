// ownership-inventory 是只读治理命令：以 Grafana Folder 为事实来源枚举 Provider orphan，不执行修复。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/dagu"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgefactory"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func main() {
	grafanaURL := flag.String("grafana-url", "http://localhost:3000", "Grafana HTTP origin")
	username := flag.String("username", "admin", "Grafana administrator")
	passwordFile := flag.String("password-file", "", "Grafana administrator password file")
	tenantID := flag.String("tenant-id", "", "Aegis tenant ID")
	orgID := flag.String("org-id", "", "Grafana organization ID")
	flag.Parse()
	if err := run(context.Background(), *grafanaURL, *username, *passwordFile, *tenantID, *orgID); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "ownership-inventory:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, grafanaURL, username, passwordFile, tenantID, orgID string) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	if tenantID == "" {
		tenantID = cfg.AgentTenantID
	}
	if orgID == "" {
		orgID = cfg.AgentOrgID
	}
	base := domain.ActorContext{TenantID: tenantID, OrgID: orgID, UserID: "ownership-inventory"}
	if err := base.Validate(); err != nil {
		return errors.New("tenant-id and org-id are required")
	}
	password, err := readSecret(passwordFile)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	folders, err := listGrafanaFolders(ctx, client, grafanaURL, username, password)
	if err != nil {
		return err
	}
	providers, err := inventoryProviders(cfg, client)
	if err != nil {
		return err
	}
	result := make([]ports.RootResourceOwnership, 0)
	for _, provider := range providers {
		items, err := provider.InventoryOwnership(ctx, base, folders)
		if err != nil {
			return err
		}
		result = append(result, items...)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Kind+string(result[i].ID) < result[j].Kind+string(result[j].ID)
	})
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"folders": folders, "resources": result})
}

func inventoryProviders(cfg config.Config, client *http.Client) ([]ports.OwnershipInventoryProvider, error) {
	output := make([]ports.OwnershipInventoryProvider, 0, 2)
	if endpoint := cfg.Endpoints[config.CapabilityPlaybook]; endpoint != "" {
		var token dagu.TokenSource
		if cfg.DaguTokenFile != "" {
			token = func() (string, error) { return readSecret(cfg.DaguTokenFile) }
		}
		var basic dagu.BasicAuthSource
		if cfg.DaguBasicPass != "" {
			basic = func() (string, string, error) {
				password, err := readSecret(cfg.DaguBasicPass)
				return cfg.DaguBasicUser, password, err
			}
		}
		daguClient, err := dagu.NewClient(endpoint, client, dagu.WithTokenSource(token), dagu.WithBasicAuthSource(basic))
		if err != nil {
			return nil, err
		}
		options := []dagu.ProviderOption{}
		if cfg.PlaybookLegacyFolder != "" {
			options = append(options, dagu.WithLegacyFolderUID(cfg.PlaybookLegacyFolder))
		}
		provider, err := dagu.NewProvider(daguClient, options...)
		if err != nil {
			return nil, err
		}
		output = append(output, provider)
	}
	if cfg.Endpoints[config.CapabilityKnowledge] != "" {
		content, err := os.ReadFile(cfg.KnowledgeIDKeyFile)
		if err != nil {
			return nil, err
		}
		key, err := knowledgeid.DecodeKey(content)
		if err != nil {
			return nil, err
		}
		codec, _ := knowledgeid.New(key)
		provider, err := knowledgefactory.New(cfg, codec)
		if err != nil {
			return nil, err
		}
		inventory, ok := provider.(ports.OwnershipInventoryProvider)
		if !ok {
			return nil, errors.New("knowledge provider does not support ownership inventory")
		}
		output = append(output, inventory)
	}
	return output, nil
}

func listGrafanaFolders(ctx context.Context, client *http.Client, rawURL, username, password string) ([]string, error) {
	base, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, errors.New("Grafana URL must be an HTTP origin")
	}
	endpoint := base.ResolveReference(&url.URL{Path: "/api/folders", RawQuery: "limit=1000"})
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	request.SetBasicAuth(username, password)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Grafana Folder API returned HTTP %d", response.StatusCode)
	}
	var values []struct {
		UID string `json:"uid"`
	}
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		return nil, errors.New("decode Grafana Folder response")
	}
	folders := make([]string, 0, len(values))
	for _, value := range values {
		if value.UID != "" {
			folders = append(folders, value.UID)
		}
	}
	sort.Strings(folders)
	return folders, nil
}

func readSecret(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(content))
	if value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("secret is invalid")
	}
	return value, nil
}
