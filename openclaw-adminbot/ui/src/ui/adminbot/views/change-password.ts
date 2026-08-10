// Control UI view renders the signed-in member's "change password" popover.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";

const POPOVER_ID = "change-password-popover";

export function renderChangePasswordTrigger(state: AppViewState, navCollapsed: boolean) {
  return html`
    <button
      type="button"
      class="nav-item sidebar-utility-link"
      title=${t("login.member.changePassword.trigger")}
      aria-label=${t("login.member.changePassword.trigger")}
      popovertarget=${POPOVER_ID}
      @click=${() => state.openChangePassword()}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons.lock}</span>
      ${!navCollapsed
        ? html`<span class="nav-item__text">${t("login.member.changePassword.trigger")}</span>`
        : nothing}
    </button>
  `;
}

export function renderChangePasswordPopover(state: AppViewState) {
  const onSubmit = (event: Event) => {
    event.preventDefault();
    void state.submitChangePassword();
  };
  return html`
    <article class="adminbot-editor-card adminbot-popover" id=${POPOVER_ID} popover>
      <button
        class="btn btn--sm adminbot-popover__close"
        type="button"
        popovertarget=${POPOVER_ID}
        popovertargetaction="hide"
        @click=${() => state.closeChangePassword()}
      >
        ${t("login.member.changePassword.cancel")}
      </button>
      <div class="card-title">${t("login.member.changePassword.title")}</div>
      <form class="adminbot-form" @submit=${onSubmit}>
        <label class="adminbot-form__field"
          ><span>${t("login.member.changePassword.currentPassword")}</span>
          <input
            type="password"
            autocomplete="current-password"
            required
            placeholder=${t("login.member.changePassword.currentPasswordPlaceholder")}
            .value=${state.changePasswordCurrent}
            @input=${(e: InputEvent) => {
              state.changePasswordCurrent = (e.target as HTMLInputElement).value;
            }}
        /></label>
        <label class="adminbot-form__field"
          ><span>${t("login.member.changePassword.newPassword")}</span>
          <input
            type="password"
            autocomplete="new-password"
            required
            placeholder=${t("login.member.changePassword.newPasswordPlaceholder", { min: "10" })}
            .value=${state.changePasswordNew}
            @input=${(e: InputEvent) => {
              state.changePasswordNew = (e.target as HTMLInputElement).value;
            }}
        /></label>
        <label class="adminbot-form__field"
          ><span>${t("login.member.changePassword.confirmNewPassword")}</span>
          <input
            type="password"
            autocomplete="new-password"
            required
            placeholder=${t("login.member.changePassword.confirmNewPasswordPlaceholder")}
            .value=${state.changePasswordConfirm}
            @input=${(e: InputEvent) => {
              state.changePasswordConfirm = (e.target as HTMLInputElement).value;
            }}
        /></label>
        ${state.changePasswordError
          ? html`<div class="login-gate__form-error" role="alert">
              ${state.changePasswordError}
            </div>`
          : nothing}
        ${state.changePasswordNotice
          ? html`<div class="adminbot-form__notice">${state.changePasswordNotice}</div>`
          : nothing}
        <div class="adminbot-form__actions">
          <button class="btn btn--sm primary" type="submit" ?disabled=${state.changePasswordBusy}>
            ${state.changePasswordBusy
              ? t("login.member.changePassword.submitting")
              : t("login.member.changePassword.submit")}
          </button>
        </div>
      </form>
    </article>
  `;
}
