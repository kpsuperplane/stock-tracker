# Portfolio event CSV import

Use `portfolio-events.csv` as the exact UTF-8 template. Every row names an
existing active category and account; matching trims whitespace and ignores
case. A single file can contain rows for several accounts and up to 10,000 data
rows. There is no distinct-symbol, watchlist, or current-position limit. The
upload is processed asynchronously and detailed failures appear on Status.
