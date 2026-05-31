export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth-middleware';
import { getCorsHeaders } from '@/lib/cors-utils';
import { withFeatureGate } from '@/lib/feature-gates';
import { readJsonObject, readOptionalEnum } from '@/lib/request-validation';
import { checkRateLimit } from '@/lib/rate-limit';
import { adminDb } from '@/lib/firebase-admin';
import { Timestamp } from '@google-cloud/firestore';

// L-1 fix: allowlist production-only SKUs; remove preview models from default path.
// Added gpt-realtime-mini; removed gpt-4o-mini-realtime-preview from default.
const ALLOWED_REALTIME_MODELS = [
  'gpt-realtime-1.5',
  'gpt-realtime-2',
  'gpt-realtime-mini',
  'gpt-4o-mini-realtime-preview',
] as const;
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2';

// Internal aliases used by the client → real OpenAI Realtime model identifiers.
const REALTIME_MODEL_MAP: Record<(typeof ALLOWED_REALTIME_MODELS)[number], string> = {
  'gpt-realtime-1.5':             'gpt-4o-realtime-preview',
  'gpt-realtime-2':               'gpt-4o-realtime-preview',
  'gpt-realtime-mini':            'gpt-4o-mini-realtime-preview',
  'gpt-4o-mini-realtime-preview': 'gpt-4o-mini-realtime-preview',
};

// H-9 fix: dedicated per-user rate-limit bucket for the token mint endpoint.
// Much tighter than the generic 20/min AI bucket to limit ephemeral token abuse.
const REALTIME_SESSION_RATE_LIMIT = 5;
const REALTIME_SESSION_RATE_WINDOW_SECONDS = 60;
const REALTIME_SESSION_HOURLY_RATE_LIMIT = 50;
const REALTIME_SESSION_HOURLY_RATE_WINDOW_SECONDS = 3600;

async function handler(req: Request, userId: string) {
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not configured');
    return NextResponse.json(
      { error: 'Service not configured' },
      { status: 500, headers: corsHeaders },
    );
  }

  // H-9 fix: dedicated per-minute AND per-hour rate-limit buckets.
  const [perMinResult, perHourResult] = await Promise.all([
    checkRateLimit(`realtime-mint:${userId}`, REALTIME_SESSION_RATE_LIMIT, REALTIME_SESSION_RATE_WINDOW_SECONDS),
    checkRateLimit(`realtime-mint-hourly:${userId}`, REALTIME_SESSION_HOURLY_RATE_LIMIT, REALTIME_SESSION_HOURLY_RATE_WINDOW_SECONDS),
  ]);

  if (!perMinResult.allowed) {
    const retryAfter = Math.max(0, perMinResult.resetAt - Math.floor(Date.now() / 1000));
    return NextResponse.json(
      { error: 'TOO_MANY_REQUESTS', message: 'Realtime session rate limit exceeded' },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(REALTIME_SESSION_RATE_LIMIT),
          'X-RateLimit-Remaining': String(perMinResult.remaining),
        },
      },
    );
  }

  if (!perHourResult.allowed) {
    const retryAfter = Math.max(0, perHourResult.resetAt - Math.floor(Date.now() / 1000));
    return NextResponse.json(
      { error: 'TOO_MANY_REQUESTS', message: 'Hourly realtime session rate limit exceeded' },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          'Retry-After': String(retryAfter),
        },
      },
    );
  }

  try {
    const body = await readJsonObject(req);
    const modelParam = body ? readOptionalEnum(body, 'model', ALLOWED_REALTIME_MODELS) : undefined;
    // null → provided but not in allowlist → reject explicitly
    if (modelParam === null) {
      return NextResponse.json(
        { error: 'INVALID_REALTIME_MODEL' },
        { status: 400, headers: corsHeaders },
      );
    }
    const model = modelParam ?? DEFAULT_REALTIME_MODEL;
    const openaiModel = REALTIME_MODEL_MAP[model];

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // The GA /v1/realtime/client_secrets endpoint only accepts `model`.
        // `type: 'realtime'` was an undocumented beta field — removed to align with GA spec.
        session: {
          model: openaiModel,
        },
      }),
    });

    if (!response.ok) {
      // L-3 fix: do not leak upstream error text in thrown Error.message.
      // Log the raw text internally; return a stable error code to the client.
      const errorText = await response.text();
      console.error('[realtime-session] upstream error', { status: response.status, model: openaiModel });
      if (process.env.NODE_ENV !== 'production') {
        console.error('[realtime-session] upstream detail (dev only):', errorText);
      }
      return NextResponse.json(
        { error: 'REALTIME_SESSION_UNAVAILABLE' },
        { status: 502, headers: corsHeaders },
      );
    }

    const data = await response.json() as Record<string, unknown>;
    const token = data?.value;
    if (typeof token !== 'string' || !token) {
      console.error('[realtime-session] client_secrets response missing value field');
      return NextResponse.json(
        { error: 'Failed to obtain realtime session token' },
        { status: 502, headers: corsHeaders },
      );
    }

    // L-4 fix: write usage_logs row for every successful mint for auditability.
    void adminDb.collection('usage_logs').add({
      userId,
      feature: 'realtime_token_mint',
      model: openaiModel,
      timestamp: Timestamp.now(),
      status: 'success',
    }).catch((err: unknown) => {
      console.warn('[realtime-session] usage_logs write failed:', err);
    });

    // L-2 fix: return a minimal typed contract — only fields the client needs.
    // Never echo the full upstream payload which may contain internal OpenAI fields.
    return NextResponse.json(
      { value: token as string, model: openaiModel },
      { headers: corsHeaders },
    );
  } catch (error: unknown) {
    // L-3 fix: log stable metadata; do not surface raw upstream error text.
    console.error('[realtime-session] unexpected error:', error instanceof Error ? error.message : 'unknown');

    // L-4 fix: log failed mint attempts too.
    void adminDb.collection('usage_logs').add({
      userId,
      feature: 'realtime_token_mint',
      timestamp: Timestamp.now(),
      status: 'error',
      errorCode: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
    }).catch(() => undefined);

    return NextResponse.json(
      { error: 'Could not create realtime session' },
      { status: 500, headers: corsHeaders },
    );
  }
}

export const OPTIONS = async (req: Request) => {
  return NextResponse.json({}, { headers: getCorsHeaders(req.headers.get('origin')) });
};

export const POST = withAuth(withFeatureGate('startInterview', handler));
