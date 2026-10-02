# Database

`schema.sql` is the baseline from the build pack, kept for reference. The source of truth is
`migrations/NNNN_name.up.sql` / `.down.sql`, applied in order by `pnpm db:migrate` (one
transaction per file, tracked in `schema_migrations`). `pnpm db:rollback` reverts the latest one.

## Deviations from `schema.sql` (fixed in M0)

| Where | Problem in baseline | Fix |
| --- | --- | --- |
| `audit_no_update` trigger | Created before `audit_log` existed, so `schema.sql` fails to apply | Moved to `0005_ops` after the table |
| `opt_outs` | `primary key (customer_id, merchant_id)` forbids `merchant_id = null`, so the documented global opt-out could never be stored | Surrogate `id` plus `unique nulls not distinct (customer_id, merchant_id)` |
| `ledger_entries`, `audit_log` | Append-only trigger did not cover `TRUNCATE` | Added statement-level `before truncate` triggers |

Not yet done (tracked for M9): Postgres RLS policies by `app.merchant_id` as defence in depth.
