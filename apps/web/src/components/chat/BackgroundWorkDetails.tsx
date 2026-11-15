import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { TerminalIcon } from "lucide-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useQuietThreadProjection } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton />}>Details</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Background work</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {props.tasks.map((task) => {
              const item = props.turnItems.findLast((candidate) =>
                task.itemId === undefined
                  ? (candidate.nativeItemRef?.nativeId || candidate.id) ===
                    (task.nativeItemId ?? task.taskId)
                  : candidate.id === task.itemId,
              );
              const command =
                task.command ?? (item?.type === "command_execution" ? item.input : undefined);
              const description = task.description?.trim();
              const title =
                description && description !== command?.trim()
                  ? description
                  : command
                    ? "Command"
                    : task.kind.replaceAll("_", " ");
              const itemId =
                task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
              const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
              return (
                <section key={task.taskId} className="space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{title}</h3>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {task.awaited ? "Waiting" : "Running"}
                    </span>
                  </div>
                  {command ? (
                    <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                      <ShellCommandBlock command={command} />
                    </div>
                  ) : null}
                  {itemId && streamsOutput && item?.status === "running" ? (
                    <div className="font-mono text-xs whitespace-pre-wrap break-words">
                      <CommandOutputPanel
                        environmentId={props.environmentId}
                        threadId={task.sourceThreadId ?? item?.threadId ?? props.threadId}
                        itemId={itemId}
                      />
                    </div>
                  ) : null}
                  {childThreadId ? (
                    <InlineButton
                      onClick={() => {
                        setOpen(false);
                        props.onOpenThread(childThreadId);
                      }}
                    >
                      Open subagent
                    </InlineButton>
                  ) : null}
                </section>
              );
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function ThreadBackgroundTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection = useQuietThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const tasks =
    projection?.providerThreads
      .find((thread) => thread.id === projection.thread.activeProviderThreadId)
      ?.pendingBackgroundTasks?.filter((task) => task.kind === "command") ?? [];
  if (tasks.length === 0 || projection === undefined) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-tasks-heading"
      title="Background tasks"
      actions={
        <BackgroundWorkDetails
          {...props}
          tasks={tasks}
          turnItems={projection.turnItems}
          onOpenThread={() => undefined}
        />
      }
    >
      <ul className="m-0 list-none space-y-1 p-0">
        {tasks.map((task) => (
          <li key={task.taskId} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
            <TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate">{task.description ?? task.command ?? task.taskId}</span>
              <span className="truncate text-2xs text-muted-foreground">
                {task.taskId.split("/").at(-1)}
              </span>
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground">Running</span>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
