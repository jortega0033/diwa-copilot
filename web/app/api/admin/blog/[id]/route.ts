export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { withAdminAuth } from '@/lib/auth-middleware';
import { adminDb } from '@/lib/firebase-admin';
import {
  readJsonObject,
  readRequiredString,
  readOptionalString,
  badRequest,
  hasOnlyAllowedKeys,
} from '@/lib/request-validation';
import type { BlogPost, BlogPostStatus } from '@/lib/firestore-schemas';

const VALID_PILLARS = [
  'interview-prep', 'career-growth', 'job-search', 'ai-tools',
  'product-updates', 'behavioral', 'technical', 'salary',
] as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_PATTERN = /^[a-z0-9-]+$/;

// Status machine: from -> Set of valid to values
const STATUS_TRANSITIONS: Record<BlogPostStatus, BlogPostStatus[]> = {
  draft: ['published', 'pending_review'],
  pending_review: ['published', 'draft'],
  published: ['unpublished'],
  unpublished: ['published', 'draft'],
};

function calcReadTime(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/**
 * Triggers an inline Cloud Build job that clones the repo and rebuilds + redeploys
 * the static landing site to Firebase Hosting.
 *
 * Uses builds.create (not a trigger) so no GitHub connection or trigger ID is needed.
 * Uses the Cloud Run service account identity via GCP metadata server — no extra secrets.
 *
 * IAM prerequisites (one-time setup):
 *   - Cloud Build SA (399838595429@cloudbuild.gserviceaccount.com) → roles/firebasehosting.admin
 *   - Cloud Run SA (diwa-web-runtime@...) → roles/cloudbuild.builds.editor
 *   - Cloud Build SA (713365573083@cloudbuild.gserviceaccount.com) → roles/secretmanager.secretAccessor on secret `diwa-github-pat`
 */
async function triggerCloudBuildLandingDeploy(): Promise<{ triggered: boolean; error: string | null }> {
  const projectId = process.env.FIREBASE_PROJECT_ID ?? 'diwa-copilot-ai-491108';
  const githubPatSecretName = process.env.GITHUB_PAT_SECRET_NAME ?? 'diwa-github-pat';

  // Obtain a short-lived access token from the GCP metadata server (Cloud Run only)
  let accessToken: string | null = null;
  try {
    const tokenRes = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    if (tokenRes.ok) {
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      accessToken = tokenData.access_token ?? null;
    }
  } catch {
    // Not running in GCP (local dev) — skip trigger silently
  }

  if (!accessToken) {
    console.warn('[blog/patch] No GCP credentials available — landing rebuild skipped (local dev?)');
    return { triggered: false, error: 'No GCP credentials available' };
  }

  const buildBody = {
    timeout: '600s',
    steps: [
      {
        id: 'clone',
        name: 'alpine/git',
        entrypoint: 'sh',
        secretEnv: ['GITHUB_PAT'],
        args: [
          '-c',
          'set -eu; test -n "$$GITHUB_PAT"; git clone --depth=1 "https://x-access-token:$$GITHUB_PAT@github.com/jortega0033/diwa.git" /workspace/repo',
        ],
      },
      {
        id: 'install',
        name: 'node:24',
        dir: '/workspace/repo/landing',
        args: ['npm', 'ci'],
      },
      {
        id: 'build',
        name: 'node:24',
        dir: '/workspace/repo/landing',
        args: ['npm', 'run', 'build'],
        env: [
          'NEXT_PUBLIC_APP_URL=https://app.diwacopilot.com',
          'NEXT_PUBLIC_API_BASE_URL=https://app.diwacopilot.com',
        ],
      },
      {
        id: 'deploy',
        name: 'node:24',
        dir: '/workspace/repo',
        entrypoint: 'bash',
        args: [
          '-c',
          'npm install -g firebase-tools@latest && firebase deploy --only hosting:landing --project diwa-copilot-ai-491108 --non-interactive',
        ],
      },
    ],
    availableSecrets: {
      secretManager: [
        {
          versionName: `projects/${projectId}/secrets/${githubPatSecretName}/versions/latest`,
          env: 'GITHUB_PAT',
        },
      ],
    },
  };

  try {
    const response = await fetch(
      `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBody),
      }
    );
    if (response.ok) {
      return { triggered: true, error: null };
    }
    const text = await response.text();
    console.error(`[blog/patch] Cloud Build create returned ${response.status}: ${text}`);
    return { triggered: false, error: `Cloud Build API status ${response.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[blog/patch] Cloud Build create fetch failed:', msg);
    return { triggered: false, error: msg };
  }
}

type RouteParams = { params: Promise<{ id: string }> };

async function getHandler(_req: Request, _adminUid: string, id: string): Promise<NextResponse> {
  const doc = await adminDb.collection('blog_posts').doc(id).get();
  if (!doc.exists) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ post: { id: doc.id, ...doc.data() } });
}

async function patchHandler(req: Request, adminUid: string, id: string): Promise<NextResponse> {
  const body = await readJsonObject(req);
  if (!body) return badRequest('Invalid JSON');

  const ALLOWED_PATCH_KEYS = [
    'title', 'slug', 'excerpt', 'content', 'coverImageUrl',
    'tags', 'authorName', 'seo', 'pillar', 'status',
  ];
  if (!hasOnlyAllowedKeys(body, ALLOWED_PATCH_KEYS)) {
    return badRequest('Unknown fields in request body');
  }

  const postDoc = await adminDb.collection('blog_posts').doc(id).get();
  if (!postDoc.exists) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const existing = { id: postDoc.id, ...postDoc.data() } as BlogPost;

  const updates: Partial<BlogPost> & Record<string, unknown> = {
    updatedAt: Timestamp.now(),
    lastEditedByUid: adminUid,
  };

  // Content fields
  if ('title' in body) {
    const title = readRequiredString(body, 'title', 3, 200);
    if (!title) return badRequest('title must be 3–200 chars');
    updates.title = title;
  }

  if ('excerpt' in body) {
    const excerpt = readRequiredString(body, 'excerpt', 10, 300);
    if (!excerpt) return badRequest('excerpt must be 10–300 chars');
    updates.excerpt = excerpt;
  }

  if ('content' in body) {
    const content = readRequiredString(body, 'content', 10, 200000);
    if (!content) return badRequest('content must be 10–200000 chars');
    updates.content = content;
    updates.readTimeMinutes = calcReadTime(content);
  }

  if ('authorName' in body) {
    const authorName = readOptionalString(body, 'authorName', 1, 100);
    if (authorName !== undefined) updates.authorName = authorName ?? existing.authorName;
  }

  if ('coverImageUrl' in body) {
    const coverImageUrl = readOptionalString(body, 'coverImageUrl', 0, 500);
    updates.coverImageUrl = coverImageUrl ?? null;
  }

  if ('pillar' in body) {
    const pillar = readRequiredString(body, 'pillar', 1, 50);
    if (!pillar) return badRequest('pillar is required');
    if (!(VALID_PILLARS as readonly string[]).includes(pillar)) {
      return badRequest(`pillar must be one of: ${VALID_PILLARS.join(', ')}`);
    }
    updates.pillar = pillar;
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags)) return badRequest('tags must be an array');
    if (body.tags.length > 10) return badRequest('tags: max 10 items');
    const tagArr = body.tags as unknown[];
    for (const tag of tagArr) {
      if (typeof tag !== 'string' || tag.length < 1 || tag.length > 50 || !/^[a-z0-9-]+$/.test(tag)) {
        return badRequest(`tag "${String(tag)}" is invalid`);
      }
    }
    updates.tags = [...new Set(tagArr as string[])];
  }

  if ('seo' in body && body.seo && typeof body.seo === 'object' && !Array.isArray(body.seo)) {
    const seoObj = body.seo as Record<string, unknown>;
    updates.seo = {
      metaTitle: typeof seoObj.metaTitle === 'string' ? seoObj.metaTitle.slice(0, 70) : existing.seo?.metaTitle ?? '',
      metaDescription: typeof seoObj.metaDescription === 'string' ? seoObj.metaDescription.slice(0, 320) : existing.seo?.metaDescription ?? '',
      canonicalUrl: typeof seoObj.canonicalUrl === 'string' ? seoObj.canonicalUrl : existing.seo?.canonicalUrl ?? null,
    };
  }

  // Slug change — requires transaction to swap blog_slugs sentinel
  if ('slug' in body && body.slug !== existing.slug) {
    const newSlug = readRequiredString(body, 'slug', 3, 100);
    if (!newSlug) return badRequest('slug must be 3–100 chars');
    if (!SLUG_PATTERN.test(newSlug)) return badRequest('slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/');

    const newSlugRef = adminDb.collection('blog_slugs').doc(newSlug);
    const oldSlugRef = adminDb.collection('blog_slugs').doc(existing.slug);
    const postRef = adminDb.collection('blog_posts').doc(id);

    try {
      await adminDb.runTransaction(async (tx) => {
        const newSlugSnap = await tx.get(newSlugRef);
        if (newSlugSnap.exists) throw new Error('slug_conflict');
        tx.delete(oldSlugRef);
        tx.set(newSlugRef, { blogPostId: id, createdAt: Timestamp.now() });
        tx.update(postRef, { ...updates, slug: newSlug });
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'slug_conflict') {
        return NextResponse.json({ error: 'slug_conflict' }, { status: 409 });
      }
      throw err;
    }

    const updated = await adminDb.collection('blog_posts').doc(id).get();
    return NextResponse.json({ post: { id, ...updated.data() }, rebuildTriggered: false, rebuildError: null });
  }

  // Status transition
  let rebuildTriggered = false;
  let rebuildError: string | null = null;

  if ('status' in body) {
    const newStatus = body.status as string;
    const validStatuses: BlogPostStatus[] = ['draft', 'pending_review', 'published', 'unpublished'];
    if (!validStatuses.includes(newStatus as BlogPostStatus)) {
      return badRequest('Invalid status value');
    }

    const allowed = STATUS_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(newStatus as BlogPostStatus)) {
      return NextResponse.json(
        { error: 'Invalid status transition', from: existing.status, to: newStatus },
        { status: 409 }
      );
    }

    updates.status = newStatus as BlogPostStatus;

    // Set publishedAt only on first transition to published
    if (newStatus === 'published' && existing.publishedAt === null) {
      updates.publishedAt = Timestamp.now();
    }

    // Trigger Cloud Build landing rebuild on publish/unpublish transitions
    if (newStatus === 'published' || newStatus === 'unpublished') {
      await adminDb.collection('blog_posts').doc(id).update(updates);
      const dispatch = await triggerCloudBuildLandingDeploy();
      rebuildTriggered = dispatch.triggered;
      rebuildError = dispatch.error;

      const updated = await adminDb.collection('blog_posts').doc(id).get();
      return NextResponse.json({ post: { id, ...updated.data() }, rebuildTriggered, rebuildError });
    }
  }

  // Simple update (no slug change, no workflow trigger needed)
  await adminDb.collection('blog_posts').doc(id).update(updates);
  const updated = await adminDb.collection('blog_posts').doc(id).get();
  return NextResponse.json({ post: { id, ...updated.data() }, rebuildTriggered, rebuildError });
}

async function deleteHandler(_req: Request, _adminUid: string, id: string): Promise<NextResponse> {
  const postDoc = await adminDb.collection('blog_posts').doc(id).get();
  if (!postDoc.exists) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const post = postDoc.data() as BlogPost;

  if (post.status === 'published') {
    return NextResponse.json(
      { error: 'Cannot delete a published post. Unpublish it first.' },
      { status: 409 }
    );
  }

  const batch = adminDb.batch();
  batch.delete(adminDb.collection('blog_posts').doc(id));
  batch.delete(adminDb.collection('blog_slugs').doc(post.slug));
  await batch.commit();

  return NextResponse.json({ deleted: true });
}

// Next.js App Router dynamic route handler wrappers
export async function GET(req: Request, { params }: RouteParams) {
  const { id } = await params;
  return withAdminAuth((r, uid) => getHandler(r, uid, id))(req);
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { id } = await params;
  return withAdminAuth((r, uid) => patchHandler(r, uid, id))(req);
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const { id } = await params;
  return withAdminAuth((r, uid) => deleteHandler(r, uid, id))(req);
}
