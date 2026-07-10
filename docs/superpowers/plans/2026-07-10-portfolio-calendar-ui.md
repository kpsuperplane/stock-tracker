# Portfolio, Calendar, Events, and ASTRYX UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the bilingual, information-dense four-page product experience using ASTRYX neutral components and the feature-flagged APIs from Plans 1–2.

**Architecture:** An ASTRYX AppShell owns responsive navigation and locale selection. Page modules own data loading and mutation state; shared financial formatters and status components prevent drift. The event Calendar is the only substantial custom layout and uses ASTRYX controls/dialogs around custom month/week CSS grids.

**Tech Stack:** React 19, Vite, ASTRYX core and neutral theme, TypeScript, existing fetch API wrapper, Vitest, browser/accessibility test tooling selected by the implementer.

## Global Constraints

- Plans 1 and 2 must be accepted first.
- This plan intentionally omits implementation snippets and exact component internals; implementing subagents choose them.
- Pin exact ASTRYX core, neutral-theme, and CLI versions in the lockfile.
- Use documented ASTRYX components and templates before writing custom components or styles.
- Keep custom CSS limited to event-calendar grids, tabular financial alignment, event overflow, and unavoidable responsive overflow.
- Use conservative density: approximately 16px page gutters, 12px section gaps, compact controls, dense rows, and minimal card nesting.
- UI locale affects static strings, dates, and numbers. Stored summaries remain Chinese.
- Preserve pending, partial, stale, conflict, and terminal states; do not hide data because one row failed.
- Split review must show source, range, retrieval time, provider revision, exact rows, and an incomplete-history warning before confirmation. Dividend copy must identify source-reported best-effort data and must not imply that empty future dates prove absence.
- Keep the new shell behind a disabled-by-default feature flag until Plan 4.
- Every task ends with focused tests, visual inspection at desktop/phone widths, review, and a scoped commit.

---

## Intended project structure

| Path | Responsibility |
| --- | --- |
| `src/ui/system/Providers.tsx` | ASTRYX Theme/Link/Toast providers |
| `src/ui/system/AppShell.tsx` | Responsive shell and persistent sidebar |
| `src/ui/system/formatters.ts` | Locale-aware decimal/date/native-currency formatting |
| `src/ui/i18n/catalog.ts` | Typed EN/CN static copy catalog |
| `src/ui/i18n/I18nProvider.tsx` | Locale state, browser default, local-storage persistence |
| `src/ui/routing.ts` | Four stable SPA page destinations and active navigation state |
| `src/ui/pages/PortfolioPage.tsx` | Portfolio table/totals/freshness/source interactions |
| `src/ui/pages/EventsPage.tsx` | Event timeline, filters, add/edit/delete, conflict state |
| `src/ui/pages/EventImportDialog.tsx` | CSV upload, preview, errors, projection, commit |
| `src/ui/pages/CalendarPage.tsx` | Calendar data/range/view orchestration |
| `src/ui/calendar/MarketCalendar.tsx` | Public custom calendar boundary |
| `src/ui/calendar/CalendarToolbar.tsx` | Navigation and week/month controls |
| `src/ui/calendar/MonthGrid.tsx` | Seven-column month grid |
| `src/ui/calendar/WeekGrid.tsx` | Seven-column all-day week grid |
| `src/ui/calendar/CalendarEvent.tsx` | Mover/dividend event chip |
| `src/ui/calendar/MoverDialog.tsx` | Chinese summary and sources dialog |
| `src/ui/pages/BackfillPage.tsx` | Backfill controls and pipeline job projection |
| `src/ui/components/JobProgress.tsx` | Shared reconciliation/backfill progress |
| `src/ui/components/FactStatus.tsx` | Pending/stale/error/conflict states |
| `src/ui/calendar.css` | Only custom month/week grid and overflow CSS |
| `src/ui/styles.css` | Reduced to Astryx imports and narrowly scoped app rules |

Implementers may adjust component splitting after inspecting ASTRYX templates, but must keep page ownership and the custom-CSS boundary intact.

---

### Task 1: Install and validate ASTRYX neutral foundations

**Files:**

- Modify `package.json`, `package-lock.json`, `src/ui/main.tsx`, and `src/ui/styles.css`.
- Create `src/ui/system/Providers.tsx` and focused provider tests.

**Interfaces:**

- Produces the neutral theme, link integration, toast/dialog roots, reset/component/theme CSS order, and stable CLI script.
- Existing App renders unchanged inside the provider during this task.

- [ ] Record exact package versions and verify Vite compatibility using official ASTRYX docs/CLI.
- [ ] Add a failing provider smoke test for neutral theme and accessible overlay roots.
- [ ] Install only required ASTRYX packages and add the stable CLI package script.
- [ ] Import CSS in documented cascade order and wrap the existing root.
- [ ] Run component smoke tests, `npm run typecheck`, and `npm run build`.
- [ ] Inspect bundle warnings and record any beta-version constraints.
- [ ] Commit with message `feat: add astryx neutral ui foundation`.

### Task 2: Add typed i18n, routing, and responsive AppShell

**Files:**

- Create the i18n, routing, shell, and formatter modules listed above.
- Modify `src/ui/App.tsx` and relevant shell tests.

**Interfaces:**

- Produces stable destinations for Portfolio, Events, Calendar, and Backfill.
- Locale selection persists locally; Chinese browser locales default to CN and all others to EN.
- Sidebar is persistent/collapsible on desktop and uses ASTRYX mobile shell behavior on narrow screens.

- [ ] Add failing tests for route selection, active sidebar state, locale default, locale persistence, EN/CN text, native currency, decimal strings, and dates.
- [ ] Build the shell from ASTRYX AppShell/SideNav rather than custom layout primitives.
- [ ] Keep all four destinations behind the new-product feature flag; retain the current App when disabled.
- [ ] Add a bottom-of-sidebar EN/中文 control with accessible labeling.
- [ ] Run focused shell/i18n tests, `npm run typecheck`, and `npm run build`.
- [ ] Inspect desktop and phone navigation, focus order, text fit, and density.
- [ ] Commit with message `feat: add bilingual portfolio app shell`.

### Task 3: Build the Events and CSV workflows

**Files:**

- Create `src/ui/pages/EventsPage.tsx`, `src/ui/pages/EventImportDialog.tsx`, and page tests.
- Extend `src/ui/api.ts` only through the stable Plan 1 contracts.

**Interfaces:**

- Events page reads a combined paginated transaction/split timeline.
- Manual mutations carry expected position/event revisions.
- CSV dialog performs upload, preview, projected holdings, and explicit commit.

- [ ] Add failing tests for loading/empty/error states, filters, pagination, manual add, edit revision, delete confirmation, retryable provider error, split-history review and explicit confirmation, provider-revision invalidation, negative holdings, stale conflict, read-only split, quarantined correction, and resolving edit.
- [ ] Add import tests for file selection, preview errors, projected holdings, duplicate file, stale preview, commit progress, and template access.
- [ ] Compose forms, tables, dialogs, file input, badges, alerts, and toasts from ASTRYX.
- [ ] Ensure pending reconciliation job state is visible after successful mutations.
- [ ] Run page tests, `npm run typecheck`, and `npm run build`.
- [ ] Inspect keyboard flows, phone overflow, dense table rows, and bilingual labels.
- [ ] Commit with message `feat: add portfolio events experience`.

### Task 4: Build the Portfolio page

**Files:**

- Create `src/ui/pages/PortfolioPage.tsx`, shared status components, and focused tests.
- Retire old Watchlist UI only inside the enabled new-product shell; do not delete backend legacy code.

**Interfaces:**

- Consumes the Plan 2 Portfolio DTO and ETag behavior.
- Displays separate CAD/USD totals, derived quantity, raw completed price, valuation, split-adjusted amount/percentage movement, actual trading date, Chinese summary, sources, and freshness.

- [ ] Add failing tests for mixed currency, zero holdings, weekend/latest-date labels, qualifying/nonqualifying movement, split-day amount consistency, Chinese summary under EN/CN UI, source links, stale fact, pending fact, failed analysis, and corporate-action conflict.
- [ ] Implement conditional loading/caching without polling the full Portfolio payload.
- [ ] Use one dense ASTRYX table and restrained total summaries; avoid nested cards.
- [ ] Keep row-level failures visible without suppressing successful holdings.
- [ ] Run focused tests, `npm run typecheck`, and `npm run build`.
- [ ] Inspect wide and narrow tables, numeric alignment, summary wrapping, and density.
- [ ] Commit with message `feat: add derived portfolio page`.

### Task 5: Build the custom month/week Market Calendar

**Files:**

- Create the Calendar modules and `src/ui/calendar.css` listed above.
- Create focused date-math, component, accessibility, and interaction tests.

**Interfaces:**

- CalendarPage owns visible range and server request.
- MarketCalendar receives normalized all-day mover/source-reported-dividend events and pending fact or split-review states.
- Month/week grids expose keyboard-reachable events; MoverDialog displays stored Chinese summary/sources.

- [ ] Add pure date tests for month boundaries, outside days, leap year, Sunday week start, week crossing month/year, Toronto DST, previous/today/next, and range request bounds.
- [ ] Add failing UI tests for mover/dividend chips, signed percentages, native expected totals, dividend details with eligible shares/per-share amount/source/best-effort freshness, missing-future-row copy, busy-day `more` disclosure, pending legacy refresh, empty dates, and error states.
- [ ] Add dialog tests for focus transfer/return, Escape, title/description, source URLs, and Chinese summary under both locales.
- [ ] Build toolbar controls from ASTRYX Button/ButtonGroup and detail surfaces from ASTRYX Dialog/Popover/Badge.
- [ ] Implement only the spatial month/week grids and overflow in custom CSS.
- [ ] Confirm week view remains an all-day seven-column layout with no hourly time axis.
- [ ] Run Calendar tests, `npm run typecheck`, and `npm run build`.
- [ ] Inspect dense/busy months and weeks at desktop and phone widths with keyboard-only navigation.
- [ ] Request adversarial accessibility and date-boundary review.
- [ ] Commit with message `feat: add portfolio event calendar`.

### Task 6: Adapt Backfill and reconciliation progress UI

**Files:**

- Modify `src/ui/pages/BackfillPage.tsx`.
- Create `src/ui/components/JobProgress.tsx` and focused tests.

**Interfaces:**

- Consumes Backfill compatibility and pipeline-job endpoints from Plan 2.
- Distinguishes manual Backfills from automatic reconciliation jobs.
- Shows reused, skipped, fetched, analyzed, processed, and failed counts with targeted retry.

- [ ] Add failing tests for date/range validation, normal versus reprocess, background continuation, shared work, partial error, terminal error, retryable items, automatic reconciliation grouping, and compact progress rendering.
- [ ] Replace bespoke controls/tables with ASTRYX equivalents while preserving behavior.
- [ ] Poll only job status and invalidate affected page data once on completion.
- [ ] Run existing Backfill tests, new component tests, `npm run typecheck`, and `npm run build`.
- [ ] Inspect long errors, narrow widths, and progress density.
- [ ] Commit with message `feat: show portfolio reconciliation progress`.

### Task 7: UI integration and plan-level verification

**Files:**

- Modify UI integration/browser tests and only the remaining stylesheet rules required by inspection.
- Update `README.md` with locale, navigation, and CSV user workflows.

**Interfaces:**

- Produces the accepted feature-flagged four-page UI consumed by Plan 4 cutover.
- Guarantees the legacy shell remains the default until production-read approval.

- [ ] Add an end-to-end fixture covering import → Portfolio → Calendar mover dialog → Backfill progress.
- [ ] Verify EN and CN at desktop and phone breakpoints.
- [ ] Verify keyboard navigation, visible focus, dialog focus trapping/return, table semantics, status announcements, reduced motion, and horizontal overflow.
- [ ] Compare custom CSS against the approved allowlist and remove layout rules duplicated by ASTRYX.
- [ ] Run `npm run check` with both old and new shell flags.
- [ ] Capture and inspect representative desktop/phone screenshots for all four pages.
- [ ] Run adversarial UX/accessibility review against the approved design.
- [ ] Commit with message `feat: complete portfolio product interface`.

Plan 3 is complete only when the feature-flagged product UI passes all interaction and visual gates while the legacy shell remains the default.
