Merge the latest upstream `can1357/oh-my-pi` tag into this fork.

Context:
- This checkout is a fork with local changes that are intentionally incompatible with a plain upstream self-update.
- Do not run the legacy package or binary updater.
- This repo already has git hooks (`.git/hooks/omp-rebuild.sh`, called by `post-merge`, `post-commit`, `post-checkout`, and `post-rewrite`) that rebuild `packages/coding-agent/dist/omp` in the background when compiled-code paths change.

Required outcome:
1. Inspect the current git remotes, branch, worktree status, and latest upstream tag.
2. Fetch upstream tags if needed.
3. Merge the latest upstream tag into the current fork branch.
4. Preserve fork-specific package names, compatibility shims, and local behavior.
5. Resolve conflicts at the source, not by discarding fork changes.
6. Run focused verification for changed packages.
7. Do not commit unless explicitly asked.

Recompile and reinstall handling:
8. After a successful merge, check `.git/omp-rebuild.log` for the background hook result. If the hook did not run, failed, or skipped despite compiled-code changes, run `bun --cwd=packages/coding-agent run build` manually.
9. Detect how the active `omp` is installed by resolving its path on PATH. If it resolves into the repo source or to `packages/coding-agent/dist/omp`, the rebuild hook is enough: report that the user must restart `omp` to load the rebuilt binary.
10. If the active `omp` is a separate copied binary, replace it with `packages/coding-agent/dist/omp` after the rebuild completes, preserve executable permissions, then report that the user must restart `omp`.
