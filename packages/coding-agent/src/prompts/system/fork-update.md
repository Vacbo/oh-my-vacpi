Merge the latest upstream `can1357/oh-my-pi` tag into this fork.

Context:
- This checkout is a fork with local changes that are intentionally incompatible with a plain upstream self-update.
- Do not run the legacy package or binary updater.
- This repo already has git hooks (`.git/hooks/omp-rebuild.sh`, called by `post-merge`, `post-commit`, `post-checkout`, and `post-rewrite`) that rebuild `packages/coding-agent/dist/omp` in the background when compiled-code paths change.

Required outcome:
1. Inspect the current git remotes, branch, and worktree status. Identify the fork's current version from `packages/coding-agent/package.json` and the latest upstream release tag (highest semver, ignore pre-releases).
2. Fetch upstream tags if needed.
3. If the worktree has uncommitted changes, stop and report instead of merging over them, unless the user tells you to proceed.
4. Before merging, summarize what the update brings. Read the upstream `CHANGELOG.md` files at the latest tag and list the changes between the current version and that tag, grouped as Breaking, Added, Changed, and Fixed, focused on `packages/coding-agent` plus any other notable packages. Present this summary so the user sees the features they will gain, then wait for the user to confirm before merging.
5. Record the current `HEAD` commit so the merge can be undone if needed, then merge the latest upstream tag into the current fork branch.
6. Preserve fork-specific package names, compatibility shims, and local behavior.
7. Resolve conflicts at the source, not by discarding fork changes.
8. Normalize each changed `packages/*/CHANGELOG.md`: these files use a `merge=union` driver, so the merge never drops lines but re-injects upstream `## [Unreleased]` items alongside the fork's. Keep all fork entries under `### oh-my-vacpi (fork)`, move any upstream entries that landed in `## [Unreleased]` into their versioned `## [x.y.z]` section (or drop them if upstream already released them), and remove duplicates. Never delete fork entries.
9. Run focused verification for the changed packages.
10. Do not commit unless explicitly asked.

Recompile and reinstall handling:
11. After a successful merge, check `.git/omp-rebuild.log` for the background hook result. If the hook did not run, failed, or skipped despite compiled-code changes, run `bun --cwd=packages/coding-agent run build` manually.
12. Detect how the active `omp` is installed by resolving its path on PATH. If it resolves into the repo source or to `packages/coding-agent/dist/omp`, the rebuild hook is enough: report that the user must restart `omp` to load the rebuilt binary.
13. If the active `omp` is a separate copied binary, replace it with `packages/coding-agent/dist/omp` after the rebuild completes, preserve executable permissions, then report that the user must restart `omp`.
