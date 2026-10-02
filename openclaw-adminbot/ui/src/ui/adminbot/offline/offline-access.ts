import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { pendingDraftCount, retryDraftSync } from "./draft-sync.ts";

/** Shell availability is separate from API/AI connectivity and individual draft save status. */
@customElement("adminbot-offline-access")
export class OfflineAccess extends LitElement {
  @property() scope = "";
  @state() private online = navigator.onLine;
  @state() private ready = false;
  @state() private storageMessage = "";
  private timer?: number;
  private draftChanged = () => this.requestUpdate();
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
    this.refresh();
    this.timer = window.setInterval(this.refresh, 10000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("adminbot-draft-status", this.draftChanged);
    window.removeEventListener("online", this.refresh);
    window.removeEventListener("offline", this.refresh);
    navigator.serviceWorker?.removeEventListener("controllerchange", this.refresh);
    window.clearInterval(this.timer);
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

  static override styles = css`
    :host {
      display: block;
      margin-bottom: 12px;
      font: inherit;
    }
    details {
      border: 1px solid var(--border, #8886);
      border-radius: 10px;
      padding: 10px 14px;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
    }
    p {
      max-width: 75ch;
      line-height: 1.5;
      font-size: 13px;
    }
    button {
      font: inherit;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
    }
  `;

  override render() {
    const pending = pendingDraftCount(this.scope);
    return html`<details>
      <summary role="status">
        ${!this.online ? "Working offline" : "Offline access"} ·
        ${this.ready ? "Ready on this device" : "Open online to prepare this device"}
      </summary>
      <p role="status">
        ${pending} draft${pending === 1 ? "" : "s"} awaiting sync or review.
        <button @click=${retryDraftSync}>Sync drafts now</button>
      </p>
      <p>
        Previously loaded records are available for reading. Recommendation letters, meeting
        requests, and signature corrections save manual edits on this device and sync when you
        reconnect. Check the save status above each form before closing it. Requests still need an
        explicit submission while connected.
      </p>
      <p>
        On your phone, open this portal online, then use your browser menu to install it or add it
        to your Home Screen. Open the installed app and your work once online before traveling.
        Downloads belong to this browser or installed app and account.
      </p>
      <p>AI is not needed for reading or editing. On-device AI is not installed.</p>
      <button @click=${() => this.keepStorage()}>Keep offline data on this device</button>
      <p role="status">${this.storageMessage}</p>
    </details>`;
  }
}
