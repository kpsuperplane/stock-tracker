# Portfolio event provider feasibility

Date evaluated: 2026-07-10

## Decision

**APPROVED FOR BEST-EFFORT PERSONAL-APP USE.**

Yahoo Finance chart v8 is selected only as an unverified split-candidate source;
it does not establish that every split in a requested historical interval was
retained. A later historical transaction can become authoritative only after
the user reviews and confirms the displayed split history for its affected
instrument and range. The confirmation is tied to the retrieved provider
revision; a later revision or correction invalidates it and requires review.

Alpha Vantage `DIVIDENDS` plus `OVERVIEW` is selected as a source-reported,
best-effort dividend feed. Its rows may populate Calendar facts, but absence of
a future row means only that this source reports no currently known announced
event. It is not evidence that the issuer will pay no future dividend.

Continue to keep the existing `YahooMarketDataProvider` and its
`DailySeries.corporateActionDates` behavior unchanged. The new split adapter
must never authorize a ledger mutation by itself, and neither adapter may be
described as exhaustive.

The selected application boundary is `CorporateActionProvider` and
`DividendProvider`. Consumers receive only normalized events and range
metadata; no Yahoo or Alpha Vantage response type crosses that boundary.

## Evidence matrix

| Case or field | Yahoo chart v8 | Alpha Vantage | Fixture/test outcome |
| --- | --- | --- | --- |
| Ordinary split | `events.splits[*].splitRatio`, `date` | `SPLITS` is available but not needed | Pass: `4:1` |
| Reverse split | Same fields | Not evaluated because Yahoo passes | Pass: `1:10` |
| Exact ratio | `splitRatio` is a string; adapter does not derive it from adjusted prices | N/A | Parser pass: reduced exact integer strings |
| Split effective date | Epoch seconds in `date`, normalized in UTC | N/A | Pass, including 00:30 UTC boundary |
| Split range coverage | **Unverified.** `period1`/`period2` shape a request, but Yahoo supplies no retention/completeness basis; `firstTradeDate` is only listing metadata | N/A | Candidate returns `basis: unverified`, null coverage bounds, `isComplete: false`, retrieval time, and derived snapshot revision; user confirmation is required later |
| Historical dividend | Chart event has historical date/amount but no documented depth | Documentation says historical distributions | Pass: 2024 event |
| Announced future dividend | Not selected; the unofficial chart endpoint has no stability or future-declaration coverage promise | **Best effort.** Documentation promises future declared distributions, but no authentic observed future row was available | Provider-shaped future parser case passes; a missing row means no event is currently known from this source |
| Dividend currency | Not selected | `DIVIDENDS` omits currency; `OVERVIEW.Currency` supplies it | Parser pass: USD normalized on each source-reported event |
| Missing fields | Must reject, not infer | Must reject, not infer | Pass for missing split ratio and null amount |
| Correction | No native revision or durable action ID | No native revision or durable action ID | Pass for stable derived identity and changed derived revision |
| Duplicate event | Provider records may repeat | Provider rows may repeat | Pass: exact duplicates collapse by identity/revision |
| Delisted/unknown symbol | `chart.result: null` with error | Empty response observed/represented | Pass: `provider_symbol_unavailable` |

## Request shapes

Yahoo split request:

```text
GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
    ?period1={UTC start epoch}
    &period2={UTC day after end epoch}
    &interval=1d
    &events=splits
```

Alpha Vantage dividend requests (two free-tier calls per symbol refresh):

```text
GET https://www.alphavantage.co/query
    ?function=DIVIDENDS&symbol={symbol}&apikey={key}
GET https://www.alphavantage.co/query
    ?function=OVERVIEW&symbol={symbol}&apikey={key}
```

Alpha Vantage's documented 25 free requests/day means an uncached two-call
refresh is limited to 12 symbols per day. Later pipeline work must cache
instrument currency and stagger dividend refreshes rather than refreshing all
100 instruments daily.

## Identity and correction semantics

Neither candidate exposes an immutable event ID or revision token.

- Split identity is `provider + symbol + effective date`; revision is the exact
  effective-date/ratio tuple. A corrected ratio retains identity and changes
  revision.
- Dividend identity is `provider + symbol + ex-date + declaration-date`;
  revision includes ex-date, declaration/record/payment dates, exact amount,
  and currency. An amount correction retains identity and changes revision.
- An ex-date or declaration-date correction necessarily changes derived
  identity because neither source exposes a durable upstream ID. Later
  ingestion must quarantine a disappearance/new-identity pair rather than
  silently rewriting an active event.
- Two distinct distributions with the same ex-date and declaration date cannot
  be distinguished by Alpha Vantage's published fields. Conflicting revisions
  in one response are rejected as `provider_conflicting_revision`.
- Each range response also carries its retrieval timestamp and a derived
  snapshot revision over the requested range and normalized events. Later split
  confirmation must bind to this revision, not merely to the instrument.

## Coverage and stability limits

Yahoo Finance's chart endpoint is unofficial and has no public stability or
retention SLA. During this evaluation, one live endpoint returned HTTP 429;
another live probe returned individual AAPL and GE split rows. Those rows prove
event shape, not exhaustive interval retention. `meta.firstTradeDate` is
listing metadata and cannot establish action-history coverage. The candidate
therefore returns explicit unverified coverage with null bounds and
`isComplete: false`. It can supply a history for user review but cannot satisfy
the authoritative ledger gate without confirmation of that exact range and
snapshot revision.

Alpha Vantage's documentation promises historical and future declared dividend
distributions but does not state historical depth or update latency. The demo
IBM response inspected on 2026-07-10 contained 110 events from 1999-02-08
through 2026-05-08; its newest ex-date was already past. This proves the
historical response shape only. No authorized non-demo key or authentic stored
future response was available in the workspace. The synthetic future case
tests parsing behavior and is not provider evidence. Under the approved
best-effort model, source-reported rows are usable Calendar facts and a missing
future row is represented as "no announced event currently known from this
source," never as negative proof.

The `DIVIDENDS` endpoint has no date parameters, conditional request token,
provider revision, or currency field. The adapter filters the full result to the
requested date range and joins `OVERVIEW.Currency`. Later orchestration must
retain prior revisions and treat missing previously seen future events as
correction candidates.

## Fixture provenance

`tests/fixtures/providers/yahoo-split-cases.json` contains minimized chart-v8
response-shaped cases for ordinary/reverse splits, a ratio correction, UTC
boundary, exact duplicate, missing ratio, and delisted response. These cases do
not prove exhaustive range coverage.

`tests/fixtures/providers/alpha-vantage-dividend-cases.json` contains minimized
`DIVIDENDS` and `OVERVIEW` response-shaped cases for historical and synthetic
future rows, an amount correction, exact duplicate, missing amount, and
unavailable symbol. These are parser fixtures, not authentic provider captures
or claims that the synthetic `CASE` symbol exists.

## Required downstream safeguards

The provider decision removes the strict feasibility block but does not upgrade
either source's evidence:

1. Later schema and services must record the user-confirmed start/end range,
   provider revision, retrieval time, and confirmation timestamp before a
   historical mutation becomes authoritative.
2. Any changed split snapshot revision, disappearance, or correction invalidates
   confirmation and requires review again. Conflicting corrections remain
   quarantined.
3. Dividend consumers preserve source, retrieval time, identity/revision, quota
   constraints, and incomplete-history warnings. They must not infer an
   unannounced event or claim that a missing future row is exhaustive.

Primary sources:

- Alpha Vantage API documentation, Corporate Action - Dividends and Company
  Overview: https://www.alphavantage.co/documentation/
- Alpha Vantage support, free quota: https://www.alphavantage.co/support/

Yahoo has no official public documentation for this finance chart endpoint;
that absence is part of the stability assessment rather than an omitted source.
