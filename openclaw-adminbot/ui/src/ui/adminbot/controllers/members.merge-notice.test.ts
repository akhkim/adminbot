import { expect, it } from "vitest";
import { mergeConflictLabels } from "./members.ts";

it("names merge conflicts the way the roster does and drops record bookkeeping", () => {
  expect(
    mergeConflictLabels([
      "privilege_level",
      "avatar_url",
      "timezone",
      "onboarding",
      "field_provenance",
    ]),
  ).toEqual(["access level", "photo", "time zone"]);
  expect(mergeConflictLabels(["onboarding", "field_provenance"])).toEqual([]);
  expect(mergeConflictLabels(["some_new_key"])).toEqual(["some new key"]);
});
