import type {
  EnvironmentId,
  ServerProvider,
  UsageLimitSourceSnapshots,
  UsageLimitsSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitPresentations,
} from "./usageLimits.ts";
import { collectLimitNotices } from "./usageLimitsCopy.ts";

export function collectUsageLimitsSummary(
  environmentId: EnvironmentId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsSummary {
  const presentations: LimitPresentations = new Map([
    [
      environmentId,
      {
        entry: { target: { label: environmentId } },
        serverConfig: { providers, usageLimitSources: sources },
      },
    ],
  ]);
  return {
    calculatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    pools: collectLimitPools(collectLimitAccounts(presentations), now).map((pool) => ({
      driver: pool.driver,
      accounts: pool.accounts.map((account) => ({
        id: account.key,
        providerInstanceIds: account.providerInstances.map((instance) => instance.instanceId),
        checkedAt: account.limits.checkedAt,
        windows: account.limits.windows,
      })),
      windows: displayLimitWindows(pool).map(
        ({ members: _members, columns: _columns, resets, ...window }) => ({
          ...window,
          resets: resets.map(({ at, restoresPercent }) => ({
            at: DateTime.formatIso(DateTime.makeUnsafe(at)),
            restoresPercent,
          })),
        }),
      ),
    })),
    notices: collectLimitNotices(presentations),
  };
}
