import { html, type TemplateResult } from "lit";
import { appRoute } from "../app-routes.js";

export type RouteClickHandler = (event: MouseEvent) => void;

export function renderOverviewView(onRouteClick: RouteClickHandler): TemplateResult {
  const access = appRoute("access");
  return html`
    <section class="hero" aria-labelledby="overview-title">
      <div class="hero-copy">
        <p class="eyebrow">Standalone rebuild</p>
        <h1 id="overview-title">A quieter way to run the lab.</h1>
        <p>
          AdminBot is becoming a focused operations workspace: public utilities, a member
          directory, publication planning, and proposal-first administration behind one reviewed
          API.
        </p>
        <a class="primary-link" href=${access.path} @click=${onRouteClick}>
          Request workspace access <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
    <section class="overview-grid" aria-label="Product areas">
      <article class="overview-card">
        <span class="overview-card-number">01 / PUBLIC</span>
        <h2>Useful before sign-in</h2>
        <p>
          Registration is connected now. Reimbursements and deadlines retain their place while
          their safe read models are ported.
        </p>
      </article>
      <article class="overview-card">
        <span class="overview-card-number">02 / MEMBERS</span>
        <h2>A shared operating picture</h2>
        <p>
          The roster, availability view, and paper timeline return once sessions and
          audience-specific projections are authoritative.
        </p>
      </article>
      <article class="overview-card">
        <span class="overview-card-number">03 / GOVERNANCE</span>
        <h2>Every effect remains deliberate</h2>
        <p>
          Reviews, announcements, and connector work will use immutable proposals, human
          approval, idempotency, and audit evidence.
        </p>
      </article>
    </section>
  `;
}
