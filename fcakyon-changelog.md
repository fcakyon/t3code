# `fcakyon/t3code` Nightly Changelog

Custom patches carried on the `nightly` branch on top of `upstream/main` (`pingdotgg/t3code`). Routine `upstream/main` sync/merge commits are omitted (`git log upstream/main..nightly --no-merges`).

## Product & Provider Patches

1. **Load Antigravity plugin skills** (`fe20210cf8`, `03c80e23e1`, `c4e03f9724`, `302badac71` — [PR #30476](https://github.com/pingdotgg/t3code/pull/30476)) — Discover installed Antigravity plugin skills from `~/.gemini/config/plugins` and stage them per session so `agy_acp_server.par` loads them alongside standalone skills without failing on malformed plugin manifests or preferences.
2. **Preserve discovered workspace skills across provider snapshot merges** (`112366bcc5`) — Stop `AntigravityProvider.snapshotForCwd` and `ProviderRegistry.mergeProviderSnapshot` from overwriting discovered workspace skills with an empty `workspaceSnapshots` array during status/snapshot refreshes.
3. **Cancel orphaned running steps before reopening Antigravity session logs** (`05953666b3`) — Mark stale `CORTEX_STEP_STATUS_RUNNING (2)` rows as `CANCELED (6)` in the session SQLite DB before `session/load` so interrupted background tasks or subagents do not trap resumed threads in `STATE_WAITING_FOR_TASKS` and hang `session/prompt`.

## Fork Release Infrastructure

- **Fork nightly release & auto-update pipeline** (`aa3e7435e4`, `0d63edddb6`) — Auto-sync `upstream/main -> main -> nightly` hourly and build/publish multi-platform nightly desktop + CLI releases on `fcakyon/t3code` with in-app and CLI auto-updates pointed at the fork.
