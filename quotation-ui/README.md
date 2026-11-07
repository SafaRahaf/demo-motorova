# aiContext.md — NerveCenter: Quotation, Negotiation & Payments

**Product:** Garage Management System — the quote → negotiation → invoice → payment → refund slice only.
**Purpose of this file:** a complete build contract. Hand this single file to an agent and it should be able to
scaffold the whole slice (schema, API, UI) without inventing business rules.

**Version 2** — rewritten after a clickable HTML/CSS prototype was built and reviewed. Everything in this file
describes behaviour that is already proven in that prototype, plus the decisions taken since.

---

## 0. How to use this file

1. Read the whole file before writing code. Do not re-litigate decisions marked **LOCKED**.
2. Generate the database schema/migrations exactly as specified in §4. Column names, enums and constraints are the contract.
3. Implement the shared rules package (§9.3) **first**, with the tests in §7 passing. Money logic must exist in exactly one place.
4. Then the API (§5), then the web UI (§6).
5. Never compute money, balances or statuses in the client. Never accept a total from a request body.
6. If something genuinely isn't covered here, **ask** — do not invent a rule. Ambiguity in money rules is a bug.

---

## 1. Scope

### In scope

- Jobs (a vehicle + a customer + a workflow state).
- Quotes, quote revisions, negotiation, conditions, expiry.
- Mid-job change orders (supplementary quotes) with dependency pausing.
- Documents: proforma, tax invoice (versioned, voidable), warranty invoice.
- Payments (deposit / standard / milestone), receipts, outstanding balance.
- Refunds (requested or proactive) and credit notes.
- Job cancellation → settlement quote → settlement invoice, including package unbundling.
- Daily storage fees, vehicle hold (mechanic's lien).
- Warranty / zero-dollar rework.
- Tax engine: per-line snapshots, versioned rates, percent/fixed, inclusive/exclusive.
- Service catalog (price + default tax per service).
- Append-only audit trail, customer notifications.

### Out of scope (do not build)

Inventory/parts stock, employee scheduling, payroll, appointments, multi-branch accounting, tax filing,
payment-gateway integration (simulate the charge), PDF rendering service (emit a print-ready HTML view instead),
inventory-driven line items, multi-currency (one currency per garage), i18n.

---

## 2. Actors, roles and access

### 2.1 Roles

`app_user.role` ∈ `MANAGER` | `STAFF` | `CUSTOMER`.

| Role       | Can do                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANAGER`  | everything a STAFF can, plus: void an invoice, issue/approve refunds, change tax rates, deactivate catalog services                                  |
| `STAFF`    | create/edit/send quotes, record customer decisions, generate documents, take payments, add storage fees, create warranty/settlement quotes           |
| `CUSTOMER` | view own jobs/quotes/invoices, accept/reject/counter a quote, add conditions, pay, request a refund, request cancellation, view receipts _(Phase 2)_ |

### 2.2 **Phase 1 = garage panel only** (LOCKED)

There is no customer login in Phase 1. The customer walks into the garage, receives quotes by email/print,
and the garage **records the customer's decision**.

- Every decision stores **whose decision it was** (`actor_role = CUSTOMER`) **and who recorded it**
  (`recorded_by_user_id = <staff>`). This keeps the audit trail legally meaningful.
- Statuses keep their original meaning: `PENDING_CUSTOMER_APPROVAL` = _"sent to the customer, waiting for their answer."_
- The customer still exists as a record (`app_user.role = CUSTOMER`, `password_hash = NULL`) and **receives notifications** (§4.19).
- The API is designed so Phase 2 only changes _authorization_, not schema: the same `POST /quotes/:id/accept`
  is used by the garage today (recording the customer's answer) and by the customer portal later.

### 2.3 Phase 2 (later, no schema change)

Customer portal: same endpoints with `actor_role = CUSTOMER` and `recorded_by_user_id = NULL` (self-service),
scoped to their own jobs. UI copy differs: the customer sees **"Bill"**, the garage sees **"Invoice"**.

### 2.4 Authorization rules

- Staff can only touch rows of their own `garage_id`.
- Customer (Phase 2) can only touch jobs where `job.customer_user_id = current_user.id`.
- A customer may only perform: accept, reject, counter-offer, add condition, pay, request refund, request cancellation, read.
- Server-side checks are mandatory for every state transition. The UI is a hint, never the authority.

---

## 3. Domain rules (the contract)

### 3.1 Money

- **All money is an integer in minor units** (cents). Column suffix `_minor`, type `BIGINT`. No floats, ever.
- Currency comes from `garage.currency`; format at render time only.
- Rounding: `Math.round` per line, then sum. Never round a total that was produced by summing rounded lines.
- `balance = total − amount_paid`, floored at 0.
- A refund returns money but **never re-opens a debt**: `total` is unchanged, and `amount_paid` keeps counting the
  original payment. The refund is shown separately and emits a credit note.

### 3.2 Tax

- Each quote line and invoice line **stores a snapshot**: `tax_id, tax_code, tax_name, tax_kind, tax_value, tax_inclusive`.
  Re-rating a tax can never change an issued document.
- Tax rows are **immutable**. Changing a rate = deactivate the old row (`active=0`, `effective_to`) and insert a new
  row (`superseded_by_id` points at the new one). Documents keep pointing at the old row.
- `PERCENT` value is stored in **basis points** (`800` = 8.00%). `FIXED` value is stored in **minor units per unit**
  (`500` = $5.00 per unit, multiplied by quantity).
- Inclusive taxes are extracted from the price; exclusive taxes are added on top.
- Default tax per line type (`LABOR`, `PART`, `SERVICE`, `FEE`) comes from `tax.applies_to`; every line may override.
- Line maths (the only implementation, in `packages/rules`):

```
gross = round(qty * unit_price_minor)
if no tax            -> { net = gross, tax = 0 }
if PERCENT exclusive -> { net = gross,   tax = round(gross * bp / 10000) }
if PERCENT inclusive -> { net = round(gross / (1 + bp/10000)), tax = gross - net }
if FIXED             -> { net = gross,   tax = round(tax_value_minor * qty) }

docTotals = { subtotal = Σ net, tax_total = Σ tax, total = subtotal + tax_total, taxes[] grouped by tax_id }
```

### 3.3 Quotes and negotiation

- Quote `type` ∈ `STANDARD` | `SUPPLEMENTARY` | `SETTLEMENT` | `WARRANTY`.
- Quote `status` ∈ `DRAFT` | `PENDING_GARAGE_APPROVAL` | `PENDING_CUSTOMER_APPROVAL` | `ACCEPTED` | `REJECTED` | `EXPIRED` | `WITHDRAWN`.
- Either side can create a quote (garage after inspection; customer as a Request-for-Quote with a budget note).
- Actions: **accept** (locks), **reject**, **counter-offer** (edit → new revision → back to the other party),
  **add condition** (free text, attributed, timestamped).
- Every save after the first send **increments `revision`** and appends a `quote_revision` row
  (`total_minor`, `source`, `reason_code`, `note`, `by_user_id`, `at`).
- **Acceptance records the revision accepted** (`accepted_revision`) — the paper trail must say _which version_ was agreed.
- Accepted quotes are locked (`locked_at`). Changing agreed work requires a new quote/revision, never an edit.
- `expiry_date` in the past → status `EXPIRED`; an expired quote cannot be accepted.
- Quote totals are derived from items; `quote.total_minor` is a cached convenience column, recomputed by the rules package.

### 3.4 Mid-job change orders

- Garage creates a `SUPPLEMENTARY` quote linked via `parent_quote_id`, flagged `is_change_order = 1`.
- **Independent** (`has_dependency = 0`): accepted → merges into the invoice as add-on lines. Rejected → approved work continues, nothing pauses.
- **Dependency** (`has_dependency = 1`): job → `PAUSED_PENDING_APPROVAL`; accepted → job resumes (`IN_PROGRESS`);
  rejected → job **stays paused** and the garage must agree a way forward.
- Accepted add-ons appear on the invoice flagged `is_addon = 1` and are listed separately in the itemization.

### 3.5 Documents

Single DB model `invoice`. `kind` ∈ `PROFORMA` | `TAX_INVOICE` | `WARRANTY`.

| Kind          | Payable | Balance  | Vehicle hold | Notes                                                                                                         |
| ------------- | ------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `PROFORMA`    | no      | always 0 | never        | informational; auto-`SUPERSEDED` when a tax invoice is issued; never converted, a new `INV-` number is issued |
| `TAX_INVOICE` | yes     | yes      | yes          | the real, versioned, voidable document                                                                        |
| `WARRANTY`    | no      | 0        | never        | zero-dollar rework proof, links `original_invoice_id`                                                         |

- **Nothing is created automatically** when a quote is accepted. The garage explicitly generates a proforma or a
  tax invoice (job moves to `AWAITING_INVOICE` on acceptance).
- **Stale detection**: compare the live invoice's lines to all accepted work (settlement or standard + add-ons).
  If the totals/line counts differ, the job is flagged _"accepted work not yet billed"_; regeneration stays a deliberate click.
- `invoice.subtotal/tax_total/total` are recomputed from `invoice_line` by the rules package — never set by a request.
- Label rule: garage UI says **"Invoice"**, customer UI says **"Bill"**. The row is always `invoice`.

### 3.6 Invoice versioning and voiding (LOCKED — implement exactly)

Problem 1: the document is wrong → **void**. Problem 2: the document is out of date → **new version**.

| Situation                                                           | Required behaviour                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment recorded, `garage.reissue_invoice_on_payment = 1` (default) | Insert a **new** `TAX_INVOICE` with `seq = previous.seq + 1`, `supersedes_id = previous.id`, same lines (fresh line ids), recalculate; then set the previous row `status='VOID'`, `voided_at`, `void_reason = 'Superseded by INV-####'`, `superseded_by_id = new.id`. Log both events. |
| Payment recorded, `reissue_invoice_on_payment = 0`                  | Update the existing invoice in place (lines unchanged) and recalculate. No version, no void.                                                                                                                                                                                           |
| Manual void by MANAGER, `amount_paid = 0`                           | `status='VOID'`, `voided_at`, `void_reason` (required, free text), `superseded_by_id` stays `NULL`. No replacement is created. If no live tax invoice remains: job → `AWAITING_INVOICE`, `paused_reason` explains it.                                                                  |
| Manual void when `amount_paid > 0`                                  | **Refuse** (`422 INVOICE_HAS_PAYMENTS`). Paid paper is replaced by a version, never voided.                                                                                                                                                                                            |
| Any payment against a `VOID` invoice                                | **Refuse** (`422 INVOICE_VOID`). Void invoices are also excluded from any "payable" UI.                                                                                                                                                                                                |
| Regenerate after a manual void                                      | New invoice number; `seq` continues from the last version; `supersedes_id` = the void invoice                                                                                                                                                                                          |
| Reading a void invoice                                              | Read-only, watermarked **"Void — not payable"**, totals frozen at the values it had when voided                                                                                                                                                                                        |
| Credit note for a refund                                            | Always attaches to the **live** invoice (`stdInvoice(jobId) ?? original`)                                                                                                                                                                                                              |
| Receipts                                                            | Exactly **one `VALID` receipt per job**; earlier receipts become `VOID` with `superseded_by_id`                                                                                                                                                                                        |

Additional invariants:

- **One live tax invoice per job** (`status <> 'VOID'`). Enforced by a filtered unique index, not just code.
- A `VOID` invoice is **frozen**: recalculation must return early for it, so `total/amount_paid/balance` never change again.
- Voiding never deletes a row and never reuses a document number.
- `amount_paid` is **job-wide** (sum over all versions), so paid-to-date spans versions and the new version shows the correct balance.

### 3.7 Payments and receipts

- Payments are only accepted against a live `TAX_INVOICE` (not proforma, not warranty, not void).
- `amount = min(requested, balance)`; `amount <= 0` → refuse (`422 NOTHING_TO_PAY`). Request bodies never set balances.
- `type` ∈ `DEPOSIT` | `STANDARD` | `MILESTONE`; `method` ∈ `CARD` | `BANK_TRANSFER` | `CASH` | `ONLINE`.
- Deposit is set on the quote: `NONE` | `PERCENT` (of total) | `FLAT` (minor units). Stored on the invoice as `deposit_required_minor`.
- Paying at least `deposit_required_minor` moves the job `AWAITING_DEPOSIT → IN_PROGRESS`.
- Reaching `balance = 0` logs `HOLD_RELEASED`, clears `vehicle_hold`, and marks the invoice `PAID`.
- On success: create `receipt` (`status='VALID'`, `paid_to_date_minor`, `balance_after_minor`, `emailed_to`) and queue a notification.
- Payments require an **`Idempotency-Key`** header; replays return the original result (never a second version).

### 3.8 Refunds and credit notes

- `refund.amount <= payment.amount − already_requested_or_refunded`. Otherwise `422 REFUND_EXCEEDS_PAYMENT`.
- `type` = `FULL` when the amount equals the payment, else `PARTIAL`.
- Statuses: `REQUESTED → PROCESSING → COMPLETED`, or `REQUESTED → DECLINED`. Garage may also issue directly (`COMPLETED`).
- **Completing a refund always creates a credit note** (`CN-####`, linked to the live invoice) and updates the payment
  to `PARTIALLY_REFUNDED` or `REFUNDED`.
- Refunds never reduce `total` and never re-open a debt.

### 3.9 Cancellation and settlement

- Customer (or staff on their behalf) raises a cancellation request → job immediately `PAUSED_PENDING_CANCELLATION`, logged.
- Garage either **declines** (job resumes `IN_PROGRESS`) or creates a `SETTLEMENT` quote.
- Settlement lines may include: prorated labour (hours × rate), parts already installed, and a **restocking fee**
  line (`kind='RESTOCKING_FEE'`, non-taxable).
- **Package unbundling**: when settling a bundled package, replace the discounted package price with
  `standalone_unit_price_minor` for the services actually completed; only for completed work.
- Accepting the settlement: job → `CANCELLED`, cancellation → `AGREED`, settlement quote becomes the base for the invoice
  (settlement takes precedence over the standard quote in `buildLines`).
- Rejecting the settlement returns the cancellation to `UNDER_REVIEW` (renegotiate).

### 3.10 Storage fees and vehicle hold

- Storage fee = `days × garage.storage_daily_rate_minor`, appended to the **live invoice** as a non-taxable `FEE` line;
  also recorded in `storage_fee`. Recalculation keeps the balance correct.
- Reminder rule (job-level, surfaced in the UI): if the job has been paused awaiting approval for more than
  `garage.storage_grace_days`, or the vehicle is repaired but uncollected, offer "Add storage fee".
- `vehicle_hold` is **derived**, never set by hand: `kind='TAX_INVOICE' AND status<>'VOID' AND balance > 0`.
  It must be `false` for proformas, warranty documents, settled and voided invoices.
- UI must show a prominent hold banner while true: _"Keys and vehicle must not be released."_

### 3.11 Warranty and rework

- Garage creates a `WARRANTY` quote copied from the accepted work with `unit_price_minor = 0` and
  `unit_price_original_minor` preserved (rendered struck through).
- Accepting it allows generating a `WARRANTY` invoice: kind `WARRANTY`, `original_invoice_id` set, total 0,
  `status = PAID`, `amount_paid = 0`, `balance = 0`, no hold, no payments possible.

### 3.12 Audit trail (append-only)

- Table `audit_event`: `{ garage_id, job_id, quote_id?, invoice_id?, actor_user_id?, actor_role, action, note, amount_before_minor?, amount_after_minor?, created_at }`.
- **No UPDATE, no DELETE** (enforce with a DB permission/trigger). This is the dispute record.
- A `negotiation_log` **view** over `audit_event` is provided for reporting (quote actions only).
- Action vocabulary (use exactly): `QUOTE_CREATED`, `QUOTE_SENT`, `QUOTE_REVISED`, `QUOTE_ACCEPTED`, `QUOTE_REJECTED`,
  `CONDITION_ADDED`, `JOB_PAUSED`, `JOB_RESUMED`, `AWAITING_INVOICE`, `PROFORMA_ISSUED`, `INVOICE_ISSUED`,
  `INVOICE_UPDATED`, `INVOICE_VOIDED`, `INVOICE_REISSUED`, `PAYMENT_RECEIVED`, `HOLD_RELEASED`, `REFUND_REQUEST`,
  `REFUND_APPROVED`, `REFUND_DECLINED`, `REFUND_ISSUED`, `CREDIT_NOTE`, `CANCEL_REQUEST`, `CANCEL_DECLINED`,
  `SETTLEMENT_SENT`, `SETTLEMENT_AGREED`, `STORAGE_FEE`, `TAX_CREATED`, `TAX_VERSION`, `TAX_DEACTIVATED`,
  `SERVICE_CREATED`.

### 3.13 Guards — the API must refuse these

- Pay a proforma, a warranty document, or a void invoice.
- Void an invoice that has payments.
- Refund more than the payment holds.
- Create an invoice before a quote is accepted.
- Accept an expired or already-accepted quote.
- Change an issued document by any means other than: version it, void it, or regenerate it (with the audit event).
- Store a client-supplied total, balance, status or tax amount.

---

## 4. Database schema (contract)

### 4.0 Conventions

- PK `id` = `UUID` (`NEWSEQUENTIALID()` on SQL Server, `gen_random_uuid()` on Postgres).
- Money: `BIGINT` minor units, suffix `_minor`. Percent: basis points. Qty: `DECIMAL(9,2)`.
- Time: `DATETIME2(3)` UTC, suffix `_at`. Dates that matter for expiry: `DATETIME2` (end-of-day UTC).
- Enums: `VARCHAR(32)` + `CHECK` constraint (portable and readable). Enum values are listed below verbatim.
- Every business table carries `garage_id` for tenant scoping; child tables may derive it but keep it for index speed.
- `created_at` / `updated_at` on every table. No hard deletes on business tables; catalog rows use `is_active`.
- Document numbers are per garage, from a transactional `number_sequence` (§4.21). Never from the client.

### 4.1 `garage`

`id, name, currency CHAR(3), timezone, default_deposit_type, default_deposit_value, reissue_invoice_on_payment BIT DEFAULT 1, storage_daily_rate_minor BIGINT, storage_grace_days INT, created_at, updated_at`

### 4.2 `app_user`

`id, garage_id, role CHECK IN ('MANAGER','STAFF','CUSTOMER'), name, email, phone NULL, password_hash NULL, is_active BIT, created_at, updated_at`
`UNIQUE (garage_id, email)`. Phase 1: `CUSTOMER` rows have `password_hash = NULL`.

### 4.3 `vehicle`

`id, garage_id, customer_user_id FK app_user, make, model, year INT, plate, vin, odometer INT, created_at, updated_at`
`UNIQUE (garage_id, vin)` where vin is present.

### 4.4 `job`

`id, garage_id, job_no VARCHAR(32), customer_user_id, vehicle_id, status, paused_reason TEXT NULL, depends_on_quote_id UUID NULL, created_at, opened_at, closed_at NULL, updated_at`
`status` ∈ `REQUESTED` | `QUOTING` | `AWAITING_INVOICE` | `AWAITING_DEPOSIT` | `IN_PROGRESS` | `PAUSED_PENDING_APPROVAL` | `PAUSED_PENDING_CANCELLATION` | `WORK_COMPLETE` | `CANCELLED` | `CLOSED`
`UNIQUE (garage_id, job_no)`

### 4.5 `quote`

`id, garage_id, job_id, quote_no, type, status, created_by_user_id, parent_quote_id NULL, original_invoice_id NULL, has_dependency BIT, is_change_order BIT, deposit_type CHECK IN ('NONE','PERCENT','FLAT'), deposit_value INT, expiry_date, revision INT DEFAULT 0, accepted_revision INT NULL, subtotal_minor, tax_total_minor, total_minor, created_at, accepted_at NULL, rejected_at NULL, locked_at NULL, invoiced_at NULL, updated_at`
`type` ∈ `STANDARD` | `SUPPLEMENTARY` | `SETTLEMENT` | `WARRANTY`
`status` ∈ `DRAFT` | `PENDING_GARAGE_APPROVAL` | `PENDING_CUSTOMER_APPROVAL` | `ACCEPTED` | `REJECTED` | `EXPIRED` | `WITHDRAWN`
`UNIQUE (garage_id, quote_no)`

### 4.6 `quote_item`

`id, quote_id, garage_id, kind CHECK IN ('LABOR','PART','SERVICE','FEE','RESTOCKING_FEE'), description, qty DECIMAL(9,2), unit_price_minor, unit_price_original_minor NULL, service_id NULL, package_ref NULL, standalone_unit_price_minor NULL, tax_id NULL, tax_code NULL, tax_name NULL, tax_kind CHECK IN ('PERCENT','FIXED') NULL, tax_value INT NULL, tax_inclusive BIT, line_total_minor, sort_order INT`
Tax columns are the **snapshot**. `line_total_minor` = `round(qty * unit_price_minor)` (pre-tax).

### 4.7 `quote_condition`

`id, quote_id, garage_id, text, added_by_user_id, actor_role, created_at`
Append-only.

### 4.8 `quote_revision`

`id, quote_id, garage_id, revision_no INT, subtotal_minor, tax_total_minor, total_minor, source CHECK IN ('GARAGE','CUSTOMER_REQUEST'), reason_code NULL, note NULL, by_user_id, created_at`
`reason_code` ∈ (nullable) `INTERNAL_REPRICING` | `PARTS_PRICE` | `CUSTOMER_DISCOUNT` | `CUSTOMER_SCOPE_REMOVED` | `SCOPE_ADDED` | `GOODWILL`
`UNIQUE (quote_id, revision_no)` — this table is _why_ the number moved; render it, never recompute it.

### 4.9 `tax`

`id, garage_id, code, name, kind, value INT, inclusive BIT, applies_to VARCHAR(64) /*csv of LABOR,PART,SERVICE,FEE*/, effective_from, effective_to NULL, active BIT, superseded_by_id NULL, created_at`
Rows are immutable: no UPDATE of `value`/`kind`. Change = deactivate + insert new row.
`UNIQUE (garage_id, code, effective_from)`

### 4.10 `service` (catalog)

`id, garage_id, name, category, price_minor, tax_code, unit, is_active BIT, created_at, updated_at`

### 4.11 `invoice`

`id, garage_id, job_id, quote_id, invoice_no, kind, status, seq INT, supersedes_id NULL, superseded_by_id NULL, voided_at NULL, void_reason TEXT NULL, original_invoice_id NULL /*warranty*/, settlement_quote_id NULL, deposit_required_minor, deposit_type, deposit_value, issued_at, due_at, subtotal_minor, tax_total_minor, total_minor, amount_paid_minor, amount_refunded_minor, balance_minor, vehicle_hold BIT, triggering_payment_id NULL, created_at, updated_at`
`kind` ∈ `PROFORMA` | `TAX_INVOICE` | `WARRANTY`
`status` ∈ `DRAFT` | `ISSUED` | `UNPAID` | `PARTIALLY_PAID` | `PAID` | `REFUNDED` | `SUPERSEDED` | `VOID`
Constraints:

- `UNIQUE (garage_id, invoice_no)`
- `UNIQUE (job_id, kind, seq)`
- **`CREATE UNIQUE INDEX uq_invoice_live_tax ON invoice(job_id) WHERE kind='TAX_INVOICE' AND status <> 'VOID'`**
  (SQL Server filtered index / Postgres partial index — this is what enforces "one live invoice per job")
- `CHECK (balance_minor >= 0 AND amount_paid_minor >= 0 AND total_minor >= 0)`

### 4.12 `invoice_line`

`id, invoice_id, garage_id, quote_item_id NULL, quote_type NULL, description, qty, unit_price_minor, tax_* snapshot columns (same as quote_item), line_total_minor, is_addon BIT, sort_order INT`
Stored as a **copy** — invoice lines never reference live quote rows for money.

### 4.13 `payment`

`id, garage_id, invoice_id, payment_no, amount_minor, type, method, status, idempotency_key VARCHAR(64) NULL, paid_at, created_at`
`status` ∈ `PENDING` | `SUCCEEDED` | `FAILED` | `PARTIALLY_REFUNDED` | `REFUNDED`
`UNIQUE (garage_id, payment_no)`, `UNIQUE (garage_id, idempotency_key)` where not null.

### 4.14 `receipt`

`id, garage_id, payment_id, invoice_id, job_id, receipt_no, status CHECK IN ('VALID','VOID'), issued_at, emailed_to, paid_to_date_minor, balance_after_minor, superseded_by_id NULL, voided_at NULL`
**`CREATE UNIQUE INDEX uq_receipt_valid_job ON receipt(job_id) WHERE status='VALID'`** — one valid receipt per job.
`UNIQUE (garage_id, receipt_no)`

### 4.15 `refund`

`id, garage_id, payment_id, invoice_id, amount_minor, type CHECK IN ('FULL','PARTIAL'), reason, status, requested_by_user_id NULL, decided_by_user_id NULL, created_at, decided_at NULL, credit_note_id NULL`
`status` ∈ `REQUESTED` | `PROCESSING` | `COMPLETED` | `DECLINED`

### 4.16 `credit_note`

`id, garage_id, invoice_id /*live version*/, refund_id, credit_note_no, amount_minor, reason, issued_at`
`UNIQUE (garage_id, credit_note_no)`

### 4.17 `cancellation_request`

`id, garage_id, job_id, reason, status CHECK IN ('REQUESTED','UNDER_REVIEW','SETTLEMENT_SENT','AGREED','DECLINED','WITHDRAWN'), requested_by_user_id NULL, settlement_quote_id NULL, created_at, resolved_at NULL`

### 4.18 `storage_fee`

`id, garage_id, job_id, invoice_id, days INT, rate_minor, amount_minor, created_at`

### 4.19 `notification`

`id, garage_id, job_id NULL, recipient_user_id, channel CHECK IN ('EMAIL','SMS','IN_APP'), template, payload_json, status CHECK IN ('QUEUED','SENT','FAILED'), created_at, sent_at NULL, error TEXT NULL`
Written **inside the same transaction** as the triggering action (transactional outbox); a worker sends it.
Phase 1 customer-facing notifications: `QUOTE_SENT`, `QUOTE_REVISED`, `CHANGE_ORDER_CREATED`, `INVOICE_ISSUED`,
`PAYMENT_RECEIPT`, `REFUND_DECIDED`, `CANCELLATION_RECEIVED`, `SETTLEMENT_SENT`.

### 4.20 `audit_event` (+ `negotiation_log` view)

`id BIGINT IDENTITY, garage_id, job_id, quote_id NULL, invoice_id NULL, actor_user_id NULL, actor_role CHECK IN ('GARAGE','CUSTOMER','SYSTEM'), action VARCHAR(48), note TEXT, amount_before_minor NULL, amount_after_minor NULL, created_at`
Index `(job_id, created_at)`. Append-only. View `negotiation_log` = `audit_event` filtered to quote actions,
exposing `(id, quote_id, actor_id, action, notes, timestamp)` for the original reporting requirement.

### 4.21 `number_sequence`

`garage_id, doc_type CHECK IN ('JOB','QUOTE','PROFORMA','INVOICE','PAYMENT','RECEIPT','CREDIT_NOTE'), next_value INT`
Increment inside the same transaction as the insert (`UPDATE ... OUTPUT` / `SELECT ... FOR UPDATE`). Numbers are never reused.

### 4.22 Derived values — compute in exactly one place

| Value                              | Definition                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quote.subtotal/tax_total/total`   | `docTotals(quote_item)`                                                                                                                                                |
| `invoice.subtotal/tax_total/total` | `docTotals(invoice_line)`                                                                                                                                              |
| `invoice.amount_paid_minor`        | `SUM(payment.amount_minor)` for the **job**, status in (`SUCCEEDED`,`PARTIALLY_REFUNDED`,`REFUNDED`), across **all invoice versions**                                  |
| `invoice.amount_refunded_minor`    | `SUM(refund.amount_minor)` for the job, status `COMPLETED`                                                                                                             |
| `invoice.balance_minor`            | `max(0, total − amount_paid)`                                                                                                                                          |
| `invoice.status`                   | `total = 0` → `PAID`; `balance = 0` → `PAID` (or `REFUNDED` when refunded ≥ paid); `paid > 0` → `PARTIALLY_PAID`; else `UNPAID`. `VOID` and `SUPERSEDED` short-circuit |
| `invoice.vehicle_hold`             | `kind='TAX_INVOICE' AND status<>'VOID' AND balance > 0`                                                                                                                |
| `PROFORMA`                         | `amount_paid=0, refunded=0, balance=0, vehicle_hold=0`, status `ISSUED` unless `SUPERSEDED`/`VOID`                                                                     |
| `WARRANTY`                         | `amount_paid=0, refunded=0, balance=0, status=PAID, vehicle_hold=0`                                                                                                    |
| `VOID`                             | **frozen** — recalculation returns immediately, no field changes                                                                                                       |

Implement `recalcInvoice(invoiceId)` and `recalcQuote(quoteId)` as idempotent functions in `packages/rules`, called
inside the transaction that triggered the change. No other code may write these columns.

### 4.23 `buildLines(jobId)` — what goes on an invoice

1. `base` = accepted `SETTLEMENT` quote **if present**, else accepted `STANDARD` quote.
2. `addons` = all accepted `SUPPLEMENTARY` quotes (in acceptance order).
3. Lines = base lines, then add-on lines flagged `is_addon = 1`.
4. `WARRANTY` quotes are never merged; they produce their own document.

### 4.24 Legacy migration notes (.NET / SQL Server → new schema)

- Backfill `invoice.seq = 1`, `supersedes_id = NULL` for all existing rows.
- Map legacy "Cancelled"/"Void" statuses to `VOID` deliberately and record the mapping in a migration note; keep numbers.
- Legacy deposits/balances: recompute from payments during migration; do not trust denormalised legacy totals.
- Do not delete legacy rows: import them, then void what must be voided (with a migration reason).
- Accept that historical invoices may violate "one live invoice per job"; resolve manually before adding the filtered index.

---

## 5. API surface (REST, JSON, `/api/v1`)

Auth: `POST /auth/login` (staff, email+password → httpOnly cookie/JWT), `POST /auth/logout`, `POST /auth/refresh`.
Phase 2 adds `POST /auth/customer/login` (or magic link) and the same authorization checks with a customer principal.

| #   | Method & path                                                                                     | Purpose                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `GET /jobs` · `POST /jobs` · `GET /jobs/:id`                                                      | list / intake (customer + vehicle) / detail with tab aggregates                  |
| 2   | `GET /jobs/:id/invoice-status`                                                                    | stale check: `{ needsUpdate, deltaMinor, lineDelta }`                            |
| 3   | `POST /jobs/:id/quotes` `{ type }`                                                                | create quote (opens builder)                                                     |
| 4   | `GET /jobs/:id/quotes` · `GET /quotes/:id`                                                        | list / detail with items, conditions, revisions                                  |
| 5   | `PATCH /quotes/:id` `{ depositType, depositValue, hasDependency }`                                | draft-level settings                                                             |
| 6   | `POST /quotes/:id/items` · `PATCH /quotes/:id/items/:itemId` · `DELETE /quotes/:id/items/:itemId` | builder lines                                                                    |
| 7   | `POST /quotes/:id/conditions` `{ text }`                                                          | add condition (attributed)                                                       |
| 8   | `POST /quotes/:id/send`                                                                           | `DRAFT → PENDING_CUSTOMER_APPROVAL`, revision++, notification                    |
| 9   | `POST /quotes/:id/revisions` `{ reasonCode?, note? }`                                             | counter-offer / revise: revision++, back to the other party                      |
| 10  | `POST /quotes/:id/accept` `{ acceptedRevision? }`                                                 | locks; records actor + revision                                                  |
| 11  | `POST /quotes/:id/reject` `{ reason? }`                                                           | reject; job effects per type                                                     |
| 12  | `POST /jobs/:id/proforma`                                                                         | issue proforma                                                                   |
| 13  | `POST /jobs/:id/invoice`                                                                          | generate **or** update the live tax invoice (warranty handled first if accepted) |
| 14  | `POST /invoices/:id/void` `{ reason }`                                                            | MANAGER only; refuses when paid                                                  |
| 15  | `GET /invoices/:id` · `GET /jobs/:id/invoices`                                                    | document + version history                                                       |
| 16  | `POST /invoices/:id/payments` `{ amountMinor, type, method }` + `Idempotency-Key`                 | take payment (may reissue invoice)                                               |
| 17  | `GET /jobs/:id/payments` · `GET /receipts/:id`                                                    | ledger / receipt                                                                 |
| 18  | `POST /payments/:id/refunds` `{ amountMinor, reason }`                                            | request a refund                                                                 |
| 19  | `POST /refunds/:id/approve` · `/decline` · `/complete`                                            | garage decision; complete emits the credit note                                  |
| 20  | `POST /payments/:id/refunds/direct` `{ amountMinor, reason }`                                     | garage-issued refund (completes immediately)                                     |
| 21  | `POST /jobs/:id/cancellation-requests` `{ reason }`                                               | pause the job                                                                    |
| 22  | `POST /cancellation-requests/:id/decline`                                                         | resume the job                                                                   |
| 23  | `POST /jobs/:id/settlement-quotes` `{ hours, restockMinor, unbundle }`                            | build a `SETTLEMENT` quote                                                       |
| 24  | `POST /jobs/:id/storage-fees` `{ days }`                                                          | append fee to the live invoice                                                   |
| 25  | `GET /taxes` · `POST /taxes` · `POST /taxes/:id/supersede` · `POST /taxes/:id/deactivate`         | versioned tax rates                                                              |
| 26  | `GET /services` · `POST /services` · `PATCH /services/:id` · `DELETE /services/:id`               | catalog                                                                          |
| 27  | `GET /jobs/:id/audit`                                                                             | timeline                                                                         |
| 28  | `GET /notifications` (staff)                                                                      | outbox status for the demo                                                       |

**Request/response rules**

- Never accept `total`, `balance`, `amountPaid`, `status`, `lineTotal`, `taxAmount` in a body.
- All mutations return the recalculated aggregate (`job`, `quote` or `invoice`) so the UI never guesses.
- Errors: `{ error: { code, message, details? } }` with codes such as `INVOICE_VOID`, `INVOICE_HAS_PAYMENTS`,
  `PAYMENT_NOT_ALLOWED`, `NOTHING_TO_PAY`, `REFUND_EXCEEDS_PAYMENT`, `NO_ACCEPTED_QUOTE`, `QUOTE_LOCKED`,
  `QUOTE_EXPIRED`, `CONCURRENT_MODIFICATION` (409, include `expectedVersion`).
- Every state-changing transaction also writes `audit_event` (and a `notification` row where applicable).
- Optimistic concurrency: `updated_at`/`version` column on `quote`, `invoice`, `job`; mismatch → `409`.

---

## 6. UI / UX specification

### 6.1 Design tokens (copy verbatim)

```
--bg #f4f6f9   --surface #ffffff   --surface-2 #fafbfd
--ink #0f172a  --ink-2 #45536b     --muted #8b98ad
--line #e6eaf1 --line-strong #d5dce8
--brand #4f46e5  --brand-ink #3730a3  --brand-soft #eef1ff
--ok #087f5b    --ok-soft #e3f6ee
--warn #b45309  --warn-soft #fdf1d8
--danger #c02626 --danger-soft #fde8e8
--info #0b6fa4  --info-soft #e3f2fb
--violet #6d28d9 --violet-soft #f0e9ff
--neutral #5c6b82 --neutral-soft #eef1f5
radius 8 / 12 / 16px · font: system UI stack · base 14px/1.55
```

Plain CSS with tokens (no UI framework). Numbers use `font-variant-numeric: tabular-nums`.

### 6.2 Shell

- Top bar 60px: brand (mark + name + subtitle), garage name, user menu. _(Demo-only: "Reset demo".)_
- Sidebar 292px: section title + job list (job no, vehicle, status pill, hold tag, amount). Garage nav:
  **Jobs · Taxes · Catalog**.
- Main: padding `22px 26px 80px`. Breakpoint at `920px` → single column, sidebar collapses.

### 6.3 Screens

| Screen                          | Contents                                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Jobs** (sidebar)              | list with status pill, hold tag, amount; empty state                                                                                                                                                                              |
| **Job detail**                  | header (job no, garage, vehicle, plate, VIN, odometer, customer, status, paused reason) + 6 tabs                                                                                                                                  |
| Tabs                            | **Overview** (4 KPI cards, hold banner, cancellation panel, workflow explainer, quick actions) · **Quotes** · **Invoice** · **Payments** · **Refunds** · **Audit trail**                                                          |
| **Quote builder** (full screen) | left 336px sticky catalog (search + category chips + service rows + "create new service"), right lines table (editable description/qty/price/tax), totals, deposit control, dependency checkbox, footer: Back · Save draft · Send |
| **Taxes**                       | active table, history table (superseded rates), explainer banner                                                                                                                                                                  |
| **Catalog**                     | services grouped by category, edit/remove                                                                                                                                                                                         |
| _(Phase 2)_ **Customer portal** | my jobs → job → quote (accept/reject/counter/condition) → bill → pay → refund request → cancel request → receipts                                                                                                                 |

### 6.4 Components

- **KPI card**: uppercase 11px label, 22px value, hint line. Due values `--danger`, clear values `--ok`.
- **Banner**: variants `hold | warn | info | ok` (icon 15px + rich text). Hold = red, blocks vehicle release.
- **Pill**: dot + label, colour by status (map below). **Tag**: uppercase 10.5px chips for `Add-on`, `Settlement`, `Warranty`, `Blocking`, `Hold`, `incl.`
- **Table**: 11px uppercase headers on `--surface-2`, 13px cells, `.num` right-aligned tabular.
- **Totals block**: right-aligned max 340px; railed "Total" row; `Paid to date` in green; balance row highlighted (red when > 0, green at 0).
- **Timeline**: vertical rail, actor-coloured dot (garage brand / customer ok / system muted).
- **Empty state**: dashed card, title + one sentence + a primary action.
- **Modal**: backdrop blur, 520px card, Cancel + primary; destructive variants explain the consequence before confirming.
- **Toast**: bottom-right, 3.4s, colour per kind.
- **Version history table**: version · document · issued · voided · total then · paid then · reason · replaced by.
- **Void document**: muted, struck-through number, red "Void — not payable" banner, frozen totals, footer note "Frozen snapshot".

### 6.5 Status → label & colour

```
DRAFT neutral · PENDING_GARAGE_APPROVAL warn · PENDING_CUSTOMER_APPROVAL info
ACCEPTED ok · REJECTED danger · EXPIRED neutral · SUPERSEDED neutral · WITHDRAWN neutral
ISSUED info · UNPAID danger · PARTIALLY_PAID warn · PAID ok · REFUNDED violet · VOID neutral
REQUESTED info · PROCESSING warn · COMPLETED ok · DECLINED danger
SUCCEEDED ok · PARTIALLY_REFUNDED violet · FAILED danger · PENDING warn
QUOTING info · AWAITING_INVOICE warn · AWAITING_DEPOSIT warn · IN_PROGRESS ok
PAUSED_PENDING_APPROVAL warn · PAUSED_PENDING_CANCELLATION danger
WORK_COMPLETE ok · CANCELLED neutral · CLOSED neutral
UNDER_REVIEW info · SETTLEMENT_SENT warn · AGREED ok
```

### 6.6 Copy rules (use these exact strings)

- Garage: **Invoice**. Customer (Phase 2): **Bill**. The record is always an invoice.
- Proforma: _"Proforma — not a tax invoice. No payment is due against it, and it creates no balance or Vehicle Hold."_
- Hold: _"Vehicle Hold. $X outstanding. Keys and vehicle must not be released."_
- Stale invoice: _"Accepted work not yet billed. The invoice is out of date by $X (+N lines). Regenerate it to include the add-on work."_
- Void: _"Void — not payable."_ + reason + _"Kept for the audit trail only."_
- Voided-by-payment reason: _"Superseded by INV-####."_
- Locked quote: _"Locked <date> — edits disabled, a new quote is required for changes."_
- Zero-dollar warranty: _"Zero-dollar warranty document."_

### 6.7 Interaction rules

- Nothing is created automatically on acceptance: the garage clicks **Generate proforma** or **Generate invoice**.
- A quote card shows actions only for the current turn; accepted quotes are locked and read-only.
- Every destructive action (void, refund, cancellation, decline) opens a modal that states the consequence.
- Void requires a typed reason; the confirm button is danger-styled.
- Payments/receipts always show snapshots (`paidToDate`, `balanceAfter`), not recomputed current values.
- All money/labels are formatted at render; no arithmetic in components.

---

## 7. Acceptance tests (must exist and pass before UI work)

Money & tax

1. `qty=3.5 × $95.00` → gross `33250`; VAT 8% → `2660`; total `35910`.
2. Percent-inclusive line: price `10500` @5% inclusive → net `10000`, tax `500`.
3. Fixed per-unit: `4 × $5.00` levy → tax `2000`.
4. Mixed-tax document: subtotal = Σ nets, tax_total grouped by `tax_id`, total = sum of both.
5. Rounding: sum of per-line rounding equals document total (no residual cents).

Quotes 6. Send → `PENDING_CUSTOMER_APPROVAL`, `revision` +1, `quote_revision` row created. 7. Counter-offer adds a revision with `source` and keeps the previous totals (history is immutable). 8. Accept records `accepted_revision` and locks the quote; a second accept → `422 QUOTE_LOCKED`. 9. Expired quote cannot be accepted (`422 QUOTE_EXPIRED`). 10. Rejecting an independent add-on leaves the job `IN_PROGRESS`; rejecting a dependency add-on leaves it `PAUSED_PENDING_APPROVAL`. 11. Settlement quote acceptance cancels the job and becomes the invoice base; add-ons still append.

Invoices 12. Accepting a quote creates **no** invoice. 13. Proforma has `balance = 0` and `vehicle_hold = 0`. 14. Warranty invoice: total 0, status `PAID`, no payment possible. 15. `buildLines` = settlement-or-standard base + accepted add-ons flagged `is_addon`. 16. Stale detection: accepting an add-on makes `GET /jobs/:id/invoice-status` report a delta.

Versioning & voiding (the critical set) 17. Payment with `reissue_invoice_on_payment=1`: new invoice `seq=2`, `supersedes_id` set, old row `VOID` with reason, one live invoice remains. 18. `amount_paid` on the new version equals the job-wide paid total; `balance = total − paid`. 19. Old receipt becomes `VOID`; exactly one `VALID` receipt exists for the job. 20. Voiding an unpaid invoice succeeds, leaves no live invoice, and sets the job `AWAITING_INVOICE`. 21. Voiding a paid invoice → `422 INVOICE_HAS_PAYMENTS`; invoice unchanged. 22. Paying a void invoice → `422 INVOICE_VOID`. 23. Void invoice recalculation is a no-op (totals frozen after later payments). 24. Regenerating after a manual void continues the chain (`seq` increments, `supersedes_id` = void invoice). 25. A credit note for a refund always references the **live** invoice. 26. Two concurrent payment requests with the same `Idempotency-Key` produce one payment, one version. 27. Attempting to insert a second live tax invoice for a job fails at the DB level (filtered unique index).

Payments & refunds 28. Payment amount is clamped to the balance; `<= 0` → `422 NOTHING_TO_PAY`. 29. Deposit reaching `deposit_required_minor` moves the job to `IN_PROGRESS`. 30. Balance reaching 0 sets `vehicle_hold = 0` and logs `HOLD_RELEASED`. 31. Refund over the payment → `422 REFUND_EXCEEDS_PAYMENT`; completing it emits a credit note and sets the payment status. 32. Refund never re-opens a debt: `balance` stays 0 after a refund of a settled invoice.

Cancellation & extras 33. Cancellation request pauses the job and logs `CANCEL_REQUEST`; decline resumes it. 34. Storage fee appends a non-taxable line and increases the balance by exactly `days × rate`. 35. Unbundling replaces package prices with `standalone_unit_price_minor` for completed services only.

Audit 36. Every action in §3.13 produces exactly one `audit_event` with actor role and note; the table rejects UPDATE/DELETE.

Cross-cutting 37. Any request body containing `total`/`balance`/`status` is ignored (server recalculates) — assert the response. 38. `packages/rules` tests must be runnable without a database.

---

## 8. Build order

1. **Schema** (§4) as migrations, including filtered unique indexes and CHECK constraints.
2. **`packages/rules`**: line maths, `docTotals`, `depositFor`, `recalcInvoice`, `recalcQuote`, `buildLines`,
   status transitions (`nextInvoiceStatus`, `canVoid`). Tests from §7 that don't need a DB.
3. **API**: jobs → quotes → documents → payments → refunds → cancellation → taxes/catalog → audit/notifications.
   Each mutation = one transaction (insert + recalc + audit + notification).
4. **Seed**: garage, staff/manager, 3 customers + vehicles, taxes (incl. one superseded historical rate),
   ~16 catalog services, 3 jobs (quote awaiting customer · change order in progress · invoiced with deposit paid).
5. **Web UI**: tokens/shell → jobs → job tabs → builder → taxes/catalog → invoices/version history → payments/refunds.
6. **Notifications worker** (outbox) + print-ready HTML document view.
7. _(Phase 2)_ Customer portal screens against the same API.

Definition of done per milestone: tests green, no client-side money maths, every mutation audited.

---

## 9. Stack, layout, non-functional

### 9.1 Stack

- **DB:** SQL Server 2019+ (matches the legacy system). Postgres acceptable — swap identity/partial-index syntax only.
- **API:** Node 20+, Express, TypeScript, `zod` for validation, `knex` + raw SQL migrations (filtered indexes and
  CHECK constraints must be expressible), `pino` logging.
- **Web:** React 18 + Vite + TypeScript, plain CSS with the tokens in §6.1, no component framework.
- **Tests:** `vitest`/`node:test` for rules; API tests against a real DB instance (docker).

### 9.2 Layout

```
/packages/rules        pure TS: lineMath, docTotals, depositFor, recalcInvoice, recalcQuote, buildLines, transitions (+tests)
/apps/api              express app, routes, services, migrations, seed, outbox worker
/apps/web              react app, screens, components, api client
/aiContext.md          this contract
```

### 9.3 Non-functional

- Every mutation in a DB transaction; document numbering inside it.
- Idempotency for payments; optimistic concurrency (`409`) for quotes/invoices.
- Audit table append-only at the DB level (deny UPDATE/DELETE to the app user).
- No money arithmetic in React; only formatting.
- Structured logs with `garage_id`, `job_id`, `invoice_id`, `correlation_id`.
- Nothing sensitive in the client bundle; server enforces every guard in §3.13.

---

## 10. Open decisions for the human (confirm before or during build)

| #   | Question                                                                                                                                                          | Default in this file                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | Reissue the invoice on every payment (new number per payment) vs one stable invoice + receipts? Confirm with the accountant — it affects what the customer holds. | `reissue_invoice_on_payment = 1`; the alternative path (§3.6 row 2) is implemented too |
| D2  | When does the customer portal ship?                                                                                                                               | Phase 2; Phase 1 garage-only, notifications only                                       |
| D3  | Quote revision `reason_code` — keep?                                                                                                                              | Yes (nullable; drives "why did the price change?")                                     |
| D4  | Database engine                                                                                                                                                   | SQL Server                                                                             |
| D5  | Print/PDF of invoices in Phase 1?                                                                                                                                 | Print-ready HTML view; no PDF service                                                  |

---

## 11. Changelog vs the previous version of this file

**Kept from v1:** all ten original sections (actors, negotiation, change orders, invoicing, payments, refunds,
data-model minimums, cancellation/settlement/unbundling, storage fees & vehicle hold, warranty) — nothing was dropped.

**Corrected / clarified:**

- Actors: Phase 1 is a **garage-only panel**; the customer receives notifications and their decisions are recorded
  with `actor_role = CUSTOMER` + `recorded_by_user_id`. Customer/garage label rule (`Bill`/`Invoice`) retained for Phase 2.
- `NegotiationLog` promoted to a general append-only `audit_event`, with a `negotiation_log` view for the original requirement.
- Invoice `status` list extended with `VOID` and `SUPERSEDED`; `ISSUED`/`DRAFT` added.

**Added (was missing in v1, now proven in the prototype):**

- Full tax engine (per-line snapshots, versioned rates, percent/fixed, inclusive/exclusive, per-type defaults).
- Service catalog and the full-screen quote builder.
- Proforma → tax invoice split; nothing auto-generated on acceptance; stale-invoice detection.
- **Invoice versioning and voiding** (§3.6) — the single most important addition: paid invoices are replaced by a
  new `seq`, unpaid ones are voided with a reason; voided documents are frozen; credit notes target the live version.
- Receipt lifecycle: one `VALID` receipt per job, snapshots of `paid_to_date` / `balance_after`.
- Quote revisions table with `source`/`reason_code` (who changed the price, and why).
- `notification` outbox, `number_sequence`, idempotency keys, filtered unique indexes as real invariants.
- Derived-value rules (§4.22), `buildLines` (§4.23), legacy migration notes (§4.24), API surface (§5),
  UI/UX + tokens + copy (§6), 38 acceptance tests (§7), build order (§8).
