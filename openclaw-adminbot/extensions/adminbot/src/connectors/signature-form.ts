/**
 * Filing the lab's signature request on its Google Form, without sending anybody to the form.
 *
 * The tab used to be a signpost: a link, and the member filled the four questions in themselves.
 * The questions are the same four either way, so this answers them from the request AdminBot
 * already collected and posts them.
 *
 * A plain form POST, not a browser. The DCS connector drives Playwright because the Microsoft form
 * it files has no submission endpoint worth the name; a Google Form does -- `formResponse` takes
 * url-encoded `entry.<id>` fields and answers 200. There is nothing here for a headless browser to
 * do, so there is no browser, no script to spawn and nothing to crash.
 *
 * The field ids are the form's own and were read off the live form (its `FB_PUBLIC_LOAD_DATA_`) on
 * 2026-09-12. They are stable for the life of a question: editing a question's text keeps its id,
 * deleting and re-adding it does not. If a submission starts landing with blank columns, re-read
 * them from the form before touching anything else here.
 *
 * Google answers 200 with an HTML confirmation page and no machine-readable receipt, so "it
 * worked" means the POST succeeded. A response that is not 2xx is reported to the member as a
 * failure with the form's link, which is the state the tab was in before this existed.
 */

/** The form's own response endpoint -- the `/d/e/<id>/` spelling, which is the public one. */
export const SIGNATURE_FORM_RESPONSE_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSdgPg1xCgh1732dQ16yGbD7YPgaNBpk2u37deEHw2REOl8xew/formResponse";

/** Question ids on that form, in the order it asks them. */
export const SIGNATURE_FORM_FIELDS = {
  name: "entry.93728712",
  driveUrl: "entry.1748268613",
  /** A date question: Google wants it as three fields, not one string. */
  deadline: "entry.1132435368",
  context: "entry.1028961965",
} as const;

export type SignatureFormSubmission = {
  name: string;
  /** The document to sign, as a link. The form asks for a link; it has no upload question. */
  driveUrl: string;
  /** ISO `YYYY-MM-DD`, as the date input produces it. */
  deadline: string;
  context?: string;
};

export type SignatureFormResult = { ok: true } | { ok: false; error: string };

/** Injected in tests. Defaults to the runtime's own fetch. */
export type FormPoster = (url: string, body: URLSearchParams) => Promise<{ status: number }>;

const postForm: FormPoster = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: response.status };
};

/**
 * Splits an ISO date into the three fields a Google date question expects.
 *
 * Returns undefined for anything that is not a calendar date. The form's question is required, and
 * a submission carrying two of the three parts is accepted by Google and stored with an empty
 * date -- worse than a refusal, because nobody finds out.
 */
export function dateParts(iso: string): { year: string; month: string; day: string } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso.trim());
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  const [year, month, day] = [match[1], match[2], match[3]];
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  // Rejects 2026-02-31 and friends: the regex only proves the shape.
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  ) {
    return undefined;
  }
  return { year, month: String(Number(month)), day: String(Number(day)) };
}

/** The body Google is sent, exposed so a test can assert the mapping without a network call. */
export function signatureFormBody(input: SignatureFormSubmission): URLSearchParams | undefined {
  const parts = dateParts(input.deadline);
  if (!parts) {
    return undefined;
  }
  const body = new URLSearchParams();
  body.set(SIGNATURE_FORM_FIELDS.name, input.name.trim());
  body.set(SIGNATURE_FORM_FIELDS.driveUrl, input.driveUrl.trim());
  body.set(`${SIGNATURE_FORM_FIELDS.deadline}_year`, parts.year);
  body.set(`${SIGNATURE_FORM_FIELDS.deadline}_month`, parts.month);
  body.set(`${SIGNATURE_FORM_FIELDS.deadline}_day`, parts.day);
  const context = input.context?.trim();
  if (context) {
    body.set(SIGNATURE_FORM_FIELDS.context, context);
  }
  return body;
}

/**
 * Files one signature request on the form.
 *
 * Never throws: the caller is a route answering a member who is watching, and a thrown fetch is
 * the commonest outcome of the network being unavailable. It comes back as a sentence they can act
 * on instead.
 */
export async function submitSignatureForm(
  input: SignatureFormSubmission,
  deps: { post?: FormPoster; url?: string } = {},
): Promise<SignatureFormResult> {
  if (!input.name.trim()) {
    return { ok: false, error: "a name is required" };
  }
  if (!input.driveUrl.trim()) {
    return { ok: false, error: "a link to the document is required" };
  }
  const body = signatureFormBody(input);
  if (!body) {
    return { ok: false, error: `not a calendar date: ${input.deadline}` };
  }
  const post = deps.post ?? postForm;
  try {
    const { status } = await post(deps.url ?? SIGNATURE_FORM_RESPONSE_URL, body);
    return status >= 200 && status < 300
      ? { ok: true }
      : { ok: false, error: `the form answered ${status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
