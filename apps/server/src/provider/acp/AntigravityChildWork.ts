// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type {
  OrchestrationV2NativeChildStep,
  OrchestrationV2NativeChildWork,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import {
  boundAntigravityToolText,
  isAntigravitySubagentToolUpdate,
  isCutAntigravityToolText,
  normalizeAntigravitySessionUpdate,
} from "./AntigravityProtocol.ts";

// Field numbers from the runtime's trajectory protos (exa.cortex_pb).
const STEP_METADATA = 5;
const METADATA_TOOL_CALL = 4;
const STEP_PLANNER_RESPONSE = 20;
const PLANNER_TEXT = 1;
const PLANNER_THINKING = 3;
const PLANNER_TOOL_CALLS = 7;
const STEP_SYSTEM_MESSAGE = 114;
const SYSTEM_MESSAGE_KIND = 3;
const SYSTEM_MESSAGE_AGENT_REPORT = 4;
const AGENT_REPORT_RECIPIENT_SESSION_ID = 2;
const AGENT_REPORT_SENDER_CONVERSATION_ID = 3;
const AGENT_REPORT_TEXT = 4;
const STEP_INVOKE_SUBAGENT = 143;
const INVOKE_SPECS = 9;
const INVOKE_RESULTS = 10;
const PLANNER_RESPONSE_STEP_TYPE = 15;
const SYSTEM_MESSAGE_STEP_TYPE = 101;
const INVOKE_SUBAGENT_STEP_TYPE = 127;

// One open reads at most this much; past any bound the batch view stays as it was.
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_INVOKE_ROWS = 200;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_CHILDREN = 16;
const TRANSCRIPT_BYTE_CAP = 256 * 1024;
const BATCH_TRANSCRIPT_BYTES = 512 * 1024;
const STEP_TEXT_CAP = 4_000;
const TOOL_INPUT_CAP = 1_000;

/** T3's title for a batch whose launch text it never saw. */
export const ANTIGRAVITY_SUBAGENT_BATCH_TITLE = "Antigravity subagent batch";

export const antigravitySubagentChildSessionId = (nativeTaskId: string) =>
  `antigravity-task:${nativeTaskId}`;

export interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

export interface AntigravitySubagentBatchState {
  readonly stepUpdateIndex: number;
  readonly toolCallId: string | undefined;
  readonly launches: ReadonlyArray<AntigravityChildLaunch>;
  readonly children: ReadonlyArray<{ readonly conversationId: string; readonly role: string }>;
}

export interface AntigravitySubagentReportState {
  readonly stepIndex: number;
  readonly conversationId: string;
  readonly text: string;
}

export interface AntigravitySessionSubagentState {
  readonly batches: ReadonlyArray<AntigravitySubagentBatchState>;
  readonly reports: ReadonlyArray<AntigravitySubagentReportState>;
}

const decodeLaunchInput = Schema.decodeUnknownOption(
  Schema.Struct({
    Subagents: Schema.NonEmptyArray(Schema.Struct({ Role: Schema.String, Prompt: Schema.String })),
  }),
);

/** `invoke_subagent` arguments, from the permission prompt or the persisted record. */
export function antigravitySubagentLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  return Option.getOrUndefined(
    Option.map(decodeLaunchInput(input), (decoded) =>
      decoded.Subagents.map((entry) => ({ role: entry.Role, prompt: entry.Prompt })),
    ),
  );
}

export const toAntigravitySubagentRawInput = (launches: ReadonlyArray<AntigravityChildLaunch>) => ({
  Subagents: launches.map((launch) => ({
    Role: launch.role,
    Prompt: launch.prompt,
  })),
});

/** Batch title and prompt; reads match permission-prompt tool call ids against this exact text. */
export function describeAntigravitySubagentLaunches(
  launches: ReadonlyArray<AntigravityChildLaunch>,
) {
  const [only] = launches;
  return launches.length === 1 && only !== undefined
    ? { title: only.role, prompt: only.prompt }
    : {
        title: launches.map((launch) => launch.role).join(", "),
        prompt: launches.map((launch) => `${launch.role}\n${launch.prompt}`).join("\n\n"),
      };
}

/** Length-delimited fields only; varints and fixed values are skipped. */
function protoFields(bytes: Uint8Array): ReadonlyArray<readonly [number, Uint8Array]> {
  const fields: Array<readonly [number, Uint8Array]> = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated varint");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("Overlong varint");
  };
  while (offset < bytes.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error("Truncated field");
      fields.push([field, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else throw new Error("Unsupported wire type");
  }
  if (offset > bytes.length) throw new Error("Truncated field");
  return fields;
}

// Keep a leading byte order mark: T3 stores launch text with it.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const messages = (bytes: Uint8Array, field: number) =>
  protoFields(bytes).flatMap(([number, value]) => (number === field ? [value] : []));
const message = (bytes: Uint8Array | undefined, field: number) =>
  bytes === undefined ? undefined : messages(bytes, field)[0];
const text = (bytes: Uint8Array | undefined, field: number) => {
  const value = message(bytes, field);
  return value === undefined ? undefined : textDecoder.decode(value);
};

interface InvokeRecord {
  readonly toolCallId: string | undefined;
  readonly launches: ReadonlyArray<AntigravityChildLaunch>;
  readonly children: ReadonlyArray<{ readonly conversationId: string; readonly logUri: string }>;
}

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Undefined for steps this reader cannot decode, so they never count as proof. */
const safely =
  <A>(decode: (payload: Uint8Array) => A) =>
  (payload: Uint8Array): A | undefined => {
    try {
      return decode(payload);
    } catch {
      return undefined;
    }
  };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const decodeLaunchJson = (value: string | undefined): ReadonlyArray<AntigravityChildLaunch> =>
  value === undefined
    ? []
    : Option.getOrElse(
        Option.flatMap(decodeJson(value), (parsed) =>
          Option.fromNullishOr(antigravitySubagentLaunches(parsed)),
        ),
        () => [],
      );

const decodeInvokeRecord = safely((payload): InvokeRecord | undefined => {
  const metadataCall = message(message(payload, STEP_METADATA), METADATA_TOOL_CALL);
  const toolCallId = text(metadataCall, 1);
  const invoke = message(payload, STEP_INVOKE_SUBAGENT);
  const children =
    invoke === undefined
      ? []
      : messages(invoke, INVOKE_RESULTS).map((result) => ({
          conversationId: text(result, 1) ?? "",
          logUri: text(result, 2) ?? "",
        }));
  if (!children.every((child) => NATIVE_ID.test(child.conversationId))) return undefined;
  const specLaunches =
    invoke === undefined
      ? []
      : messages(invoke, INVOKE_SPECS).map((spec) => ({
          role: text(spec, 2) ?? "",
          prompt: text(spec, 3) ?? "",
        }));
  const launches = specLaunches.length > 0 ? specLaunches : decodeLaunchJson(text(metadataCall, 3));
  if (invoke === undefined && launches.length === 0) return undefined;
  return {
    toolCallId,
    launches,
    children,
  };
});

interface PlannerInvokeCall {
  readonly id: string;
  readonly launches: ReadonlyArray<AntigravityChildLaunch>;
}

const decodePlannerStep = safely(
  (
    payload,
  ): {
    readonly isSilent: boolean;
    readonly invokeCalls: ReadonlyArray<PlannerInvokeCall>;
  } => {
    const planner = message(payload, STEP_PLANNER_RESPONSE);
    if (planner === undefined) return { isSilent: false, invokeCalls: [] };
    let hasText = false;
    let hasThinking = false;
    const invokeCalls: Array<PlannerInvokeCall> = [];
    for (const [field, value] of protoFields(planner)) {
      if (field === PLANNER_TEXT && value.length > 0) {
        hasText = true;
      } else if (field === PLANNER_THINKING && value.length > 0) {
        hasThinking = true;
      } else if (field === PLANNER_TOOL_CALLS) {
        let id: string | undefined;
        let name: string | undefined;
        let argsJson: string | undefined;
        for (const [callField, callValue] of protoFields(value)) {
          if (callField === 1 && id === undefined) id = textDecoder.decode(callValue);
          else if (callField === 2 && name === undefined) name = textDecoder.decode(callValue);
          else if (callField === 3 && argsJson === undefined)
            argsJson = textDecoder.decode(callValue);
        }
        if (name === "invoke_subagent" && id !== undefined) {
          invokeCalls.push({
            id,
            launches: decodeLaunchJson(argsJson),
          });
        }
      }
    }
    return {
      isSilent: !hasText && !hasThinking,
      invokeCalls,
    };
  },
);

const decodeAgentReport = safely(
  (
    payload,
  ):
    | {
        readonly recipientSessionId: string | undefined;
        readonly conversationId: string;
        readonly text: string;
      }
    | undefined => {
    const systemMessage = message(payload, STEP_SYSTEM_MESSAGE);
    if (
      systemMessage === undefined ||
      text(systemMessage, SYSTEM_MESSAGE_KIND) !== "agent_message"
    ) {
      return undefined;
    }
    const report = message(systemMessage, SYSTEM_MESSAGE_AGENT_REPORT);
    if (report === undefined) return undefined;
    const conversationId = text(report, AGENT_REPORT_SENDER_CONVERSATION_ID);
    const reportText = text(report, AGENT_REPORT_TEXT);
    if (
      conversationId === undefined ||
      !NATIVE_ID.test(conversationId) ||
      reportText === undefined ||
      reportText.trim() === ""
    ) {
      return undefined;
    }
    return {
      recipientSessionId: text(report, AGENT_REPORT_RECIPIENT_SESSION_ID),
      conversationId,
      text: reportText,
    };
  },
);

const payloadOf = (row: unknown) =>
  row !== null &&
  typeof row === "object" &&
  "step_payload" in row &&
  row.step_payload instanceof Uint8Array
    ? row.step_payload
    : undefined;

const rowNumber = (row: unknown, key: string): number =>
  row !== null && typeof row === "object" && key in row
    ? Number(row[key as keyof typeof row] ?? 0)
    : 0;

interface BatchLaunch {
  readonly title: string | null;
  readonly prompt: string;
}

const matchesAntigravitySubagentLaunchDescription = (
  expected: BatchLaunch,
  launches: ReadonlyArray<AntigravityChildLaunch>,
): boolean => {
  if (launches.length === 0) return false;
  const full = describeAntigravitySubagentLaunches(launches);
  if (full.title === expected.title && full.prompt === expected.prompt) {
    return true;
  }
  const bounded = describeAntigravitySubagentLaunches(
    launches.map((launch) => ({
      role: boundAntigravityToolText(launch.role),
      prompt: boundAntigravityToolText(launch.prompt),
    })),
  );
  return bounded.title === expected.title && bounded.prompt === expected.prompt;
};

interface IndexedInvokeRecord {
  readonly idx: number;
  readonly stepUpdateIndex: number;
  readonly record: InvokeRecord | undefined;
  readonly plannerCalls: ReadonlyArray<PlannerInvokeCall> | undefined;
}

/**
 * Scans `PLANNER_RESPONSE` and `INVOKE_SUBAGENT` steps in order so each invoke record carries
 * the `StepUpdate.step_index` (`idx - silentPlannerSteps`) that `localharness_external` emits
 * in `<sessionId>:<stepUpdateIndex>` tool call ids.
 */
function readIndexedInvokeRecords(
  database: NodeSqlite.DatabaseSync,
): ReadonlyArray<IndexedInvokeRecord> | undefined {
  let invokeRows = 0;
  let invokeBytes = 0;
  let silentPlannerSteps = 0;
  let lastPlannerStep:
    | {
        readonly idx: number;
        readonly silentPlannerSteps: number;
        readonly calls: ReadonlyArray<PlannerInvokeCall>;
      }
    | undefined;
  const records: Array<IndexedInvokeRecord> = [];

  for (const row of database
    .prepare(
      "SELECT idx, step_type, length(step_payload) AS size, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type IN (?, ?) AND step_format = 0 ORDER BY idx",
    )
    .iterate(MAX_STEP_BYTES, PLANNER_RESPONSE_STEP_TYPE, INVOKE_SUBAGENT_STEP_TYPE)) {
    const stepType = rowNumber(row, "step_type");
    const idx = rowNumber(row, "idx");
    const size = rowNumber(row, "size");
    const payload = payloadOf(row);

    if (stepType === PLANNER_RESPONSE_STEP_TYPE) {
      const planner = payload === undefined ? undefined : decodePlannerStep(payload);
      if (planner === undefined) {
        lastPlannerStep = undefined;
        continue;
      }
      if (planner.isSilent) {
        silentPlannerSteps += 1;
      }
      lastPlannerStep =
        planner.invokeCalls.length > 0
          ? { idx, silentPlannerSteps, calls: planner.invokeCalls }
          : undefined;
      continue;
    }

    if (stepType === INVOKE_SUBAGENT_STEP_TYPE) {
      invokeRows += 1;
      invokeBytes += size;
      if (invokeRows > MAX_INVOKE_ROWS || size > MAX_STEP_BYTES || invokeBytes > MAX_SCAN_BYTES) {
        return undefined;
      }
      const decoded = payload === undefined ? undefined : decodeInvokeRecord(payload);
      const plannerCalls = lastPlannerStep?.calls;
      const plannerLaunches =
        decoded?.toolCallId === undefined
          ? undefined
          : plannerCalls?.find((call) => call.id === decoded.toolCallId)?.launches;
      const record =
        decoded !== undefined &&
        decoded.launches.length === 0 &&
        plannerLaunches !== undefined &&
        plannerLaunches.length > 0
          ? { ...decoded, launches: plannerLaunches }
          : decoded;
      records.push({
        idx,
        stepUpdateIndex: idx - silentPlannerSteps,
        record,
        plannerCalls,
      });
    }
  }

  if (lastPlannerStep !== undefined && lastPlannerStep.calls.length === 1) {
    const [call] = lastPlannerStep.calls;
    if (
      call !== undefined &&
      call.launches.length > 0 &&
      !records.some((entry) => entry.record?.toolCallId === call.id)
    ) {
      const idx = lastPlannerStep.idx + 1;
      records.push({
        idx,
        stepUpdateIndex: idx - lastPlannerStep.silentPlannerSteps,
        record: {
          toolCallId: call.id,
          launches: call.launches,
          children: [],
        },
        plannerCalls: lastPlannerStep.calls,
      });
    }
  }

  return records;
}

const provenAutoApprovedRecord = (
  entries: ReadonlyArray<IndexedInvokeRecord>,
  stepUpdateIndex: number,
): InvokeRecord | undefined => {
  const entry = entries.find((candidate) => candidate.stepUpdateIndex === stepUpdateIndex);
  if (entry?.record === undefined || entry.plannerCalls?.length !== 1) return undefined;
  const [call] = entry.plannerCalls;
  return call !== undefined && entry.record.toolCallId === call.id ? entry.record : undefined;
};

const plannerIdxOfTask = (rootSessionId: string, nativeTaskId: string) => {
  const stepId = /^(.+):(\d+)$/.exec(nativeTaskId);
  return stepId === null ? undefined : stepId[1] === rootSessionId ? Number(stepId[2]) : -1;
};

const canLookupInvokeRecord = (input: {
  readonly rootSessionId: string;
  readonly nativeTaskId: string;
  readonly launch: BatchLaunch;
  readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
}): boolean => {
  const plannerIdx = plannerIdxOfTask(input.rootSessionId, input.nativeTaskId);
  if (plannerIdx !== undefined) {
    return plannerIdx >= 0;
  }
  const sameText = (launch: BatchLaunch) =>
    launch.title === input.launch.title && launch.prompt === input.launch.prompt;
  if (input.siblings.some(sameText)) {
    return false;
  }
  for (const sibling of input.siblings) {
    if (plannerIdxOfTask(input.rootSessionId, sibling.nativeTaskId) !== undefined) continue;
    // A sibling whose launch text is missing or cut under the same roles cannot be ruled out.
    if (
      sibling.title === ANTIGRAVITY_SUBAGENT_BATCH_TITLE ||
      (sibling.title !== null && isCutAntigravityToolText(sibling.title)) ||
      (isCutAntigravityToolText(sibling.prompt) &&
        (sibling.title === null || sibling.title === input.launch.title))
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Auto-approved calls carry `<sessionId>:<stepUpdateIndex>`; the record at that step update
 * index with the preceding planner call's id is the proof. Permission prompts carry a random id,
 * so the launch text must match one record no auto-approved sibling claims, and no sibling may
 * share the text.
 */
function findInvokeRecord(
  database: NodeSqlite.DatabaseSync,
  input: {
    readonly rootSessionId: string;
    readonly nativeTaskId: string;
    readonly launch: BatchLaunch;
    readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
  },
): InvokeRecord | undefined {
  if (!canLookupInvokeRecord(input)) return undefined;
  const plannerIdx = plannerIdxOfTask(input.rootSessionId, input.nativeTaskId);
  if (plannerIdx !== undefined) {
    const entries = readIndexedInvokeRecords(database);
    if (entries === undefined) return undefined;
    const record = provenAutoApprovedRecord(entries, plannerIdx);
    return record === undefined ? undefined : complete(record);
  }
  const totals = database
    .prepare(
      "SELECT count(*) AS rows, coalesce(sum(length(step_payload)), 0) AS bytes, coalesce(max(length(step_payload)), 0) AS largest, sum(step_format != 0) AS other FROM steps WHERE step_type = ?",
    )
    .get(INVOKE_SUBAGENT_STEP_TYPE);
  if (
    rowNumber(totals, "rows") > MAX_INVOKE_ROWS ||
    rowNumber(totals, "bytes") > MAX_SCAN_BYTES ||
    rowNumber(totals, "largest") > MAX_STEP_BYTES ||
    rowNumber(totals, "other") > 0
  ) {
    return undefined;
  }
  const entries = readIndexedInvokeRecords(database);
  if (entries === undefined) return undefined;
  const claimed = new Set<string>();
  for (const sibling of input.siblings) {
    const idx = plannerIdxOfTask(input.rootSessionId, sibling.nativeTaskId);
    if (idx === undefined || idx < 0) continue;
    const claimedRecord = provenAutoApprovedRecord(entries, idx);
    if (claimedRecord?.toolCallId === undefined) return undefined;
    claimed.add(claimedRecord.toolCallId);
  }
  const matches: Array<InvokeRecord> = [];
  for (const { record } of entries) {
    // An unreadable record could be an identical launch, so uniqueness is unproven.
    if (record === undefined) return undefined;
    if (record.toolCallId !== undefined && claimed.has(record.toolCallId)) continue;
    if (matchesAntigravitySubagentLaunchDescription(input.launch, record.launches)) {
      matches.push(record);
    }
  }
  const [match] = matches;
  return matches.length === 1 && match !== undefined ? complete(match) : undefined;
}

const complete = (record: InvokeRecord) =>
  record.launches.length === record.children.length && record.children.length <= MAX_CHILDREN
    ? record
    : undefined;

const TranscriptLine = Schema.Struct({
  step_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  type: Schema.String,
  status: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) })),
  ),
});
const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine));

// The runtime records each tool argument value as JSON text.
const toolArguments = (args: unknown) =>
  Predicate.isObject(args)
    ? Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          typeof value === "string" ? Option.getOrElse(decodeJson(value), () => value) : value,
        ]),
      )
    : (args ?? {});

const capText = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

/** Skips the runtime's opening envelope around the launch prompt the view already shows. */
function transcriptSteps(
  contents: string,
  prompt: string,
): ReadonlyArray<OrchestrationV2NativeChildStep> {
  const launchPrompt = prompt.trim();
  return contents.split("\n").flatMap((line) =>
    Option.match(decodeTranscriptLine(line), {
      onNone: () => [],
      onSome: (step) =>
        step.step_index === 0 &&
        step.type === "SYSTEM_MESSAGE" &&
        launchPrompt !== "" &&
        step.content?.includes(launchPrompt) === true
          ? []
          : [
              {
                index: step.step_index,
                type: step.type,
                status: step.status ?? null,
                text:
                  step.content !== undefined || step.error !== undefined
                    ? capText(step.content ?? step.error ?? "", STEP_TEXT_CAP)
                    : null,
                toolCalls: (step.tool_calls ?? []).map((call) => ({
                  name: call.name,
                  input: capText(JSON.stringify(toolArguments(call.args)), TOOL_INPUT_CAP),
                })),
              },
            ],
    }),
  );
}

/** Reads the tail of the transcript at the named child's own unlinked profile path. */
async function readChildTranscript(
  profileRoot: string,
  child: InvokeRecord["children"][number],
  prompt: string,
  byteCap: number,
) {
  const expected = (
    await antigravityManagedPath(
      profileRoot,
      [
        "antigravity-acp",
        "brain",
        child.conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ],
      "file",
    )
  )?.path;
  if (expected === undefined) return undefined;
  let named: string;
  try {
    named = NodeURL.fileURLToPath(child.logUri);
  } catch {
    return undefined;
  }
  if ((await NodeFSP.realpath(named).catch(() => undefined)) !== expected) return undefined;
  const handle = await NodeFSP.open(
    expected,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const length = Math.min(stat.size, byteCap);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    const truncated = stat.size > length;
    let contents = buffer.subarray(0, bytesRead).toString("utf8");
    // A tail read starts mid-line.
    if (truncated) contents = contents.slice(contents.indexOf("\n") + 1);
    return { steps: transcriptSteps(contents, prompt), truncated };
  } finally {
    await handle.close();
  }
}

async function resolveSessionDatabase(
  profileDirectory: string,
  rootSessionId: string,
): Promise<{ readonly profileRoot: string; readonly databasePath: string } | undefined> {
  const profileRoot = await antigravityProfileRoot(profileDirectory);
  if (profileRoot === undefined) return undefined;
  const databasePath = (
    await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "conversations", `${rootSessionId}.db`],
      "file",
    )
  )?.path;
  return databasePath === undefined ? undefined : { profileRoot, databasePath };
}

class AntigravityChildWorkReadError extends Schema.TaggedError<AntigravityChildWorkReadError>()(
  "AntigravityChildWorkReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read Antigravity subagent records.";
  }
}

/** Children a subagent tool call launched, proven by the parent's own session record. */
export const readAntigravityChildWork = Effect.fn("readAntigravityChildWork")(function* (input: {
  readonly profileDirectory: string;
  readonly rootSessionId: string;
  readonly nativeTaskId: string;
  readonly launch: BatchLaunch;
  /** The thread's other Antigravity batches from this instance. */
  readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
}) {
  if (!NATIVE_ID.test(input.rootSessionId) || !canLookupInvokeRecord(input)) return [];
  return yield* Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<OrchestrationV2NativeChildWork>> => {
      const resolved = await resolveSessionDatabase(input.profileDirectory, input.rootSessionId);
      if (resolved === undefined) return [];
      const database = new NodeSqlite.DatabaseSync(resolved.databasePath, { readOnly: true });
      let record: InvokeRecord | undefined;
      try {
        record = findInvokeRecord(database, input);
      } finally {
        database.close();
      }
      if (record === undefined) return [];
      const { launches, children } = record;
      // One budget for the whole batch, so the response stays small however many children ran.
      const byteCap = Math.min(
        TRANSCRIPT_BYTE_CAP,
        Math.floor(BATCH_TRANSCRIPT_BYTES / Math.max(1, children.length)),
      );
      return Promise.all(
        children.map(async (child, index) => {
          const transcript = await readChildTranscript(
            resolved.profileRoot,
            child,
            launches[index]?.prompt ?? "",
            byteCap,
          ).catch(() => undefined);
          return {
            conversationId: child.conversationId,
            role: launches[index]?.role ?? "",
            prompt: launches[index]?.prompt ?? "",
            steps: transcript?.steps ?? null,
            truncated: transcript?.truncated ?? false,
          };
        }),
      );
    },
    catch: (cause) => new AntigravityChildWorkReadError({ cause }),
  });
});

/**
 * Reads subagent batch records and child `agent_message` reports from the parent's session
 * database so live child tool calls and completion reports route to the subagent thread.
 */
export const readAntigravitySessionSubagentState = Effect.fn("readAntigravitySessionSubagentState")(
  function* (input: {
    readonly profileDirectory: string;
    readonly rootSessionId: string;
    readonly includeBatches?: boolean;
    readonly includeReports?: boolean;
    readonly afterReportStepIndex?: number;
  }) {
    if (!NATIVE_ID.test(input.rootSessionId)) return undefined;
    return yield* Effect.tryPromise({
      try: async (): Promise<AntigravitySessionSubagentState | undefined> => {
        const resolved = await resolveSessionDatabase(input.profileDirectory, input.rootSessionId);
        if (resolved === undefined) return undefined;
        const database = new NodeSqlite.DatabaseSync(resolved.databasePath, { readOnly: true });
        try {
          database.exec("PRAGMA busy_timeout = 100");
          const batches: Array<AntigravitySubagentBatchState> = [];
          if (input.includeBatches !== false) {
            const entries = readIndexedInvokeRecords(database);
            if (entries === undefined) return undefined;
            for (const entry of entries) {
              const record = entry.record;
              if (
                record === undefined ||
                record.launches.length === 0 ||
                record.launches.length > MAX_CHILDREN ||
                record.children.length > MAX_CHILDREN ||
                (record.children.length > 0 && record.children.length !== record.launches.length)
              ) {
                continue;
              }
              batches.push({
                stepUpdateIndex: entry.stepUpdateIndex,
                toolCallId: record.toolCallId,
                launches: record.launches,
                children: record.children.map((child, index) => ({
                  conversationId: child.conversationId,
                  role: record.launches[index]?.role ?? "",
                })),
              });
            }
          }
          const reports: Array<AntigravitySubagentReportState> = [];
          if (input.includeReports !== false) {
            let reportRows = 0;
            let reportBytes = 0;
            for (const row of database
              .prepare(
                "SELECT idx, length(step_payload) AS size, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type = ? AND step_format = 0 AND idx > ? ORDER BY idx",
              )
              .iterate(
                MAX_STEP_BYTES,
                SYSTEM_MESSAGE_STEP_TYPE,
                input.afterReportStepIndex ?? -1,
              )) {
              const idx = rowNumber(row, "idx");
              const size = rowNumber(row, "size");
              reportRows += 1;
              reportBytes += size;
              if (reportRows > MAX_INVOKE_ROWS * MAX_CHILDREN || reportBytes > MAX_SCAN_BYTES) {
                break;
              }
              const payload = payloadOf(row);
              if (payload === undefined) continue;
              const report = decodeAgentReport(payload);
              if (report === undefined) continue;
              if (
                report.recipientSessionId !== undefined &&
                report.recipientSessionId !== input.rootSessionId
              ) {
                continue;
              }
              reports.push({
                stepIndex: idx,
                conversationId: report.conversationId,
                text: report.text,
              });
            }
          }
          return { batches, reports };
        } finally {
          database.close();
        }
      },
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    });
  },
);

interface TrackedSubagentBatch {
  readonly rootSessionId: string;
  readonly nativeTaskId: string;
  readonly childSessionId: string;
  launches: ReadonlyArray<AntigravityChildLaunch>;
  launchesHydrated: boolean;
  children: ReadonlyArray<{ readonly conversationId: string; readonly role: string }>;
  matchedDbStepUpdateIndex: number | undefined;
  completed: boolean;
}

const batchNeedsDbSync = (batch: TrackedSubagentBatch) =>
  batch.matchedDbStepUpdateIndex === undefined ||
  batch.children.length === 0 ||
  batch.launches.length === 0;

const formatChildReport = (role: string | undefined, text: string, multiChild: boolean) =>
  multiChild && role ? `### ${role}\n\n${text}` : text;

/**
 * Tracks active Antigravity subagent batches for a runtime instance, routing child tool updates
 * to their subagent session and emitting child `agent_message` reports + batch completion updates.
 */
export function makeAntigravitySubagentTracker(profileDirectory: string | undefined) {
  const trackedBatches = new Map<string, TrackedSubagentBatch>();
  const childConversationToBatch = new Map<string, TrackedSubagentBatch>();
  const reportsByConversationId = new Map<string, string>();
  const lastReportStepIndexBySession = new Map<string, number>();
  const pendingSyntheticNotifications: Array<EffectAcpSchema.SessionNotification> = [];
  let lastChunkSyncAt: number | undefined;

  const ensureTrackedBatch = (rootSessionId: string, nativeTaskId: string) => {
    let batch = trackedBatches.get(nativeTaskId);
    if (batch === undefined) {
      batch = {
        rootSessionId,
        nativeTaskId,
        childSessionId: antigravitySubagentChildSessionId(nativeTaskId),
        launches: [],
        launchesHydrated: false,
        children: [],
        matchedDbStepUpdateIndex: undefined,
        completed: false,
      };
      trackedBatches.set(nativeTaskId, batch);
    }
    return batch;
  };

  const bindDbBatch = (
    batch: TrackedSubagentBatch,
    dbBatch: AntigravitySubagentBatchState,
    emitHydrationIfNeeded: boolean,
  ) => {
    batch.matchedDbStepUpdateIndex = dbBatch.stepUpdateIndex;
    if (batch.launches.length === 0 && dbBatch.launches.length > 0) {
      batch.launches = dbBatch.launches;
    }
    if (emitHydrationIfNeeded && !batch.launchesHydrated && batch.launches.length > 0) {
      batch.launchesHydrated = true;
      pendingSyntheticNotifications.push(
        normalizeAntigravitySessionUpdate({
          sessionId: batch.rootSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: batch.nativeTaskId,
            title: "Running invoke_subagent",
            kind: "other",
            status: "in_progress",
            rawInput: toAntigravitySubagentRawInput(batch.launches),
          },
        }),
      );
    }
    if (dbBatch.children.length > 0) {
      batch.children = dbBatch.children;
      for (const child of dbBatch.children) {
        childConversationToBatch.set(child.conversationId, batch);
      }
    }
  };

  const syncSubagentsFromDb = (
    rootSessionId: string,
    options: {
      readonly includeBatches: boolean;
      readonly includeReports: boolean;
      readonly updatingTaskId?: string;
    },
  ) => {
    if (profileDirectory === undefined) return Effect.void;
    const afterReportStepIndex = lastReportStepIndexBySession.get(rootSessionId) ?? -1;
    return readAntigravitySessionSubagentState({
      profileDirectory,
      rootSessionId,
      includeBatches: options.includeBatches,
      includeReports: options.includeReports,
      afterReportStepIndex,
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.tap((state) =>
        Effect.sync(() => {
          if (state === undefined) return;
          if (options.includeBatches) {
            const sessionBatches = [...trackedBatches.values()].filter(
              (candidate) => candidate.rootSessionId === rootSessionId,
            );
            const claimedStepIndices = new Set<number>();
            for (const candidate of sessionBatches) {
              if (candidate.matchedDbStepUpdateIndex !== undefined) {
                claimedStepIndices.add(candidate.matchedDbStepUpdateIndex);
              }
            }

            for (const dbBatch of state.batches) {
              const autoTaskId = `${rootSessionId}:${dbBatch.stepUpdateIndex}`;
              const byAutoId = trackedBatches.get(autoTaskId);
              if (byAutoId !== undefined) {
                claimedStepIndices.add(dbBatch.stepUpdateIndex);
                bindDbBatch(byAutoId, dbBatch, byAutoId.nativeTaskId !== options.updatingTaskId);
                continue;
              }
              const byToolCallId =
                dbBatch.toolCallId === undefined
                  ? undefined
                  : trackedBatches.get(dbBatch.toolCallId);
              if (byToolCallId !== undefined) {
                claimedStepIndices.add(dbBatch.stepUpdateIndex);
                bindDbBatch(
                  byToolCallId,
                  dbBatch,
                  byToolCallId.nativeTaskId !== options.updatingTaskId,
                );
                continue;
              }
              if (claimedStepIndices.has(dbBatch.stepUpdateIndex)) continue;
              const byLaunch = sessionBatches.find(
                (candidate) =>
                  candidate.matchedDbStepUpdateIndex === undefined &&
                  candidate.launches.length > 0 &&
                  matchesAntigravitySubagentLaunchDescription(
                    describeAntigravitySubagentLaunches(candidate.launches),
                    dbBatch.launches,
                  ),
              );
              if (byLaunch !== undefined) {
                claimedStepIndices.add(dbBatch.stepUpdateIndex);
                bindDbBatch(byLaunch, dbBatch, byLaunch.nativeTaskId !== options.updatingTaskId);
                continue;
              }
              const hasUnmatchedPermissionBatch = sessionBatches.some(
                (candidate) =>
                  candidate.matchedDbStepUpdateIndex === undefined &&
                  !candidate.nativeTaskId.startsWith(`${rootSessionId}:`),
              );
              if (!hasUnmatchedPermissionBatch) {
                const inferred = ensureTrackedBatch(rootSessionId, autoTaskId);
                claimedStepIndices.add(dbBatch.stepUpdateIndex);
                bindDbBatch(inferred, dbBatch, false);
              }
            }
          }

          if (!options.includeReports) return;

          let maxReportStepIndex = afterReportStepIndex;
          for (const report of state.reports) {
            if (report.stepIndex > maxReportStepIndex) {
              maxReportStepIndex = report.stepIndex;
            }
            const batch = childConversationToBatch.get(report.conversationId);
            if (batch === undefined || batch.completed) continue;
            reportsByConversationId.set(report.conversationId, report.text);
            const reportKey = `${report.conversationId}:${report.stepIndex}`;
            const role = batch.children.find(
              (child) => child.conversationId === report.conversationId,
            )?.role;
            const text = formatChildReport(role, report.text, batch.children.length > 1);
            pendingSyntheticNotifications.push({
              sessionId: batch.childSessionId,
              update: {
                sessionUpdate: "agent_message",
                messageId: `antigravity-subagent-report:${reportKey}`,
                content: [{ type: "text", text }],
              },
            });
          }
          if (maxReportStepIndex > afterReportStepIndex) {
            lastReportStepIndexBySession.set(rootSessionId, maxReportStepIndex);
          }

          for (const batch of trackedBatches.values()) {
            if (
              batch.rootSessionId !== rootSessionId ||
              batch.completed ||
              batch.children.length === 0 ||
              !batch.children.every((child) => reportsByConversationId.has(child.conversationId))
            ) {
              continue;
            }
            batch.completed = true;
            batch.launchesHydrated = true;
            const multiChild = batch.children.length > 1;
            const combinedReport = batch.children
              .map((child) =>
                formatChildReport(
                  child.role,
                  reportsByConversationId.get(child.conversationId) ?? "",
                  multiChild,
                ),
              )
              .join("\n\n");
            for (const child of batch.children) {
              reportsByConversationId.delete(child.conversationId);
            }
            pendingSyntheticNotifications.push(
              normalizeAntigravitySessionUpdate({
                sessionId: batch.rootSessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: batch.nativeTaskId,
                  title: "Running invoke_subagent",
                  kind: "other",
                  status: "completed",
                  ...(batch.launches.length > 0
                    ? { rawInput: toAntigravitySubagentRawInput(batch.launches) }
                    : {}),
                  rawOutput: combinedReport,
                  _meta: { antigravitySubagentCompleted: true },
                },
              }),
            );
          }
        }),
      ),
      Effect.asVoid,
    );
  };

  return {
    rewriteAndDrain: Effect.fn("AntigravitySubagentTracker.rewriteAndDrain")(function* (
      rawNotification: EffectAcpSchema.SessionNotification,
    ) {
      let notification = rawNotification;
      const rootSessionId = notification.sessionId;
      const update = notification.update;
      let isSubagentLaunchOrUpdate = false;
      let isChildToolUpdate = false;

      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if (isAntigravitySubagentToolUpdate(update) || trackedBatches.has(update.toolCallId)) {
          isSubagentLaunchOrUpdate = true;
          const batch = ensureTrackedBatch(rootSessionId, update.toolCallId);
          const inputLaunches = antigravitySubagentLaunches(update.rawInput);
          if (inputLaunches !== undefined && inputLaunches.length > 0) {
            batch.launches = inputLaunches;
            batch.launchesHydrated = true;
          }
          if (batchNeedsDbSync(batch)) {
            yield* syncSubagentsFromDb(rootSessionId, {
              includeBatches: true,
              includeReports: false,
              updatingTaskId: batch.nativeTaskId,
            });
          }
          if (batch.launches.length > 0) {
            batch.launchesHydrated = true;
            if (inputLaunches === undefined) {
              notification = normalizeAntigravitySessionUpdate({
                ...notification,
                update: {
                  ...update,
                  rawInput: toAntigravitySubagentRawInput(batch.launches),
                },
              });
            }
          }
        } else {
          const childPrefix = /^([A-Za-z0-9-]+):\d+$/.exec(update.toolCallId)?.[1];
          if (childPrefix !== undefined && childPrefix !== rootSessionId) {
            if (!childConversationToBatch.has(childPrefix)) {
              yield* syncSubagentsFromDb(rootSessionId, {
                includeBatches: true,
                includeReports: false,
              });
            }
            const childBatch = childConversationToBatch.get(childPrefix);
            if (childBatch !== undefined) {
              isChildToolUpdate = true;
              notification = {
                ...notification,
                sessionId: childBatch.childSessionId,
              };
            }
          }
        }
      }

      if (trackedBatches.size > 0 && !isSubagentLaunchOrUpdate && !isChildToolUpdate) {
        const activeBatches = [...trackedBatches.values()].filter(
          (batch) => batch.rootSessionId === rootSessionId && !batch.completed,
        );
        if (activeBatches.length > 0) {
          const isToolUpdate =
            update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
          const now = yield* Clock.currentTimeMillis;
          if (isToolUpdate || lastChunkSyncAt === undefined || now - lastChunkSyncAt >= 200) {
            lastChunkSyncAt = now;
            yield* syncSubagentsFromDb(rootSessionId, {
              includeBatches: activeBatches.some(batchNeedsDbSync),
              includeReports: true,
            });
          }
        }
      }

      const synthetic = pendingSyntheticNotifications.splice(
        0,
        pendingSyntheticNotifications.length,
      );
      return isSubagentLaunchOrUpdate ? [notification, ...synthetic] : [...synthetic, notification];
    }),
  };
}
