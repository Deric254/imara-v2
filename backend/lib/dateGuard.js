// backend/lib/dateGuard.js
//
// Single source of truth for "is this date in the future?" — used everywhere
// a date represents something that has already happened (a sale, a purchase,
// production, an order being placed, a payment being received, an invoice
// being issued). None of those can honestly be dated after today, so none of
// them should be accepted with a future date.
//
// Deliberately NOT used for due_date — a due date is a deadline, and is
// supposed to be in the future.

// Server's local calendar date as YYYY-MM-DD, matching how dates are stored
// and compared throughout the app (localDateString() on the frontend).
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Plain YYYY-MM-DD strings compare correctly with a simple string comparison,
// with no timezone parsing pitfalls.
function isFutureDate(dateStr) {
  if (!dateStr) return false;
  const s = String(dateStr).slice(0, 10);
  return s > todayStr();
}

module.exports = { todayStr, isFutureDate };
