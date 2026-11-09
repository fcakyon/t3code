# Nightly changelog

This branch tracks [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) and adds the patches below.

## Provider patches

1. Load installed Antigravity plugin skills from `~/.gemini/config/plugins` and stage them per session alongside standalone skills ([`fe20210cf8`](https://github.com/fcakyon/t3code/commit/fe20210cf8), [`03c80e23e1`](https://github.com/fcakyon/t3code/commit/03c80e23e1), [`c4e03f9724`](https://github.com/fcakyon/t3code/commit/c4e03f9724), [`302badac71`](https://github.com/fcakyon/t3code/commit/302badac71), [pingdotgg/t3code#30476](https://github.com/pingdotgg/t3code/pull/30476)).
2. Keep discovered workspace skills when provider status snapshots refresh ([`112366bcc5`](https://github.com/fcakyon/t3code/commit/112366bcc5)).
3. Cancel stale `RUNNING` steps in the session SQLite database before `session/load` so interrupted tasks or subagents do not hang resumed threads ([`05953666b3`](https://github.com/fcakyon/t3code/commit/05953666b3)).
4. Stream Antigravity subagent tool calls, CLI command executions, live subagent card progress, launch prompts, and completion reports into subagent threads, including auto-approved `invoke_subagent` calls ([`790abd1413`](https://github.com/fcakyon/t3code/commit/790abd1413), [`aa4c26ad84`](https://github.com/fcakyon/t3code/commit/aa4c26ad84)).
5. Show real subagent titles and prompts instead of the "Antigravity subagent batch" and "Running invoke_subagent" placeholders, and prevent duplicate subagent cards when `stepUpdateIndex` drifts after session compaction ([`fa97c35ffb`](https://github.com/fcakyon/t3code/commit/fa97c35ffb), [`aa4c26ad84`](https://github.com/fcakyon/t3code/commit/aa4c26ad84)).
6. Read Antigravity usage limits from the quota host the account is metered on, so a stale `cloudcode-pa` Gemini weekly reading no longer replaces the live `daily-cloudcode-pa` one for Google sign-ins ([pingdotgg/t3code#32425](https://github.com/pingdotgg/t3code/pull/32425)).

## Server patches

1. Apply `freshSession` when an agent updates a scheduled task through the `schedule_task` MCP tool. The update path ignored it, so the task kept its previous thread mode.

## Release pipeline

- Build desktop and CLI nightly releases with fork auto-updates when the `fork-nightly` maintenance task dispatches them ([`aa3e7435e4`](https://github.com/fcakyon/t3code/commit/aa3e7435e4), [`0d63edddb6`](https://github.com/fcakyon/t3code/commit/0d63edddb6)).
