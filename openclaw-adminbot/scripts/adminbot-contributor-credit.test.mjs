import assert from "node:assert/strict";
import { test } from "node:test";
import { contributorCredit, bibAuthor } from "./adminbot-contributor-credit.mjs";

test("counts distinct reviewed features, checks merged authorship and sorts verified names", () => {
  const prs = [1, 2, 3].map((number) => ({
    number,
    mergedAt: "2026-10-02",
    author: { login: "alice" },
  }));
  const person = {
    login: "alice",
    name: "Alice Example",
    features: [
      { id: "one", prs: [1, 2] },
      { id: "one", prs: [1] },
      { id: "two", prs: [2] },
    ],
  };
  assert.deepEqual(contributorCredit(prs, [person]), []);
  person.features.push({ id: "three", prs: [3] });
  assert.equal(contributorCredit(prs, [person])[0].features, 3);
  assert.throws(() => contributorCredit(prs.slice(0, 2), [person]), /not a merged contribution/);
  assert.throws(
    () => contributorCredit(prs, [{ ...person, login: "bob" }]),
    /not a merged contribution/,
  );
  const bob = { ...person, login: "bob", name: "Bob Example" };
  const both = prs.concat(
    prs.map((p) => ({ ...p, number: p.number + 3, author: { login: "bob" } })),
  );
  bob.features = bob.features.map((f) => ({ ...f, prs: f.prs.map((n) => n + 3) }));
  assert.deepEqual(
    contributorCredit(both, [bob, person]).map((p) => p.name),
    ["Alice Example", "Bob Example"],
  );
  assert.equal(bibAuthor(["A & B", "C_D"]), "author = {A \\& B and C\\_D},");
});
