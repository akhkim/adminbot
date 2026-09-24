// @vitest-environment jsdom
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderMemberSelect } from "./member-select.ts";

describe("member picker with a large roster", () => {
  it("renders at most 50 choices and lets a typed name reach a later member", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onPick = vi.fn();
    const onOpen = vi.fn();
    const options = Array.from({ length: 101 }, (_, index) => ({
      id: `member-${index}`,
      name: index === 100 ? "Unique Last Member" : `Person ${index}`,
    }));
    render(
      renderMemberSelect({
        options,
        value: "",
        placeholder: "Search",
        label: "Member",
        disabled: false,
        onPick,
        onOpen,
      }),
      container,
    );
    const picker = container.querySelector("adminbot-member-select")!;
    await (picker as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const input = picker.querySelector<HTMLInputElement>("input")!;
    input.focus();
    await (picker as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(onOpen).toHaveBeenCalledOnce();
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(50);
    expect(picker.querySelector('[role="status"]')?.textContent).toContain("Type to narrow");
    input.value = "Unique Last";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await (picker as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(1);
    picker
      .querySelector<HTMLElement>('[role="option"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onPick).toHaveBeenCalledWith("member-100");
  });
});
