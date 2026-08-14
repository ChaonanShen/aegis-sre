# Knowledge evaluation corpus

Create a private `manifest.json` beside this file with at least 30 annotated cases. Do not commit proprietary operations documents. Each case contains `name`, `query`, one or more `expected_document_ids`, optional `service`, and optional `forbidden_document_ids` for sources that have been deleted and must no longer appear.

Run:

```sh
go run ./cmd/knowledge-eval \
  -manifest testdata/knowledge-eval/manifest.json \
  -url http://127.0.0.1:8080/mcp/knowledge \
  -token-file deploy/local/secrets/knowledge-mcp-token
```

The command fails unless the corpus has at least 30 cases, at least 95% of listed sources are ready, expected evidence appears in Top 5 for at least 85% of cases, and no forbidden/deleted document is returned.
