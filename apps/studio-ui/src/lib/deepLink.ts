/**
 * kobastudios:// deep-link parsing.
 *
 * The shell forwards the raw URL from the OS (or a second instance) and the UI
 * decides what to do with it. Only the three actions the marketplace and
 * account flows publish are accepted; anything else is ignored rather than
 * guessed at.
 */

export type DeepLinkAction =
  | { kind: "install"; assetId: string }
  | { kind: "open-project"; slug: string }
  | { kind: "auth"; token: string | null };

export const DEEP_LINK_SCHEME = "kobastudios";

export function parseDeepLink(raw: string): DeepLinkAction | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  const action = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (action === "install") {
    const assetId = segments[0];
    return assetId ? { kind: "install", assetId } : null;
  }
  if (action === "open-project") {
    const slug = segments[0];
    return slug ? { kind: "open-project", slug } : null;
  }
  if (action === "auth" && segments[0] === "callback") {
    // The token rides in the query (or hash for providers that cannot keep a
    // query string); it is handed straight to the caller, never persisted here.
    const hashQuery = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    const token = url.searchParams.get("token") ?? new URLSearchParams(hashQuery).get("token");
    return { kind: "auth", token };
  }
  return null;
}

/**
 * A project reference may be the stored id or a human slug such as
 * `harbor ridge`; treat spaces, underscores and hyphens as equivalent.
 */
export function projectMatchesSlug(
  project: { id: string; name: string },
  slug: string,
): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return project.id === slug || normalize(project.name) === normalize(slug);
}

export function isDeepLink(raw: string): boolean {
  try {
    return new URL(raw).protocol === `${DEEP_LINK_SCHEME}:`;
  } catch {
    return false;
  }
}
