/** Config for a KahaniverseClient. */
export interface ClientConfig {
  /** e.g. https://kahaniverse.com or http://localhost:3000 */
  baseUrl: string;
  /**
   * A NextAuth (Auth.js v5) session-token JWT, copied from an authenticated
   * browser (DevTools → Application → Cookies → authjs.session-token). The
   * login form is Turnstile-gated, so a copied token is the supported path.
   */
  sessionToken: string;
  /**
   * Override the session cookie name. Defaults are derived from baseUrl:
   *   https → __Secure-authjs.session-token, http → authjs.session-token.
   */
  cookieName?: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /**
   * Override the `fetch` implementation. A browser/webview `fetch` cannot set a
   * `Cookie` header on a cross-origin request (it is a forbidden header), so a
   * Tauri app must inject `@tauri-apps/plugin-http`'s `fetch` here to authenticate.
   * Defaults to the global `fetch` (correct for Node and the CLI).
   */
  fetchImpl?: typeof fetch;
}

export interface Universe {
  id: string; slug: string; name: string; coverImage: string;
}

export interface Story {
  id: string; title: string; slug?: string; kind: 'story' | 'comic';
  universe: { id: string; slug: string; name: string };
}

export interface UploadedImage { url: string }

/** Metadata to create a universe if it does not already exist. */
export interface UniverseInput {
  slug: string;              // resolve target; created name must slugify to this
  name: string;
  concept: string;
  coverImage: string;        // URL (required by the backend). Upload one first.
  genres?: string[];
  era?: string;
  world?: string;
  isMature?: boolean;
}

/** Metadata to create a comic if it does not already exist. */
export interface ComicInput {
  slug: string;              // /comics/{universe}/{slug}
  title: string;
  synopsis: string;
  coverImage?: string;
  genreTags?: string[];
  isMature?: boolean;
}

export interface ComicPageInput {
  /** Absolute or relative path to the source image. */
  file: string;
  /** Two-page spread (wide). Auto-detected from aspect ratio when omitted. */
  spread?: boolean;
  /** Optional caption shown under the page. */
  caption?: string;
}
