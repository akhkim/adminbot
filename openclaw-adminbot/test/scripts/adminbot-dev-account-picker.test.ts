import type { ConfigEnv, UserConfig, ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import { adminBotDevAccountPicker } from "../../ui/config/adminbot-dev-account-picker.ts";

describe("development account picker isolation", () => {
  const enabled = { ADMINBOT_DEV_ACCOUNT_PICKER: "1", NODE_ENV: "development" };
  function applies(env: NodeJS.ProcessEnv, command: ConfigEnv["command"], mode: string) {
    const apply = adminBotDevAccountPicker(env).apply as (
      config: UserConfig,
      environment: ConfigEnv,
    ) => boolean;
    return apply({ mode }, { command, mode });
  }

  it("is absent from builds, production mode, and ordinary development startup", () => {
    expect(applies(enabled, "serve", "development")).toBe(true);
    expect(applies(enabled, "build", "development")).toBe(false);
    expect(applies(enabled, "build", "production")).toBe(false);
    expect(applies(enabled, "serve", "production")).toBe(false);
    expect(applies({ ...enabled, NODE_ENV: "production" }, "serve", "development")).toBe(false);
    expect(applies({}, "serve", "development")).toBe(false);
  });

  it.each([true, "0.0.0.0", "::", "localhost", undefined])(
    "refuses unsafe or ambiguous listening host %s",
    (host) => {
      const configure = adminBotDevAccountPicker({
        ...enabled,
        ADMINBOT_PORT: "8801",
        ADMINBOT_DEV_DATABASE: "state/adminbot-dev.sqlite",
        ADMINBOT_DEV_PASSWORD: "Synthetic-test-password!",
      }).configureServer as (server: ViteDevServer) => void;
      expect(() =>
        configure({ config: { server: { host, port: 5173 } } } as ViteDevServer),
      ).toThrow(/loopback-only/u);
    },
  );
});
