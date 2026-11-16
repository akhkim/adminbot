import { describe, expect, it } from "vitest";
import { createPublicationMailingRunner } from "./mailing-list-email.js";

// The command is asserted, never run: the seam exists so no test mails a real person.
async function argsFor(params: Parameters<ReturnType<typeof createPublicationMailingRunner>>[0]) {
  let seen: string[] = [];
  const send = createPublicationMailingRunner({
    env: {},
    replyTo: "lab@example.org",
    run: async (args) => {
      seen = args;
    },
  });
  await send(params);
  return seen;
}

describe("createPublicationMailingRunner", () => {
  it("copies the cc recipients research outreach names", async () => {
    const args = await argsFor({
      to: "newsletter@example.org",
      cc: ["editor@example.org", "research@example.org"],
      subject: "ICLR 2027 acceptances",
      body: "1. A paper",
    });
    expect(args[args.indexOf("--to") + 1]).toBe("newsletter@example.org");
    expect(args[args.indexOf("--cc") + 1]).toBe("editor@example.org,research@example.org");
  });

  it("passes no cc flag for the digest, which goes to one address", async () => {
    const args = await argsFor({ to: "funder@example.org", subject: "s", body: "b" });
    expect(args).not.toContain("--cc");
    expect(args[args.indexOf("--reply-to") + 1]).toBe("lab@example.org");
  });

  it("refuses to run without a recipient", async () => {
    await expect(argsFor({ to: "  ", subject: "s", body: "b" })).rejects.toThrow(/recipient/u);
  });
});
