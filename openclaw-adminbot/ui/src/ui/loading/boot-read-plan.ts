// Builds the plan the inline script in ui/index.html follows on the next cold load: which GETs
// each route opens with. Kept apart from boot-reads.ts because it needs the page-read list, which
// imports the session module, which imports boot-reads.ts.
import { getSafeLocalStorage } from "../../local-storage.ts";
import { ADMINBOT_PAGE_READS } from "../adminbot/auth/page-reads.ts";
import { pathForTab, type Tab } from "../navigation.ts";
import { type BootReadPlan, rememberBootReadPlan } from "./boot-reads.ts";
import { isPrefetchableReadPath } from "./page-data-prefetch.ts";

// Every signed-in route draws from the member's own profile first.
const ALWAYS_READ = ["/lab/members/self"];

export function buildBootReadPlan(base: string, basePath: string): BootReadPlan {
  const routes: Record<string, string[]> = {};
  for (const read of ADMINBOT_PAGE_READS) {
    const path = read.path();
    if (!isPrefetchableReadPath(path)) {
      continue;
    }
    const route = pathForTab(read.tab as Tab, basePath).replace(/\/+$/, "") || "/";
    (routes[route] ??= []).push(path);
  }
  return { v: 1, base, always: [...ALWAYS_READ], routes };
}

/**
 * Writes the plan for this deployment's AdminBot origin and base path. Called once per boot. The
 * origin is resolved inside the guard: the plan is an optimisation for the next load and must
 * never stop this one from connecting.
 */
export function saveBootReadPlan(resolveBase: () => string, basePath: string): void {
  try {
    rememberBootReadPlan(buildBootReadPlan(resolveBase(), basePath), getSafeLocalStorage());
  } catch {
    // Nothing to plan from; the next cold load starts its reads from the app as before.
  }
}
