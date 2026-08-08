import { describe, expect, it } from "vitest";
import { ScryptPasswordHasher } from "./password.js";

describe("ScryptPasswordHasher", () => {
  it("uses the v1-compatible format and verifies asynchronously", async () => {
    const hasher = new ScryptPasswordHasher();
    const serialized = await hasher.hash("correct horse battery staple");

    expect(serialized).toMatch(/^scrypt\$16384\$8\$1\$/u);
    await expect(hasher.verify(serialized, "correct horse battery staple")).resolves.toBe(true);
    await expect(hasher.verify(serialized, "wrong password")).resolves.toBe(false);
  });

  it("rejects malformed and parameter-amplified hashes", async () => {
    const hasher = new ScryptPasswordHasher();
    await expect(hasher.verify("not-a-hash", "anything")).resolves.toBe(false);
    await expect(
      hasher.verify("scrypt$1073741824$8$1$c2FsdA$aGFzaA", "anything"),
    ).resolves.toBe(false);
  });
});
