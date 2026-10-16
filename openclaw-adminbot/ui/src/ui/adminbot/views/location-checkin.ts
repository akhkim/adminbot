// "Are you in Toronto?  [Yes]  No, change · Prefer not to say  ×"
//
// The check-in costs one tap when the guess is right, which is most of the time. It is a strip in
// the page flow, never a modal or an overlay, so it covers nothing and can be ignored; closing it
// counts as "Ask me later" (a week). Only "No, change" opens the picker: a city field with the
// gazetteer as suggestions, free text accepted, and a button that asks this device where it is.
//
// One line of copy and buttons, nothing else. The why (a timezone that disagrees with the guess)
// is on the question's tooltip for whoever wants it, not a paragraph everyone has to read.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { CheckinBanner } from "../data/location-checkin.ts";

export type LocationCheckinProps = {
  banner: CheckinBanner | null | undefined;
  onAnswer: (city: string, via: "picker" | "text") => void;
  onChange: () => void;
  onDevice: () => void;
  onSnooze: () => void;
  onDecline: () => void;
};

/** "picker" when the text is one of the listed cities, "text" for anything typed freely. */
export function answerVia(text: string, places: CheckinBanner["places"]): "picker" | "text" {
  const wanted = text.trim().toLocaleLowerCase();
  return places?.some((place) => place.label.toLocaleLowerCase() === wanted) ? "picker" : "text";
}

function renderSecondary(banner: CheckinBanner, props: LocationCheckinProps) {
  const busy = Boolean(banner.busy);
  return html`
    <button
      class="location-checkin__link location-checkin__link--quiet"
      type="button"
      data-testid="location-checkin-decline"
      ?disabled=${busy}
      @click=${() => props.onDecline()}
    >
      ${t("locationCheckin.preferNot")}
    </button>
    <button
      class="location-checkin__close"
      type="button"
      data-testid="location-checkin-dismiss"
      aria-label=${t("locationCheckin.dismissAria")}
      title=${t("locationCheckin.dismissAria")}
      ?disabled=${busy}
      @click=${() => props.onSnooze()}
    >
      ×
    </button>
  `;
}

function renderConfirm(banner: CheckinBanner, props: LocationCheckinProps) {
  const city = banner.checkin.suggestion?.city ?? "";
  const busy = Boolean(banner.busy);
  return html`
    <span class="location-checkin__question" title=${banner.checkin.note ?? nothing}>
      ${t("locationCheckin.question", { city })}
    </span>
    <span class="location-checkin__actions">
      <button
        class="btn btn--sm primary location-checkin__yes"
        type="button"
        data-testid="location-checkin-yes"
        ?disabled=${busy}
        @click=${() => props.onAnswer(city, "picker")}
      >
        ${banner.busy === "answer" ? t("locationCheckin.saving") : t("locationCheckin.yes")}
      </button>
      <button
        class="location-checkin__link"
        type="button"
        data-testid="location-checkin-change"
        ?disabled=${busy}
        @click=${() => props.onChange()}
      >
        ${t("locationCheckin.change")}
      </button>
      ${renderSecondary(banner, props)}
    </span>
  `;
}

function renderPick(banner: CheckinBanner, props: LocationCheckinProps) {
  const busy = Boolean(banner.busy);
  const submit = (event: Event) => {
    event.preventDefault();
    const input = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>(
      "[name=city]",
    );
    const text = input?.value.trim() ?? "";
    props.onAnswer(text, answerVia(text, banner.places));
  };
  return html`
    <form class="location-checkin__form" @submit=${submit}>
      <input
        class="location-checkin__input"
        name="city"
        list="location-checkin-cities"
        autocomplete="address-level2"
        enterkeyhint="done"
        data-testid="location-checkin-city"
        aria-label=${t("locationCheckin.cityLabel")}
        placeholder=${t("locationCheckin.cityPlaceholder")}
        autofocus
        ?disabled=${busy}
      />
      <datalist id="location-checkin-cities">
        ${(banner.places ?? []).map(
          (place) => html`<option value=${place.label}>${place.country}</option>`,
        )}
      </datalist>
      <span class="location-checkin__actions">
        <button
          class="btn btn--sm primary"
          type="submit"
          data-testid="location-checkin-save"
          ?disabled=${busy}
        >
          ${banner.busy === "answer" ? t("locationCheckin.saving") : t("locationCheckin.save")}
        </button>
        <button
          class="btn btn--sm"
          type="button"
          data-testid="location-checkin-device"
          ?disabled=${busy}
          @click=${() => props.onDevice()}
        >
          ${banner.busy === "device"
            ? t("locationCheckin.locating")
            : t("locationCheckin.useDevice")}
        </button>
        ${renderSecondary(banner, props)}
      </span>
    </form>
  `;
}

export function renderLocationCheckin(props: LocationCheckinProps) {
  const banner = props.banner;
  if (!banner) {
    return nothing;
  }
  return html`
    <section
      class="location-checkin"
      role="region"
      aria-label=${t("locationCheckin.regionLabel")}
      data-testid="location-checkin"
      data-mode=${banner.mode}
    >
      ${banner.mode === "confirm" && banner.checkin.suggestion
        ? renderConfirm(banner, props)
        : renderPick(banner, props)}
      ${banner.error
        ? html`<p class="location-checkin__error" role="alert">${banner.error}</p>`
        : nothing}
    </section>
  `;
}
