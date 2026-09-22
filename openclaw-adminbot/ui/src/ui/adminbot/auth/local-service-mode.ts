import type { UiSettings } from "../../storage.ts";
import { resolveAdminBotBaseUrl } from "./session.ts";

/** Opt-in Vite development mode, never a substitute for a gateway credential. */
export function isLocalServiceOnlyMode(settings: Pick<UiSettings, "adminBotUrl">): boolean {
  if (
    !import.meta.env.DEV ||
    import.meta.env.VITE_ADMINBOT_SERVICE_ONLY !== "1" ||
    typeof location === "undefined"
  ) {
    return false;
  }
  const isLoopback = (url: URL) =>
    url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  try {
    return (
      isLoopback(new URL(location.href)) && isLoopback(new URL(resolveAdminBotBaseUrl(settings)))
    );
  } catch {
    return false;
  }
}
