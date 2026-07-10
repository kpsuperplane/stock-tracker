# Portfolio event provider feasibility

Date evaluated: 2026-07-10

## Decision

Select the Yahoo Finance chart v8 adapter for split events and Alpha Vantage
`DIVIDENDS` plus `OVERVIEW` adapters for dividend events. Keep the existing
`YahooMarketDataProvider` and its `DailySeries.corporateActionDates` behavior
unchanged until a later cutover.

The selected application boundary is `CorporateActionProvider` and
`DividendProvider`. Consumers receive only normalized events and range
metadata; no Yahoo or Alpha Vantage response type crosses that boundary.

## Evidence matrix

| Case or field | Yahoo chart v8 | Alpha Vantage | Fixture/test outcome |
| --- | --- | --- | --- |
| Ordinary split | `events.splits[*].splitRatio`, `date` | `SPLITS` is available but not needed | Pass: `4:1` |
| Reverse split | Same fields | Not evaluated because Yahoo passes | Pass: `1:10` |
| Exact ratio | `splitRatio` is a string; adapter does not derive it from adjusted prices | N/A | Pass: numerator and denominator preserved as decimal strings |
| Split effective date | Epoch seconds in `date`, normalized in UTC | N/A | Pass, including 00:30 UTC boundary |
| Split range coverage | `period1` inclusive, `period2` exclusive; `firstTradeDate` bounds pre-listing coverage | N/A | Pass: requested and covered range returned explicitly |
| Historical dividend | Chart event has historical date/amount but no documented depth | Documentation says historical distributions | Pass: 2024 event |
| Announced future dividend | **Fail.** The unofficial chart endpoint has no stability or future-declaration coverage promise | Official documentation says the endpoint returns future declared distributions | Pass: 2026 announced event with future ex-date and amount |
| Dividend currency | Chart metadata has instrument currency, but future event coverage already fails | `DIVIDENDS` omits currency; `OVERVIEW.Currency` supplies it | Pass: USD normalized on each event |
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

Alpha Vantage documents free access at 25 requests per day. At two calls per
symbol, an uncached refresh is limited to 12 symbols per day before the free
quota is exhausted. Later pipeline work must cache instrument currency and
schedule dividend refreshes rather than refreshing all 100 instruments daily.

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
retention SLA. During this evaluation, repeated live chart probes returned an
HTTP 429 response, while recorded chart-shaped fixtures remained deterministic.
The adapter therefore treats HTTP, schema, symbol, and conflicting-revision
failures explicitly. A successful response claims split coverage only from the
later of the requested start and `meta.firstTradeDate`, through the requested
end.

Alpha Vantage's documentation promises historical and future declared dividend
distributions but does not state historical depth or update latency. The demo
IBM response inspected on 2026-07-10 contained 110 events from 1999-02-08
through 2026-05-08; this observation is evidence for that response only, not a
general historical-depth guarantee. Future-dividend feasibility rests on the
provider's explicit documented contract plus the recorded schema fixture. It
does not imply that unannounced dividends will be predicted.

The `DIVIDENDS` endpoint has no date parameters, conditional request token,
provider revision, or currency field. The adapter filters the full result to the
requested date range and joins `OVERVIEW.Currency`. Later orchestration must
retain prior revisions and treat missing previously seen future events as
correction candidates.

## Fixture provenance

`tests/fixtures/providers/yahoo-split-cases.json` records chart-v8 response
shapes for ordinary/reverse splits, a ratio correction, UTC boundary, exact
duplicate, missing ratio, and delisted response.

`tests/fixtures/providers/alpha-vantage-dividend-cases.json` records the
documented `DIVIDENDS` and `OVERVIEW` response shapes for historical and
declared-future rows, an amount correction, exact duplicate, missing amount,
and unavailable symbol. These are minimized contract fixtures, not claims that
the synthetic `CASE` symbol exists.

Primary sources:

- Alpha Vantage API documentation, Corporate Action - Dividends and Company
  Overview: https://www.alphavantage.co/documentation/
- Alpha Vantage support, free quota: https://www.alphavantage.co/support/

Yahoo has no official public documentation for this finance chart endpoint;
that absence is part of the stability assessment rather than an omitted source.
