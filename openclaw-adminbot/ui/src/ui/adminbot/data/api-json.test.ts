import { describe, expect, it } from "vitest";
import { readApiJson } from "./api-json.ts";

function from(url: string, body: unknown): Response {
  const response = new Response(JSON.stringify(body));
  Object.defineProperty(response, "url", { value: url });
  return response;
}

// The service sends uploaded photos as /avatars/<hash>, relative to itself. The console runs on
// another origin, so an <img> needs the service's origin spelled out.
describe("readApiJson", () => {
  it("resolves photo paths against the service that sent them", async () => {
    const hash = "a".repeat(64);
    const body = await readApiJson(
      from("https://api.example.org/lab/members?x=1", {
        members: [
          { avatar_url: `/avatars/${hash}` },
          { avatar_url: "https://avatars.slack-edge.com/a.png" },
          { note: `/avatars/${hash}` },
        ],
      }),
    );
    expect(body).toEqual({
      members: [
        { avatar_url: `https://api.example.org/avatars/${hash}` },
        { avatar_url: "https://avatars.slack-edge.com/a.png" },
        { note: `/avatars/${hash}` },
      ],
    });
  });

  it("reads an empty or broken body as null", async () => {
    expect(await readApiJson(new Response(""))).toBeNull();
    expect(await readApiJson(new Response("{"))).toBeNull();
  });
});
