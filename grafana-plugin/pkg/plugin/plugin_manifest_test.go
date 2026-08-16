package plugin

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestPluginManifestRegistersFolderActionsAndIAM(t *testing.T) {
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
	want := map[string][]string{
		"folders:view":  {actionFolderResourcesRead, actionKnowledgeRead},
		"folders:edit":  {actionFolderResourcesRead, actionFolderResourcesWrite, actionKnowledgeRead, actionKnowledgeWrite},
		"folders:admin": {actionFolderResourcesRead, actionFolderResourcesWrite, actionFolderResourcesAdmin, actionKnowledgeRead, actionKnowledgeWrite},
	}
	for _, set := range manifest.ActionSets {
		if reflect.DeepEqual(want[set.Action], set.Actions) {
			delete(want, set.Action)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing action sets: %+v", want)
	}
}
