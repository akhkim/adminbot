/**
 * A service response body as JSON, or null when there is none.
 *
 * Uploaded photos arrive as `/avatars/<hash>` paths relative to the service (see
 * extensions/adminbot/src/api/avatars.ts); the console is on another origin, so they are made
 * absolute here, once, rather than in every view that draws a face.
 */
export async function readApiJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text(), (key, value: unknown) =>
      key === "avatar_url" &&
      typeof value === "string" &&
      value.startsWith("/avatars/") &&
      response.url
        ? new URL(value, response.url).href
        : value,
    );
  } catch {
    return null;
  }
}
