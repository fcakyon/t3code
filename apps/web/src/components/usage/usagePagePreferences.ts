import { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

const isEnvironmentId = Schema.is(EnvironmentId);
const isUsageProvider = Schema.is(UsageProviderKind);
export const isUsageMetric = Schema.is(UsagePagePreferencesSchema.fields.metric);

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export function validateUsagePageSearch(raw: Record<string, unknown>) {
  return {
    ...(isEnvironmentId(raw.environmentId) ? { environmentId: raw.environmentId } : {}),
    ...(isUsageProvider(raw.provider) ? { provider: raw.provider } : {}),
    ...(isUsageMetric(raw.metric) ? { metric: raw.metric } : {}),
  };
}

export function readUsagePagePreferences(
  target: ReturnType<typeof validateUsagePageSearch> = {},
): UsagePagePreferences {
  let preferences = DEFAULT_PREFERENCES;
  try {
    preferences =
      getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
  }
  return {
    ...preferences,
    ...(target.metric ? { metric: target.metric } : {}),
    ...(target.provider
      ? {
          hiddenProviders: UsageProviderKind.literals.filter(
            (provider) => provider !== target.provider,
          ),
        }
      : {}),
  };
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
