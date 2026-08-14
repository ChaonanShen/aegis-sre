package knowledgeeval

import "testing"

func TestEvaluatePhaseEightTargets(t *testing.T) {
	manifest := Manifest{FolderUID: "ops", Cases: make([]Case, MinimumCases)}
	results := make([]SearchResult, MinimumCases)
	for index := range manifest.Cases {
		manifest.Cases[index] = Case{ExpectedDocumentIDs: []string{"doc_expected"}, ForbiddenDocumentIDs: []string{"doc_deleted"}}
		results[index] = SearchResult{DocumentIDs: []string{"doc_expected"}}
	}
	sources := make([]SourceStatus, 20)
	for index := range sources {
		sources[index].Status = "ready"
	}
	report, err := Evaluate(manifest, sources, results)
	if err != nil || !report.MeetsTargets() || report.TopFiveRecall != 1 || report.ParseSuccessRate != 1 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
}

func TestEvaluateFailsDeletedSourceAndQualityThresholds(t *testing.T) {
	manifest := Manifest{FolderUID: "ops", Cases: make([]Case, MinimumCases)}
	results := make([]SearchResult, MinimumCases)
	for index := range manifest.Cases {
		manifest.Cases[index] = Case{ExpectedDocumentIDs: []string{"doc_expected"}, ForbiddenDocumentIDs: []string{"doc_deleted"}}
		results[index] = SearchResult{DocumentIDs: []string{"doc_other"}}
	}
	results[0].DocumentIDs = append(results[0].DocumentIDs, "doc_deleted")
	report, err := Evaluate(manifest, []SourceStatus{{Status: "failed"}}, results)
	if err != nil {
		t.Fatal(err)
	}
	if report.MeetsTargets() || report.ForbiddenReturnCount != 1 || report.TopFiveRecall != 0 {
		t.Fatalf("report=%+v", report)
	}
}

func TestEvaluateRejectsToyCorpus(t *testing.T) {
	_, err := Evaluate(Manifest{FolderUID: "ops", Cases: []Case{{Query: "one"}}}, nil, []SearchResult{{}})
	if err == nil {
		t.Fatal("small corpus was accepted")
	}
}
