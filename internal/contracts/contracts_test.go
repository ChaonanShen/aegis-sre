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
