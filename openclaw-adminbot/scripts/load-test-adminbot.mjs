#!/usr/bin/env node
// Run against a local, fictional AdminBot fixture. Never load-test the deployed lab service.
const baseUrl = new URL(process.env.ADMINBOT_LOAD_URL ?? "http://127.0.0.1:8765");
if (!["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)) {
  throw new Error("ADMINBOT_LOAD_URL must point to a local fixture service");
}

const email = process.env.ADMINBOT_LOAD_EMAIL;
const password = process.env.ADMINBOT_LOAD_PASSWORD;
if (!email || !password) {
  throw new Error("Set ADMINBOT_LOAD_EMAIL and ADMINBOT_LOAD_PASSWORD for the fixture account");
}

function positiveInt(name, fallback, max) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/u.test(raw) || Number(raw) > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return Number(raw);
}

const requests = positiveInt("ADMINBOT_LOAD_REQUESTS", 20, 1000);
const concurrency = positiveInt("ADMINBOT_LOAD_CONCURRENCY", 4, 50);
const paths = (
  process.env.ADMINBOT_LOAD_PATHS ?? "/lab/members/self,/lab/members?limit=50&offset=0"
)
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean);
if (
  paths.length === 0 ||
  paths.some(
    (path) =>
      !path.startsWith("/") ||
      path.startsWith("//") ||
      new URL(path, baseUrl).origin !== baseUrl.origin,
  )
) {
  throw new Error("ADMINBOT_LOAD_PATHS must contain local absolute paths");
}

const login = await fetch(new URL("/auth/login", baseUrl), {
  method: "POST",
  redirect: "error",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) {
  throw new Error(`Fixture login failed (${login.status})`);
}
const { session_token: token } = await login.json();
if (typeof token !== "string") {
  throw new Error("Fixture login did not return a session token");
}

async function request(path) {
  const started = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    redirect: "error",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  JSON.parse(body);
  return {
    ms: performance.now() - started,
    bytes: Buffer.byteLength(body),
    status: response.status,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

for (const path of paths) {
  const warmup = await request(path);
  if (warmup.status !== 200) {
    throw new Error(`${path} returned ${warmup.status} during warmup`);
  }
  let next = 0;
  const results = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests) }, async () => {
      while (next < requests) {
        next += 1;
        results.push(await request(path));
      }
    }),
  );
  const wallMs = performance.now() - started;
  const times = results.map((result) => result.ms).toSorted((a, b) => a - b);
  const failures = results.filter((result) => result.status !== 200).length;
  const bytes = Math.round(results.reduce((sum, result) => sum + result.bytes, 0) / results.length);
  console.log(
    `${path}: n=${requests} concurrency=${concurrency} ` +
      `p50=${percentile(times, 0.5).toFixed(1)}ms p95=${percentile(times, 0.95).toFixed(1)}ms ` +
      `mean-bytes=${bytes} throughput=${((requests * 1000) / wallMs).toFixed(1)}/s ` +
      `errors=${failures}`,
  );
  if (failures) {
    process.exitCode = 1;
  }
}
