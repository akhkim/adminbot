/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinancialNeedsSection, fromDrafts, toDrafts } from "./financial-needs.ts";

afterEach(() => document.body.replaceChildren());

const blank = {
  category: "other" as const,
  amount: "",
  currency: "",
  description: "",
  pi_permission: "",
};

describe("financial support drafts", () => {
  it("drops an untouched row and stores typed rows in the service's shape", () => {
    const result = fromDrafts([
      blank,
      {
        category: "ai_subscription",
        amount: " 240 ",
        currency: "usd",
        description: " Agent API credits ",
        pi_permission: "Yes, expense it",
      },
      { ...blank, category: "travel", description: "Train to the workshop" },
    ]);
    expect(result).toEqual({
      ok: true,
      entries: [
        {
          category: "ai_subscription",
          amount: 240,
          currency: "USD",
          description: "Agent API credits",
          pi_permission: "Yes, expense it",
        },
        { category: "travel", description: "Train to the workshop" },
      ],
    });
  });

  it("refuses a row with no description, a bad amount or a bad currency", () => {
    expect(fromDrafts([{ ...blank, amount: "50" }]).ok).toBe(false);
    expect(fromDrafts([{ ...blank, description: "x", amount: "-1" }]).ok).toBe(false);
    expect(fromDrafts([{ ...blank, description: "x", currency: "dollars" }]).ok).toBe(false);
    // An amount needs its currency: the sheet totals per currency and never converts.
    expect(fromDrafts([{ ...blank, description: "x", amount: "5" }]).ok).toBe(false);
  });

  it("round-trips stored entries and ignores junk", () => {
    expect(toDrafts("nope")).toEqual([]);
    expect(toDrafts([null, { category: "travel", amount: 12.5, description: "Bus" }])).toEqual([
      { category: "travel", amount: "12.5", currency: "", description: "Bus", pi_permission: "" },
    ]);
  });
});

describe("<adminbot-financial-needs>", () => {
  async function mount(onSave: (entries: unknown) => Promise<boolean>) {
    const element = new FinancialNeedsSection();
    element.entries = [{ category: "travel", description: "Bus", amount: 20, currency: "CAD" }];
    element.onSave = onSave;
    document.body.append(element);
    await element.updateComplete;
    return element;
  }
  const root = (element: FinancialNeedsSection) => element.shadowRoot!;
  const buttons = (element: FinancialNeedsSection) =>
    [...root(element).querySelectorAll("button")].map((b) => b.textContent?.trim());

  it("adds a row, saves the whole list, and keeps the rows if the save is refused", async () => {
    const onSave = vi.fn(async () => false);
    const element = await mount(onSave);
    expect(root(element).querySelectorAll("li")).toHaveLength(1);

    (root(element).querySelector("button:not(.primary):not(.link)") as HTMLButtonElement).click();
    await element.updateComplete;
    const description = root(element).querySelectorAll<HTMLInputElement>(
      'input[name="description"]',
    )[1];
    description.value = "Chat plan";
    description.dispatchEvent(new Event("input"));
    await element.updateComplete;

    (root(element).querySelector("button.primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([
      { category: "travel", amount: 20, currency: "CAD", description: "Bus" },
      { category: "ai_subscription", currency: "USD", description: "Chat plan" },
    ]);
    await element.updateComplete;
    expect(root(element).querySelector('[role="alert"]')?.textContent).toContain("Not saved");
    expect(root(element).querySelectorAll("li")).toHaveLength(2);
    expect(buttons(element)).toContain("Save");
  });

  it("hides Save again when an added row is removed before saving", async () => {
    const element = await mount(async () => true);
    expect(buttons(element)).not.toContain("Save");
    (root(element).querySelector("button:not(.primary):not(.link)") as HTMLButtonElement).click();
    await element.updateComplete;
    expect(buttons(element)).toContain("Save");
    [...root(element).querySelectorAll<HTMLButtonElement>("button.link")].at(-1)!.click();
    await element.updateComplete;
    expect(buttons(element)).not.toContain("Save");
  });

  it("still detaches with Element.remove(), which Lit uses when the page drops the section", async () => {
    const element = await mount(async () => true);
    element.remove();
    expect(element.isConnected).toBe(false);
  });
});
