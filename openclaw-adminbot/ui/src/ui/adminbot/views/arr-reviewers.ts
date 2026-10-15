import { html } from "lit";
import type { AdminBotLabMember } from "../controllers/admin.ts";

type Reviewer = Pick<
  AdminBotLabMember,
  "id" | "name" | "arr_reviewer_qualified" | "arr_review_capacity"
>;

export function renderArrReviewers(props: {
  members: readonly Reviewer[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const reviewers = props.members
    .filter((member) => member.arr_reviewer_qualified === true)
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return html` <section class="card">
    <div class="row" style="justify-content: space-between; gap: 16px; flex-wrap: wrap;">
      <div>
        <h2 class="card-title">ARR Eligible Reviewers</h2>
        <p class="card-sub">Qualification and review capacity are self-reported in My Profile.</p>
      </div>
      <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>Refresh</button>
    </div>
    ${props.error
      ? html`<p class="callout danger" role="alert">${props.error}</p>`
      : props.loading
        ? html`<p class="muted" role="status">Loading reviewers…</p>`
        : reviewers.length === 0
          ? html`<p class="muted">No users have confirmed ARR reviewer qualification yet.</p>`
          : html` <p class="muted">
                ${reviewers.length} eligible reviewer${reviewers.length === 1 ? "" : "s"}
              </p>
              <div style="overflow-x: auto;">
                <table style="width: 100%; text-align: left; border-spacing: 0 12px;">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Papers they can review</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${reviewers.map(
                      (member) => html`
                        <tr>
                          <td>${member.name}</td>
                          <td>${member.arr_review_capacity ?? "Not provided"}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>`}
  </section>`;
}
