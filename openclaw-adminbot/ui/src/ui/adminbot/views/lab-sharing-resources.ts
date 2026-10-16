import { html, nothing } from "lit";
import { pathForTab, type Tab } from "../../navigation.ts";

const resources: { tab: Tab; title: string; description: string }[] = [
  {
    tab: "adminbotMeetings",
    title: "Meeting recordings",
    description: "Find previous lab discussions.",
  },
  {
    tab: "profile",
    title: "My profile",
    description: "Keep your research topics current so members can find you.",
  },
  {
    tab: "adminbotTimeAvailability",
    title: "Time availability",
    description: "Update your saved availability.",
  },
  { tab: "myWork", title: "My projects & papers", description: "Manage your project information." },
];

export function renderLabSharingResources(basePath: string, signedIn: boolean) {
  if (!signedIn) {
    return nothing;
  }
  return html`<section
    class="card adminbot-card adminbot-card--wide lab-sharing-resources"
    aria-label="Collaboration resources"
  >
    <h2 class="card-title">Collaboration resources</h2>
    <p class="card-sub">Pages that help other members find you and work with you.</p>
    <ul class="lab-sharing-resources__grid">
      ${resources.map(
        (resource) => html`<li>
          <a class="lab-sharing-resources__link" href=${pathForTab(resource.tab, basePath)}>
            <span class="lab-sharing-resources__title">${resource.title}</span>
            <span class="lab-sharing-resources__desc">${resource.description}</span>
          </a>
        </li>`,
      )}
    </ul>
  </section>`;
}
