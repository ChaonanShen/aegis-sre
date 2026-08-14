package knowledgeeval

import "fmt"

const MinimumCases = 30

type Case struct {
	Name                 string   `json:"name"`
	Query                string   `json:"query"`
	Service              string   `json:"service,omitempty"`
	ExpectedDocumentIDs  []string `json:"expected_document_ids"`
	ForbiddenDocumentIDs []string `json:"forbidden_document_ids,omitempty"`
}

type Manifest struct {
	FolderUID        string   `json:"folder_uid"`
	KnowledgeBaseIDs []string `json:"knowledge_base_ids"`
	Cases            []Case   `json:"cases"`
}

type SearchResult struct{ DocumentIDs []string }
type SourceStatus struct{ Status string }
type Report struct {
	Cases                int     `json:"cases"`
	Sources              int     `json:"sources"`
	ReadySources         int     `json:"ready_sources"`
	ParseSuccessRate     float64 `json:"parse_success_rate"`
	TopFiveRecall        float64 `json:"top_five_recall"`
	ForbiddenReturnCount int     `json:"forbidden_return_count"`
}

func Evaluate(manifest Manifest, sources []SourceStatus, results []SearchResult) (Report, error) {
	if manifest.FolderUID == "" || len(manifest.Cases) < MinimumCases || len(results) != len(manifest.Cases) {
		return Report{}, fmt.Errorf("evaluation requires a Folder and at least %d aligned cases", MinimumCases)
	}
	report := Report{Cases: len(manifest.Cases), Sources: len(sources)}
	for _, source := range sources {
		if source.Status == "ready" {
			report.ReadySources++
		}
	}
	if report.Sources > 0 {
		report.ParseSuccessRate = float64(report.ReadySources) / float64(report.Sources)
	}
	matched := 0
	for index, testCase := range manifest.Cases {
		returned := make(map[string]struct{}, len(results[index].DocumentIDs))
		for _, id := range results[index].DocumentIDs {
			returned[id] = struct{}{}
		}
		found := false
		for _, id := range testCase.ExpectedDocumentIDs {
			if _, ok := returned[id]; ok {
				found = true
				break
			}
		}
		if found {
			matched++
		}
		for _, id := range testCase.ForbiddenDocumentIDs {
			if _, ok := returned[id]; ok {
				report.ForbiddenReturnCount++
			}
		}
	}
	report.TopFiveRecall = float64(matched) / float64(len(manifest.Cases))
	return report, nil
}

func (report Report) MeetsTargets() bool {
	return report.Sources > 0 && report.ParseSuccessRate >= .95 && report.TopFiveRecall >= .85 && report.ForbiddenReturnCount == 0
}
