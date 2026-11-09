---
name: fork-nightly
description: Maintain the fcakyon/t3code fork. Use when syncing upstream into nightly, resolving fork merge conflicts, building or publishing a fork nightly release, deploying a release to the local T3 runtime, or when GitHub Actions on the fork is disabled.
---

# Fork nightly

Fork notes live here so the root `AGENTS.md` stays identical to upstream and merges never conflict on it.

- `main` mirrors `upstream/main` (pingdotgg/t3code) with no fork commits.
- `nightly` carries the fork patches listed in `fcakyon-changelog.md` plus `main` merged in.
- `.github/workflows/fork-nightly.yml` only builds, and only on dispatch. The sync runs locally with the user's `gh` token because the workflow's `GITHUB_TOKEN` cannot push upstream changes to `.github/workflows/`.

## Sync and release

The T3 Code maintenance task on akyon-server runs this every 6 hours from `/home/fatih/dev/t3code`. Never touch uncommitted changes in that checkout.

1. Fetch `origin` (`main`, `nightly`) and `upstream` (`main`). Fast-forward `main`: `git fetch . upstream/main:main && git push origin upstream/main:refs/heads/main`.
2. If `git merge-base --is-ancestor upstream/main origin/nightly` fails, merge in a temporary worktree:
   - `git worktree add --detach .worktrees/nightly-sync origin/nightly`, then `git -C .worktrees/nightly-sync merge --no-edit main`.
   - Resolve conflicts while keeping the fork patches: `CLI_RELEASE_REPOSITORY = "fcakyon/t3code"`, `DEFAULT_DESKTOP_RELEASE_REPOSITORY = "fcakyon/t3code"`, the unsigned macOS zip installer fallback in `apps/desktop/src/electron/ElectronUpdater.ts`, `.github/workflows/fork-nightly.yml`, this skill, and the Antigravity plugins.
   - Push `HEAD:refs/heads/nightly`, remove the worktree, and fast-forward the checkout with `git merge --ff-only origin/nightly` when its uncommitted changes allow it.
3. Keep Fork Nightly Release the only active workflow. Upstream merges can add new ones, so run `gh workflow disable <id> --repo fcakyon/t3code` on every other workflow that `gh workflow list --all --repo fcakyon/t3code --json id,name,state` shows as `active`.
4. Read the latest run with `gh run list --repo fcakyon/t3code --workflow fork-nightly.yml -L 1 --json databaseId,headSha,conclusion`. Dispatch a build only when `origin/nightly` differs from that run's `headSha` and from the latest release target (`gh api 'repos/fcakyon/t3code/releases?per_page=1' --jq '.[0].target_commitish'`), so running or failed builds of the same commit never repeat. An external failure such as a network timeout waits for the next commit.
   - When a dispatch is due and that run failed, read the end of its log first (`gh run view <databaseId> --repo fcakyon/t3code --log-failed | tail -n 200`). If our code or workflow caused it, push a fix before dispatching.
   - Dispatch once: `gh workflow run fork-nightly.yml --repo fcakyon/t3code --ref nightly`.
5. If a dispatch fails with `Actions has been disabled for this repository`, GitHub disabled workflows on the fork, even though the API still reports Actions as enabled. Press "I understand my workflows, go ahead and re-enable them" on https://github.com/fcakyon/t3code/actions in the user's signed-in Chrome, then repeat step 3.
6. If `gh release list --repo fcakyon/t3code -L 1` shows a release newer than `/home/fatih/.local/bin/t3 --version`, make this the final step so the turn ends before `t3code.service` restarts: `systemd-run --user --on-active=5s /bin/bash -c 'T3CODE_RELEASE_BASE_URL=https://github.com/fcakyon/t3code/releases/download /home/fatih/.local/bin/t3 update <VER> --yes'`.

## Runtime

- [Background service](../../../docs/user/background-service.md) covers `t3 update` and `t3 service install`. Keep `~/.local/bin/t3` as the standard runtime symlink so the updater can repoint it.
- Installed runtime directories are release artifacts. Never overwrite their executables with a local build or select versions through a custom `current.json` launcher. Local builds inherit the checkout's package version, which can differ from the release directory and stop the service at startup.
- After an update, verify `t3 --version`, `t3 service status`, HTTP on port 3773, and a saved client connection before reporting success. Do not edit service state by hand.
