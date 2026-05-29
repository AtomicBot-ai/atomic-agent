---
name: currency
description: Currency exchange rates and conversion via the Frankfurter API (no key). Use for FX rates, "convert X to Y", or historical/time-series rates.
version: 1.0.0
requires_tools:
  - os.http.request
  - os.shell.run
dangerous: false
---

# currency

Fetch exchange rates and convert money amounts through the free, key-less
[Frankfurter API](https://frankfurter.dev) (ECB-sourced fiat rates, updated
daily ~16:00 CET). Prefer `os.http.request` **GET**; if the host allowlist is
not `null`, it must include `api.frankfurter.dev`.

Fiat only — no crypto, no precious metals on v1. Rates refresh on business days,
so weekend/holiday requests return the most recent business-day rate.

## Endpoints (v1, stable)

Base URL: `https://api.frankfurter.dev/v1`

| Goal | URL |
|---|---|
| Latest, EUR base, all currencies | `/latest` |
| Latest with base + targets | `/latest?base=USD&symbols=EUR,GBP` |
| Convert an amount | `/latest?base=USD&symbols=EUR&amount=100` |
| Historical (single day) | `/2024-01-15?base=USD&symbols=EUR` |
| Time series (date range) | `/2024-01-01..2024-01-31?base=USD&symbols=EUR` |
| Supported currencies | `/currencies` |

`symbols` is a comma-separated list of ISO 4217 codes. `amount` multiplies the
returned rate, so `amount=100&base=USD&symbols=EUR` gives "100 USD in EUR".

## Calling convention

Latest rate with `os.http.request`:

```
[{ "tool": "os.http.request", "args": { "method": "GET", "url": "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP" } }]
```

Convert 250 USD to JPY:

```
[{ "tool": "os.http.request", "args": { "method": "GET", "url": "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY&amount=250" } }]
```

Fallback if `os.http.request` is unavailable or the host is not allowlisted:

```
[{ "tool": "os.shell.run", "args": { "cmd": "curl", "args": ["-fsS", "--max-time", "25", "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR&amount=100"] } }]
```

## Response shape

```json
{ "amount": 100.0, "base": "USD", "date": "2026-05-29", "rates": { "EUR": 92.13 } }
```

`rates[<symbol>]` already reflects `amount`. Always report the `date` so the user
knows how fresh the quote is.

## When to use

- "What's the USD/EUR rate?", "convert 50 GBP to PLN", "rate of X in Y".
- Historical FX on a given date, or a rate trend over a period.

## When NOT to use

- Crypto prices (BTC, ETH) — Frankfurter is fiat-only.
- Real-time / intraday tick data — rates are daily reference rates.
- Precious metals (XAU, XAG) — not available on v1.

## Rules

1. Echo the `date` field with every quote; rates are daily, not live.
2. Validate currency codes against `/currencies` if the user gives an unusual code.
3. For "convert N", pass `amount=N` rather than multiplying client-side — the API
   keeps full precision.
4. Unknown currency codes return HTTP 404 / 422; surface a clear "unsupported
   currency" message instead of the raw error.
