# Payroll (B4)

Staff-only feature in the studio app: **Cover** and **Payroll** in the nav, plus a Payroll tab in Settings and a clock widget.

- **Cover (sub requests)**: an instructor (or owner/manager for them) posts a class, eligible staff claim it, the owner or a manager approves and the class's instructor changes. Optional auto-approve in Cover settings. Claims turned down can't be re-claimed; classes that start uncovered expire.
- **Pay rules** (owner only, per person): `flat` per class, `per_head` (base + per attendee above N), `tiered` by attendance, `hourly`, `session` (private/appointment work by session-type key, per session or per hour). A rule can be limited to one class type. Old per-class pay on the staff record is the fallback.
- **Timesheets**: clock in/out (front desk and anyone with an hourly rule), or typed-in shifts and sessions. Owner approves; pending entries aren't counted.
- **Pay periods**: weekly or fortnightly from an anchor date. Pay comes from finished classes with check-ins, approved hours and adjustments. Marking a period paid saves a snapshot (rule changes don't alter it); owner can reopen.
- **Export**: Xero-friendly CSV, one row per person and earnings rate: Employee, Earnings rate, Hours / units, Rate, Amount.

Code: `src/features/payroll/` (`calc.ts` is shared by demo and live), SQL `supabase/migrations/1400_*`, `1401_*`, tests `supabase/tests/payroll_flow.sql` and `tests/payroll.test.ts`.
Permissions: `payroll.view/manage/rules/timesheets/timesheets_approve/cover/cover_approve/clock`.
