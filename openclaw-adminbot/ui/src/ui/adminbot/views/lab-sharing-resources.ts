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
    class="lab-sharing-directory"
    aria-label="Collaboration resources"
  >
    <h2 class="lab-sharing-seek__title">Collaboration resources</h2>
    ${resources.map(
      (resource) => html`<article class="lab-sharing-request">
        <h3 class="lab-sharing-request__project">
          <a href=${pathForTab(resource.tab, basePath)}>${resource.title}</a>
        </h3>
        <p>${resource.description}</p>
      </article>`,
    )}
  </section>`;
}
