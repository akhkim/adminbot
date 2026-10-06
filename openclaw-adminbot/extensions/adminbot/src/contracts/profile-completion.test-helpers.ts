const PROFILE_ANSWERS = {
  calendar_email: "ada@example.com",
  correspondence_email: "ada@example.com",
  location: "Toronto",
  research_topics: ["synthetic-test-topic"],
  whatsapp: "+1 555 0100",
  joined_month: "2026-01",
  affiliation: "Example University",
  hours_per_week: 0,
  github_url: "https://github.com/example",
  linkedin_url: "https://linkedin.com/in/example",
  linkedin_urn: "ACoAAB1234567",
  twitter_url: "https://x.com/example",
  personal_website: "https://example.com",
  cv_url: "https://example.com/cv.pdf",
  one_on_one_folder_url: "https://drive.google.com/drive/folders/example",
  intake_form_unavailable: true,
  openreview_id: "~Example_User1",
  arr_reviewer_qualified: false,
};
export const COMPLETE_PROFILE = {
  ...PROFILE_ANSWERS,
  id: "ada",
  name: "Ada Example",
  privilege_level: "member" as const,
  email: "ada@example.com",
};

// Feature-route fixtures have completed onboarding; gate tests seed incomplete rows explicitly.
export function withCompleteProfile<T extends object>(member: T) {
  const email = (member as { email?: string }).email;
  return {
    ...PROFILE_ANSWERS,
    calendar_email: email ?? PROFILE_ANSWERS.calendar_email,
    correspondence_email: email ?? PROFILE_ANSWERS.correspondence_email,
    ...member,
  };
}
