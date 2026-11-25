import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parse as parseYamlDocument } from "yaml";

/** Match Python os.path.expanduser: USERPROFILE, then HOMEDRIVE+HOMEPATH on Windows; HOME elsewhere. */
export function resolveAntigravityUserHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) {
      return `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
    }
    return home;
  }
  return environment.HOME || home;
}

/** Link private GEMINI_HOME skills to ~/.gemini; ~/.agents/skills is ignored because .agents/skills is project-only. */
export function antigravityUserSkillDirectories(
  path: Path.Path,
  geminiHome: string,
): readonly [configSkills: string, cliSkills: string] {
  return [
    path.join(geminiHome, "config", "skills"),
    path.join(geminiHome, "antigravity-cli", "skills"),
  ];
}

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_INHERIT_DEPTH = 10;
// Typical frontmatter fits in one chunk, so most skills cost about this much of the scan budget.
const SKILL_READ_CHUNK_BYTES = 1024;

const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);
const SkillConfigEntry = Schema.Struct({
  path: Schema.String,
  include_only: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  exclude: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const decodeSkillsConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      inherits: Schema.optional(Schema.NullOr(Schema.Array(SkillConfigEntry))),
      entries: Schema.optional(Schema.NullOr(Schema.Array(SkillConfigEntry))),
    }),
  ),
);
const decodePluginPreferences = Schema.decodeUnknownOption(
  // agy decodes like Go's encoding/json, so a null entry leaves that plugin's default.
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({ enabled: Schema.optional(Schema.NullOr(Schema.Boolean)) }),
        ),
      ),
    }),
  ),
);
const decodePluginManifest = Schema.decodeUnknownOption(
  // agy decodes like Go's encoding/json, so null leaves the default and a string is invalid.
  Schema.fromJsonString(
    Schema.Struct({ disabled: Schema.optional(Schema.NullOr(Schema.Boolean)) }),
  ),
);

export class AntigravitySkillsProbeError extends Schema.TaggedError<AntigravitySkillsProbeError>()(
  "AntigravitySkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "scan-budget-exhausted"
      ? `Antigravity skill discovery exceeded its scan limit at '${this.path}'.`
      : `Antigravity could not read skills at '${this.path}'.`;
  }
}

interface ScanBudget {
  remainingBytes: number;
  remainingEntries: number;
}

const readIfPresent = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  path: string,
) =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.fail(
              new AntigravitySkillsProbeError({ reason: "filesystem-error", path, cause }),
            ),
    }),
  );

/** Reads a file of at most MAX_SKILL_BYTES, or undefined when it is missing. */
export const readAntigravityBoundedFile = Effect.fn("readAntigravityBoundedFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(filePath), filePath);
  if (info?.type !== "File") return undefined;
  if (info.size > BigInt(MAX_SKILL_BYTES)) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: filePath,
    });
  }
  return yield* readIfPresent(fileSystem.readFileString(filePath), filePath);
});

/**
 * The explicit `plugins.<name>.enabled` values in a GEMINI_HOME's config.json, or undefined when
 * the file does not decode, so callers load no plugins rather than ones the user turned off.
 */
const readAntigravityPluginPreferences = Effect.fn("readAntigravityPluginPreferences")(function* (
  configPath: string,
) {
  const config = yield* readAntigravityBoundedFile(configPath);
  const preferences = config === undefined ? undefined : decodePluginPreferences(config);
  if (preferences?._tag === "None") {
    yield* Effect.logWarning("Antigravity plugin preferences are invalid.", { path: configPath });
    return undefined;
  }
  return new Map(
    Object.entries(preferences?.value.plugins ?? {}).flatMap(([name, plugin]) =>
      plugin.enabled == null ? [] : [[name, plugin.enabled] as const],
    ),
  );
});

/** agy skips a plugin folder without one of these manifests, or whose manifest is not valid JSON. */
const ANTIGRAVITY_PLUGIN_MANIFESTS = [
  "plugin.json",
  ".antigravity-plugin/plugin.json",
  ".gemini-plugin/plugin.json",
] as const;

const readAntigravityPluginManifest = Effect.fn("readAntigravityPluginManifest")(
  function* (pluginDirectory: string) {
    const path = yield* Path.Path;
    for (const manifest of ANTIGRAVITY_PLUGIN_MANIFESTS) {
      const text = yield* readAntigravityBoundedFile(path.join(pluginDirectory, manifest));
      if (text === undefined) continue;
      const decoded = decodePluginManifest(text);
      return decoded._tag === "Some" ? { disabled: decoded.value.disabled === true } : undefined;
    }
    return undefined;
  },
  // An oversized manifest cannot be valid JSON for agy either, so only that plugin is skipped.
  Effect.catchIf(
    (error) => error.reason === "scan-budget-exhausted",
    () => Effect.undefined,
  ),
);

/**
 * A plugin shipping `"disabled": true` loads only when config.json enables it by folder name, and
 * none load while config.json does not decode.
 */
const isAntigravityPluginEnabled = (
  disabledByDefault: boolean,
  preferences: ReadonlyMap<string, boolean> | undefined,
  name: string,
) =>
  preferences !== undefined &&
  (disabledByDefault ? preferences.get(name) === true : preferences.get(name) !== false);

/** Enabled plugins in the user's ~/.gemini, by name, that a profile links and agy then loads. */
export const readAntigravityUserPlugins = Effect.fn("readAntigravityUserPlugins")(function* (
  userHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsDirectory = path.join(userHome, ".gemini", "config", "plugins");
  const plugins = new Map<
    string,
    { readonly directory: string; readonly disabledByDefault: boolean }
  >();
  const names = yield* readIfPresent(fileSystem.readDirectory(pluginsDirectory), pluginsDirectory);
  for (const name of names?.toSorted() ?? []) {
    const directory = path.join(pluginsDirectory, name);
    const info = yield* readIfPresent(fileSystem.stat(directory), directory);
    if (info?.type !== "Directory") continue;
    const manifest = yield* readAntigravityPluginManifest(directory);
    if (manifest === undefined) continue;
    plugins.set(name, { directory, disabledByDefault: manifest.disabled });
  }
  if (plugins.size === 0) return plugins;
  const preferences = yield* readAntigravityPluginPreferences(
    path.join(userHome, ".gemini", "config", "config.json"),
  );
  for (const [name, plugin] of plugins) {
    if (!isAntigravityPluginEnabled(plugin.disabledByDefault, preferences, name)) {
      plugins.delete(name);
    }
  }
  return plugins;
});

/** Plugins agy loads from the profile once its next launch relinks the enabled user plugins. */
export const readAntigravityPlugins = Effect.fn("readAntigravityPlugins")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsDirectory = path.join(input.profileDirectory, "config", "plugins");
  const userPluginsDirectory = path.join(input.userHome, ".gemini", "config", "plugins");
  // The profile linker carries a user's enabled override for a plugin that ships disabled.
  const plugins = new Map(
    [...(yield* readAntigravityUserPlugins(input.userHome))].map(([name, plugin]) => [
      name,
      { directory: plugin.directory, disabledByDefault: false },
    ]),
  );
  const names = yield* readIfPresent(fileSystem.readDirectory(pluginsDirectory), pluginsDirectory);
  for (const name of names ?? []) {
    const pluginDirectory = path.join(pluginsDirectory, name);
    const target = yield* fileSystem.readLink(pluginDirectory).pipe(
      Effect.map((value) => path.resolve(pluginsDirectory, value)),
      Effect.orElseSucceed(() => undefined),
    );
    // Profile preparation replaces its links into the user's plugins, so those come from above.
    if (target !== undefined && path.dirname(target) === userPluginsDirectory) continue;
    const info = yield* readIfPresent(fileSystem.stat(pluginDirectory), pluginDirectory);
    if (info?.type !== "Directory") continue;
    // Profile folders count without a manifest, as they did before user plugins were linked.
    const manifest = yield* readAntigravityPluginManifest(pluginDirectory);
    plugins.set(name, {
      directory: pluginDirectory,
      disabledByDefault: manifest?.disabled === true,
    });
  }
  if (plugins.size === 0) return [];
  const preferences = yield* readAntigravityPluginPreferences(
    path.join(input.profileDirectory, "config", "config.json"),
  );
  return [...plugins]
    .filter(([name, plugin]) =>
      isAntigravityPluginEnabled(plugin.disabledByDefault, preferences, name),
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, plugin]) => plugin.directory);
});

function parseSkillFrontmatter(contents: string, fileName: string) {
  const start = contents.indexOf("---");
  if (start === -1) return undefined;
  const end = contents.indexOf("---", start + 3);
  if (end === -1) return undefined;
  try {
    const frontmatter = decodeSkillFrontmatter(
      // Antigravity reads plain scalar names and descriptions as text.
      parseYamlDocument(contents.slice(start + 3, end).trim(), {
        schema: "failsafe",
        customTags: ["null"],
      }) ?? {},
    );
    const name = frontmatter.name || fileName.slice(0, -3);
    const description = frontmatter.description?.trim();
    // Native names are not trimmed. Do not rename one to fit the picker contract.
    if (!name || name !== name.trim()) return undefined;
    return { name, ...(description ? { description } : {}) };
  } catch {
    return undefined;
  }
}

/** The native loader orders child paths with Go's URL.EscapedPath encoding. */
function skillPathSortKey(entry: string) {
  return encodeURI(entry).replace(
    /[!'()*?#]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const DASH = 0x2d;

/** Finds the byte offset after the second `---`, as parseSkillFrontmatter's indexOf calls do. */
function makeFrontmatterEndFinder() {
  let bytesSeen = 0;
  let dashes = 0;
  let markers = 0;
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      bytesSeen += 1;
      dashes = byte === DASH ? dashes + 1 : 0;
      if (dashes === 3) {
        dashes = 0;
        markers += 1;
        if (markers === 2) return bytesSeen;
      }
    }
    return undefined;
  };
}

/** Reads through the frontmatter only, so skill bodies do not spend the scan budget. */
const readSkillFrontmatter = Effect.fn("readAntigravitySkill")(function* (
  skillPath: string,
  budget: ScanBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(skillPath), skillPath);
  if (info?.type !== "File") return undefined;

  const byteLimit = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
  const findFrontmatterEnd = makeFrontmatterEndFinder();
  let frontmatterEnd: number | undefined;
  const chunks = yield* readIfPresent(
    fileSystem
      .stream(skillPath, { bytesToRead: byteLimit + 1, chunkSize: SKILL_READ_CHUNK_BYTES })
      .pipe(
        Stream.takeUntil((chunk) => (frontmatterEnd = findFrontmatterEnd(chunk)) !== undefined),
        Stream.runCollect,
      ),
    skillPath,
  );
  if (chunks === undefined) return undefined;
  const bytes = Buffer.concat(chunks);
  budget.remainingBytes -= bytes.byteLength;
  if ((frontmatterEnd ?? bytes.byteLength) > byteLimit) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  return bytes.toString("utf8", 0, frontmatterEnd);
});

interface SkillEntryFilter {
  readonly includeGroups: ReadonlyArray<ReadonlyArray<string>>;
  readonly excludeNames: ReadonlyArray<string>;
}

const EMPTY_SKILL_FILTER: SkillEntryFilter = {
  includeGroups: [],
  excludeNames: [],
};

function matchesSkillFilter(entry: string, filter: SkillEntryFilter): boolean {
  for (const group of filter.includeGroups) {
    if (!group.includes(entry)) return false;
  }
  return !filter.excludeNames.includes(entry);
}

function narrowSkillFilter(
  parent: SkillEntryFilter,
  entry: typeof SkillConfigEntry.Type,
): SkillEntryFilter {
  const includeGroups =
    entry.include_only && entry.include_only.length > 0
      ? [...parent.includeGroups, entry.include_only]
      : parent.includeGroups;
  const excludeNames =
    entry.exclude && entry.exclude.length > 0
      ? [...parent.excludeNames, ...entry.exclude]
      : parent.excludeNames;
  return { includeGroups, excludeNames };
}

// agy does not expand ~, so a ~/ path stays relative to the config file.
function resolveSkillsConfigPath(path: Path.Path, rawPath: string, baseDir: string): string {
  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(baseDir, rawPath);
}

/** Keep read errors typed so workspace snapshots cannot cache partial results. */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (input: {
  readonly cwd: string;
  readonly userHome: string;
  /** The instance's GEMINI_HOME, where agy loads plugins from. */
  readonly profileDirectory: string;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  AntigravitySkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [configSkills, cliSkills] = antigravityUserSkillDirectories(
    path,
    path.join(input.userHome, ".gemini"),
  );
  const roots = [
    { directory: configSkills, scope: "user" },
    { directory: path.resolve(input.cwd, ".gemini", "skills"), scope: "project" },
    { directory: cliSkills, scope: "user" },
    { directory: path.resolve(input.cwd, ".agents", "skills"), scope: "project", agentRoot: true },
    { directory: path.resolve(input.cwd, ".agent", "skills"), scope: "project", agentRoot: true },
  ];
  const budget: ScanBudget = {
    remainingBytes: MAX_SCAN_BYTES,
    remainingEntries: MAX_SCAN_ENTRIES,
  };
  const skillsByName = new Map<string, ServerProviderSkill>();

  const addSkillFile = Effect.fn("addAntigravitySkillFile")(function* (
    skillPath: string,
    scope: string,
    pluginName?: string,
  ) {
    const fileName = path.basename(skillPath);
    if (fileName.toLowerCase() !== "skill.md" || !fileName.endsWith(".md")) return;
    const contents = yield* readSkillFrontmatter(skillPath, budget);
    if (contents === undefined) return;
    const skill = parseSkillFrontmatter(contents, fileName);
    if (!skill || skillsByName.has(skill.name)) return;
    skillsByName.set(skill.name, {
      ...skill,
      path: skillPath,
      scope,
      enabled: true,
      ...(pluginName === undefined ? {} : { displayName: `${pluginName}:${skill.name}` }),
    });
  });

  const scanDirectory = Effect.fn("scanAntigravitySkillDirectory")(function* (
    directory: string,
    scope: string,
    mode: "directory" | "agent-root" | "child" | "manifest",
    filter: SkillEntryFilter = EMPTY_SKILL_FILTER,
    pluginName?: string,
  ): Effect.fn.Return<void, AntigravitySkillsProbeError, FileSystem.FileSystem> {
    const info = yield* readIfPresent(fileSystem.stat(directory), directory);
    if (info?.type === "File" && mode === "manifest") {
      if (budget.remainingEntries === 0) {
        return yield* new AntigravitySkillsProbeError({
          reason: "scan-budget-exhausted",
          path: directory,
        });
      }
      budget.remainingEntries -= 1;
      if (matchesSkillFilter(path.basename(path.dirname(directory)), filter)) {
        yield* addSkillFile(directory, scope, pluginName);
      }
      return;
    }
    if (info?.type !== "Directory") return;
    const entries = yield* readIfPresent(fileSystem.readDirectory(directory), directory);
    if (entries === undefined) return;
    if (entries.length > budget.remainingEntries) {
      return yield* new AntigravitySkillsProbeError({
        reason: "scan-budget-exhausted",
        path: directory,
      });
    }
    budget.remainingEntries -= entries.length;

    const sortedEntries = entries.toSorted();
    const skillFileName = sortedEntries.find((entry) => entry.toLowerCase() === "skill.md");
    // agy treats the automatic .agent(s)/skills roots as collections.
    if (skillFileName !== undefined && mode !== "agent-root") {
      if (matchesSkillFilter(path.basename(directory), filter)) {
        yield* addSkillFile(path.join(directory, skillFileName), scope, pluginName);
      }
      return;
    }
    if (mode !== "child") {
      const children = sortedEntries
        .filter((entry) => matchesSkillFilter(entry, filter))
        .map((entry) => ({ entry, sortKey: skillPathSortKey(entry) }))
        .sort((left, right) =>
          left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0,
        );
      for (const { entry } of children) {
        yield* scanDirectory(
          path.join(directory, entry),
          scope,
          "child",
          EMPTY_SKILL_FILTER,
          pluginName,
        );
      }
    }
  });

  const scanSkillsConfig = Effect.fn("scanAntigravitySkillsConfig")(function* (
    configPath: string,
    baseDir: string,
    scope: string,
    filter: SkillEntryFilter,
    visitedConfigs: ReadonlySet<string>,
    depth: number,
  ): Effect.fn.Return<void, AntigravitySkillsProbeError, FileSystem.FileSystem> {
    if (depth > MAX_INHERIT_DEPTH) return;
    const resolvedConfigPath = path.resolve(configPath);
    if (visitedConfigs.has(resolvedConfigPath)) return;
    const configInfo = yield* readIfPresent(
      fileSystem.stat(resolvedConfigPath),
      resolvedConfigPath,
    );
    if (configInfo?.type !== "File") return;
    const byteLimit = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
    if (configInfo.size > BigInt(byteLimit)) {
      return yield* new AntigravitySkillsProbeError({
        reason: "scan-budget-exhausted",
        path: resolvedConfigPath,
      });
    }
    const raw = yield* readIfPresent(
      fileSystem.readFileString(resolvedConfigPath),
      resolvedConfigPath,
    );
    if (raw === undefined) return;
    budget.remainingBytes -= Buffer.byteLength(raw, "utf8");
    const parsed = decodeSkillsConfig(raw);
    if (parsed._tag === "None") return;

    const nextVisited = new Set(visitedConfigs);
    nextVisited.add(resolvedConfigPath);
    for (const inherited of parsed.value.inherits ?? []) {
      const inheritedPath = resolveSkillsConfigPath(path, inherited.path, baseDir);
      yield* scanSkillsConfig(
        inheritedPath,
        path.dirname(inheritedPath),
        scope,
        narrowSkillFilter(filter, inherited),
        nextVisited,
        depth + 1,
      );
    }
    for (const entry of parsed.value.entries ?? []) {
      const entryDirectory = resolveSkillsConfigPath(path, entry.path, baseDir);
      yield* scanDirectory(entryDirectory, scope, "manifest", narrowSkillFilter(filter, entry));
    }
  });

  for (const root of roots) {
    yield* scanDirectory(root.directory, root.scope, root.agentRoot ? "agent-root" : "directory");
  }

  for (const config of [
    {
      configPath: path.resolve(input.cwd, ".agents", "skills.json"),
      baseDir: input.cwd,
      scope: "project",
    },
    {
      configPath: path.resolve(input.cwd, ".agent", "skills.json"),
      baseDir: input.cwd,
      scope: "project",
    },
    {
      configPath: path.join(input.userHome, ".gemini", "config", "skills.json"),
      baseDir: path.join(input.userHome, ".gemini", "config"),
      scope: "user",
    },
  ]) {
    yield* scanSkillsConfig(
      config.configPath,
      config.baseDir,
      config.scope,
      EMPTY_SKILL_FILTER,
      new Set(),
      0,
    );
  }

  for (const pluginDirectory of yield* readAntigravityPlugins(input)) {
    yield* scanDirectory(
      path.join(pluginDirectory, "skills"),
      "user",
      "directory",
      EMPTY_SKILL_FILTER,
      path.basename(pluginDirectory),
    );
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
