// `adminbot auth login` without --email: sign this machine in through the browser, after RFC 8628.
//
// The CLI asks the service for a one-time code, the person approves it in AdminBot with their
// password, and the CLI collects a personal API token. No password ever passes through the
// terminal, and the token is only ever sent to the process that started the request.
// See docs/adminbot/api-tokens.md.
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { saveApiToken } from "./auth.mjs";
import { ApiError, callOperation } from "./client.mjs";

const sleepFor = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Opens the approval page, but only a web page on the service's own scheme rules. */
function openBrowser(link, env) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    return;
  }
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? undefined : "xdg-open";
  if (!opener || env.ADMINBOT_NO_BROWSER === "1") {
    return;
  }
  try {
    const child = spawn(opener, [url.href], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The link is printed as well; a missing opener is not a failure.
  }
}

export async function deviceLogin({
  baseUrl,
  credentials,
  name,
  days,
  browser,
  timeout,
  env,
  stderr,
  fetchImpl,
  sleep = sleepFor,
}) {
  const call = (operationId, body) =>
    callOperation(operationId, { baseUrl, body, timeout, fetchImpl });
  const started = await call("post-auth-device-start", {
    name: name ?? `adminbot CLI on ${hostname().split(".")[0] || "this computer"}`,
    ...(days === undefined ? {} : { expires_in_days: days }),
  });
  const { device_code, user_code, verification_uri, verification_uri_complete } = started ?? {};
  if (typeof device_code !== "string" || typeof user_code !== "string") {
    throw new ApiError("INVALID_RESPONSE", "Invalid login response");
  }
  stderr.write(
    `To sign in, open ${verification_uri_complete ?? verification_uri}\n` +
      `and check that it shows this code: ${user_code}\n` +
      `Approve it only if you started this login. Waiting…\n`,
  );
  if (browser) {
    openBrowser(verification_uri_complete ?? verification_uri, env);
  }
  let interval = Math.max(1, Number(started.interval) || 5) * 1000;
  const deadline = Date.now() + Math.max(1, Number(started.expires_in) || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const polled = await call("post-auth-device-poll", { device_code });
    switch (polled?.status) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5000;
        continue;
      case "access_denied":
        throw new ApiError("ACCESS_DENIED", "The login was denied in AdminBot", 403);
      case "expired_token":
        throw new ApiError("LOGIN_EXPIRED", "The login code expired; run auth login again", 401);
      case "approved": {
        const { token, api_token: apiToken, member } = polled;
        if (typeof token !== "string" || typeof apiToken?.id !== "string") {
          throw new ApiError("INVALID_RESPONSE", "Invalid login response");
        }
        await saveApiToken(credentials, baseUrl, token, apiToken, env);
        return {
          authenticated: true,
          member,
          api_token: { id: apiToken.id, name: apiToken.name, expires_at: apiToken.expires_at },
        };
      }
      default:
        throw new ApiError("INVALID_RESPONSE", "Invalid login response");
    }
  }
  throw new ApiError("LOGIN_EXPIRED", "The login code expired; run auth login again", 401);
}
