import { describe, expect, it } from "vitest";
import { checkDcsUsernames } from "../../scripts/adminbot-dcs-username-check.js";

describe("checkDcsUsernames", () => {
  it("walks firstname, lastname, then initial+lastname, past every holder", () => {
    const [verdict] = checkDcsUsernames(["Ada Example"], {
      apps0: ["ada"],
      sheet: ["example"],
    });
    expect(verdict).toEqual({
      name: "Ada Example",
      choice: "aexample",
      candidates: [
        { username: "ada", takenBy: ["apps0"] },
        { username: "example", takenBy: ["sheet"] },
        { username: "aexample", takenBy: [] },
      ],
    });
  });

  it("gives no choice when every candidate is held", () => {
    const [verdict] = checkDcsUsernames(["Ada Example"], {
      apps0: ["ada", "example", "aexample"],
    });
    expect(verdict?.choice).toBeUndefined();
  });

  it("gives no candidates for a mononym", () => {
    expect(checkDcsUsernames(["Ada"], { apps0: [] })[0]?.candidates).toEqual([]);
  });
});
