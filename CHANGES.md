# IMARA LINKS — Fix Package

## Files changed (drop into your project folder at the same relative paths)

```
backend/routes/reconciliation.js
backend/routes/daily.js
backend/routes/reports.js
backend/routes/dashboard.js
backend/routes/invoices.js
frontend/reconciliation.html
```

---

## Fix 1 — Remove `::numeric` PostgreSQL cast from all SQL queries
**Files:** all 5 route files

Every `ROUND(expr::numeric, 2)` has been simplified to `ROUND(expr, 2)`.
SQLite's ROUND() already operates on real/float values without any cast.
The `::numeric` syntax is PostgreSQL-specific and is only masked at runtime
by the `toSQLite()` wrapper in `sqlite-schema.js`. Removing it from source
eliminates the dependency on that wrapper and makes the SQL valid native SQLite.

---

## Fix 2 — Replace `LEFT(col, n)` with `SUBSTR(col, 1, n)` in all SQL queries
**Files:** reconciliation.js, reports.js, dashboard.js

`LEFT()` is a PostgreSQL/MySQL string function. SQLite has no `LEFT()` built-in.
All occurrences replaced with the SQLite-native equivalent `SUBSTR(col, 1, n)`.

Affected query areas:
- Rent month matching (reconciliation.js ×4)
- Trend chart date grouping (reports.js ×6, uses LEFT(col,10))
- Dashboard rent payment lookup (dashboard.js ×1)

---

## Fix 3 — Negative outstanding amounts in reconciliation display
**File:** frontend/reconciliation.html  (19 display guards added)

**Root cause:** Reconciliation uses a date-range filter. Accruals and payments
are summed independently within that range. If a payment was recorded in a
different period than when the wages were earned (e.g. March wages paid in
April), filtering for April shows: paid > accrued → balance = negative.

**What was broken:** Every "Outstanding" KPI card, every individual
worker/supplier balance card, and the printed statement table showed raw
negative values (e.g. "KES -250.00") under headings like "Outstanding" and
"Balance Due" — which is meaningless and looks like corrupt data.

**Fix:** `fmt(balance, 2)` → `fmt(Math.max(0, balance), 2)` on every
display-only context that represents an outstanding/owed amount.
The underlying `_summary` data is completely untouched. Calculation logic,
Pay button amounts, overpayment guards, and all backend logic are unchanged.

---

## What was NOT changed
- Zero business logic
- Zero database schema
- Zero route structure or auth
- Zero calculation formulas
- The `toSQLite()` transformer in sqlite-schema.js (unchanged, still a safety net)
