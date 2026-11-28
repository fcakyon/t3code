import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingApproval } from "../../lib/threadActivity";

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, className }: Children & { className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import { PendingApprovalCard } from "./PendingApprovalCard";

function setup(
  approval: PendingApproval,
  options?: {
    canOperateThread?: boolean;
    respondingApprovalId?: RuntimeRequestId | null;
    onRespond?: (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<void>;
  },
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <PendingApprovalCard
        canOperateThread={options?.canOperateThread ?? true}
        approval={approval}
        respondingApprovalId={options?.respondingApprovalId ?? null}
        onRespond={options?.onRespond ?? (async () => {})}
      />,
    ),
  );
  return {
    container,
    findButton(label: string) {
      const button = [...container.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes(label),
      );
      if (!button) throw new Error(`No button matching "${label}" found`);
      return button;
    },
    async pressButton(label: string) {
      const button = [...container.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes(label),
      );
      if (!button) throw new Error(`No button matching "${label}" found`);
      await act(async () => button.click());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

describe("PendingApprovalCard", () => {
  it("renders file paths and diff counts, collapses diff details, and dispatches approval decisions", async () => {
    const onRespond = vi.fn(async () => {});
    const diff = [
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    using screen = setup(
      {
        requestId: "req-1" as RuntimeRequestId,
        requestKind: "file-change",
        createdAt: "2026-11-28T00:00:00.000Z",
        detail: diff,
        reason: "Edits files outside the current workspace.",
        files: [{ path: "src/example.ts", operation: "update", additions: 1, deletions: 1 }],
        responseCapability: "live",
      },
      { onRespond },
    );

    expect(screen.container.textContent).toContain("src/example.ts");
    expect(screen.container.textContent).toContain("+1");
    expect(screen.container.textContent).toContain("-1");
    expect(screen.container.textContent).toContain("Edits files outside the current workspace.");
    expect(screen.container.textContent).not.toContain("@@ -1 +1 @@");

    await screen.pressButton("Details");
    const monoBoxes = [...screen.container.querySelectorAll(".font-mono")];
    expect(monoBoxes.some((node) => node.textContent?.includes("@@ -1 +1 @@"))).toBe(true);

    await screen.pressButton("Allow once");
    expect(onRespond).toHaveBeenCalledWith("req-1", "accept");
    await screen.pressButton("Decline");
    expect(onRespond).toHaveBeenCalledWith("req-1", "decline");
  });

  it("collapses non-diff write previews behind Details when files are present and disables actions when locked", async () => {
    using readOnlyScreen = setup(
      {
        requestId: "req-2" as RuntimeRequestId,
        requestKind: "file-change",
        createdAt: "2026-11-28T00:00:00.000Z",
        detail: "Write replaces src/new.ts with:\nexport const ok = true;",
        files: [{ path: "src/new.ts", operation: "add" }],
        responseCapability: "live",
      },
      { canOperateThread: false },
    );

    expect(readOnlyScreen.container.textContent).toContain("src/new.ts");
    expect(readOnlyScreen.container.textContent).not.toContain("export const ok = true;");
    expect(readOnlyScreen.findButton("Allow once").disabled).toBe(true);
    expect(readOnlyScreen.findButton("Decline").disabled).toBe(true);

    await readOnlyScreen.pressButton("Details");
    expect(readOnlyScreen.container.textContent).toContain("export const ok = true;");

    using respondingScreen = setup(
      {
        requestId: "req-3" as RuntimeRequestId,
        requestKind: "command",
        createdAt: "2026-11-28T00:00:00.000Z",
        detail: "git status",
        responseCapability: "live",
      },
      { respondingApprovalId: "req-3" as RuntimeRequestId },
    );
    expect(respondingScreen.findButton("Allow once").disabled).toBe(true);
  });
});
