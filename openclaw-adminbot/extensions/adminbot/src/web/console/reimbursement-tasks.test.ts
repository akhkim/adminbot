import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderAdminBotWebUi } from "./index.js";

function harness() {
  const html = renderAdminBotWebUi();
  const start = html.indexOf("    async function prepareReimbursementVisitor()");
  const end = html.indexOf('    document.getElementById("reimb-form").addEventListener', start);
  expect(start).toBeGreaterThan(0);
  const buttons: Array<{ textContent: string; click?: () => void }> = [];
  const reimbursement = {
    messages: [] as Array<{ text: string }>,
    draft: {},
    ready: false,
    taskId: null,
    pollTimer: null,
    visitorToken: null,
    pendingTurn: null as { key: string; input: string } | null,
  };
  const fetch = vi.fn();
  const context = {
    reimbursement,
    fetch,
    sessionStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(),
    renderReimbursementLog: vi.fn(),
    setStatus: vi.fn(() => {
      buttons.length = 0;
    }),
    document: {
      getElementById: () => ({
        appendChild: (button: (typeof buttons)[number]) => buttons.push(button),
      }),
      createElement: () => {
        const button = {
          textContent: "",
          click: undefined as (() => void) | undefined,
          addEventListener: (_event: string, click: () => void) => {
            button.click = click;
          },
        };
        return button;
      },
    },
  };
  const helpers = runInNewContext(
    `${html.slice(start, end)}; ({ apply: applyReimbursementResponse, submit: submitReimbursementTurn })`,
    context,
  ) as { apply: (payload: unknown) => Promise<void>; submit: () => Promise<void> };
  return { ...helpers, context, buttons, reimbursement, fetch };
}

describe("legacy console reimbursement task controls", () => {
  it("establishes a visitor before submission and reuses credential and key after losing the first task response", async () => {
    const { submit, reimbursement, fetch, context } = harness();
    reimbursement.pendingTurn = {
      key: "synthetic-key",
      input: JSON.stringify({ message: "Synthetic receipt" }),
    };
    fetch.mockResolvedValueOnce({ ok: true, headers: { get: () => "synthetic-visitor" } });
    fetch.mockRejectedValueOnce(new Error("response lost"));
    await submit();
    expect(fetch.mock.calls[0]?.[0]).toBe("/tasks/visitor");
    expect(context.sessionStorage.setItem).toHaveBeenCalledWith(
      "adminbot.console.visitor",
      "synthetic-visitor",
    );
    expect(reimbursement.pendingTurn?.key).toBe("synthetic-key");
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ assistant_message: "Synthetic final answer", ready: false }),
    });
    await submit();
    expect(fetch.mock.calls[1]?.[1]).toEqual(fetch.mock.calls[2]?.[1]);
    expect(fetch.mock.calls[2]?.[1].headers).toMatchObject({
      "X-AdminBot-Visitor": "synthetic-visitor",
      "Idempotency-Key": "synthetic-key",
    });
    expect(reimbursement.pendingTurn).toBeNull();
  });

  it("does not submit any task when visitor bootstrap fails", async () => {
    const { submit, reimbursement, fetch } = harness();
    reimbursement.pendingTurn = { key: "synthetic-key", input: "{}" };
    fetch.mockRejectedValueOnce(new Error("bootstrap response lost"));
    await submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/tasks/visitor");
    expect(reimbursement.pendingTurn?.key).toBe("synthetic-key");
  });

  it("displays a shed task without making an automatic wait or adding a blank answer", async () => {
    const { apply, buttons, reimbursement, fetch } = harness();
    await apply({ task: { id: "synthetic", status: "shed", actions: ["wait", "cancel"] } });
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Wait",
      "Cancel task",
      "Refresh task status",
    ]);
    expect(reimbursement.messages).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends Wait only after clicking the explicit control", async () => {
    const { apply, buttons, fetch } = harness();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "synthetic", status: "queued", actions: ["cancel"] } }),
    });
    await apply({ task: { id: "synthetic", status: "shed", actions: ["wait", "cancel"] } });
    expect(fetch).not.toHaveBeenCalled();
    buttons.find((button) => button.textContent === "Wait")?.click?.();
    expect(fetch).toHaveBeenCalledWith(
      "/tasks/synthetic/wait",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retrieves a completed task's original reimbursement response", async () => {
    const { apply, reimbursement, fetch } = harness();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        assistant_message: "Synthetic receipt is ready",
        draft: { amount: 10 },
        ready: true,
      }),
    });
    await apply({ task: { id: "synthetic", status: "completed", actions: ["result"] } });
    expect(fetch).toHaveBeenCalledWith(
      "/tasks/synthetic/result",
      expect.objectContaining({ method: "GET" }),
    );
    expect(reimbursement.messages).toEqual([
      { role: "adminbot", text: "Synthetic receipt is ready" },
    ]);
    expect(reimbursement.ready).toBe(true);
    expect(reimbursement.taskId).toBeNull();
  });

  it("polls only accepted queued work and never submits the original input again", async () => {
    const { apply, reimbursement, fetch, context } = harness();
    await apply({ task: { id: "synthetic", status: "queued", actions: ["cancel"] } });
    expect(context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(reimbursement.messages).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
