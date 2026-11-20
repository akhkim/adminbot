import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { pendingDraftCount, retryDraftSync } from "./draft-sync.ts";

/** Shell availability is separate from API/AI connectivity and individual draft save status. */
@customElement("adminbot-offline-access")
export class OfflineAccess extends LitElement {
  @property() scope = "";
  /**
   * Draw the setup panel even when there is nothing to report. Set on the request pages, where
   * someone prepares a device before travelling; elsewhere the panel appears only while the device
   * is offline or drafts wait to sync, so it is not a block above every page.
   */
  @property({ type: Boolean }) always = false;
  @state() private online = navigator.onLine;
  @state() private ready = false;
  @state() private storageMessage = "";
  private timer?: number;
  private draftChanged = () => this.requestUpdate();
  // A hidden tab has no badge to keep current; the check resumes (and runs once) when it is shown.
  private poll = () => {
    if (!document.hidden) {
      this.refresh();
    }
  };
  private refresh = () => {
    this.online = navigator.onLine;
    this.requestUpdate();
    const worker = navigator.serviceWorker?.controller;
    if (worker) {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => channel.port1.close(), 3000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        this.ready = event.data?.offlineReady === true;
        channel.port1.close();
      };
      worker.postMessage({ type: "ADMINBOT_OFFLINE_STATUS" }, [channel.port2]);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("adminbot-draft-status", this.draftChanged);
    window.addEventListener("online", this.refresh);
    window.addEventListener("offline", this.refresh);
    navigator.serviceWorker?.addEventListener("controllerchange", this.refresh);
    document.addEventListener("visibilitychange", this.poll);
    this.refresh();
    this.timer = window.setInterval(this.poll, 10000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("adminbot-draft-status", this.draftChanged);
    window.removeEventListener("online", this.refresh);
    window.removeEventListener("offline", this.refresh);
    navigator.serviceWorker?.removeEventListener("controllerchange", this.refresh);
    document.removeEventListener("visibilitychange", this.poll);
    window.clearInterval(this.timer);
    document.removeEventListener("pointerdown", this.onOutside);
    document.removeEventListener("keydown", this.onKey);
  }

  private async keepStorage() {
    try {
      const kept = await navigator.storage?.persist?.();
      this.storageMessage = kept
        ? "Persistent storage enabled. Clearing site data still deletes local copies."
        : "Automatic storage protection is unavailable. Export important drafts before clearing site data.";
    } catch {
      this.storageMessage =
        "Storage protection failed. You can export saved copies from each draft.";
    }
  }

  /**
   * The page header clips its overflow (it animates its height away in chat), so the panel is fixed
   * to the viewport and placed under the pill when it opens. A press anywhere else, or Escape,
   * closes it, as any popover would.
   */
  private onToggle = (event: Event) => {
    const details = event.currentTarget as HTMLDetailsElement;
    const panel = details.querySelector<HTMLElement>(".offline-access__panel");
    const pill = details.querySelector("summary");
    if (!details.open || !panel || !pill) {
      document.removeEventListener("pointerdown", this.onOutside);
      document.removeEventListener("keydown", this.onKey);
      return;
    }
    const box = pill.getBoundingClientRect();
    panel.style.top = `${Math.round(box.bottom + 8)}px`;
    const width = Math.min(352, window.innerWidth - 32);
    panel.style.left = `${Math.round(Math.max(16, Math.min(box.right - width, window.innerWidth - width - 16)))}px`;
    document.addEventListener("pointerdown", this.onOutside);
    document.addEventListener("keydown", this.onKey);
  };
  private close() {
    const details = this.querySelector("details");
    if (details) {
      details.open = false;
    }
  }
  private onOutside = (event: Event) => {
    if (!this.contains(event.target as Node)) {
      this.close();
    }
  };
  private onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
      this.querySelector("summary")?.focus();
    }
  };

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override render() {
    const pending = pendingDraftCount(this.scope);
    const quiet = this.online && pending === 0 && !this.always;
    this.hidden = quiet;
    if (quiet) {
      return nothing;
    }
    // A pill in the page header that opens a small panel (DESIGN.md rule 17): a status, so it sits
    // with the title rather than as a band above it. Offline or with drafts waiting it says so in
    // the pill itself, which is the only time it needs to be noticed.
    const label = !this.online
      ? "Working offline"
      : pending
        ? `${pending} draft${pending === 1 ? "" : "s"} to sync`
        : this.ready
          ? "Offline access · ready"
          : "Offline access";
    const tone = !this.online || pending ? "offline-access--warn" : "";
    return html`<details class="offline-access ${tone}" @toggle=${this.onToggle}>
      <summary role="status" class="offline-access__pill">${label}</summary>
      <div class="offline-access__panel">
        <p role="status">
          ${pending
            ? `${pending} draft${pending === 1 ? "" : "s"} awaiting sync or review.`
            : "No drafts waiting to sync."}
          ${this.ready
            ? "Ready on this device."
            : "Open this page online once to prepare this device."}
        </p>
        <p class="muted">
          Letter, meeting and signature edits save here and sync when you reconnect. Submitting
          still needs a connection.
        </p>
        <div class="offline-access__actions">
          ${pending
            ? html`<button class="btn btn--sm" type="button" @click=${retryDraftSync}>
                Sync drafts now
              </button>`
            : nothing}
          <button class="btn btn--sm" type="button" @click=${() => this.keepStorage()}>
            Keep data on this device
          </button>
        </div>
        ${this.storageMessage
          ? html`<p class="muted" role="status">${this.storageMessage}</p>`
          : nothing}
      </div>
    </details>`;
  }
}
