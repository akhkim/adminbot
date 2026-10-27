// The macOS Keychain, for the one secret `adminbot auth login` saves: a personal API token.
//
// The secret never goes in a process argument (visible to every local user through `ps`): it is
// written through `security -i`, which reads its command from stdin, and read back on stdout.
// Elsewhere, or with ADMINBOT_KEYCHAIN=0, the caller falls back to the private credentials file.
// `security -i` exits 0 even when the command inside it fails, so a save is only trusted once it
// reads back.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ApiError } from "./client.mjs";

const SERVICE = "adminbot";
// Checked before it is written into a `security -i` command line, which splits on whitespace and
// honours quotes: a value outside these characters could smuggle in a second command.
const TOKEN_SHAPE = /^abt_[A-Za-z0-9_-]{20,120}$/u;
const ACCOUNT_SHAPE = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/u;

export function keychainAvailable(env = process.env) {
  return process.platform === "darwin" && env.ADMINBOT_KEYCHAIN !== "0";
}

function run(args, input, env) {
  // A keychain file other than the login keychain, for tests only.
  const keychain = env.ADMINBOT_KEYCHAIN_FILE ? [env.ADMINBOT_KEYCHAIN_FILE] : [];
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", input === undefined ? [...args, ...keychain] : args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => reject(new ApiError("KEYCHAIN_ERROR", "Cannot run macOS security")));
    child.on("close", (code) => resolve({ code, stdout }));
    if (input !== undefined) {
      child.stdin.end(`${input} ${keychain.map((path) => `"${path}"`).join(" ")}\n`);
    } else {
      child.stdin.end();
    }
  });
}

export async function keychainSave(account, token, env = process.env) {
  if (!ACCOUNT_SHAPE.test(account) || !TOKEN_SHAPE.test(token)) {
    throw new ApiError("KEYCHAIN_ERROR", "Refusing to store an unexpected value in the Keychain");
  }
  // `security -i` writes to the login keychain when the named file is missing.
  if (env.ADMINBOT_KEYCHAIN_FILE && !existsSync(env.ADMINBOT_KEYCHAIN_FILE)) {
    throw new ApiError("KEYCHAIN_ERROR", "ADMINBOT_KEYCHAIN_FILE does not exist");
  }
  const { code } = await run(
    ["-i"],
    `add-generic-password -U -s ${SERVICE} -a "${account}" -l "AdminBot API token" -w "${token}"`,
    env,
  );
  if (code !== 0 || (await keychainRead(account, env)) !== token) {
    throw new ApiError("KEYCHAIN_ERROR", "Could not save the token in the macOS Keychain");
  }
}

export async function keychainRead(account, env = process.env) {
  const { code, stdout } = await run(
    ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
    undefined,
    env,
  );
  const token = stdout.trim();
  return code === 0 && TOKEN_SHAPE.test(token) ? token : undefined;
}

export async function keychainDelete(account, env = process.env) {
  await run(["delete-generic-password", "-s", SERVICE, "-a", account], undefined, env);
}
