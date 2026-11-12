# MotorovaDemo — Quotation, Negotiation & Payments (UI prototype)

Clickable HTML/CSS prototype covering quotes → negotiation → documents → payments → refunds.
**No backend, no database, no build step.** All state lives in memory; refreshing resets it.

## Run it

Double-click `index.html`, or serve the folder:

```
npx serve quotation-ui
```

## One panel: the garage

Everything is driven from the garage side. There is no customer login — the customer comes to the
garage, the garage quotes, the garage records what the customer decided and takes the payment.

| Area            | Garage sees                    |
| --------------- | ------------------------------ |
| Document screen | **Invoice**                    |
| Sidebar         | Jobs · **Taxes** · **Catalog** |

Customer-facing statuses still mean exactly what they say: **Pending Customer Approval** = _"sent to the
customer, waiting for their answer"_. When the customer says yes (in person, on the phone, by email) the
garage clicks **Accept & lock**, and the audit trail records the decision and the time.

## Seed jobs

| Job                        | State                               | Good for trying                                                                   |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| **JC-1042** Toyota Corolla | Garage quote pending customer       | Negotiation, configurable tax, proforma, invoice generation                       |
| **JC-1043** Honda Civic    | Customer RFQ pending garage         | Garage answering with catalog services                                            |
| **JC-1044** BMW 320i       | Invoiced, deposit paid, in progress | Change orders, cancellation, unbundling, warranty, **invoice versions & voiding** |

## What's new in this round

### 0. Garage-side job creation, per-payment balances, quote→invoice traceability

- **+ New job** in the sidebar (garage role): customer + vehicle + complaint → job in `QUOTING`. Nothing priced yet; the next click is **+ New quote**.
- **Remaining balance on every payment**: the Payments ledger has a **Remaining after** column, and each invoice card shows `Total · paid · remaining`.
- **Quote → invoice badge** on every quote card: **Not invoiced** / **Invoiced → INV-####** (clickable) / **Voided → INV-####**. Invoices print **From quote Q-####**.
- **Generate** issues one invoice per accepted-but-un-invoiced quote; disabled with _"Nothing new to invoice"_ when there is nothing to bill.
- **Voided invoices** are now a collapsed accordion; each row opens its frozen document.
- **Multiple live invoices per job** are supported and summed in an "All live invoices" table.
- **Download / print** any invoice or receipt as PDF or a standalone `.html` file.
- The invoice totals block lists **receipts** (payments in, not charges), with voided ones struck through.
- **Combine with payments** consolidates documents _and_ receipts, issuing one consolidated receipt.
- Currency is `£` (`CURRENCY = "GBP"` at the top of `js/store.js`).
- `syncInvoice()` is now **invoice-scoped** — with several live invoices a job-wide paid total would double-count.

### 1. Tax engine (percent **and** fixed, inclusive supported)

Garage → **Taxes** in the sidebar.

| Tax           | Type      | Value  | Behaviour                                               |
| ------------- | --------- | ------ | ------------------------------------------------------- |
| `VAT-STD`     | Percent   | 8.00%  | Added on top                                            |
| `VAT-PRT`     | Percent   | 5.00%  | Added on top                                            |
| `ENV-TYR`     | **Fixed** | $5.00  | Charged **per unit** (4 tyres = $20.00)                 |
| `WST-DIS`     | **Fixed** | $12.00 | Per line — used by "Shop supplies & disposal"           |
| `VAT-PRT-INC` | Percent   | 5.00%  | **Tax-inclusive** — extracted from the price, not added |

Three rules that make it trustworthy:

1. **Every line carries a snapshot** (`taxCode`, `taxKind`, `taxValue`, `taxInclusive`). Re-rating a tax **cannot** change a document already issued — try it: change a rate, then reopen the old invoice.
2. **Rates are versioned.** "Change rate" closes the old row and opens a new one; the old one stays in _History_ and keeps being referenced by old documents.
3. **Defaults are routed by line type** (labour → labour tax, parts → parts tax, fees → fee tax), and every line has a **dropdown** to override.

Totals render a real breakdown instead of one blended tax line:

```
Subtotal (excl. tax)              $600.00
VAT-PRT  5.00%                    $ 11.70
VAT-LAB  8.00%                    $ 26.60
WST-DIS  $12.00/unit              $ 12.00
──────────────────────────────────────────
Total                             $650.30
```

### 2. Service catalog + custom lines

Garage → **Catalog**: dummy services grouped by category, each with a default price and default tax.

### 2b. Quote builder (full screen)

**Every "New quote" entry point now opens a dedicated builder screen**, and it is also where existing quotes are edited:

- Overview card → **+ New quote** — available in _every_ job state (previously it was hidden once a quote existed)
- Quotes tab → **+ New quote**, always visible
- `Edit in builder` on any quote where it is the garage's turn
- Mid-job add-ons and warranty rework open the same builder

```
┌ Service catalog ────────┐  ┌ Quote lines ────────────────────────┐
│ [search…] [All][Brakes] │  │ Pads    1  $89.00  VAT-PRT   $89.00 │
│ + Brake pads    $89.00  │  │ Rotors  1 $145.00  VAT-PRT  $145.00 │
│ + Rotors       $145.00  │  │ Labour  3.5 $95.00 VAT-LAB  $332.50 │
│ + Tyre levy      $5.00  │  │ + Blank custom line                 │
│ [+ Create new service…] │  │ Subtotal $566.50 · tax $38.20       │
└─────────────────────────┘  └ Total $604.70 ──────────────────────┘
   [Deposit 30% ▾] [+ Condition]   [Save as draft] [Send to customer]
```

- **Select from list** — click a service, it drops into the quote with its default price and tax.
- **Create from scratch** — _Blank custom line_, or _Create new service…_ which adds it to the catalog **and** the quote in one step.
- **Edit anything** — description, qty, price and tax per line; deposit type/value; conditions.
- Search filters the catalog live (without losing focus), categories filter on click.

### 3. Proforma, then a manually generated invoice

**Nothing is created automatically on accept.**

```
Quote ACCEPTED
      │  job → "Awaiting Invoice"
      ├─[Generate proforma] → PRO-8004  "not a tax invoice", no balance, no hold
      │                        └─ superseded automatically when the invoice is issued
      └─[Generate invoice]  → INV-5004  payable · balance · Vehicle Hold · refunds
```

Try it on **JC-1042**: open the **Quotes** tab and click _Accept & lock_, then open the **Invoice** tab.

Also: when an add-on is accepted mid-job, the invoice is flagged **"Accepted work not yet billed"** with an _Update invoice_ button — the garage decides when it hits the bill.

### 4. Invoice versions, voiding & reissue

A tax invoice is **never edited and never deleted** once it has been issued. There are **three distinct mechanisms**, and they are not interchangeable:

| Situation                                                  | Mechanism                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The document is **wrong** (wrong quote, wrong customer)    | **Void** it — allowed only while nothing is paid                                            |
| The document is **out of date** because new work was added | A **new invoice** for the extra work is issued; the live one is untouched                   |
| You want **one page for the customer**                     | **Combine invoices** — merges the documents; payments stay put and print as carried forward |
| You want **one page and clean paperwork**                  | **Combine with payments** — merges documents, moves the money, voids the old receipts       |
| _Optional_ (`reissueInvoiceOnPayment = true`)              | Every payment issues a new version and voids the previous one                               |

**Default is `reissueInvoiceOnPayment = false`.** Payments accumulate on the live invoice and each one produces a receipt. Voiding is reserved for the explicit combine action, so the void history stays short and readable.

```
Base quote £1,000
  ├─[Generate]────────────► INV-1 £1,000  live
  │    Pay £200 ──────────► INV-1  paid £200 · left £800 · RCP-1
  │    Pay £200 ──────────► INV-1  paid £400 · left £600 · RCP-2
  ├─ add-on accepted (£120)
  ├─[Generate]────────────► INV-2 £120     live   (INV-1 unchanged)
  └─[Combine]─────────────► INV-1 + INV-2 → VOID
                             INV-3 £1,120
                              ├─ lines from both quotes
                              ├─ Paid on consolidated invoices  −£400
                              └─ Remaining to pay               £600 · RCP-3
```

**Rules**

| Situation                          | Behaviour                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Press **Generate**                 | Issues one invoice per accepted-but-un-invoiced quote. Idempotent — a quote is stamped `invoicedAt`, so pressing twice creates nothing new                      |
| Press **Generate** with none left  | Button is disabled with "Nothing new to invoice"                                                                                                                |
| Press **Combine**                  | Needs at least **2 live invoices**; otherwise disabled. Voids them all and issues one combined document                                                         |
| Combined invoice                   | Stores `combinedFromInvoiceIds[]` and `carriedPaid`, so it prints "Paid on consolidated invoices" and the balance still adds up                                 |
| Paid-to-date on an invoice         | Summed **for that invoice only** — never job-wide, otherwise two live invoices would each show the same money                                                   |
| Garage voids an **unpaid** invoice | Document flagged `VOID` with the reason; no replacement; the job returns to **Awaiting Invoice**                                                                |
| Garage voids a **paid** invoice    | Refused — paid paper is replaced by a version or a combined invoice, never voided                                                                               |
| Payment on a void invoice          | Refused (`That invoice is void — collect against the current one`)                                                                                              |
| Quoting which document covers what | Quote card badge: **Not invoiced** / **Invoiced → INV-####** (click jumps to the Invoice tab) / **Voided → INV-####**; the invoice prints **From quote Q-####** |
| Viewing a void document            | Nested inside a collapsed **Voided invoices** accordion; read-only, totals frozen at the moment of voiding, never payable                                       |
| Credit note from a refund          | Always attaches to the **live** version, never to a void one                                                                                                    |
| Receipts                           | One `VALID` receipt per payment; superseded receipts (reissue mode) become `VOID`                                                                               |
| `reissueInvoiceOnPayment = true`   | Every payment issues `seq + 1`, voids the previous, re-points its payments and receipts at the replacement. Toggle lives on the Invoice tab                     |

## Flows you can still click

| Flow                                                   | Where                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Create a job (garage side)**                         | Sidebar → **+ New job** (customer + vehicle, then quote it)               |
| **Build / edit a quote**                               | Overview or Quotes tab → **+ New quote** (full-screen builder)            |
| **See which quote has an invoice**                     | Quotes tab → badge on each card: _Not invoiced_ / _Invoiced → INV-####_   |
| **Generate an invoice for accepted work**              | Invoice tab → **Generate** (lists exactly what will be issued)            |
| **Combine live invoices into one**                     | Invoice tab → **Combine invoices** (documents only; payments stay put)    |
| **Consolidate documents + payments**                   | Invoice tab → **Combine with payments** (moves money, voids old receipts) |
| **Download / print an invoice or receipt**             | Document footer → **Download**, or on a receipt → **Print / Save as PDF** |
| **See the balance after each payment**                 | Payments tab → ledger column **Remaining after**                          |
| **Inspect voided invoices**                            | Invoice tab → collapsed **Voided invoices** accordion                     |
| **Create a service from scratch**                      | Builder → _+ Create new service_ (also lands in the catalog)              |
| **Edit services**                                      | Catalog → row → _Edit_ / _Remove_                                         |
| Counter-offer / accept / reject / conditions           | Quotes tab                                                                |
| Supplementary quote + dependency flag                  | Overview (garage) → _Supplementary quote_                                 |
| Cancellation → settlement → unbundle packages          | Overview → _Request cancellation_, then garage _Create settlement quote_  |
| Deposit / balance / milestone payments + auto receipts | Payments tab (tax invoice only)                                           |
| **Payment → new invoice version → old one voided**     | Payments / Invoice tab → _Record payment_                                 |
| **Void an unpaid invoice**                             | Invoice tab (garage) → _Void invoice_ → reason                            |
| **See voided versions**                                | Invoice tab → _Voided versions_ block + frozen documents                  |
| Refund request → approval → **Credit Note**            | Refunds tab                                                               |
| Daily storage fees                                     | Overview (garage) → _Add storage fee_                                     |
| Warranty rework at $0.00                               | Overview (garage) → _Warranty quote_                                      |
| Full audit trail                                       | Audit trail tab                                                           |

## The rules, in full

Everything below is enforced in `js/store.js`. The views only render what the engine decides.

### 1. Money

- **Money is integer minor units everywhere.** `£95.00` is stored as `9500`; formatting happens once, at render time, through `money()`. Change `CURRENCY` / `LOCALE` at the top of `js/store.js` to switch the display currency.
- **One calculator**: `docTotals(lines)` is used by quotes _and_ invoices, so a quote and the invoice made from it can never disagree.
- `balance = total − carriedPaid − payments on this invoice`. A refund returns money but never re-opens a debt — it emits a Credit Note instead.
- **Vehicle Hold** is derived, never stored by hand: `balance > 0` on a **tax invoice** only. Proformas and warranty documents never create a hold.
- Rounding is done on cents with `Math.round`, per line, before summing.

### 2. Tax

- Each line stores a **snapshot** of its tax (`taxId, taxCode, taxName, taxKind, taxValue, taxInclusive`). Re-rating a tax cannot rewrite a document already issued.
- **Rates are versioned.** "Change rate" closes the old row (`active: false`, `effectiveTo`) and opens a new one with a new id (`supersededBy` link). Old documents keep pointing at the old row.
- **Percent** taxes store basis points (`800` = 8.00%). **Fixed** taxes store cents per unit (`500` = $5.00/unit, multiplied by quantity).
- **Inclusive** taxes are extracted from the price instead of added on top; exclusive ones are added.
- **Defaults are routed by line type** (`LABOR`, `PART`, `SERVICE`, `FEE`) through `defaultTaxFor()`, and every line can override it with the tax dropdown.
- Deactivating a tax only removes it from _new_ lines.

### 3. Quotes

- Types: `STANDARD`, `SUPPLEMENTARY` (add-on), `SETTLEMENT`, `WARRANTY`.
- Statuses: `DRAFT`, `PENDING_GARAGE_APPROVAL`, `PENDING_CUSTOMER_APPROVAL`, `ACCEPTED`, `REJECTED`.
- **One actor, recorded decisions**: the garage edits, counters, accepts and rejects. A status of
  `PENDING_CUSTOMER_APPROVAL` means the quote is out with the customer; the garage flips it to `ACCEPTED`
  once the customer agrees, so every round is still logged with a timestamp.
- Every save bumps `revision` and appends to `revisions[]`; the status flips to the _other_ party's approval.
- **Accepting locks the quote** (`acceptedAt`, `lockedAt`) — but creates **no invoice**.
- A `hasDependency` add-on pauses the job (`PAUSED_PENDING_APPROVAL`) until it is accepted (resume) or rejected (stay paused). Independent add-ons never block.
- Rejecting a `STANDARD` quote cancels the job; rejecting a `SETTLEMENT` returns the cancellation to `UNDER_REVIEW`.
- **Warranty** quotes copy the accepted work at `$0.00`, keep the original price in `unitPriceOriginal` (shown struck through) and invoice as a `WARRANTY` document.
- **Settlement** quotes bill only work completed up to cancellation, optionally "unbundling" package prices back to `standaloneUnitPrice`.

### 4. Documents

| Kind          | Payable | Balance    | Hold  | Purpose                                       |
| ------------- | ------- | ---------- | ----- | --------------------------------------------- |
| `PROFORMA`    | no      | always `0` | never | informational, auto-superseded by the invoice |
| `TAX_INVOICE` | **yes** | yes        | yes   | the real, versioned document                  |
| `WARRANTY`    | no      | `0`        | never | zero-dollar rework proof                      |

- Nothing is created automatically on acceptance; the garage chooses proforma or tax invoice.
- `invoiceNeedsUpdate()` compares the live invoice against all accepted work and flags _"Accepted work not yet billed"_; regenerating is a deliberate click.
- A proforma is never converted — it is marked `SUPERSEDED` and a new `INV-####` number is issued.

### 5. Invoice versions & voiding

- **Live invoices**: `sel.liveInvoices(jobId)` returns every non-`VOID` tax invoice — a job can hold more than one on purpose. `sel.stdInvoice(jobId)` returns the first, for convenience. `sel.voidedInvoices()` gives the history.
- **Freeze on void**: `syncInvoice()` returns immediately for a `VOID` document, so its `total`, `amountPaid` and `balance` stay exactly as they were when it was voided.
- **Void is never a delete.** The row keeps `voidedAt`, `voidReason`, the link forward (`supersededBy`), and — on a combined document — `combinedFromInvoiceIds[]` plus `carriedPaid`.
- **Paid-to-date is per invoice.** `invoicePaid(id)` / `invoiceRefunded(id)` scope the money to the document. A job-wide total would show the same receipts on every live invoice.
- **`carriedPaid`** holds money received on documents that were merged into a combined invoice, so `balance = total − carriedPaid − payments on this invoice` always reconciles.
- **Three ways to void:**
  - _Combine_ (garage, deliberate): voids every live invoice with `"Consolidated into INV-####"` and issues one replacement carrying `carriedPaid`.
  - _Manual_ (garage): only when `amountPaid === 0`; requires a written reason; creates no replacement, so the job drops back to `AWAITING_INVOICE`.
  - _Reissue on payment_ (only if `reissueInvoiceOnPayment = true`): issues the replacement first, re-points the payments and receipts at it, then voids the previous one with `"Superseded by INV-####"`.
- **A paid invoice can never be voided manually.** Money forces a new version or a combine.
- **No payment can land on a void invoice** — guarded in `recordPayment()` _and_ hidden in the UI (void versions are filtered out of the Payments tab).
- **Receipts follow the same discipline**: one `VALID` receipt per payment, snapshots of `paidToDate` / `balanceAfter`; superseded ones become `VOID`. With the default settings every payment keeps its own valid receipt.
- **Credit notes always target the live version** (`completeRefundRecord()` resolves `stdInvoice(jobId) || original`).
- Voided documents render read-only, watermarked _"Void — not payable"_, with the figures frozen at void time.

### 6. Payments

- Only against a `TAX_INVOICE` (proformas and warranty documents are refused).
- The amount is clamped to the outstanding balance: `min(entered, balance)`; zero → refused.
- Types: `DEPOSIT`, `STANDARD`, `MILESTONE`. Methods: `CARD`, `BANK_TRANSFER`, `CASH`, `ONLINE`.
- Recording a deposit that covers `depositRequired` moves the job `AWAITING_DEPOSIT → IN_PROGRESS`.
- Reaching `balance === 0` logs `HOLD_RELEASED` and flips the Vehicle Hold off.
- A receipt is generated, emailed and timestamped on every successful payment.
- **Receipts drive the balance.** `invoicePaid()` sums the invoice's **VALID** receipts, not its payment rows.
  A `VOID` receipt stays visible on the document (struck through) but is **never** deducted, so a consolidated
  invoice cannot subtract the same money twice.

### 6b. Receipts printed on the invoice

The invoice totals block ends with a **Receipts** panel (`receiptRows()`), deliberately styled apart from the
charges and labelled _"payments received — not charges on this invoice"_:

```
Subtotal (excl. tax)                    £299.00
VAT-STD 8.00%                            £19.20
VAT-PRT 5.00%                             £2.95
──────────────────────────────────────────────
Total                                   £321.15
── Receipts · payments received, not charges ──
RCP-7003  Card · 12 Aug               −£96.35
RCP-7004  Cash · 14 Aug              −£200.00
──────────────────────────────────────────────
Remaining balance                        £24.80
```

After **Combine with payments**, the earlier receipts appear here marked **VOID** (struck through, not
deducted) beside the single valid consolidated receipt. Each row opens its receipt.

### 6c. Downloading documents

**Download** on every invoice footer offers two dependency-free outputs, both rendered by the same
`Views.printableDoc()` so they can never drift:

- **Print / Save as PDF** — opens a print window containing only the document (garage, customer, vehicle,
  lines, tax breakdown, receipts, balance) and calls `window.print()`.
- **Download .html** — saves a self-contained file (`INV-5005-BM2210.html`) with inlined CSS.

Receipts have their own **Print / Save as PDF**. Voided documents print with a diagonal
**VOID — NOT PAYABLE** watermark and their frozen figures.

### 7. Refunds & credit notes

- A refund can never exceed what is still refundable on that payment (`amount − already requested`).
- Customer requests (`REQUESTED`) → garage approves (`PROCESSING`) or declines (`DECLINED`); the garage can also issue a proactive refund.
- **Completing a refund always generates a Credit Note** and moves the payment to `PARTIALLY_REFUNDED` / `REFUNDED`.
- Refunds never reduce `total` and never re-open a debt.

### 8. Cancellation & settlement

- A customer request pauses the job immediately (`PAUSED_PENDING_CANCELLATION`) and logs `JOB_PAUSED`.
- The garage either issues a **settlement quote** (normal negotiable quote) or **declines** (job resumes).
- Accepting a settlement cancels the job, marks the cancellation `AGREED`, and the settlement replaces the original billing on the invoice.

### 9. Extras

- **Storage fees** are appended to the live tax invoice as a non-taxable `FEE` line and recorded in `S.storage`.
- **Audit trail** is append-only: every action writes `{ actor, action, note, amountBefore, amountAfter, at }`. Voiding, reissuing and hold release all appear there.

### 10. Guards — what the app refuses to do

- Pay a proforma, a warranty document or a **void** invoice.
- Void a **paid** invoice.
- Take a refund larger than the payment.
- Combine fewer than **two** live invoices.
- Create an invoice before a quote is accepted.
- Overwrite an issued document: it is either **versioned**, **consolidated** or **voided**, never rewritten.

## Data model

| Entity                 | Fields                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job**                | `id, jobNo, garageName, customerName, customerEmail, vehicle{year,make,model,plate,vin,odometer}, status, createdAt, pausedReason, dependsOnQuoteId`                                                                                                                                                                                                  |
| **Quote**              | `id, jobId, no, type, status, createdByRole, parentQuoteId, originalInvoiceId, items[], conditions[], revisions[], hasDependency, isChangeOrder, depositType, depositValue, expiryDate, revision, createdAt, acceptedAt, rejectedAt, lockedAt, invoicedAt, invoiceIds[]`                                                                              |
| **Quote line**         | `id, kind, description, qty, unitPrice, serviceId?, packageRef?, standaloneUnitPrice?, unitPriceOriginal?, taxId, taxCode, taxName, taxKind, taxValue, taxInclusive`                                                                                                                                                                                  |
| **Invoice / document** | `id, jobId, quoteId, no, kind, originalInvoiceId, settlementQuoteId, supersedes, supersededBy, voidedAt, voidReason, seq, paymentId, carriedPaid, combinedFromInvoiceIds[], isCombined, lines[], issuedAt, dueAt, depositRequired, depositType, depositValue, status, subtotal, taxTotal, taxes[], total, amountPaid, refunded, balance, vehicleHold` |
| **Invoice line**       | quote-line snapshot + `quoteId, quoteType, isAddon`                                                                                                                                                                                                                                                                                                   |
| **Payment**            | `id, invoiceId, no, amount, type, method, status, paidAt`                                                                                                                                                                                                                                                                                             |
| **Receipt**            | `id, paymentId, invoiceId, jobId, no, status, amount, method, type, issuedAt, emailedTo, paidToDate, balanceAfter, supersededBy, voidedAt, voidReason`                                                                                                                                                                                                |
| **Refund**             | `id, invoiceId, paymentId, amount, type, reason, status, requestedBy, createdAt, decidedAt, creditNoteId`                                                                                                                                                                                                                                             |
| **Credit note**        | `id, invoiceId, refundId, no, amount, reason, issuedAt`                                                                                                                                                                                                                                                                                               |
| **Cancellation**       | `id, jobId, reason, status, requestedBy, settlementQuoteId, createdAt, resolvedAt`                                                                                                                                                                                                                                                                    |
| **Storage**            | `id, jobId, invoiceId, days, rate, amount, at`                                                                                                                                                                                                                                                                                                        |
| **Timeline**           | `id, jobId, quoteId, actor, action, note, amountBefore, amountAfter, at`                                                                                                                                                                                                                                                                              |
| **Tax**                | `id, code, name, kind, value, inclusive, appliesTo[], effectiveFrom, effectiveTo, active, supersededBy`                                                                                                                                                                                                                                               |
| **Service**            | `id, name, category, price, taxCode, unit`                                                                                                                                                                                                                                                                                                            |

## Function reference (`js/store.js`)

### Pure helpers (exported on `Store`)

| Function                                                                                | Does                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `money(cents)`                                                                          | formats integer cents as `£1,234.56` (`CURRENCY` / `LOCALE` constants at the top of `store.js`)                          |
| `fmtDateTime(iso)` / `fmtDay(iso)`                                                      | short date-time / date, `—` when empty                                                                                   |
| `uid(prefix)` / `nowISO()` / `addDays(iso, n)`                                          | ids, timestamps, date arithmetic                                                                                         |
| `setLineTax(line, tax)`                                                                 | copies the tax definition onto the line (the snapshot)                                                                   |
| `lineMath(line)`                                                                        | `{ gross, net, tax }` for one line, honouring inclusive/fixed                                                            |
| `docTotals(lines)`                                                                      | `{ subtotal, taxTotal, total, taxes[] }` — the one calculator                                                            |
| `quoteTotals(q)` / `lineTotal(line)`                                                    | totals for a quote / one line                                                                                            |
| `depositFor(q)`                                                                         | deposit in cents from `depositType` (`NONE/PERCENT/FLAT`)                                                                |
| `syncInvoice(inv)`                                                                      | recomputes totals, `balance`, `status`, `vehicleHold` from **that invoice's own** payments; **returns early for `VOID`** |
| `linesForQuote(q)`                                                                      | invoice lines for a single quote                                                                                         |
| `taxById` / `taxByCode` / `activeTaxes` / `defaultTaxFor` / `taxLabel` / `taxRateLabel` | tax lookups and labels                                                                                                   |
| `buildLines(jobId)`                                                                     | every accepted line on the job, ready to compare against                                                                 |
| `invoiceNeedsUpdate(jobId)`                                                             | `null` or `{ delta, lines, quotes }` for accepted work not yet on any live invoice                                       |
| `seed()`                                                                                | resets the demo to the three seed jobs                                                                                   |
| `actions`                                                                               | the workflow API (below)                                                                                                 |

Internal (not exported): `log()`, `nextQuoteNo()`, `linesFromQuote()`, `jobPaid()`, `jobRefunded()`, `completeRefundRecord()`, `openBuilder()`.

### Selectors (`Store.sel`)

| Selector                                                   | Returns                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `job`, `quote`, `invoice`, `payment`, `receipt`, `service` | one record by id                                               |
| `receiptForPayment(pid)` / `receiptForInvoice(invId)`      | the receipt for a payment / invoice                            |
| `quotesForJob(jobId)`                                      | every quote, oldest first                                      |
| `activeQuote(jobId)`                                       | the open one (`DRAFT`/pending)                                 |
| `stdQuote(jobId)`                                          | the accepted `STANDARD` quote                                  |
| `invoicesForJob(jobId)`                                    | every document on the job                                      |
| `liveInvoices(jobId)`                                      | every **non-void** tax invoice (can be more than one)          |
| `stdInvoice(jobId)`                                        | the first live tax invoice (convenience)                       |
| `voidedInvoices(jobId)`                                    | the void history                                               |
| `invoiceVersions(jobId)`                                   | every tax invoice, sorted by `seq`                             |
| `invoicesForQuote(quoteId)`                                | documents covering a quote, including combined ones            |
| `quoteInvoiceStatus(quoteId)`                              | `{ invoiced, live, voided, total, latest }` — drives the badge |
| `uninvoicedQuotes(jobId)`                                  | accepted quotes with no invoice yet — drives **Generate**      |
| `jobTotals(jobId)`                                         | `{ total, paid, balance }` summed over live invoices           |
| `balanceAfter(paymentId)`                                  | running balance shown on each payment ledger row               |
| `openProforma(jobId)`                                      | the `ISSUED` proforma, if any                                  |
| `receiptsForJob(jobId)`                                    | receipts (valid and void)                                      |
| `paymentsForInvoice`, `paymentsForJob`                     | payments                                                       |
| `refundsForJob`, `creditNotesForInvoice`                   | refunds and credit notes                                       |
| `cancellationsForJob`, `openCancellation`                  | cancellation requests                                          |
| `storageForJob`, `timelineForJob`                          | storage fees, audit trail                                      |

### Actions (`Store.actions`)

| Group           | Actions                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation      | `setRole`, `setScreen`, `selectJob`, `setTab`, `reset`                                                                                                                                                     |
| Builder         | `openBuilder`, `closeBuilder`, `builderCat`, `builderSearch`, `builderAddService`, `builderBlankLine`, `builderRemoveItem`, `builderSetDeposit`, `builderCreateService`, `builderSaveDraft`, `builderSend` |
| Quote editing   | `startEdit`, `cancelEdit`, `addItem`, `removeItem`, `setItemTax`, `addServices`, `toggleDependency`, `addCondition`                                                                                        |
| Quote lifecycle | `saveEdit`, `sendQuote`, `acceptQuote`, `rejectQuote`                                                                                                                                                      |
| New quotes      | `createGarageQuote`, `createSupplementary`, `createWarranty`, `createRfq`, `createSettlement`                                                                                                              |
| Jobs            | **`createJob(payload)`** — garage opens a job (customer + vehicle), then quotes it                                                                                                                         |
| Documents       | `generateProforma`, `generateInvoices`, `generateCombinedInvoice`, `combineInvoicesWithPayments`, `voidInvoice`                                                                                            |
| Cancellation    | `requestCancellation`, `declineCancellation`                                                                                                                                                               |
| Money           | `recordPayment`, `requestRefund`, `decideRefund`, `issueRefund`, `completeRefund`, `addStorageFee`                                                                                                         |
| Tax / catalog   | `saveTax`, `deactivateTax`, `saveService`, `removeService`                                                                                                                                                 |

### Invoice actions in detail

| Action                            | Void invoices? | Void receipts?                           | Money handling                           |
| --------------------------------- | -------------- | ---------------------------------------- | ---------------------------------------- |
| `generateInvoices(jobId)`         | no             | no                                       | none                                     |
| `generateCombinedInvoice(jobId)`  | yes (≥2 live)  | no                                       | kept as `carriedPaid` on the new invoice |
| `combineInvoicesWithPayments(id)` | yes            | **yes** + one consolidated valid receipt | payments re-pointed at the new invoice   |

## Function reference (`js/views.js`)

| Function                                              | Renders                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `render()`                                            | the whole screen (role switch + sidebar + main)                             |
| `renderSidebar()` / `renderMain()`                    | job list / the current screen                                               |
| `jobHeader`, `tabs`, `tabBody`                        | job header, tab bar, active tab                                             |
| `viewOverview`                                        | KPIs, Vehicle Hold banner, cancellation panel, workflow steps               |
| `viewQuotes` → `quoteCard`                            | quote cards with lines, tax, totals, conditions, revisions, actions         |
| `viewBill`                                            | proforma + live invoice + warranty docs + **voided versions**               |
| `proformaDoc`, `invoiceDoc`, `linesTable`, `taxBlock` | document bodies (shared line/tax rendering)                                 |
| `versionHistory(job, voided)`                         | the collapsed **Voided invoices** accordion (each row opens its frozen doc) |
| `voidedDoc(job, inv)`                                 | a frozen, read-only, watermarked void document                              |
| `invoiceBadge(q)`                                     | _Not invoiced_ / _Invoiced → INV-####_ / _Voided → INV-####_                |
| `receiptRows(inv)`                                    | the **Receipts** panel inside an invoice's totals block                     |
| `printableDoc(inv)`                                   | standalone printable document (no app chrome; VOID watermark)               |
| `viewPayments`                                        | payable cards (live invoices only) + payment ledger with void markers       |
| `viewRefunds`, `viewAudit`                            | refund workflow, audit timeline                                             |
| `viewBuilder`                                         | full-screen builder (catalog + lines + deposit)                             |
| `viewTaxes`, `viewCatalog`                            | tax engine screen, service catalog                                          |

## Function reference (`js/app.js`)

| Function                                   | Does                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toast(msg, kind)`                         | transient notification                                                                                                                                                                                                                                                            |
| `openModal(opts)` / `closeModal()`         | modal shell, submit handling, focus                                                                                                                                                                                                                                               |
| `printablePage(body, title)`               | wraps a document in a styled, self-contained HTML page                                                                                                                                                                                                                            |
| `downloadDoc` / `printDoc` / `saveHtmlDoc` | Download dialog, print-to-PDF, and standalone `.html` export                                                                                                                                                                                                                      |
| `receiptModal` / `printReceipt`            | receipt detail and its printable copy                                                                                                                                                                                                                                             |
| `combinedPaymentsModal`                    | confirm dialog for **Combine with payments** (lists what voids, what moves)                                                                                                                                                                                                       |
| `taxSelectOptions(code)`                   | tax dropdown markup                                                                                                                                                                                                                                                               |
| `handlers`                                 | one entry per `data-act` (navigation, builder, quotes, documents incl. **`generateInvoices`**, **`combinedModal`**, **`combinedPaymentsModal`**, **`downloadDoc`**, **`toggleReissue`**, **`voidInvoiceModal`**, **`newGarageJob`**, payments, receipts, refunds, taxes, catalog) |
| click / input / change / keydown listeners | delegated events; live line editing keeps focus by patching `#lt-*` and `#qtotal-*` instead of re-rendering                                                                                                                                                                       |

## Files

```
index.html          shell: top bar, sidebar, main, modal root
css/app.css         all styling (no framework)
js/store.js         mock data, tax engine, document maths, all workflows
js/views.js         rendering (pure functions → HTML strings)
js/app.js           event delegation, modals, toasts, boot
```

## Deferred (agreed)

- Payments on a proforma (deposit against proforma)
- Multi-tax stacking on a single line
- Draft → issue step for invoices
- A settings screen for `reissueInvoiceOnPayment` — a toggle now lives on the Invoice tab, but it is not persisted across a reset
