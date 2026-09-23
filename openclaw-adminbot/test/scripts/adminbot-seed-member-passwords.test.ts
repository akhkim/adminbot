import { describe, expect, it } from "vitest";
import { generatePassword } from "../../scripts/adminbot-seed-member-passwords.ts";

describe("generatePassword", () => {
  // The whole point of the change this covers: the script used to hand every seeded member one
  // shared constant, so any seeded member could sign in as any other who had not yet changed
  // theirs. Distinct salts never helped with that -- only distinct secrets do.
  it("gives a different password every call", () => {
    const passwords = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(passwords.size).toBe(500);
  });

  it("draws only from the unambiguous alphabet", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      // No 0/O and no 1/l/I: these get read aloud and retyped from an email.
      expect(generatePassword()).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{16}$/u);
    }
  });

  it("uses the whole alphabet rather than a biased slice", () => {
    // randomInt over the alphabet, not randomBytes % length -- 256 is not a multiple of 56, so the
    // modulo would over-represent the first characters. Across this many draws every character
    // should appear; a biased generator that never reaches the tail fails here.
    const seen = new Set(Array.from({ length: 400 }, () => generatePassword()).join(""));
    expect(seen.size).toBe(56);
  });
});
