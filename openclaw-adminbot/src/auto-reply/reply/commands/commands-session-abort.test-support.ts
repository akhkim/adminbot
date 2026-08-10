// Shared mocks for session abort command tests.
import { vi } from "vitest";

vi.mock("../queue/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../queue/queue.js")>("../queue/queue.js");
  return {
    ...actual,
    clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
  };
});
