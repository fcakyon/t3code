import "~/index.css";
import { EnvironmentId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
const state = vi.hoisted(() => ({ projection: null as unknown }));
vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: (() =>
    state.projection === null ? null : { projection: state.projection }) as never,
}));
vi.mock(import("./CommandOutputPanel"), () => ({
  useCommandOutputStreaming: () => true,
  CommandOutputPanel: () => <div>Command output stream</div>,
}));

import { render } from "../../../test/render";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";
import { ThreadBackgroundTasksPanel } from "./BackgroundWorkDetails";

it("opens full command details for short labels and keeps pending tasks current", async () => {
  state.projection = null;
  const command = "python3 audit.py -j 6\n> scratch/audit.log 2>&1";
  const commandItem = (status: "running" | "completed") => ({
    id: TurnItemId.make("bash-1"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-09T00:00:00Z"),
    type: "command_execution" as const,
    input: command,
    output: "Command running in background with ID: native-task",
  });
  const view = (
    description?: string,
    status: "running" | "completed" = "completed",
    explicitItem = true,
  ) => (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            itemId: explicitItem ? TurnItemId.make("bash-1") : undefined,
            nativeItemId: "native-command",
            kind: "command",
            description,
            command,
            awaited: true,
          },
        ],
        turnItems: [
          commandItem(status),
          {
            ...commandItem("running"),
            id: TurnItemId.make("native-match"),
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-command",
              strength: "strong",
            },
            ordinal: 2,
          },
        ],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread: () => undefined,
      })}
    />
  );
  await using screen = await render(view("Audit"));
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("dialog").element().textContent).toContain(command));
  await expect.element(page.getByText("Command output stream")).not.toBeInTheDocument();

  await screen.rerender(view(command));
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();
  await screen.rerender(view());
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();

  await screen.rerender(view("Check remaining modules", "running"));
  await expect
    .element(page.getByRole("heading", { name: "Check remaining modules" }))
    .toBeVisible();
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await screen.rerender(view("Native fallback", "completed", false));
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("shows a native command roster while its parent runs and removes finished tasks", async () => {
  const command = "ssh ultra12 'wc -l predictions.jsonl'";
  const projection = {
    thread: { activeProviderThreadId: "native" },
    runs: [{ status: "running" }],
    turnItems: [],
    providerThreads: [
      {
        id: "native",
        pendingBackgroundTasks: [
          {
            kind: "command",
            taskId: "trajectory/task-4293",
            command,
            description: "Check evaluation progress across hosts",
            nativeItemId: "trajectory:2813",
          },
          { kind: "subagent", taskId: "real-agent", description: "Agent work belongs in Lineage" },
        ],
      },
      {
        id: "old-provider",
        pendingBackgroundTasks: [
          { kind: "command", taskId: "old", description: "Other provider task" },
        ],
      },
    ],
  };
  state.projection = projection;
  const view = () => (
    <ThreadBackgroundTasksPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("thread")}
    />
  );
  await using screen = await render(view());
  await expect.element(screen.getByRole("region", { name: "Background tasks" })).toBeVisible();
  await expect.element(screen.getByText("Check evaluation progress across hosts")).toBeVisible();
  await expect.element(screen.getByText("Other provider task")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Agent work belongs in Lineage")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("dialog").element().textContent).toContain(command));
  state.projection = {
    ...projection,
    providerThreads: [{ id: "native", pendingBackgroundTasks: [] }],
  };
  await screen.rerender(view());
  await expect
    .element(screen.getByRole("region", { name: "Background tasks" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
