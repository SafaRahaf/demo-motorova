/* =========================================================
   app.js — event delegation, modals, toasts.
   ========================================================= */
(function (global) {
  "use strict";

  const St = global.Store;
  const {
    S,
    sel,
    money,
    actions,
    fmtDateTime,
    fmtDay,
    activeTaxes,
    taxById,
    taxRateLabel,
    docTotals,
  } = St;
  const Views = global.Views;

  /*
     Wrap a rendered document in a minimal, self-contained HTML page.
     Inlined CSS means the downloaded file and the print window look identical
     without loading css/app.css — no relative paths, no network.
  */
  function printablePage(bodyHtml, title) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root{--ink:#0f172a;--muted:#6b7788;--line:#e2e7ef;}
  *{box-sizing:border-box}
  body{margin:0;padding:32px;font:13px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff;max-width:820px;margin:0 auto;position:relative}
  .num{text-align:right;white-space:nowrap}
  .d-mono{font-family:ui-monospace,Menlo,monospace}
  .d-head{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid var(--ink);padding-bottom:14px}
  .d-garage{font-size:18px;font-weight:800;letter-spacing:-.01em}
  .d-meta{text-align:right}
  .d-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .d-no{font-size:17px;font-weight:800;font-family:ui-monospace,Menlo,monospace}
  .d-muted{color:var(--muted);font-size:12px}
  .d-parties{display:flex;gap:40px;padding:18px 0;border-bottom:1px solid var(--line)}
  .d-table{width:100%;border-collapse:collapse;margin:18px 0}
  .d-table th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--ink);padding:7px 8px}
  .d-table td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
  .d-tag{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--muted)}
  .d-tag--tax{background:#f4f6fa}
  .d-totals{display:flex;justify-content:flex-end}
  .d-totals table{border-collapse:collapse;min-width:320px}
  .d-totals td{padding:5px 8px}
  .d-totals td.num{text-align:right;white-space:nowrap}
  .d-major td{border-top:1px solid var(--ink);font-weight:800;font-size:14px}
  .d-section td{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:12px}
  .d-due td{border-top:2px solid var(--ink);font-weight:800;font-size:15px;padding-top:8px}
  .d-note{margin-top:18px;padding:10px 12px;background:#f7f9fc;border-left:3px solid var(--line);font-size:12px}
  .d-foot{margin-top:28px;padding-top:12px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
  .d-void-mark{position:fixed;top:42%;left:50%;transform:translate(-50%,-50%) rotate(-24deg);font-size:90px;font-weight:900;letter-spacing:.1em;color:rgba(192,38,38,.13);border:8px solid rgba(192,38,38,.13);border-radius:12px;padding:8px 32px;pointer-events:none;z-index:9}
  @media print{body{padding:0}.d-void-mark{position:fixed}}
  @page{margin:16mm}
</style></head>
<body>${bodyHtml}</body></html>`;
  }

  /* ---------------- toast ---------------- */
  function toast(msg, kind) {
    const wrap = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " toast--" + kind : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .25s, transform .25s";
      el.style.opacity = "0";
      el.style.transform = "translateX(12px)";
      setTimeout(() => el.remove(), 260);
    }, 3400);
  }

  /* ---------------- modal ---------------- */
  function openModal(opts) {
    const el = document.getElementById("modal");
    el.hidden = false;
    el.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h3>${opts.title}</h3>
            ${opts.subtitle ? `<p class="modal-sub">${opts.subtitle}</p>` : ""}
          </div>
          <button type="button" class="icon-btn" data-act="closeModal">&#10005;</button>
        </div>
        <form class="modal-body" id="modalForm">
          ${opts.body}
          <div class="modal-foot">
            <button type="button" class="btn btn--ghost" data-act="closeModal">Cancel</button>
            <button type="submit" class="btn ${opts.danger ? "btn--danger" : "btn--primary"}">${opts.submitLabel || "Confirm"}</button>
          </div>
        </form>
      </div>`;

    const form = el.querySelector("#modalForm");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const keepOpen = opts.onSubmit(new FormData(form), form);
      if (keepOpen !== true) closeModal();
    });

    const first = form.querySelector("input, select, textarea");
    if (first) first.focus();
  }

  function closeModal() {
    const el = document.getElementById("modal");
    el.hidden = true;
    el.innerHTML = "";
  }

  /* ---------------- tax option markup ---------------- */
  const taxSelectOptions = (selectedCode) =>
    activeTaxes()
      .map(
        (t) =>
          `<option value="${t.code}" ${t.code === selectedCode ? "selected" : ""}>${t.code} · ${taxRateLabel(t)}</option>`,
      )
      .join("");

  /* ---------------- handlers ---------------- */
  const handlers = {
    /* navigation */
    screen: (id) => actions.setScreen(id),
    job: (id) => actions.selectJob(id),
    tab: (id) => actions.setTab(id),
    reset: () => {
      actions.reset();
      toast("Demo reset to seed data.", "ok");
    },
    closeModal: () => closeModal(),

    /* quote builder */
    openBuilder: (id) => actions.openBuilder(id),
    closeBuilder: () => actions.closeBuilder(),
    builderCat: (id) => actions.builderCat(id),
    builderAddService: (id) => actions.builderAddService(id),
    builderBlank: () => actions.builderBlankLine(),
    builderRemove: (id) => actions.builderRemoveItem(id),
    builderSaveDraft: () => actions.builderSaveDraft(),
    builderSend: () => actions.builderSend(),

    builderNewService: (quoteId) => {
      openModal({
        title: "Create a service",
        subtitle:
          "Adds it to the catalog and drops it straight into this quote.",
        body: `
          <div class="field">
            <label>Service name</label>
            <input name="name" placeholder="e.g. Diesel injector clean" required>
          </div>
          <div class="field">
            <label>Category</label>
            <input name="category" placeholder="e.g. Maintenance" required>
          </div>
          <div class="field">
            <label>Price (USD)</label>
            <input name="price" type="number" step="0.01" min="0" value="75.00" required>
          </div>
          <div class="field">
            <label>Default tax</label>
            <select name="taxCode">${taxSelectOptions(null)}</select>
          </div>`,
        submitLabel: "Create & add",
        onSubmit: (fd) => {
          if (!String(fd.get("name") || "").trim()) {
            toast("A name is required.", "warn");
            return true;
          }
          actions.builderCreateService({
            name: fd.get("name"),
            category: fd.get("category"),
            price: fd.get("price"),
            taxCode: fd.get("taxCode"),
          });
        },
      });
    },

    /* quote lifecycle */
    editQuote: (id) => actions.startEdit(id),
    cancelEdit: () => actions.cancelEdit(),
    addItem: (id) => actions.addItem(id),
    removeItem: (id, el) => actions.removeItem(id, el.dataset.item),
    toggleDependency: (id) => actions.toggleDependency(id),
    saveQuote: (id) => {
      actions.saveEdit(id);
      closeModal();
    },
    sendQuote: (id) => actions.sendQuote(id),
    acceptQuote: (id) => actions.acceptQuote(id),
    rejectQuote: (id) => actions.rejectQuote(id),

    addCondition: (id) => {
      openModal({
        title: "Add a condition",
        subtitle:
          "Terms attached to this quote. Visible to both parties and logged in the audit trail.",
        body: `<div class="field">
                 <label>Condition</label>
                 <textarea name="text" placeholder="e.g. Must use OEM parts only." required></textarea>
               </div>`,
        submitLabel: "Add condition",
        onSubmit: (fd) => {
          actions.addCondition(id, fd.get("text"));
        },
      });
    },

    /* ---------- service catalog picker ---------- */
    servicePicker: (quoteId) => {
      const q = sel.quote(quoteId);
      if (!q) return;
      const cats = [...new Set(S.services.map((s) => s.category))];

      const body = cats
        .map(
          (cat) => `
        <div class="picker__group">
          <div class="picker__cat">${cat}</div>
          ${S.services
            .filter((s) => s.category === cat)
            .map(
              (s) => `
            <label class="picker__row">
              <input type="checkbox" name="svc" value="${s.id}">
              <span class="picker__name">${s.name}</span>
              <span class="picker__price">${money(s.price)}</span>
              <span class="taxchip">${s.taxCode || "none"}</span>
            </label>`,
            )
            .join("")}
        </div>`,
        )
        .join("");

      openModal({
        title: "Add services to the quote",
        subtitle: `Quote ${q.no} · prices and taxes come from the catalog and stay editable afterwards.`,
        body: `<div class="picker">${body}</div>`,
        submitLabel: "Add selected",
        onSubmit: (fd) => {
          const ids = fd.getAll("svc");
          if (!ids.length) {
            toast("Select at least one service.", "warn");
            return true;
          }
          actions.addServices(quoteId, ids);
        },
      });
    },

    /* ---------- documents ---------- */
    generateProforma: (id) => actions.generateProforma(id),
    generateInvoice: (id) => actions.generateInvoices(id),

    /*
       "Generate" — confirm first, and list exactly what will be created so the
       garage never bulk-issues documents blind.
    */
    generateInvoices: (jobId) => {
      const pending = sel.uninvoicedQuotes(jobId);
      if (!pending.length) {
        toast("Nothing new to invoice.", "warn");
        return;
      }
      const total = pending.reduce((s, q) => s + Store.quoteTotals(q).total, 0);
      openModal({
        title: "Generate invoice",
        subtitle:
          "Only the accepted work listed below is billed. Existing live invoices are not changed.",
        body: `
          <table class="table table--compact">
            <thead><tr><th>Quote</th><th>Type</th><th class="num">Amount</th></tr></thead>
            <tbody>
              ${pending
                .map(
                  (q) => `<tr>
                  <td class="mono">${q.no}</td>
                  <td class="sub">${q.type}</td>
                  <td class="num"><b>${money(Store.quoteTotals(q).total)}</b></td>
                </tr>`,
                )
                .join("")}
            </tbody>
            <tfoot><tr><td colspan="2"><b>Total to invoice</b></td><td class="num"><b>${money(total)}</b></td></tr></tfoot>
          </table>
          <div class="banner banner--info" style="margin-top:12px">
            <span class="banner__icon">&#8505;</span>
            <div>One tax invoice is issued per quote. Nothing that already carries a payment is voided or rewritten.</div>
          </div>`,
        submitLabel: "Generate",
        onSubmit: () => {
          actions.generateInvoices(jobId);
        },
      });
    },

    /*
       "Combine" — the one action that voids. Spell out the consequences and the
       money that will be carried forward before it happens.
    */
    combinedModal: (jobId) => {
      const live = sel
        .liveInvoices(jobId)
        .filter((i) => i.kind === "TAX_INVOICE");
      if (live.length < 2) {
        toast("At least two live invoices are needed to combine.", "warn");
        return;
      }
      const totals = sel.jobTotals(jobId);
      const carried = live.reduce((s, i) => s + i.amountPaid, 0);
      openModal({
        title: "Generate combined invoice",
        subtitle:
          "Merges every live invoice into one document and voids the originals.",
        body: `
          <table class="table table--compact">
            <thead><tr><th>Will be voided</th><th class="num">Total</th><th class="num">Paid</th></tr></thead>
            <tbody>
              ${live
                .map(
                  (i) => `<tr>
                  <td class="mono">${i.no}</td>
                  <td class="num">${money(i.total)}</td>
                  <td class="num">${money(i.amountPaid)}</td>
                </tr>`,
                )
                .join("")}
            </tbody>
          </table>
          <table class="table table--compact" style="margin-top:10px">
            <tbody>
              <tr><td>Combined total</td><td class="num"><b>${money(totals.total)}</b></td></tr>
              <tr><td>Paid carried forward</td><td class="num">&minus;${money(carried)}</td></tr>
              <tr><td><b>Remaining to pay</b></td><td class="num"><b>${money(totals.balance)}</b></td></tr>
            </tbody>
          </table>
          <div class="banner banner--warn" style="margin-top:12px">
            <span class="banner__icon">&#9888;</span>
            <div>The ${live.length} invoices above become <b>void</b> — they stay readable and are never deleted.
            A single new invoice is issued showing <b>paid on consolidated invoices</b> so the history still adds up.</div>
          </div>`,
        submitLabel: "Combine &amp; void originals",
        danger: true,
        onSubmit: () => {
          actions.generateCombinedInvoice(jobId);
        },
      });
    },

    /*
       Download a document. Two dependency-free options, both rendered by the
       same `Views.printableDoc()` so the file and the printout always match:
         · Print / Save as PDF — opens a print window with only the document
         · Download .html      — saves a self-contained file with the styling
    */
    downloadDoc: (invId) => {
      const inv = sel.invoice(invId);
      if (!inv) return;
      const job = sel.job(inv.jobId);
      const slug = `${inv.no}-${(job.vehicle.plate || "vehicle").replace(/[^A-Za-z0-9]/g, "")}`;
      openModal({
        title: "Download " + inv.no,
        subtitle: `${job.jobNo} · ${job.customerName} · ${money(inv.total)}${inv.status === "VOID" ? " · VOID" : ""}`,
        body: `
          <div class="row">
            <button type="button" class="btn btn--primary" data-act="printDoc" data-id="${inv.id}">Print / Save as PDF</button>
            <button type="button" class="btn btn--ghost" data-act="saveHtmlDoc" data-id="${inv.id}">Download .html</button>
          </div>
          <div class="banner banner--info" style="margin-top:14px">
            <span class="banner__icon">&#8505;</span>
            <div>Both produce the same layout: garage, customer, vehicle, line items, tax breakdown,
            receipts and the remaining balance — with no app navigation around it.</div>
          </div>
          <div class="field" style="margin-top:12px">
            <label>File name</label>
            <input name="filename" value="${slug}" readonly>
          </div>`,
        submitLabel: "Close",
        onSubmit: () => {},
      });
    },

    printDoc: (invId) => {
      const inv = sel.invoice(invId);
      if (!inv) return;
      const w = global.open("", "_blank", "width=900,height=1000");
      if (!w) {
        toast("Pop-up blocked — allow pop-ups to print the invoice.", "warn");
        return;
      }
      w.document.write(
        printablePage(
          Views.printableDoc(inv),
          `${inv.no} — ${sel.job(inv.jobId).garageName}`,
        ),
      );
      w.document.close();
      setTimeout(() => {
        w.focus();
        w.print();
      }, 250);
    },

    saveHtmlDoc: (invId) => {
      const inv = sel.invoice(invId);
      if (!inv) return;
      const job = sel.job(inv.jobId);
      const name = `${inv.no}-${(job.vehicle.plate || "vehicle").replace(/[^A-Za-z0-9]/g, "")}.html`;
      const html = printablePage(
        Views.printableDoc(inv),
        `${inv.no} — ${job.garageName}`,
      );
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`${name} downloaded.`, "ok");
    },

    /* "Combine with payments" — confirm, then move money onto one document. */
    combinedPaymentsModal: (jobId) => {
      const live = sel
        .liveInvoices(jobId)
        .filter((i) => i.kind === "TAX_INVOICE");
      const receipts = live.flatMap((i) =>
        sel.receiptsForInvoice(i.id).filter((r) => r.status === "VALID"),
      );
      if (!receipts.length) {
        toast("There are no payments to consolidate.", "warn");
        return;
      }
      const totals = sel.jobTotals(jobId);
      openModal({
        title: "Combine invoices & payments",
        subtitle:
          "Money moves onto one document and the receipts are replaced by a single consolidated receipt.",
        body: `
          <table class="table table--compact">
            <thead><tr><th>Invoice</th><th class="num">Total</th><th>Receipts to void</th></tr></thead>
            <tbody>
              ${live
                .map(
                  (i) => `<tr>
                <td class="mono">${i.no}</td>
                <td class="num">${money(i.total)}</td>
                <td class="sub">${
                  sel
                    .receiptsForInvoice(i.id)
                    .filter((r) => r.status === "VALID")
                    .map((r) => r.no)
                    .join(", ") || "—"
                }</td>
              </tr>`,
                )
                .join("")}
            </tbody>
          </table>
          <table class="table table--compact" style="margin-top:10px">
            <tbody>
              <tr><td>Combined total</td><td class="num"><b>${money(totals.total)}</b></td></tr>
              <tr><td>Payments moved (${receipts.length} receipts)</td><td class="num">&minus;${money(totals.paid)}</td></tr>
              <tr><td><b>Remaining to pay</b></td><td class="num"><b>${money(totals.balance)}</b></td></tr>
            </tbody>
          </table>
          <div class="banner banner--warn" style="margin-top:12px">
            <span class="banner__icon">&#9888;</span>
            <div>The ${receipts.length} receipts above become <b>void</b> and are shown struck through on the new invoice.
            One <b>valid consolidated receipt</b> is issued for ${money(totals.paid)}, so the customer keeps proof of payment.</div>
          </div>`,
        submitLabel: "Combine &amp; consolidate",
        danger: true,
        onSubmit: () => {
          actions.combineInvoicesWithPayments(jobId);
        },
      });
    },

    receiptModal: (recId) => {
      const rc = sel.receipt(recId);
      openModal({
        title: "Receipt " + rc.no,
        subtitle:
          rc.status === "VOID"
            ? "Void — replaced by a consolidated receipt."
            : "Proof of payment, not an invoice.",
        body: `<div class="banner banner--info"><span class="banner__icon">&#8505;</span>
                 <div><b>${money(rc.amount || 0)}</b> received · paid to date ${money(rc.paidToDate || 0)} · balance ${money(rc.balanceAfter || 0)}</div>
               </div>
               <button type="button" class="btn btn--ghost btn--sm" data-act="printReceipt" data-id="${rc.id}">Print / Save as PDF</button>`,
        submitLabel: "Close",
        onSubmit: () => {},
      });
    },

    printReceipt: (recId) => {
      const rc = sel.receipt(recId);
      if (!rc) return;
      const inv = sel.invoice(rc.invoiceId);
      const job = sel.job(rc.jobId);
      const w = global.open("", "_blank", "width=700,height=800");
      if (!w) {
        toast("Pop-up blocked — allow pop-ups to print the receipt.", "warn");
        return;
      }
      w.document.write(
        printablePage(
          `<header class="d-head"><div><div class="d-garage">${job.garageName}</div>
             <div class="d-muted">${job.jobNo}</div></div>
             <div class="d-meta"><div class="d-label">Receipt</div><div class="d-no">${rc.no}</div>
             <div class="d-muted">${rc.status === "VOID" ? "VOID" : "Issued " + fmtDay(rc.issuedAt)}</div></div></header>
           <section class="d-parties"><div><div class="d-label">Received from</div><b>${job.customerName}</b></div>
             <div><div class="d-label">Against</div><b>${inv ? inv.no : "—"}</b></div></section>
           <section class="d-totals"><table>
             <tr><td>Amount received</td><td class="num"><b>${money(rc.amount || 0)}</b></td></tr>
             <tr><td>Method</td><td class="num">${rc.method || "—"}</td></tr>
             <tr><td>Paid to date</td><td class="num">${money(rc.paidToDate || 0)}</td></tr>
             <tr class="d-due"><td>Balance after</td><td class="num">${money(rc.balanceAfter || 0)}</td></tr>
           </table></section>
           <footer class="d-foot">Emailed to ${rc.emailedTo || "—"} · ${fmtDateTime(rc.issuedAt)}</footer>`,
          `${rc.no} — ${job.garageName}`,
        ),
      );
      w.document.close();
      setTimeout(() => {
        w.focus();
        w.print();
      }, 250);
    },

    toggleReissue: () => {
      S.settings.reissueInvoiceOnPayment = !S.settings.reissueInvoiceOnPayment;
      toast(
        S.settings.reissueInvoiceOnPayment
          ? "Each payment will now void the previous invoice and issue a new version."
          : "Payments will now build up on the current invoice.",
        "ok",
      );
      global.App.render();
    },

    voidInvoiceModal: (invId) => {
      const inv = sel.invoice(invId);
      if (!inv) return;
      openModal({
        title: `Void ${inv.no}`,
        subtitle:
          "The document is kept on the job and marked void. No live invoice is left, so the job returns to Awaiting Invoice until you issue a replacement.",
        danger: true,
        body: `
          <div class="field">
            <label>Why is this invoice void?</label>
            <textarea name="reason" placeholder="e.g. Raised against the wrong quote." required></textarea>
            <div class="field__hint">Written to the document and to the audit trail. Never editable afterwards.</div>
          </div>
          <div class="banner banner--warn" style="margin:0">
            <span class="banner__icon">&#9888;</span>
            <div>Voiding is only allowed while <b>nothing has been paid</b> on the invoice. Once money has
            moved, recording a payment replaces the document with a new version instead — paid paper is
            never voided.</div>
          </div>`,
        submitLabel: "Void invoice",
        onSubmit: (fd) => actions.voidInvoice(invId, fd.get("reason")),
      });
    },

    /* new quote variants */
    createGarageQuote: (id) => actions.createGarageQuote(id),
    newSupplementary: (id) => actions.createSupplementary(id),
    newWarranty: (id) => actions.createWarranty(id),

    /* cancellation + settlement */
    cancelModal: (id) => {
      openModal({
        title: "Request cancellation",
        subtitle:
          "The job pauses immediately and the garage will issue a settlement quote for work already done.",
        danger: true,
        body: `<div class="field">
                 <label>Why are you cancelling?</label>
                 <textarea name="reason" placeholder="e.g. Selling the vehicle / found another garage." required></textarea>
               </div>`,
        submitLabel: "Pause job &amp; request",
        onSubmit: (fd) => actions.requestCancellation(id, fd.get("reason")),
      });
    },

    declineCancel: (id) => actions.declineCancellation(id),

    settlementModal: (id) => {
      const job = sel.job(id);
      const orig = sel.stdQuote(id);
      const pkg = orig ? orig.items.filter((i) => i.packageRef) : [];

      openModal({
        title: "Create settlement quote",
        subtitle:
          "Charge only for work completed before the cancellation. This becomes a normal negotiable quote.",
        body: `
          <div class="field">
            <label>Labour hours completed</label>
            <input name="hours" type="number" step="0.25" min="0" value="2.5" required>
            <div class="field__hint">Billed at $95.00 / hour, prorated.</div>
          </div>
          <div class="field">
            <label>Restocking fee (USD)</label>
            <input name="restock" type="number" step="0.01" min="0" value="45.00">
            <div class="field__hint">For parts already ordered that must go back to the supplier.</div>
          </div>
          ${
            pkg.length
              ? `
          <label class="checkline">
            <input type="checkbox" name="unbundle" checked>
            <span><b>Unbundle the service package.</b> Replace the discounted package price with the
            standalone rate for each completed service (${pkg.length} services in this bundle).</span>
          </label>`
              : ""
          }
          <div class="banner banner--info" style="margin:6px 0 0">
            <span class="banner__icon">&#8505;</span>
            <div>Parts already installed come from the original quote. Accepting the settlement
            replaces the original billing on ${job.jobNo}.</div>
          </div>`,
        submitLabel: "Send settlement quote",
        onSubmit: (fd) => {
          actions.createSettlement(id, {
            hours: fd.get("hours"),
            restock: fd.get("restock"),
            unbundle: fd.get("unbundle") === "on",
          });
        },
      });
    },

    /* money */
    payModal: (invId) => {
      const inv = sel.invoice(invId);
      if (!inv) return;
      const depOutstanding = Math.max(0, inv.depositRequired - inv.amountPaid);
      const defaultAmount = depOutstanding > 0 ? depOutstanding : inv.balance;
      const defaultType = depOutstanding > 0 ? "DEPOSIT" : "STANDARD";

      openModal({
        title: depOutstanding > 0 ? "Collect deposit" : "Record payment",
        subtitle: `Invoice ${inv.no} · remaining balance ${money(inv.balance)}`,
        body: `
          <div class="field">
            <label>Amount (USD)</label>
            <input name="amount" type="number" step="0.01" min="0" max="${(inv.balance / 100).toFixed(2)}"
                   value="${(defaultAmount / 100).toFixed(2)}" required>
          </div>
          <div class="field">
            <label>Payment type</label>
            <select name="type">
              <option value="DEPOSIT" ${defaultType === "DEPOSIT" ? "selected" : ""}>Upfront deposit</option>
              <option value="STANDARD" ${defaultType === "STANDARD" ? "selected" : ""}>Standard payment (balance on completion)</option>
              <option value="MILESTONE">Milestone payment (mid-job)</option>
            </select>
          </div>
          <div class="field">
            <label>Method</label>
            <select name="method">
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CASH">Cash</option>
              <option value="ONLINE">Online gateway</option>
            </select>
          </div>
          <div class="banner banner--ok" style="margin:0">
            <span class="banner__icon">&#9993;</span>
            <div>A receipt is generated and emailed the moment this payment is marked successful.</div>
          </div>`,
        submitLabel: "Mark as paid",
        onSubmit: (fd) => {
          actions.recordPayment(
            invId,
            Math.round(Number(fd.get("amount")) * 100),
            fd.get("type"),
            fd.get("method"),
          );
        },
      });
    },

    receiptModal: (recId) => {
      const rc = sel.receipt(recId);
      const p = sel.payment(rc.paymentId);
      const inv = sel.invoice(p.invoiceId);
      const job = sel.job(inv.jobId);
      const next = rc.supersededBy ? sel.receipt(rc.supersededBy) : null;
      openModal({
        title: "Receipt " + rc.no,
        subtitle:
          rc.status === "VOID"
            ? "Void — a later payment on this job replaced it. Kept for the audit trail."
            : "Auto-generated on successful payment.",
        body: `
          ${
            rc.status === "VOID"
              ? `<div class="banner banner--warn" style="margin-bottom:12px">
                   <span class="banner__icon">&#9888;</span>
                   <div><b>Void receipt.</b> ${next ? `Replaced by <b>${next.no}</b> ` : ""}It shows the balance
                   as it stood at that moment and must not be used as proof of current payment.</div>
                 </div>`
              : ""
          }
          <div class="doc__parties" style="margin-bottom:14px">
            <div><span class="doc__label">Received from</span><div><b>${job.customerName}</b><br>${job.customerEmail}</div></div>
            <div><span class="doc__label">Against</span><div><b>${inv.no}</b><br>${job.jobNo}</div></div>
          </div>
          <table class="table table--compact">
            <tbody>
              <tr><td>Status</td><td class="num"><b>${rc.status === "VOID" ? "Void" : "Valid"}</b></td></tr>
              <tr><td>Payment</td><td class="num mono">${p.no}</td></tr>
              <tr><td>Type</td><td class="num">${p.type} · ${p.method}</td></tr>
              <tr><td>Amount</td><td class="num"><b>${money(p.amount)}</b></td></tr>
              <tr><td>Paid at</td><td class="num">${fmtDateTime(p.paidAt)}</td></tr>
              <tr><td>Paid to date on this receipt</td><td class="num">${money(rc.paidToDate || 0)}</td></tr>
              <tr><td>Balance after this payment</td><td class="num">${money(rc.balanceAfter || 0)}</td></tr>
            </tbody>
          </table>
          <div class="banner banner--info" style="margin-top:14px">
            <span class="banner__icon">&#9993;</span>
            <div>Emailed to <b>${rc.emailedTo}</b> on ${fmtDateTime(rc.issuedAt)}.</div>
          </div>`,
        submitLabel: "Close",
        onSubmit: () => {},
      });
    },

    storageModal: (jobId) => {
      openModal({
        title: "Add daily storage fee",
        subtitle: `Vehicle uncollected or job paused. Rate: ${money(S.settings.storageDailyRate)} / day.`,
        body: `<div class="field">
                 <label>Number of days</label>
                 <input name="days" type="number" min="1" step="1" value="4" required>
                 <div class="field__hint">Appended to the current invoice as a non-taxable fee line.</div>
               </div>`,
        submitLabel: "Append fee",
        onSubmit: (fd) => actions.addStorageFee(jobId, fd.get("days")),
      });
    },

    /* refunds */
    refundRequestModal: (paymentId) => {
      const p = sel.payment(paymentId);
      openModal({
        title: "Request a refund",
        subtitle: `Payment ${p.no} · ${money(p.amount)} · full or partial`,
        body: `
          <div class="field">
            <label>Amount to refund (USD)</label>
            <input name="amount" type="number" step="0.01" min="0" max="${(p.amount / 100).toFixed(2)}"
                   value="${(p.amount / 100).toFixed(2)}" required>
          </div>
          <div class="field">
            <label>Reason</label>
            <textarea name="reason" placeholder="e.g. Work not carried out as agreed." required></textarea>
          </div>`,
        submitLabel: "Send request",
        onSubmit: (fd) =>
          actions.requestRefund(
            paymentId,
            Math.round(Number(fd.get("amount")) * 100),
            fd.get("reason"),
          ),
      });
    },

    refundIssueModal: (paymentId) => {
      const p = sel.payment(paymentId);
      openModal({
        title: "Issue refund (proactive)",
        subtitle: `Payment ${p.no} · ${money(p.amount)}. Issued immediately — a credit note is generated.`,
        body: `
          <div class="field">
            <label>Amount to refund (USD)</label>
            <input name="amount" type="number" step="0.01" min="0" max="${(p.amount / 100).toFixed(2)}"
                   value="${(p.amount / 100).toFixed(2)}" required>
          </div>
          <div class="field">
            <label>Reason</label>
            <textarea name="reason" placeholder="e.g. Goodwill refund for delay." required></textarea>
          </div>`,
        submitLabel: "Issue refund",
        danger: true,
        onSubmit: (fd) =>
          actions.issueRefund(
            paymentId,
            Math.round(Number(fd.get("amount")) * 100),
            fd.get("reason"),
          ),
      });
    },

    refundApprove: (id) => actions.decideRefund(id, true),
    refundDecline: (id) => actions.decideRefund(id, false),
    refundComplete: (id) => actions.completeRefund(id),

    /* ---------- taxes ---------- */
    taxModal: (taxId) => {
      const t = taxId ? taxById(taxId) : null;
      const kinds = ["LABOR", "PART", "SERVICE", "FEE"];
      const applies = (k) =>
        t && (t.appliesTo || []).includes(k) ? "checked" : "";

      openModal({
        title: t ? `Change rate — ${t.code}` : "New tax",
        subtitle: t
          ? "Saving closes this rate and opens a new version. Documents already issued keep the old rate."
          : "Fixed taxes are charged per unit. Percent taxes can be exclusive (added) or inclusive (already in the price).",
        body: `
          <div class="field">
            <label>Tax code</label>
            <input name="code" value="${t ? t.code : ""}" ${t ? "disabled" : ""} placeholder="e.g. VAT-STD" required>
            <div class="field__hint">Shown on every line it is applied to.</div>
          </div>
          <div class="field">
            <label>Name</label>
            <input name="name" value="${t ? t.name : ""}" placeholder="e.g. VAT (standard)" required>
          </div>
          <div class="field">
            <label>Type</label>
            <select name="kind" id="taxKind">
              <option value="PERCENT" ${t && t.kind === "PERCENT" ? "selected" : ""}>Percent (%)</option>
              <option value="FIXED" ${t && t.kind === "FIXED" ? "selected" : ""}>Fixed amount per unit</option>
            </select>
          </div>
          <div class="field">
            <label>Value</label>
            <input name="value" type="number" step="0.01" min="0"
                   value="${t ? (t.kind === "PERCENT" ? (t.value / 100).toFixed(2) : (t.value / 100).toFixed(2)) : "8.00"}" required>
            <div class="field__hint">Percent: 8 = 8.00%. Fixed: 5 = $5.00 per unit.</div>
          </div>
          <label class="checkline">
            <input type="checkbox" name="inclusive" ${t && t.inclusive ? "checked" : ""}>
            <span><b>Prices already include this tax</b> — the tax is extracted from the line price
            instead of being added on top. (Percent taxes only.)</span>
          </label>
          <div class="field">
            <label>Default for these line types</label>
            <div class="row" style="gap:14px">
              ${kinds
                .map(
                  (k) => `<label class="checkline" style="margin:0">
                <input type="checkbox" name="appliesTo" value="${k}" ${applies(k)}>
                <span>${k.charAt(0) + k.slice(1).toLowerCase()}</span></label>`,
                )
                .join("")}
            </div>
            <div class="field__hint">Leave all unticked to make this tax selectable only.</div>
          </div>`,
        submitLabel: t ? "Save as new version" : "Create tax",
        onSubmit: (fd) => {
          actions.saveTax({
            id: t ? t.id : null,
            code: t ? t.code : fd.get("code"),
            name: fd.get("name"),
            kind: fd.get("kind"),
            value: fd.get("value"),
            inclusive: fd.get("inclusive") === "on",
            appliesTo: fd.getAll("appliesTo"),
          });
        },
      });
    },

    taxDeactivate: (id) => actions.deactivateTax(id),

    /* ---------- service catalog ---------- */
    serviceModal: (serviceId) => {
      const s = serviceId ? sel.service(serviceId) : null;
      openModal({
        title: s ? "Edit service" : "New service",
        subtitle:
          "Default values used when this service is added to a quote. Everything stays editable on the quote.",
        body: `
          <div class="field">
            <label>Service name</label>
            <input name="name" value="${s ? s.name : ""}" placeholder="e.g. Oil & filter change" required>
          </div>
          <div class="field">
            <label>Category</label>
            <input name="category" value="${s ? s.category : ""}" placeholder="e.g. Maintenance" required>
          </div>
          <div class="field">
            <label>Default price (USD)</label>
            <input name="price" type="number" step="0.01" min="0"
                   value="${s ? (s.price / 100).toFixed(2) : "99.00"}" required>
          </div>
          <div class="field">
            <label>Default tax</label>
            <select name="taxCode">${taxSelectOptions(s ? s.taxCode : null)}</select>
          </div>`,
        submitLabel: s ? "Save service" : "Add service",
        onSubmit: (fd) => {
          actions.saveService({
            id: s ? s.id : null,
            name: fd.get("name"),
            category: fd.get("category"),
            price: fd.get("price"),
            taxCode: fd.get("taxCode"),
          });
        },
      });
    },

    serviceRemove: (id) => actions.removeService(id),

    /* new customer job */
    /*
       Garage-side job creation. Creates an empty job (customer + vehicle); the
       garage then opens the quote builder to price the work.
    */
    newGarageJob: () => {
      openModal({
        title: "New job",
        subtitle:
          "Records the customer and vehicle. Nothing is priced yet — the next step is a quote.",
        body: `
          <div class="field"><label>Customer name</label>
            <input name="customerName" placeholder="e.g. Dana Whitfield" required></div>
          <div class="field"><label>Customer email</label>
            <input name="customerEmail" type="email" placeholder="dana@example.com"></div>
          <div class="field"><label>Make</label>
            <input name="make" placeholder="Ford" required></div>
          <div class="field"><label>Model</label>
            <input name="model" placeholder="Focus" required></div>
          <div class="field"><label>Year</label>
            <input name="year" type="number" value="2018" min="1950" max="2100" required></div>
          <div class="field"><label>Plate</label>
            <input name="plate" placeholder="AB-1234" required></div>
          <div class="field"><label>Odometer (mi)</label>
            <input name="odometer" type="number" min="0" value="0"></div>
          <div class="field"><label>Reported complaint</label>
            <textarea name="complaint" placeholder="Grinding noise from the front when braking."></textarea></div>`,
        submitLabel: "Create job",
        onSubmit: (fd) => {
          const id = actions.createJob({
            customerName: fd.get("customerName"),
            customerEmail: fd.get("customerEmail"),
            make: fd.get("make"),
            model: fd.get("model"),
            year: fd.get("year"),
            plate: fd.get("plate"),
            odometer: fd.get("odometer"),
            complaint: fd.get("complaint"),
          });
          actions.selectJob(id);
        },
      });
    },

    /* customer-side request (unchanged flow) */
    newJob: () => {
      openModal({
        title: "New service request",
        subtitle:
          "You describe the problem and your budget — the garage answers with a quote.",
        body: `
          <div class="field"><label>Make</label><input name="make" placeholder="Ford" required></div>
          <div class="field"><label>Model</label><input name="model" placeholder="Focus" required></div>
          <div class="field"><label>Year</label><input name="year" type="number" value="2018" min="1950" max="2100" required></div>
          <div class="field"><label>Plate</label><input name="plate" placeholder="AB-1234" required></div>
          <div class="field"><label>What needs doing?</label>
            <textarea name="desc" placeholder="Grinding noise from the front when braking." required></textarea></div>
          <div class="field"><label>Budget cap (USD)</label>
            <input name="budget" type="number" step="0.01" value="400.00" required></div>`,
        submitLabel: "Send request",
        onSubmit: (fd) => {
          const n = S.jobs.length + 1042;
          const job = {
            id: St.uid("job"),
            jobNo: "JC-" + n,
            garageName: "Northgate Auto Works",
            customerName: "Dana Whitfield",
            customerEmail: "dana.whitfield@example.com",
            vehicle: {
              year: Number(fd.get("year")) || 2018,
              make: fd.get("make"),
              model: fd.get("model"),
              plate: fd.get("plate"),
              vin: "PENDING-" + n,
              odometer: 0,
            },
            status: "REQUESTED",
            createdAt: St.nowISO(),
            pausedReason: null,
            dependsOnQuoteId: null,
          };
          S.jobs.push(job);
          actions.createRfq(job.id, fd.get("desc"), fd.get("budget"));
          S.jobId = job.id;
          S.screen = "job";
          S.tab = "quotes";
          global.App.render();
        },
      });
    },
  };

  /* ---------------- wiring ---------------- */
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const fn = handlers[el.dataset.act];
    if (!fn) return;
    if (el.tagName === "INPUT" && el.type === "checkbox") ev.preventDefault();
    fn(el.dataset.id, el);
  });

  /* live line editing */
  document.addEventListener("input", (ev) => {
    /* builder: filter the catalog list without a re-render (keeps focus) */
    if (ev.target.id === "svcSearch") {
      const term = ev.target.value.toLowerCase();
      actions.builderSearch(term);
      const list = document.getElementById("svcList");
      if (!list) return;
      list.querySelectorAll(".svc-row").forEach((row) => {
        const hit =
          !term ||
          row.dataset.name.includes(term) ||
          row.dataset.cat.includes(term);
        row.style.display = hit ? "" : "none";
      });
      return;
    }

    const input = ev.target.closest("input[data-field]");
    if (!input) return;

    const q = sel.quote(input.dataset.quoteId);
    if (!q) return;
    const item = q.items.find((i) => i.id === input.dataset.itemId);
    if (!item) return;

    const field = input.dataset.field;
    if (field === "description") item.description = input.value;
    else if (field === "qty")
      item.qty = Math.max(0, parseFloat(input.value) || 0);
    else if (field === "unitPrice")
      item.unitPrice = Math.max(
        0,
        Math.round((parseFloat(input.value) || 0) * 100),
      );

    const lt = document.getElementById("lt-" + item.id);
    if (lt) lt.textContent = money(Math.round(item.qty * item.unitPrice));
    const total = document.getElementById("qtotal-" + q.id);
    if (total) total.textContent = money(St.quoteTotals(q).total);
  });

  /* tax / deposit / committed line edits */
  document.addEventListener("change", (ev) => {
    const taxSel = ev.target.closest("[data-tax-select]");
    if (taxSel) {
      actions.setItemTax(
        taxSel.dataset.quoteId,
        taxSel.dataset.itemId,
        taxSel.value,
      );
      return;
    }

    const depType = ev.target.closest("[data-deposit-type]");
    if (depType) {
      const q = sel.quote(depType.dataset.quoteId);
      const valueEl = document.querySelector("[data-deposit-value]");
      const value = valueEl ? valueEl.value : q.depositValue;
      actions.builderSetDeposit(depType.value, value);
      return;
    }

    const depValue = ev.target.closest("[data-deposit-value]");
    if (depValue) {
      const q = sel.quote(depValue.dataset.quoteId);
      actions.builderSetDeposit(q.depositType, depValue.value);
      return;
    }

    /* a committed line edit re-renders so the tax breakdown stays in sync */
    if (ev.target.closest("input[data-field]")) global.App.render();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeModal();
  });

  /* ---------------- boot ---------------- */
  global.App = {
    render: () => global.Views.render(),
    toast,
    openModal,
    closeModal,
  };
  global.App.render();
})(window);
