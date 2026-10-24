// Slack's stand-in photo for someone who never uploaded one. Slack hands it out as a Gravatar URL
// whose fallback is one of its coloured-letter silhouettes (`/img/avatars/ava_0013-512.png`), or as
// that silhouette directly. It is a valid https image, so without this check it reads as a photo.

const SLACK_DEFAULT_AVATAR_PATH = /\/img\/avatars\/ava_\d+/u;

export function isSlackDefaultAvatar(url: string | undefined): boolean {
  const value = url?.trim();
  if (!value) {
    return false;
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed escape is not Slack's format either way; test the raw string.
  }
  return SLACK_DEFAULT_AVATAR_PATH.test(decoded) && /slack-edge\.com|slack\.com/u.test(decoded);
}
