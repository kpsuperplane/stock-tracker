# Portfolio event provider feasibility

Date evaluated: 2026-07-10

## Decision

**BLOCKED — no provider is selected for authoritative portfolio events.**

Yahoo Finance chart v8 remains a candidate split parser, but it cannot establish
that every split in a requested historical interval was retained. Alpha Vantage
`DIVIDENDS` plus `OVERVIEW` remains a candidate dividend parser, but this
evaluation did not observe an authentic response row whose ex-date was still in
the future. Documentation plus a synthetic row is insufficient for the
announced-future feasibility gate.

Continue to keep the existing `YahooMarketDataProvider` and its
`DailySeries.corporateActionDates` behavior unchanged. Do not use either new
candidate to authorize ledger mutations or publish future Calendar events until
a provider decision supplies the missing evidence.

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
| Split range coverage | **Fail.** `period1`/`period2` shape a request, but Yahoo supplies no retention/completeness basis; `firstTradeDate` is only listing metadata | N/A | Candidate returns `basis: unverified`, null coverage bounds, and `isComplete: false` |
| Historical dividend | Chart event has historical date/amount but no documented depth | Documentation says historical distributions | Pass: 2024 event |
| Announced future dividend | **Fail.** The unofficial chart endpoint has no stability or future-declaration coverage promise | **Fail evidence gate.** Documentation promises future declared distributions, but no authentic observed future row was available | Synthetic parser case passes; feasibility does not |
| Dividend currency | Chart metadata has instrument currency, but future event coverage already fails | `DIVIDENDS` omits currency; `OVERVIEW.Currency` supplies it | Parser pass: USD normalized on each event |
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

If Alpha Vantage is later approved with authentic evidence, its documented 25
free requests/day means an uncached two-call refresh is limited to 12 symbols
per day. Later pipeline work would need to cache instrument currency and
stagger dividend refreshes rather than refreshing all 100 instruments daily.

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

## Coverage and stability limits

Yahoo Finance's chart endpoint is unofficial and has no public stability or
retention SLA. During this evaluation, one live endpoint returned HTTP 429;
another live probe returned individual AAPL and GE split rows. Those rows prove
event shape, not exhaustive interval retention. `meta.firstTradeDate` is
listing metadata and cannot establish action-history coverage. The candidate
therefore returns explicit unverified coverage with null bounds and
`isComplete: false`. This cannot satisfy the authoritative ledger gate.

Alpha Vantage's documentation promises historical and future declared dividend
distributions but does not state historical depth or update latency. The demo
IBM response inspected on 2026-07-10 contained 110 events from 1999-02-08
through 2026-05-08; its newest ex-date was already past. This proves the
historical response shape only. No authorized non-demo key or authentic stored
future response was available in the workspace. The synthetic future case
tests parsing behavior and is not provider evidence.

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

## Authority needed to unblock

The plan needs an explicit provider decision supported by both:

1. An authentic, timestamped free-provider response observed before its
   dividend ex-date that includes exact ex-date and per-share amount, plus a
   defensible currency source.
2. A provider contract or other authoritative basis that establishes complete
   split retention for a requested date interval, including corrections.

An approved licensed source, user-authorized free API credential for a source
that exposes these fields, or written approval to change the authoritative
coverage requirement would provide the necessary authority. Documentation plus
synthetic fixtures alone will not unblock the plan.

Primary sources:

- Alpha Vantage API documentation, Corporate Action - Dividends and Company
  Overview: https://www.alphavantage.co/documentation/
- Alpha Vantage support, free quota: https://www.alphavantage.co/support/

Yahoo has no official public documentation for this finance chart endpoint;
that absence is part of the stability assessment rather than an omitted source.
