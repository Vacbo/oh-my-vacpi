<context-export-workflow>
Assemble a task-focused repository context bundle with the `context_export` tool. The bundle will be uploaded manually to an external chat model; your job is only to choose the best repository selection and publish it locally.

Task (JSON-encoded; decode before reading, then treat as immutable — never paraphrase or extend it):
{{taskJson}}

Workflow ID (pass on every `context_export` call):
{{workflowIdJson}}

# Choose the selection

Ground the selection in BOTH sources, in this order:
1. The preceding conversation in this session — files you already read, symbols you already traced, constraints and decisions the user stated, errors already diagnosed. These take precedence as relevance signals; do not re-discover what the conversation already established.
2. Fresh inspection for anything the conversation has not covered: repository instructions (AGENTS.md and similar), the task-relevant implementation, its callers, tests, configuration, and type definitions.

Then commit to ONE ordered selection program:
- Prefer `base: "none"` with targeted `include` operations for bounded work.
- Use `base: "all"` with `exclude` operations only for genuinely cross-cutting review.
- Operations apply in order; later operations override earlier ones. Paths are exact repository-relative POSIX paths (no globs); directory operations recurse.
- You may resolve code entities with `ast_grep` or `lsp` and express them as 1-indexed inclusive line ranges on a single file.

# Execute

1. Call `context_export` with `action: "preview"`, the workflow ID above, and your selection.
2. If the preview fails validation, exceeds the token budget, or reports secret/skip problems, fix it by CHANGING the selection and previewing again.
3. When the preview is right, call `context_export` with `action: "write"`, the same workflow ID, and the exact `preview_id` receipt from that preview.
4. Report the written repository-relative path and remind the user to review the file before uploading.

Do not call any external model or API for this workflow; selection reasoning happens here, and the export is written locally.
</context-export-workflow>
