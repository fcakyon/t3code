import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import { validateUsagePageSearch } from "../components/usage/usagePagePreferences";

export const Route = createFileRoute("/_chat/usage")({
  validateSearch: validateUsagePageSearch,
  remountDeps: ({ search }) => [search.environmentId, search.provider, search.metric],
  component: UsagePage,
});
