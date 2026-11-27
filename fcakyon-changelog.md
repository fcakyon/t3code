# t3code-fcakyon changelog

Active fork-only features, fixes, and release infrastructure on `nightly` (relative to `upstream/main`):

- feat: Fork nightly release pipeline, `fcakyon/t3code` update feeds, and unsigned macOS `.zip` update swap in `ElectronUpdater` ([`aa3e7435e4`](https://github.com/fcakyon/t3code/commit/aa3e7435e4), [`b38ff47b14`](https://github.com/fcakyon/t3code/commit/b38ff47b14), [`59b6cf0ff9`](https://github.com/fcakyon/t3code/commit/59b6cf0ff9), [`453db3b3ab`](https://github.com/fcakyon/t3code/commit/453db3b3ab), [`935e25e3aa`](https://github.com/fcakyon/t3code/commit/935e25e3aa))
- fix: Resume Antigravity sessions without replaying old tools ([`18265feecd`](https://github.com/fcakyon/t3code/commit/18265feecd))
- fix: Place running Antigravity edits and use the completed file diff for final line numbers ([pingdotgg/t3code#39073](https://github.com/pingdotgg/t3code/pull/39073)).
- docs: Remove the root Claude configuration shim.
- fix: Let Antigravity sessions read a linked git worktree's backing gitdir, also from subdirectories, after checking its backlink ([pingdotgg/t3code#39078](https://github.com/pingdotgg/t3code/pull/39078))
- fix: Link enabled global Antigravity plugins from `~/.gemini/config/plugins` into each instance profile, so their skills, hooks and MCP servers load in T3 threads, replacing the earlier skills-only catalog ([pingdotgg/t3code#39082](https://github.com/pingdotgg/t3code/pull/39082))
- fix: Keep delegation available in Antigravity and let it find and call other T3 tools in the same turn, without asking in Auto and Auto-accept edits for the `tool_search` and `tool_call` calls that carry them ([pingdotgg/t3code#39362](https://github.com/pingdotgg/t3code/pull/39362))
- fix: Show the shell command and working directory in Antigravity approval requests.
- fix: Allow read-only Antigravity requests without prompting in Auto ([pingdotgg/t3code#40127](https://github.com/pingdotgg/t3code/issues/40127))
- fix: Show managed Antigravity updates beside the provider version in Settings ([`53de663bb1`](https://github.com/fcakyon/t3code/commit/53de663bb1))
- fix: Resolve and propagate Antigravity subagent model selection (inherited parent model/options and tier overrides) ([`3d2bb2a109`](https://github.com/fcakyon/t3code/commit/3d2bb2a109))
- fix: Track running Antigravity background commands from the session log in Thread Details ([`e8a84f972e`](https://github.com/fcakyon/t3code/commit/e8a84f972e), [`f58a00e58b`](https://github.com/fcakyon/t3code/commit/f58a00e58b))
- fix: Cancel orphaned `RUNNING` Antigravity session log steps before reopening ([`05953666b3`](https://github.com/fcakyon/t3code/commit/05953666b3))
- feat: Share native provider usage pace with agents and Stream Deck (limited to non-Fable weekly windows) and open selected usage metrics from desktop deep links ([`f96aad41f0`](https://github.com/fcakyon/t3code/commit/f96aad41f0), [`84b933553c`](https://github.com/fcakyon/t3code/commit/84b933553c), [`abeb40096f`](https://github.com/fcakyon/t3code/commit/abeb40096f))
- feat: Show Antigravity limits again under **Usage → Limits** by asking the official `agy` CLI (`agy -p /usage --output-format json`) for each instance's own Google sign-in, and count one account signed in on several servers once, after upstream removed the internal API reader in [pingdotgg/t3code#43026](https://github.com/pingdotgg/t3code/pull/43026). Drop when upstream ships its own reader ([pingdotgg/t3code#43343](https://github.com/pingdotgg/t3code/discussions/43343), [pingdotgg/t3code#42614](https://github.com/pingdotgg/t3code/pull/42614)).
