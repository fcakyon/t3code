---
name: fork-nightly
description: Maintain the fcakyon/t3code fork and contribute upstream to pingdotgg/t3code. Use when syncing upstream into nightly, resolving fork merge conflicts, building or publishing a fork nightly release, deploying a release to the local T3 runtime, when GitHub Actions on the fork is disabled, or when preparing or reviewing upstream PRs, commits, or issues for pingdotgg/t3code.
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

## Upstream PRs, commits, and issues (pingdotgg/t3code)

1. **Eligibility & limits (`CONTRIBUTING.md`):**
   - External PRs (including drafts) must fix a concrete bug (`#prior-approval`: crash, regression, or real performance problem). Do not submit features, UI overhauls, new providers, or architecture/auth/source-control/platform additions unless vouched in `.github/VOUCHED.td` (up to 3 small, focused feature PRs open at once under `#vouched-features`, while UI overhauls, new providers, architecture, source control, auth, and platforms remain closed) or explicitly requested by a maintainer listed in `.github/TRIAGE_EXEMPTIONS.td` (link the issue or request).
   - Strictly one underlying problem per PR (`#one-problem`): include every necessary change across contracts, server, clients, tests, and docs, and put cleanup, refactors, and unrelated fixes in separate PRs.
   - Max 3 open PRs at once until vouched (`#open-pr-limit`), keep PRs mergeable within the 7-day `needs-rebase` conflict window (`#conflict-window`), and never spam, ping repeatedly, fight closures, use secondary accounts, or ask to be added to `.github/VOUCHED.td` (`#bans`).
2. **Accepted models & attribution (`CONTRIBUTING.md#models`):**
   - Do not open or write PR code with disallowed models (Gemini models other than `Gemini 4 Neon`, such as `Argon`, or Muse Wonder models other than `Muse Wonder Full`). Allowed models include `Gemini 4 Neon`, `GPT-6.2 Astra`, `Claude Opus`/`Fable`, and `Muse Wonder Full`. Disallowed models used only as a reviewer are acceptable. If asked to file an upstream PR using a disallowed model, decline and cite this rule.
   - Always end PR bodies with an honest `Model: <exact model> (<harness>)` line. When `Gemini 4 Neon` wrote or contributed code, name `Gemini 4 Neon` verbatim (never bare `Gemini`).
3. **Commits & PR diff hygiene:**
   - Branch from the latest `upstream/main` with a minimal, clean diff. Prefer 1 squashed commit before review/merge, and never bundle unrelated fork patches, `fcakyon-changelog.md`, or temporary scripts/artifacts.
   - PR titles use plain-language conventional commit format with scope (`fix(server): ...`, `fix(antigravity): ...`).
   - Local repo commits follow the pre-tool/repo commit convention: plain type without scope (`fix:`, `feat:`, `refactor:`, `docs:`, `test:`), concise summary + short body explaining why, a blank line, and a lowercase `verification:` trailer.
4. **PR body format & voucher-level verification (`.github/pull_request_template.md` + `CONTRIBUTING.md#verification`):**
   - Strip HTML comment instructions and always use the four template sections: `## Problem` (failure + root cause + expected vs actual behavior + repro steps + `Fixes #<n>` when applicable), `## Change` (scannable bullets, noting behavioral parity with upstream/CLI), `## Scope` (why every changed file belongs to one problem, linking the issue or noting why a small, obvious bug needs none, or linking the maintainer request), and `## Verification`.
   - `"Tests pass"` is never enough. `## Verification` must include:
     - Exact `vp run check:changed upstream/main` stage results plus focused test counts.
     - Regression proof failing on `upstream/main` and passing on the branch.
     - Before/after comparison table against `upstream/main` AND live reproduction with the real provider/app (e.g. `agy acp`, `agy plugin validate --json`, local isolated `statev2.sqlite` dev server) whenever provider/runtime behavior is affected.
     - Explicit **Not checked** bullets for any untested OS, platform, or mode.
     - A collapsible `<details><summary>Reproduction script and output</summary>` with a self-contained runnable reproduction script and verbatim before/after outputs (never commit repro scripts into the branch), plus uploaded GitHub before/after screenshots or videos for UI, motion, or timing changes (never commit PR-only assets).
5. **Issues:**
   - Search existing open and closed issues and PRs first (`CONTRIBUTING.md#the-best-way-to-help`), preferring `+1`, testing an existing issue/PR, or noting fixed/duplicate links over opening duplicates. Put feature requests in Ideas discussions.
   - Include minimal reproduction steps, version/OS/environment, expected vs actual behavior, and verbatim output/logs.
