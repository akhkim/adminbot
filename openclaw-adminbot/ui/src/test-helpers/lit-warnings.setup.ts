// Lit emits a one-time dev-mode warning in test builds. Pre-mark it as issued
// so broad UI suites stay signal-heavy instead of repeating the same console.warn.
import { beforeEach } from "vitest";
import { i18n } from "../i18n/index.ts";

const issuedWarnings = ((globalThis as { litIssuedWarnings?: Set<string> }).litIssuedWarnings ??=
  new Set<string>());

issuedWarnings.add("dev-mode");

// The UI lane runs with isolate: false, so the i18n singleton's loaded-bundle
// cache survives from one test file into the next. Files that switch to a
// non-English locale restore the active locale but cannot un-load the bundle,
// which makes any assertion about pre-hydration state order-dependent.
beforeEach(() => {
  i18n.resetForTests();
});
