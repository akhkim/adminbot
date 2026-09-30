import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";

const LABELS: Record<string, string> = {
  submission: "Submission",
  abstract: "Abstract registration",
  notification: "Decisions",
  author_response: "Author response",
  camera_ready: "Camera-ready",
  conference: "Conference",
  commitment: "Commitment",
  registration: "Registration",
  discussion: "Discussion",
};

export function stageKey(key: string): string {
  if (
    ["submission", "full_paper", "direct_submission", "paper", "paper_submission"].includes(key)
  ) {
    return "submission";
  }
  if (["abstract", "abstract_registration", "abstract_submission"].includes(key)) {
    return "abstract";
  }
  if (["notification", "decisions", "accept_reject"].includes(key)) {
    return "notification";
  }
  if (["rebuttal", "author_response"].includes(key)) {
    return "author_response";
  }
  return key || "submission";
}

export function chooseStage<T extends { key: string; instant: number }>(
  stages: readonly T[],
  key: string,
  now: number,
  period: "upcoming" | "past",
): T | undefined {
  const matching = stages
    .filter((stage) => stage.key === key && Number.isFinite(stage.instant))
    .toSorted((a, b) => a.instant - b.instant);
  return period === "upcoming"
    ? matching.find((stage) => stage.instant > now)
    : matching.findLast((stage) => stage.instant <= now);
}

export function stageFilterOptions(stages: readonly { key: string; label: string }[]) {
  const labels = new Map<string, string>();
  for (const stage of stages) {
    if (stage.key !== "notification_by") {
      labels.set(
        stage.key,
        LABELS[stage.key] ? t(`deadlineStageFilter.${stage.key}`) : stage.label,
      );
    }
  }
  return [...labels]
    .map(([value, label]) => ({ value, label }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function renderStageFilter(
  value: string,
  options: ReturnType<typeof stageFilterOptions>,
  onChange: (value: string) => void,
  count: (value: string) => number,
) {
  return html`<label class="deadline-board__facet">
    <span class="sr-only">${t("deadlineStageFilter.label")}</span>
    <select
      aria-label=${t("deadlineStageFilter.label")}
      data-testid="deadline-filter-stage"
      .value=${value}
      @change=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}
    >
      <option value="">${t("deadlineStageFilter.all")} (${count("")})</option>
      ${options.map(
        (option) =>
          html`<option value=${option.value}>${option.label} (${count(option.value)})</option>`,
      )}
    </select>
    <span class="country-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
  </label>`;
}
