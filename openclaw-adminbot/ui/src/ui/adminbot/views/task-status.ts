import { html, LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { listRecentTasks, applicationResultSummary, type RecoveredTask } from "../task-history.ts";
import { taskActivities, taskChanges, taskFetch } from "../task-request.ts";

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
      this.recovered = tasks.filter((task) => !active.has(task.id)).map((task) => ({ task }));
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
      if (!response.ok) {
        entry.error = result?.error?.message ?? "The task result is unavailable.";
        entry.task = {
          ...entry.task,
          status:
            response.status === 410
              ? "expired"
              : result?.error?.message === "Task cancelled."
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
    return html`${Array.from(taskActivities.values())
      .filter((activity) => activity.task || activity.message)
      .map(
        (activity) => html` <section class="callout" aria-label="Task progress">
          <p role="status">
            ${taskLabel(activity.label)}:
            ${activity.task?.status === "shed"
              ? "waiting for your choice"
              : activity.task?.status === "needs_retry"
                ? "retry required"
                : (activity.task?.status.replaceAll("_", " ") ?? "disconnected")}
          </p>
          ${activity.message ? html`<p>${activity.message}</p>` : ""}
          ${activity.message?.startsWith("Connection lost")
            ? html`<button class="btn" @click=${() => activity.act("status")}>Reconnect</button>`
            : ""}
          ${(activity.task?.actions ?? [])
            .filter((action) => ["wait", "cancel", "retry"].includes(action))
            .map(
              (action) => html`
                <button class="btn" @click=${() => activity.act(action)}>
                  ${action === "wait"
                    ? "Wait"
                    : action === "cancel"
                      ? "Cancel"
                      : "Retry uncertain step"}
                </button>
              `,
            )}
        </section>`,
      )}
    ${this.historyError
      ? html`<p role="status">
          ${this.historyError} <button class="btn" @click=${() => this.restore()}>Reconnect</button>
        </p>`
      : ""}
    ${this.recovered
      .filter((entry) => !entry.busy)
      .map(
        (entry) => html`
          <section class="callout" aria-label="Recovered task">
            <p>${taskLabel(entry.task.kind ?? "")}: ${entry.task.status.replaceAll("_", " ")}</p>
            ${entry.error ? html`<p role="alert">${entry.error}</p>` : ""}
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
                        ${action === "result"
                          ? "View result"
                          : action === "wait"
                            ? "Wait"
                            : action === "retry"
                              ? "Retry uncertain step"
                              : "Cancel"}
                      </button>
                    `,
                  )}
          </section>
        `,
      )} `;
  }
}
if (!customElements.get("adminbot-task-status")) {
  customElements.define("adminbot-task-status", AdminBotTaskStatus);
}
