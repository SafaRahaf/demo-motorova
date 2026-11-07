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
    activeTaxes,
    taxById,
    taxRateLabel,
    docTotals,
  } = St;

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
    role: (id, el) => actions.setRole(el.dataset.role),
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
    generateInvoice: (id) => actions.generateInvoice(id),

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
