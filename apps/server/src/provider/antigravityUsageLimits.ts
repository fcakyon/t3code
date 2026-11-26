import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";

// agy 1.5.18 waits 60 seconds for a new sign-in whatever `--print-timeout` says, so only the hard
// timeout ends the wait on a sign-in Google no longer accepts.
const PRINT_TIMEOUT_SECONDS = 10;
const HARD_TIMEOUT_MS = 20_000;
const WINDOW_MINS: Record<string, number> = { "5h": 300, weekly: 10_080 };

const decodeUsageOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      command: Schema.Struct({
        data: Schema.Struct({
          groups: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              buckets: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  window: Schema.String,
                  remaining_fraction: Schema.Number,
                  reset_time: Schema.optional(Schema.String),
                }),
              ),
            }),
          ),
        }),
      }),
    }),
  ),
);

// `/usage` names no account, so the email agy saves beside its tokens is what lets clients count
// one account signed in on several servers once. The tokens themselves are never used.
const decodeSignIn = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id_token_email: Schema.optional(Schema.String) })),
);

/** Windows from the JSON that `agy -p /usage --output-format json` prints. */
export const antigravityUsageWindows = Effect.fn("antigravityUsageWindows")(function* (
  stdout: string,
) {
  const output = yield* decodeUsageOutput(stdout);
  return output.command.data.groups.flatMap((group) =>
    group.buckets.map((bucket): ServerProviderUsageWindow => {
      const family = bucket.id.startsWith("gemini-")
        ? "Gemini"
        : bucket.id.startsWith("3p-")
          ? "Claude & GPT (shared)"
          : group.name;
      const windowDurationMins = WINDOW_MINS[bucket.window];
      // A full bucket reports the epoch or a reset that rolls forward with every read.
      const reset =
        bucket.remaining_fraction < 1 && bucket.reset_time
          ? DateTime.make(bucket.reset_time)
          : Option.none();
      return {
        id: bucket.id,
        label: `${family} · ${bucket.window === "weekly" ? "Weekly" : bucket.window === "5h" ? "5-hour" : bucket.window}`,
        kind: bucket.window === "weekly" ? "weekly" : bucket.window === "5h" ? "session" : "other",
        usedPercent: clampPercent((1 - bucket.remaining_fraction) * 100),
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      };
    }),
  );
});

/**
 * Read limits from the official CLI: `/usage` in print mode answers without a model turn.
 * Print mode ignores GEMINI_HOME and reads the login in `~/.gemini/antigravity-cli`, so a
 * throwaway home linking only this instance's sign-in file makes agy answer for its account.
 */
export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(function* <
  E,
>(input: {
  readonly signInFile: string;
  readonly prepareSpawn: (
    home: string,
  ) => Effect.Effect<Pick<AcpSessionRuntime.AcpSpawnInput, "command" | "env">, E, Scope.Scope>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Without a sign-in agy only waits for one, so it is not asked.
  const signIn = yield* fileSystem.readFileString(input.signInFile).pipe(Effect.option);
  if (Option.isNone(signIn)) return undefined;
  const email = yield* decodeSignIn(signIn.value).pipe(
    Effect.map((decoded) => decoded.id_token_email),
    Effect.orElseSucceed(() => undefined),
  );
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-usage-" });
    const cliDirectory = path.join(home, ".gemini", "antigravity-cli");
    yield* fileSystem.makeDirectory(cliDirectory, { recursive: true });
    yield* fileSystem.symlink(
      input.signInFile,
      path.join(cliDirectory, path.basename(input.signInFile)),
    );
    const spawn = yield* input.prepareSpawn(home);
    return yield* spawnAndCollect(
      spawn.command,
      ChildProcess.make(
        spawn.command,
        ["-p", "/usage", "--output-format", "json", "--print-timeout", `${PRINT_TIMEOUT_SECONDS}s`],
        {
          cwd: home,
          env: { ...spawn.env, HOME: home, USERPROFILE: home },
          extendEnv: false,
          stdin: "ignore",
        },
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeout(HARD_TIMEOUT_MS),
    Effect.flatMap((result) => antigravityUsageWindows(result.stdout)),
    Effect.map((windows): ServerProviderUsageLimits => makeUsageLimits({ checkedAt, windows })),
    Effect.orElseSucceed(() => makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })),
    Effect.map((usageLimits) => ({ usageLimits, email })),
  );
});
