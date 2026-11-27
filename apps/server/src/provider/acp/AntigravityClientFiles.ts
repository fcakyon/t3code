import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const GIT_POINTER_MAX_BYTES = 4096;
const GITDIR_POINTER = /^gitdir:[ \t]*(.+?)[ \t]*(?:\r?\n)?$/u;

export interface VerifiedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface VerifiedClientFileRoot {
  readonly path: string;
  readonly identity: VerifiedFileIdentity;
}

export type ClientFileRoot = string | VerifiedClientFileRoot;

function extractFileIdentity(info: FileSystem.File.Info): VerifiedFileIdentity | undefined {
  return Option.isSome(info.ino) ? { dev: info.dev, ino: info.ino.value } : undefined;
}

function sameFileIdentity(a: VerifiedFileIdentity, b: VerifiedFileIdentity | undefined): boolean {
  return b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

// Windows has no O_NOFOLLOW, so there the callers' identity checks bind the opened file.
const openNoFollow = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.open(filePath, { flag: "r", noFollow: true }).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "BadArgument",
      () => fileSystem.open(filePath, { flag: "r" }),
    ),
  );

/** Read at most `maxBytes + 1` bytes, so an oversized or growing file is never buffered whole. */
const readBoundedBytes = Effect.fn("AntigravityClientFiles.readBoundedBytes")(function* (
  file: FileSystem.File,
  maxBytes: number,
) {
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = yield* file.readAlloc(maxBytes + 1 - total);
    if (Option.isNone(chunk)) break;
    chunks.push(chunk.value);
    total += chunk.value.length;
  }
  return total > maxBytes ? undefined : Buffer.concat(chunks, total);
});

const readGitPointer = Effect.fn("AntigravityClientFiles.readGitPointer")(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  lstatInfo: FileSystem.File.Info,
) {
  const lstatId = extractFileIdentity(lstatInfo);
  if (
    lstatInfo.type !== "File" ||
    Number(lstatInfo.size) > GIT_POINTER_MAX_BYTES ||
    lstatId === undefined
  ) {
    return undefined;
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* openNoFollow(fileSystem, filePath);
      const fdInfo = yield* file.stat;
      if (
        fdInfo.type !== "File" ||
        Number(fdInfo.size) > GIT_POINTER_MAX_BYTES ||
        !sameFileIdentity(lstatId, extractFileIdentity(fdInfo))
      ) {
        return undefined;
      }
      const bytes = yield* readBoundedBytes(file, GIT_POINTER_MAX_BYTES);
      if (bytes === undefined) return undefined;
      const contents = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => undefined,
      }).pipe(Effect.option);
      return Option.isSome(contents) ? { contents: contents.value, identity: lstatId } : undefined;
    }),
  );
});

function singleLineValue(contents: string | undefined): string | undefined {
  const value = contents?.trim();
  return value && !/[\r\n]/u.test(value) ? value : undefined;
}

const isVerifiedRootIntact = Effect.fn("AntigravityClientFiles.isVerifiedRootIntact")(
  function* (fileSystem: FileSystem.FileSystem, root: VerifiedClientFileRoot) {
    if ((yield* fileSystem.realPath(root.path)) !== root.path) return false;
    const info = yield* fileSystem.lstat(root.path);
    return info.type === "Directory" && sameFileIdentity(root.identity, extractFileIdentity(info));
  },
  Effect.orElseSucceed(() => false),
);

/**
 * Find the backing directory of the linked worktree containing `cwd`. Every pointer must be a
 * bounded single-line regular file, the backing directory must be registered under its common
 * directory's `worktrees`, and its `gitdir` backlink must name this exact `.git` file.
 */
export const resolveGitWorktreeDirectory = Effect.fn(
  "AntigravityClientFiles.resolveGitWorktreeDirectory",
)(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd: string | null | undefined;
  }) {
    const { fileSystem, path } = input;
    const cwd = input.cwd?.trim();
    if (!cwd) return undefined;
    let dir = path.resolve(cwd);
    while (true) {
      const dotGit = path.join(dir, ".git");
      const info = yield* fileSystem.lstat(dotGit).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
      );
      if (info === undefined) {
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
        continue;
      }
      const pointer = yield* readGitPointer(fileSystem, dotGit, info);
      const gitdir = pointer?.contents.match(GITDIR_POINTER)?.[1]?.trim();
      if (pointer === undefined || !gitdir) return undefined;

      const realDir = yield* fileSystem.realPath(dir);
      const realDotGit = yield* fileSystem.realPath(dotGit);
      if (realDotGit !== path.join(realDir, ".git")) return undefined;
      const realDotGitInfo = yield* fileSystem.lstat(realDotGit);
      if (
        realDotGitInfo.type !== "File" ||
        !sameFileIdentity(pointer.identity, extractFileIdentity(realDotGitInfo))
      ) {
        return undefined;
      }

      const gitDirectory = yield* fileSystem.realPath(path.resolve(realDir, gitdir));
      const gitDirInfo = yield* fileSystem.lstat(gitDirectory);
      const gitDirIdentity = extractFileIdentity(gitDirInfo);
      if (gitDirInfo.type !== "Directory" || gitDirIdentity === undefined) return undefined;

      const commonDirPath = path.join(gitDirectory, "commondir");
      const commonDir = singleLineValue(
        (yield* readGitPointer(fileSystem, commonDirPath, yield* fileSystem.lstat(commonDirPath)))
          ?.contents,
      );
      if (!commonDir) return undefined;
      const realCommonDir = yield* fileSystem.realPath(path.resolve(gitDirectory, commonDir));
      if (
        (yield* fileSystem.lstat(realCommonDir)).type !== "Directory" ||
        path.dirname(gitDirectory) !== path.join(realCommonDir, "worktrees")
      ) {
        return undefined;
      }

      const backlinkPath = path.join(gitDirectory, "gitdir");
      const backlink = singleLineValue(
        (yield* readGitPointer(fileSystem, backlinkPath, yield* fileSystem.lstat(backlinkPath)))
          ?.contents,
      );
      if (!backlink) return undefined;
      const realTarget = yield* fileSystem.realPath(path.resolve(gitDirectory, backlink));
      const targetInfo = yield* fileSystem.lstat(realTarget);
      if (
        targetInfo.type !== "File" ||
        realTarget !== realDotGit ||
        !sameFileIdentity(pointer.identity, extractFileIdentity(targetInfo))
      ) {
        return undefined;
      }

      const root: VerifiedClientFileRoot = { path: gitDirectory, identity: gitDirIdentity };
      return (yield* isVerifiedRootIntact(fileSystem, root)) ? root : undefined;
    }
  },
  Effect.orElseSucceed(() => undefined),
);

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve all symlinks, including the final component, before checking workspace containment.
 * A verified root is matched at its pinned path and identity, never re-canonicalized.
 */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<ClientFileRoot>;
    readonly requestPath: string;
  }) {
    const { fileSystem, path } = input;
    const resolved = path.resolve(input.requestPath);
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    // Canonicalize the deepest existing ancestor, so a link above missing directories cannot escape.
    let candidate = resolved;
    const missingSuffix: Array<string> = [];
    let real: string;
    while (true) {
      const canonical = yield* fileSystem.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(canonical)) {
        real = path.join(canonical.value, ...missingSuffix);
        break;
      }
      // Walk up only past missing entries, never dangling or unreadable links.
      const entryExists = yield* fileSystem.readLink(candidate).pipe(
        Effect.as(true),
        Effect.catch(() => fileSystem.exists(candidate)),
        Effect.orElseSucceed(() => true),
      );
      const parent = path.dirname(candidate);
      if (entryExists || parent === candidate) return yield* outside;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
    let verifiedRoot: VerifiedClientFileRoot | undefined;
    for (const root of input.allowedRoots) {
      if (typeof root === "string") {
        const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
        if (isInsideRoot(path, realRoot, real)) return { filePath: real, verifiedRoot: undefined };
      } else if (
        verifiedRoot === undefined &&
        isInsideRoot(path, root.path, real) &&
        (yield* isVerifiedRootIntact(fileSystem, root))
      ) {
        verifiedRoot = root;
      }
    }
    if (verifiedRoot === undefined) return yield* outside;
    return { filePath: real, verifiedRoot };
  },
);

export const readAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.readTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<ClientFileRoot>;
    readonly request: EffectAcpSchema.ReadTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
    const { fileSystem } = input;
    const { filePath, verifiedRoot } = yield* resolveClientFilePath({
      ...input,
      requestPath: input.request.path,
    });
    const notFound = EffectAcpErrors.AcpRequestError.resourceNotFound(
      `File '${input.request.path}' not found.`,
    );
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.request.path}' is outside the session workspace.`,
    );
    const notText = EffectAcpErrors.AcpRequestError.invalidParams(
      `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
    );
    const unreadable = EffectAcpErrors.AcpRequestError.internalError(
      `Could not read '${input.request.path}'.`,
    );
    // Checked before opening so a FIFO is refused instead of blocking the open.
    const info = yield* fileSystem.stat(filePath).pipe(Effect.mapError(() => notFound));
    if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
      return yield* notText;
    }
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* openNoFollow(fileSystem, filePath).pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.fail(notFound)
              : fileSystem.lstat(filePath).pipe(
                  Effect.option,
                  Effect.flatMap((entry) =>
                    Effect.fail(
                      Option.isSome(entry) && entry.value.type === "SymbolicLink"
                        ? outside
                        : unreadable,
                    ),
                  ),
                ),
          ),
        );
        const fdInfo = yield* file.stat.pipe(Effect.mapError(() => unreadable));
        if (fdInfo.type !== "File" || Number(fdInfo.size) > CLIENT_FILE_MAX_BYTES) {
          return yield* notText;
        }
        const read = yield* readBoundedBytes(file, CLIENT_FILE_MAX_BYTES).pipe(
          Effect.mapError(() => unreadable),
        );
        if (read === undefined) return yield* notText;
        if (verifiedRoot !== undefined) {
          const fdIdentity = extractFileIdentity(fdInfo);
          const stillInside = yield* Effect.gen(function* () {
            if (fdIdentity === undefined) return false;
            if (!(yield* isVerifiedRootIntact(fileSystem, verifiedRoot))) return false;
            if ((yield* fileSystem.realPath(filePath)) !== filePath) return false;
            return sameFileIdentity(
              fdIdentity,
              extractFileIdentity(yield* fileSystem.lstat(filePath)),
            );
          }).pipe(Effect.orElseSucceed(() => false));
          if (!stillInside) return yield* outside;
        }
        return read;
      }),
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
