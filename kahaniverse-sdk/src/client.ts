import type {
  ClientConfig, Universe, Story, UniverseInput, ComicInput,
} from './types.js';

export class KahaniverseError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'KahaniverseError';
  }
}

/**
 * Thin typed client over the Kahaniverse HTTP API. Authenticates by replaying a
 * NextAuth session cookie — the same JWT the browser holds — so it hits the very
 * same auth()-guarded routes the app uses. No new server surface, no admin keys.
 */
export class KahaniverseClient {
  private readonly baseUrl: string;
  private readonly cookie: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: ClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const secure = this.baseUrl.startsWith('https://');
    const name = cfg.cookieName ?? (secure ? '__Secure-authjs.session-token' : 'authjs.session-token');
    this.cookie = `${name}=${cfg.sessionToken}`;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  // ── low-level ─────────────────────────────────────────────────────
  private async req(path: string, init: RequestInit & { rawBody?: Uint8Array } = {}): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set('cookie', this.cookie);
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        body: init.rawBody ?? init.body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new KahaniverseError(data?.error ?? res.statusText, res.status, data?.code);
    }
    return data as T;
  }

  /** Verify the session token resolves to an author (fail fast on a bad token). */
  async whoami(): Promise<{ id: string } | null> {
    const res = await this.req('/api/auth/session');
    if (!res.ok) return null;
    const s = await res.json().catch(() => null) as { user?: { id?: string } } | null;
    return s?.user?.id ? { id: s.user.id } : null;
  }

  // ── universes ─────────────────────────────────────────────────────
  async getUniverse(slug: string): Promise<Universe | null> {
    const res = await this.req(`/api/universes/${encodeURIComponent(slug)}`);
    if (res.status === 404) return null;
    return this.json<Universe>(res);
  }

  async createUniverse(input: UniverseInput): Promise<Universe> {
    const res = await this.req('/api/universes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Send the explicit slug so the universe lives at the intended
        // /universes/{slug}. Without it the server derives the slug from the
        // name, so name "The Chahamana Legacy" would create "the-chahamana-legacy"
        // instead of the desired "chahamana".
        slug: input.slug,
        name: input.name, concept: input.concept, coverImage: input.coverImage,
        genres: input.genres ?? [], era: input.era, world: input.world,
        isMature: input.isMature ?? false,
      }),
    });
    return this.json<Universe>(res);
  }

  /** GET the universe by slug; create it (from `input`) when absent. */
  async ensureUniverse(slug: string, input?: UniverseInput): Promise<Universe> {
    const found = await this.getUniverse(slug);
    if (found) return found;
    if (!input) throw new KahaniverseError(`Universe "${slug}" not found and no metadata to create it`, 404);
    if (input.slug !== slug) {
      throw new KahaniverseError(`ensureUniverse slug mismatch: looked up "${slug}" but input.slug is "${input.slug}"`, 400);
    }
    const created = await this.createUniverse(input);
    // The server now honors input.slug, so the created universe resolves at it.
    // Guard anyway so a stray, wrong-slug universe never passes silently.
    if (created.slug !== slug) {
      throw new KahaniverseError(`Created universe got slug "${created.slug}", expected "${slug}"`, 500);
    }
    return created;
  }

  // ── comics (stories with kind='comic') ────────────────────────────
  async findComic(universeId: string, slug: string): Promise<Story | null> {
    // Comics are published on create, so a plain kind=comic listing finds them.
    let page = 1;
    for (;;) {
      const res = await this.req(`/api/stories?kind=comic&universeId=${universeId}&page=${page}&limit=50`);
      const body = await this.json<{ data: Story[]; hasMore: boolean }>(res);
      const hit = body.data.find(s => s.slug === slug);
      if (hit) return hit;
      if (!body.hasMore) return null;
      page += 1;
    }
  }

  async createComic(universeId: string, input: ComicInput): Promise<Story> {
    const res = await this.req('/api/stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'comic', slug: input.slug, title: input.title, synopsis: input.synopsis,
        universeId, coverImage: input.coverImage, genreTags: input.genreTags ?? [],
        isMature: input.isMature ?? false,
      }),
    });
    return this.json<Story>(res);
  }

  async ensureComic(universeId: string, input: ComicInput): Promise<Story> {
    const found = await this.findComic(universeId, input.slug);
    return found ?? this.createComic(universeId, input);
  }

  // ── uploads ───────────────────────────────────────────────────────
  /** Stream a prepared image straight to the app's /api/upload (→ Vercel Blob).
   *  Accepts any `Uint8Array` (a Node `Buffer` is one) so browser callers can pass
   *  bytes read from a `Blob`/canvas without a `Buffer` polyfill. */
  async uploadImage(buffer: Uint8Array, filename: string, contentType: string): Promise<string> {
    const qs = `?filename=${encodeURIComponent(filename)}&contentType=${encodeURIComponent(contentType)}`;
    const res = await this.req(`/api/upload${qs}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      rawBody: buffer,
    });
    const body = await this.json<{ url: string }>(res);
    return body.url;
  }

  /** Bulk-append comic pages in one request (single function invocation). */
  async batchComicPages(
    storyId: string,
    pages: Array<{ illustration: string; spread?: boolean; content?: string }>,
  ): Promise<{ id: string }[]> {
    const res = await this.req(`/api/stories/${storyId}/pages/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages }),
    });
    const body = await this.json<{ data: { id: string }[] }>(res);
    return body.data;
  }

  /**
   * Bulk-update existing comic pages by id in one request — the path for pages
   * whose image or spread changed on a re-run. The server reclaims the old blob
   * of any illustration that gets replaced. Omitted fields are left unchanged.
   */
  async updateComicPages(
    storyId: string,
    pages: Array<{ id: string; illustration?: string; spread?: boolean; content?: string }>,
  ): Promise<{ id: string }[]> {
    const res = await this.req(`/api/stories/${storyId}/pages/batch`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages }),
    });
    const body = await this.json<{ data: { id: string }[] }>(res);
    return body.data;
  }
}
