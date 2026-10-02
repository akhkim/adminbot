// Is this module the one node was asked to run?
//
// The obvious spelling is `import.meta.url === \`file://${process.argv[1]}\``, and it is wrong the
// moment a symlink is involved. `import.meta.url` is the *resolved* path; `process.argv[1]` is the
// path as typed. Aurora deploys to `services/openclaw-adminbot/releases/<sha>` and points a
// `current` symlink at it, so every cron wrapper invokes its script through `current/...` while
// import.meta.url reports `releases/<sha>/...`. The two never match, `main()` never runs, and the
// process exits 0 having printed nothing -- a cron job that reports success every night and does
// nothing at all. Five of them were doing exactly that.
//
// Resolving both sides fixes it in either direction: run through the symlink or through the real
// path and the answer is the same.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Pass `import.meta.url`. True when this module is the process entry point. */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // A path that cannot be resolved is not the entry point we are running from.
    return false;
  }
}
