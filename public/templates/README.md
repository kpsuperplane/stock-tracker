# Portfolio event CSV import

Use `portfolio-events.csv` as the exact UTF-8 template. Every row names an
existing active category and account; matching trims whitespace and ignores
case. A single file can contain rows for several accounts. A file may contain
up to 10,000 data rows and up to 40 distinct symbols. The distinct-symbol limit
keeps synchronous split-history verification within the Worker request budget;
split larger portfolios into multiple imports.

If this bound is exceeded, preview returns the stable validation code
`too_many_symbols` and does not stage the file.
