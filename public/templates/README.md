# Portfolio event CSV import

Use `portfolio-events.csv` as the exact UTF-8 template. A file may contain up
to 10,000 data rows and up to 40 distinct symbols. The distinct-symbol limit
keeps synchronous split-history verification within the Worker request budget;
split larger portfolios into multiple imports.
