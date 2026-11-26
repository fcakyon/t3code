import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { antigravityUsageWindows } from "./antigravityUsageLimits.ts";

// The shape `agy -p /usage --output-format json` printed on agy 1.5.18.
const bucket = (id: string, window: string, remaining_fraction: number, reset_time: string) => ({
  id,
  name: "Limit Remaining",
  window,
  remaining_fraction,
  reset_time,
});
const output = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            bucket("gemini-weekly", "weekly", 0, "2026-12-03T08:37:33Z"),
            bucket("gemini-5h", "5h", 0.25, "2026-11-26T13:37:33Z"),
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            bucket("3p-weekly", "weekly", 1, "1970-01-01T00:00:00Z"),
            bucket("3p-5h", "5h", 1, "2026-11-26T19:29:13Z"),
          ],
        },
      ],
    },
  },
});

it.effect("reads agy /usage buckets as limit windows and blocks only the spent model family", () =>
  Effect.gen(function* () {
    const windows = yield* antigravityUsageWindows(output);
    expect(windows).toEqual([
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: 100,
        resetsAt: "2026-12-03T08:37:33.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        kind: "session",
        usedPercent: 75,
        resetsAt: "2026-11-26T13:37:33.000Z",
        windowDurationMins: 300,
      },
      // A full bucket has nothing to restore, so its epoch or rolling reset is dropped.
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10_080,
      },
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
    ]);

    const exhausted = (model: string) =>
      exhaustedUsageWindow(
        {
          driver: ProviderDriverKind.make("antigravity"),
          instanceId: ProviderInstanceId.make("antigravity"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-11-26T10:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: { checkedAt: "2026-11-26T10:00:00.000Z", windows },
        },
        Date.parse("2026-11-26T10:00:00.000Z"),
        model,
      )?.id;
    expect(exhausted("gemini-4-argon")).toBe("gemini-weekly");
    expect(exhausted("claude-opus-5-5")).toBeUndefined();
  }),
);

it.effect("rejects output that is not a usage answer", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      antigravityUsageWindows('{"status":"ERROR","error":"authentication failed or timed out"}'),
    );
    expect(exit._tag).toBe("Failure");
  }),
);
