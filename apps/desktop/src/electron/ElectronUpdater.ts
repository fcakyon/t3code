// @effect-diagnostics nodeBuiltinImport:off - Unsigned macOS update replacement spawns a detached shell before exiting Electron.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { app as electronApp } from "electron";

import { AppImageUpdater, autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;
type SpawnLog = (cmd: string, args?: Array<string>, ...rest: Array<unknown>) => Promise<boolean>;

// Electron holds the AppImage runtime's keepalive pipe and some files without O_CLOEXEC; a
// relaunched AppImage inherits them, so old runtimes and FUSE mounts never exit. bash (AppRun
// already needs it; dash cannot close multi-digit fds) closes them before exec'ing the AppImage.
// -p skips BASH_ENV and exported functions in the helper only; the AppImage still receives both.
const CLOSE_INHERITED_FDS_THEN_EXEC =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done; exec "$@"';

const relaunchWithoutInheritedDescriptors = (updater: AppImageUpdater) => {
  const spawnLog = (AppImageUpdater.prototype as unknown as { spawnLog: SpawnLog }).spawnLog;
  (updater as unknown as { spawnLog: SpawnLog }).spawnLog = function (cmd, args = [], ...rest) {
    return spawnLog.call(
      this,
      "bash",
      ["-p", "-c", CLOSE_INHERITED_FDS_THEN_EXEC, cmd, cmd, ...args],
      ...rest,
    );
  };
};

function resolveMacAppBundlePath(execPath: string): string | null {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.indexOf(marker);
  if (index === -1) return null;
  return execPath.slice(0, index + 4);
}

function isMacAppDeveloperIdSigned(appBundlePath: string): boolean {
  try {
    const output = NodeChildProcess.execFileSync(
      "codesign",
      ["-dv", "--verbose=2", appBundlePath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output.includes("Authority=Developer ID Application:");
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { readonly stderr?: unknown }).stderr ?? "")
        : "";
    return stderr.includes("Authority=Developer ID Application:");
  }
}

function resolveDownloadedUpdateZipPath(): string | null {
  const helper = (
    autoUpdater as unknown as {
      readonly downloadedUpdateHelper?: {
        readonly file?: string | null;
        readonly cacheDir?: string | null;
      } | null;
    }
  ).downloadedUpdateHelper;
  if (helper?.file && NodeFS.existsSync(helper.file)) {
    return helper.file;
  }
  if (helper?.cacheDir) {
    const fallbackZip = NodePath.join(helper.cacheDir, "update.zip");
    if (NodeFS.existsSync(fallbackZip)) {
      return fallbackZip;
    }
  }
  return null;
}

function installUnsignedMacUpdateAndRestart(
  zipFilePath: string,
  appBundlePath: string,
  isForceRunAfter: boolean,
): void {
  const stagingRoot = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(zipFilePath), "t3-mac-update-"),
  );
  NodeChildProcess.execFileSync("/usr/bin/ditto", ["-x", "-k", zipFilePath, stagingRoot]);
  const extractedAppName = NodeFS.readdirSync(stagingRoot).find((entry) => entry.endsWith(".app"));
  if (!extractedAppName) {
    throw new Error(`No .app bundle found in downloaded update archive ${zipFilePath}.`);
  }
  const stagedAppPath = NodePath.join(stagingRoot, extractedAppName);
  try {
    NodeChildProcess.execFileSync("/usr/bin/xattr", ["-cr", stagedAppPath]);
  } catch {
    // Best-effort quarantine cleanup before swap.
  }

  const script = [
    'target_app="$1"',
    'staged_app="$2"',
    'staging_root="$3"',
    'relaunch="$4"',
    'exec_path="$5"',
    "for _ in $(seq 1 150); do",
    '  if ! /usr/bin/pgrep -f "$exec_path" >/dev/null 2>&1; then break; fi',
    "  sleep 0.1",
    "done",
    'rm -rf "$target_app"',
    'mv "$staged_app" "$target_app"',
    'rm -rf "$staging_root"',
    '/usr/bin/xattr -cr "$target_app" 2>/dev/null || true',
    'if [ "$relaunch" = "1" ]; then',
    '  /usr/bin/open -n "$target_app"',
    "fi",
  ].join("\n");

  const child = NodeChildProcess.spawn(
    "/bin/sh",
    [
      "-c",
      script,
      "t3-mac-updater",
      appBundlePath,
      stagedAppPath,
      stagingRoot,
      isForceRunAfter ? "1" : "0",
      electronApp.getPath("exe"),
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  electronApp.exit(0);
}

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public */
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
    return Effect.suspend(() => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    });
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    });
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    });
  }),
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
    return Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    });
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    });
  }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    });
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    });
  }),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    function (value) {
      return Effect.suspend(() => {
        autoUpdater.disableDifferentialDownload = value;
        return Effect.void;
      });
    },
  ),
  checkForUpdates: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
    isSilent,
    isForceRunAfter,
  }) {
    return Effect.suspend(() => {
      const channel = autoUpdater.channel;
      if (autoUpdater instanceof AppImageUpdater) relaunchWithoutInheritedDescriptors(autoUpdater);
      return Effect.try({
        try: () => {
          const appBundlePath = resolveMacAppBundlePath(electronApp.getPath("exe"));
          const zipFilePath = appBundlePath ? resolveDownloadedUpdateZipPath() : null;
          if (appBundlePath && zipFilePath && !isMacAppDeveloperIdSigned(appBundlePath)) {
            installUnsignedMacUpdateAndRestart(zipFilePath, appBundlePath, isForceRunAfter);
            return;
          }
          autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
        },
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    });
  }),
  on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
