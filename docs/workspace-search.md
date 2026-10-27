# Workspace Search (EFS)

**EFS** is a local content index in Source Control (or optionally its own Activity Bar location), not a hosted GitHub search engine or an archive of every conversation/commit/PDF.

| Mode | Ranking | Dependencies |
| --- | --- | --- |
| Exact | Terms, paths and filename matching | Works without embeddings |
| Semantic | Vector similarity over extracted passages | Local Ollama + chosen embedding model |
| Hybrid | Blended lexical and semantic ranking | Default; embeddings improve semantic portion |

The manifest defaults to `hybrid` and `qwen3-embedding:0.6b`. Install that model if needed:

```sh
ollama pull qwen3-embedding:0.6b
```

**Ask Ollama** is separate, off by default and needs an explicit local chat model. Only localhost/loopback Ollama URLs are accepted. The index extracts eligible text/code and supported document text, skips common generated and Git directories and persists indexed passages. Some binary, unsupported, huge or unextractable documents cannot be searched.

Default maximums: **5,000 candidate files**, **10 MB per directly indexed file**, **100 returned passages**, incremental refresh approximately every **two minutes** when auto-reindex is on. The scope can include other local repositories under `~/GitHub` when configured. Results may open matching passages and copy repo-relative Markdown links. Use **Clear Workspace Search Index** for stale cache after checking scope/exclusions/model warnings; reindexing takes work.

Privacy: local indexing and Ollama embedding are separate from optional cloud ChatGPT/GitHub workflows. Deliberately exclude sensitive documents; a hidden filename is not an access control. For incomplete results try Exact mode, correct scope, limits, model, and text extraction.

Source: [index and persistence](../extension/search/search_index.js), [extractor](../extension/search/extract.js), [view](../extension/search/view.js), [search tests](../tests/test_workspace_search_index.js). See [settings](settings-reference.md).
