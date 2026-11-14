import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["t3code", "t3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each(["t3code", "t3code-dev"])("opens %s Usage with only its selected filters", (scheme) => {
    expect(
      providerAuthReturnUrl(
        `${scheme}://app/usage?environmentId=m5max&provider=claude&metric=limits&code=secret&instanceId=work#ignored`,
      ),
    ).toBe(`${scheme}://app/usage?environmentId=m5max&provider=claude&metric=limits`);
  });
  it.each([
    "t3code://app/usage/other",
    "t3code://attacker/usage",
    "t3code://user@app/usage",
    "https://attacker.example/usage",
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
