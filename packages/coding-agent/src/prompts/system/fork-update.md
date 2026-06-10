Merge the latest upstream `can1357/oh-my-pi` tag into this fork.

Context:
- This checkout is a fork with local changes that are intentionally incompatible with a plain upstream self-update.
- Do not run the legacy package or binary updater.
- The repo is managed with jj (Jujutsu, colocated git). Use `jj` commands for VCS operations: git HEAD stays detached by design, "uncommitted changes" in `git status` are the snapshotted `@` working-copy commit, and git hooks (including the legacy `.git/hooks/omp-rebuild.sh` rebuild hooks) do not fire, so rebuilds after the merge are manual.
- Committing and pushing to the fork remote (`origin`) is pre-authorized per AGENTS.md (Version Control). Never push to `upstream` or `pi`.

Required outcome:
1. Inspect the current git remotes, branch, and worktree status. Identify the fork's current version from `packages/coding-agent/package.json` and the latest upstream release tag (highest semver, ignore pre-releases).
2. Fetch upstream tags if needed.
3. If the working-copy commit (`@`) carries WIP changes, report them before merging. The default handling: carve the WIP into atomic conventional commits (one logical change each, with its changelog lines), verify tree equality against the original snapshot, push `main`, then merge. Ask only if the WIP looks half-finished enough that committing it would be wrong.
4. Before merging, summarize what the update brings. Read the upstream `CHANGELOG.md` files at the latest tag and list the changes between the current version and that tag, grouped as Breaking, Added, Changed, and Fixed, focused on `packages/coding-agent` plus any other notable packages. Present this summary so the user sees the features they will gain, then wait for the user to confirm before merging.
5. Record the current `jj op log` head plus the `main` and `@` commit ids so the merge can be undone (`jj undo` / `jj op restore`), then create the merge commit: `jj new main <tag> -m "merge: upstream <tag>"`.
6. Preserve fork-specific package names, compatibility shims, and local behavior by default. When upstream restructures (moves, splits, or rewrites the files a fork patch lives in), re-home the patch into the new architecture rather than resurrecting deleted files.
7. Resolve conflicts at the source, never by mechanically discarding either side. When fork and upstream genuinely diverge in behavior or design, decide on the merits which behavior is better: adopt the fork's version, upstream's version, or a synthesis. The fork divergence is not sacred; if upstream solved the same problem structurally better, adopt upstream and delete the fork patch (including tests that pin the dead mechanism, after porting their still-valid contracts). The user relies on this judgment. Document every such call in the merge report, and record significant ones in `.omp/UPGRADE_OPPORTUNITIES.md` with rationale and any residual levers.
8. Normalize each changed `packages/*/CHANGELOG.md`. These files declare a `merge=union` driver, but jj ignores git merge drivers and surfaces ordinary conflicts: merge them manually. Keep all fork entries under `### oh-my-vacpi (fork)` inside `## [Unreleased]`, take upstream's released `## [x.y.z]` sections byte-identical from upstream's side, move or drop any upstream entries stranded in `## [Unreleased]` (drop when upstream already released them), and remove duplicates. Never delete fork entries.
9. Run focused verification for the changed packages.
10. After verification passes, finalize: move `main` to the merge commit (`jj bookmark set main -r @`) and push (`jj git push -b main --remote origin`).

Recompile and reinstall handling:
11. After a successful merge, rebuild manually (jj fires no git hooks): `bun --cwd=packages/natives run build` first when crates or generated bindings changed, then `bun --cwd=packages/coding-agent run build`. Regenerate `packages/catalog/src/models.json` (`bun run generate-models`) when catalog resolvers, descriptors, or seeds changed.
12. Detect how the active `omp` is installed by resolving its path on PATH. If it resolves into the repo source or to `packages/coding-agent/dist/omp`, the rebuild from step 11 is enough: report that the user must restart `omp` to load the new version.
13. If the active `omp` is a separate copied binary, replace it with `packages/coding-agent/dist/omp` after the rebuild completes, preserve executable permissions, then report that the user must restart `omp`.
