Preview or write a task-focused repository context bundle as one self-contained Markdown file under `prompt-exports/`, for manual upload to an external chat model.

This tool is command-bound: `/context-export <task>` binds the exact task text and issues the `workflow_id` you must pass on every call. The tool never accepts task text, a destination path, or an overwrite flag.

# Two-call protocol

1. `action: "preview"` — requires `workflow_id` and `selection`; `preview_id` is forbidden. Resolves the selection against the repository inventory, renders the full bundle in memory, and returns a `preview_id` receipt plus destination, file/range counts, byte and exact o200k_base token totals with remaining headroom, grouped skips, secret-scan status, and the 20 largest selected payloads. Nothing is written.
2. `action: "write"` — requires `workflow_id` and the `preview_id` from the latest successful preview; `selection` is forbidden. Publishes exactly the previewed bytes (repository changes after preview do not alter the output). The receipt is consumed by the attempt; the workflow ends on success.

Re-running `preview` invalidates the previous receipt. Fix validation, budget, or secret errors by adjusting `selection` and previewing again.

# Selection model

- `base: "none"` starts with nothing selected; use `include` operations to add. Prefer this for bounded tasks.
- `base: "all"` starts with every inventoried file selected; use `exclude` operations to remove. Use for genuinely cross-cutting review.
- Operations apply strictly in order; a later operation overrides earlier state for the files it touches.
- `path` is an exact repository-relative POSIX path of an inventoried file or directory. No globs — characters like `*?[]{}` are literal. Directory operations apply recursively to files beneath them.
- `ranges` (1-indexed, inclusive, no clamping) are valid only on a single file. Ranged include unions lines into the selection; ranged exclude subtracts lines and can split a full file into slices.

# Inventory and safety

- The inventory respects `.gitignore` (AGENTS.md discovery excepted), includes hidden files, and excludes symlinks, `.git/`, `prompt-exports/`, and native prune directories such as `node_modules`.
- Sensitive files (`.env*`, key/credential files, `.omp/secrets.yml`, …) and binary files selected incidentally by `base: "all"` or a directory rule are skipped with a reason; explicitly including one by exact path is an error.
- Configured/environment secrets found in the task, paths, or selected content fail the preview; nothing transformed is ever exported.
