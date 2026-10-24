import { createAdminBotClient } from "./client.mjs";
const client = createAdminBotClient();
void client.GET("/papers");
void client.PATCH("/papers/{papers_id}/progress", {
  params: { path: { papers_id: "synthetic-paper" } },
  body: { current_step: "overleaf_writing" },
});
// @ts-expect-error Generated API types reject nonexistent routes.
void client.GET("/not-a-real-route");
void client.PATCH("/papers/{papers_id}/progress", {
  params: { path: { papers_id: "synthetic-paper" } },
  // @ts-expect-error The stage enum is generated from the server's TypeScript contract.
  body: { current_step: "invented-stage" },
});
