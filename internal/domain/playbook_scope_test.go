package domain

import "testing"

func TestPlaybookScopeSeparatesFoldersAndPreservesLegacyOrgScope(t *testing.T) {
	actorA := ActorContext{TenantID: "tenant", OrgID: "org", FolderUID: "folder-a"}
	actorB := ActorContext{TenantID: "tenant", OrgID: "org", FolderUID: "folder-b"}
	current := ID("pbk_" + PlaybookScopeKey(actorA) + "_abcdefgh")
	legacy := ID("pbk_" + PlaybookLegacyScopeKey(actorA) + "_abcdefgh")

	if !PlaybookIDInScope(current, actorA) || PlaybookIDInScope(current, actorB) {
		t.Fatal("current Playbook scope must include the exact Folder")
	}
	if !PlaybookIDInLegacyScope(legacy, actorA) || !PlaybookIDInLegacyScope(legacy, actorB) {
		t.Fatal("legacy Playbook scope must remain organization-wide")
	}
	if !PlaybookIDVisibleInScope(current, actorA) || !PlaybookIDVisibleInScope(legacy, actorA) {
		t.Fatal("visible scope must accept both current and legacy IDs")
	}
}
