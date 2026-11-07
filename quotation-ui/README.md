# NerveCenter — Quotation, Negotiation & Payments (UI prototype)

Clickable HTML/CSS prototype covering quotes → negotiation → documents → payments → refunds.
**No backend, no database, no build step.** All state lives in memory; refreshing resets it.

## Run it

Double-click `index.html`, or serve the folder:

```
npx serve quotation-ui
```

## Two actors, one set of records

Use the **Viewing as** switch in the top bar. The same records change face:

|                 | Customer sees | Garage sees                    |
| --------------- | ------------- | ------------------------------ |
| Document screen | **Bill**      | **Invoice**                    |
| Sidebar         | Jobs only     | Jobs · **Taxes** · **Catalog** |

The database row is always `Invoice`; only the label changes per viewer.

## Seed jobs

| Job                        | State                               | Good for trying                                                                   |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| **JC-1042** Toyota Corolla | Garage quote pending customer       | Negotiation, configurable tax, proforma, invoice generation                       |
| **JC-1043** Honda Civic    | Customer RFQ pending garage         | Garage answering with catalog services                                            |
| **JC-1044** BMW 320i       | Invoiced, deposit paid, in progress | Change orders, cancellation, unbundling, warranty, **invoice versions & voiding** |

## What's new in this round

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
- The customer keeps their lighter inline counter-offer editor — no catalog access.

### 3. Proforma, then a manually generated invoice

**Nothing is created automatically on accept.**

```
Quote ACCEPTED
      │  job → "Awaiting Invoice"
      ├─[Generate proforma] → PRO-8004  "not a tax invoice", no balance, no hold
      │                        └─ superseded automatically when the invoice is issued
      └─[Generate invoice]  → INV-5004  payable · balance · Vehicle Hold · refunds
```

Try it on **JC-1042**: accept as customer, then flip to garage and open the **Invoice** tab.

Also: when an add-on is accepted mid-job, the invoice is flagged **"Accepted work not yet billed"** with an _Update invoice_ button — the garage decides when it hits the bill.

### 4. Invoice versions, voiding & reissue

A tax invoice is **never edited and never deleted** once it has been issued. Two different problems, two different mechanisms:

| Problem                                 | Mechanism                                            |
| --------------------------------------- | ---------------------------------------------------- |
| The document is **wrong** (wrong quote) | **Void** it — allowed only while nothing is paid     |
| The document is merely **out of date**  | A **new version** replaces it (automatic on payment) |

```
Record a payment (reissueInvoiceOnPayment = true, the default)
      │
      ├─ INV-5004 issued   seq 2 · supersedes INV-5003 · paid-to-date · new balance
      ├─ INV-5003 → VOID   reason "Superseded by INV-5004" · figures frozen
      └─ RCP-7003 → VOID   RCP-7004 becomes the one valid receipt on the job
```

Try it: **JC-1044** → Invoice tab → _Record payment_ on the remaining balance. The bill now shows `INV-5004 · Version 2 · replaces INV-5003`, a **Voided versions** block and a frozen copy of `INV-5003`. The Payments ledger marks the payment as having landed on a since-voided invoice.

**Rules**

| Situation                          | Behaviour                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A payment is recorded              | New version `seq + 1`, old version `VOID`, both linked by `supersedes` / `supersededBy`                                                      |
| Paid-to-date                       | Summed **across every version of the job**, not per document                                                                                 |
| Garage voids an **unpaid** invoice | Document flagged `VOID` with the reason; no replacement is created; job returns to **Awaiting Invoice**                                      |
| Garage voids a **paid** invoice    | Refused — the toast explains that paid paper is replaced by a version, not voided                                                            |
| Payment on a void invoice          | Refused (`That invoice is void — collect against the current one`)                                                                           |
| Regenerate after a void            | New number, chain continues (`seq` keeps counting, `supersedes` points at the void document)                                                 |
| Viewing a void document            | Read-only, "Void — not payable", totals frozen at the moment of voiding, never payable                                                       |
| Credit note from a refund          | Always attaches to the **live** version, never to a void one                                                                                 |
| Receipts                           | Exactly one `VALID` receipt per job; every earlier one becomes `VOID`                                                                        |
| `reissueInvoiceOnPayment = false`  | The same invoice is re-synced in place and only a receipt is added (no versions). It is a flag in `js/store.js`, there is no settings screen |

## Flows you can still click

| Flow                                                   | Where                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Build / edit a quote**                               | Overview or Quotes tab → **+ New quote** (full-screen builder)           |
| **Create a service from scratch**                      | Builder → _+ Create new service_ (also lands in the catalog)             |
| **Edit services**                                      | Catalog → row → _Edit_ / _Remove_                                        |
| Counter-offer / accept / reject / conditions           | Quotes tab                                                               |
| Supplementary quote + dependency flag                  | Overview (garage) → _Supplementary quote_                                |
| Cancellation → settlement → unbundle packages          | Overview → _Request cancellation_, then garage _Create settlement quote_ |
| Deposit / balance / milestone payments + auto receipts | Payments tab (tax invoice only)                                          |
| **Payment → new invoice version → old one voided**     | Payments / Invoice tab → _Record payment_                                |
| **Void an unpaid invoice**                             | Invoice tab (garage) → _Void invoice_ → reason                           |
| **See voided versions**                                | Invoice tab → _Voided versions_ block + frozen documents                 |
| Refund request → approval → **Credit Note**            | Refunds tab                                                              |
| Daily storage fees                                     | Overview (garage) → _Add storage fee_                                    |
| Warranty rework at $0.00                               | Overview (garage) → _Warranty quote_                                     |
| Full audit trail                                       | Audit trail tab                                                          |

## The rules, in full

Everything below is enforced in `js/store.js`. The views only render what the engine decides.

### 1. Money

- **Money is integer cents everywhere.** `$95.00` is stored as `9500`; formatting happens once, at render time, through `money()`.
- **One calculator**: `docTotals(lines)` is used by quotes _and_ invoices, so a quote and the invoice made from it can never disagree.
- `balance = total − paid`. A refund returns money but never re-opens a debt — it emits a Credit Note instead.
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
- **Turn-taking**: only the party whose turn it is can edit/counter/accept/reject. The garage edits in the full-screen **builder**; the customer keeps the lighter inline counter-offer editor.
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

- **One live version at a time.** `sel.stdInvoice(jobId)` returns the non-`VOID` tax invoice; `sel.voidedInvoices()` and `sel.invoiceVersions()` give the history.
- **Freeze on void**: `syncInvoice()` returns immediately for a `VOID` document, so its `total`, `amountPaid` and `balance` stay exactly as they were when it was voided.
- **Void is never a delete.** The row keeps `voidedAt`, `voidReason`, and the link forward (`supersededBy`).
- **Two ways to void:**
  - _Automatic_ (payment): issue the replacement first (it needs the new number), then void the previous one with `"Superseded by INV-####"`.
  - _Manual_ (garage): only when `amountPaid === 0`; requires a written reason; creates no replacement, so the job drops back to `AWAITING_INVOICE` and nothing is payable until a new document is issued.
- **A paid invoice can never be voided.** Money forces a new version; that is the whole point of the reissue flow.
- **No payment can land on a void invoice** — guarded in `recordPayment()` _and_ hidden in the UI (void versions are filtered out of the Payments tab).
- **Receipts follow the same discipline**: exactly one `VALID` receipt per job, snapshots of `paidToDate` / `balanceAfter`, the rest `VOID` with `supersededBy`.
- **Credit notes always target the live version** (`completeRefundRecord()` resolves `stdInvoice(jobId) || original`).
- Voided documents render read-only, watermarked _"Void — not payable"_, with the figures frozen at void time.

### 6. Payments

- Only against a `TAX_INVOICE` (proformas and warranty documents are refused).
- The amount is clamped to the outstanding balance: `min(entered, balance)`; zero → refused.
- Types: `DEPOSIT`, `STANDARD`, `MILESTONE`. Methods: `CARD`, `BANK_TRANSFER`, `CASH`, `ONLINE`.
- Recording a deposit that covers `depositRequired` moves the job `AWAITING_DEPOSIT → IN_PROGRESS`.
- Reaching `balance === 0` logs `HOLD_RELEASED` and flips the Vehicle Hold off.
- A receipt is generated, emailed and timestamped on every successful payment.

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
- Create an invoice before a quote is accepted.
- Overwrite an issued document: it is either **versioned** or **voided**, never rewritten.

## Data model

| Entity                 | Fields                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job**                | `id, jobNo, garageName, customerName, customerEmail, vehicle{year,make,model,plate,vin,odometer}, status, createdAt, pausedReason, dependsOnQuoteId`                                                                                                                                               |
| **Quote**              | `id, jobId, no, type, status, createdByRole, parentQuoteId, originalInvoiceId, items[], conditions[], revisions[], hasDependency, isChangeOrder, depositType, depositValue, expiryDate, revision, createdAt, acceptedAt, rejectedAt, lockedAt, invoicedAt?`                                        |
| **Quote line**         | `id, kind, description, qty, unitPrice, serviceId?, packageRef?, standaloneUnitPrice?, unitPriceOriginal?, taxId, taxCode, taxName, taxKind, taxValue, taxInclusive`                                                                                                                               |
| **Invoice / document** | `id, jobId, quoteId, no, kind, originalInvoiceId, settlementQuoteId, supersedes, supersededBy, voidedAt, voidReason, seq, paymentId, lines[], issuedAt, dueAt, depositRequired, depositType, depositValue, status, subtotal, taxTotal, taxes[], total, amountPaid, refunded, balance, vehicleHold` |
| **Invoice line**       | quote-line snapshot + `quoteId, quoteType, isAddon`                                                                                                                                                                                                                                                |
| **Payment**            | `id, invoiceId, no, amount, type, method, status, paidAt`                                                                                                                                                                                                                                          |
| **Receipt**            | `id, paymentId, invoiceId, jobId, no, status, issuedAt, emailedTo, paidToDate, balanceAfter, supersededBy, voidedAt`                                                                                                                                                                               |
| **Refund**             | `id, invoiceId, paymentId, amount, type, reason, status, requestedBy, createdAt, decidedAt, creditNoteId`                                                                                                                                                                                          |
| **Credit note**        | `id, invoiceId, refundId, no, amount, reason, issuedAt`                                                                                                                                                                                                                                            |
| **Cancellation**       | `id, jobId, reason, status, requestedBy, settlementQuoteId, createdAt, resolvedAt`                                                                                                                                                                                                                 |
| **Storage**            | `id, jobId, invoiceId, days, rate, amount, at`                                                                                                                                                                                                                                                     |
| **Timeline**           | `id, jobId, quoteId, actor, action, note, amountBefore, amountAfter, at`                                                                                                                                                                                                                           |
| **Tax**                | `id, code, name, kind, value, inclusive, appliesTo[], effectiveFrom, effectiveTo, active, supersededBy`                                                                                                                                                                                            |
| **Service**            | `id, name, category, price, taxCode, unit`                                                                                                                                                                                                                                                         |

## Function reference (`js/store.js`)

### Pure helpers (exported on `Store`)

| Function                                                                                | Does                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `money(cents)`                                                                          | formats integer cents as `$1,234.56`                                                              |
| `fmtDateTime(iso)` / `fmtDay(iso)`                                                      | short date-time / date, `—` when empty                                                            |
| `uid(prefix)` / `nowISO()` / `addDays(iso, n)`                                          | ids, timestamps, date arithmetic                                                                  |
| `setLineTax(line, tax)`                                                                 | copies the tax definition onto the line (the snapshot)                                            |
| `lineMath(line)`                                                                        | `{ gross, net, tax }` for one line, honouring inclusive/fixed                                     |
| `docTotals(lines)`                                                                      | `{ subtotal, taxTotal, total, taxes[] }` — the one calculator                                     |
| `quoteTotals(q)` / `lineTotal(line)`                                                    | totals for a quote / one line                                                                     |
| `depositFor(q)`                                                                         | deposit in cents from `depositType` (`NONE/PERCENT/FLAT`)                                         |
| `syncInvoice(inv)`                                                                      | recomputes totals, `amountPaid`, `balance`, `status`, `vehicleHold`; **returns early for `VOID`** |
| `taxById` / `taxByCode` / `activeTaxes` / `defaultTaxFor` / `taxLabel` / `taxRateLabel` | tax lookups and labels                                                                            |
| `buildLines(jobId)`                                                                     | accepted base + add-on lines ready to invoice (`{ lines, base, addons, settlement }`)             |
| `invoiceNeedsUpdate(jobId)`                                                             | `null` or `{ delta, lines }` for "accepted work not yet billed"                                   |
| `seed()`                                                                                | resets the demo to the three seed jobs                                                            |
| `actions`                                                                               | the workflow API (below)                                                                          |

Internal (not exported): `log()`, `nextQuoteNo()`, `linesFromQuote()`, `jobPaid()`, `jobRefunded()`, `completeRefundRecord()`, `openBuilder()`.

### Selectors (`Store.sel`)

| Selector                                                   | Returns                                 |
| ---------------------------------------------------------- | --------------------------------------- |
| `job`, `quote`, `invoice`, `payment`, `receipt`, `service` | one record by id                        |
| `receiptForPayment(pid)` / `receiptForInvoice(invId)`      | the receipt for a payment / invoice     |
| `quotesForJob(jobId)`                                      | every quote, oldest first               |
| `activeQuote(jobId)`                                       | the open one (`DRAFT`/pending)          |
| `stdQuote(jobId)`                                          | the accepted `STANDARD` quote           |
| `invoicesForJob(jobId)`                                    | every document on the job               |
| `stdInvoice(jobId)`                                        | the **live** tax invoice (never `VOID`) |
| `voidedInvoices(jobId)`                                    | the void history                        |
| `invoiceVersions(jobId)`                                   | every tax invoice, sorted by `seq`      |
| `openProforma(jobId)`                                      | the `ISSUED` proforma, if any           |
| `receiptsForJob(jobId)`                                    | receipts (valid and void)               |
| `paymentsForInvoice`, `paymentsForJob`                     | payments                                |
| `refundsForJob`, `creditNotesForInvoice`                   | refunds and credit notes                |
| `cancellationsForJob`, `openCancellation`                  | cancellation requests                   |
| `storageForJob`, `timelineForJob`                          | storage fees, audit trail               |

### Actions (`Store.actions`)

| Group           | Actions                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation      | `setRole`, `setScreen`, `selectJob`, `setTab`, `reset`                                                                                                                                                     |
| Builder         | `openBuilder`, `closeBuilder`, `builderCat`, `builderSearch`, `builderAddService`, `builderBlankLine`, `builderRemoveItem`, `builderSetDeposit`, `builderCreateService`, `builderSaveDraft`, `builderSend` |
| Quote editing   | `startEdit`, `cancelEdit`, `addItem`, `removeItem`, `setItemTax`, `addServices`, `toggleDependency`, `addCondition`                                                                                        |
| Quote lifecycle | `saveEdit`, `sendQuote`, `acceptQuote`, `rejectQuote`                                                                                                                                                      |
| New quotes      | `createGarageQuote`, `createSupplementary`, `createWarranty`, `createRfq`, `createSettlement`                                                                                                              |
| Documents       | `generateProforma`, `generateInvoice`, **`voidInvoice(invoiceId, reason)`**                                                                                                                                |
| Cancellation    | `requestCancellation`, `declineCancellation`                                                                                                                                                               |
| Money           | `recordPayment`, `requestRefund`, `decideRefund`, `issueRefund`, `completeRefund`, `addStorageFee`                                                                                                         |
| Tax / catalog   | `saveTax`, `deactivateTax`, `saveService`, `removeService`                                                                                                                                                 |

## Function reference (`js/views.js`)

| Function                                              | Renders                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `render()`                                            | the whole screen (role switch + sidebar + main)                       |
| `renderSidebar()` / `renderMain()`                    | job list / the current screen                                         |
| `jobHeader`, `tabs`, `tabBody`                        | job header, tab bar, active tab                                       |
| `viewOverview`                                        | KPIs, Vehicle Hold banner, cancellation panel, workflow steps         |
| `viewQuotes` → `quoteCard`                            | quote cards with lines, tax, totals, conditions, revisions, actions   |
| `viewBill`                                            | proforma + live invoice + warranty docs + **voided versions**         |
| `proformaDoc`, `invoiceDoc`, `linesTable`, `taxBlock` | document bodies (shared line/tax rendering)                           |
| **`versionHistory(job, voided)`**                     | the voided-versions table                                             |
| **`voidedDoc(job, inv)`**                             | a frozen, read-only, watermarked void document                        |
| `viewPayments`                                        | payable cards (live invoices only) + payment ledger with void markers |
| `viewRefunds`, `viewAudit`                            | refund workflow, audit timeline                                       |
| `viewBuilder`                                         | full-screen builder (catalog + lines + deposit)                       |
| `viewTaxes`, `viewCatalog`                            | tax engine screen, service catalog                                    |

## Function reference (`js/app.js`)

| Function                                   | Does                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toast(msg, kind)`                         | transient notification                                                                                                                               |
| `openModal(opts)` / `closeModal()`         | modal shell, submit handling, focus                                                                                                                  |
| `taxSelectOptions(code)`                   | tax dropdown markup                                                                                                                                  |
| `handlers`                                 | one entry per `data-act` (navigation, builder, quotes, documents incl. **`voidInvoiceModal`**, payments, receipts, refunds, taxes, catalog, new job) |
| click / input / change / keydown listeners | delegated events; live line editing keeps focus by patching `#lt-*` and `#qtotal-*` instead of re-rendering                                          |

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
- A settings screen for `reissueInvoiceOnPayment` (the flag exists in `js/store.js`; there is no UI for it)
