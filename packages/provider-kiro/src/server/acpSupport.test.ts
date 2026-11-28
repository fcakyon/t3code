import { describe, expect, it } from "@effect/vitest";

import { kiroNormalizePermissionRequest, kiroPermissionDisposition } from "./acpSupport.ts";

describe("kiroNormalizePermissionRequest", () => {
  it("gives a review request the files Kiro lists only in its metadata", () => {
    const request = kiroNormalizePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_1", status: "pending", title: "Review changes" },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: {
        kiro: {
          type: "turn_approval",
          files: [{ path: "/workspace/kiro-permission-probe.txt", toolCallId: "tool-1" }],
        },
      },
    });

    expect(request.toolCall.locations).toEqual([{ path: "/workspace/kiro-permission-probe.txt" }]);
    expect(request.toolCall.kind).toBe("edit");
  });

  it("populates empty locations, preserves explicit null kind, and ignores explicit null locations or non-turn approvals", () => {
    const fromEmpty = kiroNormalizePermissionRequest({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "turn_approval_2",
        kind: null,
        locations: [],
      },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: {
        kiro: {
          type: "turn_approval",
          files: [{ path: "/workspace/a.ts" }],
        },
      },
    });
    expect(fromEmpty.toolCall.kind).toBeNull();
    expect(fromEmpty.toolCall.locations).toEqual([{ path: "/workspace/a.ts" }]);

    const nullLocations = {
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_3", locations: null },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: { kiro: { type: "turn_approval", files: [{ path: "/workspace/a.ts" }] } },
    };
    expect(kiroNormalizePermissionRequest(nullLocations)).toBe(nullLocations);

    const otherMeta = {
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_4" },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: { kiro: { type: "other", files: [{ path: "/workspace/a.ts" }] } },
    };
    expect(kiroNormalizePermissionRequest(otherMeta)).toBe(otherMeta);

    const emptyFiles = {
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_5" },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: { kiro: { type: "turn_approval", files: [] } },
    };
    expect(kiroNormalizePermissionRequest(emptyFiles)).toBe(emptyFiles);
  });

  it("asks on out-of-workspace review changes and allows inside-workspace ones only with allow_once", () => {
    const policy = { runtimeMode: "auto-accept-edits" as const, cwd: "/workspace" };
    const outside = kiroNormalizePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_6" },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: { kiro: { type: "turn_approval", files: [{ path: "/outside/file.ts" }] } },
    });
    expect(kiroPermissionDisposition(policy, outside)).toBe("ask");

    const insideAlwaysOnly = kiroNormalizePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_7" },
      options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
      _meta: { kiro: { type: "turn_approval", files: [{ path: "/workspace/file.ts" }] } },
    });
    expect(kiroPermissionDisposition(policy, insideAlwaysOnly)).toBe("ask");

    const insideOnce = kiroNormalizePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_8" },
      options: [{ optionId: "accept", name: "Accept", kind: "allow_once" }],
      _meta: { kiro: { type: "turn_approval", files: [{ path: "/workspace/file.ts" }] } },
    });
    expect(kiroPermissionDisposition(policy, insideOnce)).toBe("allow");
  });
});
