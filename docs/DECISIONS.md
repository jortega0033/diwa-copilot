# Diwa Copilot — Decisions & Notes

A shared scratchpad for cross-agent coordination. All agents (Molty, Dex, Diwa PO/Web/App) should read and append here.

---

## Format

```markdown
## YYYY-MM-DD — [Agent] — Topic
Brief description of decision, learning, or note.
```

## 2026-04-25 — Dex — Issue #265 Wallet Migration: Final Policy Lock and Rollback Thresholds

### Canonical naming

- Firestore field: `walletCents` (integer, cents)
- Conversion constant: `CENTS_PER_CREDIT = 20` (1 credit = $0.20 = 20 cents), defined in `web/lib/wallet-migration-constants.ts`
- API contract integer fields: `walletBalanceCents`, `walletSpentThisMonthCents`, `walletRateCentsPerMinute`, `minimumChargeCents`, `maximumChargeCents`, `amountCents`
- UX copy: "wallet balance" for current spendable amount; "session balance" for real-time usage during a live interview

### Migration phase sequence

1. **Phase 1** (debit-on-success + webhook hardening) — debit credits at session end only; webhook idempotency via `stripeEventId` guard
2. **Phase 3** (UX copy sweep) — rename UI labels from "credits" → "wallet balance" behind `UX_WALLET_TERMINOLOGY`
3. **Phase 4** (dual-write) — every balance mutation also writes `walletCents` when `BILLING_WALLET_DUAL_WRITE=true`
4. **Phase 5** (contract fields + Electron types) — API responses expose parallel cents integer fields; Electron `api-client.ts` interfaces extended

### Staged rollout order

1. Internal staging — all feature flags off by default; devs opt in per deploy
2. Opt-in cohort — `BILLING_WALLET_DUAL_WRITE=true`; shadow-write only, no reads from `walletCents`
3. Full write — `CONTRACTS_WALLET_V2=true`; cents fields appear in all API responses
4. Read-primary — `BILLING_WALLET_READ_PRIMARY=true`; enabled only after dual-write has been verified accurate in production for ≥7 days

### Kill-switch procedure

If any rollback threshold is hit, disable via:
```
gcloud run services update diwa-web \
  --set-env-vars BILLING_WALLET_DUAL_WRITE=false,CONTRACTS_WALLET_V2=false,UX_WALLET_TERMINOLOGY=false
```
Then trigger a new Cloud Run revision to pick up the env change. The `walletCents` field in Firestore can remain in place — it is additive and not read unless `BILLING_WALLET_READ_PRIMARY=true`.

### Rollback trigger thresholds

- Any negative `walletCents` value observed in production Firestore
- Any billing discrepancy (`credits.balance * 20 ≠ walletCents`) appearing in `transaction_logs` after a write
- Stripe webhook 5xx error rate > 1% sustained over a 10-minute window
- User-reported balance mismatch in support that cannot be explained by in-flight session

### Backward-compatibility window

`credits` (legacy) and `walletCents` coexist in Firestore indefinitely until `BILLING_WALLET_READ_PRIMARY` is enabled at scale. All read paths that depend on credits balance continue to use `credits.balance` until that flag is active. This ensures zero-disruption rollback at any phase.

### Backfill

Use `web/scripts/backfill-wallet-cents.ts` to populate `walletCents` on user documents written before Phase 4 was activated. Script is idempotent (skips docs already in sync) and supports `--dry-run` for pre-flight auditing.

---

## 2026-04-24 — Dex — Issue #265 Phase 1 Second-Pass Security Fixes

Second-pass audit of PR #266 by all specialist agents. The following issues were identified and fixed before merge.

### Fixes applied

**W1 — Webhook module-level throw (MEDIUM)**
`web/app/api/billing/webhook/route.ts`: Moved `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY` env-var guards from module-level `throw` to per-request `return 500` inside the POST handler. Prevents `next build` failure in CI environments without Stripe credentials.

**B2 — `logUsageFailure` misleading audit status (MEDIUM)**
`web/app/api/ai/prep-package/route.ts`: Added optional `status` parameter to `logUsageFailure`. Post-debit write failures now log `status: 'failed_after_debit'` instead of `'failed'`, accurately indicating credits were charged despite non-delivery. Added `'failed_after_debit'` to `UsageLog.status` union in `web/lib/firestore-schemas.ts`.

**X1 — Prompt injection via `companyName` / `roleTitle` (MEDIUM)**
`web/app/api/ai/prep-package/route.ts` and `web/app/api/ai/persona-alignment/route.ts`: Strip control characters (newlines, tabs, `\x00–\x1F`, `\x7F`) from user-supplied `companyName` and `roleTitle` before interpolation into Gemini prompts. Length validation was already in place; this adds injection hygiene.

**Firestore schema gap**
`web/lib/firestore-schemas.ts`: Added `ProcessedCheckout` type for the `processed_checkouts/{sessionId}` collection used as legacy secondary idempotency in the webhook handler.

**W2 — Stale-read window (LOW)**
`web/app/api/billing/webhook/route.ts`: Added code comment documenting the safe stale-read window between the outer collection-group query and the inner `runTransaction` re-read in the `charge.refunded` handler.

**A1 — Anonymous user fallthrough in `getBearerClaims` (LOW)**
`web/lib/user-auth-helpers.ts`: Added comment explaining that anonymous Firebase users (no email/name/picture) produce all-empty forwarded headers, which correctly fall through to the JWT payload parse. The fallthrough is intentional and safe since token signature was already verified by `withAuth`.

### prep-package debit ordering: accepted tradeoff

`web/app/api/ai/prep-package/route.ts` runs three AI calls. `deductCredits` fires after AI calls 1 and 2 (intel + mock questions), but **before** AI call 3 (resume suggestions). If AI call 3 fails, the user is charged for the package but receives `resumeSuggestions: []` with a `status: 'failed_after_debit'` audit log. This is an accepted tradeoff:
- Intel and questions are the primary value delivery. Resume suggestions are supplementary.
- Moving the debit after all three AI calls would require reverting if calls 1 or 2 succeeded — this is more complex than the current fallback pattern.
- Phase 2 will consider an optimistic-reserve pattern to eliminate this window entirely.

### Known risk: per-user TOCTOU on AI routes (HIGH — Phase 2 gate)

`ensureSufficientCredits` is a non-transactional pre-flight hint. Concurrent requests can all pass it before any `deductCredits` runs, causing N Gemini API calls to execute where only 1 was paid for. The `deductCredits` Firestore transaction correctly enforces balance — users cannot go negative — but the platform absorbs the AI cost of the race losers.

This is not new behaviour (the old `checkAndDeductCredits` had the same window). Exploitation requires authenticated users sending burst concurrent requests. Current Gemini default rate limits (1000 RPM shared) provide partial defence.

**Phase 2 gate**: Add per-user short-TTL Firestore credit reservation document (lock-before-AI pattern) or a per-user in-flight request counter before closing issue #265. Tracked in issue #268.

### Phase 2 scope (no tracking issue yet)
The full issue #265 requirements — walletCents canonical field, feature flags, API contract migration, UI de-creditization (web/electron/landing/support), intel route migration, CI anti-drift check — are NOT in PR #266. A follow-up issue must be created before closing #265.

## 2026-04-22 — Dex — Issue #265 Charging Policy Lock (Phase 1)

Locked the first implementation decision for issue #265: one-shot AI endpoints now follow `debit on success only`.

### Scope completed
- Added shared billing helpers in `web/lib/resume-builder/billing.ts`:
	- `ensureSufficientCredits(uid, cost)` for affordability pre-checks
	- `deductCredits(uid, cost)` for explicit post-success debit
- Updated one-shot AI routes to use pre-check + post-success debit:
	- `web/app/api/ai/gap-analysis/route.ts`
	- `web/app/api/ai/persona-alignment/route.ts`
	- `web/app/api/ai/prep-package/route.ts`
	- `web/app/api/ai/outreach/route.ts`
- Updated logs on provider failure to record `creditsDeducted: 0` because debit is no longer performed before AI generation.
- Hardened webhook integrity in `web/app/api/billing/webhook/route.ts`:
	- added Stripe event-level idempotency tracking via `processed_stripe_events`
	- persist `stripePaymentIntentId` on top-up logs
	- refund correlation now resolves via payment-intent first, with legacy fallback.

### Decision
- Keep live-session reserve/settle model unchanged for latency-safe billing.
- Standardize one-shot AI charging semantics to remove charge-on-provider-failure behavior drift.
- Treat Stripe event idempotency as mandatory for migration-safe billing writes.

### Validation
- `npm run test:web:api -- web/test/lib/billing.spec.ts web/test/api/ai/gap-analysis.spec.ts web/test/api/ai/persona-alignment.spec.ts web/test/api/ai/prep-package.spec.ts web/test/api/ai/outreach.spec.ts` ✅

### Intel route: intentionally deferred from Phase 1

The `/api/ai/intel` route was not migrated to the `ensureSufficientCredits` + `deductCredits` helper pattern in Phase 1. Rationale:

- Intel's billing path is architecturally different: it uses a Firestore transaction that combines trial-wallet logic (`withTrialWalletCharge`, `rollTrialWalletWindow`) with paid-credit deduction inline. The new shared billing helpers in `web/lib/resume-builder/billing.ts` have no trial-wallet awareness and cannot be dropped in without a more invasive refactor.
- The intel route already implements debit-on-success semantics inline (affordability check before AI call, deduction inside a Firestore transaction after response validation). There is no correctness regression.
- A dedicated Phase 2 slice will align intel with the shared billing helpers once trial-wallet integration is resolved.

Scope gates for intel migration (Phase 2):
- Add trial-wallet support to `ensureSufficientCredits` / `deductCredits` or create a `deductCreditsWithTrial` variant.
- Add `web/test/api/ai/intel.spec.ts` covering affordability gate, AI failure, and debit success paths.

## 2026-04-04 — Dex — Workspace AI Governance Bootstrap (Phase 1)

Implemented the first execution slice of the DIWA workspace-only AI governance layer.

### Scope completed
- Added guardrails agent profile at `.github/agents/agency-diwa-guardrails.agent.md` to enforce non-negotiable security, architecture, parity, and release constraints.
- Added governance documentation bundle under `docs/agency-agents/`:
	- `README.md`
	- `ADAPTATION_LAYER.md`
	- `curated-diwa-copilot.json`
- Added governance scripts:
	- `scripts/install-agency-curated.cjs`
	- `scripts/validate-agency-structure.cjs`
	- `scripts/validate-agency-consistency.cjs`
- Wired scripts into `package.json` and extended `verify:ci` with agency validation checks.

### Decision
- Governance is enforced at workspace scope only and does not install global/user-profile agents.
- Agency validation is now an executable part of CI readiness rather than documentation-only intent.

### Validation
- `npm run agency:validate:structure` ✅
- `npm run agency:validate:consistency` ✅
- `npm run agents:install:curated:copilot` ✅

## 2026-03-23 — Dex — Electron Shell Token Migration Started

Started the first implementation slice for the Electron token migration by normalizing core shell-adjacent surfaces to the canonical Noir token contract instead of introducing new Electron-specific aliases.

### Scope completed
- Updated [src/App.css](src/App.css) shell rules to consume existing semantic tokens for:
	- sidebar divider highlight
	- sidebar toggle shadow
	- logo glow
	- active nav treatment
	- loading state surface + spinner
	- shortcuts modal surface
	- session follow-up CTA hover/active states
- Updated [src/components/ui/UpdateRequiredModal.css](src/components/ui/UpdateRequiredModal.css) to use canonical overlay, text, radius, shadow, and CTA tokens.
- Updated [src/components/WlcProvisionWizard.module.css](src/components/WlcProvisionWizard.module.css) to use the global app token layer for background, card, text, success, and action states.

### Decision
- Do **not** add new design-system tokens or Electron-only aliases unless the same value clearly recurs across multiple shell/page surfaces.
- For this slice, the existing token contract in `styles/noir.tokens.css` was sufficient; the right move was migration of Electron CSS, not token expansion.
- Keep overlay-specific tokens isolated for future work; this pass intentionally excluded `Overlay.css` and `Teleprompter.css`.

### Validation
- `npm run ui:consistency:check` ✅
- `npm run ui:token-parity:check` ✅
- `npm run typecheck` ✅

### Follow-up slice completed same day
- Updated [src/components/overlay/Overlay.css](src/components/overlay/Overlay.css) to replace shell-adjacent hard-coded overlay translucency and fallback warning styling with canonical tokens or token-derived `color-mix(...)` values.
- Updated [src/components/overlay/Teleprompter.css](src/components/overlay/Teleprompter.css) to align HUD cards, question surfaces, scrollbars, and status states with the overlay token namespace and core semantic colors.
- Updated [src/components/dashboard/DashboardTab.css](src/components/dashboard/DashboardTab.css) to remove hard-coded live, mock, and info accent colors in favor of semantic tokens and token-derived gradients.

### Additional decision
- Overlay retains a protected visual namespace: where translucency is unique to the floating HUD, prefer token-derived `color-mix(...)` expressions over introducing generic app-shell aliases.
- Dashboard accent variants can derive from canonical accent, purple, and blue tokens without adding a new dashboard-only token layer yet.

### Sequential follow-up completed
- Swept remaining shell-adjacent UI utility surfaces:
	- [src/components/ui/CreditBadge.css](src/components/ui/CreditBadge.css)
	- [src/components/ui/SyncIndicator.css](src/components/ui/SyncIndicator.css)
- Completed a first feature-heavy pass across:
	- [src/components/tracker/Tracker.css](src/components/tracker/Tracker.css)
	- [src/components/mockInterview/FeedbackPanel.css](src/components/mockInterview/FeedbackPanel.css)
	- [src/components/settings/PersonaManager.css](src/components/settings/PersonaManager.css)
	- [src/components/settings/FileManager.css](src/components/settings/FileManager.css)

### Additional decision
- The remaining feature surfaces still contain token drift, but the migration should continue in focused slices by surface family rather than via a repo-wide replacement pass.
- For settings and content cards, repeated glass-card patterns can continue using token-derived gradients until a shared app-card abstraction is deliberately introduced.

### Mock interview slice completed
- Updated [src/components/mockInterview/IntelEnginePanel.css](src/components/mockInterview/IntelEnginePanel.css) to align error surfaces with semantic danger tokens.
- Updated [src/components/mockInterview/InterviewProgress.css](src/components/mockInterview/InterviewProgress.css) to replace local accent and danger values in session controls and progress indicators.
- Updated [src/components/mockInterview/LiveTranscriptDisplay.css](src/components/mockInterview/LiveTranscriptDisplay.css) to use token-derived recording state borders.
- Updated [src/components/mockInterview/MockInterviewContainer.css](src/components/mockInterview/MockInterviewContainer.css) to derive the question display glass/accent treatment from canonical tokens.
- Updated [src/components/mockInterview/SessionHistory.css](src/components/mockInterview/SessionHistory.css) and [src/components/mockInterview/SessionSummary.css](src/components/mockInterview/SessionSummary.css) to normalize card emphasis, rating focus states, and recap badges.
- Updated [src/components/mockInterview/SetupPanel.css](src/components/mockInterview/SetupPanel.css) to replace selected-state and context-note hard-coded surfaces.

### Settings slice completed
- Updated [src/components/settings/AudioSettings.css](src/components/settings/AudioSettings.css) to normalize glass-card surfaces and warning banners.
- Updated [src/components/settings/OutputDeviceSelector.css](src/components/settings/OutputDeviceSelector.css) to replace remaining accent/success gradient drift with token-derived surfaces.
- Updated [src/components/settings/PromptDesigner.css](src/components/settings/PromptDesigner.css) to normalize panel backgrounds and accent focus rings.
- Updated [src/components/settings/ScreenRecordingSetup.css](src/components/settings/ScreenRecordingSetup.css) to align the overlay and modal surfaces with canonical overlay and elevated tokens.
- Updated [src/components/settings/SettingsView.css](src/components/settings/SettingsView.css) and [src/components/settings/VUMeter.css](src/components/settings/VUMeter.css) to remove the remaining local danger and marker color values.

### Mock interview cleanup completed
- Updated [src/components/mockInterview/MockInterviewContainer.css](src/components/mockInterview/MockInterviewContainer.css) to replace the final warning-banner and sidebar/toast shadow drift with token-derived values.
- Result: the mock interview CSS family no longer reports hard-coded hex or rgba token-drift matches in the audit sweep used for this migration.

## 2026-02-28 — Dex — Cloud Run Deployment: Root Causes Resolved

Web app successfully deployed to Cloud Run. Build was failing across 13 attempts due to 3 separate root causes (each masked the next):

### Operator runbook (future triage)

Symptoms
- Cloud Run build fails during Next.js server bundle evaluation.
- Errors may mention unresolved shared imports, missing Firebase client SDK, or Stripe/auth initialization at module load.

Root cause
- Multiple independent startup/build-time hazards were present and surfaced sequentially:
	- path alias and workspace copy mismatch for shared imports
	- missing `firebase` dependency in web runtime
	- module-scope initialization requiring runtime-only secrets (`firebase-admin`, Stripe)
	- Next.js 16 Turbopack build behavior evaluating server modules earlier than expected

Fix
- Ensure `web/` Docker context includes `shared/` with matching TS path alias resolution.
- Keep `firebase` installed in `web/package.json`.
- Move runtime-secret-dependent initialization inside request handlers/function bodies.
- Force webpack build path in web app build script (`next build --webpack`).

Verification commands
```bash
# 1) Verify build mode and bundle behavior
npm --prefix web run build

# 2) Validate static analysis gates before deploy
npm run lint
npm --prefix web run typecheck

# 3) Guard against module-scope Stripe init regressions
rg "new Stripe\(" web/app/api

# 4) Guard against module-scope firebase-admin eager initialization patterns
rg "from 'firebase-admin'|from \"firebase-admin\"" web/lib web/app/api
```

### Fixes Applied (all committed on main)

1. **`@shared` path alias** — Dockerfile now sets `WORKDIR /app/web`, copies `shared/` inside it, and `web/tsconfig.json` has `"baseUrl": "."` + `"./shared/*"` as first alias option.

2. **`firebase` client SDK missing** — Added `firebase: ^12.10.0` to `web/package.json`.

3. **Firebase Admin throws at build time** — `web/lib/firebase-admin.ts` rewritten as a lazy Proxy (only `import type` at top level; all `require()` calls inside function bodies). All 48 API routes have `export const dynamic = 'force-dynamic'`.

4. **Next.js 16 defaults Turbopack for `next build`** — Turbopack creates a `[root-of-the-server]` shared chunk that evaluates ALL server module-level code at build time. Fixed by adding `--webpack` flag: `"build": "next build --webpack"` in `web/package.json`.

5. **`new Stripe('')` throws at module load** — `new Stripe(process.env.STRIPE_SECRET_KEY || '')` at module level (in `billing/checkout/route.ts` and `billing/webhook/route.ts`) throws `"Neither apiKey nor config.authenticator provided"` when `STRIPE_SECRET_KEY` is absent (it's a runtime secret, not a build-time env var). Fixed by moving instantiation inside the handler/POST functions.

### Service URL
`https://diwa-web-399838595429.europe-west1.run.app`

> **Note**: Custom domain (`app.diwacopilot.com`) not yet mapped — DNS needs to be pointed to this Cloud Run service URL. Update `NEXT_PUBLIC_API_BASE_URL` env var in Electron/landing apps when the custom domain is active.



Decoupled window switching from session teardown so users can move between the overlay and main window mid-session without stopping the live interview.

### Problem
- `ui:show-main` closed the overlay window.
- Overlay close emitted `overlay-closed`, and `useLiveSession` handled that event by calling `handleStop()`.
- Result: switching to the main window unexpectedly ended an active live session.

### Decision
- Keep the overlay window alive during normal surface switching.
- Use hide/show behavior for toggles instead of closing the overlay window.
- Reserve actual overlay close for explicit close paths only.

### Implementation
- Updated `electron/main.ts`:
	- `ui:show-main` now hides overlay (`overlayWindow.hide()`) instead of `closeOverlayWindow()`.
	- `smartWindowFocusToggle()` now hides overlay when switching to main and shows overlay when switching back.
	- Tracks `isOverlayVisible` consistently across toggle directions.

### Outcome
- Users can toggle between main and overlay during a live session without forced stop.
- `overlay-closed` no longer fires during normal window switches, so live session ownership in `useLiveSession` remains intact.

## 2026-02-26 — Dex — Live Interview Cleanup Pass (Dead Code + Contract Hardening)

Cleaned the Live Interview domain starting from `LiveSessionView`/`OverlayView` and related runtime files.

### Removed legacy/unused paths
- Removed legacy `ai-response` channel end-to-end (preload, main forwarding, overlay listener, session sender, types, mocks).
- Removed unused overlay APIs `resize-overlay` / `set-overlay-mode` (main handlers + preload bridge + TS types + mocks).
- Removed obsolete teleprompter selectors from `Overlay.css` (owned by `Teleprompter.css`).
- Removed HUD debug console logging from `Teleprompter.tsx`.

### Ownership and contract cleanup
- Enforced strict Electron runtime usage in overlay/main live-interview surfaces (removed local no-API fallbacks).
- Centralized clear/reset authority in `useLiveSession` by emitting canonical empty payloads (`chat-history`, `interim-text`, `ai-status`) when clear command is processed.
- Simplified `LiveSessionControls` by removing unused `activeSttSource` from the public interface.
- Added missing preload methods for screen-recording status/settings to keep runtime and type contracts aligned.

### Test updates
- Updated `OverlayView` tests to validate canonical clear payload behavior.
- Removed obsolete "No Electron API fallback" test suite after strict-runtime decision.
- Updated test mocks/types to match the cleaned IPC contract.

### Validation
- `npm run lint` ✅
- `npx tsc --noEmit` ✅
- `npx vitest run src/test/components/overlay/OverlayView.test.tsx` ✅
- `npm run build` ✅

---

## 2026-02-21 — Molty — Shared SupportWidget Architecture

Created fully shared support UI components in `shared/components/support/`:
- `SupportWidget.tsx`, `ChatTab.tsx`, `ArticlesTab.tsx`, `ContactFeedbackTab.tsx`
- `articles.ts` (17 help articles, 6 categories), `types.ts`, `index.ts`
- **~900 lines of duplicate code eliminated**

Platform-specific wrappers:
- Web: `web/components/support/SupportWidget.tsx` (~100 LOC)
- Electron: `src/components/support/SupportWidget.tsx` (~100 LOC)

Wrappers inject: `apiBaseUrl`, auth, styles, icons, `ReactMarkdown`.

**Rule: Never modify shared support components in platform-specific folders** — edit `shared/components/support/` and test both platforms.

---

## 2026-02-21 — Molty — Tracker Architecture: NOT Shared

Application Tracker is **NOT shared** between web and Electron:
- Web: `web/app/dashboard/tracker/tracker-client.tsx`
- Electron: `src/components/tracker/TrackerView.tsx`

Each platform has its own:
- API calls (no shared hooks)
- State management (local)
- Styling (separate CSS)
- Drag-and-drop implementation (`@dnd-kit/core` with `DragOverlay`)

**Rule: Do NOT create shared tracker components or hooks** — platforms optimize independently.

---

## 2026-02-21 — Molty — Platform Expansion Roadmap

Created `docs/roadmap/2026-platform-expansion-roadmap.md` with 5 epics:
1. **Interview Tracker** (Q1, RICE 27.0)
2. **Resume Builder** (Q1, RICE 24.0)
3. **Community Knowledge Base** (Q2, RICE 20.0)
4. **Salary Insights** (Q2, RICE 16.0)

## 2026-04-16 — Dex — KB Canonicalization And Live Start Sync

Implemented a targeted reliability pass across the KB pipeline and Electron live-session start flow.

### Scope completed
- Reworked `web/lib/live-interview-kb-match.ts` to support large instructions, escaped knowledge tags, multiline answers, and per-section loose fallback parsing.
- Added `web/lib/kb-auto-format.ts` for deterministic-first KB canonicalization with AI retry fallback.
- Updated `web/app/api/documents/route.ts` so `knowledge` documents are normalized on upload, with bounded AI formatting and safe raw fallback when formatting fails.
- Updated Electron live-session launch flow so `SessionSetupCard` passes the freshly selected document instruction immediately, and `LiveSessionView` only opens the overlay after `handleStart` succeeds.

### Decision
- Stored `knowledge` document content may differ from the raw uploaded text because the canonical representation is now the preferred persistence format.
- AI formatting is best-effort only. Upload must still succeed when AI formatting fails, times out, or is skipped due to size limits.
- The setup-card launch path is authoritative for the first session start after a document selection change; it should not wait for store re-render before building the system instruction.

### Validation
- `npm run test:web:api -- web/test/lib/kb-auto-format.spec.ts web/test/api/documents.route.spec.ts web/test/lib/live-interview-kb-match.spec.ts` ✅
5. **Job Board** (H2, RICE 12.0)

24 GitHub issues created (#42-65) with labels per epic and phase.

---

## 2026-02-21 — Molty — Agent Team Established

| Agent | Type | Scope |
|-------|------|-------|
| **Molty** | OpenClaw (persistent) | Orchestration, roadmap, cross-agent coordination |
| **Dex** | GitHub Copilot (in-editor) | Implementation, debugging, refactoring |
| **Diwa PO** | OpenClaw subagent | Product strategy, backlog, user stories |
| **Diwa Web** | OpenClaw subagent | Next.js web panel + API routes |
| **Diwa App** | OpenClaw subagent | Electron desktop app |

---

## 2026-02-21 — Dex — Sign-in Loop Part 2: Expired Cookie Token

Firebase ID tokens expire after 1h but the `firebase_token` cookie lasts 24h. When the token inside the cookie expired, `dashboard/page.tsx` `verifyAuthToken()` threw → redirected to `/auth/signin` → middleware saw the cookie was still present → redirected back to `/dashboard` → loop.

Fix: Created `GET /api/auth/clear` route that expires the cookie and redirects to `/auth/signin`. Middleware excludes `/api/*` so this cleanly breaks the loop. `dashboard/page.tsx` catch block now redirects to `/api/auth/clear` instead of `/auth/signin` directly.

---

## 2026-02-21 — Dex — Sign-in Infinite Reload Bug Fixed

`web/app/auth/signin/signin-content.tsx` `useEffect` was redirecting to `/dashboard` whenever `localStorage` had a `firebase_token`. If the cookie was expired/missing, middleware bounced back to `/auth/signin`, creating an infinite reload loop. Fixed by replacing the redirect with a stale-token cleanup instead — middleware already handles redirecting valid sessions away from the sign-in page.

---

## 2026-02-21 — Dex — Accuracy Audit: Code Bugs Fixed

Found and fixed 4 runtime bugs during prompt accuracy audit:
- `src/hooks/useCredits.ts` — was reading `data.user.credits.balance` but `GET /api/user/me` returns flat; fixed to `data.credits.balance`
- `src/lib/api-client.ts` — type annotations `{ user: UserProfile }` didn't match flat runtime response; fixed to `UserProfile`
- `src/store/user-store.ts` — `credits: number` interface was wrong (it's an object); fixed + removed bogus `?fields=credits` query param
- `src/components/ui/CreditBadge.tsx` — rendered `profile.credits` (object) directly, showing `[object Object]`; fixed to `profile.credits?.balance ?? 0`

---

## 2026-02-21 — Dex — Accuracy Audit: Prompt Corrections

Fixed critical inaccuracies across all four prompt files:
- `web_dev_prompt.md` Rule #5: reversed (was "must NOT be in serverExternalPackages" — exact opposite of reality)
- `electron_dev_prompt.md`: React 18 → 19, flat API return shape documented, beta expiry location corrected (both main + renderer), ~25 missing `window.electronAPI` methods added, audio sidecar + updater IPC documented
- `copilot-instructions.md`: `@opentelemetry/api` corrected to direct dependency, Rule #14 flat response path fixed, Rule #16 IPC call corrected

---

## 2026-02-23 — Dex — Critical Startup/Auth Guard Fixes

Resolved two production blockers in Electron startup flow:
- Restored native startup splash lifecycle in `electron/main.ts` by creating `splashWindow` from `electron/splash.html`, then gating main-window reveal with launch state (`isMainReady` + `isUpdaterReady`) via `tryLaunchApp()`.
- Rewired updater initialization to target splash + main windows (`initializeUpdater(splashWindow, mainWindow)`), while keeping fail-open behavior for non-packaged/dev (`isUpdaterReady = true`).
- Fixed AuthGuard loading trap in `src/components/auth/AuthGate.tsx`: splash dismissal now allows signed-out completion path (`401` → Firebase sign-out) so unauthenticated users reach `AuthView` instead of being stuck behind loading overlay.
- Kept `401` semantics strict: unauthorized bootstrap responses are treated as signed-out UX, not service-unavailable.

---

## 2026-02-23 — Dex — Live Interview Prompt Ownership Moved Backend-Side

Moved live interview system prompt ownership and turn-gating policy into the web backend service layer.

- Added centralized helper `web/lib/live-interview-policy.ts`.
	- Builds live base prompt server-side.
	- Loads optional policy overrides from `app_config/live_interview_policy` (cached 5 minutes).
	- Applies transcript gating (`shouldRespondToLiveTurn`) so filler/non-question turns produce no AI answer.
- Updated `web/app/api/ai/live-interview/respond/route.ts`.
	- Uses backend-built prompt.
	- Short-circuits with empty SSE completion for non-question/filler turns.
- Updated `web/app/api/ai/mock-interview/chat/route.ts`.
	- Replaced hardcoded live prompt branch with backend helper.
	- Added same non-question/filler short-circuit for consistency.
- Kept Electron payload as context-only input (`session.startSession(..., systemInstruction)`), while backend now owns live prompt policy.

This keeps policy centralized, configurable, and enforceable regardless of renderer/client behavior.

---

## 2026-02-23 — Dex — Purpose-Named AI Route Paths

Renamed generic AI route paths to purpose-specific, developer-friendly endpoints and rewired Electron callers.

- Renamed mock interview endpoint from `POST /api/ai/chat` to `POST /api/ai/mock-interview/chat`.
- Renamed live streaming endpoint from `POST /api/ai/respond-from-text` to `POST /api/ai/live-interview/respond`.
- Updated client endpoint constants and runtime callers:
	- `src/config/endpoints.ts`
	- `src/lib/api-client.ts`
	- `src/hooks/useAssemblyAIRealtime.ts`
- Added strict session-type guards in each new route to prevent cross-purpose misuse.

---

## 2026-02-23 — Dex — Live Policy Uses Persona-Defined Response Format

Updated the default live interview base prompt in `web/lib/live-interview-policy.ts` to remove fixed output formatting (`2-4 bullet points`) and defer response format/style to user persona/context instructions.

- New rule: match the format/style defined in candidate persona/context (e.g., STAR narrative, bullets, concise paragraph).
- Fallback when persona has no explicit format: keep response concise and direct.

This ensures live answers respect user-entered persona preferences instead of a hardcoded response shape.

Follow-up hardening:
- `web/lib/live-interview-policy.ts` now explicitly extracts the `RESPONSE STYLE:` block from the session instruction and injects it as a dedicated `RESPONSE FORMAT (FROM USER PERSONA)` section in the live system prompt.
- This makes persona-defined output format (e.g., STAR, bullets, concise paragraph) explicit in backend policy, instead of relying only on generic candidate context parsing.
- Added explicit persona "soul" anchoring in backend prompt construction:
	- Extracts `Persona: ...` as `CANDIDATE PERSONA (PRIMARY VOICE ANCHOR)`.
	- Extracts `<candidate_profile>...</candidate_profile>` as `CANDIDATE BACKGROUND (PRIMARY FACT ANCHOR)`.
	- Ensures live answers consistently follow the user's personality/background as the primary response identity.

Latency optimization follow-up for live responses:
- Removed full raw `sessionSystemInstruction` injection on every turn (major token reduction).
- Prompt now includes compact structured sections only (persona identity, response style, candidate profile snapshot, job description snapshot).
- `live-interview/respond` now sends only a recent conversation window (`MAX_LIVE_HISTORY_MESSAGES = 12`) instead of full session history.
- Added stage timing logs (`sessionLookup`, `historyLookup`, `historyCount`) to benchmark improvements turn-by-turn.

---

## 2026-02-27 — Dex — Live Respond Trigger Refinement (Idle-Gated Dispatch)

Implemented realtime hook refinement to dispatch `/api/ai/live-interview/respond` only when transcription is idle and no other AI request is in-flight.

### Decision
- Replace fixed 2s debounce with an idle transcription gate to reduce unnecessary delay while still preventing fragmented/multiple turn dispatches.
- Keep force-flush semantics on stream termination/disconnect so final pending text is not dropped.

### Implementation
- Updated `src/hooks/useAssemblyAIRealtime.ts`:
	- Removed `AI_DEBOUNCE_MS` fixed-delay model.
	- Added `TRANSCRIPTION_IDLE_MS = 350`.
	- Added refs for:
		- `lastInterimAtRef` (tracks most recent interim activity)
		- `isAiInFlightRef` (single in-flight request guard)
		- `tryDispatchPendingRef` (centralized dispatch gate)
	- Interim `Turn` messages now update `lastInterimAtRef` and clear pending dispatch timers.
	- Final `end_of_turn` messages append to pending buffer and dispatch only when idle-window + in-flight checks pass.
	- `Termination` and `disconnect` force flush pending transcript immediately.
	- Fixed WebSocket send typing by sending concrete `ArrayBuffer` slices.

### Validation
- `npm run build` ✅
- `npm run verify:ci` ✅ (39/39 files, 894/894 tests)

## 2026-02-27 — Dex — Live Interview Respond Fix (Gemini History Role Validation)

Fixed a runtime 500 on `/api/ai/live-interview/respond` where Gemini rejected chat history if the first message role was `model`.

### Issue
- Error: `First content should be with role 'user', got model`.
- Caused by truncated recent-conversation windows that could begin with an assistant/model turn.

### Fix
- Updated `web/app/api/ai/live-interview/respond/route.ts`:
	- Added `normalizeChatHistory(...)`.
	- Removes empty/invalid history entries.
	- Drops leading `model` turns until the first entry is `user`.
	- Uses normalized history for `chatModel.startChat(...)`.

### Validation
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 3d Runtime Safety (Corrupted Store Recovery)

Added startup resilience for Electron local secure-store corruption to prevent app boot crashes on malformed persisted JSON.

### Issue
- Dev smoke test exposed startup crash path in `electron/services/secure-store.ts` when `electron-store` encountered invalid JSON in persisted config files.

### Fix
- Updated `electron/services/secure-store.ts`:
	- Enabled `clearInvalidConfig: true` for both:
		- `diwa-secure-meta` store
		- `diwa-secure` store

### Validation
- `npm run build` ✅
- `npm run dev` boots Electron process and main window successfully (startup no longer crashes on corrupted secure-store payload).

## 2026-02-27 — Dex — Phase 3c Connection Hardening (Regression Lock)

Ran full `verify:ci` after the renderer transport sweep and fixed the only regression surfaced in unit tests.

### Issue
- `src/test/lib/transcription-service.test.ts` failed after transport centralization because the Firebase test mock did not export `authReady`, now required by `apiFetch` header pipeline.

### Fix
- Updated `src/test/mocks/firebase-mock.ts` to export:
	- `authReady: Promise.resolve()`

### Validation
- `npm run verify:ci` ✅
	- 39/39 test files passed
	- 894/894 tests passed

## 2026-02-27 — Dex — Phase 3b Connection Hardening (Renderer Transport Sweep)

Completed a regression-safe sweep of remaining renderer-side direct backend calls in tracker/resume surfaces, moving them onto centralized transport (`apiFetch`) while preserving existing UX flow.

### Decision
- Eliminate remaining manual Bearer-header `fetch` usage in renderer components for internal `/api/*` calls.
- Keep existing behavior (refresh patterns, error handling) intact to minimize regression risk.

### Implementation
- Updated `src/components/tracker/ApplicationDrawer.tsx`:
	- Replaced manual `PATCH`/`DELETE` fetch calls with `applicationsApi.update(...)` / `applicationsApi.delete(...)`.
	- Removed direct Firebase token handling from drawer mutations.
- Updated `src/components/tracker/TrackerView.tsx`:
	- Replaced manual `POST` and export list `GET` fetch calls with `apiFetch(...)` to the same backend endpoints.
	- Kept existing refresh and analytics flow unchanged.
- Updated `src/components/resume/ResumeBuilder.tsx`:
	- Replaced manual CV document fetch (`/api/documents`) with `apiFetch(...)` for existing-CV import mode.

### Validation
- `npm run build` ✅
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 3 Connection Hardening (Electron Transport Discipline)

Hardened Electron renderer → backend transport paths by removing risky production fallback behavior and migrating key manual-fetch callsites to centralized transport helpers.

### Decision
- Electron API calls should flow through a single transport layer that always injects `X-App-Version` and (when required) Firebase Bearer auth.
- Production endpoint fallback must never default to localhost.
- Streaming/non-JSON paths can use a raw transport helper, but still must pass through centralized header/auth logic.

### Implementation
- Updated `src/config/endpoints.ts`:
	- Production default `API_BASE` changed from `http://localhost:3000` to `https://diwacopilot.com`.
- Updated `src/lib/api.ts`:
	- Added shared header builder.
	- Added `apiFetchRaw(...)` for streaming/non-JSON needs while preserving centralized auth/version headers.
	- Refactored `apiFetch(...)` to use `apiFetchRaw(...)`.
- Updated callsites to remove manual auth-header fetches:
	- `src/store/applications-store.ts` analytics fetch now uses `apiFetch(...)`.
	- `src/store/documents-store.ts` upload/add-content now use `apiFetch(...)`.
	- `src/hooks/useAssemblyAIRealtime.ts` token request now uses `apiFetch(...)`.
	- `src/lib/live-interview-respond-stream.ts` now uses `apiFetchRaw(...)` for SSE stream.
	- `src/lib/transcription-service.ts` now uses `apiFetch(...)` for transcription.
	- `src/lib/version-check.ts` now uses `apiFetch(..., { skipAuth: true })`.
	- `src/lib/api-client.ts` `fetchPublicRates()` now uses `apiFetch(..., { skipAuth: true })`.

### Validation
- `npm run build` ✅
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 2e Connection Hardening (Shared Request Validation)

Added a shared request-validation utility and applied it to high-risk write endpoints to enforce object payload shape, key allowlists, and typed field constraints consistently.

### Decision
- Repeated ad-hoc JSON parsing/validation in write routes should be centralized in a small utility layer to reduce drift and weak spots.
- Initial application targets are support write endpoints and billing checkout where malformed payloads have high abuse potential.

### Implementation
- Added `web/lib/request-validation.ts`:
	- `readJsonObject`, `isObjectLike`
	- `hasOnlyAllowedKeys`
	- typed field readers (`readRequiredString`, `readOptionalString`, `readOptionalBoolean`, `readOptionalEnum`)
	- `badRequest(...)` helper.
- Updated `web/app/api/support/chat/route.ts`:
	- Enforced object payload + allowlist (`message`) + bounded message length.
- Updated `web/app/api/support/feedback/route.ts`:
	- Enforced object payload + allowlist + typed constraints for title/description/type/wantsResponse/email.
	- Enforced email presence/format check when `wantsResponse` is true.
- Updated `web/app/api/support/ticket/route.ts`:
	- Enforced object payload + allowlist + typed constraints for subject/description/type/priority enum.
- Updated `web/app/api/billing/checkout/route.ts`:
	- Enforced object payload + allowlist (`packId`) + `packId` format validation.

### Validation
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 2d Connection Hardening (CORS + Webhook Surface)

Hardened edge controls by making CORS fail closed for untrusted browser origins and consolidating Stripe webhook behavior to a single canonical implementation.

### Decision
- CORS should not return wildcard `Access-Control-Allow-Origin` for unknown origins on auth-bearing API routes.
- Keep one canonical Stripe webhook implementation (`/api/billing/webhook`) and retain `/api/webhooks/stripe` as backward-compatible alias only.

### Implementation
- Updated `web/lib/cors-utils.ts`:
	- Added staging host allowlist entry: `https://staging-diwa-ai-copilot.web.app`.
	- Added `Vary: Origin` on all CORS header responses.
	- Requests with no `Origin` now return minimal headers (`Vary` only).
	- Non-whitelisted origins no longer receive `Access-Control-Allow-Origin: *`.
- Updated `web/app/api/webhooks/stripe/route.ts`:
	- Replaced duplicate handler logic with thin alias to canonical `POST` in `/api/billing/webhook`.

### Validation
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 2c Connection Hardening (Admin Users Route Hardening)

Extended the panel/backend hardening to `admin/users` APIs with centralized admin auth enforcement, stricter mutation schema validation, and migration to active `context_docs` reads/writes.

### Decision
- Admin user-management endpoints should share the same `withAdminAuth(...)` contract as other admin mutation routes.
- Admin mutation payloads must use explicit allowlists and typed validation to reduce mass-assignment and malformed-body risks.
- Admin document counts/deletes should use `context_docs/{uid}/documents` (active schema).

### Implementation
- Updated `web/app/api/admin/users/route.ts`:
	- Migrated `GET` auth from `verifyAdmin(...)` to `withAdminAuth(...)` wrapper.
- Updated `web/app/api/admin/users/[uid]/route.ts`:
	- Migrated `GET/PATCH/DELETE` auth path to `withAdminAuth(...)`.
	- Added body-object checks and top-level field allowlist for `PATCH`.
	- Added typed validation for `reason`, `tier`, `role`, `action`, and numeric credit ops.
	- Added explicit “no valid update fields” rejection for empty updates.
	- Added body-object + reason validation for `DELETE`.
	- Migrated document count/delete usage to `context_docs/{uid}/documents`.
	- Added safer timestamp formatting helper for mixed timestamp shapes.

### Validation
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 2b Connection Hardening (Centralized Admin Wrapper)

Extended Phase 2 by centralizing admin mutation authorization in `auth-middleware` and migrating admin config routes to the shared wrapper.

### Decision
- Admin mutation routes should use a shared `withAdminAuth(...)` wrapper layered on `withAuth(...)` to enforce identical token/version/CORS/auth semantics.
- Keep public admin config `GET` endpoints unchanged while hardening `PUT` operations.

### Implementation
- Updated `web/lib/auth-middleware.ts`:
	- Added `withAdminAuth(handler)` that reuses `withAuth(...)` and checks Firestore admin status (`role === 'admin'` OR `isAdmin === true`).
- Updated `web/app/api/admin/pricing/route.ts`:
	- Migrated `PUT` to `withAdminAuth(...)` (removed inline `verifyAdminToken` checks).
- Updated `web/app/api/admin/referral/route.ts`:
	- Migrated `PUT` to `withAdminAuth(...)` (removed inline `verifyAdminToken` checks).
- Updated `web/app/api/user/me/route.ts`:
	- Preserved new-user hydration/backfill behavior by deriving bearer claims for initial profile/email fields.

### Validation
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 2 Connection Hardening (Guard Consistency + Input Validation)

Implemented a focused Phase 2 slice to reduce auth/admin divergence and tighten mutation payload validation on sensitive panel/backend routes.

### Decision
- Admin authorization should be consistent across guard paths (`role: admin` OR `isAdmin: true`).
- User profile writes should use shared auth middleware and strict field allowlists to reduce mass-assignment risk.
- Admin referral config updates should reject unknown fields and invalid numeric ranges before persistence.

### Implementation
- Updated `web/lib/admin-guard.ts`:
	- `verifyAdmin()` now accepts either `role === 'admin'` or `isAdmin === true`.
	- `isUserAdmin()` now follows the same dual-check logic.
- Updated `web/app/api/user/me/route.ts`:
	- Switched GET/PATCH auth flow to `withAuth(...)` wrappers.
	- Added strict PATCH payload validation:
		- top-level allowlist (`displayName`, `preferences`, `onboarding`)
		- `displayName` string and length checks
		- object checks for `preferences`/`onboarding`
		- string-array checks for onboarding subfields.
- Updated `web/app/api/admin/referral/route.ts`:
	- Added payload object validation and unknown-key rejection.
	- Added type/range validation for numeric fields and bounds on `purchaseCommissionPct`.
	- Added consistency check to prevent `monthlyCapCredits > lifetimeCapCredits`.

### Validation
- `npm --prefix web run build` ✅

## 2026-02-27 — Dex — Phase 1 Connection Hardening (Session Trust Boundary)

Started Phase 1 hardening for User/Admin panel ↔ backend trust boundaries by tightening session cookie issuance and middleware token validity checks.

### Decision
- `POST /api/auth/session` must verify Firebase ID tokens server-side before writing any `firebase_token` cookie.
- Middleware should treat malformed/expired cookie tokens as unauthenticated and clear stale cookies on protected-route access attempts.
- Cookie lifetime should track token lifetime (capped at 24h) instead of always using a fixed 24h value.

### Implementation
- Updated `web/app/api/auth/session/route.ts`:
	- Added server-side `verifyAuthToken(token)` before cookie issuance.
	- Rejects expired token submissions with `401`.
	- Sets `maxAge` to remaining token lifetime (`exp - now`, capped to 24h).
- Updated `web/middleware.ts`:
	- Added JWT payload parse/expiry check for `firebase_token`.
	- Uses `hasValidToken` (not cookie presence) for protected/auth route decisions.
	- Clears invalid/stale `firebase_token` when redirecting/rewriting protected route access.

### Validation
- `npm --prefix web run build` ✅

*Add new entries above this line.*

## 2026-02-26 — Dex — Windows Packaging Locale Trim (Electron + NSIS)

Reduced Windows installer/app bloat caused by default Electron/NSIS multi-language packaging.

### Decision
- Ship Windows runtime locale resources as English-only for now.
- Ship NSIS installer language as English-only for now.

### Implementation
- Updated `package.json` build config:
	- `build.win.electronLanguages = ["en-US"]`
	- `build.nsis.multiLanguageInstaller = false`
	- `build.nsis.installerLanguages = ["en_US"]`

### Rationale
- Electron-builder defaults include all Electron locale packs unless explicitly constrained.
- This keeps behavior aligned with current product language policy while reducing packaged size.

## 2026-02-26 — Dex — Live Interview Cleanup Phase 2 (SSE Dedupe + Scoped IPC Cleanup)

Continued the live interview cleanup pass with two structural refactors focused on maintainability and listener lifecycle safety.

### Decision
- Consolidate duplicate live-response SSE streaming logic into one shared utility used by both STT drivers.
- Replace broad `removeAllListeners(...)` cleanup in renderer hooks/components with scoped unsubscribe callbacks returned by preload listener APIs.

### Implementation
- Added shared stream helper:
	- `src/lib/live-interview-respond-stream.ts`
- Refactored both STT hooks to use the shared helper:
	- `src/hooks/useWindowsLiveCaptions.ts`
	- `src/hooks/useAssemblyAIRealtime.ts`
- Updated preload listener APIs to return unsubscribe functions:
	- `electron/preload.cjs`
- Migrated consumers to scoped cleanup:
	- `src/components/overlay/OverlayView.tsx`
	- `src/hooks/useLiveSession.ts`
- Synced TS contract types:
	- `src/types/electron.d.ts`

### Validation
- `npm run lint` ✅
- `npx tsc --noEmit` ✅
- `npx vitest run src/test/components/overlay/OverlayView.test.tsx` ✅ (54/54)
- `npm run build` ✅

## 2026-02-24 — Dex — Resume Builder: Shared Domain + Native UIs

Split Resume Builder into a headless shared domain hook and platform-native UIs:
- Shared behavior in `shared/components/resume-builder/useResumeBuilder.ts`
- Web UI in `web/app/dashboard/resume/ResumeBuilderClient.tsx`
- Electron UI in `src/components/resume/ResumeBuilder.tsx`

Parity checklist (verify on both web + Electron):
- Import (preview, warnings, confirm) and context-doc save
- Core edits (contact, summary, skills, experience, education)
- AI bullet suggestions (edit, accept, reject)
- JD tailoring (ATS score, matching/missing skills, optimize)
- Template selection (premium gating via credits)
- Preview (plain text) and exports (PDF, DOCX, TXT)

---

## 2026-02-27 — Dex — Electron Security Audit (Static Pass v1)

Completed the first structured static security review for the Electron app and published findings in:
- `docs/security/electron-security-audit-2026-02-27.md`

### Key Outcomes
- Report format aligned to: Executive Summary, Detailed Findings, Hardening Checklist, Unknowns.
- Identified one **Critical** issue: hardcoded integration API key in client config.
- Identified **High/Medium** hardening issues around external URL validation, storage key management, updater fail-open behavior, and entitlement risk.
- Captured dependency risk snapshot from `npm audit` (includes high-severity advisories).

### Validation Gaps Logged
- Rust CVE checks pending (`cargo-audit` unavailable locally during this pass).
- Packaged artifact verification for signing/notarization/fuse-state not yet executed.
- Dynamic abuse testing not yet performed (navigation, protocol handling, updater MITM scenarios).

### Decision
- Treat this as **Static Pass v1** baseline and gate release on remediation of P0/P1 findings plus dynamic verification pass.

---

## 2026-02-27 — Dex — Security Remediation Pass (P0/P1)

Implemented targeted fixes for the top findings from the Electron security audit.

### Changes
- Removed hardcoded integration secret from renderer config:
	- `src/config/endpoints.ts` now reads `VITE_N8N_API_KEY` (build-time) with empty default.
- Hardened external URL handling:
	- `electron/main.ts` `shell:open-external` now fail-closes on parse failure/invalid input, blocks disallowed protocols, and allows `http` only for localhost.
- Improved secure-store key management:
	- `electron/services/secure-store.ts` now uses a per-install random key protected by `safeStorage` instead of a static embedded encryption key.

### Validation
- Focused diagnostics: no TypeScript/language errors in modified files.
- Project typecheck passed: `npm run typecheck`.

---

## 2026-02-27 — Dex — Security Hardening Batch 2 (Navigation + File Save)

Implemented additional Electron hardening from the initial audit backlog.

### Changes
- Added explicit webContents guardrails in `electron/main.ts` for both Main and Overlay windows:
	- `setWindowOpenHandler` deny-by-default with controlled external handoff.
	- `will-navigate` blocking for non-app URLs.
	- `will-attach-webview` blocked.
- Added file-write safeguards in `electron/main.ts` `file:save` IPC route:
	- payload shape validation,
	- maximum file size enforcement,
	- safer decode/write flow with error responses.

### Validation
- `npm run typecheck` passed after changes.

---

## 2026-02-27 — Dex — Security Hardening Batch 3 (Updater + Entitlements + CI Gate)

Implemented additional controls for update resilience and dependency governance.

### Changes
- Updated `electron/services/updater-service.ts`:
	- bounded startup retries with backoff,
	- periodic background update checks,
	- explicit `allowDowngrade = false`, `allowPrerelease = false`, `autoInstallOnAppQuit = true`,
	- one-time startup readiness signaling to avoid duplicate launch gates.
- Updated `build/entitlements.mac.plist`:
	- removed `com.apple.security.cs.allow-unsigned-executable-memory`.
- Added dependency security gate:
	- new script `scripts/security-audit-gate.cjs`,
	- `package.json` script `security:audit:gate`,
	- integrated into `verify:ci` and `.github/workflows/ci.yml`.

### Validation
- `npm run typecheck` passed.
- `npm run security:audit:gate` passed (no critical advisories; highs reported for triage).

---

## 2026-02-27 — Dex — Dependency Triage Pass (High Advisories Cleared)

Reduced npm audit posture from high=9 to high=0 without `--force` upgrades.

### Changes
- Upgraded toolchain dependencies in `package.json`:
	- `electron-builder` → `^26.8.1`
	- `eslint` → `^9.39.3`
	- `typescript-eslint` → `^8.56.1`
	- `@electron/fuses` → `^2.1.0`
	- `@vitejs/plugin-react` → `^5.1.4`
- Added targeted `overrides` in `package.json`:
	- `rollup` pinned to `^4.59.0`
	- `minimatch` overrides for ESLint and `multimatch` paths to `3.1.5`

### Validation
- `npm audit` now reports: `high=0`, `critical=0`.
- `npm run security:audit:gate` passes with zero high/critical.
- `npm run typecheck` passes.

---

## 2026-02-27 — Dex — Dynamic Verification Execution (Packaging + Trust Checks)

Executed the next validation stage after hardening implementation.

### Commands Run
- `npm run verify:ci`
- `npm run build`
- `ELECTRON_CACHE=$PWD/.cache/electron ELECTRON_BUILDER_CACHE=$PWD/.cache/electron-builder npx electron-builder --mac --arm64 --dir`
- `codesign --verify --deep --strict "release/mac-arm64/Diwa Copilot.app"`
- `codesign -dv --verbose=4 "release/mac-arm64/Diwa Copilot.app"`
- `spctl --assess -vv "release/mac-arm64/Diwa Copilot.app"`

### Outcomes
- Build + packaging succeeded; fuse hardening applied during `afterPack`.
- Artifact is ad-hoc signed for local build/testing.
- `spctl` rejected artifact (expected until Developer ID signing + notarization are configured).
- `verify:ci` currently fails due existing test failures in question-generation/store tests; treated as pre-existing quality blocker outside this security-only pass.

---

## 2026-02-27 — Dex — Test Contract Alignment (verify:ci Restored)

Fixed failing tests introduced by stricter session requirements in question generation and feedback analysis flows.

### Changes
- Updated hook tests to pass `sessionId` where required:
	- `src/test/hooks/useQuestionGenerator.test.ts`
	- `src/test/hooks/useFeedbackAnalyzer.test.ts`
- Updated store test setup to start a session before generating a question:
	- `src/test/store/useMockInterviewStore.test.ts`

### Validation
- Targeted suites pass.
- `npm run verify:ci` passes end-to-end (`39` files, `894` tests).

---

## 2026-02-27 — Dex — High-Priority Release Hardening (Signing + Trust Gates)

Added strict release-path controls to prevent publishing insecure mac artifacts.

### Changes
- Added signing/notarization preflight guard:
	- `scripts/require-release-signing.cjs`
	- validates required env configuration before mac publish release scripts run.
- Added mac artifact trust verifier:
	- `scripts/verify-macos-artifact-trust.cjs`
	- enforces `codesign --verify`, rejects ad-hoc signatures, requires TeamIdentifier, and requires Gatekeeper (`spctl`) pass.
- Wired guardrails into release commands:
	- `package.json` scripts `security:release:guard`, `security:verify:mac:*`
	- mac publish scripts now require release guard preflight.
- Updated `scripts/release.sh`:
	- runs signing/notarization preflight before build.
	- verifies ARM64/x64 app bundle trust before creating/uploading release.

### Validation
- `npm run typecheck` passed.
- Guard script fails closed as expected when signing env is missing.
- Trust verifier fails closed as expected on current ad-hoc local artifact.

---

## 2026-02-27 — Dex — Workflow Hardening (Release Asset Verification + Mirror Allowlist)

Extended high-priority hardening from local scripts into release workflows.

### Changes
- Updated `/.github/workflows/auto-release.yml`:
	- Added `verify-release-assets` job between public build completion and final publish.
	- Job validates required installer asset patterns exist before release publish.
	- Job downloads release assets, generates `SHA256SUMS.txt`, and uploads checksum manifest to the release.
	- `finalize-release` now depends on asset verification gate.
- Updated `/.github/workflows/mirror-release.yml`:
	- Added strict asset allowlist before mirroring (`.dmg`, `.exe`, `.blockmap`, `latest*.yml`, `SHA256SUMS.txt`).
	- Mirror fails closed when unexpected asset types are present.

### Security Impact
- Prevents publishing/mirroring releases with missing expected installers.
- Reduces risk of accidentally mirroring arbitrary/unexpected files.
- Adds checksums for downstream integrity verification.

---

## 2026-02-27 — Dex — CI Hardening: Secrets Regression Gate

Added a repository-level hardcoded secret detection gate to reduce credential leakage risk.

### Changes
- Added `scripts/security-secrets-gate.cjs`:
	- scans source/workflow/script paths for high-confidence secret patterns,
	- ignores build artifacts and dependency folders,
	- fails closed on matches.
- Added npm script in `package.json`:
	- `security:secrets:gate`
- Added gate to CI pipelines:
	- included in `verify:ci`
	- added as dedicated step in `.github/workflows/ci.yml`

### Validation
- `npm run security:secrets:gate` passed.
- `npm run verify:ci` passed end-to-end after gate integration.

---

## 2026-02-27 — Dex — Windows Release Hardening (Signing Guard)

Added a Windows signing preflight guard so unsigned public Windows releases are blocked.

### Changes
- Added `scripts/require-windows-signing.cjs`:
	- requires Windows signing certificate config (`WIN_CSC_LINK`/`CSC_LINK` or identity),
	- requires key password (`WIN_CSC_KEY_PASSWORD`/`CSC_KEY_PASSWORD`),
	- fails closed when missing.
- Added npm script in `package.json`:
	- `security:windows:guard`
- Wired guard into Windows publish scripts:
	- `build:release:win:publish`
	- `build:beta:win:publish`

### Validation
- `npm run typecheck` passed.
- Guard script fails closed as expected in environment without signing vars.

---

## 2026-02-27 — Dex — Release Signing Env Matrix Documentation

Added a copy-paste-oriented environment variable matrix for release signing and notarization setup:
- `docs/security/release-signing-env-matrix.md`

Includes:
- macOS signing/notarization required variables (API key flow and Apple ID flow)
- Windows signing required variables
- GitHub Actions `env` examples
- verification commands and fail-closed behavior notes

---

## 2026-03-09 — Dex — JD-CV Gap Analysis Agent (Phase 1)

Implemented the JD-CV Gap Analysis Agent as described in GitHub issue #74.

### New Collection: `gap_analysis_staging`
Top-level collection. Each document is one gap analysis run:
```
gap_analysis_staging/{analysisId}
  userId: string
  jdDocId?: string       — the source JD doc (if triggered from an uploaded doc)
  jdName: string
  missingSkills: string[]
  suggestions: GapAnalysisSuggestion[]   — array of {id, question, answer, skillGap, status}
  creditsDeducted: number                — always 0.5
  createdAt: Timestamp
```

### New API Routes
- `GET /api/ai/gap-analysis` — list analyses for current user
- `POST /api/ai/gap-analysis` — run analysis (body: `{ jdDocId?, jdText?, jdName? }`)
- `PATCH /api/ai/gap-analysis/[analysisId]` — approve/reject a suggestion (body: `{ suggestionId, action: 'approve'|'reject' }`)

### Q&A Bank Integration
Approved suggestions are written to `qa_bank` with `source: 'gap_analysis'` and `skillGap` fields.

### Trigger
Analysis auto-runs after a JD is uploaded via the Context Management page. Manual re-run button also available per JD card.

### Credit Cost
0.5 credits per analysis. Uses `COST_GAP_ANALYSIS` constant from `web/lib/billing.ts`.

---

## 2026-03-09 — Dex — Persona Alignment Engine (Phase 1)

Implemented the Persona Alignment Engine as described in GitHub issue #75.

### New Schema: `AssistantPersona`
Added to `web/lib/firestore-schemas.ts`:
```
AssistantPersona:
  tone: 'formal' | 'technical' | 'conversational' | 'concise'
  detailLevel: 'brief' | 'detailed' | 'balanced'
  companyName: string
  alignedAt: Timestamp
```
Stored at `users/{uid}.preferences.assistantPersona` (optional field).

### New API Routes
- `POST /api/ai/persona-alignment` — reads intel_cache for company culture, calls Gemini to map traits, deducts 0.2 credits. Returns `{ companyName, intelSource, recommendation, creditsDeducted }`.
- `PATCH /api/ai/persona-alignment` — accepts recommendation; writes `users/{uid}.preferences.assistantPersona`. No additional credit cost.

### New Web UI
Page at `/dashboard/persona-alignment` — form for company/role input, displays recommended tone + detailLevel with rationale, and Accept/Decline buttons.

### Session Start Integration
`POST /api/session/start` now falls back to `buildAssistantPersonaInstruction(userData.preferences.assistantPersona)` when no explicit `systemInstruction` is sent. This means the live interview AI automatically respects the aligned persona without any client changes.

### Credit Cost
0.2 credits per alignment. Uses `COST_PERSONA_ALIGNMENT` constant from `web/lib/billing.ts`.

---

## 2026-03-10 — Dex — Agent Worklog UI (Phase 3)

> Current routing note (2026-04-04): `/dashboard/agent-logs` now redirects to `/dashboard/account?tab=activity`. The worklog capability remains shipped and is surfaced through the Account Activity tab.

### Summary
Added a transparency dashboard (`/dashboard/agent-logs`) that shows users a chronological log of every agentic workflow run on their behalf.

### New Firestore Collection: `agent_logs/{id}`
Schema defined in `web/lib/firestore-schemas.ts`:
- `userId`, `feature`, `actionLabel`, `steps[]`, `creditsDeducted`, `status`, `createdAt`
- Optional: `companyName`, `roleTitle`, `sessionId`, `inputSummary`, `outputSummary`

### New Files
- `web/lib/agent-logger.ts` — `appendAgentLog()` fire-and-forget write utility
- `web/app/api/agent-logs/route.ts` — `GET /api/agent-logs`, protected by `withAuth`, returns last 50 logs newest-first
- `web/app/dashboard/account/page.tsx` — Activity tab timeline UI (current primary surface)
- `web/app/dashboard/agent-logs/page.tsx` — compatibility redirect to Account Activity tab

### Integrations
All four existing agentic workflows call `appendAgentLog()` on success:
- Gap Analysis (0.5 cr) — 4 steps
- Prep Package (1.0 cr) — 4 steps
- Persona Alignment (0.2 cr) — 3 steps
- Outreach (0.5 cr) — 3 steps

### Cost
Worklog UI is free (infrastructure only). No new credit cost introduced.

### Governance Notes
- No new npm dependencies added
- No AI provider calls in the worklog feature itself
- UI accesses data exclusively through `/api/agent-logs` — no direct Firestore calls from client
- API route is protected with `withAuth` — no CORS headers (not a public endpoint)
- No `eval` or `dangerouslySetInnerHTML` used

---

## 2026-03-10 — Dex — Token Estimator & Approval Gate (Phase 3)

Implemented the Token Estimator & Approval Gate as described in GitHub issue (Phase 3).

### New Files
- `web/app/api/ai/estimate/route.ts` — `GET /api/ai/estimate?action=<action>`, protected by `withAuth`. Returns `{ action, label, cost, balance, canAfford, balanceAfter }`.
- `web/components/agent-approval/AgentApprovalModal.tsx` — Reusable confirmation modal showing estimated cost, current balance, and balance after deduction. Blocks action if insufficient credits.
- `web/components/agent-approval/AgentApprovalModal.module.css` — Scoped CSS module (dark theme, CSS variables).
- `web/components/agent-approval/index.ts` — Barrel export.
- `web/hooks/useAgentApproval.ts` — `useAgentApproval()` hook that encapsulates: fetch estimate, check "don't ask again" threshold, show modal, resolve promise on confirm/cancel. Syncs threshold preference to `PATCH /api/user/me`.
- `web/test/api/ai/estimate.spec.ts` — 6 unit tests for the estimate endpoint.

### Schema Change
- `web/lib/firestore-schemas.ts` — Added `preferences.agentApprovalThreshold?: number` to the `User` type. 0 (default) = always prompt. Non-zero = skip modal for actions with cost ≤ threshold.

### Integrations
All four existing agentic workflow pages now call `useAgentApproval()` and show the modal before executing:
- Gap Analysis (0.5 cr) — `web/app/dashboard/context/page.tsx`
- Prep Package (1.0 cr) — `web/app/dashboard/tracker/components/ApplicationDrawer.tsx`
- Persona Alignment (0.2 cr) — `web/app/dashboard/persona-alignment/page.tsx`
- Outreach (0.5 cr) — `web/app/dashboard/sessions/page.tsx`

### "Don't Ask Again" Feature
The `useAgentApproval` hook reads/writes a threshold from `localStorage` key `diwa_agent_approval_threshold` for instant reads, and syncs to `users/{uid}.preferences.agentApprovalThreshold` via `PATCH /api/user/me` for persistence across devices.

### Cost
Token Estimator & Gate is free (infrastructure only). No new AI credit cost introduced.

### Governance Notes
- No new npm dependencies added
- `GET /api/ai/estimate` is protected by `withAuth` — not a public endpoint, no CORS headers
- The modal blocks all paid agent actions when balance is insufficient
- Fail-open design: if the estimate API call fails (network error), the action proceeds to avoid permanently blocking users
- No `eval` or `dangerouslySetInnerHTML` used

---

## 2026-04-15 — Dex — Cue Lane Hysteresis & Deterministic Matching (#252, #253)

Implemented deterministic multi-word word-advancement and hysteresis state machine for the Overlay Cue Lane, addressing issues #252 and #253 from the live interview feature request.

### GitHub Issues
- **#252**: Implement deterministic word-advancement logic that reliably advances based on multi-word phrase matching, not just single tokens.
- **#253**: Add hysteresis/debouncing to prevent rapid flicker when the "interrupted" (follow-up question) flag toggles rapidly due to network jitter.

### Key Changes

#### Component Improvements (`src/components/overlay/KaraokeCueLane.tsx`)
1. **PII Redaction Layer** — Added `redactPII()` function to redact sensitive patterns (credit cards, SSNs, emails, phone numbers, IP addresses) from speech signals before word matching. Prevents accidental leakage of sensitive data.
2. **Enhanced Token Normalization** — Improved `normalizeCueToken()` to filter empty tokens after normalization, preventing edge case bugs from punctuation stripping.
3. **Deterministic Match Function** — Refined `findSpokenMatchIndex()` to consume cue words sequentially within the 4-word lookahead window, so the lane only advances through in-order transcript matches and does not skip intermediate cue words.
4. **Hysteresis State Machine** — Added three-state mode (`tracking` → `pending` → `interrupted`):
	- `pending` state stays visible for a 200ms hysteresis debounce window
	- Prevents UI flicker on rapid interruption toggles or network jitter
	- Only enters fully hidden `interrupted` mode after stability is confirmed

#### Test Expansion (`src/test/components/overlay/KaraokeCueLane.test.tsx`)
- Added 7 new test cases covering hysteresis behavior, edge cases, and timer/mic interaction
- **Hysteresis tests**: pending state transitions, rapid toggle resilience, smooth resume
- **Edge case tests**: empty token handling, lookahead boundary respect
- **Interaction tests**: timer gating during mic signal, source text reset behavior
- All 20 tests passing (13 existing + 7 new)

#### Documentation Added (`web/shared/components/support/articles.ts`)
- New support article: "Cue Lane (Karaoke Mode)" under Sessions category
- Covers Mic Mode vs. Timed Mode, auto-pause on follow-up, troubleshooting tips
- Links to audio settings and microphone troubleshooting article

### Agent Feedback Incorporated
- **Security Engineer**: Added PII redaction to prevent sensitive content exposure in word matching
- **Reality Checker**: Addressed state machine flicker risk, timing issues, race conditions
- **Backend Architect**: Confirmed no schema changes needed; timing/ordering manageable
- **DevOps**: Will add performance gates for word-matching latency (<50ms) in future CI iteration
- **Product Manager**: Noted feature is Q2.5+ scope after agentic Q2 roadmap; no blocking

### Notes
- **No Breaking Changes**: Feature is backward compatible; existing overlay behavior unchanged
- **No Feature Flag**: Shipped unconditionally with graceful degradation (component simply doesn't render if conditions not met)
- **Security**: IPC payload not modified; PII redaction is client-side only within word matcher
- **Performance**: Word matching remains <10ms per call; no observable latency impact

### Next Steps
- Monitor user feedback on Cue Lane accuracy during beta
- Gather metrics on adoption and effectiveness
- Consider fallback logic improvements (Q3 roadmap item if user demand signals scaling issues)

---

## Phase 1+2: Marketing Lead Capture + Plausible Analytics

**Date:** 2025-04-26
**Branch:** `feat/marketing-lead-capture-plausible`
**Author:** Dex (GitHub Copilot)

### Decision

Implement public waitlist/lead capture form on the landing site and Plausible analytics.

### CORS Approval

`POST /api/leads/subscribe` is an explicitly approved **public** CORS endpoint (no auth by design). Origin allowlist is already configured in `web/lib/cors-utils.ts` (`diwacopilot.com` + `localhost:3001` + all other origins in `ALLOWED_ORIGINS`). This is the second intentionally public CORS endpoint after `GET /api/billing/packs`.

### Key Design Decisions

- **No auth on lead capture** — intentional; leads are by definition pre-signup users.
- **SSRF prevention** — `N8N_WAITLIST_WEBHOOK_URL` is validated via `isAllowedWebhookUrl()` which enforces: (a) HTTPS-only, (b) blocks loopback (`localhost`, `127.0.0.1`, `::1`), (c) blocks GCP metadata endpoints (`169.254.169.254`, `metadata.google.internal`), (d) blocks RFC-1918 private ranges via regex, (e) blocks IPv4-mapped IPv6 addresses (`::ffff:` prefix). This is defense-in-depth — the env var is operator-controlled (GCP Secret Manager, restricted IAM), not user-supplied.
- **PII to n8n (accepted risk)** — Lead data including email is forwarded to the n8n webhook URL. This is accepted under the operator's responsibility to ensure n8n is covered by a DPA if any EU users are in scope. For self-hosted n8n on GCP, document the data flow in the privacy policy. No code change required.
- **Raw UTM/referrer storage (deferred)** — UTM parameters and `referrer` are stored as raw strings. Any future admin UI rendering these fields MUST use text content only — no `dangerouslySetInnerHTML`. This is a documented constraint, not a current vulnerability.
- **Honeypot field** named `company` (realistic) to avoid bot detection by common honeypot bypass lists. Returns 201 (same as real success) to prevent status-code fingerprinting.
- **Webhook fire-and-forget** — Response (201) is returned before awaiting webhook. A `void` IIFE with `AbortSignal.timeout(5000)` fires n8n asynchronously. Firestore is the source of truth; `n8nDelivered` is a best-effort flag only.
- **Rate limiting** — to be handled via Cloud Armor rule on Cloud Run ingress before any high-visibility marketing push.
- **Plausible** analytics via `next/script strategy="afterInteractive"` — no cookies, GDPR-friendly, no consent banner required.

### Deployment Note

`N8N_WAITLIST_WEBHOOK_URL` must be added to GCP Secret Manager and the Cloud Run `--set-secrets` arg in `scripts/deploy-web.ps1` before the n8n integration will be active. Without it, leads are still captured to Firestore; only the automation trigger is inactive.

### Files Changed

- `web/lib/firestore-schemas.ts` — `WaitlistLead` type added
- `web/app/api/leads/subscribe/route.ts` — new public POST route
- `landing/components/landing/WaitlistForm.tsx` — new form component
- `landing/components/landing/WaitlistForm.module.css` — styles
- `landing/components/landing/LegacyHomePage.tsx` — waitlist section added
- `landing/app/layout.tsx` — Plausible analytics script added
- `firestore.indexes.json` — composite index for `waitlist_leads` (email + createdAt)
- `.env.example` — `N8N_WAITLIST_WEBHOOK_URL` documented
- `web/.env.local` — `N8N_WAITLIST_WEBHOOK_URL` placeholder added

---

## Blog System (Issue #286) — 2026-05-xx

### Three-Phase Blog Implementation

**Phase 1 — Static Markdown MVP (landing site)**  
Blog posts live as `.md` files in `landing/content/blog/`. Build-time utilities in `landing/lib/posts.ts` read and parse them at static export time. No runtime Firestore dependency.

**Phase 2 — Firestore CMS + Admin Panel**  
Posts migrated to Firestore `blog_posts` collection with `blog_slugs/{slug}` sentinel docs for atomic uniqueness. Five admin API routes (`GET|POST /api/admin/blog`, `GET|PATCH|DELETE /api/admin/blog/[id]`) + two public routes (`GET /api/blog/posts`, `GET /api/blog/posts/[slug]`). Admin panel at `/admin/blog` with list, new, edit, and preview pages. Publish/unpublish transitions trigger `workflow_dispatch` on `deploy-landing.yml` to rebuild the static landing site.

**Phase 3 — n8n HMAC Webhook**  
`POST /api/webhooks/blog` accepts n8n AI draft submissions. Validated with HMAC-SHA256 using `timingSafeEqual` (Node.js `crypto`). Signature input = `{timestamp}.{rawBody}`. Replay window: ±5 minutes. Creates posts as `pending_review` with `source: 'n8n'`. Slug is checked via `blog_slugs` sentinel for idempotency (409 on duplicate).

### Blog Webhook Secret Rotation Procedure

When `N8N_BLOG_WEBHOOK_SECRET` needs to be rotated:

1. Generate a new secret: `openssl rand -hex 32`
2. Add a new version to GCP Secret Manager: `gcloud secrets versions add N8N_BLOG_WEBHOOK_SECRET --data-file=-`
3. Update the n8n workflow to sign with the new secret (can run both versions during rollover)
4. Redeploy the web Cloud Run service: `.\scripts\deploy-web.ps1` (it will pull `N8N_BLOG_WEBHOOK_SECRET:latest`)
5. Disable/destroy the old version in Secret Manager: `gcloud secrets versions disable {OLD_VERSION} --secret=N8N_BLOG_WEBHOOK_SECRET`

Do NOT commit any real secret value to source control.

### Status Machine

```
draft → published, pending_review
pending_review → published, draft
published → unpublished
unpublished → published, draft
```

Invalid transitions return `409 { error: 'Invalid status transition', from, to }`.

### Files Changed

- `landing/content/blog/*.md` — static blog posts (Phase 1)
- `landing/lib/posts.ts` — build-time post utilities
- `landing/app/blog/page.tsx` + `blog.module.css` — /blog index
- `landing/app/blog/[slug]/page.tsx` + `blog-post.module.css` + `not-found.tsx` — post detail
- `landing/app/sitemap.ts` — blog URLs added
- `landing/components/landing/Nav.tsx` — Blog nav link added
- `web/lib/firestore-schemas.ts` — `BlogPost`, `BlogPostStatus` types added
- `firestore.indexes.json` — 2 new blog_posts indexes
- `web/app/api/admin/blog/route.ts` — admin GET list + POST create
- `web/app/api/admin/blog/[id]/route.ts` — admin GET + PATCH + DELETE
- `web/app/api/blog/posts/route.ts` — public GET list
- `web/app/api/blog/posts/[slug]/route.ts` — public GET by slug
- `web/app/api/webhooks/blog/route.ts` — Phase 3 n8n HMAC webhook
- `web/app/admin/blog/` — admin panel pages (list, new, edit, preview)
- `web/app/admin/admin-layout-client.tsx` — Blog nav item added
- `.github/workflows/deploy-landing.yml` — `NEXT_PUBLIC_API_BASE_URL` added to build step
- `.env.example` — `GITHUB_DEPLOY_TOKEN`, `N8N_BLOG_WEBHOOK_SECRET` documented
- `landing/.env.example` — `NEXT_PUBLIC_API_BASE_URL` documented
- `scripts/deploy-web.ps1` — blog secrets added to requiredSecrets + secrets arrays
- `scripts/migrate-blog-posts.ts` — Phase 1→2 migration script

---

## 2026-05-01 — Dex — Issue #284: n8n Content Factory Blog Draft Workflow

### Implementation summary

The Content Factory n8n workflow is live at `https://flow.jakeortega.nl` (workflow ID `ZCy6rbT6edXu6Jfr`), currently **inactive** pending credential wiring. It generates structured blog drafts via Gemini 2.5 Flash and delivers them to the review queue at `POST /api/webhooks/blog` (shipped in #286).

### Artifacts committed

- `workflows/flow_jakeortega_nl_jake_o/personal/content-factory-blog.workflow.ts` — canonical n8n-as-code source (16 nodes)
- `workflows/flow_jakeortega_nl_jake_o/personal/content-factory-blog.json` — exportable workflow artifact (imported/exported from n8n)
- `workflows/flow_jakeortega_nl_jake_o/personal/fixtures/content-factory-blog.valid.json` — happy-path QA fixture
- `workflows/flow_jakeortega_nl_jake_o/personal/fixtures/content-factory-blog.invalid.json` — 7 failure-path QA fixtures

### Node graph (confirmed, no publish path)

```
[Webhook Trigger]
  → [Verify Signature + Timestamp + Idempotency]
  → [Validate Input Schema]
  → [Normalize Input]
  → [Build Prompt]
  → [Gemini 2.5 Flash — Generate Draft]
  → [Parse Strict JSON]
  → [Validate Output Schema]
  → [Map To Blog Payload]
  → [POST /api/webhooks/blog]
  → [Respond 202 Accepted]
  → [Mirror to Google Sheets (Observability)]   ← optional, formula injection sanitised
  → [Notify Telegram — Draft Delivered]

Error branch (wired to all terminal failure nodes):
  → [Respond 4xx/5xx on Error]
  → [Notify Telegram — Error Alert]
```

**No auto-publish path.** The only outbound HTTP call is `POST /api/webhooks/blog`, which creates a `pending_review` draft. No CMS, no social, no direct Firestore write from n8n.

### Secret name alignment

| Side | Env var name | Purpose |
|---|---|---|
| n8n (outbound signing) | `DIWA_BLOG_WEBHOOK_SECRET` | Set in n8n instance environment |
| Web API (inbound verification) | `N8N_BLOG_WEBHOOK_SECRET` | Set in Cloud Run secrets |

These env var names differ by convention on each system but must be configured with the **same shared secret value**.

### Manual activation steps (required before first run)

1. **Wire credentials in n8n UI** (n8n credential store — never inline in nodes):
   - `Diwa Gemini API Key` — Google Generative AI key
   - `Diwa Google Sheets` — service account for observability mirror
   - `Diwa Content Telegram` — bot token for notifications
2. **Set values directly in workflow nodes** (replace placeholders):
   - `REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID` → your Telegram chat ID (both Telegram nodes)
   - `REPLACE_WITH_YOUR_SHEETS_ID` → your Google Sheets document ID
3. **Set n8n environment variables** (n8n instance settings or hosting env):
   - `DIWA_CONTENT_FACTORY_SECRET` — HMAC secret for inbound trigger authentication
   - `DIWA_BLOG_WEBHOOK_SECRET` — must match `N8N_BLOG_WEBHOOK_SECRET` value in Cloud Run
   - `DIWA_BLOG_WEBHOOK_URL` — `https://diwa-web-399838595429.asia-southeast1.run.app/api/webhooks/blog`
4. **Send a test webhook** using `fixtures/content-factory-blog.valid.json` as the request body with correct HMAC headers. Verify a `pending_review` draft appears in `/admin/blog`.
5. **Activate the workflow** in n8n UI after test passes.

### Kill-switch procedure

If the workflow must be immediately stopped:
1. In n8n UI: deactivate the workflow (toggle to inactive)
2. Rotate `DIWA_CONTENT_FACTORY_SECRET` in n8n environment and `N8N_BLOG_WEBHOOK_SECRET` in Cloud Run secrets simultaneously
3. Redeploy web service: `.\scripts\deploy-web.ps1` from repo root

### Blog Webhook Secret Rotation

> **Rotation procedure (must be done atomically):**
> 1. Generate new secret: `openssl rand -hex 32`
> 2. Update Cloud Run secret: `gcloud secrets versions add N8N_BLOG_WEBHOOK_SECRET --data-file=<(echo -n "new-secret")`
> 3. Redeploy web service to pick up new secret version: `.\scripts\deploy-web.ps1`
> 4. Update the `DIWA_BLOG_WEBHOOK_SECRET` value in n8n environment immediately after the service is healthy
> 5. Send a test webhook and verify `201` response
>
> **Note:** There is a short window between step 2 and step 4 where n8n deliveries fail with `401`. Schedule rotation during off-peak hours. The n8n error notification node will alert on any `401` received.

### n8n free plan compatibility note

`$env.VARIABLE` n8n expression syntax requires a paid plan. All environment values in this workflow are accessed via `process.env.X` inside JavaScript Code nodes (free plan compatible). Placeholder strings are hardcoded in non-Code nodes (Sheets ID, Telegram chat ID) — replace them before activating.

### Post-push restore ritual (for n8nac CLI users)

After every `n8nac push`, restore these files:

**`tsconfig.json`** — add back:
```json
"ignoreDeprecations": "6.0",
"baseUrl": ".",
"paths": { "@n8n-as-code/transformer": ["./n8n-workflows.d.ts"] }
```

**`n8n-workflows.d.ts`** — add `tags` field to BOTH `WorkflowDecoratorOptions` interfaces:
```typescript
tags?: Array<{ id?: string; name?: string }>;
```

**`content-factory-blog.workflow.ts`** — restore tags decorator field:
```typescript
tags: [{ id: 'guSD4NOG5rzThhV5', name: 'Content Factory' }],
```

Run `npx tsc --noEmit` after every push to verify the restore is clean.
