import { expect, it, vi } from "vitest";
import { AdminBotDeadlineRecommendationStore } from "./deadline-recommendations.ts";

it("explains an unavailable directory endpoint even when its 404 body is not JSON", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
  const store = new AdminBotDeadlineRecommendationStore(
    "https://example.test",
    () => "test-token",
    fetch,
  );
  await expect(store.list({ mode: "members" })).rejects.toThrow(
    "Deadline recommendations are unavailable. Please try again later.",
  );
});
