# Nightly changelog

This branch tracks [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) and adds the patches below.

## Provider patches

1. Load installed Antigravity plugin skills from `~/.gemini/config/plugins` and stage them per session alongside standalone skills ([`fe20210cf8`](https://github.com/fcakyon/t3code/commit/fe20210cf8), [`03c80e23e1`](https://github.com/fcakyon/t3code/commit/03c80e23e1), [`c4e03f9724`](https://github.com/fcakyon/t3code/commit/c4e03f9724), [`302badac71`](https://github.com/fcakyon/t3code/commit/302badac71), [pingdotgg/t3code#30476](https://github.com/pingdotgg/t3code/pull/30476)).
2. Keep discovered workspace skills when provider status snapshots refresh ([`112366bcc5`](https://github.com/fcakyon/t3code/commit/112366bcc5)).
3. Cancel stale `RUNNING` steps in the session SQLite database before `session/load` so interrupted tasks or subagents do not hang resumed threads ([`05953666b3`](https://github.com/fcakyon/t3code/commit/05953666b3)).
4. Stream Antigravity subagent tool calls, launch prompts, and completion reports into subagent threads, and hydrate subagent titles and prompts from planner and compacted steps ([`790abd1413`](https://github.com/fcakyon/t3code/commit/790abd1413), [`fa97c35ffb`](https://github.com/fcakyon/t3code/commit/fa97c35ffb)).

## Release pipeline

- Sync `upstream/main` into `nightly` every hour and publish desktop and CLI nightly builds with fork auto-updates ([`aa3e7435e4`](https://github.com/fcakyon/t3code/commit/aa3e7435e4), [`0d63edddb6`](https://github.com/fcakyon/t3code/commit/0d63edddb6)).
