/* =========================================================
   store.js — mock data + business rules for the prototype.
   No backend, no database. Everything lives in memory.

   Money = INTEGER CENTS everywhere.
   Tax lives on the LINE (snapshot), never on a global setting,
   so changing a rate tomorrow cannot rewrite yesterday's bill.
   ========================================================= */
(function (global) {
  'use strict';

  /* ---------------- utils ---------------- */
  const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 9);
  const nowISO = () => new Date().toISOString();
  const addDays = (iso, n) => {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return d.toISOString();
  };
  const money = (cents) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
  const fmtDateTime = (iso) =>
    iso
      ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '—';
  const fmtDay = (iso) =>
    iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  const refresh = () => { if (global.App && global.App.render) global.App.render(); };
  const toast = (msg, kind) => { if (global.App && global.App.toast) global.App.toast(msg, kind); };

  /* ---------------- state ---------------- */
  const S = {
    role: 'garage',
    screen: 'job',            // 'job' | 'taxes' | 'services'
    jobId: 'job_1',
    tab: 'overview',
    editingQuoteId: null,
    settings: {
      depositType: 'PERCENT',
      depositValue: 30,
      storageDailyRate: 3500,
      storageGraceDays: 3,
    },
    taxes: [],
    services: [],
    jobs: [], quotes: [], invoices: [], payments: [], receipts: [],
    refunds: [], creditNotes: [], cancellations: [], storage: [], timeline: [],
  };

  let counters = { inv: 5001, pro: 8001, pay: 9001, rec: 7001, ref: 3001, cn: 101 };

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
      S.quotes.filter((q) => q.jobId === jobId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    activeQuote: (jobId) =>
      sel.quotesForJob(jobId)
        .filter((q) => ['DRAFT', 'PENDING_GARAGE_APPROVAL', 'PENDING_CUSTOMER_APPROVAL'].includes(q.status))
        .pop(),
    stdQuote: (jobId) => sel.quotesForJob(jobId).find((q) => q.type === 'STANDARD' && q.status === 'ACCEPTED'),

    invoicesForJob: (jobId) => S.invoices.filter((i) => i.jobId === jobId),
    stdInvoice: (jobId) => S.invoices.find((i) => i.jobId === jobId && i.kind === 'TAX_INVOICE'),
    openProforma: (jobId) =>
      S.invoices.filter((i) => i.jobId === jobId && i.kind === 'PROFORMA' && i.status === 'ISSUED').pop(),

    paymentsForInvoice: (invId) => S.payments.filter((p) => p.invoiceId === invId),
    paymentsForJob: (jobId) => S.payments.filter((p) => (sel.invoice(p.invoiceId) || {}).jobId === jobId),
    refundsForJob: (jobId) => S.refunds.filter((r) => (sel.invoice(r.invoiceId) || {}).jobId === jobId),
    creditNotesForInvoice: (invId) => S.creditNotes.filter((c) => c.invoiceId === invId),
    cancellationsForJob: (jobId) => S.cancellations.filter((c) => c.jobId === jobId),
    openCancellation: (jobId) =>
      S.cancellations
        .filter((c) => c.jobId === jobId)
        .find((c) => !['AGREED', 'DECLINED', 'WITHDRAWN'].includes(c.status)),
    storageForJob: (jobId) => S.storage.filter((s) => s.jobId === jobId),
    timelineForJob: (jobId) =>
      S.timeline.filter((t) => t.jobId === jobId).sort((a, b) => new Date(a.at) - new Date(b.at)),
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
    S.taxes.find((t) => t.code === code && t.active) || S.taxes.find((t) => t.code === code);

  const defaultTaxFor = (kind) => {
    const list = activeTaxes();
    return list.find((t) => (t.appliesTo || []).includes(kind)) || null;
  };

  const taxRateLabel = (t) => {
    if (!t) return 'No tax';
    return t.kind === 'PERCENT' ? `${(t.value / 100).toFixed(2)}%` : `${money(t.value)} / unit`;
  };
  const taxLabel = (t) => (t ? `${t.code} · ${taxRateLabel(t)}` : 'No tax');

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

    if (line.taxKind === 'PERCENT') {
      const rate = (line.taxValue || 0) / 10000;
      if (line.taxInclusive) {
        const net = Math.round(gross / (1 + rate)); // tax is already inside the price
        return { gross, net, tax: gross - net };
      }
      return { gross, net: gross, tax: Math.round(gross * rate) };
    }
    // FIXED: charged per unit, added on top
    return { gross, net: gross, tax: Math.round((line.taxValue || 0) * (line.qty || 0)) };
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
            id: line.taxId, code: line.taxCode, name: line.taxName,
            kind: line.taxKind, value: line.taxValue, inclusive: line.taxInclusive,
            base: 0, amount: 0,
          });
        }
        const e = map.get(line.taxId);
        e.base += m.net;
        e.amount += m.tax;
      }
    });

    return { subtotal, taxTotal, total: subtotal + taxTotal, taxes: [...map.values()] };
  }

  const quoteTotals = (q) => docTotals(q.items);
  const lineTotal = (line) => Math.round((line.qty || 0) * (line.unitPrice || 0));

  function depositFor(q) {
    const total = quoteTotals(q).total;
    if (q.depositType === 'PERCENT') return Math.round((total * (q.depositValue || 0)) / 100);
    if (q.depositType === 'FLAT') return Math.round((q.depositValue || 0) * 100);
    return 0;
  }

  /* =========================================================
     INVOICE MATH
     ========================================================= */
  function syncInvoice(inv) {
    const t = docTotals(inv.lines);
    inv.subtotal = t.subtotal;
    inv.taxTotal = t.taxTotal;
    inv.taxes = t.taxes;
    inv.total = t.total;

    if (inv.kind === 'PROFORMA') {
      inv.amountPaid = 0;
      inv.refunded = 0;
      inv.balance = 0;               // a proforma never chases money
      inv.vehicleHold = false;
      if (!['SUPERSEDED', 'VOID'].includes(inv.status)) inv.status = 'ISSUED';
      return inv;
    }

    const paid = S.payments
      .filter((p) => p.invoiceId === inv.id && ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))
      .reduce((s, p) => s + p.amount, 0);
    const refunded = S.refunds
      .filter((r) => r.invoiceId === inv.id && r.status === 'COMPLETED')
      .reduce((s, r) => s + r.amount, 0);
    const balance = Math.max(0, inv.total - paid);

    inv.amountPaid = paid;
    inv.refunded = refunded;
    inv.balance = balance;

    if (inv.total === 0) inv.status = 'PAID';
    else if (balance === 0) inv.status = refunded > 0 && refunded >= paid ? 'REFUNDED' : 'PAID';
    else if (paid > 0) inv.status = 'PARTIALLY_PAID';
    else inv.status = 'UNPAID';

    inv.vehicleHold = inv.kind === 'TAX_INVOICE' && balance > 0;
    return inv;
  }

  /* =========================================================
     AUDIT LOG
     ========================================================= */
  function log(jobId, quoteId, actor, action, note, before, after) {
    S.timeline.push({
      id: uid('tl'), jobId, quoteId, actor, action, note,
      amountBefore: before === undefined ? null : before,
      amountAfter: after === undefined ? null : after,
      at: nowISO(),
    });
  }

  const nextQuoteNo = (job) =>
    'Q-' + job.jobNo.replace('JC-', '') + '-' + (sel.quotesForJob(job.id).length + 1);

  /* =========================================================
     LINE BUILDERS
     ========================================================= */
  function linesFromQuote(q, isAddon) {
    return q.items.map((i) => ({
      id: uid('ln'), quoteId: q.id, quoteType: q.type,
      description: i.description, qty: i.qty, unitPrice: i.unitPrice,
      taxId: i.taxId, taxCode: i.taxCode, taxName: i.taxName,
      taxKind: i.taxKind, taxValue: i.taxValue, taxInclusive: i.taxInclusive,
      isAddon: !!isAddon,
    }));
  }

  /* Every accepted quote on the job, ready to become invoice lines. */
  function buildLines(jobId) {
    const accepted = sel.quotesForJob(jobId).filter((q) => q.status === 'ACCEPTED' && q.type !== 'WARRANTY');
    const settlement = accepted.find((q) => q.type === 'SETTLEMENT');
    const base = settlement || accepted.find((q) => q.type === 'STANDARD');
    const addons = accepted.filter((q) => q.type === 'SUPPLEMENTARY');

    const lines = [];
    if (base) lines.push(...linesFromQuote(base, false));
    addons.forEach((q) => lines.push(...linesFromQuote(q, true)));

    return { lines, base, addons, settlement };
  }

  /* True when accepted work has not yet reached the invoice. */
  function invoiceNeedsUpdate(jobId) {
    const inv = sel.stdInvoice(jobId);
    if (!inv) return null;
    const built = buildLines(jobId);
    if (!built.base) return null;
    const a = docTotals(built.lines).total;
    const b = docTotals(inv.lines).total;
    if (a === b && built.lines.length === inv.lines.length) return null;
    return { delta: a - b, lines: built.lines.length - inv.lines.length };
  }

  /* =========================================================
     SEED
     ========================================================= */
  function seed() {
    S.jobs = []; S.quotes = []; S.invoices = []; S.payments = []; S.receipts = [];
    S.refunds = []; S.creditNotes = []; S.cancellations = []; S.storage = []; S.timeline = [];
    counters = { inv: 5004, pro: 8004, pay: 9004, rec: 7004, ref: 3004, cn: 101 };

    const t = nowISO();
    const FROM = '2024-01-01T00:00:00.000Z';

    /* ---------- taxes ---------- */
    S.taxes = [
      { id: 'tax_vat_std', code: 'VAT-STD', name: 'VAT (standard)', kind: 'PERCENT', value: 800,
        inclusive: false, appliesTo: ['SERVICE', 'FEE'], effectiveFrom: FROM, effectiveTo: null, active: true, supersededBy: null },
      { id: 'tax_vat_lab', code: 'VAT-LAB', name: 'VAT (labour)', kind: 'PERCENT', value: 800,
        inclusive: false, appliesTo: ['LABOR'], effectiveFrom: FROM, effectiveTo: null, active: true, supersededBy: null },
      { id: 'tax_vat_prt', code: 'VAT-PRT', name: 'VAT (parts)', kind: 'PERCENT', value: 500,
        inclusive: false, appliesTo: ['PART'], effectiveFrom: FROM, effectiveTo: null, active: true, supersededBy: null },
      { id: 'tax_env_tyr', code: 'ENV-TYR', name: 'Tyre environmental levy', kind: 'FIXED', value: 500,
        inclusive: false, appliesTo: [], effectiveFrom: '2024-03-01T00:00:00.000Z', effectiveTo: null, active: true, supersededBy: null },
      { id: 'tax_wst_dis', code: 'WST-DIS', name: 'Waste disposal', kind: 'FIXED', value: 1200,
        inclusive: false, appliesTo: ['FEE'], effectiveFrom: '2024-06-01T00:00:00.000Z', effectiveTo: null, active: true, supersededBy: null },
      { id: 'tax_inc_prt', code: 'VAT-PRT-INC', name: 'VAT (parts, tax-inclusive)', kind: 'PERCENT', value: 500,
        inclusive: true, appliesTo: [], effectiveFrom: FROM, effectiveTo: null, active: true, supersededBy: null },
      /* historical version, kept for the audit trail */
      { id: 'tax_vat_old', code: 'VAT-STD', name: 'VAT (standard, 2023)', kind: 'PERCENT', value: 750,
        inclusive: false, appliesTo: ['SERVICE', 'FEE'], effectiveFrom: '2023-01-01T00:00:00.000Z',
        effectiveTo: '2023-12-31T00:00:00.000Z', active: false, supersededBy: 'tax_vat_std' },
    ];

    /* ---------- service catalog ---------- */
    S.services = [
      { id: 'svc_oil', name: 'Oil & filter change', category: 'Maintenance', price: 9900, taxCode: 'VAT-STD', unit: 'job' },
      { id: 'svc_brake_pad', name: 'Front brake pads (OEM)', category: 'Brakes', price: 8900, taxCode: 'VAT-PRT', unit: 'set' },
      { id: 'svc_rotor', name: 'Brake rotors (pair)', category: 'Brakes', price: 14500, taxCode: 'VAT-PRT', unit: 'pair' },
      { id: 'svc_brake_fluid', name: 'Brake fluid flush', category: 'Brakes', price: 6900, taxCode: 'VAT-STD', unit: 'job' },
      { id: 'svc_brake_lab', name: 'Brake overhaul labour', category: 'Brakes', price: 9500, taxCode: 'VAT-LAB', unit: 'hour' },
      { id: 'svc_align', name: 'Four-wheel alignment', category: 'Tyres', price: 7200, taxCode: 'VAT-STD', unit: 'job' },
      { id: 'svc_tyre', name: 'Tyre replacement', category: 'Tyres', price: 12500, taxCode: 'VAT-PRT', unit: 'tyre' },
      { id: 'svc_tyre_levy', name: 'Tyre disposal levy', category: 'Tyres', price: 500, taxCode: 'ENV-TYR', unit: 'tyre' },
      { id: 'svc_ac', name: 'A/C recharge (R-134a)', category: 'Climate', price: 18000, taxCode: 'VAT-STD', unit: 'job' },
      { id: 'svc_diag', name: 'Diagnostic scan', category: 'Diagnostics', price: 6000, taxCode: 'VAT-STD', unit: 'job' },
      { id: 'svc_battery', name: 'Battery replacement', category: 'Electrical', price: 15900, taxCode: 'VAT-PRT', unit: 'unit' },
      { id: 'svc_coolant', name: 'Coolant flush', category: 'Maintenance', price: 8900, taxCode: 'VAT-STD', unit: 'job' },
      { id: 'svc_cabin', name: 'Cabin air filter', category: 'Filters', price: 5900, taxCode: 'VAT-PRT', unit: 'unit' },
      { id: 'svc_wiper', name: 'Wiper blades (pair)', category: 'Filters', price: 3200, taxCode: 'VAT-PRT', unit: 'pair' },
      { id: 'svc_shop', name: 'Shop supplies & disposal', category: 'Fees', price: 2500, taxCode: 'WST-DIS', unit: 'job' },
      { id: 'svc_labour', name: 'General labour', category: 'Labour', price: 9500, taxCode: 'VAT-LAB', unit: 'hour' },
    ];

    /* helper: build a quote line with its tax snapshot */
    const mkItem = (kind, desc, qty, price, taxCode, extra) =>
      setLineTax(
        Object.assign({ id: uid('qi'), kind, description: desc, qty, unitPrice: price }, extra || {}),
        taxByCode(taxCode),
      );

    /* ---------- JOB 1 — garage quote awaiting customer ---------- */
    S.jobs.push({
      id: 'job_1', jobNo: 'JC-1042', garageName: 'Northgate Auto Works',
      customerName: 'Dana Whitfield', customerEmail: 'dana.whitfield@example.com',
      vehicle: { year: 2016, make: 'Toyota', model: 'Corolla', plate: 'KX-4471', vin: 'JT2BF22K1W0123456', odometer: 128400 },
      status: 'QUOTING', createdAt: addDays(t, -2), pausedReason: null, dependsOnQuoteId: null,
    });

    const q1 = {
      id: 'q_1', jobId: 'job_1', no: 'Q-1042-1', type: 'STANDARD',
      status: 'PENDING_CUSTOMER_APPROVAL', createdByRole: 'GARAGE',
      parentQuoteId: null, originalInvoiceId: null,
      items: [
        mkItem('PART', 'Front brake pads (set, OEM)', 1, 8900, 'VAT-PRT'),
        mkItem('PART', 'Brake rotors (pair)', 1, 14500, 'VAT-PRT'),
        mkItem('LABOR', 'Brake overhaul labour', 3.5, 9500, 'VAT-LAB'),
        mkItem('FEE', 'Shop supplies & disposal', 1, 2500, 'WST-DIS'),
      ],
      conditions: [{ id: 'qc_1', text: 'Must use OEM parts only.', addedBy: 'GARAGE', at: addDays(t, -1) }],
      hasDependency: false, isChangeOrder: false,
      depositType: 'PERCENT', depositValue: 30,
      expiryDate: addDays(t, 6), revision: 1,
      createdAt: addDays(t, -1), acceptedAt: null, rejectedAt: null, lockedAt: null,
    };
    q1.revisions = [{ no: 1, total: quoteTotals(q1).total, by: 'Garage', at: addDays(t, -1) }];
    S.quotes.push(q1);
    log('job_1', 'q_1', 'Garage', 'CREATE', 'Initial quote sent after vehicle inspection.', null, quoteTotals(q1).total);

    /* ---------- JOB 2 — customer RFQ awaiting garage ---------- */
    S.jobs.push({
      id: 'job_2', jobNo: 'JC-1043', garageName: 'Northgate Auto Works',
      customerName: 'Dana Whitfield', customerEmail: 'dana.whitfield@example.com',
      vehicle: { year: 2019, make: 'Honda', model: 'Civic', plate: 'PL-8890', vin: '19XFC2F59KE001234', odometer: 61200 },
      status: 'REQUESTED', createdAt: addDays(t, -1), pausedReason: null, dependsOnQuoteId: null,
    });

    const q2 = {
      id: 'q_2', jobId: 'job_2', no: 'Q-1043-1', type: 'STANDARD',
      status: 'PENDING_GARAGE_APPROVAL', createdByRole: 'CUSTOMER',
      parentQuoteId: null, originalInvoiceId: null,
      items: [
        mkItem('LABOR', 'A/C not cooling — diagnostic inspection', 1, 6000, 'VAT-LAB'),
        mkItem('SERVICE', 'Refrigerant recharge (R-134a)', 1, 18000, 'VAT-STD'),
      ],
      conditions: [{ id: 'qc_2', text: 'Budget cap is $400.00 — please confirm before exceeding.', addedBy: 'CUSTOMER', at: addDays(t, -1) }],
      hasDependency: false, isChangeOrder: false,
      depositType: 'PERCENT', depositValue: 30,
      expiryDate: addDays(t, 9), revision: 1,
      createdAt: addDays(t, -1), acceptedAt: null, rejectedAt: null, lockedAt: null,
    };
    q2.revisions = [{ no: 1, total: quoteTotals(q2).total, by: 'Customer', at: addDays(t, -1) }];
    S.quotes.push(q2);
    log('job_2', 'q_2', 'Customer', 'CREATE', 'Request for Quote submitted with budget cap.', null, quoteTotals(q2).total);

    /* ---------- JOB 3 — accepted, invoiced, deposit paid ---------- */
    S.jobs.push({
      id: 'job_3', jobNo: 'JC-1044', garageName: 'Northgate Auto Works',
      customerName: 'Dana Whitfield', customerEmail: 'dana.whitfield@example.com',
      vehicle: { year: 2021, make: 'BMW', model: '320i', plate: 'BM-2210', vin: 'WBA5R1C0XMFL12345', odometer: 34850 },
      status: 'IN_PROGRESS', createdAt: addDays(t, -6), pausedReason: null, dependsOnQuoteId: null,
    });

    const q3 = {
      id: 'q_3', jobId: 'job_3', no: 'Q-1044-1', type: 'STANDARD',
      status: 'ACCEPTED', createdByRole: 'GARAGE',
      parentQuoteId: null, originalInvoiceId: null,
      items: [
        mkItem('SERVICE', 'Oil & filter change', 1, 9900, 'VAT-STD', { packageRef: 'pkg_full', standaloneUnitPrice: 12000 }),
        mkItem('SERVICE', 'Brake fluid flush', 1, 6900, 'VAT-STD', { packageRef: 'pkg_full', standaloneUnitPrice: 9000 }),
        mkItem('SERVICE', 'Cabin air filter replacement', 1, 5900, 'VAT-PRT', { packageRef: 'pkg_full', standaloneUnitPrice: 7000 }),
        mkItem('SERVICE', 'Four-wheel alignment', 1, 7200, 'VAT-STD', { packageRef: 'pkg_full', standaloneUnitPrice: 11000 }),
      ],
      conditions: [{ id: 'qc_3', text: 'Bundled "Full Service Package" price — discounted vs. standalone rates.', addedBy: 'GARAGE', at: addDays(t, -6) }],
      hasDependency: false, isChangeOrder: false,
      depositType: 'PERCENT', depositValue: 30,
      expiryDate: addDays(t, -1), revision: 1,
      createdAt: addDays(t, -6), acceptedAt: addDays(t, -5), rejectedAt: null, lockedAt: addDays(t, -5),
    };
    q3.revisions = [{ no: 1, total: quoteTotals(q3).total, by: 'Garage', at: addDays(t, -6) }];
    S.quotes.push(q3);

    const inv3 = {
      id: 'inv_3', jobId: 'job_3', quoteId: 'q_3', no: 'INV-5003', kind: 'TAX_INVOICE',
      originalInvoiceId: null, settlementQuoteId: null, supersededBy: null,
      lines: linesFromQuote(q3, false),
      issuedAt: addDays(t, -5), dueAt: addDays(t, 9),
      depositRequired: depositFor(q3), depositType: 'PERCENT', depositValue: 30,
    };
    S.invoices.push(inv3);
    syncInvoice(inv3);

    S.payments.push({
      id: 'pay_3', invoiceId: 'inv_3', no: 'PAY-9003', amount: inv3.depositRequired,
      type: 'DEPOSIT', method: 'CARD', status: 'SUCCEEDED', paidAt: addDays(t, -4),
    });
    S.receipts.push({
      id: 'rec_3', paymentId: 'pay_3', no: 'RCP-7003',
      issuedAt: addDays(t, -4), emailedTo: 'dana.whitfield@example.com',
    });
    syncInvoice(inv3);

    log('job_3', 'q_3', 'Garage', 'CREATE', 'Full Service Package quoted (bundled pricing).', null, quoteTotals(q3).total);
    log('job_3', 'q_3', 'Customer', 'ACCEPT', 'Quote accepted and locked.', quoteTotals(q3).total, quoteTotals(q3).total);
    log('job_3', null, 'System', 'INVOICE_ISSUED', 'Invoice INV-5003 generated from accepted quote.', null, inv3.total);
    log('job_3', null, 'System', 'PAYMENT_RECEIVED', `PAY-9003 · ${money(inv3.depositRequired)} deposit (CARD). Receipt RCP-7003 emailed.`, null, inv3.depositRequired);
    log('job_3', null, 'Garage', 'WORK_STARTED', 'Deposit received — work commenced.', null, null);
  }

  /* =========================================================
     ACTIONS
     ========================================================= */
  const actions = {

    /* ---------- navigation ---------- */
    setRole(role) { S.role = role; S.screen = 'job'; S.editingQuoteId = null; refresh(); },
    setScreen(screen) { S.screen = screen; S.tab = 'overview'; S.editingQuoteId = null; refresh(); },
    selectJob(id) { S.jobId = id; S.screen = 'job'; S.tab = 'overview'; S.editingQuoteId = null; refresh(); },
    setTab(tab) { S.tab = tab; S.editingQuoteId = null; refresh(); },
    reset() {
      seed();
      S.role = 'garage'; S.screen = 'job'; S.jobId = 'job_1'; S.tab = 'overview'; S.editingQuoteId = null;
      refresh();
    },

    /* ---------- quote editing ---------- */
    startEdit(quoteId) { S.editingQuoteId = quoteId; S.tab = 'quotes'; refresh(); },
    cancelEdit() { S.editingQuoteId = null; refresh(); },

    addItem(quoteId) {
      const q = sel.quote(quoteId);
      const line = { id: uid('qi'), kind: 'LABOR', description: 'Custom line item', qty: 1, unitPrice: 0 };
      setLineTax(line, defaultTaxFor('LABOR'));
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
          id: uid('qi'),
          kind: svc.category === 'Labour' ? 'LABOR' : 'SERVICE',
          description: svc.name, qty: 1, unitPrice: svc.price, serviceId: svc.id,
        };
        setLineTax(line, taxByCode(svc.taxCode) || defaultTaxFor(line.kind));
        q.items.push(line);
      });
      toast(`${ids.length} service${ids.length > 1 ? 's' : ''} added.`, 'ok');
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
      const actor = S.role === 'customer' ? 'Customer' : 'Garage';

      q.revision += 1;
      q.revisions = q.revisions || [];
      q.revisions.push({ no: q.revision, total: after, by: actor, at: nowISO() });
      q.status = S.role === 'customer' ? 'PENDING_GARAGE_APPROVAL' : 'PENDING_CUSTOMER_APPROVAL';
      q.expiryDate = addDays(nowISO(), 7);
      S.editingQuoteId = null;

      log(q.jobId, q.id, actor, 'COUNTER_OFFER', `Revision ${q.revision} sent for approval.`, before, after);

      if (q.hasDependency && S.role === 'garage') {
        job.status = 'PAUSED_PENDING_APPROVAL';
        job.pausedReason = `Blocking change order ${q.no} awaiting customer decision.`;
        job.dependsOnQuoteId = q.id;
        log(q.jobId, q.id, 'System', 'JOB_PAUSED', 'Work paused — change order flagged as blocking.', null, null);
      }
      toast(`Counter-offer sent — waiting for the ${S.role === 'customer' ? 'garage' : 'customer'}.`, 'ok');
      refresh();
    },

    sendQuote(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      q.status = 'PENDING_CUSTOMER_APPROVAL';
      q.revision += 1;
      q.revisions = q.revisions || [];
      q.revisions.push({ no: q.revision, total: quoteTotals(q).total, by: 'Garage', at: nowISO() });
      S.editingQuoteId = null;

      log(q.jobId, q.id, 'Garage', 'CREATE', `Quote ${q.no} sent to customer for approval.`, null, quoteTotals(q).total);

      if (q.hasDependency) {
        job.status = 'PAUSED_PENDING_APPROVAL';
        job.pausedReason = `Blocking change order ${q.no} awaiting customer decision.`;
        job.dependsOnQuoteId = q.id;
        log(q.jobId, q.id, 'System', 'JOB_PAUSED', 'Work paused — change order flagged as blocking.', null, null);
      }
      toast('Quote sent to the customer.', 'ok');
      refresh();
    },

    addCondition(quoteId, text) {
      const q = sel.quote(quoteId);
      if (!text || !text.trim()) return;
      q.conditions.push({
        id: uid('qc'), text: text.trim(),
        addedBy: S.role === 'customer' ? 'CUSTOMER' : 'GARAGE', at: nowISO(),
      });
      log(q.jobId, q.id, S.role === 'customer' ? 'Customer' : 'Garage', 'ADD_CONDITION', text.trim());
      toast('Condition added to the quote.', 'ok');
      refresh();
    },

    /* ---------- accept / reject ---------- */
    acceptQuote(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      const actor = S.role === 'customer' ? 'Customer' : 'Garage';
      const total = quoteTotals(q).total;

      q.status = 'ACCEPTED';
      q.acceptedAt = nowISO();
      q.lockedAt = nowISO();
      log(q.jobId, q.id, actor, 'ACCEPT', `Quote ${q.no} accepted and locked.`, total, total);

      if (q.type === 'SETTLEMENT') {
        job.status = 'CANCELLED';
        job.pausedReason = null;
        job.dependsOnQuoteId = null;
        const cancel = sel.openCancellation(job.id);
        if (cancel) { cancel.status = 'AGREED'; cancel.settlementQuoteId = q.id; cancel.resolvedAt = nowISO(); }
        log(q.jobId, q.id, 'System', 'SETTLEMENT_AGREED', 'Settlement agreed — generate the final invoice.', null, total);
        toast('Settlement agreed — generate the final invoice.', 'ok');
        refresh();
        return;
      }

      if (q.type === 'SUPPLEMENTARY') {
        if (job.status === 'PAUSED_PENDING_APPROVAL' && q.hasDependency) {
          job.status = 'IN_PROGRESS';
          job.pausedReason = null;
          job.dependsOnQuoteId = null;
          log(q.jobId, q.id, 'System', 'JOB_RESUMED', 'Blocking work approved — work resumed.', null, null);
        }
        toast('Add-on accepted — update the invoice to bill it.', 'ok');
        refresh();
        return;
      }

      /* STANDARD or WARRANTY: no invoice is created automatically. */
      job.status = 'AWAITING_INVOICE';
      job.pausedReason = q.type === 'WARRANTY'
        ? 'Warranty quote accepted — generate the $0.00 invoice.'
        : 'Quote accepted — generate the invoice to collect payment.';
      log(q.jobId, q.id, 'System', 'AWAITING_INVOICE', 'Quote locked. Invoice must be generated by the garage.', null, null);

      toast('Quote accepted — now generate the invoice.', 'ok');
      refresh();
    },

    rejectQuote(quoteId) {
      const q = sel.quote(quoteId);
      const job = sel.job(q.jobId);
      const actor = S.role === 'customer' ? 'Customer' : 'Garage';
      q.status = 'REJECTED';
      q.rejectedAt = nowISO();

      if (q.type === 'SUPPLEMENTARY') {
        if (q.hasDependency) {
          job.status = 'PAUSED_PENDING_APPROVAL';
          job.pausedReason = `Blocking work ${q.no} was rejected. Garage must agree a way forward.`;
          log(q.jobId, q.id, actor, 'REJECT', `Blocking change order ${q.no} rejected — job remains paused.`, quoteTotals(q).total, null);
        } else {
          log(q.jobId, q.id, actor, 'REJECT', `Add-on ${q.no} rejected. Original approved work continues unaffected.`, quoteTotals(q).total, null);
          if (job.status === 'PAUSED_PENDING_APPROVAL' && job.dependsOnQuoteId === q.id) {
            job.status = 'IN_PROGRESS';
            job.pausedReason = null;
            job.dependsOnQuoteId = null;
          }
        }
      } else if (q.type === 'SETTLEMENT') {
        const c = sel.openCancellation(job.id);
        if (c) c.status = 'UNDER_REVIEW';
        log(q.jobId, q.id, actor, 'REJECT', `Settlement quote ${q.no} rejected — renegotiation required.`, quoteTotals(q).total, null);
      } else {
        job.status = 'CANCELLED';
        log(q.jobId, q.id, actor, 'REJECT', `Quote ${q.no} rejected — job cancelled.`, quoteTotals(q).total, null);
      }
      toast('Quote rejected.', 'warn');
      refresh();
    },

    /* ---------- new quotes ---------- */
    createSupplementary(jobId) {
      const job = sel.job(jobId);
      const parent = sel.stdQuote(jobId) || sel.activeQuote(jobId);
      const q = {
        id: uid('q'), jobId, no: nextQuoteNo(job), type: 'SUPPLEMENTARY',
        status: 'DRAFT', createdByRole: 'GARAGE',
        parentQuoteId: parent ? parent.id : null, originalInvoiceId: null,
        items: [setLineTax({ id: uid('qi'), kind: 'PART', description: 'Additional part discovered', qty: 1, unitPrice: 0 }, defaultTaxFor('PART'))],
        conditions: [], revisions: [],
        hasDependency: false, isChangeOrder: true,
        depositType: 'NONE', depositValue: 0,
        expiryDate: addDays(nowISO(), 3), revision: 0,
        createdAt: nowISO(), acceptedAt: null, rejectedAt: null, lockedAt: null,
      };
      S.quotes.push(q);
      S.editingQuoteId = q.id;
      S.tab = 'quotes';
      log(jobId, q.id, 'Garage', 'CREATE', 'Supplementary quote started — new issue found mid-job.', null, 0);
      toast('Supplementary quote started. Add the extra lines, then send it.', 'ok');
      refresh();
    },

    createWarranty(jobId) {
      const job = sel.job(jobId);
      const origInv = sel.invoicesForJob(jobId).find((i) => i.kind === 'TAX_INVOICE');
      const origQuote = sel.stdQuote(jobId);
      const items = (origQuote ? origQuote.items : []).map((i) =>
        setLineTax({
          id: uid('qi'), kind: i.kind,
          description: `[Warranty rework] ${i.description}`,
          qty: i.qty, unitPrice: 0, unitPriceOriginal: i.unitPrice,
        }, null),
      );
      if (!items.length) {
        items.push(setLineTax({ id: uid('qi'), kind: 'LABOR', description: '[Warranty rework] Re-do previous repair', qty: 1, unitPrice: 0, unitPriceOriginal: 9500 }, null));
      }

      const q = {
        id: uid('q'), jobId, no: nextQuoteNo(job), type: 'WARRANTY',
        status: 'DRAFT', createdByRole: 'GARAGE',
        parentQuoteId: origQuote ? origQuote.id : null,
        originalInvoiceId: origInv ? origInv.id : null,
        items,
        conditions: [{ id: uid('qc'), text: 'Zero-dollar rework — covered under warranty. No charge to customer.', addedBy: 'GARAGE', at: nowISO() }],
        revisions: [], hasDependency: false, isChangeOrder: false,
        depositType: 'NONE', depositValue: 0,
        expiryDate: addDays(nowISO(), 14), revision: 0,
        createdAt: nowISO(), acceptedAt: null, rejectedAt: null, lockedAt: null, invoicedAt: null,
      };
      S.quotes.push(q);
      S.editingQuoteId = q.id;
      S.tab = 'quotes';
      log(jobId, q.id, 'Garage', 'CREATE', `Warranty quote raised against ${origInv ? origInv.no : 'original invoice'}.`, null, 0);
      toast('Warranty quote created at $0.00 line items.', 'ok');
      refresh();
    },

    createGarageQuote(jobId) {
      const job = sel.job(jobId);
      const q = {
        id: uid('q'), jobId, no: nextQuoteNo(job), type: 'STANDARD',
        status: 'DRAFT', createdByRole: 'GARAGE',
        parentQuoteId: null, originalInvoiceId: null,
        items: [setLineTax({ id: uid('qi'), kind: 'LABOR', description: 'Labour', qty: 1, unitPrice: 9500 }, defaultTaxFor('LABOR'))],
        conditions: [], revisions: [],
        hasDependency: false, isChangeOrder: false,
        depositType: S.settings.depositType, depositValue: S.settings.depositValue,
        expiryDate: addDays(nowISO(), 7), revision: 0,
        createdAt: nowISO(), acceptedAt: null, rejectedAt: null, lockedAt: null,
      };
      S.quotes.push(q);
      S.editingQuoteId = q.id;
      S.tab = 'quotes';
      log(jobId, q.id, 'Garage', 'CREATE', 'New quote started after inspection.', null, 0);
      refresh();
    },

    createRfq(jobId, description, budgetDollars) {
      const job = sel.job(jobId);
      const budget = Math.round((Number(budgetDollars) || 0) * 100);
      const q = {
        id: uid('q'), jobId, no: nextQuoteNo(job), type: 'STANDARD',
        status: 'PENDING_GARAGE_APPROVAL', createdByRole: 'CUSTOMER',
        parentQuoteId: null, originalInvoiceId: null,
        items: [setLineTax({ id: uid('qi'), kind: 'SERVICE', description: description || 'Requested work', qty: 1, unitPrice: budget }, defaultTaxFor('SERVICE'))],
        conditions: [{ id: uid('qc'), text: `Customer budget cap: ${money(budget)}.`, addedBy: 'CUSTOMER', at: nowISO() }],
        revisions: [], hasDependency: false, isChangeOrder: false,
        depositType: S.settings.depositType, depositValue: S.settings.depositValue,
        expiryDate: addDays(nowISO(), 10), revision: 1,
        createdAt: nowISO(), acceptedAt: null, rejectedAt: null, lockedAt: null,
      };
      q.revisions = [{ no: 1, total: quoteTotals(q).total, by: 'Customer', at: nowISO() }];
      S.quotes.push(q);
      job.status = 'QUOTING';
      log(jobId, q.id, 'Customer', 'CREATE', `Request for Quote submitted: ${description || 'requested work'}. Budget cap ${money(budget)}.`, null, budget);
      toast('Request for Quote sent to the garage.', 'ok');
      refresh();
    },

    /* ---------- documents: proforma + invoice ---------- */
    generateProforma(jobId) {
      const built = buildLines(jobId);
      if (!built.base) { toast('Accept a quote first.', 'warn'); return; }

      const existing = sel.openProforma(jobId);
      if (existing) { toast('A proforma is already open on this job.', 'warn'); return; }

      const doc = {
        id: uid('inv'), jobId, quoteId: built.base.id, no: 'PRO-' + counters.pro++,
        kind: 'PROFORMA', originalInvoiceId: null, settlementQuoteId: null, supersededBy: null,
        lines: built.lines,
        issuedAt: nowISO(), dueAt: addDays(nowISO(), 7),
        depositRequired: depositFor(built.base), depositType: built.base.depositType, depositValue: built.base.depositValue,
      };
      S.invoices.push(doc);
      syncInvoice(doc);
      log(jobId, built.base.id, 'Garage', 'PROFORMA_ISSUED',
        `Proforma ${doc.no} issued for ${money(doc.total)} — not a tax invoice.`, null, doc.total);
      toast(`Proforma ${doc.no} issued.`, 'ok');
      refresh();
    },

    generateInvoice(jobId) {
      const job = sel.job(jobId);

      /* Warranty jobs produce their own zero-dollar invoice */
      const warranty = sel.quotesForJob(jobId).find((q) => q.type === 'WARRANTY' && q.status === 'ACCEPTED' && !q.invoicedAt);
      if (warranty) {
        const doc = {
          id: uid('inv'), jobId, quoteId: warranty.id, no: 'INV-' + counters.inv++,
          kind: 'WARRANTY', originalInvoiceId: warranty.originalInvoiceId, settlementQuoteId: null, supersededBy: null,
          lines: linesFromQuote(warranty, false),
          issuedAt: nowISO(), dueAt: addDays(nowISO(), 14),
          depositRequired: 0, depositType: 'NONE', depositValue: 0,
        };
        S.invoices.push(doc);
        syncInvoice(doc);
        warranty.invoicedAt = nowISO();
        log(jobId, warranty.id, 'System', 'INVOICE_ISSUED',
          `Warranty invoice ${doc.no} issued at $0.00 against ${(sel.invoice(warranty.originalInvoiceId) || {}).no || 'original invoice'}.`, null, 0);
        toast(`Warranty invoice ${doc.no} issued at $0.00.`, 'ok');
        refresh();
        return;
      }

      const built = buildLines(jobId);
      if (!built.base) { toast('Accept a quote first.', 'warn'); return; }

      let inv = sel.stdInvoice(jobId);
      const isNew = !inv;

      if (isNew) {
        inv = {
          id: uid('inv'), jobId, quoteId: built.base.id, no: 'INV-' + counters.inv++,
          kind: 'TAX_INVOICE', originalInvoiceId: null,
          settlementQuoteId: built.settlement ? built.settlement.id : null, supersededBy: null,
          lines: built.lines,
          issuedAt: nowISO(), dueAt: addDays(nowISO(), 14),
          depositRequired: depositFor(built.base),
          depositType: built.base.depositType, depositValue: built.base.depositValue,
        };
        S.invoices.push(inv);
        syncInvoice(inv);

        /* the proforma is replaced by the real thing */
        const pro = sel.openProforma(jobId);
        if (pro) {
          pro.status = 'SUPERSEDED';
          pro.supersededBy = inv.id;
          syncInvoice(pro);
        }
        log(jobId, built.base.id, 'Garage', 'INVOICE_ISSUED',
          `Invoice ${inv.no} generated from accepted quote${built.addons.length ? ' + ' + built.addons.length + ' add-on(s)' : ''}.`, null, inv.total);
      } else {
        inv.lines = built.lines;
        if (built.settlement) inv.settlementQuoteId = built.settlement.id;
        syncInvoice(inv);
        log(jobId, null, 'Garage', 'INVOICE_UPDATED',
          `Invoice ${inv.no} regenerated from accepted work — now ${money(inv.total)}.`, null, inv.total);
      }

      if (job.status === 'AWAITING_INVOICE') {
        job.status = inv.depositRequired > 0 && inv.amountPaid < inv.depositRequired
          ? 'AWAITING_DEPOSIT'
          : 'IN_PROGRESS';
        job.pausedReason = job.status === 'AWAITING_DEPOSIT' ? 'Deposit required before work begins.' : null;
        if (job.status === 'IN_PROGRESS') {
          log(jobId, null, 'System', 'WORK_STARTED', 'Invoice issued — work can proceed.', null, null);
        }
      }

      toast(isNew ? `Invoice ${inv.no} generated.` : `Invoice ${inv.no} updated.`, 'ok');
      refresh();
    },

    /* ---------- cancellation + settlement ---------- */
    requestCancellation(jobId, reason) {
      const job = sel.job(jobId);
      S.cancellations.push({
        id: uid('can'), jobId, reason: reason || 'No reason given.',
        status: 'REQUESTED', requestedBy: 'Customer',
        settlementQuoteId: null, createdAt: nowISO(), resolvedAt: null,
      });
      job.status = 'PAUSED_PENDING_CANCELLATION';
      job.pausedReason = 'Customer requested cancellation — awaiting settlement.';
      log(jobId, null, 'Customer', 'CANCEL_REQUEST', reason || 'Cancellation requested.', null, null);
      log(jobId, null, 'System', 'JOB_PAUSED', 'Job auto-paused pending cancellation settlement.', null, null);
      toast('Cancellation requested — job paused, garage notified.', 'warn');
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
        items.push(setLineTax({ id: uid('qi'), kind: 'LABOR', description: `Labour completed to date (${hours}h, prorated)`, qty: hours, unitPrice: 9500 }, defaultTaxFor('LABOR')));
      }
      if (orig) {
        orig.items.filter((i) => i.kind === 'PART').forEach((p) =>
          items.push(setLineTax({ id: uid('qi'), kind: 'PART', description: `${p.description} (already installed)`, qty: p.qty, unitPrice: p.unitPrice }, taxById(p.taxId) || defaultTaxFor('PART'))));

        const pkg = orig.items.filter((i) => i.packageRef);
        if (pkg.length) {
          pkg.forEach((p) => items.push(setLineTax({
            id: uid('qi'), kind: 'SERVICE',
            description: unbundle ? `${p.description} — unbundled, standard rate` : `${p.description} (package rate)`,
            qty: p.qty,
            unitPrice: unbundle ? (p.standaloneUnitPrice || p.unitPrice) : p.unitPrice,
          }, taxById(p.taxId) || defaultTaxFor('SERVICE'))));
        }
      }
      if (restock > 0) {
        items.push(setLineTax({ id: uid('qi'), kind: 'RESTOCKING_FEE', description: 'Restocking fee — special-order parts returned to supplier', qty: 1, unitPrice: restock }, null));
      }

      const q = {
        id: uid('q'), jobId, no: nextQuoteNo(job), type: 'SETTLEMENT',
        status: 'PENDING_CUSTOMER_APPROVAL', createdByRole: 'GARAGE',
        parentQuoteId: orig ? orig.id : null, originalInvoiceId: null,
        items,
        conditions: [{ id: uid('qc'), text: 'Settlement figure covers work completed up to the cancellation time only.', addedBy: 'GARAGE', at: nowISO() }],
        revisions: [], hasDependency: false, isChangeOrder: false,
        depositType: 'NONE', depositValue: 0,
        expiryDate: addDays(nowISO(), 7), revision: 1,
        createdAt: nowISO(), acceptedAt: null, rejectedAt: null, lockedAt: null,
      };
      q.revisions = [{ no: 1, total: quoteTotals(q).total, by: 'Garage', at: nowISO() }];
      S.quotes.push(q);

      if (c) { c.status = 'SETTLEMENT_SENT'; c.settlementQuoteId = q.id; }

      log(jobId, q.id, 'Garage', 'SETTLE',
        `Settlement quote ${q.no} issued${unbundle ? ' (package unbundled at standard rates)' : ''}.`, null, quoteTotals(q).total);
      toast('Settlement quote sent to the customer.', 'ok');
      refresh();
    },

    declineCancellation(jobId) {
      const c = sel.openCancellation(jobId);
      if (c) { c.status = 'DECLINED'; c.resolvedAt = nowISO(); }
      const job = sel.job(jobId);
      job.status = 'IN_PROGRESS';
      job.pausedReason = null;
      log(jobId, null, 'Garage', 'CANCEL_DECLINED', 'Garage declined the cancellation request; work resumed.', null, null);
      toast('Cancellation declined — job resumed.', 'warn');
      refresh();
    },

    /* ---------- payments ---------- */
    recordPayment(invoiceId, amountCents, type, method) {
      const inv = sel.invoice(invoiceId);
      if (!inv || inv.kind !== 'TAX_INVOICE') { toast('Payments can only be taken against a tax invoice.', 'warn'); return; }

      const amount = Math.max(0, Math.min(Math.round(amountCents), inv.balance));
      if (!amount) { toast('Nothing left to pay on this invoice.', 'warn'); return; }

      const p = {
        id: uid('pay'), invoiceId, no: 'PAY-' + counters.pay++,
        amount, type: type || 'STANDARD', method: method || 'CARD',
        status: 'SUCCEEDED', paidAt: nowISO(),
      };
      S.payments.push(p);

      S.receipts.push({
        id: uid('rec'), paymentId: p.id, no: 'RCP-' + counters.rec++,
        issuedAt: nowISO(), emailedTo: sel.job(inv.jobId).customerEmail,
      });

      syncInvoice(inv);

      const job = sel.job(inv.jobId);
      if (job.status === 'AWAITING_DEPOSIT' && inv.amountPaid >= inv.depositRequired) {
        job.status = 'IN_PROGRESS';
        job.pausedReason = null;
        log(job.id, null, 'System', 'WORK_STARTED', 'Deposit received — work commenced.', null, null);
      }
      if (inv.balance === 0) {
        log(job.id, null, 'System', 'HOLD_RELEASED', 'Balance cleared — Vehicle Hold removed. Keys may be released.', null, null);
      }

      const rc = sel.receiptForPayment(p.id);
      log(inv.jobId, null, 'System', 'PAYMENT_RECEIVED',
        `${p.no} · ${money(amount)} (${type}). Receipt ${rc.no} emailed to ${rc.emailedTo}.`, null, amount);
      toast(`Payment recorded — receipt ${rc.no} emailed.`, 'ok');
      refresh();
    },

    /* ---------- refunds ---------- */
    requestRefund(paymentId, amountCents, reason) {
      const p = sel.payment(paymentId);
      const inv = sel.invoice(p.invoiceId);
      const already = S.refunds
        .filter((r) => r.paymentId === paymentId && ['REQUESTED', 'PROCESSING', 'COMPLETED'].includes(r.status))
        .reduce((s, r) => s + r.amount, 0);
      const amount = Math.max(0, Math.min(Math.round(amountCents), p.amount - already));
      if (!amount) { toast('This payment has no refundable amount left.', 'warn'); return; }

      const r = {
        id: uid('ref'), invoiceId: p.invoiceId, paymentId, amount,
        type: amount >= p.amount ? 'FULL' : 'PARTIAL',
        reason: reason || 'Not specified',
        status: 'REQUESTED', requestedBy: 'Customer',
        createdAt: nowISO(), decidedAt: null, creditNoteId: null,
      };
      S.refunds.push(r);
      log(inv.jobId, null, 'Customer', 'REFUND_REQUEST',
        `${r.type} refund of ${money(amount)} requested against ${p.no}. Reason: ${r.reason}`, null, amount);
      toast('Refund requested — garage must approve.', 'warn');
      refresh();
    },

    decideRefund(refundId, approve) {
      const r = S.refunds.find((x) => x.id === refundId);
      const inv = sel.invoice(r.invoiceId);
      r.decidedAt = nowISO();
      if (approve) {
        r.status = 'PROCESSING';
        log(inv.jobId, null, 'Garage', 'REFUND_APPROVED', `${money(r.amount)} refund approved — processing.`, null, r.amount);
        toast('Refund approved — now processing.', 'ok');
      } else {
        r.status = 'DECLINED';
        log(inv.jobId, null, 'Garage', 'REFUND_DECLINED', 'Refund request declined.', null, r.amount);
        toast('Refund declined.', 'danger');
      }
      refresh();
    },

    issueRefund(paymentId, amountCents, reason) {
      const p = sel.payment(paymentId);
      const inv = sel.invoice(p.invoiceId);
      const amount = Math.max(0, Math.min(Math.round(amountCents), p.amount));
      if (!amount) return;
      const r = {
        id: uid('ref'), invoiceId: p.invoiceId, paymentId, amount,
        type: amount >= p.amount ? 'FULL' : 'PARTIAL',
        reason: reason || 'Issued by garage',
        status: 'COMPLETED', requestedBy: 'Garage',
        createdAt: nowISO(), decidedAt: nowISO(), creditNoteId: null,
      };
      S.refunds.push(r);
      log(inv.jobId, null, 'Garage', 'REFUND_ISSUED', `${r.type} refund of ${money(amount)} issued proactively against ${p.no}.`, null, amount);
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
      if (!inv) { toast('Generate the invoice first — fees are billed on it.', 'warn'); return; }
      const n = Math.max(1, Number(days) || 1);
      const rate = S.settings.storageDailyRate;
      inv.lines.push(setLineTax({
        id: uid('ln'), quoteId: null, quoteType: 'FEE',
        description: `Daily storage fee (${n} day${n > 1 ? 's' : ''} @ ${money(rate)}/day)`,
        qty: n, unitPrice: rate, isAddon: false,
      }, null));
      syncInvoice(inv);
      S.storage.push({ id: uid('st'), jobId, invoiceId: inv.id, days: n, rate, amount: n * rate, at: nowISO() });
      log(jobId, null, 'Garage', 'STORAGE_FEE', `${n} day(s) of storage added to ${inv.no} — ${money(n * rate)}.`, null, n * rate);
      toast(`Storage fee added to ${inv.no}.`, 'ok');
      refresh();
    },

    /* =====================================================
       TAX MANAGEMENT
       ===================================================== */
    saveTax(payload) {
      const value = payload.kind === 'PERCENT'
        ? Math.round(Number(payload.value) * 100)   // 8.00 -> 800
        : Math.round(Number(payload.value) * 100);  // $5.00 -> 500

      if (payload.id) {
        /* editing an active rate creates a NEW VERSION, never mutates history */
        const old = taxById(payload.id);
        if (!old) return;
        const newId = uid('tax');
        old.active = false;
        old.effectiveTo = nowISO();
        old.supersededBy = newId;
        S.taxes.push({
          id: newId, code: old.code, name: payload.name || old.name,
          kind: payload.kind, value, inclusive: !!payload.inclusive,
          appliesTo: payload.appliesTo || [], effectiveFrom: nowISO(),
          effectiveTo: null, active: true, supersededBy: null,
        });
        log(S.jobId, null, 'Garage', 'TAX_VERSION',
          `${old.code} re-rated to ${payload.kind === 'PERCENT' ? (value / 100).toFixed(2) + '%' : money(value) + '/unit'}. Old rate kept for existing documents.`, null, null);
        toast(`${old.code} updated — existing documents keep the old rate.`, 'ok');
      } else {
        const code = (payload.code || '').trim().toUpperCase();
        if (!code) { toast('A tax code is required.', 'warn'); return; }
        S.taxes.push({
          id: uid('tax'), code, name: payload.name || code,
          kind: payload.kind, value, inclusive: !!payload.inclusive,
          appliesTo: payload.appliesTo || [], effectiveFrom: nowISO(),
          effectiveTo: null, active: true, supersededBy: null,
        });
        log(S.jobId, null, 'Garage', 'TAX_CREATED', `Tax ${code} created.`, null, null);
        toast(`Tax ${code} created.`, 'ok');
      }
      refresh();
    },

    deactivateTax(taxId) {
      const t = taxById(taxId);
      if (!t) return;
      t.active = false;
      t.effectiveTo = nowISO();
      log(S.jobId, null, 'Garage', 'TAX_DEACTIVATED', `Tax ${t.code} deactivated — not offered on new lines.`, null, null);
      toast(`Tax ${t.code} deactivated.`, 'ok');
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
        svc.category = payload.category || 'General';
        svc.price = price;
        svc.taxCode = payload.taxCode;
        toast('Service updated.', 'ok');
      } else {
        S.services.push({
          id: uid('svc'), name: payload.name,
          category: payload.category || 'General',
          price, taxCode: payload.taxCode, unit: 'job',
        });
        toast('Service added to the catalog.', 'ok');
      }
      refresh();
    },

    removeService(serviceId) {
      S.services = S.services.filter((s) => s.id !== serviceId);
      toast('Service removed from the catalog.', 'warn');
      refresh();
    },
  };

  function completeRefundRecord(r) {
    const inv = sel.invoice(r.invoiceId);
    const p = sel.payment(r.paymentId);

    r.status = 'COMPLETED';

    const cn = {
      id: uid('cn'), invoiceId: inv.id, refundId: r.id,
      no: 'CN-' + counters.cn++, amount: r.amount,
      reason: r.reason, issuedAt: nowISO(),
    };
    S.creditNotes.push(cn);
    r.creditNoteId = cn.id;

    const refundedOnPayment = S.refunds
      .filter((x) => x.paymentId === p.id && x.status === 'COMPLETED')
      .reduce((s, x) => s + x.amount, 0);
    p.status = refundedOnPayment >= p.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    syncInvoice(inv);
    log(inv.jobId, null, 'System', 'CREDIT_NOTE',
      `Credit note ${cn.no} issued for ${money(r.amount)} against ${inv.no}. Payment ${p.no} now ${p.status.replace('_', ' ').toLowerCase()}.`, null, r.amount);
    toast(`Refund completed — credit note ${cn.no} generated.`, 'ok');
  }

  /* =========================================================
     BOOT
     ========================================================= */
  seed();

  global.Store = {
    S, sel, money, fmtDateTime, fmtDay, uid, nowISO, addDays,
    quoteTotals, docTotals, lineMath, lineTotal, depositFor, syncInvoice,
    activeTaxes, taxById, taxByCode, defaultTaxFor, taxLabel, taxRateLabel, setLineTax,
    buildLines, invoiceNeedsUpdate,
    actions, seed,
  };
})(window);
