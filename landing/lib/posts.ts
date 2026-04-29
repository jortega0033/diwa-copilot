import 'server-only';

// Fetch blog posts from the web app API at build time.
// NEXT_PUBLIC_API_BASE_URL is injected by the deploy workflow.
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  'https://app.diwacopilot.com';

export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  publishedAt: string; // ISO date string e.g. "2026-04-28"
  pillar: string;
  author: string;
  readingTimeMin: number;
  coverImageUrl?: string | null;
}

export interface PostFull extends PostMeta {
  content: string; // raw Markdown body
}

/** Firestore Timestamps serialize as { _seconds, _nanoseconds } over JSON. */
function toIsoString(ts: unknown): string {
  if (typeof ts === 'string') return ts;
  if (ts && typeof ts === 'object') {
    const obj = ts as Record<string, unknown>;
    if (typeof obj._seconds === 'number') {
      return new Date(obj._seconds * 1000).toISOString();
    }
  }
  return '';
}

function mapMeta(p: Record<string, unknown>): PostMeta {
  return {
    slug: String(p.slug ?? ''),
    title: String(p.title ?? ''),
    description: String(p.excerpt ?? ''),
    publishedAt: toIsoString(p.publishedAt),
    pillar: String(p.pillar ?? ''),
    author: String(p.authorName ?? 'Diwa Copilot'),
    readingTimeMin: Number(p.readTimeMinutes ?? 1),
    coverImageUrl: (p.coverImageUrl as string | null | undefined) ?? null,
  };
}

export async function getAllPublishedPosts(): Promise<PostMeta[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/blog/posts?limit=50`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { posts?: unknown[] };
    if (!Array.isArray(data.posts)) return [];
    return data.posts
      .map((p) => mapMeta(p as Record<string, unknown>))
      .filter((p) => Boolean(p.slug) && Boolean(p.publishedAt));
  } catch {
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<PostFull | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/blog/posts/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { post?: Record<string, unknown> };
    if (!data.post) return null;
    const p = data.post;
    return {
      ...mapMeta(p),
      content: String(p.content ?? ''),
    };
  } catch {
    return null;
  }
}
