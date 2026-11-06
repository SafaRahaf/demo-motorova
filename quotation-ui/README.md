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

| Job                        | State                               | Good for trying                                             |
| -------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| **JC-1042** Toyota Corolla | Garage quote pending customer       | Negotiation, configurable tax, proforma, invoice generation |
| **JC-1043** Honda Civic    | Customer RFQ pending garage         | Garage answering with catalog services                      |
| **JC-1044** BMW 320i       | Invoiced, deposit paid, in progress | Change orders, cancellation, unbundling, warranty           |

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

Inside a quote being edited: **+ From service list** opens a picker; **+ Blank custom line** adds a free-form line. Everything stays editable afterwards (description, qty, price, tax).

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

## Flows you can still click

| Flow                                                   | Where                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Counter-offer / accept / reject / conditions           | Quotes tab                                                               |
| Supplementary quote + dependency flag                  | Overview (garage) → _Supplementary quote_                                |
| Cancellation → settlement → unbundle packages          | Overview → _Request cancellation_, then garage _Create settlement quote_ |
| Deposit / balance / milestone payments + auto receipts | Payments tab (tax invoice only)                                          |
| Refund request → approval → **Credit Note**            | Refunds tab                                                              |
| Daily storage fees                                     | Overview (garage) → _Add storage fee_                                    |
| Warranty rework at $0.00                               | Overview (garage) → _Warranty quote_                                     |
| Full audit trail                                       | Audit trail tab                                                          |

## Design rules baked into the code

- **Money is integer cents.** Formatted only at render time.
- **`balance = total − paid`.** A refund returns money but never re-opens a debt; it emits a Credit Note.
- **Vehicle Hold** is derived: `balance > 0` on a **tax invoice** only. Proformas never create a hold.
- **Tax lives on the line**, never in a global setting. `docTotals()` is the one shared calculator for quotes and invoices.
- **Derived values are computed in one place**, never trusted from the browser.

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
