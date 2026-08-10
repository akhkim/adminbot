// System event queue helpers without the broad infra-runtime barrel.

export {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system/system-events.js";
