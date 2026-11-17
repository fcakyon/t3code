import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const GIT_FILE_MAX_BYTES = 4096;

/**
 * In a git worktree, `<cwd>/.git` is a file containing `gitdir: <path>` that points to
 * `<repo>/.git/worktrees/<name>` outside `<cwd>`. Include that directory in workspace roots
 * so reading `.git/HEAD` or worktree refs does not fail workspace containment checks.
 */
export const resolveGitWorktreeDirectory = Effect.fn(
  "AntigravityClientFiles.resolveGitWorktreeDirectory",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string | null | undefined;
}): Effect.fn.Return<string | undefined> {
  const cwd = input.cwd?.trim();
  if (!cwd) return undefined;
  const dotGit = input.path.join(cwd, ".git");
  const info = yield* input.fileSystem.stat(dotGit).pipe(Effect.option);
  if (
    Option.isNone(info) ||
    info.value.type !== "File" ||
    Number(info.value.size) > GIT_FILE_MAX_BYTES
  ) {
    return undefined;
  }
  const content = yield* input.fileSystem.readFileString(dotGit, "utf8").pipe(Effect.option);
  if (Option.isNone(content)) return undefined;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content.value);
  const gitdir = match?.[1]?.trim();
  if (!gitdir) return undefined;
  const resolved = input.path.resolve(cwd, gitdir);
  const dirInfo = yield* input.fileSystem.stat(resolved).pipe(Effect.option);
  if (Option.isNone(dirInfo) || dirInfo.value.type !== "Directory") return undefined;
  return resolved;
});

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve all symlinks, including the final component, before checking workspace containment. */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const resolved = path.resolve(input.requestPath);
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    // Canonicalize the deepest existing ancestor, so a link above missing directories cannot escape.
    let candidate = resolved;
    const missingSuffix: Array<string> = [];
    let real: string;
    while (true) {
      const canonical = yield* input.fileSystem.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(canonical)) {
        real = path.join(canonical.value, ...missingSuffix);
        break;
      }
      // Walk up only past missing entries, never dangling or unreadable links.
      const entryExists = yield* input.fileSystem.readLink(candidate).pipe(
        Effect.as(true),
        Effect.catch(() => input.fileSystem.exists(candidate)),
        Effect.orElseSucceed(() => true),
      );
      const parent = path.dirname(candidate);
      if (entryExists || parent === candidate) return yield* outside;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* outside;
    }
    return real;
  },
);

export const readAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.readTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.ReadTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
    const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
    const info = yield* input.fileSystem
      .stat(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.resourceNotFound(
            `File '${input.request.path}' not found.`,
          ),
        ),
      );
    if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
      );
    }
    const bytes = yield* input.fileSystem
      .readFile(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
        ),
      );
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `File '${input.request.path}' is not a UTF-8 text file.`,
        ),
    });
    if (text.includes("\0")) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' contains binary data.`,
      );
    }
    const line = input.request.line ?? undefined;
    const limit = input.request.limit ?? undefined;
    if (line === undefined && limit === undefined) {
      return { content: text };
    }
    // ACP lines are 1-indexed. `limit` is a line count.
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    return { content: lines.slice(start, end).join("\n") };
  },
);
