# Nightly changelog

This branch tracks [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) and adds the patches below.

## Provider patches

1. Load installed Antigravity plugin skills from `~/.gemini/config/plugins` and stage them per session alongside standalone skills ([`fe20210cf8`](https://github.com/fcakyon/t3code/commit/fe20210cf8), [`03c80e23e1`](https://github.com/fcakyon/t3code/commit/03c80e23e1), [`c4e03f9724`](https://github.com/fcakyon/t3code/commit/c4e03f9724), [`302badac71`](https://github.com/fcakyon/t3code/commit/302badac71), [pingdotgg/t3code#30476](https://github.com/pingdotgg/t3code/pull/30476)).
2. Keep discovered workspace skills when provider status snapshots refresh ([`112366bcc5`](https://github.com/fcakyon/t3code/commit/112366bcc5)).
3. Cancel stale `RUNNING` steps in the session SQLite database before `session/load` so interrupted tasks or subagents do not hang resumed threads ([`05953666b3`](https://github.com/fcakyon/t3code/commit/05953666b3)).
4. Stream Antigravity subagent tool calls, CLI command executions, live subagent card progress, launch prompts, and completion reports into subagent threads, including auto-approved `invoke_subagent` calls ([`790abd1413`](https://github.com/fcakyon/t3code/commit/790abd1413), [`aa4c26ad84`](https://github.com/fcakyon/t3code/commit/aa4c26ad84)).
5. Show real subagent titles and prompts instead of the "Antigravity subagent batch" and "Running invoke_subagent" placeholders, and prevent duplicate subagent cards when `stepUpdateIndex` drifts after session compaction ([`fa97c35ffb`](https://github.com/fcakyon/t3code/commit/fa97c35ffb), [`aa4c26ad84`](https://github.com/fcakyon/t3code/commit/aa4c26ad84)).
6. Resolve and propagate Antigravity subagent model selections and tier overrides (`inherit`, `flash_lite`, `flash`, `pro`) from live calls and protobuf records so subagent cards display their resolved model instead of "Not reported" ([`3d2bb2a109`](https://github.com/fcakyon/t3code/commit/3d2bb2a109)).

7. Steer Antigravity 1.5.1+ sessions with concurrent prompts, preserving running tools and the active turn. Queue follow-ups on older runtimes ([`f278d14e33`](https://github.com/fcakyon/t3code/commit/f278d14e33)).

8. Migrate existing Antigravity consumer sign-ins to the 1.5.9 CLI credential format, preserve logout, and keep quota reads working across the upgrade.

## Desktop patches

1. Open Usage from desktop links with the selected environment, provider, and metric, including from Stream Deck quota keys ([`abeb40096f`](https://github.com/fcakyon/t3code/commit/abeb40096f37ea1064ce8eb4c5a42bc2b44c3c7d)).

## Release pipeline

- Build desktop and CLI nightly releases when the `fork-nightly` maintenance task dispatches them. Updates use fork release feeds, including for macOS apps without a Developer ID signature ([`aa3e7435e4`](https://github.com/fcakyon/t3code/commit/aa3e7435e4), [`0d63edddb6`](https://github.com/fcakyon/t3code/commit/0d63edddb6)).

## Other fork commits

- Read Antigravity quota from the metered host ([`709256b31f`](https://github.com/fcakyon/t3code/commit/709256b31f)).
- Type recursive subagent notifications ([`9b4787509c`](https://github.com/fcakyon/t3code/commit/9b4787509c)).
- Apply fresh-session changes to scheduled tasks ([`c5a6552ba0`](https://github.com/fcakyon/t3code/commit/c5a6552ba0)).
- Use the shared HTTP client for Cursor Origin ([`28dfe66a15`](https://github.com/fcakyon/t3code/commit/28dfe66a15)).
- Supply the Electron path in updater tests ([`935e25e3aa`](https://github.com/fcakyon/t3code/commit/935e25e3aa)).
- Run fork maintenance every six hours ([`b38ff47b14`](https://github.com/fcakyon/t3code/commit/b38ff47b14)).
- Build nightly releases only on dispatch ([`59b6cf0ff9`](https://github.com/fcakyon/t3code/commit/59b6cf0ff9)).
- Check failed build logs before dispatching ([`453db3b3ab`](https://github.com/fcakyon/t3code/commit/453db3b3ab)).
- Add the fork changelog ([`98ee6461fe`](https://github.com/fcakyon/t3code/commit/98ee6461fe)).
- Record the subagent timeline patch ([`d5151a9dbe`](https://github.com/fcakyon/t3code/commit/d5151a9dbe)).
- Link fork commits and reference this changelog ([`00b6182e66`](https://github.com/fcakyon/t3code/commit/00b6182e66)).
- Record subagent title and prompt hydration ([`f7096a95ae`](https://github.com/fcakyon/t3code/commit/f7096a95ae)).
- Separate the subagent patch notes ([`70ad4f0487`](https://github.com/fcakyon/t3code/commit/70ad4f0487)).
- Record subagent progress and step-drift fixes ([`8de2215bb2`](https://github.com/fcakyon/t3code/commit/8de2215bb2)).
- Refresh the fork patch inventory ([`fc40114593`](https://github.com/fcakyon/t3code/commit/fc40114593)).
- Record subagent model selection ([`dd1d469006`](https://github.com/fcakyon/t3code/commit/dd1d469006)).
