package plugin

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPluginManifestRegistersKnowledgeFolderActionsAndIAM(t *testing.T) {
	content, err := os.ReadFile("../../src/plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		IAM struct {
			Permissions []struct {
				Action string `json:"action"`
				Scope  string `json:"scope"`
			} `json:"permissions"`
		} `json:"iam"`
		ActionSets []struct {
			Action  string   `json:"action"`
			Actions []string `json:"actions"`
		} `json:"actionSets"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.IAM.Permissions) != 1 || manifest.IAM.Permissions[0].Action != "users.permissions:read" || manifest.IAM.Permissions[0].Scope != "users:*" {
		t.Fatalf("IAM permissions = %+v", manifest.IAM.Permissions)
	}
	want := map[string]string{"folders:view": actionKnowledgeRead, "folders:edit": actionKnowledgeWrite, "folders:admin": actionKnowledgeWrite}
	for _, set := range manifest.ActionSets {
		if len(set.Actions) == 1 && want[set.Action] == set.Actions[0] {
			delete(want, set.Action)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing action sets: %+v", want)
	}
}
