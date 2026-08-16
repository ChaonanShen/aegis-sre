package dagu

import (
	"strings"
	"testing"
)

func TestBindFolderOwnershipSupportsNativeLabelForms(t *testing.T) {
	tests := []string{
		"labels:\n  team: sre\nsteps:\n  - run: echo ok\n",
		"labels: [team=sre]\nsteps:\n  - run: echo ok\n",
		"labels: team=sre\nsteps:\n  - run: echo ok\n",
		"steps:\n  - run: echo ok\n",
	}
	for _, spec := range tests {
		bound, err := bindFolderOwnership([]byte(spec), "Folder-A")
		if err != nil {
			t.Fatal(err)
		}
		text := string(bound)
		if !strings.Contains(text, "aegis.folder.key:") || !strings.Contains(text, "team: sre") && strings.Contains(spec, "team") {
			t.Fatalf("bound YAML = %s", text)
		}
	}
}

func TestBindFolderOwnershipRejectsReservedLabelConflict(t *testing.T) {
	_, err := bindFolderOwnership([]byte("labels:\n  aegis.folder.key: attacker\nsteps:\n  - run: echo ok\n"), "folder-a")
	if err == nil {
		t.Fatal("expected reserved label conflict")
	}
}

func TestFolderOwnershipKeyPreservesExactUIDSemantics(t *testing.T) {
	if folderOwnershipKey("Folder-A") == folderOwnershipKey("folder-a") {
		t.Fatal("case-sensitive Folder UIDs must not collide")
	}
	labels := expectedOwnershipLabels("Folder-A")
	serialized := []string{
		labelManaged + "=" + labels[labelManaged],
		labelOwnerKind + "=" + labels[labelOwnerKind],
		labelOwnerVersion + "=" + labels[labelOwnerVersion],
		labelFolderKey + "=" + labels[labelFolderKey],
	}
	if !labelsOwnedByFolder(serialized, "Folder-A") || labelsOwnedByFolder(serialized, "folder-a") {
		t.Fatal("ownership comparison did not preserve exact Folder UID")
	}
}
