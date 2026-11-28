import { describe, expect, it } from "vite-plus/test";

import {
  boundFileChangeApprovalPrompt,
  formatWriteApprovalText,
  isUnifiedDiffText,
  withoutTrailingHighSurrogate,
} from "./approvalPrompt.ts";

describe("boundFileChangeApprovalPrompt", () => {
  it("keeps the bounded output within the exact character limit across footer digit boundaries", () => {
    const baseText = "a".repeat(10_000);
    for (const limit of [9_000, 9_950, 9_990, 9_999]) {
      const bounded = boundFileChangeApprovalPrompt(baseText, limit);
      expect(bounded.length).toBeLessThanOrEqual(limit);
      expect(bounded).toContain("more characters are not shown");
    }

    // Exercise the digit-width boundary around 1,000 omitted characters with narrow limits.
    const mediumText = "b".repeat(1_050);
    for (let limit = 40; limit <= 120; limit += 5) {
      const bounded = boundFileChangeApprovalPrompt(mediumText, limit);
      expect(bounded.length).toBeLessThanOrEqual(limit);
    }
  });

  it("drops a split trailing high surrogate at the truncation cut", () => {
    const emoji = "🚀";
    const text = `prefix ${emoji.repeat(40)}`;
    for (const limit of [50, 51, 52, 53]) {
      const bounded = boundFileChangeApprovalPrompt(text, limit);
      expect(bounded.length).toBeLessThanOrEqual(limit);
      const newline = bounded.indexOf("\n");
      expect(newline).toBeGreaterThan(0);
      const kept = bounded.slice(0, newline);
      expect(withoutTrailingHighSurrogate(kept)).toBe(kept);
    }
  });
});

describe("formatWriteApprovalText", () => {
  it("formats a write preview header with file path and content", () => {
    expect(formatWriteApprovalText("src/index.ts", "export const x = 1;\n")).toBe(
      "Write replaces src/index.ts with:\nexport const x = 1;\n",
    );
  });
});

describe("isUnifiedDiffText", () => {
  it("detects git diffs and standard unified diffs with headers and hunks", () => {
    expect(isUnifiedDiffText("diff --git a/a.ts b/a.ts\nindex 1..2 100644")).toBe(true);
    expect(isUnifiedDiffText("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b")).toBe(true);
    expect(isUnifiedDiffText("--- header without hunk\nplain text")).toBe(false);
    expect(isUnifiedDiffText("@@ -1 +1 @@\n+line without file header")).toBe(false);
    expect(isUnifiedDiffText("echo hello world")).toBe(false);
  });
});
