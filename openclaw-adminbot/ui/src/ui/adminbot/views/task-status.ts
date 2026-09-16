import { html, LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { listRecentTasks, applicationResultSummary, type RecoveredTask } from "../task-history.ts";
import { taskActivities, taskChanges, taskFetch, type TaskHandle } from "../task-request.ts";
import "./wait-preference.ts";

function taskLabel(path: string): string {
  if (path.includes("reimbursement")) {
    return "Reimbursement";
  }
  if (path.includes("guidebook") || path.includes("lab-sharing/ask")) {
    return "Guidebook answer";
  }
  if (path.includes("/cv/scan") || path === "cv.scan") {
    return "CV scan";
  }
  if (path.includes("/cv/blurb") || path === "cv.blurb") {
    return "CV blurb";
  }
  if (path.includes("/papers/import/columns") || path === "import-columns") {
    return "Column suggestions";
  }
  if (path.includes("privacy")) {
    return "Private task";
  }
  return "Task";
}

type TaskCopy = { state: string; detail?: string };

/**
 * A stable number per task, for the case where a member has more than one in flight.
 *
 * Two saved reimbursements render as two identical callouts otherwise, and pressing Wait on one
 * of them is a guess. The number is assigned when the task is first seen and never reused, so it
 * does not renumber when an earlier task finishes -- a label that moves under you is worse than
 * no label. It is only shown when there is more than one to tell apart.
 */
const taskOrdinals = new Map<string, number>();
function rememberOrder(tasks: Array<TaskHandle | undefined>): void {
  // Assign by submission time, not by the order they happen to render. Assigning on first paint
  // numbered whichever task the map yielded first, so a second submission could come out as 1.
  // Sorting the not-yet-numbered ones by createdAt gives a member the order they sent them in,
  // and the numbers never move afterwards.
  const fresh = tasks
    .filter((task): task is TaskHandle => Boolean(task) && !taskOrdinals.has(task!.id))
    .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  for (const task of fresh) {
    taskOrdinals.set(task.id, taskOrdinals.size + 1);
  }
}
function ordinalFor(id: string): number {
  return taskOrdinals.get(id) ?? 0;
}

/**
 * What a member reads. Assembled from the status alone, never from the server's error text.
 *
 * The earlier version concatenated a label, a raw status word and whatever message the service
 * happened to send, which produced lines like "Reimbursement: waiting for your choice / Task
 * saved. Choose Wait to run it." That describes this panel's state, not the lab's, and leaves the
 * member to work out that a GPU is busy. Every string here says what happened on the server and,
 * where there is a decision, what each option does.
 */
function taskCopy(label: string, status: string, actions: string[] = []): TaskCopy {
  switch (status) {
    case "shed":
      return {
        state: `${label} saved`,
        detail: "The lab's model is busy right now. Wait in the queue, or cancel and come back.",
      };
    case "queued":
      return {
        state: `${label} waiting in queue`,
        detail: "It runs as soon as the model frees up.",
      };
    case "running":
      return { state: `${label} running now` };
    case "needs_retry":
      return {
        state: `${label} interrupted`,
        detail: actions.includes("retry")
          ? "It stopped partway. Work already finished was kept. The interrupted step may have run; Resume retries it."
          : "The retry limit was reached. Review the outcome before starting a new request.",
      };
    case "cancelled":
      return { state: `${label} cancelled` };
    case "expired":
      return {
        state: `${label} expired`,
        detail: "Saved requests are kept for a day. Submit it again to run it.",
      };
    case "failed":
      return {
        state: `${label} could not finish`,
        detail: actions.includes("retry")
          ? "Resume this request to try again. Completed work is kept."
          : "The retry limit was reached. Review the outcome before starting a new request.",
      };
    case "completed":
      return { state: `${label} finished` };
    default:
      return { state: `${label}: ${status.replaceAll("_", " ")}` };
  }
}

/** Buttons say what pressing them does, not which route they call. */
function actionLabel(action: string): string {
  switch (action) {
    case "wait":
      return "Wait in queue";
    case "retry":
      return "Resume";
    case "cancel":
      return "Cancel";
    case "result":
      return "View result";
    default:
      return action;
  }
}

/** Embedded in existing workflows; closing the view detaches polling, never cancels server work. */
export class AdminBotTaskStatus extends LitElement {
  @property() sessionContext = "";
  @property() baseUrl = "";
  @state() private recovered: RecoveredTask[] = [];
  @state() private historyError = "";
  private historyRequest?: AbortController;
  private generation = 0;
  private async restore() {
    const generation = ++this.generation;
    this.historyRequest?.abort();
    this.historyRequest = new AbortController();
    this.recovered = [];
    this.historyError = "";
    if (!this.baseUrl) {
      return;
    }
    try {
      const tasks = await listRecentTasks(
        this.baseUrl.replace(/\/$/u, ""),
        this.sessionContext,
        this.historyRequest.signal,
      );
      if (generation !== this.generation) {
        return;
      }
      const active = new Set(Array.from(taskActivities.values(), (entry) => entry.task?.id));
      // Work the member may still act on or collect. A task they cancelled, or one that aged
      // out, is neither -- leaving those on screen turns the tray into a list of old notices.
      this.recovered = tasks
        .filter((task) => !active.has(task.id) && !["cancelled", "expired"].includes(task.status))
        .map((task) => ({ task }));
      for (const entry of this.recovered) {
        if (["queued", "running"].includes(entry.task.status)) {
          void this.resume(entry, "status");
        }
      }
    } catch {
      if (generation === this.generation) {
        this.historyError = "Recent tasks could not be loaded.";
      }
    }
  }
  private async resume(entry: RecoveredTask, action: string) {
    if (entry.busy) {
      return;
    }
    const generation = this.generation;
    entry.busy = true;
    entry.error = undefined;
    this.requestUpdate();
    const endpoint = `${this.baseUrl.replace(/\/$/u, "")}/tasks/${encodeURIComponent(entry.task.id)}`;
    try {
      const response = await taskFetch(
        `${endpoint}${["wait", "cancel", "retry"].includes(action) ? `/${action}` : ""}`,
        {
          method: ["wait", "cancel", "retry"].includes(action) ? "POST" : "GET",
          headers:
            this.sessionContext && this.sessionContext !== "visitor"
              ? { Authorization: `Bearer ${this.sessionContext}` }
              : {},
          signal: this.historyRequest?.signal,
        },
      );
      const result = await response.json();
      if (generation !== this.generation) {
        return;
      }
      if (result && typeof result === "object" && "task" in result) {
        const view = (result as { task: TaskHandle }).task;
        entry.task = { ...entry.task, ...view };
        if (["cancelled", "expired"].includes(view.status)) {
          this.recovered = this.recovered.filter((item) => item !== entry);
        }
      } else if (!response.ok) {
        entry.error = result?.error?.message ?? "The task result is unavailable.";
        entry.task = {
          ...entry.task,
          status:
            response.status === 410
              ? "expired"
              : result?.error?.message === "Cancelled by owner"
                ? "cancelled"
                : "failed",
          actions: [],
        };
      } else {
        entry.result = result;
        entry.task = { ...entry.task, status: "completed", actions: ["result"] };
      }
    } catch {
      if (generation === this.generation) {
        entry.error = "The connection was interrupted. Reconnect to retrieve this task.";
      }
    } finally {
      if (generation === this.generation) {
        entry.busy = false;
        this.requestUpdate();
      }
    }
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionContext") || changed.has("baseUrl")) {
      if (
        (changed.has("sessionContext") && changed.get("sessionContext") !== undefined) ||
        (changed.has("baseUrl") && changed.get("baseUrl") !== undefined)
      ) {
        for (const activity of taskActivities.values()) {
          activity.detach();
        }
        taskActivities.clear();
      }
      void this.restore();
    }
  }
  private readonly changed = () => this.requestUpdate();
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    taskChanges.addEventListener("change", this.changed);
    if (this.hasUpdated && this.baseUrl) {
      void this.restore();
    }
  }
  override disconnectedCallback() {
    taskChanges.removeEventListener("change", this.changed);
    this.generation++;
    this.historyRequest?.abort();
    this.recovered = [];
    for (const activity of taskActivities.values()) {
      activity.detach();
    }
    super.disconnectedCallback();
  }
  override render() {
    const live = Array.from(taskActivities.values()).filter(
      (activity) => activity.task || activity.message || activity.requestError,
    );
    const restored = this.recovered.filter((entry) => !entry.busy);
    // Only number when there is something to tell apart.
    const many = live.length + restored.length > 1;
    rememberOrder([...live.map((a) => a.task), ...restored.map((e) => e.task)]);
    return html`${live.map((activity) => {
      const label = `${taskLabel(activity.label)}${
        many && activity.task ? ` ${ordinalFor(activity.task.id)}` : ""
      }`;
      const copy = activity.task
        ? taskCopy(label, activity.task.status, activity.task.actions)
        : {
            state: `${label} disconnected`,
            detail: "The connection dropped. Reconnecting picks up the same request.",
          };
      return html` <section class="callout" aria-label="Task progress">
        <p role="status">${copy.state}</p>
        ${copy.detail ? html`<p>${copy.detail}</p>` : ""}
        ${activity.requestError ? html`<p role="alert">${activity.requestError}</p>` : ""}
        ${!activity.task || activity.requestError || activity.message?.startsWith("Connection lost")
          ? html`<button class="btn" @click=${() => activity.act("status")}>Reconnect</button>`
          : ""}
        ${(activity.task?.actions ?? [])
          .filter((action) => ["wait", "cancel", "retry"].includes(action))
          .map(
            (action) => html`
              <button class="btn" @click=${() => activity.act(action)}>
                ${actionLabel(action)}
              </button>
            `,
          )}
        ${activity.task?.status === "shed"
          ? html`<adminbot-wait-preference
              .baseUrl=${this.baseUrl}
              .sessionContext=${this.sessionContext}
            ></adminbot-wait-preference>`
          : ""}
      </section>`;
    })}
    ${this.historyError
      ? html`<p role="status">
          ${this.historyError} <button class="btn" @click=${() => this.restore()}>Reconnect</button>
        </p>`
      : ""}
    ${restored.map(
      (entry) => html`
        <section class="callout" aria-label="Recovered task">
          <p>
            ${taskCopy(
              `${taskLabel(entry.task.kind ?? "")}${many ? ` ${ordinalFor(entry.task.id)}` : ""}`,
              entry.task.status,
              entry.task.actions,
            ).state}
          </p>
          ${(() => {
            const detail =
              entry.error ??
              taskCopy(taskLabel(entry.task.kind ?? ""), entry.task.status, entry.task.actions)
                .detail;
            return detail ? html`<p role=${entry.error ? "alert" : "status"}>${detail}</p>` : "";
          })()}
          ${entry.result !== undefined
            ? html`
                <p
                  style="white-space:pre-wrap;overflow-wrap:anywhere"
                  .textContent=${applicationResultSummary(entry.result)}
                ></p>
                <a
                  class="btn"
                  download=${`task-${entry.task.id}-result.json`}
                  href=${`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(entry.result, null, 2))}`}
                  >Download result</a
                >
              `
            : (entry.task.actions ?? [])
                .filter((action) => ["wait", "cancel", "retry", "result"].includes(action))
                .map(
                  (action) => html`
                    <button class="btn" @click=${() => this.resume(entry, action)}>
                      ${actionLabel(action)}
                    </button>
                  `,
                )}
          ${entry.task.status === "shed"
            ? html`<adminbot-wait-preference
                .baseUrl=${this.baseUrl}
                .sessionContext=${this.sessionContext}
              ></adminbot-wait-preference>`
            : ""}
        </section>
      `,
    )} `;
  }
}
if (!customElements.get("adminbot-task-status")) {
  customElements.define("adminbot-task-status", AdminBotTaskStatus);
}
