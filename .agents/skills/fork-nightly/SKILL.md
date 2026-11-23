---
name: fork-nightly
description: Maintain the fcakyon/t3code fork. Use when syncing upstream into nightly, resolving fork merge conflicts, building or publishing a fork nightly release, deploying a release to the local T3 runtime, or when GitHub Actions on the fork is disabled.
---

# Fork nightly

Fork notes live here so the root `AGENTS.md` stays identical to upstream and merges never conflict on it.

- `main` mirrors `upstream/main` (pingdotgg/t3code) with no fork commits.
- `nightly` carries the fork patches listed in `fcakyon-changelog.md` plus `main` merged in. Keep `fcakyon-changelog.md` strictly to active fork-only deltas: add a concise note for each new fork-only commit, and remove or narrow any bullet or commit hash whose patch was merged upstream, superseded, or reverted back to upstream.
- Before fixing a bug or adding a workaround on `nightly`, search open issues and pull requests in `upstream` (`pingdotgg/t3code`). If a matching upstream issue or PR already exists, adopt or build on that upstream fix (and link it in `fcakyon-changelog.md`) instead of introducing a divergent workaround, so future upstream syncs merge cleanly. When you have live reproduction evidence for an open upstream issue or PR, add it there rather than opening duplicates.
- Before every push to `nightly`, run `/code-review --fix` on what the fork adds or changes: a merged fork branch, upstream PR, conflict resolutions, or fork-patch cleanup edits made during a `main` sync (upstream already reviewed `main`).
- `.github/workflows/fork-nightly.yml` only builds, and only on dispatch. The sync runs locally with the user's `gh` token because the workflow's `GITHUB_TOKEN` cannot push upstream changes to `.github/workflows/`.

## Sync and release

The T3 Code maintenance task on akyon-server runs this every 6 hours from `/home/fatih/dev/t3code`. Never touch uncommitted changes in that checkout.

1. Fetch `origin` with pruning (`git fetch --prune origin`) and `upstream` (`main`). Fast-forward `main`: `git fetch . upstream/main:main && git push origin upstream/main:refs/heads/main`.
2. If `git merge-base --is-ancestor upstream/main origin/nightly` fails, merge in a detached temporary worktree (never create or leave extra local branches behind):
   - `git worktree add --detach .worktrees/nightly-sync origin/nightly`, then `git -C .worktrees/nightly-sync merge --no-edit main`.
   - Resolve conflicts while keeping the fork patches: `CLI_RELEASE_REPOSITORY = "fcakyon/t3code"`, `DEFAULT_DESKTOP_RELEASE_REPOSITORY = "fcakyon/t3code"`, the unsigned macOS zip installer fallback in `apps/desktop/src/electron/ElectronUpdater.ts`, `.github/workflows/fork-nightly.yml`, this skill, and the Antigravity plugins. Plugin preferences and manifests need bounded full-file JSON reads even when upstream skill discovery reads Markdown frontmatter only.
   - **Fork patch housekeeping:** Audit incoming commits (`git log --oneline <old-merge-base>..upstream/main`) against `fcakyon-changelog.md` and `git diff upstream/main..HEAD` even when the merge had no text conflicts:
     - Drop clearly superseded, duplicated, or obsolete fork workarounds, version gates, and legacy compatibility shims whenever upstream ships an equivalent or better fix with no regression, switching to upstream's implementation instead of carrying parallel code.
     - Remove or update stale fork tests rather than hardcoding mock versions to keep superseded shims passing, keeping focused tests only for remaining unique fork behavior.
     - Trim `fcakyon-changelog.md` to match the remaining active fork-only diff, then verify cleanup edits with focused tests, `vp run check:changed origin/nightly`, and `/code-review --fix`.
     - Leave ambiguous product tradeoffs or unverified replacements untouched and flag the options briefly in the sync summary instead of guessing.
   - Push `HEAD:refs/heads/nightly`, remove the detached worktree (and prune any stale clean temporary sync worktrees), and fast-forward the checkout with `git merge --ff-only origin/nightly` when its uncommitted changes allow it.
3. Keep Fork Nightly Release the only active workflow. Upstream merges can add new ones, so run `gh workflow disable <id> --repo fcakyon/t3code` on every other workflow that `gh workflow list --all --repo fcakyon/t3code --json id,name,state` shows as `active`.
4. Read the latest run with `gh run list --repo fcakyon/t3code --workflow fork-nightly.yml -L 1 --json databaseId,headSha,conclusion`. Dispatch a build only when `origin/nightly` differs from that run's `headSha` and from the latest release target (`gh api 'repos/fcakyon/t3code/releases?per_page=1' --jq '.[0].target_commitish'`), so running or failed builds of the same commit never repeat. An external failure such as a network timeout waits for the next commit.
   - When a dispatch is due and that run failed, read the end of its log first (`gh run view <databaseId> --repo fcakyon/t3code --log-failed | tail -n 200`). If our code or workflow caused it, push a fix before dispatching.
   - Dispatch once: `gh workflow run fork-nightly.yml --repo fcakyon/t3code --ref nightly`.
5. If a dispatch fails with `Actions has been disabled for this repository`, GitHub disabled workflows on the fork, even though the API still reports Actions as enabled. Press "I understand my workflows, go ahead and re-enable them" on https://github.com/fcakyon/t3code/actions in the user's signed-in Chrome, then repeat step 3.
6. If `gh release list --repo fcakyon/t3code -L 1` shows a release newer than `/home/fatih/.local/bin/t3 --version`, make this the final step so the turn ends before `t3code.service` restarts: `XDG_RUNTIME_DIR=/run/user/$(id -u) systemd-run --user --on-active=5s /bin/bash -c 'T3CODE_RELEASE_BASE_URL=https://github.com/fcakyon/t3code/releases/download /home/fatih/.local/bin/t3 update <VER> --yes'`.

## Runtime

- [Background service](../../../docs/user/background-service.md) covers `t3 update` and `t3 service install`. Keep `~/.local/bin/t3` as the standard runtime symlink so the updater can repoint it.
- Installed runtime directories are release artifacts. Never overwrite their executables with a local build or select versions through a custom `current.json` launcher. Local builds inherit the checkout's package version, which can differ from the release directory and stop the service at startup.
- After an update, verify `t3 --version`, `t3 service status`, HTTP on port 3773, and a saved client connection before reporting success. Do not edit service state by hand.
