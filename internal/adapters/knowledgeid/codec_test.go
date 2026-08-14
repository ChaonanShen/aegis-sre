package knowledgeid

import (
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

func TestCollectionIDIsStableAndBoundToTrustedScope(t *testing.T) {
	codec, err := New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	actor := domain.ActorContext{TenantID: "tenant-a", OrgID: "org-a", UserID: "user-a", FolderUID: "folder-a"}
	first, err := codec.CollectionID(actor, "request-1")
	if err != nil {
		t.Fatal(err)
	}
	second, _ := codec.CollectionID(actor, "request-1")
	if first != second || !first.Valid() || !strings.HasPrefix(string(first), "kbs_") {
		t.Fatalf("unexpected stable collection ID %q / %q", first, second)
	}

	otherFolder := actor
	otherFolder.FolderUID = "folder-b"
	otherID, _ := codec.CollectionID(otherFolder, "request-1")
	if first == otherID {
		t.Fatal("different folders must not derive the same public ID")
	}
	if strings.Contains(string(first), actor.UserID) || strings.Contains(string(first), actor.FolderUID) {
		t.Fatal("public ID leaks actor scope")
	}
}

func TestDocumentAndProviderNamesRoundTripWithoutProviderID(t *testing.T) {
	codec, _ := New([]byte("01234567890123456789012345678901"))
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user", FolderUID: "folder"}
	collectionID, _ := codec.CollectionID(actor, "create-kb")
	documentID, err := codec.DocumentID(collectionID, "upload-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(documentID), "doc_") {
		t.Fatalf("unexpected document ID %q", documentID)
	}

	datasetName, _ := DatasetName(collectionID)
	roundTrip, err := PublicIDFromDatasetName(datasetName)
	if err != nil || roundTrip != collectionID {
		t.Fatalf("dataset name round trip = %q, %v", roundTrip, err)
	}
	documentName, _ := DocumentName(documentID, "故障手册.PDF")
	if documentName != "aegis__"+string(documentID)+".pdf" {
		t.Fatalf("document name = %q", documentName)
	}
}

func TestCodecRejectsMissingScopeAndMalformedProviderNames(t *testing.T) {
	codec, _ := New([]byte("01234567890123456789012345678901"))
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	if _, err := codec.CollectionID(actor, "key"); err == nil {
		t.Fatal("missing folder must fail closed")
	}
	if _, err := PublicIDFromDatasetName("customer-dataset"); err == nil {
		t.Fatal("unmanaged dataset name must be rejected")
	}
	if _, err := DocumentName("kbs_abcdefgh", "x.pdf"); err == nil {
		t.Fatal("knowledge base ID must not be accepted as a document ID")
	}
}

func TestScopeFingerprintDoesNotExposeActorValues(t *testing.T) {
	codec, _ := New([]byte("01234567890123456789012345678901"))
	actor := domain.ActorContext{TenantID: "secret-tenant", OrgID: "secret-org", UserID: "secret-user", FolderUID: "secret-folder"}
	fingerprint, err := codec.ScopeFingerprint(actor)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{actor.TenantID, actor.OrgID, actor.UserID, actor.FolderUID} {
		if strings.Contains(fingerprint, secret) {
			t.Fatalf("fingerprint exposes %q", secret)
		}
	}
}
