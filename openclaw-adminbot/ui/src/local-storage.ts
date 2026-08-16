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
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  if (typeof process !== "undefined" && process.env?.VITEST) {
    return descriptor && !descriptor.get && isStorage(descriptor.value) ? descriptor.value : null;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const storage = window[name];
      return isStorage(storage) ? storage : null;
    } catch {
      return null;
    }
  }

  return descriptor && !descriptor.get && isStorage(descriptor.value) ? descriptor.value : null;
}

export function getSafeLocalStorage(): Storage | null {
  return getSafeStorage("localStorage");
}

export function getSafeSessionStorage(): Storage | null {
  return getSafeStorage("sessionStorage");
}
