import { html, nothing } from "lit";
import {
  paperFeedbackSlots,
  parsePaperFeedback,
} from "../../../../../extensions/adminbot/src/contracts/paper-feedback.js";
import { t } from "../../../i18n/index.ts";
import { renderDateControl } from "../date-control.ts";
import type { PaperSlotsProps } from "./paper-slots.ts";

export function renderPaperFeedback(
  props: Pick<PaperSlotsProps, "slots" | "loading" | "onSaveSlot">,
) {
  return html`<section class="card" data-testid="paper-feedback">
    <h4>${t("paperFeedback.title")}</h4>
    <p>${t("paperFeedback.blurb")}</p>
    ${Object.entries(paperFeedbackSlots).map(([slot]) => {
      const label = t(`paperFeedback.${slot}`);
      const row = props.slots.find((entry) => entry.slot === slot);
      const request = row?.status === "provided" ? parsePaperFeedback(row.value_text ?? "") : null;
      return html`<details>
        <summary>${label}</summary>
        ${request
          ? html`<p role="status">
                <strong
                  >${request.reviewed
                    ? "Feedback completed"
                    : t("paperFeedback.queued", { label })}</strong
                ><br />${request.reason}
              </p>
              ${request.review_note
                ? html`<p style="white-space: pre-wrap">${request.review_note}</p>`
                : nothing}
              <p>
                ${t("paperFeedback.soft")}
                ${request.soft_deadline
                  ? new Date(request.soft_deadline).toLocaleString(undefined, {
                      timeZoneName: "short",
                    })
                  : t("paperFeedback.unspecified")}<br />
                ${t("paperFeedback.hard")}
                ${request.hard_deadline
                  ? new Date(request.hard_deadline).toLocaleString(undefined, {
                      timeZoneName: "short",
                    })
                  : t("paperFeedback.unspecified")}
              </p>
              ${request.hard_deadline && Date.parse(request.hard_deadline) < Date.now()
                ? html`<p role="status">${t("paperFeedback.late")}</p>`
                : nothing}
              <a href=${request.url} target="_blank" rel="noopener noreferrer"
                >${t("paperFeedback.open")}</a
              >
              <button
                class="btn"
                type="button"
                ?disabled=${props.loading}
                @click=${() => props.onSaveSlot(slot, { value_text: "" })}
              >
                ${t("paperFeedback.remove")}
              </button>`
          : html` <form
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                const form = event.currentTarget as HTMLFormElement;
                const data = new FormData(form);
                const reason = (data.get("reason") as string) ?? "";
                const url = (data.get("url") as string) ?? "";
                const soft = (data.get("soft") as string) ?? "";
                const hard = (data.get("hard") as string) ?? "";
                const input = JSON.stringify({
                  reason,
                  url,
                  ...(soft ? { soft_deadline: new Date(soft).toISOString() } : {}),
                  ...(hard ? { hard_deadline: new Date(hard).toISOString() } : {}),
                });
                const error = form.querySelector('[role="alert"]') as HTMLElement;
                if (!parsePaperFeedback(input)) {
                  error.textContent = t("paperFeedback.invalid");
                  return;
                }
                error.textContent = "";
                props.onSaveSlot(slot, { value_text: input });
              }}
            >
              <label
                >${t("paperFeedback.url")}<input
                  class="input"
                  name="url"
                  type="url"
                  required
                  placeholder="https://…"
              /></label>
              <label
                >${t("paperFeedback.reason")}<textarea
                  class="input"
                  name="reason"
                  required
                  maxlength="2000"
                ></textarea>
              </label>
              <label
                >${t("paperFeedback.softInput")}${renderDateControl(html`<input
                  class="input"
                  name="soft"
                  type="datetime-local"
                />`)}</label
              >
              <label
                >${t("paperFeedback.hardInput")}${renderDateControl(html`<input
                  class="input"
                  name="hard"
                  type="datetime-local"
                />`)}</label
              >
              <p class="muted">${t("paperFeedback.hint")}</p>
              <p role="alert"></p>
              <button class="btn btn--primary" type="submit" ?disabled=${props.loading}>
                ${props.loading ? t("paperFeedback.saving") : t("paperFeedback.queue", { label })}
              </button>
            </form>`}
      </details>`;
    })}
  </section>`;
}
