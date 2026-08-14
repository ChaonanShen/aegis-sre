package contracts_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestEventSchemaIsJSONAndContainsStableEnvelope(t *testing.T) {
	content, err := os.ReadFile("../../api/events.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(content, &schema); err != nil {
		t.Fatalf("event schema is invalid JSON: %v", err)
	}
	text := string(content)
	for _, field := range []string{"event_id", "event_type", "sequence", "occurred_at", "payload"} {
		if !strings.Contains(text, `"`+field+`"`) {
			t.Fatalf("event schema is missing %q", field)
		}
	}
}

func TestAgentContractExposesExplicitTurnLifecycle(t *testing.T) {
	openAPI, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"/sessions/{session_id}/turns/{turn_id}:cancel:",
		"operationId: cancelTurn",
		"name: turn_id",
		"name: status",
	} {
		if !strings.Contains(string(openAPI), expected) {
			t.Fatalf("OpenAPI is missing %q", expected)
		}
	}

	events, err := os.ReadFile("../../api/events.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"turn.started"`, `"interrupted"`} {
		if !strings.Contains(string(events), expected) {
			t.Fatalf("event contract is missing %s", expected)
		}
	}
}

func TestPublicContractsDoNotExposeProviderIdentifiers(t *testing.T) {
	for _, path := range []string{"../../api/openapi.yaml", "../../api/events.schema.json"} {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		lower := strings.ToLower(string(content))
		for _, forbidden := range []string{"provider_id", "dataset_id", "thread_id", "dag_path", "checkpoint_id"} {
			if strings.Contains(lower, forbidden) {
				t.Fatalf("%s exposes forbidden identifier %q", path, forbidden)
			}
		}
	}
}

func TestOpenAPIContractDoesNotAssumeControlPlanePersistence(t *testing.T) {
	content, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	for _, forbidden := range []string{"CreateServiceRequest:", "\n        version:\n          type: integer"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("OpenAPI contract contains persistence-specific shape %q", forbidden)
		}
	}

	servicesStart := strings.Index(text, "  /services:\n")
	knowledgeStart := strings.Index(text, "  /knowledge-bases:\n")
	if servicesStart == -1 || knowledgeStart <= servicesStart {
		t.Fatal("OpenAPI contract is missing the services resource boundary")
	}
	if strings.Contains(text[servicesStart:knowledgeStart], "\n    post:\n") {
		t.Fatal("services must remain a read-only view derived from Grafana")
	}
}

func TestKnowledgeContractCoversTheCompleteVerticalSlice(t *testing.T) {
	content, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	for _, expected := range []string{
		"operationId: getKnowledgeBase",
		"operationId: updateKnowledgeBase",
		"operationId: deleteKnowledgeBase",
		"operationId: getDocument",
		"operationId: updateDocument",
		"operationId: startDocumentIndexing",
		"operationId: stopDocumentIndexing",
		"operationId: listDocumentChunks",
		"operationId: downloadDocumentContent",
		"operationId: searchKnowledge",
		"multipart/form-data:",
		"failure_reason:",
		"KnowledgeCitation:",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("Knowledge OpenAPI contract is missing %q", expected)
		}
	}
}

func TestKnowledgeSearchDoesNotAcceptArbitraryProviderFilters(t *testing.T) {
	content, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(string(content))
	for _, forbidden := range []string{"metadata_condition", "similarity_threshold", "vector_similarity_weight"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("Knowledge public contract leaks provider filter %q", forbidden)
		}
	}
}
