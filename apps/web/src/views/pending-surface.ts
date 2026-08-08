import { html, type TemplateResult } from "lit";
import type { PendingAppRoute } from "../app-routes.js";

export function renderPendingSurface(route: PendingAppRoute): TemplateResult {
  return html`
    <header class="page-heading">
      <div>
        <p class="eyebrow">${route.eyebrow}</p>
        <h1>${route.label}</h1>
        <p class="page-description">${route.description}</p>
      </div>
      <div class="badges">
        <span class="badge">${route.audience}</span>
        <span class="badge badge--pending">backend pending</span>
      </div>
    </header>
    <aside class="port-notice" aria-label="Port status">
      <span class="port-mark" aria-hidden="true">P0</span>
      <div>
        <strong>The interface is reconstructed; data and commands are not connected.</strong>
        <p>${route.nextBoundary} This preview makes no API request and exposes no private data.</p>
      </div>
    </aside>
    ${renderPreview(route)}
  `;
}

function renderPreview(route: PendingAppRoute): TemplateResult {
  switch (route.preview) {
    case "table":
      return html`
        <section class="surface" aria-label=${`${route.label} preview`}>
          ${renderSurfaceHeader(route)}
          <table class="preview-table">
            <thead><tr>${route.columns?.map((column) => html`<th>${column}</th>`)}</tr></thead>
            <tbody>
              <tr>
                <td colspan=${route.columns?.length ?? 1}>${renderEmptyState(route)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      `;
    case "timeline":
      return html`
        <section class="surface" aria-label=${`${route.label} preview`}>
          ${renderSurfaceHeader(route)}
          <div class="preview-timeline" aria-hidden="true">
            ${[0, 1, 2].map(
              () => html`
                <div class="timeline-row">
                  <span class="timeline-line"></span><span class="timeline-track"></span>
                </div>
              `,
            )}
          </div>
          ${renderEmptyState(route)}
        </section>
      `;
    case "composer":
      return html`
        <section class="surface" aria-label=${`${route.label} preview`}>
          ${renderSurfaceHeader(route)}
          <div class="preview-composer" aria-hidden="true">
            <div class="composer-pane">
              <div class="composer-line"></div>
              <div class="composer-line"></div>
              <div class="composer-line"></div>
            </div>
            ${renderEmptyState(route)}
          </div>
        </section>
      `;
    case "queue":
      return html`
        <section class="surface" aria-label=${`${route.label} preview`}>
          ${renderSurfaceHeader(route)} ${renderEmptyState(route)}
        </section>
      `;
    case "cards":
      return html`
        <section class="surface" aria-label=${`${route.label} preview`}>
          ${renderSurfaceHeader(route)}
          <div class="preview-cards" aria-hidden="true">
            <div class="preview-card">
              <strong>Reviewed defaults</strong>
              <div class="composer-line"></div>
              <div class="composer-line"></div>
            </div>
            <div class="preview-card">
              <strong>Privacy policy</strong>
              <div class="composer-line"></div>
              <div class="composer-line"></div>
            </div>
          </div>
          ${renderEmptyState(route)}
        </section>
      `;
  }
}

function renderSurfaceHeader(route: PendingAppRoute): TemplateResult {
  return html`
    <div class="surface-header">
      <span class="surface-title">${route.label}</span>
      <span class="surface-meta">NO DATA REQUESTED</span>
    </div>
  `;
}

function renderEmptyState(route: PendingAppRoute): TemplateResult {
  return html`
    <div class="empty-state">
      <div>
        <span class="empty-state-mark" aria-hidden="true">—</span>
        <strong>Waiting for its authoritative backend</strong>
        <p>${route.legacyBehavior}</p>
      </div>
    </div>
  `;
}
