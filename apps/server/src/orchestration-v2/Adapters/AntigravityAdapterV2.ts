import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import { createModelSelection, modelSelectionsEqual } from "@t3tools/shared/model";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityAppendsSystemPrompt,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  type AntigravityChildLaunch,
  antigravitySubagentChildSessionId,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
  makeAntigravitySubagentTracker,
  makeAntigravityCommandTaskTracker,
} from "../../provider/acp/AntigravityChildWork.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import {
  cancelStaleAntigravityRunningSteps,
  watchAntigravityPromptOutcome,
} from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpSubagentUpdateContext,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const isCompletedAntigravitySubagentMeta = (meta: unknown): boolean =>
  Predicate.isObject(meta) &&
  "antigravitySubagentCompleted" in meta &&
  meta.antigravitySubagentCompleted === true;

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    activeSteeringInterruptsTools: false,
    activeSteeringAcceptsAttachments: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly supportsNativeGoals?: Effect.Effect<boolean>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs record upstream turn errors and step status. */
  readonly profileDirectory?: string;
}

const ANTIGRAVITY_MODEL_TIER_LABELS: Readonly<Record<string, string>> = {
  flash_lite: "Flash Lite",
  flash: "Flash",
  pro: "Pro",
};

function resolveAntigravitySubagentModel(
  launches: ReadonlyArray<AntigravityChildLaunch> | undefined,
  context?: AcpSubagentUpdateContext,
): {
  readonly model: string | null;
  readonly modelSelection?: ModelSelection;
} {
  if (launches === undefined || launches.length === 0) {
    return { model: null };
  }
  const parentSelection = context?.parentModelSelection;
  const resolveSingle = (
    launch: AntigravityChildLaunch,
  ): {
    readonly model: string | null;
    readonly modelSelection?: ModelSelection;
  } => {
    const rawModel = launch.model?.trim() ?? "";
    const normalized = rawModel.toLowerCase();
    if (!normalized || normalized === "inherit") {
      const parentModel = parentSelection?.model.trim();
      if (!parentSelection || !parentModel || parentModel === ANTIGRAVITY_DEFAULT_MODEL) {
        return { model: null };
      }
      return {
        model: parentModel,
        modelSelection: parentSelection,
      };
    }
    const resolvedModel = ANTIGRAVITY_MODEL_TIER_LABELS[normalized] ?? rawModel;
    return {
      model: resolvedModel,
      ...(parentSelection === undefined
        ? {}
        : { modelSelection: createModelSelection(parentSelection.instanceId, resolvedModel) }),
    };
  };
  const resolved = launches.map(resolveSingle);
  const [first, ...rest] = resolved;
  if (first === undefined) {
    return { model: null };
  }
  const allMatch = rest.every(
    (entry) =>
      entry.model === first.model &&
      (entry.modelSelection === undefined
        ? first.modelSelection === undefined
        : first.modelSelection !== undefined &&
          modelSelectionsEqual(entry.modelSelection, first.modelSelection)),
  );
  return allMatch ? first : { model: null };
}

/**
 * Each subagent batch gets a synthetic `antigravity-task:<nativeTaskId>` child session id so
 * child tool calls and `agent_message` reports from the session database route to the subagent
 * thread while keeping the child thread read-only.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
  context,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const completedByReport =
    toolCall.status === "completed" && isCompletedAntigravitySubagentMeta(toolCall.data.meta);
  const status =
    toolCall.status === "failed"
      ? "failed"
      : toolCall.status === "pending"
        ? "pending"
        : completedByReport
          ? "completed"
          : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  const { model, modelSelection } = resolveAntigravitySubagentModel(launches, context);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      (completedByReport ? undefined : antigravitySubagentOutput(toolCall)) ??
      toolCall.detail ??
      toolCall.title ??
      ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    title: launch?.title ?? ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    model,
    ...(modelSelection === undefined ? {} : { modelSelection }),
    status,
    childSessionId: antigravitySubagentChildSessionId(toolCall.toolCallId),
    result:
      status === "failed" || status === "completed"
        ? (antigravitySubagentOutput(toolCall) ?? null)
        : null,
    ...(launch === undefined ? { provisional: true } : {}),
  };
};

interface AntigravityFlavorServices {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  const commandTasks = makeAntigravityCommandTaskTracker(profileDirectory);
  const antigravityClientFileRoots = (cwd: string | null) =>
    cwd === null ? [options.host.paths.attachmentsDir] : [cwd, options.host.paths.attachmentsDir];
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            clientFileReads: true,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
            additionalDirectories: [options.host.paths.attachmentsDir],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      const subagents = makeAntigravitySubagentTracker(profileDirectory);
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      const watchedSessions = new Set<string>();
      const watchSession = Effect.fn("AntigravityAdapterV2.watchSession")(
        function* (started: AcpSessionRuntime.AcpSessionRuntimeStartResult) {
          const { sessionId } = started;
          if (watchedSessions.has(sessionId)) return;
          watchedSessions.add(sessionId);
          const ready = yield* Deferred.make<void>();
          const changes = yield* commandTasks.changes(sessionId, () =>
            Deferred.doneUnsafe(ready, Exit.void),
          );
          yield* changes.pipe(
            Stream.runForEach(() =>
              updates.withPermit(
                projectUpdate?.({ sessionId, update: { sessionUpdate: "session_info_update" } }) ??
                  Effect.void,
              ),
            ),
            Effect.ignoreCause({ log: true }),
            Effect.ensuring(Deferred.succeed(ready, undefined)),
            Effect.forkIn(scope),
          );
          yield* Deferred.await(ready);
        },
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      );
      const repairedSessions = new Set<string>();
      const repairBeforeOpen = (sessionId: string | undefined) => {
        if (
          profileDirectory === undefined ||
          sessionId === undefined ||
          repairedSessions.has(sessionId)
        ) {
          return Effect.void;
        }
        repairedSessions.add(sessionId);
        return cancelStaleAntigravityRunningSteps(profileDirectory, sessionId);
      };
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          (promptOptions?.steering ? Effect.void : Effect.sync(reads.reset)).pipe(
            Effect.andThen(runtime.prompt(payload, promptOptions)),
          ),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((rawNotification) =>
            updates.withPermit(
              subagents
                .rewriteAndDrain(rawNotification)
                .pipe(
                  Effect.flatMap((notifications) =>
                    Effect.forEach(
                      notifications,
                      (notification) => handler(reads.repair(notification)),
                      { discard: true },
                    ),
                  ),
                ),
            ),
          );
        },
        resumeSession: (sessionId, configOptions) =>
          repairBeforeOpen(sessionId).pipe(
            Effect.andThen(runtime.resumeSession(sessionId, configOptions)),
            Effect.tap(watchSession),
          ),
        loadSession: (sessionId, configOptions) =>
          repairBeforeOpen(sessionId).pipe(
            Effect.andThen(runtime.loadSession(sessionId, configOptions)),
            Effect.tap(watchSession),
          ),
        start: () =>
          repairBeforeOpen(input.resumeSessionId).pipe(
            Effect.andThen(runtime.start()),
            Effect.tap(watchSession),
            Effect.tap((started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void),
          ),
      } satisfies typeof runtime;
    },
    Effect.provideService(SecureRandom.SecureRandom, options.random),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    pendingBackgroundTasks: commandTasks.read,
    promptSteering: (initializeResult) => {
      const version = initializeResult.agentInfo?.version;
      return (
        initializeResult.protocolVersion === 1 &&
        version !== undefined &&
        compareSemverVersions(version, "1.5.1") >= 0
      );
    },
    supportsNativeGoals: options.supportsNativeGoals ?? Effect.succeed(false),
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    makeRuntime,
    buildAttachmentPrompt: ({
      text,
      attachments,
      resolveAttachmentPath,
      promptCapabilities,
      agentVersion,
      currentModel,
    }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        resolveAttachmentPath,
        promptCapabilities,
        agentVersion,
        currentModel,
      }).pipe(
        Effect.map((blocks) => (text.trim() ? blocks.slice(1) : blocks)),
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Loading history replays tool calls; resume avoids replay.
    subagentsIdleOnTurnCompletion: true,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: antigravityClientFileRoots(cwd),
          request,
        }),
    },
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    deferFinalizeForBackgroundWork: true,
    enablePostSettleContinuation: true,
    promptOnEmptyContinuationWake: true,
    supportsImagePrompts: true,
    // ACP 1.3.0 treats /compact as ordinary model input.
    supportsCompaction: false,
    requiresSignIn: isAntigravitySignInRequiredError,
    // Antigravity can leave a prompt open without updates; long tools and approvals pause this.
    promptInactivityTimeout: "15 minutes",
    // 1.4.5 returns the root trajectory's Gemini usageMetadata delta; 1.4.1 returns none.
    reportsPerTurnPromptUsage: true,
    geminiPromptUsage: true,
    ...(profileDirectory === undefined
      ? {}
      : {
          watchPromptOutcome: (sessionId: string) =>
            watchAntigravityPromptOutcome(profileDirectory, sessionId),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    random: yield* SecureRandom.SecureRandom,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
