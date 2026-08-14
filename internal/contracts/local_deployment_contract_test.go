package contracts_test

import (
	"os"
	"strings"
	"testing"
)

func TestLocalPluginProvisioningUsesRealRuntime(t *testing.T) {
	content, err := os.ReadFile("../../grafana-plugin/provisioning/plugins/apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "workbenchMode: fixture") {
		t.Fatal("local Grafana provisioning must not enable fixture runtime")
	}
	if !strings.Contains(string(content), "workbenchMode: real") {
		t.Fatal("local Grafana provisioning must explicitly overwrite stale fixture mode")
	}
}
