/* =========================================================
   store.js — mock data + business rules for the prototype.
   No backend, no database. Everything lives in memory.

   Money = INTEGER CENTS everywhere.
   Tax lives on the LINE (snapshot), never on a global setting,
   so changing a rate tomorrow cannot rewrite yesterday's bill.
   ========================================================= */
(function (global) {
  "use strict";

  /* ---------------- utils ---------------- */
  const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 9);
  const nowISO = () => new Date().toISOString();
  const addDays = (iso, n) => {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return d.toISOString();
  };
  /* Display currency. Change these two values to switch the whole UI (£ ⇄ $).
     Stored money is always integer minor units, so this is display-only. */
  const CURRENCY = "GBP";
  const LOCALE = "en-GB";
  const money = (cents) =>
    new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: CURRENCY,
    }).format((cents || 0) / 100);
  const fmtDateTime = (iso) =>
    iso
      ? new Date(iso).toLocaleString(LOCALE, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "—";
  const fmtDay = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString(LOCALE, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "—";

  const refresh = () => {
    if (global.App && global.App.render) global.App.render();
  };
  const toast = (msg, kind) => {
    if (global.App && global.App.toast) global.App.toast(msg, kind);
  };

  /* ---------------- state ---------------- */
  const S = {
    role: "garage",
    screen: "job", // 'job' | 'taxes' | 'services' | 'builder'
    jobId: "job_1",
    tab: "overview",
    editingQuoteId: null,
    builderQuoteId: null,
    builderSearch: "",
    builderCat: "all",
    settings: {
      depositType: "PERCENT",
      depositValue: 30,
      storageDailyRate: 3500,
      storageGraceDays: 3,
      /* false = payments accumulate on the live invoice (recommended).
         true  = every payment issues a new version and voids the previous one.
         Voiding is otherwise reserved for the "combine invoices" action. */
      reissueInvoiceOnPayment: false,
    },
    taxes: [],
    services: [],
    jobs: [],
    quotes: [],
    invoices: [],
    payments: [],
    receipts: [],
    refunds: [],
    creditNotes: [],
    cancellations: [],
    storage: [],
    timeline: [],
  };

  let counters = {
    inv: 5001,
    pro: 8001,
    pay: 9001,
    rec: 7001,
    ref: 3001,
    cn: 101,
  };

  /* =========================================================
     SELECTORS
     ========================================================= */
  const sel = {
    job: (id) => S.jobs.find((j) => j.id === id),
    quote: (id) => S.quotes.find((q) => q.id === id),
    invoice: (id) => S.invoices.find((i) => i.id === id),
    payment: (id) => S.payments.find((p) => p.id === id),
    receipt: (id) => S.receipts.find((r) => r.id === id),
    receiptForPayment: (pid) => S.receipts.find((r) => r.paymentId === pid),
    service: (id) => S.services.find((s) => s.id === id),

    quotesForJob: (jobId) =>
      S.quotes
        .filter((q) => q.jobId === jobId)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    activeQuote: (jobId) =>
      sel
        .quotesForJob(jobId)
        .filter((q) =>
          [
            "DRAFT",
            "PENDING_GARAGE_APPROVAL",
            "PENDING_CUSTOMER_APPROVAL",
          ].includes(q.status),
        )
        .pop(),
    stdQuote: (jobId) =>
      sel
        .quotesForJob(jobId)
        .find((q) => q.type === "STANDARD" && q.status === "ACCEPTED"),

    invoicesForJob: (jobId) => S.invoices.filter((i) => i.jobId === jobId),
    stdInvoice: (jobId) =>
      S.invoices.find(
        (i) =>
          i.jobId === jobId && i.kind === "TAX_INVOICE" && i.status !== "VOID",
      ),
    /* Every payable tax invoice on the job. More than one is normal: each
       accepted quote gets its own document, and nothing is voided to get there. */
    liveInvoices: (jobId) =>
      S.invoices.filter(
        (i) =>
          i.jobId === jobId && i.kind === "TAX_INVOICE" && i.status !== "VOID",
      ),
    voidedInvoices: (jobId) =>
      S.invoices.filter(
        (i) =>
          i.jobId === jobId && i.kind === "TAX_INVOICE" && i.status === "VOID",
      ),
    invoiceVersions: (jobId) =>
      S.invoices
        .filter((i) => i.jobId === jobId && i.kind === "TAX_INVOICE")
        .sort((a, b) => (a.seq || 1) - (b.seq || 1)),
    receiptsForJob: (jobId) => S.receipts.filter((r) => r.jobId === jobId),
    receiptForInvoice: (invId) => S.receipts.find((r) => r.invoiceId === invId),
    /* Receipts printed on a document: valid ones first (newest last), then the
       voided history, so the totals block can show both without ambiguity. */
    receiptsForInvoice: (invId) =>
      S.receipts
        .filter((r) => r.invoiceId === invId)
        .sort((a, b) => new Date(a.issuedAt) - new Date(b.issuedAt)),
    openProforma: (jobId) =>
      S.invoices
        .filter(
          (i) =>
            i.jobId === jobId && i.kind === "PROFORMA" && i.status === "ISSUED",
        )
        .pop(),

    paymentsForInvoice: (invId) =>
      S.payments.filter((p) => p.invoiceId === invId),
    paymentsForJob: (jobId) =>
      S.payments.filter(
        (p) => (sel.invoice(p.invoiceId) || {}).jobId === jobId,
      ),

    /* ---------- quote <-> invoice traceability ---------- */
    /*
       Answers "has this quote been invoiced, and by which documents?".
       A quote may legitimately be covered by several live invoices, or by one
       that was later merged into a combined invoice — so we report all of it.
     */
    invoicesForQuote: (quoteId) => {
      const merged = new Set();
      const out = [];
      S.invoices.forEach((i) => {
        const c = i.combinedFromInvoiceIds || [];
        if (
          i.quoteId === quoteId ||
          c.some((id) => (sel.invoice(id) || {}).quoteId === quoteId)
        ) {
          out.push(i);
          if (i.supersededBy) merged.add(i.supersededBy);
        }
      });
      return out;
    },
    quoteInvoiceStatus: (quoteId) => {
      const all = sel
        .invoicesForQuote(quoteId)
        .filter((i) => i.kind === "TAX_INVOICE");
      const live = all.filter((i) => i.status !== "VOID");
      const voided = all.filter((i) => i.status === "VOID");
      const q = sel.quote(quoteId);
      return {
        invoiced: all.length > 0,
        live,
        voided,
        total: q ? quoteTotals(q).total : 0,
        /* the document to link to: live one first, else the void history */
        latest: live[live.length - 1] || voided[voided.length - 1] || null,
      };
    },
    /* Accepted quotes whose work is not on any live invoice yet. */
    uninvoicedQuotes: (jobId) =>
      sel
        .quotesForJob(jobId)
        .filter(
          (q) =>
            q.status === "ACCEPTED" &&
            ["STANDARD", "SUPPLEMENTARY", "SETTLEMENT", "WARRANTY"].includes(
              q.type,
            ) &&
            !q.invoicedAt,
        ),
    /* Sum across every live invoice — the one "what does the customer owe" number. */
    jobTotals: (jobId) => {
      const live = sel.liveInvoices(jobId);
      const total = live.reduce((s, i) => s + (i.total || 0), 0);
      const paid = live.reduce((s, i) => s + (i.amountPaid || 0), 0);
      return { total, paid, balance: Math.max(0, total - paid) };
    },
    /* Running balance shown on each ledger row. */
    balanceAfter: (paymentId) => {
      const p = sel.payment(paymentId);
      if (!p) return 0;
      const inv = sel.invoice(p.invoiceId);
      if (!inv) return 0;
      const upto = validReceipts(inv.id)
        .filter((r) => new Date(r.issuedAt) <= new Date(p.paidAt))
        .sort((a, b) => new Date(a.issuedAt) - new Date(b.issuedAt));
      const paidSoFar = upto.reduce((s, r) => s + (r.amount || 0), 0);
      const carried = inv.carriedPaid || 0;
      return Math.max(0, inv.total - carried - paidSoFar);
    },
    refundsForJob: (jobId) =>
      S.refunds.filter((r) => (sel.invoice(r.invoiceId) || {}).jobId === jobId),
    creditNotesForInvoice: (invId) =>
      S.creditNotes.filter((c) => c.invoiceId === invId),
    cancellationsForJob: (jobId) =>
      S.cancellations.filter((c) => c.jobId === jobId),
    openCancellation: (jobId) =>
      S.cancellations
        .filter((c) => c.jobId === jobId)
        .find((c) => !["AGREED", "DECLINED", "WITHDRAWN"].includes(c.status)),
    storageForJob: (jobId) => S.storage.filter((s) => s.jobId === jobId),
    timelineForJob: (jobId) =>
      S.timeline
        .filter((t) => t.jobId === jobId)
        .sort((a, b) => new Date(a.at) - new Date(b.at)),
  };

  /* =========================================================
     TAX ENGINE
     A tax row: { id, code, name, kind:'PERCENT'|'FIXED', value,
                 inclusive, appliesTo:[kinds], effectiveFrom,
                 effectiveTo, active, supersededBy }
     PERCENT value = basis points (800 = 8.00%)
     FIXED   value = cents per unit ($5.00 => 500)
     ========================================================= */
  const activeTaxes = () => S.taxes.filter((t) => t.active);
  const taxById = (id) => S.taxes.find((t) => t.id === id);
  const taxByCode = (code) =>
    S.taxes.find((t) => t.code === code && t.active) ||
    S.taxes.find((t) => t.code === code);

  const defaultTaxFor = (kind) => {
    const list = activeTaxes();
    return list.find((t) => (t.appliesTo || []).includes(kind)) || null;
  };

  const taxRateLabel = (t) => {
    if (!t) return "No tax";
    return t.kind === "PERCENT"
      ? `${(t.value / 100).toFixed(2)}%`
      : `${money(t.value)} / unit`;
  };
  const taxLabel = (t) => (t ? `${t.code} · ${taxRateLabel(t)}` : "No tax");

  /* Copy the tax definition onto the line (the snapshot). */
  function setLineTax(line, tax) {
    line.taxId = tax ? tax.id : null;
    line.taxCode = tax ? tax.code : null;
    line.taxName = tax ? tax.name : null;
    line.taxKind = tax ? tax.kind : null;
    line.taxValue = tax ? tax.value : 0;
    line.taxInclusive = tax ? !!tax.inclusive : false;
    return line;
  }

  /* Per-line maths. Returns gross (qty x price), net and tax. */
  function lineMath(line) {
    const gross = Math.round((line.qty || 0) * (line.unitPrice || 0));
    if (!line.taxId) return { gross, net: gross, tax: 0 };

    if (line.taxKind === "PERCENT") {
      const rate = (line.taxValue || 0) / 10000;
      if (line.taxInclusive) {
        const net = Math.round(gross / (1 + rate)); // tax is already inside the price
        return { gross, net, tax: gross - net };
      }
      return { gross, net: gross, tax: Math.round(gross * rate) };
    }
    // FIXED: charged per unit, added on top
    return {
      gross,
      net: gross,
      tax: Math.round((line.taxValue || 0) * (line.qty || 0)),
    };
  }

  /* One function used by BOTH quotes and invoices. */
  function docTotals(lines) {
    let subtotal = 0;
    let taxTotal = 0;
    const map = new Map();

    (lines || []).forEach((line) => {
      const m = lineMath(line);
      subtotal += m.net;
      taxTotal += m.tax;
      if (line.taxId) {
        if (!map.has(line.taxId)) {
          map.set(line.taxId, {
            id: line.taxId,
            code: line.taxCode,
            name: line.taxName,
            kind: line.taxKind,
            value: line.taxValue,
            inclusive: line.taxInclusive,
            base: 0,
            amount: 0,
          });
        }
        const e = map.get(line.taxId);
        e.base += m.net;
        e.amount += m.tax;
      }
    });

    return {
      subtotal,
      taxTotal,
      total: subtotal + taxTotal,
      taxes: [...map.values()],
    };
  }

  const quoteTotals = (q) => docTotals(q.items);
  const lineTotal = (line) =>
    Math.round((line.qty || 0) * (line.unitPrice || 0));

  function depositFor(q) {
    const total = quoteTotals(q).total;
    if (q.depositType === "PERCENT")
      return Math.round((total * (q.depositValue || 0)) / 100);
    if (q.depositType === "FLAT")
      return Math.round((q.depositValue || 0) * 100);
    return 0;
  }

  /* =========================================================
     INVOICE MATH
     ========================================================= */
  /*
     Money received against ONE invoice is derived from its RECEIPTS, not from
     the payment rows. A receipt is the customer-facing proof of payment, so it
     is the single source of truth for what has been collected.

     Only VALID receipts count. A VOID receipt stays visible on the document for
     history (struck through) but is never deducted — otherwise a consolidated
     invoice would subtract the same money twice.
  */
  const validReceipts = (invoiceId) =>
    S.receipts.filter((r) => r.invoiceId === invoiceId && r.status === "VALID");

  const voidReceipts = (invoiceId) =>
    S.receipts.filter((r) => r.invoiceId === invoiceId && r.status === "VOID");

  const invoicePaid = (invoiceId) =>
    validReceipts(invoiceId).reduce((s, r) => s + (r.amount || 0), 0);

  const invoiceRefunded = (invoiceId) =>
    S.refunds
      .filter((r) => r.invoiceId === invoiceId && r.status === "COMPLETED")
      .reduce((s, r) => s + r.amount, 0);

  /* Kept for the job-level summary views. */
  const jobPaid = (jobId) => sel.jobTotals(jobId).paid;

  const jobRefunded = (jobId) =>
    S.refunds
      .filter((r) => {
        const i = sel.invoice(r.invoiceId);
        return i && i.jobId === jobId && r.status === "COMPLETED";
      })
      .reduce((s, r) => s + r.amount, 0);

  /*
     Recompute a document's money from its lines and its own payments.
     `carriedPaid` holds money received on invoices that were later merged into
     this one, so a combined invoice still shows the true balance:
        balance = total - carriedPaid - payments made on this invoice
     A VOID document is frozen: it keeps the figures it had when voided.
  */
  function syncInvoice(inv) {
    const t = docTotals(inv.lines);
    inv.subtotal = t.subtotal;
    inv.taxTotal = t.taxTotal;
    inv.taxes = t.taxes;
    inv.total = t.total;

    if (inv.kind === "PROFORMA") {
      inv.amountPaid = 0;
      inv.refunded = 0;
      inv.balance = 0; // a proforma never chases money
      inv.vehicleHold = false;
      if (!["SUPERSEDED", "VOID"].includes(inv.status)) inv.status = "ISSUED";
      return inv;
    }

    /* A voided version is frozen: it keeps the figures it had when replaced. */
    if (inv.status === "VOID") return inv;

    /* Warranty rework is always zero-dollar and never carries payments. */
    if (inv.kind === "WARRANTY") {
      inv.amountPaid = 0;
      inv.refunded = 0;
      inv.balance = 0;
      inv.status = "PAID";
      inv.vehicleHold = false;
      return inv;
    }

    const paid = invoicePaid(inv.id);
    const refunded = invoiceRefunded(inv.id);
    const carried = inv.carriedPaid || 0;
    const balance = Math.max(0, inv.total - carried - paid);

    inv.amountPaid = paid + carried;
    inv.refunded = refunded;
    inv.balance = balance;

    if (inv.total === 0) inv.status = "PAID";
    else if (balance === 0) inv.status = "PAID";
    else if (inv.amountPaid > 0) inv.status = "PARTIALLY_PAID";
    else inv.status = "UNPAID";

    inv.vehicleHold = inv.kind === "TAX_INVOICE" && balance > 0;
    return inv;
  }

  /* =========================================================
     AUDIT LOG
     ========================================================= */
  function log(jobId, quoteId, actor, action, note, before, after) {
    S.timeline.push({
      id: uid("tl"),
      jobId,
      quoteId,
      actor,
      action,
      note,
      amountBefore: before === undefined ? null : before,
      amountAfter: after === undefined ? null : after,
      at: nowISO(),
    });
  }

  const nextQuoteNo = (job) =>
    "Q-" +
    job.jobNo.replace("JC-", "") +
    "-" +
    (sel.quotesForJob(job.id).length + 1);

  /* =========================================================
     LINE BUILDERS
     ========================================================= */
  function linesFromQuote(q, isAddon) {
    return q.items.map((i) => ({
      id: uid("ln"),
      quoteId: q.id,
      quoteType: q.type,
      description: i.description,
      qty: i.qty,
      unitPrice: i.unitPrice,
      taxId: i.taxId,
      taxCode: i.taxCode,
      taxName: i.taxName,
      taxKind: i.taxKind,
      taxValue: i.taxValue,
      taxInclusive: i.taxInclusive,
      isAddon: !!isAddon,
    }));
  }

  /* Every accepted quote on the job, ready to become invoice lines. */
  function buildLines(jobId) {
    const accepted = sel
      .quotesForJob(jobId)
      .filter((q) => q.status === "ACCEPTED" && q.type !== "WARRANTY");
    const settlement = accepted.find((q) => q.type === "SETTLEMENT");
    const base = settlement || accepted.find((q) => q.type === "STANDARD");
    const addons = accepted.filter((q) => q.type === "SUPPLEMENTARY");

    const lines = [];
    if (base) lines.push(...linesFromQuote(base, false));
    addons.forEach((q) => lines.push(...linesFromQuote(q, true)));

    return { lines, base, addons, settlement };
  }

  /* Lines for ONE quote, ready to invoice. */
  function linesForQuote(q) {
    return linesFromQuote(q, q.type === "SUPPLEMENTARY");
  }

  /*
     True when there is accepted work that has not reached any live invoice.
     Since documents are issued per quote, this reports how much un-invoiced
     work exists rather than diffing a single "current" invoice.
  */
  function invoiceNeedsUpdate(jobId) {
    const pending = sel.uninvoicedQuotes(jobId);
    if (!pending.length) return null;
    const total = pending.reduce((s, q) => s + quoteTotals(q).total, 0);
    const lines = pending.reduce((s, q) => s + q.items.length, 0);
    return { delta: total, lines, quotes: pending.length };
  }

  /* =========================================================
     SEED
     ========================================================= */
  function seed() {
    S.jobs = [];
    S.quotes = [];
    S.invoices = [];
    S.payments = [];
    S.receipts = [];
    S.refunds = [];
    S.creditNotes = [];
    S.cancellations = [];
    S.storage = [];
    S.timeline = [];
    counters = {
      inv: 5004,
      pro: 8004,
      pay: 9004,
      rec: 7004,
      ref: 3004,
      cn: 101,
    };

    const t = nowISO();
    const FROM = "2024-01-01T00:00:00.000Z";

    /* ---------- taxes ---------- */
    S.taxes = [
      {
        id: "tax_vat_std",
        code: "VAT-STD",
        name: "VAT (standard)",
        kind: "PERCENT",
        value: 800,
        inclusive: false,
        appliesTo: ["SERVICE", "FEE"],
        effectiveFrom: FROM,
        effectiveTo: null,
        active: true,
        supersededBy: null,
      },
      {
        id: "tax_vat_lab",
        code: "VAT-LAB",
        name: "VAT (labour)",
        kind: "PERCENT",
        value: 800,
        inclusive: false,
        appliesTo: ["LABOR"],
        effectiveFrom: FROM,
        effectiveTo: null,
        active: true,
        supersededBy: null,
      },
      {
        id: "tax_vat_prt",
        code: "VAT-PRT",
        name: "VAT (parts)",
        kind: "PERCENT",
        value: 500,
        inclusive: false,
        appliesTo: ["PART"],
        effectiveFrom: FROM,
        effectiveTo: null,
        active: true,
        supersededBy: null,
      },
      {
        id: "tax_env_tyr",
        code: "ENV-TYR",
        name: "Tyre environmental levy",
        kind: "FIXED",
        value: 500,
        inclusive: false,
        appliesTo: [],
        effectiveFrom: "2024-03-01T00:00:00.000Z",
        effectiveTo: null,
        active: true,
        supersededBy: null,
      },
      {
        id: "tax_wst_dis",
        code: "WST-DIS",
        name: "Waste disposal",
        kind: "FIXED",
        value: 1200,
        inclusive: false,
        appliesTo: ["FEE"],
        effectiveFrom: "2024-06-01T00:00:00.000Z",
        effectiveTo: null,
        active: true,
        supersededBy: null,
      },
      {
        id: "tax_inc_prt",
        code: "VAT-PRT-INC",
        name: "VAT (parts, tax-inclusive)",
        kind: "PERCENT",
        value: 500,
        inclusive: true,
        appliesTo: [],
        effectiveFrom: FROM,
        effectiveTo: null,
        active: true,
        supersededBy: null,
      },
      /* historical version, kept for the audit trail */
      {
        id: "tax_vat_old",
        code: "VAT-STD",
        name: "VAT (standard, 2023)",
        kind: "PERCENT",
        value: 750,
        inclusive: false,
        appliesTo: ["SERVICE", "FEE"],
        effectiveFrom: "2023-01-01T00:00:00.000Z",
        effectiveTo: "2023-12-31T00:00:00.000Z",
        active: false,
        supersededBy: "tax_vat_std",
      },
    ];

    /* ---------- service catalog ---------- */
    S.services = [
      {
        id: "svc_oil",
        name: "Oil & filter change",
        category: "Maintenance",
        price: 9900,
        taxCode: "VAT-STD",
        unit: "job",
      },
      {
        id: "svc_brake_pad",
        name: "Front brake pads (OEM)",
        category: "Brakes",
        price: 8900,
        taxCode: "VAT-PRT",
        unit: "set",
      },
      {
        id: "svc_rotor",
        name: "Brake rotors (pair)",
        category: "Brakes",
        price: 14500,
        taxCode: "VAT-PRT",
        unit: "pair",
      },
      {
        id: "svc_brake_fluid",
        name: "Brake fluid flush",
        category: "Brakes",
        price: 6900,
        taxCode: "VAT-STD",
        unit: "job",
      },
      {
        id: "svc_brake_lab",
        name: "Brake overhaul labour",
        category: "Brakes",
        price: 9500,
        taxCode: "VAT-LAB",
        unit: "hour",
      },
      {
        id: "svc_align",
        name: "Four-wheel alignment",
        category: "Tyres",
        price: 7200,
        taxCode: "VAT-STD",
        unit: "job",
      },
      {
        id: "svc_tyre",
        name: "Tyre replacement",
        category: "Tyres",
        price: 12500,
        taxCode: "VAT-PRT",
        unit: "tyre",
      },
      {
        id: "svc_tyre_levy",
        name: "Tyre disposal levy",
        category: "Tyres",
        price: 500,
        taxCode: "ENV-TYR",
        unit: "tyre",
      },
      {
        id: "svc_ac",
        name: "A/C recharge (R-134a)",
        category: "Climate",
        price: 18000,
        taxCode: "VAT-STD",
        unit: "job",
      },
      {
        id: "svc_diag",
        name: "Diagnostic scan",
        category: "Diagnostics",
        price: 6000,
        taxCode: "VAT-STD",
        unit: "job",
      },
      {
        id: "svc_battery",
        name: "Battery replacement",
        category: "Electrical",
        price: 15900,
        taxCode: "VAT-PRT",
        unit: "unit",
      },
      {
        id: "svc_coolant",
        name: "Coolant flush",
        category: "Maintenance",
        price: 8900,
        taxCode: "VAT-STD",
        unit: "job",
      },
      {
        id: "svc_cabin",
        name: "Cabin air filter",
        category: "Filters",
        price: 5900,
        taxCode: "VAT-PRT",
        unit: "unit",
      },
      {
        id: "svc_wiper",
        name: "Wiper blades (pair)",
        category: "Filters",
        price: 3200,
        taxCode: "VAT-PRT",
        unit: "pair",
      },
      {
        id: "svc_shop",
        name: "Shop supplies & disposal",
        category: "Fees",
        price: 2500,
        taxCode: "WST-DIS",
        unit: "job",
      },
      {
        id: "svc_labour",
        name: "General labour",
        category: "Labour",
        price: 9500,
        taxCode: "VAT-LAB",
        unit: "hour",
      },
    ];

    /* helper: build a quote line with its tax snapshot */
    const mkItem = (kind, desc, qty, price, taxCode, extra) =>
      setLineTax(
        Object.assign(
          { id: uid("qi"), kind, description: desc, qty, unitPrice: price },
          extra || {},
        ),
        taxByCode(taxCode),
      );

    /* ---------- JOB 1 — garage quote awaiting customer ---------- */
    S.jobs.push({
      id: "job_1",
      jobNo: "JC-1042",
      garageName: "Northgate Auto Works",
      customerName: "Dana Whitfield",
      customerEmail: "dana.whitfield@example.com",
      vehicle: {
        year: 2016,
        make: "Toyota",
        model: "Corolla",
        plate: "KX-4471",
        vin: "JT2BF22K1W0123456",
        odometer: 128400,
      },
      status: "QUOTING",
      createdAt: addDays(t, -2),
      pausedReason: null,
      dependsOnQuoteId: null,
    });

    const q1 = {
      id: "q_1",
      jobId: "job_1",
      no: "Q-1042-1",
      type: "STANDARD",
      status: "PENDING_CUSTOMER_APPROVAL",
      createdByRole: "GARAGE",
      parentQuoteId: null,
      originalInvoiceId: null,
      items: [
        mkItem("PART", "Front brake pads (set, OEM)", 1, 8900, "VAT-PRT"),
        mkItem("PART", "Brake rotors (pair)", 1, 14500, "VAT-PRT"),
        mkItem("LABOR", "Brake overhaul labour", 3.5, 9500, "VAT-LAB"),
        mkItem("FEE", "Shop supplies & disposal", 1, 2500, "WST-DIS"),
      ],
      conditions: [
        {
          id: "qc_1",
          text: "Must use OEM parts only.",
          addedBy: "GARAGE",
          at: addDays(t, -1),
        },
      ],
      hasDependency: false,
      isChangeOrder: false,
      depositType: "PERCENT",
      depositValue: 30,
      expiryDate: addDays(t, 6),
      revision: 1,
      createdAt: addDays(t, -1),
      acceptedAt: null,
      rejectedAt: null,
      lockedAt: null,
    };
    q1.revisions = [
      { no: 1, total: quoteTotals(q1).total, by: "Garage", at: addDays(t, -1) },
    ];
    S.quotes.push(q1);
    log(
      "job_1",
      "q_1",
      "Garage",
      "CREATE",
      "Initial quote sent after vehicle inspection.",
      null,
      quoteTotals(q1).total,
    );

    /* ---------- JOB 2 — customer RFQ awaiting garage ---------- */
    S.jobs.push({
      id: "job_2",
      jobNo: "JC-1043",
      garageName: "Northgate Auto Works",
      customerName: "Dana Whitfield",
      customerEmail: "dana.whitfield@example.com",
      vehicle: {
        year: 2019,
        make: "Honda",
        model: "Civic",
        plate: "PL-8890",
        vin: "19XFC2F59KE001234",
        odometer: 61200,
      },
      status: "REQUESTED",
      createdAt: addDays(t, -1),
      pausedReason: null,
      dependsOnQuoteId: null,
    });

    const q2 = {
      id: "q_2",
      jobId: "job_2",
      no: "Q-1043-1",
      type: "STANDARD",
      status: "PENDING_GARAGE_APPROVAL",
      createdByRole: "CUSTOMER",
      parentQuoteId: null,
      originalInvoiceId: null,
      items: [
        mkItem(
          "LABOR",
          "A/C not cooling — diagnostic inspection",
          1,
          6000,
          "VAT-LAB",
        ),
        mkItem("SERVICE", "Refrigerant recharge (R-134a)", 1, 18000, "VAT-STD"),
      ],
      conditions: [
        {
          id: "qc_2",
          text: "Budget cap is $400.00 — please confirm before exceeding.",
          addedBy: "CUSTOMER",
          at: addDays(t, -1),
        },
      ],
      hasDependency: false,
      isChangeOrder: false,
      depositType: "PERCENT",
      depositValue: 30,
      expiryDate: addDays(t, 9),
      revision: 1,
      createdAt: addDays(t, -1),
      acceptedAt: null,
      rejectedAt: null,
      lockedAt: null,
    };
    q2.revisions = [
      {
        no: 1,
        total: quoteTotals(q2).total,
        by: "Customer",
        at: addDays(t, -1),
      },
    ];
    S.quotes.push(q2);
    log(
      "job_2",
      "q_2",
      "Customer",
      "CREATE",
      "Request for Quote submitted with budget cap.",
      null,
      quoteTotals(q2).total,
    );

    /* ---------- JOB 3 — accepted, invoiced, deposit paid ---------- */
    S.jobs.push({
      id: "job_3",
      jobNo: "JC-1044",
      garageName: "Northgate Auto Works",
      customerName: "Dana Whitfield",
      customerEmail: "dana.whitfield@example.com",
      vehicle: {
        year: 2021,
        make: "BMW",
        model: "320i",
        plate: "BM-2210",
        vin: "WBA5R1C0XMFL12345",
        odometer: 34850,
      },
      status: "IN_PROGRESS",
      createdAt: addDays(t, -6),
      pausedReason: null,
      dependsOnQuoteId: null,
    });

    const q3 = {
      id: "q_3",
      jobId: "job_3",
      no: "Q-1044-1",
      type: "STANDARD",
      status: "ACCEPTED",
      createdByRole: "GARAGE",
      parentQuoteId: null,
      originalInvoiceId: null,
      items: [
        mkItem("SERVICE", "Oil & filter change", 1, 9900, "VAT-STD", {
          packageRef: "pkg_full",
          standaloneUnitPrice: 12000,
        }),
        mkItem("SERVICE", "Brake fluid flush", 1, 6900, "VAT-STD", {
          packageRef: "pkg_full",
          standaloneUnitPrice: 9000,
        }),
        mkItem("SERVICE", "Cabin air filter replacement", 1, 5900, "VAT-PRT", {
          packageRef: "pkg_full",
          standaloneUnitPrice: 7000,
        }),
        mkItem("SERVICE", "Four-wheel alignment", 1, 7200, "VAT-STD", {
          packageRef: "pkg_full",
          standaloneUnitPrice: 11000,
        }),
      ],
      conditions: [
        {
          id: "qc_3",
          text: 'Bundled "Full Service Package" price — discounted vs. standalone rates.',
          addedBy: "GARAGE",
          at: addDays(t, -6),
        },
      ],
      hasDependency: false,
      isChangeOrder: false,
      depositType: "PERCENT",
      depositValue: 30,
      expiryDate: addDays(t, -1),
      revision: 1,
      createdAt: addDays(t, -6),
      acceptedAt: addDays(t, -5),
      rejectedAt: null,
      lockedAt: addDays(t, -5),
    };
    q3.revisions = [
      { no: 1, total: quoteTotals(q3).total, by: "Garage", at: addDays(t, -6) },
    ];
    S.quotes.push(q3);
    /* the seed invoice already covers this quote */
    q3.invoicedAt = addDays(t, -5);
    q3.invoiceIds = ["inv_3"];

    const inv3 = {
      id: "inv_3",
      jobId: "job_3",
      quoteId: "q_3",
      no: "INV-5003",
      kind: "TAX_INVOICE",
      originalInvoiceId: null,
      settlementQuoteId: null,
      supersedes: null,
      supersededBy: null,
      voidedAt: null,
      voidReason: null,
      seq: 1,
      paymentId: null,
      lines: linesFromQuote(q3, false),
      issuedAt: addDays(t, -5),
      dueAt: addDays(t, 9),
      depositRequired: depositFor(q3),
      depositType: "PERCENT",
      depositValue: 30,
    };
    S.invoices.push(inv3);
    syncInvoice(inv3);

    S.payments.push({
      id: "pay_3",
      invoiceId: "inv_3",
      no: "PAY-9003",
      amount: inv3.depositRequired,
      type: "DEPOSIT",
      method: "CARD",
      status: "SUCCEEDED",
      paidAt: addDays(t, -4),
    });
    S.receipts.push({
      id: "rec_3",
      paymentId: "pay_3",
      invoiceId: "inv_3",
      jobId: "job_3",
      no: "RCP-7003",
      status: "VALID",
      amount: inv3.depositRequired,
      method: "CARD",
      type: "DEPOSIT",
      issuedAt: addDays(t, -4),
      emailedTo: "dana.whitfield@example.com",
      paidToDate: inv3.depositRequired,
      balanceAfter: inv3.total - inv3.depositRequired,
      supersededBy: null,
      voidedAt: null,
    });
    syncInvoice(inv3);

    log(
      "job_3",
      "q_3",
      "Garage",
      "CREATE",
      "Full Service Package quoted (bundled pricing).",
      null,
      quoteTotals(q3).total,
    );
    log(
      "job_3",
      "q_3",
      "Customer",
      "ACCEPT",
      "Quote accepted and locked.",
      quoteTotals(q3).total,
      quoteTotals(q3).total,
    );
    log(
      "job_3",
      null,
      "System",
      "INVOICE_ISSUED",
      "Invoice INV-5003 generated from accepted quote.",
      null,
      inv3.total,
    );
    log(
      "job_3",
      null,
      "System",
      "PAYMENT_RECEIVED",
      `PAY-9003 · ${money(inv3.depositRequired)} deposit (CARD). Receipt RCP-7003 emailed.`,
      null,
      inv3.depositRequired,
    );
    log(
      "job_3",
      null,
      "Garage",
      "WORK_STARTED",
      "Deposit received — work commenced.",
      null,
      null,
    );
  }

  /* Open the full-screen quote builder on a given quote. */
  function openBuilder(state, quoteId) {
    state.screen = "builder";
    state.builderQuoteId = quoteId;
    state.builderSearch = "";
    state.builderCat = "all";
    state.editingQuoteId = null;
    return state;
  }

  /* =========================================================
     ACTIONS
     ========================================================= */
  const actions = {
    /* ---------- navigation ---------- */
    setScreen(screen) {
      S.screen = screen;
      S.tab = "overview";
      S.editingQuoteId = null;
      refresh();
    },
    selectJob(id) {
      S.jobId = id;
      S.screen = "job";
      S.tab = "overview";
      S.editingQuoteId = null;
      refresh();
    },
    setTab(tab) {
      S.tab = tab;
      S.editingQuoteId = null;
      refresh();
    },
    reset() {
      seed();
      S.role = "garage";
      S.screen = "job";
      S.jobId = "job_1";
      S.tab = "overview";
      S.editingQuoteId = null;
      refresh();
    },

    /* ---------- quote builder (full screen) ---------- */
    openBuilder(quoteId) {
      openBuilder(S, quoteId);
      refresh();
    },
    closeBuilder() {
      S.screen = "job";
      S.builderQuoteId = null;
      S.tab = "quotes";
      refresh();
    },
    builderCat(cat) {
      S.builderCat = cat;
      refresh();
    },
    builderSearch(value) {
      S.builderSearch = value; // list filtering happens in the DOM
    },
    builderAddService(serviceId) {
      if (!S.builderQuoteId) return;
      actions.addServices(S.builderQuoteId, [serviceId]);
    },
    builderBlankLine() {
      if (!S.builderQuoteId) return;
      actions.addItem(S.builderQuoteId);
    },
    builderRemoveItem(itemId) {
      if (!S.builderQuoteId) return;
      actions.removeItem(S.builderQuoteId, itemId);
    },
    builderSetDeposit(type, value) {
      const q = sel.quote(S.builderQuoteId);
      if (!q) return;
      q.depositType = type;
      q.depositValue = Number(value) || 0;
      refresh();
    },
    builderCreateService(payload) {
      const price = Math.round((Number(payload.price) || 0) * 100);
      const svc = {
        id: uid("svc"),
        name: payload.name,
        category: payload.category || "General",
        price,
        taxCode: payload.taxCode,
        unit: "job",
      };
      S.services.push(svc);
      log(
        S.jobId,
        null,
        "Garage",
        "SERVICE_CREATED",
        `Catalog service "${svc.name}" created.`,
        null,
        price,
      );
      if (S.builderQuoteId) {
        const line = {
          id: uid("qi"),
          kind: svc.category === "Labour" ? "LABOR" : "SERVICE",
          description: svc.name,
          qty: 1,
          unitPrice: svc.price,
          serviceId: svc.id,
        };
        setLineTax(line, taxByCode(svc.taxCode) || defaultTaxFor(line.kind));
        sel.quote(S.builderQuoteId).items.push(line);
      }
      toast(`Service "${svc.name}" created and added.`, "ok");
      refresh();
    },
    builderSaveDraft() {
      const q = sel.quote(S.builderQuoteId);
      if (!q) return;
      log(
        q.jobId,
        q.id,
        "Garage",
        "QUOTE_DRAFT",
        `Quote ${q.no} saved as draft (${money(quoteTotals(q).total)}).`,
        null,
        quoteTotals(q).total,
      );
      S.screen = "job";
      S.builderQuoteId = null;
      S.tab = "quotes";
      toast("Draft saved.", "ok");
      refresh();
    },
    builderSend() {
      const id = S.builderQuoteId;
      if (!id) return;
      S.screen = "job";
      S.builderQuoteId = null;
      S.tab = "quotes";
      actions.sendQuote(id);
    },

    /* ---------- quote editing ---------- */
    startEdit(quoteId) {
      S.editingQuoteId = quoteId;
      S.tab = "quotes";
      refresh();
    },
    cancelEdit() {
      S.editingQuoteId = null;
      refresh();
    },

    addItem(quoteId) {
      const q = sel.quote(quoteId);
      const line = {
        id: uid("qi"),
        kind: "LABOR",
        description: "Custom line item",
        qty: 1,
        unitPrice: 0,
      };
      setLineTax(line, defaultTaxFor("LABOR"));
      q.items.push(line);
      refresh();
    },

    removeItem(quoteId, itemId) {
      const q = sel.quote(quoteId);
      q.items = q.items.filter((i) => i.id !== itemId);
      refresh();
    },

    setItemTax(quoteId, itemId, taxId) {
      const q = sel.quote(quoteId);
      const item = q.items.find((i) => i.id === itemId);
      if (!item) return;
      setLineTax(item, taxId ? taxById(taxId) : null);
      refresh();
    },

    /* Add catalog services to the quote being edited. */
    addServices(quoteId, serviceIds) {
      const q = sel.quote(quoteId);
      const ids = Array.isArray(serviceIds) ? serviceIds : [serviceIds];
      ids.forEach((id) => {
        const svc = sel.service(id);
        if (!svc) return;
        const line = {
          id: uid("qi"),
          kind: svc.category === "Labour" ? "LABOR" : "SERVICE",
          description: svc.name,
          qty: 1,
          unitPrice: svc.price,
          serviceId: svc.id,
        };
        setLineTax(line, taxByCode(svc.taxCode) || defaultTaxFor(line.kind));
        q.items.push(line);
      });
      toast(`${ids.length} service${ids.length > 1 ? "s" : ""} added.`, "ok");
      refresh();
    },

    toggleDependency(quoteId) {
      const q = sel.quote(quoteId);
      q.hasDependency = !q.hasDependency;
      refresh();
    },

    saveEdit(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      const before = (q.revisions[q.revisions.length - 1] || {}).total || 0;
      const after = quoteTotals(q).total;
      const actor = S.role === "customer" ? "Customer" : "Garage";

      q.revision += 1;
      q.revisions = q.revisions || [];
      q.revisions.push({
        no: q.revision,
        total: after,
        by: actor,
        at: nowISO(),
      });
      q.status =
        S.role === "customer"
          ? "PENDING_GARAGE_APPROVAL"
          : "PENDING_CUSTOMER_APPROVAL";
      q.expiryDate = addDays(nowISO(), 7);
      S.editingQuoteId = null;

      log(
        q.jobId,
        q.id,
        actor,
        "COUNTER_OFFER",
        `Revision ${q.revision} sent for approval.`,
        before,
        after,
      );

      if (q.hasDependency && S.role === "garage") {
        job.status = "PAUSED_PENDING_APPROVAL";
        job.pausedReason = `Blocking change order ${q.no} awaiting customer decision.`;
        job.dependsOnQuoteId = q.id;
        log(
          q.jobId,
          q.id,
          "System",
          "JOB_PAUSED",
          "Work paused — change order flagged as blocking.",
          null,
          null,
        );
      }
      toast(
        `Counter-offer sent — waiting for the ${S.role === "customer" ? "garage" : "customer"}.`,
        "ok",
      );
      refresh();
    },

    sendQuote(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      q.status = "PENDING_CUSTOMER_APPROVAL";
      q.revision += 1;
      q.revisions = q.revisions || [];
      q.revisions.push({
        no: q.revision,
        total: quoteTotals(q).total,
        by: "Garage",
        at: nowISO(),
      });
      S.editingQuoteId = null;

      log(
        q.jobId,
        q.id,
        "Garage",
        "CREATE",
        `Quote ${q.no} sent to customer for approval.`,
        null,
        quoteTotals(q).total,
      );

      if (q.hasDependency) {
        job.status = "PAUSED_PENDING_APPROVAL";
        job.pausedReason = `Blocking change order ${q.no} awaiting customer decision.`;
        job.dependsOnQuoteId = q.id;
        log(
          q.jobId,
          q.id,
          "System",
          "JOB_PAUSED",
          "Work paused — change order flagged as blocking.",
          null,
          null,
        );
      }
      toast("Quote sent to the customer.", "ok");
      refresh();
    },

    addCondition(quoteId, text) {
      const q = sel.quote(quoteId);
      if (!text || !text.trim()) return;
      q.conditions.push({
        id: uid("qc"),
        text: text.trim(),
        addedBy: S.role === "customer" ? "CUSTOMER" : "GARAGE",
        at: nowISO(),
      });
      log(
        q.jobId,
        q.id,
        S.role === "customer" ? "Customer" : "Garage",
        "ADD_CONDITION",
        text.trim(),
      );
      toast("Condition added to the quote.", "ok");
      refresh();
    },

    /* ---------- accept / reject ---------- */
    acceptQuote(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      const actor = S.role === "customer" ? "Customer" : "Garage";
      const total = quoteTotals(q).total;

      q.status = "ACCEPTED";
      q.acceptedAt = nowISO();
      q.lockedAt = nowISO();
      log(
        q.jobId,
        q.id,
        actor,
        "ACCEPT",
        `Quote ${q.no} accepted and locked.`,
        total,
        total,
      );

      if (q.type === "SETTLEMENT") {
        job.status = "CANCELLED";
        job.pausedReason = null;
        job.dependsOnQuoteId = null;
        const cancel = sel.openCancellation(job.id);
        if (cancel) {
          cancel.status = "AGREED";
          cancel.settlementQuoteId = q.id;
          cancel.resolvedAt = nowISO();
        }
        log(
          q.jobId,
          q.id,
          "System",
          "SETTLEMENT_AGREED",
          "Settlement agreed — generate the final invoice.",
          null,
          total,
        );
        toast("Settlement agreed — generate the final invoice.", "ok");
        refresh();
        return;
      }

      if (q.type === "SUPPLEMENTARY") {
        if (job.status === "PAUSED_PENDING_APPROVAL" && q.hasDependency) {
          job.status = "IN_PROGRESS";
          job.pausedReason = null;
          job.dependsOnQuoteId = null;
          log(
            q.jobId,
            q.id,
            "System",
            "JOB_RESUMED",
            "Blocking work approved — work resumed.",
            null,
            null,
          );
        }
        toast("Add-on accepted — update the invoice to bill it.", "ok");
        refresh();
        return;
      }

      /* STANDARD or WARRANTY: no invoice is created automatically. */
      job.status = "AWAITING_INVOICE";
      job.pausedReason =
        q.type === "WARRANTY"
          ? "Warranty quote accepted — generate the $0.00 invoice."
          : "Quote accepted — generate the invoice to collect payment.";
      log(
        q.jobId,
        q.id,
        "System",
        "AWAITING_INVOICE",
        "Quote locked. Invoice must be generated by the garage.",
        null,
        null,
      );

      toast("Quote accepted — now generate the invoice.", "ok");
      refresh();
    },

    rejectQuote(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      const actor = S.role === "customer" ? "Customer" : "Garage";
      q.status = "REJECTED";
      q.rejectedAt = nowISO();

      if (q.type === "SUPPLEMENTARY") {
        if (q.hasDependency) {
          job.status = "PAUSED_PENDING_APPROVAL";
          job.pausedReason = `Blocking work ${q.no} was rejected. Garage must agree a way forward.`;
          log(
            q.jobId,
            q.id,
            actor,
            "REJECT",
            `Blocking change order ${q.no} rejected — job remains paused.`,
            quoteTotals(q).total,
            null,
          );
        } else {
          log(
            q.jobId,
            q.id,
            actor,
            "REJECT",
            `Add-on ${q.no} rejected. Original approved work continues unaffected.`,
            quoteTotals(q).total,
            null,
          );
          if (
            job.status === "PAUSED_PENDING_APPROVAL" &&
            job.dependsOnQuoteId === q.id
          ) {
            job.status = "IN_PROGRESS";
            job.pausedReason = null;
            job.dependsOnQuoteId = null;
          }
        }
      } else if (q.type === "SETTLEMENT") {
        const c = sel.openCancellation(job.id);
        if (c) c.status = "UNDER_REVIEW";
        log(
          q.jobId,
          q.id,
          actor,
          "REJECT",
          `Settlement quote ${q.no} rejected — renegotiation required.`,
          quoteTotals(q).total,
          null,
        );
      } else {
        job.status = "CANCELLED";
        log(
          q.jobId,
          q.id,
          actor,
          "REJECT",
          `Quote ${q.no} rejected — job cancelled.`,
          quoteTotals(q).total,
          null,
        );
      }
      toast("Quote rejected.", "warn");
      refresh();
    },

    /* ---------- new quotes ---------- */
    /*
       Garage opens a job for a customer who walked in / phoned.
       Creates exactly one job (customer + vehicle + complaint) and leaves it
       empty: the garage then clicks "+ New quote" to price the work.
       Returns the new job id so the caller can select it.
    */
    createJob(payload) {
      const count = S.jobs.length + 1043;
      const job = {
        id: uid("job"),
        jobNo: "JC-" + count,
        garageName: "Northgate Auto Works",
        customerName: (payload.customerName || "Walk-in customer").trim(),
        customerEmail: (payload.customerEmail || "").trim(),
        vehicle: {
          year: Number(payload.year) || new Date().getFullYear(),
          make: (payload.make || "").trim(),
          model: (payload.model || "").trim(),
          plate: (payload.plate || "").trim().toUpperCase(),
          vin: (payload.vin || "PENDING-" + count).trim(),
          odometer: Number(payload.odometer) || 0,
        },
        status: "QUOTING",
        createdAt: nowISO(),
        pausedReason: null,
        dependsOnQuoteId: null,
      };
      S.jobs.push(job);
      log(
        job.id,
        null,
        "Garage",
        "JOB_CREATED",
        `Job ${job.jobNo} opened for ${job.customerName} — ${job.vehicle.make} ${job.vehicle.model} (${job.vehicle.plate}).` +
          (payload.complaint ? ` Complaint: ${payload.complaint}` : ""),
        null,
        null,
      );
      toast(`Job ${job.jobNo} created. Add a quote to price the work.`, "ok");
      refresh();
      return job.id;
    },

    createSupplementary(jobId) {
      const job = sel.job(jobId);
      const parent = sel.stdQuote(jobId) || sel.activeQuote(jobId);
      const q = {
        id: uid("q"),
        jobId,
        no: nextQuoteNo(job),
        type: "SUPPLEMENTARY",
        status: "DRAFT",
        createdByRole: "GARAGE",
        parentQuoteId: parent ? parent.id : null,
        originalInvoiceId: null,
        items: [
          setLineTax(
            {
              id: uid("qi"),
              kind: "PART",
              description: "Additional part discovered",
              qty: 1,
              unitPrice: 0,
            },
            defaultTaxFor("PART"),
          ),
        ],
        conditions: [],
        revisions: [],
        hasDependency: false,
        isChangeOrder: true,
        depositType: "NONE",
        depositValue: 0,
        expiryDate: addDays(nowISO(), 3),
        revision: 0,
        createdAt: nowISO(),
        acceptedAt: null,
        rejectedAt: null,
        lockedAt: null,
      };
      S.quotes.push(q);
      openBuilder(S, q.id);
      log(
        jobId,
        q.id,
        "Garage",
        "CREATE",
        "Supplementary quote started — new issue found mid-job.",
        null,
        0,
      );
      toast(
        "Supplementary quote started. Add the extra lines, then send it.",
        "ok",
      );
      refresh();
    },

    createWarranty(jobId) {
      const job = sel.job(jobId);
      const origInv = sel
        .invoicesForJob(jobId)
        .find((i) => i.kind === "TAX_INVOICE");
      const origQuote = sel.stdQuote(jobId);
      const items = (origQuote ? origQuote.items : []).map((i) =>
        setLineTax(
          {
            id: uid("qi"),
            kind: i.kind,
            description: `[Warranty rework] ${i.description}`,
            qty: i.qty,
            unitPrice: 0,
            unitPriceOriginal: i.unitPrice,
          },
          null,
        ),
      );
      if (!items.length) {
        items.push(
          setLineTax(
            {
              id: uid("qi"),
              kind: "LABOR",
              description: "[Warranty rework] Re-do previous repair",
              qty: 1,
              unitPrice: 0,
              unitPriceOriginal: 9500,
            },
            null,
          ),
        );
      }

      const q = {
        id: uid("q"),
        jobId,
        no: nextQuoteNo(job),
        type: "WARRANTY",
        status: "DRAFT",
        createdByRole: "GARAGE",
        parentQuoteId: origQuote ? origQuote.id : null,
        originalInvoiceId: origInv ? origInv.id : null,
        items,
        conditions: [
          {
            id: uid("qc"),
            text: "Zero-dollar rework — covered under warranty. No charge to customer.",
            addedBy: "GARAGE",
            at: nowISO(),
          },
        ],
        revisions: [],
        hasDependency: false,
        isChangeOrder: false,
        depositType: "NONE",
        depositValue: 0,
        expiryDate: addDays(nowISO(), 14),
        revision: 0,
        createdAt: nowISO(),
        acceptedAt: null,
        rejectedAt: null,
        lockedAt: null,
        invoicedAt: null,
      };
      S.quotes.push(q);
      openBuilder(S, q.id);
      log(
        jobId,
        q.id,
        "Garage",
        "CREATE",
        `Warranty quote raised against ${origInv ? origInv.no : "original invoice"}.`,
        null,
        0,
      );
      toast("Warranty quote created at $0.00 line items.", "ok");
      refresh();
    },

    createGarageQuote(jobId) {
      const job = sel.job(jobId);
      const q = {
        id: uid("q"),
        jobId,
        no: nextQuoteNo(job),
        type: "STANDARD",
        status: "DRAFT",
        createdByRole: "GARAGE",
        parentQuoteId: null,
        originalInvoiceId: null,
        items: [
          setLineTax(
            {
              id: uid("qi"),
              kind: "LABOR",
              description: "Labour",
              qty: 1,
              unitPrice: 9500,
            },
            defaultTaxFor("LABOR"),
          ),
        ],
        conditions: [],
        revisions: [],
        hasDependency: false,
        isChangeOrder: false,
        depositType: S.settings.depositType,
        depositValue: S.settings.depositValue,
        expiryDate: addDays(nowISO(), 7),
        revision: 0,
        createdAt: nowISO(),
        acceptedAt: null,
        rejectedAt: null,
        lockedAt: null,
      };
      S.quotes.push(q);
      openBuilder(S, q.id);
      log(
        jobId,
        q.id,
        "Garage",
        "CREATE",
        "New quote started after inspection.",
        null,
        0,
      );
      refresh();
    },

    createRfq(jobId, description, budgetDollars) {
      const job = sel.job(jobId);
      const budget = Math.round((Number(budgetDollars) || 0) * 100);
      const q = {
        id: uid("q"),
        jobId,
        no: nextQuoteNo(job),
        type: "STANDARD",
        status: "PENDING_GARAGE_APPROVAL",
        createdByRole: "CUSTOMER",
        parentQuoteId: null,
        originalInvoiceId: null,
        items: [
          setLineTax(
            {
              id: uid("qi"),
              kind: "SERVICE",
              description: description || "Requested work",
              qty: 1,
              unitPrice: budget,
            },
            defaultTaxFor("SERVICE"),
          ),
        ],
        conditions: [
          {
            id: uid("qc"),
            text: `Customer budget cap: ${money(budget)}.`,
            addedBy: "CUSTOMER",
            at: nowISO(),
          },
        ],
        revisions: [],
        hasDependency: false,
        isChangeOrder: false,
        depositType: S.settings.depositType,
        depositValue: S.settings.depositValue,
        expiryDate: addDays(nowISO(), 10),
        revision: 1,
        createdAt: nowISO(),
        acceptedAt: null,
        rejectedAt: null,
        lockedAt: null,
      };
      q.revisions = [
        { no: 1, total: quoteTotals(q).total, by: "Customer", at: nowISO() },
      ];
      S.quotes.push(q);
      job.status = "QUOTING";
      log(
        jobId,
        q.id,
        "Customer",
        "CREATE",
        `Request for Quote submitted: ${description || "requested work"}. Budget cap ${money(budget)}.`,
        null,
        budget,
      );
      toast("Request for Quote sent to the garage.", "ok");
      refresh();
    },

    /* ---------- documents: proforma + invoice ---------- */
    generateProforma(jobId) {
      const built = buildLines(jobId);
      if (!built.base) {
        toast("Accept a quote first.", "warn");
        return;
      }

      const existing = sel.openProforma(jobId);
      if (existing) {
        toast("A proforma is already open on this job.", "warn");
        return;
      }

      const doc = {
        id: uid("inv"),
        jobId,
        quoteId: built.base.id,
        no: "PRO-" + counters.pro++,
        kind: "PROFORMA",
        originalInvoiceId: null,
        settlementQuoteId: null,
        supersededBy: null,
        voidedAt: null,
        voidReason: null,
        seq: 1,
        lines: built.lines,
        issuedAt: nowISO(),
        dueAt: addDays(nowISO(), 7),
        depositRequired: depositFor(built.base),
        depositType: built.base.depositType,
        depositValue: built.base.depositValue,
      };
      S.invoices.push(doc);
      syncInvoice(doc);
      log(
        jobId,
        built.base.id,
        "Garage",
        "PROFORMA_ISSUED",
        `Proforma ${doc.no} issued for ${money(doc.total)} — not a tax invoice.`,
        null,
        doc.total,
      );
      toast(`Proforma ${doc.no} issued.`, "ok");
      refresh();
    },

    generateInvoice(jobId) {
      const job = sel.job(jobId);

      /* Warranty jobs produce their own zero-dollar invoice */
      const warranty = sel
        .quotesForJob(jobId)
        .find(
          (q) =>
            q.type === "WARRANTY" && q.status === "ACCEPTED" && !q.invoicedAt,
        );
      if (warranty) {
        const doc = {
          id: uid("inv"),
          jobId,
          quoteId: warranty.id,
          no: "INV-" + counters.inv++,
          kind: "WARRANTY",
          originalInvoiceId: warranty.originalInvoiceId,
          settlementQuoteId: null,
          supersedes: null,
          supersededBy: null,
          voidedAt: null,
          voidReason: null,
          seq: 1,
          paymentId: null,
          lines: linesFromQuote(warranty, false),
          issuedAt: nowISO(),
          dueAt: addDays(nowISO(), 14),
          depositRequired: 0,
          depositType: "NONE",
          depositValue: 0,
        };
        S.invoices.push(doc);
        syncInvoice(doc);
        warranty.invoicedAt = nowISO();
        log(
          jobId,
          warranty.id,
          "System",
          "INVOICE_ISSUED",
          `Warranty invoice ${doc.no} issued at $0.00 against ${(sel.invoice(warranty.originalInvoiceId) || {}).no || "original invoice"}.`,
          null,
          0,
        );
        toast(`Warranty invoice ${doc.no} issued at $0.00.`, "ok");
        refresh();
        return;
      }

      const built = buildLines(jobId);
      if (!built.base) {
        toast("Accept a quote first.", "warn");
        return;
      }

      let inv = sel.stdInvoice(jobId);
      const isNew = !inv;

      /* A brand-new invoice continues the chain when an older version was voided. */
      const versions = sel.invoiceVersions(jobId);
      const lastVersion = versions.length
        ? versions[versions.length - 1]
        : null;

      if (isNew) {
        inv = {
          id: uid("inv"),
          jobId,
          quoteId: built.base.id,
          no: "INV-" + counters.inv++,
          kind: "TAX_INVOICE",
          originalInvoiceId: null,
          settlementQuoteId: built.settlement ? built.settlement.id : null,
          supersedes: lastVersion ? lastVersion.id : null,
          supersededBy: null,
          voidedAt: null,
          voidReason: null,
          seq: lastVersion ? (lastVersion.seq || 1) + 1 : 1,
          paymentId: null,
          lines: built.lines,
          issuedAt: nowISO(),
          dueAt: addDays(nowISO(), 14),
          depositRequired: depositFor(built.base),
          depositType: built.base.depositType,
          depositValue: built.base.depositValue,
        };
        S.invoices.push(inv);
        syncInvoice(inv);

        /* the proforma is replaced by the real thing */
        const pro = sel.openProforma(jobId);
        if (pro) {
          pro.status = "SUPERSEDED";
          pro.supersededBy = inv.id;
          syncInvoice(pro);
        }
        log(
          jobId,
          built.base.id,
          "Garage",
          "INVOICE_ISSUED",
          `Invoice ${inv.no} generated from accepted quote${built.addons.length ? " + " + built.addons.length + " add-on(s)" : ""}.`,
          null,
          inv.total,
        );
      } else {
        inv.lines = built.lines;
        if (built.settlement) inv.settlementQuoteId = built.settlement.id;
        syncInvoice(inv);
        log(
          jobId,
          null,
          "Garage",
          "INVOICE_UPDATED",
          `Invoice ${inv.no} regenerated from accepted work — now ${money(inv.total)}.`,
          null,
          inv.total,
        );
      }

      if (job.status === "AWAITING_INVOICE") {
        job.status =
          inv.depositRequired > 0 && inv.amountPaid < inv.depositRequired
            ? "AWAITING_DEPOSIT"
            : "IN_PROGRESS";
        job.pausedReason =
          job.status === "AWAITING_DEPOSIT"
            ? "Deposit required before work begins."
            : null;
        if (job.status === "IN_PROGRESS") {
          log(
            jobId,
            null,
            "System",
            "WORK_STARTED",
            "Invoice issued — work can proceed.",
            null,
            null,
          );
        }
      }

      toast(
        isNew ? `Invoice ${inv.no} generated.` : `Invoice ${inv.no} updated.`,
        "ok",
      );
      refresh();
    },

    /*
       "Generate" — issue one tax invoice for every accepted quote that has not
       been invoiced yet. Existing live invoices are NOT touched: nothing that
       carries money is ever rewritten or voided by this action.

       Idempotent: a quote is stamped with `invoicedAt`, so pressing the button
       twice cannot produce two documents for the same work.
       Returns the list of new invoices (empty when there was nothing to bill).
    */
    generateInvoices(jobId) {
      const job = sel.job(jobId);
      const pending = sel.uninvoicedQuotes(jobId);
      if (!pending.length) {
        toast("Nothing new to invoice.", "warn");
        return [];
      }
      const created = [];
      const versions = sel.invoiceVersions(jobId);
      let lastSeq = versions.reduce((m, i) => Math.max(m, i.seq || 1), 0);

      pending.forEach((q) => {
        lastSeq += 1;
        const isWarranty = q.type === "WARRANTY";
        const doc = {
          id: uid("inv"),
          jobId,
          quoteId: q.id,
          no: (isWarranty ? "INV-" : "INV-") + counters.inv++,
          kind: isWarranty ? "WARRANTY" : "TAX_INVOICE",
          originalInvoiceId: isWarranty ? q.originalInvoiceId || null : null,
          settlementQuoteId: q.type === "SETTLEMENT" ? q.id : null,
          supersedes: null,
          supersededBy: null,
          voidedAt: null,
          voidReason: null,
          seq: lastSeq,
          paymentId: null,
          carriedPaid: 0,
          carriedFromInvoiceIds: [],
          lines: linesForQuote(q),
          issuedAt: nowISO(),
          dueAt: addDays(nowISO(), 14),
          depositRequired: isWarranty ? 0 : depositFor(q),
          depositType: isWarranty ? "NONE" : q.depositType,
          depositValue: isWarranty ? 0 : q.depositValue,
        };
        S.invoices.push(doc);
        syncInvoice(doc);

        q.invoicedAt = nowISO();
        q.invoiceIds = (q.invoiceIds || []).concat(doc.id);
        created.push(doc);

        log(
          jobId,
          q.id,
          "Garage",
          "INVOICE_ISSUED",
          `${doc.no} issued from ${q.no} for ${money(doc.total)}.`,
          null,
          doc.total,
        );
      });

      /* The proforma has served its purpose once a real invoice exists. */
      const pro = sel.openProforma(jobId);
      if (pro && created.length) {
        pro.status = "SUPERSEDED";
        pro.supersededBy = created[created.length - 1].id;
        syncInvoice(pro);
      }

      if (job.status === "AWAITING_INVOICE") {
        const totals = sel.jobTotals(jobId);
        job.status =
          totals.total > 0 &&
          totals.paid === 0 &&
          created.some((d) => d.depositRequired > 0)
            ? "AWAITING_DEPOSIT"
            : "IN_PROGRESS";
        job.pausedReason =
          job.status === "AWAITING_DEPOSIT"
            ? "Deposit required before work begins."
            : null;
      }

      toast(
        created.length === 1
          ? `Invoice ${created[0].no} issued.`
          : `${created.length} invoices issued: ${created.map((d) => d.no).join(", ")}.`,
        "ok",
      );
      refresh();
      return created;
    },

    /*
       "Generate combined invoice" — the one place that legitimately voids.
       Takes every live tax invoice on the job, merges their lines into a single
       new invoice, carries the money already received forward, then voids the
       originals pointing at their replacement.

       The combined document keeps the audit trail honest by storing:
         combinedFromInvoiceIds[]  — what it replaced
         carriedPaid               — money received on those documents
       so the printed balance is always explainable:
         total - carriedPaid - payments on this invoice
    */
    generateCombinedInvoice(jobId) {
      const job = sel.job(jobId);
      const live = sel
        .liveInvoices(jobId)
        .filter((i) => i.kind === "TAX_INVOICE");
      if (live.length < 2) {
        toast(
          live.length === 0
            ? "There is no live invoice to combine yet."
            : "Only one live invoice — nothing to combine.",
          "warn",
        );
        return null;
      }

      const carriedPaid = live.reduce((s, i) => s + (i.amountPaid || 0), 0);
      const lines = [];
      const quoteIds = [];
      live.forEach((inv) => {
        inv.lines.forEach((l) =>
          lines.push(Object.assign({}, l, { id: uid("ln") })),
        );
        if (inv.quoteId) quoteIds.push(inv.quoteId);
      });

      const versions = sel.invoiceVersions(jobId);
      const seq = versions.reduce((m, i) => Math.max(m, i.seq || 1), 0) + 1;

      const combined = {
        id: uid("inv"),
        jobId,
        quoteId: live[0].quoteId || null,
        no: "INV-" + counters.inv++,
        kind: "TAX_INVOICE",
        originalInvoiceId: null,
        settlementQuoteId: null,
        supersedes: null,
        supersededBy: null,
        voidedAt: null,
        voidReason: null,
        seq,
        paymentId: null,
        /* money received on the invoices this one replaces */
        carriedPaid,
        combinedFromInvoiceIds: live.map((i) => i.id),
        isCombined: true,
        lines,
        issuedAt: nowISO(),
        dueAt: addDays(nowISO(), 14),
        depositRequired: 0,
        depositType: "NONE",
        depositValue: 0,
      };
      S.invoices.push(combined);
      syncInvoice(combined);

      /* Now — and only now — the originals are voided, pointing forward. */
      live.forEach((inv) => {
        inv.status = "VOID";
        inv.voidedAt = nowISO();
        inv.voidReason = "Consolidated into " + combined.no;
        inv.supersededBy = combined.id;
        log(
          jobId,
          null,
          "System",
          "INVOICE_VOIDED",
          `${inv.no} consolidated into ${combined.no}.`,
          inv.total,
          null,
        );
      });

      /* Re-point the quotes' invoice references at the surviving document. */
      S.quotes
        .filter((q) => quoteIds.includes(q.id))
        .forEach((q) => {
          q.invoiceIds = [combined.id];
        });

      log(
        jobId,
        null,
        "Garage",
        "INVOICE_COMBINED",
        `${combined.no} combines ${live.length} invoices (${live
          .map((i) => i.no)
          .join(
            ", ",
          )}) and carries forward ${money(carriedPaid)} already paid. ` +
          `Total ${money(combined.total)}, remaining ${money(combined.balance)}.`,
        null,
        combined.total,
      );

      toast(
        `${combined.no} issued — combined ${live.length} invoices, ${money(combined.balance)} remaining.`,
        "ok",
      );
      refresh();
      return combined;
    },

    /*
       "Combine invoices & payments" — full consolidation.
       Differs from generateCombinedInvoice() in one decisive way: the money is
       MOVED onto the new document instead of being carried as a figure.

         · every live invoice is merged and voided
         · their payments are re-pointed at the new invoice
         · every earlier receipt is voided (kept, struck through, never deleted)
         · exactly one VALID receipt is issued showing paid-to-date + balance

       Because the payments now belong to the new invoice, carriedPaid is 0 —
       otherwise the same money would be deducted twice.
    */
    combineInvoicesWithPayments(jobId) {
      const job = sel.job(jobId);
      const live = sel
        .liveInvoices(jobId)
        .filter((i) => i.kind === "TAX_INVOICE");
      if (!live.length) {
        toast("There is no live invoice to consolidate.", "warn");
        return null;
      }

      const liveIds = live.map((i) => i.id);
      /* Receipts to fold in: everything valid on the invoices being replaced. */
      const receiptsToFold = S.receipts.filter(
        (r) => liveIds.includes(r.invoiceId) && r.status === "VALID",
      );
      if (!receiptsToFold.length) {
        toast(
          "There are no payments to consolidate — use 'Combine invoices' instead.",
          "warn",
        );
        return null;
      }
      if (live.length === 1 && validReceipts(live[0].id).length < 2) {
        toast("Nothing to consolidate — one invoice with one receipt.", "warn");
        return null;
      }

      /* 1. build the merged document */
      const lines = [];
      const quoteIds = [];
      live.forEach((inv) => {
        inv.lines.forEach((l) =>
          lines.push(Object.assign({}, l, { id: uid("ln") })),
        );
        if (inv.quoteId) quoteIds.push(inv.quoteId);
      });

      const versions = sel.invoiceVersions(jobId);
      const seq = versions.reduce((m, i) => Math.max(m, i.seq || 1), 0) + 1;

      const combined = {
        id: uid("inv"),
        jobId,
        quoteId: live[0].quoteId || null,
        no: "INV-" + counters.inv++,
        kind: "TAX_INVOICE",
        originalInvoiceId: null,
        settlementQuoteId: null,
        supersedes: null,
        supersededBy: null,
        voidedAt: null,
        voidReason: null,
        seq,
        paymentId: null,
        /* payments are moved, not carried — so this stays 0 */
        carriedPaid: 0,
        combinedFromInvoiceIds: liveIds,
        isCombined: true,
        consolidatedReceipts: true,
        lines,
        issuedAt: nowISO(),
        dueAt: addDays(nowISO(), 14),
        depositRequired: 0,
        depositType: "NONE",
        depositValue: 0,
      };
      S.invoices.push(combined);

      /* 2. move the payments and their receipts onto the new document */
      S.payments
        .filter((p) => liveIds.includes(p.invoiceId))
        .forEach((p) => {
          p.migratedFromInvoiceId = p.invoiceId;
          p.invoiceId = combined.id;
        });
      const foldedAmount = receiptsToFold.reduce(
        (s, r) => s + (r.amount || 0),
        0,
      );
      receiptsToFold.forEach((r) => {
        r.invoiceId = combined.id;
      });

      /* 3. compute totals before issuing the consolidated receipt */
      syncInvoice(combined);

      /* 4. void every earlier receipt — kept for history, never deducted */
      const consolidated = {
        id: uid("rec"),
        paymentId: null,
        invoiceId: combined.id,
        jobId,
        no: "RCP-" + counters.rec++,
        status: "VALID",
        amount: foldedAmount,
        method: "CONSOLIDATED",
        type: "CONSOLIDATED",
        issuedAt: nowISO(),
        emailedTo: job.customerEmail,
        paidToDate: foldedAmount,
        balanceAfter: combined.balance,
        supersededBy: null,
        voidedAt: null,
        consolidatedFrom: receiptsToFold.map((r) => r.id),
      };
      receiptsToFold.forEach((r) => {
        r.status = "VOID";
        r.voidedAt = nowISO();
        r.voidReason = "Consolidated into " + consolidated.no;
        r.supersededBy = consolidated.id;
      });
      S.receipts.push(consolidated);
      syncInvoice(combined);

      /* 5. void the source invoices, pointing forward */
      live.forEach((inv) => {
        inv.status = "VOID";
        inv.voidedAt = nowISO();
        inv.voidReason = "Consolidated into " + combined.no;
        inv.supersededBy = combined.id;
        log(
          jobId,
          null,
          "System",
          "INVOICE_VOIDED",
          `${inv.no} consolidated into ${combined.no} (with payments).`,
          inv.total,
          null,
        );
      });

      S.quotes
        .filter((q) => quoteIds.includes(q.id))
        .forEach((q) => {
          q.invoiceIds = [combined.id];
        });

      log(
        jobId,
        null,
        "Garage",
        "INVOICE_COMBINED",
        `${combined.no} consolidates ${live.length} invoice(s) and ${receiptsToFold.length} receipt(s). ` +
          `${money(foldedAmount)} already paid carried onto this document; consolidated receipt ${consolidated.no} issued. ` +
          `Total ${money(combined.total)}, remaining ${money(combined.balance)}.`,
        null,
        combined.total,
      );

      toast(
        `${combined.no} issued — ${receiptsToFold.length} receipts consolidated into ${consolidated.no}.`,
        "ok",
      );
      refresh();
      return combined;
    },

    /* ---------- voiding a document ---------- */
    /*
       Manual void = "this document was wrong from the start".
       Allowed only while nothing has been paid on it. Once money has moved the
       document is not wrong, it is merely out of date — that is what the
       automatic reissue on payment exists for. Voiding never deletes the row.
    */
    voidInvoice(invoiceId, reason) {
      const inv = sel.invoice(invoiceId);
      if (!inv) return;
      if (inv.kind !== "TAX_INVOICE") {
        toast("Only a tax invoice can be voided.", "warn");
        return;
      }
      if (inv.status === "VOID") return;
      if (inv.amountPaid > 0) {
        toast(
          "This invoice carries payments — a paid document is replaced by a new version, never voided.",
          "warn",
        );
        return;
      }

      const text = (reason || "").trim() || "Voided by the garage.";
      inv.status = "VOID";
      inv.voidedAt = nowISO();
      inv.voidReason = text;
      inv.supersededBy = null; // voided outright, not replaced by anything

      /* Voiding receipts that belonged to this document (defensive: none once paid). */
      S.receipts
        .filter((r) => r.invoiceId === inv.id && r.status === "VALID")
        .forEach((r) => {
          r.status = "VOID";
          r.voidedAt = nowISO();
        });

      /* No live version is left, so the job has nothing payable again. */
      const job = sel.job(inv.jobId);
      if (!sel.stdInvoice(inv.jobId)) {
        job.status = "AWAITING_INVOICE";
        job.pausedReason = `Invoice ${inv.no} was voided — issue a replacement before collecting payment.`;
        log(
          inv.jobId,
          null,
          "System",
          "AWAITING_INVOICE",
          "No live invoice left on this job — the garage must issue a replacement.",
          null,
          null,
        );
      }

      log(
        inv.jobId,
        null,
        "Garage",
        "INVOICE_VOIDED",
        `${inv.no} voided by the garage. Reason: ${text}`,
        inv.total,
        null,
      );
      toast(
        `${inv.no} voided — issue a replacement to collect payment.`,
        "warn",
      );
      refresh();
    },

    /* ---------- cancellation + settlement ---------- */
    requestCancellation(jobId, reason) {
      const job = sel.job(jobId);
      S.cancellations.push({
        id: uid("can"),
        jobId,
        reason: reason || "No reason given.",
        status: "REQUESTED",
        requestedBy: "Customer",
        settlementQuoteId: null,
        createdAt: nowISO(),
        resolvedAt: null,
      });
      job.status = "PAUSED_PENDING_CANCELLATION";
      job.pausedReason =
        "Customer requested cancellation — awaiting settlement.";
      log(
        jobId,
        null,
        "Customer",
        "CANCEL_REQUEST",
        reason || "Cancellation requested.",
        null,
        null,
      );
      log(
        jobId,
        null,
        "System",
        "JOB_PAUSED",
        "Job auto-paused pending cancellation settlement.",
        null,
        null,
      );
      toast("Cancellation requested — job paused, garage notified.", "warn");
      refresh();
    },

    createSettlement(jobId, opts) {
      const job = sel.job(jobId);
      const orig = sel.stdQuote(jobId);
      const c = sel.openCancellation(jobId);
      const hours = Number(opts.hours) || 0;
      const restock = Math.round((Number(opts.restock) || 0) * 100);
      const unbundle = !!opts.unbundle;

      const items = [];
      if (hours > 0) {
        items.push(
          setLineTax(
            {
              id: uid("qi"),
              kind: "LABOR",
              description: `Labour completed to date (${hours}h, prorated)`,
              qty: hours,
              unitPrice: 9500,
            },
            defaultTaxFor("LABOR"),
          ),
        );
      }
      if (orig) {
        orig.items
          .filter((i) => i.kind === "PART")
          .forEach((p) =>
            items.push(
              setLineTax(
                {
                  id: uid("qi"),
                  kind: "PART",
                  description: `${p.description} (already installed)`,
                  qty: p.qty,
                  unitPrice: p.unitPrice,
                },
                taxById(p.taxId) || defaultTaxFor("PART"),
              ),
            ),
          );

        const pkg = orig.items.filter((i) => i.packageRef);
        if (pkg.length) {
          pkg.forEach((p) =>
            items.push(
              setLineTax(
                {
                  id: uid("qi"),
                  kind: "SERVICE",
                  description: unbundle
                    ? `${p.description} — unbundled, standard rate`
                    : `${p.description} (package rate)`,
                  qty: p.qty,
                  unitPrice: unbundle
                    ? p.standaloneUnitPrice || p.unitPrice
                    : p.unitPrice,
                },
                taxById(p.taxId) || defaultTaxFor("SERVICE"),
              ),
            ),
          );
        }
      }
      if (restock > 0) {
        items.push(
          setLineTax(
            {
              id: uid("qi"),
              kind: "RESTOCKING_FEE",
              description:
                "Restocking fee — special-order parts returned to supplier",
              qty: 1,
              unitPrice: restock,
            },
            null,
          ),
        );
      }

      const q = {
        id: uid("q"),
        jobId,
        no: nextQuoteNo(job),
        type: "SETTLEMENT",
        status: "PENDING_CUSTOMER_APPROVAL",
        createdByRole: "GARAGE",
        parentQuoteId: orig ? orig.id : null,
        originalInvoiceId: null,
        items,
        conditions: [
          {
            id: uid("qc"),
            text: "Settlement figure covers work completed up to the cancellation time only.",
            addedBy: "GARAGE",
            at: nowISO(),
          },
        ],
        revisions: [],
        hasDependency: false,
        isChangeOrder: false,
        depositType: "NONE",
        depositValue: 0,
        expiryDate: addDays(nowISO(), 7),
        revision: 1,
        createdAt: nowISO(),
        acceptedAt: null,
        rejectedAt: null,
        lockedAt: null,
      };
      q.revisions = [
        { no: 1, total: quoteTotals(q).total, by: "Garage", at: nowISO() },
      ];
      S.quotes.push(q);

      if (c) {
        c.status = "SETTLEMENT_SENT";
        c.settlementQuoteId = q.id;
      }

      log(
        jobId,
        q.id,
        "Garage",
        "SETTLE",
        `Settlement quote ${q.no} issued${unbundle ? " (package unbundled at standard rates)" : ""}.`,
        null,
        quoteTotals(q).total,
      );
      toast("Settlement quote sent to the customer.", "ok");
      refresh();
    },

    declineCancellation(jobId) {
      const c = sel.openCancellation(jobId);
      if (c) {
        c.status = "DECLINED";
        c.resolvedAt = nowISO();
      }
      const job = sel.job(jobId);
      job.status = "IN_PROGRESS";
      job.pausedReason = null;
      log(
        jobId,
        null,
        "Garage",
        "CANCEL_DECLINED",
        "Garage declined the cancellation request; work resumed.",
        null,
        null,
      );
      toast("Cancellation declined — job resumed.", "warn");
      refresh();
    },

    /* ---------- payments ---------- */
    recordPayment(invoiceId, amountCents, type, method) {
      const inv = sel.invoice(invoiceId);
      if (!inv || inv.kind !== "TAX_INVOICE") {
        toast("Payments can only be taken against a tax invoice.", "warn");
        return;
      }
      if (inv.status === "VOID") {
        toast(
          "That invoice is void — collect against the current one.",
          "warn",
        );
        return;
      }

      const amount = Math.max(
        0,
        Math.min(Math.round(amountCents), inv.balance),
      );
      if (!amount) {
        toast("Nothing left to pay on this invoice.", "warn");
        return;
      }

      const job = sel.job(inv.jobId);
      const reissue = !!S.settings.reissueInvoiceOnPayment;

      const p = {
        id: uid("pay"),
        invoiceId,
        no: "PAY-" + counters.pay++,
        amount,
        type: type || "STANDARD",
        method: method || "CARD",
        status: "SUCCEEDED",
        paidAt: nowISO(),
      };
      S.payments.push(p);

      let current = inv;

      if (reissue) {
        /* 1. issue the replacement first — it needs the new document number */
        current = {
          id: uid("inv"),
          jobId: inv.jobId,
          quoteId: inv.quoteId,
          no: "INV-" + counters.inv++,
          kind: "TAX_INVOICE",
          originalInvoiceId: inv.originalInvoiceId || null,
          settlementQuoteId: inv.settlementQuoteId || null,
          supersedes: inv.id,
          supersededBy: null,
          voidedAt: null,
          voidReason: null,
          seq: (inv.seq || 1) + 1,
          paymentId: p.id,
          /* carry forward anything already received on the version being replaced,
             otherwise the replacement would look unpaid. */
          carriedPaid: inv.amountPaid || 0,
          lines: inv.lines.map((l) => Object.assign({}, l, { id: uid("ln") })),
          issuedAt: nowISO(),
          dueAt: inv.dueAt,
          depositRequired: inv.depositRequired,
          depositType: inv.depositType,
          depositValue: inv.depositValue,
          status: "UNPAID",
        };
        S.invoices.push(current);
        syncInvoice(current);

        /* 2. void the previous version and point it at its replacement.
              Payments made against it are re-pointed at the replacement so the
              ledger never shows money sitting on a void document. */
        S.payments
          .filter((x) => x.invoiceId === inv.id)
          .forEach((x) => {
            x.invoiceId = current.id;
            x.reassignedFromInvoiceId = inv.id;
          });
        S.receipts
          .filter((r) => r.invoiceId === inv.id)
          .forEach((r) => {
            r.invoiceId = current.id;
          });

        inv.status = "VOID";
        inv.voidedAt = nowISO();
        inv.voidReason = "Superseded by " + current.no;
        inv.supersededBy = current.id;

        log(
          inv.jobId,
          null,
          "System",
          "INVOICE_VOIDED",
          `${inv.no} voided — replaced by ${current.no} after payment ${p.no}.`,
          inv.total,
          null,
        );
      } else {
        syncInvoice(inv);
      }

      /* 3. one valid receipt per job: the new one voids the previous */
      const previousReceipts = reissue
        ? S.receipts.filter(
            (r) => r.jobId === inv.jobId && r.status === "VALID",
          )
        : [];

      const rc = {
        id: uid("rec"),
        paymentId: p.id,
        invoiceId: current.id,
        jobId: inv.jobId,
        no: "RCP-" + counters.rec++,
        status: "VALID",
        amount,
        method: p.method,
        type: p.type,
        issuedAt: nowISO(),
        emailedTo: job.customerEmail,
        paidToDate: current.amountPaid,
        balanceAfter: current.balance,
        supersededBy: null,
        voidedAt: null,
      };
      S.receipts.push(rc);

      previousReceipts.forEach((r) => {
        r.status = "VOID";
        r.voidedAt = nowISO();
        r.supersededBy = rc.id;
      });

      /* The receipt is the source of truth for paid-to-date, so re-derive the
         document now that it exists (and after any receipts were voided). */
      syncInvoice(current);
      rc.paidToDate = current.amountPaid;
      rc.balanceAfter = current.balance;

      if (
        job.status === "AWAITING_DEPOSIT" &&
        current.amountPaid >= current.depositRequired
      ) {
        job.status = "IN_PROGRESS";
        job.pausedReason = null;
        log(
          job.id,
          null,
          "System",
          "WORK_STARTED",
          "Deposit received — work commenced.",
          null,
          null,
        );
      }
      if (current.balance === 0) {
        log(
          job.id,
          null,
          "System",
          "HOLD_RELEASED",
          "Balance cleared — Vehicle Hold removed. Keys may be released.",
          null,
          null,
        );
      }
      log(
        inv.jobId,
        null,
        "System",
        "PAYMENT_RECEIVED",
        `${p.no} · ${money(amount)} (${type}). Receipt ${rc.no} emailed to ${rc.emailedTo}.`,
        null,
        amount,
      );

      if (reissue) {
        log(
          inv.jobId,
          null,
          "System",
          "INVOICE_REISSUED",
          `${current.no} issued for ${money(current.total)} — paid ${money(current.amountPaid)}, balance ${money(current.balance)}.`,
          null,
          current.total,
        );
      }

      toast(
        reissue
          ? `Payment recorded — ${current.no} issued, receipt ${rc.no} emailed.`
          : `Payment recorded — receipt ${rc.no} emailed.`,
        "ok",
      );
      refresh();
    },

    /* ---------- refunds ---------- */
    requestRefund(paymentId, amountCents, reason) {
      const p = sel.payment(paymentId);
      const inv = sel.invoice(p.invoiceId);
      const already = S.refunds
        .filter(
          (r) =>
            r.paymentId === paymentId &&
            ["REQUESTED", "PROCESSING", "COMPLETED"].includes(r.status),
        )
        .reduce((s, r) => s + r.amount, 0);
      const amount = Math.max(
        0,
        Math.min(Math.round(amountCents), p.amount - already),
      );
      if (!amount) {
        toast("This payment has no refundable amount left.", "warn");
        return;
      }

      const r = {
        id: uid("ref"),
        invoiceId: p.invoiceId,
        paymentId,
        amount,
        type: amount >= p.amount ? "FULL" : "PARTIAL",
        reason: reason || "Not specified",
        status: "REQUESTED",
        requestedBy: "Customer",
        createdAt: nowISO(),
        decidedAt: null,
        creditNoteId: null,
      };
      S.refunds.push(r);
      log(
        inv.jobId,
        null,
        "Customer",
        "REFUND_REQUEST",
        `${r.type} refund of ${money(amount)} requested against ${p.no}. Reason: ${r.reason}`,
        null,
        amount,
      );
      toast("Refund requested — garage must approve.", "warn");
      refresh();
    },

    decideRefund(refundId, approve) {
      const r = S.refunds.find((x) => x.id === refundId);
      const inv = sel.invoice(r.invoiceId);
      r.decidedAt = nowISO();
      if (approve) {
        r.status = "PROCESSING";
        log(
          inv.jobId,
          null,
          "Garage",
          "REFUND_APPROVED",
          `${money(r.amount)} refund approved — processing.`,
          null,
          r.amount,
        );
        toast("Refund approved — now processing.", "ok");
      } else {
        r.status = "DECLINED";
        log(
          inv.jobId,
          null,
          "Garage",
          "REFUND_DECLINED",
          "Refund request declined.",
          null,
          r.amount,
        );
        toast("Refund declined.", "danger");
      }
      refresh();
    },

    issueRefund(paymentId, amountCents, reason) {
      const p = sel.payment(paymentId);
      const inv = sel.invoice(p.invoiceId);
      const amount = Math.max(0, Math.min(Math.round(amountCents), p.amount));
      if (!amount) return;
      const r = {
        id: uid("ref"),
        invoiceId: p.invoiceId,
        paymentId,
        amount,
        type: amount >= p.amount ? "FULL" : "PARTIAL",
        reason: reason || "Issued by garage",
        status: "COMPLETED",
        requestedBy: "Garage",
        createdAt: nowISO(),
        decidedAt: nowISO(),
        creditNoteId: null,
      };
      S.refunds.push(r);
      log(
        inv.jobId,
        null,
        "Garage",
        "REFUND_ISSUED",
        `${r.type} refund of ${money(amount)} issued proactively against ${p.no}.`,
        null,
        amount,
      );
      completeRefundRecord(r);
      refresh();
    },

    completeRefund(refundId) {
      completeRefundRecord(S.refunds.find((x) => x.id === refundId));
      refresh();
    },

    /* ---------- storage fee ---------- */
    addStorageFee(jobId, days) {
      const inv = sel.stdInvoice(jobId);
      if (!inv) {
        toast("Generate the invoice first — fees are billed on it.", "warn");
        return;
      }
      const n = Math.max(1, Number(days) || 1);
      const rate = S.settings.storageDailyRate;
      inv.lines.push(
        setLineTax(
          {
            id: uid("ln"),
            quoteId: null,
            quoteType: "FEE",
            description: `Daily storage fee (${n} day${n > 1 ? "s" : ""} @ ${money(rate)}/day)`,
            qty: n,
            unitPrice: rate,
            isAddon: false,
          },
          null,
        ),
      );
      syncInvoice(inv);
      S.storage.push({
        id: uid("st"),
        jobId,
        invoiceId: inv.id,
        days: n,
        rate,
        amount: n * rate,
        at: nowISO(),
      });
      log(
        jobId,
        null,
        "Garage",
        "STORAGE_FEE",
        `${n} day(s) of storage added to ${inv.no} — ${money(n * rate)}.`,
        null,
        n * rate,
      );
      toast(`Storage fee added to ${inv.no}.`, "ok");
      refresh();
    },

    /* =====================================================
       TAX MANAGEMENT
       ===================================================== */
    saveTax(payload) {
      const value =
        payload.kind === "PERCENT"
          ? Math.round(Number(payload.value) * 100) // 8.00 -> 800
          : Math.round(Number(payload.value) * 100); // $5.00 -> 500

      if (payload.id) {
        /* editing an active rate creates a NEW VERSION, never mutates history */
        const old = taxById(payload.id);
        if (!old) return;
        const newId = uid("tax");
        old.active = false;
        old.effectiveTo = nowISO();
        old.supersededBy = newId;
        S.taxes.push({
          id: newId,
          code: old.code,
          name: payload.name || old.name,
          kind: payload.kind,
          value,
          inclusive: !!payload.inclusive,
          appliesTo: payload.appliesTo || [],
          effectiveFrom: nowISO(),
          effectiveTo: null,
          active: true,
          supersededBy: null,
        });
        log(
          S.jobId,
          null,
          "Garage",
          "TAX_VERSION",
          `${old.code} re-rated to ${payload.kind === "PERCENT" ? (value / 100).toFixed(2) + "%" : money(value) + "/unit"}. Old rate kept for existing documents.`,
          null,
          null,
        );
        toast(
          `${old.code} updated — existing documents keep the old rate.`,
          "ok",
        );
      } else {
        const code = (payload.code || "").trim().toUpperCase();
        if (!code) {
          toast("A tax code is required.", "warn");
          return;
        }
        S.taxes.push({
          id: uid("tax"),
          code,
          name: payload.name || code,
          kind: payload.kind,
          value,
          inclusive: !!payload.inclusive,
          appliesTo: payload.appliesTo || [],
          effectiveFrom: nowISO(),
          effectiveTo: null,
          active: true,
          supersededBy: null,
        });
        log(
          S.jobId,
          null,
          "Garage",
          "TAX_CREATED",
          `Tax ${code} created.`,
          null,
          null,
        );
        toast(`Tax ${code} created.`, "ok");
      }
      refresh();
    },

    deactivateTax(taxId) {
      const t = taxById(taxId);
      if (!t) return;
      t.active = false;
      t.effectiveTo = nowISO();
      log(
        S.jobId,
        null,
        "Garage",
        "TAX_DEACTIVATED",
        `Tax ${t.code} deactivated — not offered on new lines.`,
        null,
        null,
      );
      toast(`Tax ${t.code} deactivated.`, "ok");
      refresh();
    },

    /* =====================================================
       SERVICE CATALOG
       ===================================================== */
    saveService(payload) {
      const price = Math.round(Number(payload.price) * 100);
      if (payload.id) {
        const svc = sel.service(payload.id);
        if (!svc) return;
        svc.name = payload.name;
        svc.category = payload.category || "General";
        svc.price = price;
        svc.taxCode = payload.taxCode;
        toast("Service updated.", "ok");
      } else {
        S.services.push({
          id: uid("svc"),
          name: payload.name,
          category: payload.category || "General",
          price,
          taxCode: payload.taxCode,
          unit: "job",
        });
        toast("Service added to the catalog.", "ok");
      }
      refresh();
    },

    removeService(serviceId) {
      S.services = S.services.filter((s) => s.id !== serviceId);
      toast("Service removed from the catalog.", "warn");
      refresh();
    },
  };

  function completeRefundRecord(r) {
    const source = sel.invoice(r.invoiceId);
    /* A credit note always lands on the live version, never on a void one. */
    const inv = sel.stdInvoice(source.jobId) || source;
    const p = sel.payment(r.paymentId);

    r.status = "COMPLETED";

    const cn = {
      id: uid("cn"),
      invoiceId: inv.id,
      refundId: r.id,
      no: "CN-" + counters.cn++,
      amount: r.amount,
      reason: r.reason,
      issuedAt: nowISO(),
    };
    S.creditNotes.push(cn);
    r.creditNoteId = cn.id;

    const refundedOnPayment = S.refunds
      .filter((x) => x.paymentId === p.id && x.status === "COMPLETED")
      .reduce((s, x) => s + x.amount, 0);
    p.status =
      refundedOnPayment >= p.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";

    syncInvoice(inv);
    log(
      inv.jobId,
      null,
      "System",
      "CREDIT_NOTE",
      `Credit note ${cn.no} issued for ${money(r.amount)} against ${inv.no}. Payment ${p.no} now ${p.status.replace("_", " ").toLowerCase()}.`,
      null,
      r.amount,
    );
    toast(`Refund completed — credit note ${cn.no} generated.`, "ok");
  }

  /* =========================================================
     BOOT
     ========================================================= */
  seed();

  global.Store = {
    S,
    sel,
    money,
    fmtDateTime,
    fmtDay,
    uid,
    nowISO,
    addDays,
    quoteTotals,
    docTotals,
    lineMath,
    lineTotal,
    depositFor,
    syncInvoice,
    activeTaxes,
    taxById,
    taxByCode,
    defaultTaxFor,
    taxLabel,
    taxRateLabel,
    setLineTax,
    buildLines,
    invoiceNeedsUpdate,
    invoicePaid,
    invoiceRefunded,
    validReceipts,
    voidReceipts,
    actions,
    seed,
  };
})(window);
