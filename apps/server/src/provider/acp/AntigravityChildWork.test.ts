// @effect-diagnostics nodeBuiltinImport:off -- fixtures name transcript files by URL.
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  antigravitySubagentChildSessionId,
  describeAntigravitySubagentLaunches,
  makeAntigravitySubagentTracker,
  makeAntigravityCommandTaskTracker,
  readAntigravityChildWork,
  readAntigravitySessionSubagentState,
  toAntigravitySubagentRawInput,
} from "./AntigravityChildWork.ts";
import { sanitizeAntigravityToolPayload } from "./AntigravityProtocol.ts";
import {
  agentReportStep,
  autoApproved,
  commandTaskStep,
  CHILD,
  invokeStep,
  LAUNCH,
  makeProfile,
  plannerStep,
  ROOT,
  transcriptLines,
} from "./AntigravityChildWork.testkit.ts";

const read = (
  profileDirectory: string,
  nativeTaskId: string,
  launch: { readonly title: string | null; readonly prompt: string } = {
    title: null,
    prompt: "Readme check",
  },
  siblings: ReadonlyArray<{
    readonly nativeTaskId: string;
    readonly title: string | null;
    readonly prompt: string;
  }> = [],
) =>
  readAntigravityChildWork({
    profileDirectory,
    rootSessionId: ROOT,
    nativeTaskId,
    launch,
    siblings,
  });

it.layer(NodeServices.layer)("readAntigravityChildWork", (it) => {
  it.effect("keeps a compacted background command's native task identity until completion", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const taskId = `${ROOT}/task-4293`;
      const command = "ssh ultra12 'wc -l predictions.jsonl'";
      const { profile } = yield* makeProfile({
        steps: () => [
          [
            4293,
            21,
            commandTaskStep({
              taskId,
              command,
              summary: "Check evaluation progress across hosts",
              callId: "call-original",
            }),
          ],
        ],
      });
      const tracker = makeAntigravityCommandTaskTracker(profile);
      const notification = {
        sessionId: ROOT,
        update: {
          sessionUpdate: "tool_call" as const,
          toolCallId: `${ROOT}:2813`,
          kind: "execute" as const,
          title: command,
          status: "in_progress" as const,
          rawInput: { CommandLine: command, WaitMsBeforeAsync: 10000 },
        },
      };
      const refresh = {
        sessionId: ROOT,
        update: { sessionUpdate: "session_info_update" as const },
      };
      expect(yield* tracker.read(notification)).toEqual([
        {
          kind: "command",
          taskId,
          command,
          description: "Check evaluation progress across hosts",
          nativeItemId: `${ROOT}:2813`,
        },
      ]);
      expect(yield* tracker.read(refresh)).toBeUndefined();
      expect(yield* tracker.read(notification)).toBeUndefined();
      expect(
        yield* tracker.read({
          ...notification,
          update: { ...notification.update, status: "completed" },
        }),
      ).toBeUndefined();
      const database = new NodeSqlite.DatabaseSync(
        path.join(profile, "antigravity-acp", "conversations", `${ROOT}.db`),
      );
      database.prepare("UPDATE steps SET status = 3 WHERE idx = 4293").run();
      database.close();
      expect(
        yield* tracker.read({
          sessionId: ROOT,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Still working" },
          },
        }),
      ).toBeUndefined();
      expect(yield* tracker.read(notification)).toBeUndefined();
      expect(
        yield* tracker.read({
          ...notification,
          update: { ...notification.update, status: "completed" },
        }),
      ).toEqual([]);
      expect(yield* tracker.read(refresh)).toBeUndefined();
      yield* tracker.read({
        ...notification,
        update: { ...notification.update, toolCallId: "completed-foreground", status: "completed" },
      });
      const nextDatabase = new NodeSqlite.DatabaseSync(
        path.join(profile, "antigravity-acp", "conversations", `${ROOT}.db`),
      );
      nextDatabase
        .prepare(
          "INSERT INTO steps (idx,step_type,status,step_format,step_payload) VALUES (?,21,2,0,?)",
        )
        .run(
          4294,
          commandTaskStep({
            taskId: `${ROOT}/task-4294`,
            command,
            summary: "Next check",
            callId: "call-next",
          }),
        );
      nextDatabase.close();
      expect(
        yield* tracker.read({
          ...notification,
          update: { ...notification.update, toolCallId: `${ROOT}:2814` },
        }),
      ).toEqual([
        {
          kind: "command",
          taskId: `${ROOT}/task-4294`,
          command,
          description: "Next check",
          nativeItemId: `${ROOT}:2814`,
        },
      ]);
      expect(yield* tracker.read(refresh)).toBeUndefined();
    }),
  );

  it.effect.each([
    { stepType: 21 as const, status: 3 },
    { stepType: 132 as const, status: 3 },
    { stepType: 132 as const, status: 6 },
  ])("restores native task $stepType until terminal state $status", ({ stepType, status }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { profile } = yield* makeProfile({
        steps: () => [
          [
            4293,
            stepType,
            commandTaskStep({
              stepType,
              taskId: `${ROOT}/task-4293`,
              command: "run checks",
              summary: "Check progress",
              callId: "call-original",
            }),
          ],
          [
            4294,
            132,
            commandTaskStep({
              stepType: 132,
              toolName: "invoke_subagent",
              taskId: `${ROOT}/task-4294`,
              command: "agent work",
              summary: "Other task",
              callId: "other-call",
            }),
          ],
        ],
      });
      const tracker = makeAntigravityCommandTaskTracker(profile);
      const notification = {
        sessionId: ROOT,
        update: {
          sessionUpdate: "session_info_update" as const,
          title: "Research",
        },
      };
      expect(yield* tracker.read(notification)).toEqual([
        {
          kind: "command",
          taskId: `${ROOT}/task-4293`,
          command: "run checks",
          description: "Check progress",
          nativeItemId: "call-original",
        },
      ]);
      const database = new NodeSqlite.DatabaseSync(
        path.join(profile, "antigravity-acp", "conversations", `${ROOT}.db`),
      );
      database.prepare("UPDATE steps SET status = ? WHERE idx = 4293").run(status);
      database.close();
      expect(yield* tracker.read(notification)).toEqual([]);
    }),
  );
  it.effect("follows an auto-approved call id through its planner step to the record", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({ steps: autoApproved });
      const [child, ...rest] = yield* read(profile, `${ROOT}:1`);
      expect(rest).toEqual([]);
      expect(child).toMatchObject({
        conversationId: CHILD,
        role: LAUNCH.role,
        prompt: LAUNCH.prompt,
        truncated: false,
      });
      // The launch envelope repeats the prompt shown above, so the steps start with the child's work.
      expect(child?.steps?.map((step) => step.text ?? step.toolCalls[0]?.name)).toEqual([
        "view_file",
        "2: child read marker 4242",
        "marker 4242 found",
      ]);
      expect(child?.steps?.[0]?.toolCalls[0]?.input).toBe('{"AbsolutePath":"/project/README.md"}');
    }),
  );

  it.effect.each([127, 132] as const)(
    "matches an auto-approved call id with silent planner steps and native step type %s",
    (stepType) =>
      Effect.gen(function* () {
        const { profile } = yield* makeProfile({
          steps: (logUri) => [
            [1, 15, plannerStep([])],
            [4, 15, plannerStep([])],
            [9, 15, plannerStep([])],
            [
              14,
              15,
              plannerStep(["other-call"], { thought: "Visible thought keeps its step index" }),
            ],
            [20, 15, plannerStep([])],
            [29, 15, plannerStep(["call-30"])],
            [
              30,
              stepType,
              invokeStep({
                stepType,
                callId: "call-30",
                launches: [LAUNCH],
                children: [{ id: CHILD, logUri }],
              }),
            ],
            [
              31,
              101,
              agentReportStep({
                recipientSessionId: ROOT,
                senderConversationId: CHILD,
                text: "marker 4242 found in README.md",
              }),
            ],
            ...Array.from(
              { length: 201 },
              (_, index) =>
                [
                  100 + index,
                  132,
                  commandTaskStep({
                    stepType: 132,
                    taskId: `${ROOT}/task-${100 + index}`,
                    command: "echo invoke_subagent",
                    summary: "Unrelated command",
                    callId: `command-${index}`,
                  }),
                ] as const,
            ),
          ],
        });
        // 5 silent planner steps precede idx 30 (at 1, 4, 9, 20, 29), so StepUpdate.step_index is 25.
        const [child] = yield* read(profile, `${ROOT}:25`);
        expect(child?.conversationId).toBe(CHILD);
        expect(child?.role).toBe(LAUNCH.role);

        const state = yield* readAntigravitySessionSubagentState({
          profileDirectory: profile,
          rootSessionId: ROOT,
        });
        expect(state?.batches).toEqual([
          {
            stepUpdateIndex: 25,
            toolCallId: "call-30",
            launches: [LAUNCH],
            children: [{ conversationId: CHILD, role: LAUNCH.role }],
          },
        ]);
        expect(state?.reports).toEqual([
          {
            stepIndex: 31,
            conversationId: CHILD,
            text: "marker 4242 found in README.md",
          },
        ]);
      }),
  );

  it.effect(
    "reads subagent launch specs from in-progress, compacted, and planner-only steps before child resultados exist",
    () =>
      Effect.gen(function* () {
        const compactedLaunch = { role: "Compacted Reviewer", prompt: "Review compacted diff" };
        const runningLaunch = { role: "Running Reviewer", prompt: "Inspect active files" };
        const plannerLaunch = { role: "Planner Reviewer", prompt: "Check planner args" };
        const { profile } = yield* makeProfile({
          steps: () => [
            [1, 15, plannerStep(["call-compacted"])],
            [
              2,
              127,
              invokeStep({
                callId: "call-compacted",
                launches: [],
                children: [],
                omitInvokePayload: true,
                metadataArgsJson: JSON.stringify({
                  Subagents: [{ Role: compactedLaunch.role, Prompt: compactedLaunch.prompt }],
                }),
              }),
            ],
            [3, 15, plannerStep(["call-running"])],
            [
              4,
              127,
              invokeStep({
                callId: "call-running",
                launches: [runningLaunch],
                children: [],
              }),
            ],
            [5, 15, plannerStep([{ id: "call-planner", launches: [plannerLaunch] }])],
          ],
        });
        const state = yield* readAntigravitySessionSubagentState({
          profileDirectory: profile,
          rootSessionId: ROOT,
          includeReports: false,
        });
        expect(state?.batches).toEqual([
          {
            stepUpdateIndex: 1,
            toolCallId: "call-compacted",
            launches: [compactedLaunch],
            children: [],
          },
          {
            stepUpdateIndex: 2,
            toolCallId: "call-running",
            launches: [runningLaunch],
            children: [],
          },
          {
            stepUpdateIndex: 3,
            toolCallId: "call-planner",
            launches: [plannerLaunch],
            children: [],
          },
        ]);
      }),
  );

  it.effect("needs proof that the call id belongs to the parent's record", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({
        steps: (logUri) => [
          ...autoApproved(logUri),
          [5, 15, plannerStep(["call-b", "call-c"])],
          [
            6,
            127,
            invokeStep({ callId: "call-b", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
          [
            7,
            127,
            invokeStep({ callId: "call-c", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
        ],
      });
      // Another session's id, a step that is not the planner call, and parallel calls that share one id.
      expect(yield* read(profile, `00000000-0000-4000-8000-000000000000:1`)).toEqual([]);
      expect(yield* read(profile, `${ROOT}:2`)).toEqual([]);
      expect(yield* read(profile, `${ROOT}:5`)).toEqual([]);
    }),
  );

  it.effect("matches a permission-prompt call by its launch text, only when unique", () =>
    Effect.gen(function* () {
      const other = { role: "Test Runner", prompt: "Run the tests" };
      const long = { role: "Long Reader", prompt: `Read this:\n${"x".repeat(9_000)}` };
      // A role's leading byte order mark is part of its text.
      const marked = { role: "\uFEFFMarked", prompt: "Check the mark" };
      const { profile } = yield* makeProfile({
        steps: (logUri) => [
          [
            2,
            127,
            invokeStep({ callId: "x", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
          [
            8,
            127,
            invokeStep({ callId: "w", launches: [long], children: [{ id: CHILD, logUri }] }),
          ],
          [
            10,
            127,
            invokeStep({ callId: "v", launches: [marked], children: [{ id: CHILD, logUri }] }),
          ],
          [
            4,
            127,
            invokeStep({ callId: "y", launches: [other], children: [{ id: CHILD, logUri }] }),
          ],
          [
            6,
            127,
            invokeStep({ callId: "z", launches: [other], children: [{ id: CHILD, logUri }] }),
          ],
        ],
      });
      const opaque = "35bea692fa95447fbdae6333fec5515f";
      const matched = yield* read(profile, opaque, describeAntigravitySubagentLaunches([LAUNCH]));
      expect(matched.map((child) => child.role)).toEqual([LAUNCH.role]);
      // T3 knows a second batch with this text that the agent has not recorded yet.
      const twin = { nativeTaskId: "f00d", ...describeAntigravitySubagentLaunches([LAUNCH]) };
      expect(
        yield* read(profile, opaque, describeAntigravitySubagentLaunches([LAUNCH]), [twin]),
      ).toEqual([]);
      // T3 stores the launch from the bounded tool payload, which keeps only a long prompt's tail.
      const stored = antigravitySubagentLaunches(
        sanitizeAntigravityToolPayload({ Subagents: [{ Role: long.role, Prompt: long.prompt }] }),
      );
      const longMatch = yield* read(profile, opaque, describeAntigravitySubagentLaunches(stored!));
      expect(longMatch.map((child) => child.prompt)).toEqual([long.prompt]);
      expect(
        yield* read(profile, opaque, describeAntigravitySubagentLaunches([marked])),
      ).toHaveLength(1);
      expect(yield* read(profile, opaque, { title: "Marked", prompt: marked.prompt })).toEqual([]);
      expect(yield* read(profile, opaque, describeAntigravitySubagentLaunches([other]))).toEqual(
        [],
      );
      expect(yield* read(profile, opaque, { title: null, prompt: "Readme check" })).toEqual([]);
    }),
  );

  it.effect("leaves an auto-approved batch's record out of a launch-text match", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({ steps: autoApproved });
      const launch = describeAntigravitySubagentLaunches([LAUNCH]);
      const opaque = "35bea692fa95447fbdae6333fec5515f";
      expect(yield* read(profile, opaque, launch)).toHaveLength(1);
      // An earlier auto-approved batch stored no launch text, but its planner step claims the record.
      const auto = {
        nativeTaskId: `${ROOT}:1`,
        title: ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
        prompt: "",
      };
      expect(yield* read(profile, opaque, launch, [auto])).toEqual([]);
      // A sibling that cannot be ruled out refuses the match: its planner step is unreadable,
      // or it is a permission batch whose launch text is missing or cut.
      for (const sibling of [
        { ...auto, nativeTaskId: `${ROOT}:99` },
        { nativeTaskId: "0ld", title: ANTIGRAVITY_SUBAGENT_BATCH_TITLE, prompt: "Running" },
        // Its stored launch was cut, so it may be this same launch.
        { nativeTaskId: "cut", title: LAUNCH.role, prompt: "[Earlier output truncated]\n\nmarker" },
        { nativeTaskId: "cut", title: "[Earlier output truncated]\n\nReader", prompt: "x" },
        { nativeTaskId: "cut", title: null, prompt: "[Earlier output truncated]\n\nx" },
      ]) {
        expect(yield* read(profile, opaque, launch, [sibling])).toEqual([]);
      }
      // A cut prompt under different roles is another launch.
      const other = {
        nativeTaskId: "cut",
        title: "Test Runner",
        prompt: "[Earlier output truncated]\n\nx",
      };
      expect(yield* read(profile, opaque, launch, [other])).toHaveLength(1);
    }),
  );

  it.effect("reads no transcript outside the child's own profile path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-outside-" });
      const secret = path.join(outside, "transcript.jsonl");
      yield* fs.writeFileString(secret, JSON.stringify(transcriptLines[3]) + "\n");
      const named = yield* makeProfile({
        steps: () => autoApproved(NodeURL.pathToFileURL(secret).href),
      });
      const [namedChild] = yield* read(named.profile, `${ROOT}:1`);
      expect(namedChild?.role).toBe(LAUNCH.role);
      expect(namedChild?.steps).toBeNull();

      const linked = yield* makeProfile({ steps: autoApproved });
      yield* fs.remove(linked.transcriptPath);
      yield* fs.symlink(secret, linked.transcriptPath);
      const [linkedChild] = yield* read(linked.profile, `${ROOT}:1`);
      expect(linkedChild?.steps).toBeNull();
    }),
  );

  it.effect("reads only the tail of a large transcript", () =>
    Effect.gen(function* () {
      const filler = JSON.stringify({
        step_index: 0,
        type: "VIEW_FILE",
        status: "DONE",
        content: "x".repeat(10_000),
      });
      const { profile } = yield* makeProfile({
        steps: autoApproved,
        transcript: `${Array.from({ length: 40 }, () => filler).join("\n")}\n${JSON.stringify(transcriptLines[3])}\n`,
      });
      const [child] = yield* read(profile, `${ROOT}:1`);
      expect(child?.truncated).toBe(true);
      expect(child?.steps?.length).toBeLessThan(40);
      expect(child?.steps?.at(-1)?.text).toBe("marker 4242 found");
      expect(child?.steps?.[0]?.text?.length).toBeLessThanOrEqual(4_001);
    }),
  );

  it.effect("refuses links between children and sessions inside the same profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sibling = "b468c0e1d2f34a5b6c7d8e9f0a1b2c3d";
      // The record names this child's literal path, but the child directory links to a sibling.
      const linked = yield* makeProfile({ steps: autoApproved });
      const brain = path.join(linked.profile, "antigravity-acp", "brain");
      yield* fs.rename(path.join(brain, CHILD), path.join(brain, sibling));
      yield* fs.symlink(path.join(brain, sibling), path.join(brain, CHILD));
      const [child] = yield* read(linked.profile, `${ROOT}:1`);
      expect(child?.role).toBe(LAUNCH.role);
      expect(child?.steps).toBeNull();

      // This session's database links to another session's records.
      const other = yield* makeProfile({ steps: autoApproved });
      const conversations = path.join(other.profile, "antigravity-acp", "conversations");
      const peer = path.join(conversations, "00000000-0000-4000-8000-000000000000.db");
      yield* fs.rename(path.join(conversations, `${ROOT}.db`), peer);
      yield* fs.symlink(peer, path.join(conversations, `${ROOT}.db`));
      expect(yield* read(other.profile, `${ROOT}:1`)).toEqual([]);
    }),
  );

  it.effect.each([127, 132] as const)(
    "declines an unproven launch-text match for native step %s",
    (stepType) =>
      Effect.gen(function* () {
        const record = (callId: string, logUri: string) =>
          invokeStep({ stepType, callId, launches: [LAUNCH], children: [{ id: CHILD, logUri }] });
        const other = { role: "Test Runner", prompt: "Run the tests" };
        const filler = (idx: number, logUri: string) =>
          [
            idx,
            stepType,
            invokeStep({
              stepType,
              callId: `f${idx}`,
              launches: [other],
              children: [{ id: CHILD, logUri }],
            }),
          ] as const;
        const opaque = "35bea692fa95447fbdae6333fec5515f";
        const launch = describeAntigravitySubagentLaunches([LAUNCH]);
        const cases = [
          // More records than one open may scan.
          (logUri: string) => [
            [1, stepType, record("x", logUri)] as const,
            ...Array.from({ length: 200 }, (_, index) => filler(index + 2, logUri)),
          ],
          // An oversized record could hold an identical launch.
          (logUri: string) => [
            [1, stepType, record("x", logUri)] as const,
            [
              2,
              stepType,
              Uint8Array.from([...record("oversized", logUri), ...new Uint8Array(1024 * 1024)]),
            ] as const,
          ],
          // So could one this reader cannot decode.
          (logUri: string) => [
            [1, stepType, record("x", logUri)] as const,
            [2, stepType, Uint8Array.from([...record("invalid", logUri), 0xff, 0xff])] as const,
          ],
        ];
        for (const steps of cases) {
          const { profile } = yield* makeProfile({ steps });
          expect(yield* read(profile, opaque, launch)).toEqual([]);
        }
        const { profile } = yield* makeProfile({
          steps: (logUri) => [[1, stepType, record("x", logUri)]],
        });
        const path = yield* Path.Path;
        const database = new NodeSqlite.DatabaseSync(
          path.join(profile, "antigravity-acp", "conversations", `${ROOT}.db`),
        );
        database.prepare("UPDATE steps SET step_format = 1").run();
        database.close();
        expect(yield* read(profile, opaque, launch)).toEqual([]);
      }),
  );

  it.effect("keeps the batch view for a batch over the child limit", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({
        steps: (logUri) => [
          [1, 15, plannerStep(["call-a"])],
          [
            2,
            127,
            invokeStep({
              callId: "call-a",
              launches: Array.from({ length: 17 }, () => LAUNCH),
              children: Array.from({ length: 17 }, () => ({ id: CHILD, logUri })),
            }),
          ],
        ],
      });
      expect(yield* read(profile, `${ROOT}:1`)).toEqual([]);
    }),
  );

  it.effect("shares one transcript budget across the batch", () =>
    Effect.gen(function* () {
      const filler = JSON.stringify({
        step_index: 0,
        type: "VIEW_FILE",
        status: "DONE",
        content: "x".repeat(1_000),
      });
      const transcript = `${Array.from({ length: 300 }, () => filler).join("\n")}\n`;
      const { profile } = yield* makeProfile({
        transcript,
        steps: (logUri) => [
          [1, 15, plannerStep(["call-a"])],
          [
            2,
            127,
            invokeStep({
              callId: "call-a",
              launches: Array.from({ length: 16 }, () => LAUNCH),
              children: Array.from({ length: 16 }, () => ({ id: CHILD, logUri })),
            }),
          ],
        ],
      });
      const children = yield* read(profile, `${ROOT}:1`);
      expect(children).toHaveLength(16);
      expect(children.every((child) => child.truncated)).toBe(true);
      expect(JSON.stringify(children).length).toBeLessThan(600 * 1024);
    }),
  );

  it.effect(
    "binds a drifted auto-approved call id to the newest unclaimed DB batch without synthesizing duplicate historical batches",
    () =>
      Effect.gen(function* () {
        const historicalLaunch = { role: "Earlier Researcher", prompt: "Inspect earlier wave" };
        const historicalChild = "11111111111111111111111111111111";
        const { profile } = yield* makeProfile({
          steps: (logUri) => [
            [10, 15, plannerStep([{ id: "call-old", launches: [historicalLaunch] }])],
            [
              11,
              127,
              invokeStep({
                callId: "call-old",
                launches: [historicalLaunch],
                children: [{ id: historicalChild, logUri }],
              }),
            ],
            [1669, 15, plannerStep([{ id: "call-new", launches: [LAUNCH] }])],
            [
              1670,
              127,
              invokeStep({
                callId: "call-new",
                launches: [LAUNCH],
                children: [{ id: CHILD, logUri }],
              }),
            ],
            [
              1671,
              101,
              agentReportStep({
                recipientSessionId: ROOT,
                senderConversationId: CHILD,
                text: "marker 4242 found in README.md",
              }),
            ],
          ],
        });

        const driftedTaskId = `${ROOT}:1624`;
        const tracker = makeAntigravitySubagentTracker(profile);
        const launchNotifications = yield* tracker.rewriteAndDrain({
          sessionId: ROOT,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: driftedTaskId,
            title: "Running invoke_subagent",
            kind: "other",
            status: "in_progress",
          },
        });
        expect(launchNotifications).toHaveLength(1);
        const launchUpdate = launchNotifications[0]?.update;
        expect(
          launchUpdate?.sessionUpdate === "tool_call"
            ? antigravitySubagentLaunches(launchUpdate.rawInput)
            : undefined,
        ).toEqual([LAUNCH]);

        const childToolNotifications = yield* tracker.rewriteAndDrain({
          sessionId: ROOT,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `${CHILD}:1`,
            title: "Running command",
            kind: "execute",
            status: "in_progress",
            rawInput: { command_line: "orc status" },
          },
        });
        // Must route the child tool call to the drifted batch's child session and never synthesize
        // phantom tool_call_update notifications for historical `:9` or duplicate `:1668` batches.
        expect(childToolNotifications).toHaveLength(1);
        expect(childToolNotifications[0]?.sessionId).toBe(
          antigravitySubagentChildSessionId(driftedTaskId),
        );

        const settledNotifications = yield* tracker.rewriteAndDrain({
          sessionId: ROOT,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "processing" },
          },
        });
        expect(settledNotifications.map((entry) => entry.sessionId)).toEqual([
          antigravitySubagentChildSessionId(driftedTaskId),
          ROOT,
          ROOT,
        ]);
        expect(settledNotifications[1]?.update).toMatchObject({
          sessionUpdate: "tool_call_update",
          toolCallId: driftedTaskId,
          status: "completed",
          rawOutput: "marker 4242 found in README.md",
        });

        const hydratedLaunch = describeAntigravitySubagentLaunches([LAUNCH]);
        const [resolvedChild] = yield* read(profile, driftedTaskId, hydratedLaunch);
        expect(resolvedChild?.conversationId).toBe(CHILD);
        expect(resolvedChild?.role).toBe(LAUNCH.role);
      }),
  );

  it.effect.each([127, 132] as const)(
    "hydrates subagent models from raw input, native step %s, and planner args",
    (stepType) =>
      Effect.gen(function* () {
        expect(
          antigravitySubagentLaunches({
            Subagents: [{ Role: LAUNCH.role, Prompt: LAUNCH.prompt }],
          }),
        ).toEqual([LAUNCH]);
        expect(toAntigravitySubagentRawInput([LAUNCH])).toEqual({
          Subagents: [{ Role: LAUNCH.role, Prompt: LAUNCH.prompt }],
        });

        const flashLaunch = { role: "Fast Reader", prompt: "Inspect index.ts", model: "flash" };
        const proLaunch = { role: "Deep Reviewer", prompt: "Review diff", model: "pro" };
        expect(
          antigravitySubagentLaunches(toAntigravitySubagentRawInput([flashLaunch, proLaunch])),
        ).toEqual([flashLaunch, proLaunch]);

        const { profile } = yield* makeProfile({
          steps: (logUri) => [
            [1, 15, plannerStep(["call-proto"])],
            [
              2,
              stepType,
              invokeStep({
                stepType,
                callId: "call-proto",
                launches: [
                  { role: "Lite", prompt: "A", model: "flash_lite" },
                  { role: "Inherited", prompt: "B", model: "inherit" },
                ],
                children: [
                  { id: CHILD, logUri },
                  { id: "b468c0e1d2f34a5b6c7d8e9f0a1b2c3d", logUri },
                ],
              }),
            ],
            [3, 15, plannerStep([{ id: "call-planner-model", launches: [flashLaunch] }])],
            [
              4,
              stepType,
              invokeStep({
                stepType,
                callId: "call-planner-model",
                launches: [{ role: flashLaunch.role, prompt: flashLaunch.prompt }],
                children: [{ id: CHILD, logUri }],
              }),
            ],
          ],
        });

        const state = yield* readAntigravitySessionSubagentState({
          profileDirectory: profile,
          rootSessionId: ROOT,
          includeReports: false,
        });
        expect(state?.batches).toEqual([
          {
            stepUpdateIndex: 1,
            toolCallId: "call-proto",
            launches: [
              { role: "Lite", prompt: "A", model: "flash_lite" },
              { role: "Inherited", prompt: "B", model: "inherit" },
            ],
            children: [
              { conversationId: CHILD, role: "Lite" },
              { conversationId: "b468c0e1d2f34a5b6c7d8e9f0a1b2c3d", role: "Inherited" },
            ],
          },
          {
            stepUpdateIndex: 2,
            toolCallId: "call-planner-model",
            launches: [flashLaunch],
            children: [{ conversationId: CHILD, role: flashLaunch.role }],
          },
        ]);

        const tracker = makeAntigravitySubagentTracker(profile);
        const hydrated = yield* tracker.rewriteAndDrain({
          sessionId: ROOT,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `${ROOT}:2`,
            title: "Running invoke_subagent",
            kind: "other",
            status: "in_progress",
          },
        });
        const hydratedUpdate = hydrated[0]?.update;
        expect(
          hydratedUpdate?.sessionUpdate === "tool_call"
            ? antigravitySubagentLaunches(hydratedUpdate.rawInput)
            : undefined,
        ).toEqual([flashLaunch]);
      }),
  );
});
