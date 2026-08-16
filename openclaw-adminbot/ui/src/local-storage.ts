// Control UI module implements local storage behavior.
// The whole Storage contract, not just the two accessors most callers reach for.
// A half-implemented stand-in used to pass this check and reach callers as a
// real Storage, so `storage.clear()` threw instead of the call being skipped.
const STORAGE_METHODS = ["getItem", "setItem", "removeItem", "clear", "key"] as const;

function isStorage(value: unknown): value is Storage {
  if (!value) {
    return false;
  }
  const candidate = value as Storage;
  return STORAGE_METHODS.every((method) => typeof candidate[method] === "function");
}

function getSafeStorage(name: "localStorage" | "sessionStorage"): Storage | null {
  // A real DOM wins, tests included. Under Vitest this used to be checked last,
  // so jsdom's own storage — an accessor property, not a data property — was
  // rejected and every UI test had to overwrite the global to get storage at all.
  // Those overwrites are what leaked between files in the shared worker.
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const storage = window[name];
      return isStorage(storage) ? storage : null;
    } catch {
      return null;
    }
  }

  // No DOM: read the global directly, and skip accessor properties. Node's
  // sessionStorage getter warns when there is no storage file behind it, and
  // touching it is exactly what that warning is about.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  return descriptor && !descriptor.get && isStorage(descriptor.value) ? descriptor.value : null;
}

export function getSafeLocalStorage(): Storage | null {
  return getSafeStorage("localStorage");
}

export function getSafeSessionStorage(): Storage | null {
  return getSafeStorage("sessionStorage");
}
