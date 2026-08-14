package ragflow

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestListDatasetsRetriesSafeReadsAndSendsFreshCredential(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		attempt := requests.Add(1)
		if request.Header.Get("Authorization") != "Bearer secret-token" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.URL.Query().Get("name") != "aegis__kbs_example" || request.URL.Query().Get("page_size") != "25" {
			t.Errorf("query = %s", request.URL.RawQuery)
		}
		if attempt == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `{"code":0,"data":[{"id":"internal-id","name":"aegis__kbs_example"}],"total_datasets":1}`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, func() (string, error) { return "secret-token", nil }, ClientOptions{ReadAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.ListDatasets(context.Background(), 1, 25, "aegis__kbs_example")
	if err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 || result.Total != 1 || len(result.Items) != 1 {
		t.Fatalf("requests=%d result=%+v", requests.Load(), result)
	}
}

func TestBusinessErrorDoesNotExposeProviderMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"code":108,"message":"secret tenant and dataset details"}`)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() (string, error) { return "token", nil }, ClientOptions{ReadAttempts: 1})

	_, err := client.ListDatasets(context.Background(), 1, 20, "")
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != 108 {
		t.Fatalf("error = %#v", err)
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "tenant") {
		t.Fatalf("sanitized error leaked provider body: %v", err)
	}
}

func TestMutationTransportFailureIsNotRetriedAndIsUnknown(t *testing.T) {
	transport := &failingTransport{}
	client, _ := NewClient("http://ragflow.invalid", func() (string, error) { return "token", nil }, ClientOptions{
		HTTPClient:   &http.Client{Transport: transport},
		ReadAttempts: 3,
	})
	err := client.DeleteDataset(context.Background(), "internal-id")
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || !providerErr.Unknown || providerErr.Retryable {
		t.Fatalf("error = %#v", err)
	}
	if transport.calls != 1 {
		t.Fatalf("mutation calls = %d, want 1", transport.calls)
	}
}

type failingTransport struct{ calls int }

func (transport *failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	transport.calls++
	return nil, errors.New("connection dropped after write")
}

func TestUploadUsesMultipartAndNeverPlacesOriginalNameInURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if strings.Contains(request.URL.String(), "private") {
			t.Errorf("URL leaks original file name: %s", request.URL)
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		content, _ := io.ReadAll(file)
		if header.Filename != "aegis__doc_abcdefgh.pdf" || string(content) != "document bytes" {
			t.Errorf("file = %q %q", header.Filename, content)
		}
		_, _ = io.WriteString(w, `{"code":0,"data":[{"id":"internal-doc","name":"aegis__doc_abcdefgh.pdf","run":"UNSTART"}]}`)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() (string, error) { return "token", nil }, ClientOptions{})

	documents, err := client.UploadDocument(context.Background(), "internal-dataset", "aegis__doc_abcdefgh.pdf", "application/pdf", strings.NewReader("document bytes"))
	if err != nil || len(documents) != 1 || documents[0].ID != "internal-doc" {
		t.Fatalf("documents=%+v error=%v", documents, err)
	}
}

func TestMalformedSuccessResponseIsControlled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `not-json with secret details`)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() (string, error) { return "token", nil }, ClientOptions{ReadAttempts: 1})
	_, err := client.ListDocuments(context.Background(), "dataset", 1, 20, "")
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %#v", err)
	}
}
