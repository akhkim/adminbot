/**
 * A service response body as JSON, or null when there is none.
 *
 * Uploaded photos arrive as `/avatars/<hash>` paths relative to the service (see
 * extensions/adminbot/src/api/avatars.ts); the console is on another origin, so they are made
 * absolute here, once, rather than in every view that draws a face.
 */
export async function readApiJson(response: Response): Promise<unknown> {
  try {
    return parseApiJson(await response.text(), response.url);
  } catch {
    return null;
  }
}

/** The same parse over text already read -- a body kept for revalidation is re-parsed per use. */
export function parseApiJson(text: string, responseUrl: string): unknown {
  try {
    return JSON.parse(text, (key, value: unknown) =>
      key === "avatar_url" &&
      typeof value === "string" &&
      value.startsWith("/avatars/") &&
      responseUrl
        ? new URL(value, responseUrl).href
        : value,
    );
  } catch {
    return null;
  }
}
