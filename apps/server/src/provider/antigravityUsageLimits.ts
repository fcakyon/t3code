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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";

// A signed-out agy waits for a sign-in until this passes, and a stalled request can outlast it.
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
 * Read limits by asking the official CLI, the only reader Google allows: `/usage` in print mode
 * answers without a model turn. T3 never reads the sign-in or calls Google itself.
 */
export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(function* <E>(
  prepareSpawn: Effect.Effect<
    Pick<AcpSessionRuntime.AcpSpawnInput, "command" | "cwd" | "env">,
    E,
    Scope.Scope
  >,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* prepareSpawn.pipe(
    Effect.flatMap((spawn) =>
      spawnAndCollect(
        spawn.command,
        ChildProcess.make(
          spawn.command,
          [
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            `${PRINT_TIMEOUT_SECONDS}s`,
          ],
          { cwd: spawn.cwd, env: spawn.env, extendEnv: false, stdin: "ignore" },
        ),
      ),
    ),
    Effect.scoped,
    Effect.timeout(HARD_TIMEOUT_MS),
    Effect.flatMap((result) => antigravityUsageWindows(result.stdout)),
    Effect.map((windows): ServerProviderUsageLimits => makeUsageLimits({ checkedAt, windows })),
    Effect.orElseSucceed(() => makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })),
  );
});
