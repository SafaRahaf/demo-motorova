/* =========================================================
   views.js — rendering. Pure functions returning HTML strings.
   ========================================================= */
(function (global) {
  "use strict";

  const St = global.Store;
  const {
    S,
    sel,
    money,
    fmtDateTime,
    fmtDay,
    nowISO,
    quoteTotals,
    depositFor,
    lineTotal,
    docTotals,
    activeTaxes,
    taxById,
    taxLabel,
    taxRateLabel,
    invoiceNeedsUpdate,
    buildLines,
  } = St;

  /* ---------------- helpers ---------------- */
  const esc = (s) =>
    String(s === undefined || s === null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  const STATUS = {
    DRAFT: ["Draft", "neutral"],
    PENDING_GARAGE_APPROVAL: ["Pending Garage Approval", "warn"],
    PENDING_CUSTOMER_APPROVAL: ["Pending Customer Approval", "info"],
    ACCEPTED: ["Accepted", "ok"],
    REJECTED: ["Rejected", "danger"],
    EXPIRED: ["Expired", "neutral"],
    SUPERSEDED: ["Superseded", "neutral"],
    WITHDRAWN: ["Withdrawn", "neutral"],

    ISSUED: ["Issued", "info"],
    UNPAID: ["Unpaid", "danger"],
    PARTIALLY_PAID: ["Partially Paid", "warn"],
    PAID: ["Paid", "ok"],
    REFUNDED: ["Refunded", "violet"],
    VOID: ["Void", "neutral"],

    REQUESTED: ["Requested", "info"],
    PROCESSING: ["Processing", "warn"],
    COMPLETED: ["Completed", "ok"],
    DECLINED: ["Declined", "danger"],

    SUCCEEDED: ["Succeeded", "ok"],
    PARTIALLY_REFUNDED: ["Partially Refunded", "violet"],
    FAILED: ["Failed", "danger"],
    PENDING: ["Pending", "warn"],

    QUOTING: ["Quoting", "info"],
    AWAITING_INVOICE: ["Awaiting Invoice", "warn"],
    AWAITING_DEPOSIT: ["Awaiting Deposit", "warn"],
    IN_PROGRESS: ["In Progress", "ok"],
    PAUSED_PENDING_APPROVAL: ["Paused — Awaiting Approval", "warn"],
    PAUSED_PENDING_CANCELLATION: ["Paused — Pending Cancellation", "danger"],
    WORK_COMPLETE: ["Work Complete", "ok"],
    CANCELLED: ["Cancelled", "neutral"],
    CLOSED: ["Closed", "neutral"],

    UNDER_REVIEW: ["Under Review", "info"],
    SETTLEMENT_SENT: ["Settlement Sent", "warn"],
    AGREED: ["Agreed", "ok"],
  };

  const pill = (s) => {
    const meta = STATUS[s] || [String(s).replace(/_/g, " "), "neutral"];
    return `<span class="pill pill--${meta[1]}">${esc(meta[0])}</span>`;
  };

  const typeTag = (t) => {
    const map = {
      STANDARD: ["tag--std", "Standard"],
      SUPPLEMENTARY: ["tag--sup", "Supplementary"],
      SETTLEMENT: ["tag--set", "Settlement"],
      WARRANTY: ["tag--war", "Warranty"],
    };
    const m = map[t] || ["", t];
    return `<span class="tag ${m[0]}">${esc(m[1])}</span>`;
  };

  const btn = (label, act, id, cls, extraAttrs) =>
    `<button type="button" class="${cls || "btn btn--ghost"}" data-act="${act}"${id ? ` data-id="${id}"` : ""}${extraAttrs ? " " + extraAttrs : ""}>${label}</button>`;

  const empty = (title, sub, actionHtml) =>
    `<div class="empty"><h4>${esc(title)}</h4><p>${esc(sub || "")}</p>${actionHtml ? `<div style="margin-top:14px">${actionHtml}</div>` : ""}</div>`;

  const banner = (kind, icon, html) =>
    `<div class="banner banner--${kind}"><span class="banner__icon">${icon}</span><div>${html}</div></div>`;

  /* One panel only: the garage records the customer's answer after they agree in
     person/by phone, so every open quote is actionable from the garage side. */
  const isMyTurn = (q) =>
    ["DRAFT", "PENDING_GARAGE_APPROVAL", "PENDING_CUSTOMER_APPROVAL"].includes(
      q.status,
    );

  const isOpen = (q) =>
    ["DRAFT", "PENDING_GARAGE_APPROVAL", "PENDING_CUSTOMER_APPROVAL"].includes(
      q.status,
    );

  /* Which document(s) cover this quote — the badge that answers
     "is this quote invoiced yet, and where?" without hunting through tabs. */
  function invoiceBadge(q) {
    const st = sel.quoteInvoiceStatus(q.id);
    if (!st.invoiced)
      return `<span class="badge badge--none" title="No invoice has been generated for this quote">Not invoiced</span>`;
    if (!st.live.length)
      return `<button type="button" class="badge badge--void" data-act="tabs" data-id="bill" title="Its invoice was consolidated into a newer one">Voided → ${esc(st.latest ? st.latest.no : "—")}</button>`;
    const first = st.live[0];
    const extra = st.live.length > 1 ? ` +${st.live.length - 1}` : "";
    return `<button type="button" class="badge badge--invoiced" data-act="tabs" data-id="bill" title="Open the invoice for this quote">
      Invoiced → ${esc(first.no)}${esc(extra)}</button>`;
  }

  /* tax chip shown under a line description */
  const taxChip = (line) => {
    if (!line.taxId) return '<span class="taxchip taxchip--none">no tax</span>';
    const rate =
      line.taxKind === "PERCENT"
        ? (line.taxValue / 100).toFixed(2) + "%"
        : money(line.taxValue) + "/unit";
    return `<span class="taxchip">${esc(line.taxCode)} ${rate}${line.taxInclusive ? " incl." : ""}</span>`;
  };

  /* one shared tax breakdown block for quotes AND invoices */
  function taxBlock(taxes) {
    if (!taxes || !taxes.length) return "";
    return taxes
      .map((t) => {
        const rate =
          t.kind === "PERCENT"
            ? (t.value / 100).toFixed(2) + "%"
            : money(t.value) + "/unit";
        return `<div class="totals__row totals__row--tax">
        <span>${esc(t.code)} <span class="sub">${rate}${t.inclusive ? " · included" : ""}</span></span>
        <span>${money(t.amount)}</span>
      </div>`;
      })
      .join("");
  }

  /* Total refunded across the job, for the overview hint. */
  const jobRefundedTotal = (jobId) =>
    S.refunds
      .filter((r) => {
        const i = sel.invoice(r.invoiceId);
        return i && i.jobId === jobId && r.status === "COMPLETED";
      })
      .reduce((s, r) => s + r.amount, 0);

  /* =========================================================
     SIDEBAR
     ========================================================= */
  function renderSidebar() {
    const nav =
      S.role === "garage"
        ? `
      <div class="navlist">
        <button class="${S.screen === "job" ? "is-active" : ""}" data-act="screen" data-id="job">Jobs</button>
        <button class="${S.screen === "taxes" ? "is-active" : ""}" data-act="screen" data-id="taxes">Taxes</button>
        <button class="${S.screen === "services" ? "is-active" : ""}" data-act="screen" data-id="services">Catalog</button>
      </div>`
        : "";

    if (S.screen !== "job") {
      const note =
        S.screen === "taxes"
          ? [
              "Tax engine",
              "Rates are versioned — changing one never rewrites an existing quote or invoice.",
            ]
          : S.screen === "services"
            ? [
                "Service catalog",
                "Default prices and taxes used when the garage builds a quote.",
              ]
            : [
                "Quote builder",
                "Running full screen. Use Back to job to leave without saving.",
              ];
      document.getElementById("sidebar").innerHTML =
        nav +
        `
        <div class="side-note">
          <b>${note[0]}.</b> ${note[1]}
        </div>`;
      return;
    }

    const jobs = S.jobs
      .map((job) => {
        const active = sel.activeQuote(job.id);
        const inv = sel.stdInvoice(job.id);
        const amount = active ? quoteTotals(active).total : inv ? inv.total : 0;
        const hold = inv && inv.vehicleHold;
        return `
        <button type="button" class="job-item ${job.id === S.jobId ? "is-active" : ""}" data-act="job" data-id="${job.id}">
          <div class="job-item__no">${esc(job.jobNo)}</div>
          <div class="job-item__veh">${esc(job.vehicle.year + " " + job.vehicle.make + " " + job.vehicle.model)}</div>
          <div class="job-item__foot">
            ${pill(job.status)}
            ${hold ? '<span class="tag tag--hold">Hold</span>' : ""}
            <span class="job-item__amt">${money(amount)}</span>
          </div>
        </button>`;
      })
      .join("");

    const newJobBtn =
      S.role === "customer"
        ? `<button type="button" class="btn btn--primary btn--sm" style="width:100%;margin-bottom:10px" data-act="newJob">+ New request</button>`
        : `<button type="button" class="btn btn--primary btn--sm" style="width:100%;margin-bottom:10px" data-act="newGarageJob">+ New job</button>`;

    document.getElementById("sidebar").innerHTML = `
      ${nav}
      <div class="side-head">
        <span class="side-head__title">${S.role === "garage" ? "Garage jobs" : "My jobs"}</span>
        <span class="sub">${S.jobs.length}</span>
      </div>
      ${newJobBtn}
      ${jobs}
      <div class="side-note">
        <b>Prototype.</b> Switch role in the top bar to answer the other party.
        <b>Reset demo</b> restores the seed data.
      </div>`;
  }

  /* =========================================================
     MAIN
     ========================================================= */
  function renderMain() {
    const main = document.getElementById("main");
    if (S.screen === "taxes") {
      main.innerHTML = viewTaxes();
      return;
    }
    if (S.screen === "services") {
      main.innerHTML = viewCatalog();
      return;
    }
    if (S.screen === "builder") {
      main.innerHTML = viewBuilder();
      return;
    }

    const job = sel.job(S.jobId);
    if (!job) {
      main.innerHTML = empty("No job selected", "Pick a job from the left.");
      return;
    }
    main.innerHTML = jobHeader(job) + tabs(job) + tabBody(job);
  }

  function jobHeader(job) {
    const v = job.vehicle;
    return `
      <div class="jobhead">
        <div class="jobhead__top">
          <div>
            <div class="jobhead__no">${esc(job.jobNo)} &middot; ${esc(job.garageName)}</div>
            <div class="jobhead__title">${esc(v.year + " " + v.make + " " + v.model)}</div>
            <div class="jobhead__meta">
              <span>Plate <b>${esc(v.plate)}</b></span>
              <span>VIN <b class="mono">${esc(v.vin)}</b></span>
              <span>Odometer <b>${Number(v.odometer || 0).toLocaleString()} mi</b></span>
              <span>Customer <b>${esc(job.customerName)}</b></span>
            </div>
          </div>
          <div style="text-align:right">
            ${pill(job.status)}
            ${job.pausedReason ? `<div class="sub" style="max-width:280px;margin-top:6px">${esc(job.pausedReason)}</div>` : ""}
          </div>
        </div>
      </div>`;
  }

  function tabs(job) {
    const quotes = sel.quotesForJob(job.id).length;
    const pays = sel.paymentsForJob(job.id).length;
    const refs = sel.refundsForJob(job.id).length;
    const docs = sel.invoicesForJob(job.id).length;
    const billLabel = S.role === "customer" ? "Bill" : "Invoice";

    const t = [
      ["overview", "Overview", 0],
      ["quotes", "Quotes", quotes],
      ["bill", billLabel, docs],
      ["payments", "Payments", pays],
      ["refunds", "Refunds", refs],
      ["audit", "Audit trail", 0],
    ];

    return `<div class="tabs">${t
      .map(
        ([key, label, count]) => `
      <button type="button" class="${S.tab === key ? "is-active" : ""}" data-act="tab" data-id="${key}">
        ${esc(label)}${count ? `<span class="count">${count}</span>` : ""}
      </button>`,
      )
      .join("")}</div>`;
  }

  function tabBody(job) {
    switch (S.tab) {
      case "quotes":
        return viewQuotes(job);
      case "bill":
        return viewBill(job);
      case "payments":
        return viewPayments(job);
      case "refunds":
        return viewRefunds(job);
      case "audit":
        return viewAudit(job);
      default:
        return viewOverview(job);
    }
  }

  /* =========================================================
     OVERVIEW
     ========================================================= */
  function viewOverview(job) {
    const active = sel.activeQuote(job.id);
    const inv = sel.stdInvoice(job.id);
    const live = sel.liveInvoices(job.id);
    const totals = sel.jobTotals(job.id);
    const pro = sel.openProforma(job.id);
    const cancel = sel.openCancellation(job.id);
    const pendingQuotes = sel.uninvoicedQuotes(job.id);

    const kpis = `
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">Open quote</div>
          <div class="kpi__value">${active ? money(quoteTotals(active).total) : "—"}</div>
          <div class="kpi__hint">${active ? esc(active.no + " · " + (STATUS[active.status] || [active.status])[0]) : "No quote in play"}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">${inv ? (S.role === "customer" ? "Amount billed" : "Invoiced") : "Proforma"}</div>
          <div class="kpi__value">${live.length ? money(totals.total) : pro ? money(pro.total) : "—"}</div>
          <div class="kpi__hint">${live.length ? `${live.length} live invoice${live.length === 1 ? "" : "s"} · ${esc(live.map((i) => i.no).join(", "))}` : pro ? esc(pro.no + " · proforma") : "No document yet"}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">Remaining balance</div>
          <div class="kpi__value ${totals.balance > 0 ? "is-due" : "is-ok"}">${live.length ? money(totals.balance) : "—"}</div>
          <div class="kpi__hint">${live.length ? "Paid " + money(totals.paid) + (jobRefundedTotal(job.id) ? " · Refunded " + money(jobRefundedTotal(job.id)) : "") : "Nothing payable yet"}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">Vehicle hold</div>
          <div class="kpi__value ${inv && inv.vehicleHold ? "is-due" : "is-ok"}">${inv ? (inv.vehicleHold ? "ON" : "OFF") : "—"}</div>
          <div class="kpi__hint">${inv && inv.vehicleHold ? "Keys cannot be released" : "Release permitted"}</div>
        </div>
      </div>`;

    let holdBanner = "";
    if (totals.balance > 0 && live.length) {
      holdBanner = banner(
        "hold",
        "&#128274;",
        `<b>Vehicle Hold active.</b> ${money(totals.balance)} still owed across ${live.length} live invoice${live.length === 1 ? "" : "s"}.
         Garage staff must not release the vehicle or keys until the balance reaches ${money(0)}.`,
      );
    }
    if (pendingQuotes.length) {
      holdBanner += banner(
        "warn",
        "&#9888;",
        `<b>Accepted work not yet billed.</b> ${pendingQuotes.length} quote${pendingQuotes.length === 1 ? "" : "s"} accepted but not on an invoice
         (${pendingQuotes.map((q) => esc(q.no)).join(", ")}). Use <b>Generate</b> on the Invoice tab to bill it.`,
      );
    }

    let cancelPanel = "";
    if (cancel) {
      const settle = cancel.settlementQuoteId
        ? sel.quote(cancel.settlementQuoteId)
        : null;
      cancelPanel = `
        <div class="card">
          <div class="card__head">
            <div>
              <div class="card__title">Cancellation request ${pill(cancel.status)}</div>
              <div class="card__sub">Reason: ${esc(cancel.reason)} &middot; raised ${fmtDateTime(cancel.createdAt)}</div>
            </div>
          </div>
          <div class="card__body">
            ${banner(
              "warn",
              "&#9888;",
              `Job is auto-paused at <b>Paused — Pending Cancellation</b>. The garage reviews work
               completed to this minute and issues a <b>Settlement Quote</b>.`,
            )}
            <div class="sub">
              ${
                settle
                  ? `Settlement quote <b>${esc(settle.no)}</b> — ${money(quoteTotals(settle).total)} — ${esc(settle.status.replace(/_/g, " "))}. Open the <b>Quotes</b> tab.`
                  : S.role === "garage"
                    ? "No settlement quote issued yet."
                    : "Waiting for the garage to issue a settlement quote."
              }
            </div>
          </div>
          ${
            S.role === "garage" && !settle
              ? `
          <div class="card__foot">
            <button class="btn btn--primary" data-act="settlementModal" data-id="${job.id}">Create settlement quote</button>
            <button class="btn btn--ghost" data-act="declineCancel" data-id="${job.id}">Decline cancellation</button>
          </div>`
              : ""
          }
        </div>`;
    }

    const acts = [];
    if (S.role === "garage") {
      if (job.status !== "CANCELLED" && job.status !== "CLOSED") {
        acts.push(
          btn("+ New quote", "createGarageQuote", job.id, "btn btn--primary"),
        );
      }
      if (sel.stdQuote(job.id))
        acts.push(
          btn("Supplementary quote (mid-job)", "newSupplementary", job.id),
        );
      if (inv) {
        acts.push(btn("Add storage fee", "storageModal", job.id));
        acts.push(btn("Warranty / rework quote", "newWarranty", job.id));
      }
    } else if (
      job.status !== "CANCELLED" &&
      !cancel &&
      job.status !== "CLOSED"
    ) {
      acts.push(
        btn(
          "Request cancellation",
          "cancelModal",
          job.id,
          "btn btn--danger-soft",
        ),
      );
    }

    return `
      ${kpis}
      ${holdBanner}
      ${cancelPanel}
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Workflow</div>
            <div class="card__sub">What this job is doing right now</div>
          </div>
        </div>
        <div class="card__body">
          <ol style="margin:0;padding-left:18px;font-size:13px;color:var(--ink-2);line-height:1.9">
            <li>Quote built by ${esc(sel.quotesForJob(job.id)[0] ? (sel.quotesForJob(job.id)[0].createdByRole === "GARAGE" ? "the garage after inspection" : "the customer as a Request for Quote") : "nobody yet")}.</li>
            <li>Both sides may <b>accept</b>, <b>reject</b>, <b>counter-offer</b> or <b>add conditions</b>. Every round is logged.</li>
            <li>Acceptance <b>locks</b> the quote — but it does <b>not</b> raise a bill.</li>
            <li>The garage then issues a <b>proforma</b> (informational) or a <b>tax invoice</b> (payable).</li>
            <li>Deposit is collected on the invoice; the balance is due on completion.</li>
          </ol>
        </div>
        ${acts.length ? `<div class="card__foot">${acts.join("")}</div>` : ""}
      </div>`;
  }

  /* =========================================================
     QUOTES
     ========================================================= */
  function viewQuotes(job) {
    const quotes = sel.quotesForJob(job.id);
    const newBtn =
      S.role === "garage"
        ? btn(
            "+ New quote",
            "createGarageQuote",
            job.id,
            "btn btn--primary btn--sm",
          )
        : "";

    const head = `<div class="page-head" style="margin-bottom:14px">
        <div>
          <h2 style="font-size:16px">Quotes</h2>
          <p class="sub">${quotes.length} on this job · newest first</p>
        </div>
        ${newBtn}
      </div>`;

    if (!quotes.length) {
      return (
        head +
        empty(
          "No quotes yet",
          "Either party can start one.",
          S.role === "garage"
            ? btn(
                "Open quote builder",
                "createGarageQuote",
                job.id,
                "btn btn--primary",
              )
            : "",
        )
      );
    }
    return (
      head +
      quotes
        .map((q) => quoteCard(job, q))
        .reverse()
        .join("")
    );
  }

  function quoteCard(job, q) {
    const t = quoteTotals(q);
    const editing = S.editingQuoteId === q.id;
    const myTurn = isMyTurn(q);
    const editable = editing && isOpen(q) && S.role === "customer";
    const canEditTax = editable;

    const header = `
      <div class="card__head">
        <div>
          <div class="card__title">
            ${typeTag(q.type)} <span class="mono">${esc(q.no)}</span>
            ${q.hasDependency ? '<span class="tag tag--hold">Blocking</span>' : ""}
            ${q.isChangeOrder ? '<span class="tag tag--addon">Add-on</span>' : ""}
          </div>
          <div class="card__sub">
            ${q.createdByRole === "GARAGE" ? "Created by garage after inspection" : "Created by customer as a Request for Quote"}
            &middot; revision ${q.revision}
            &middot; expires ${fmtDay(q.expiryDate)}
            ${q.originalInvoiceId && sel.invoice(q.originalInvoiceId) ? " · rework for " + esc(sel.invoice(q.originalInvoiceId).no) : ""}
            ${q.parentQuoteId && sel.quote(q.parentQuoteId) ? " · linked to " + esc(sel.quote(q.parentQuoteId).no) : ""}
          </div>
        </div>
        <div style="text-align:right">
          ${pill(q.status)}
          <div style="margin-top:6px">${invoiceBadge(q)}</div>
          <div class="quote__amount" id="qtotal-${q.id}" style="margin-top:6px">${money(t.total)}</div>
        </div>
      </div>`;

    let notice = "";
    if (q.type === "SUPPLEMENTARY" && q.hasDependency) {
      notice = banner(
        "warn",
        "&#9888;",
        "<b>Blocking work.</b> This extra must be approved before the job can continue.",
      );
    } else if (q.type === "SUPPLEMENTARY") {
      notice = banner(
        "info",
        "&#8505;",
        "This add-on is <b>independent</b>. If rejected, approved work keeps running.",
      );
    } else if (q.type === "WARRANTY") {
      notice = banner(
        "info",
        "&#8505;",
        "Warranty rework at <b>$0.00</b>. Original prices shown struck through.",
      );
    } else if (q.type === "SETTLEMENT") {
      notice = banner(
        "warn",
        "&#9888;",
        "Settlement of a paused job. Accepting replaces the original billing.",
      );
    }

    /* ---- items ---- */
    const taxOptions = (line) =>
      `<option value="">No tax</option>` +
      activeTaxes()
        .map(
          (tx) =>
            `<option value="${tx.id}" ${line.taxId === tx.id ? "selected" : ""}>${esc(tx.code)} · ${esc(taxRateLabel(tx))}${tx.inclusive ? " (incl.)" : ""}</option>`,
        )
        .join("");

    const itemRows = q.items
      .map((i) => {
        if (editable) {
          return `<tr>
          <td><input type="text" data-item-id="${i.id}" data-quote-id="${q.id}" data-field="description" value="${esc(i.description)}">
              ${taxChip(i)}</td>
          <td class="num" style="width:78px"><input class="num-input" type="number" step="0.5" min="0"
              data-item-id="${i.id}" data-quote-id="${q.id}" data-field="qty" value="${i.qty}"></td>
          <td class="num" style="width:100px"><input class="num-input" type="number" step="0.01" min="0"
              data-item-id="${i.id}" data-quote-id="${q.id}" data-field="unitPrice" value="${(i.unitPrice / 100).toFixed(2)}"></td>
          <td class="num" id="lt-${i.id}" style="width:92px">${money(lineTotal(i))}</td>
          <td style="width:36px"><button type="button" class="icon-btn" data-act="removeItem" data-id="${q.id}" data-item="${i.id}">&#10005;</button></td>
        </tr>`;
        }
        const orig =
          i.unitPriceOriginal && i.unitPriceOriginal !== i.unitPrice
            ? `<div class="sub" style="text-decoration:line-through">${money(i.unitPriceOriginal)}</div>`
            : "";
        return `<tr>
        <td>
          <div>${esc(i.description)}</div>
          <div class="sub">${esc(String(i.kind).replace(/_/g, " ").toLowerCase())}${i.packageRef ? " · package" : ""} ${taxChip(i)}</div>
        </td>
        <td class="num">${i.qty}</td>
        <td class="num">${money(i.unitPrice)}${orig}</td>
        <td class="num">${money(lineTotal(i))}</td>
      </tr>`;
      })
      .join("");

    const itemsTable = `
      <table class="table">
        <thead><tr>
          <th>Description</th><th class="num">Qty</th><th class="num">Unit price</th>
          <th class="num">Amount</th>
          ${editable ? "<th></th>" : ""}
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>`;

    /* ---- totals ---- */
    const dep = depositFor(q);
    const totals = `
      <div class="card__body" style="border-top:1px solid var(--line)">
        <div class="totals">
          <div class="totals__row"><span>Subtotal <span class="sub">(excl. tax)</span></span><span>${money(t.subtotal)}</span></div>
          ${taxBlock(t.taxes)}
          <div class="totals__row totals__row--major"><span>Total</span><span>${money(t.total)}</span></div>
          ${dep > 0 ? `<div class="totals__row"><span>Deposit (${q.depositType === "PERCENT" ? q.depositValue + "%" : "flat"})</span><span>${money(dep)}</span></div>` : ""}
        </div>
      </div>`;

    /* ---- conditions ---- */
    const conds = q.conditions.length
      ? `
      <div class="card__body" style="border-top:1px solid var(--line)">
        <div class="card__sub" style="margin-bottom:8px;font-weight:650;color:var(--ink-2)">Conditions &amp; terms</div>
        <ul class="conditions">
          ${q.conditions.map((c) => `<li><span class="who">${esc(c.addedBy)}</span><span>${esc(c.text)}</span></li>`).join("")}
        </ul>
      </div>`
      : "";

    const revs =
      q.revisions && q.revisions.length > 1
        ? `
      <div class="card__body" style="border-top:1px solid var(--line)">
        <div class="card__sub" style="font-weight:650;color:var(--ink-2);margin-bottom:6px">Revision history</div>
        <div class="sub">${q.revisions.map((r) => `rev ${r.no} · ${money(r.total)} · ${esc(r.by)} · ${fmtDateTime(r.at)}`).join("<br>")}</div>
      </div>`
        : "";

    /* ---- actions ---- */
    let actionsHtml = "";
    if (editing) {
      actionsHtml = `
        ${btn("+ Blank custom line", "addItem", q.id)}
        ${btn("+ Add condition", "addCondition", q.id)}
        <span class="spacer"></span>
        ${btn("Cancel", "cancelEdit", null)}
        ${btn("Save &amp; send", "saveQuote", q.id, "btn btn--primary")}`;
    } else if (myTurn) {
      const editAct = S.role === "garage" ? "openBuilder" : "editQuote";
      if (q.status === "DRAFT") {
        actionsHtml = `
          ${btn("Open in builder", editAct, q.id, "btn btn--primary")}
          ${btn("Add condition", "addCondition", q.id)}
          <span class="spacer"></span>
          ${btn("Send to customer", "sendQuote", q.id, "btn btn--ok")}`;
      } else {
        actionsHtml = `
          ${btn(S.role === "garage" ? "Edit in builder" : "Counter-offer / edit", editAct, q.id)}
          ${btn("Add condition", "addCondition", q.id)}
          <span class="spacer"></span>
          ${btn("Reject", "rejectQuote", q.id, "btn btn--danger-soft")}
          ${btn("Accept &amp; lock", "acceptQuote", q.id, "btn btn--ok")}`;
      }
    } else if (isOpen(q)) {
      actionsHtml = `
        ${btn("Add condition", "addCondition", q.id)}
        <span class="spacer"></span>
        <span class="turn-hint">Waiting for <b>${q.status === "PENDING_GARAGE_APPROVAL" ? "the garage" : "the customer"}</b> to respond</span>`;
    } else if (q.status === "ACCEPTED") {
      actionsHtml = `<span class="turn-hint">Locked ${fmtDateTime(q.acceptedAt)} — edits disabled, a new quote is required for changes.</span>`;
    } else {
      actionsHtml = `<span class="turn-hint">This quote is closed (${esc((STATUS[q.status] || [q.status])[0])}).</span>`;
    }

    return `
      <div class="card quote ${q.status === "ACCEPTED" ? "is-locked" : ""}">
        ${header}
        ${notice ? `<div class="card__body" style="padding-bottom:0">${notice}</div>` : ""}
        ${itemsTable}
        ${totals}
        ${conds}
        ${revs}
        <div class="card__foot">${actionsHtml}</div>
      </div>`;
  }

  /* =========================================================
     BILL / INVOICE
     ========================================================= */
  /*
     Shows every LIVE invoice, not just one. A job can hold several: the base
     quote, then add-ons billed later. "Generate" issues what is missing;
     "Combine" merges the live set into one document (the only action that voids).
  */
  function viewBill(job) {
    const live = sel.liveInvoices(job.id);
    const inv = live[0] || null;
    const totals = sel.jobTotals(job.id);
    const pendingQuotes = sel.uninvoicedQuotes(job.id);
    const pro = sel.openProforma(job.id);
    const supersededPros = sel
      .invoicesForJob(job.id)
      .filter((i) => i.kind === "PROFORMA" && i.status !== "ISSUED");
    const warrantyDocs = sel
      .invoicesForJob(job.id)
      .filter((i) => i.kind === "WARRANTY");
    const voidedDocs = sel
      .voidedInvoices(job.id)
      .sort((a, b) => (b.seq || 1) - (a.seq || 1));
    const label = S.role === "customer" ? "bill" : "invoice";

    /* ---- action bar: Generate + Combine ---- */
    const pendingTotal = pendingQuotes.reduce(
      (s, q) => s + quoteTotals(q).total,
      0,
    );
    const canCombine = live.filter((i) => i.kind === "TAX_INVOICE").length >= 2;

    /* "Combine with payments" needs money to fold in, plus either a second
       document or a second receipt — otherwise there is nothing to consolidate. */
    const receiptCount = live.reduce(
      (s, i) =>
        s +
        sel.receiptsForInvoice(i.id).filter((r) => r.status === "VALID").length,
      0,
    );
    const taxLive = live.filter((i) => i.kind === "TAX_INVOICE");
    const canCombineWithPayments =
      receiptCount > 0 && (taxLive.length >= 2 || receiptCount >= 2);

    const generateBar = `
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Billing actions</div>
            <div class="card__sub">Invoices are only ever created by an explicit click. Nothing is automatic.</div>
          </div>
        </div>
        <div class="card__body">
          <div class="row">
            ${
              pendingQuotes.length
                ? btn(
                    `Generate invoice${pendingQuotes.length > 1 ? `s (${pendingQuotes.length})` : ""} · ${money(pendingTotal)}`,
                    "generateInvoices",
                    job.id,
                    "btn btn--primary",
                  )
                : `<button type="button" class="btn btn--primary" disabled>Nothing new to invoice</button>`
            }
            ${
              canCombine
                ? btn(
                    `Combine ${live.length} live invoices`,
                    "combinedModal",
                    job.id,
                    "btn btn--ghost",
                    `title="Merge the documents. Payments stay where they are and are shown as carried forward."`,
                  )
                : `<button type="button" class="btn btn--ghost" disabled title="At least two live invoices are needed">Combine invoices</button>`
            }
            ${
              canCombineWithPayments
                ? btn(
                    canCombine
                      ? `Combine with payments`
                      : `Consolidate ${receiptCount} receipts`,
                    "combinedPaymentsModal",
                    job.id,
                    "btn btn--ok",
                    `title="Move the payments onto one invoice and replace the receipts with a single consolidated receipt."`,
                  )
                : `<button type="button" class="btn btn--ok" disabled title="Needs payments and more than one document or receipt">Combine with payments</button>`
            }
            <span class="spacer"></span>
            ${
              S.role === "garage"
                ? `<label class="checkline" style="margin:0" title="Off = payments build up on one invoice. On = every payment issues a new version and voids the previous.">
                     <input type="checkbox" data-act="toggleReissue" ${S.settings.reissueInvoiceOnPayment ? "checked" : ""}>
                     <span class="sub">New version on each payment</span>
                   </label>`
                : ""
            }
          </div>
          <div class="sub" style="margin-top:10px">
            ${
              pendingQuotes.length
                ? `<b>Will be invoiced:</b> ${pendingQuotes.map((q) => esc(q.no)).join(", ")}. Existing live invoices are left untouched.`
                : live.length
                  ? `<b>All accepted work is invoiced.</b> ${live.length} live document${live.length === 1 ? "" : "s"}.`
                  : "Nothing accepted yet — accept a quote before generating a document."
            }
          </div>
        </div>
      </div>`;

    /* nothing issued yet */
    if (!live.length && !pro) {
      if (!buildLines(job.id).base) {
        return (
          generateBar +
          empty(
            "No " + label + " yet",
            "A document can only be issued once a quote is accepted.",
          ) +
          (voidedDocs.length ? versionHistory(job, voidedDocs) : "")
        );
      }
      return `
        ${generateBar}
        ${voidedDocs.length ? versionHistory(job, voidedDocs) : ""}`;
    }

    /* ---- multi-invoice summary ---- */
    const summary =
      live.length > 1
        ? `
      <div class="card summary">
        <div class="card__head">
          <div>
            <div class="card__title">All live invoices</div>
            <div class="card__sub">${live.length} payable documents on this job. Combine them if you would rather give the customer one page.</div>
          </div>
        </div>
        <table class="table">
          <thead><tr><th>Document</th><th>From quote</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Remaining</th><th>Status</th></tr></thead>
          <tbody>
            ${live
              .map((i) => {
                const q = i.quoteId ? sel.quote(i.quoteId) : null;
                return `<tr>
                <td><span class="mono">${esc(i.no)}</span></td>
                <td class="sub">${q ? esc(q.no) : "—"}</td>
                <td class="num">${money(i.total)}</td>
                <td class="num">${money(i.amountPaid)}</td>
                <td class="num ${i.balance > 0 ? "is-due" : ""}"><b>${money(i.balance)}</b></td>
                <td>${pill(i.status)}</td>
              </tr>`;
              })
              .join("")}
          </tbody>
          <tfoot><tr>
            <td colspan="2"><b>Job total</b></td>
            <td class="num"><b>${money(totals.total)}</b></td>
            <td class="num"><b>${money(totals.paid)}</b></td>
            <td class="num"><b>${money(totals.balance)}</b></td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>`
        : "";

    return `
      ${generateBar}
      ${summary}
      ${pro ? proformaDoc(job, pro) : ""}
      ${live.map((d) => invoiceDoc(job, d)).join("")}
      ${warrantyDocs.map((d) => invoiceDoc(job, d)).join("")}
      ${voidedDocs.length ? versionHistory(job, voidedDocs) : ""}
      ${
        supersededPros.length
          ? `
        <details class="voided-acc">
          <summary>
            <span class="voided-acc__chev">&#9656;</span>
            <span class="voided-acc__title">Superseded proformas</span>
            <span class="voided-acc__count">${supersededPros.length}</span>
          </summary>
          <div class="voided-acc__body">
            ${supersededPros.map((p) => `<div class="sub">${esc(p.no)} · ${money(p.total)} · ${esc(p.status.toLowerCase())}${p.supersededBy ? " by " + esc((sel.invoice(p.supersededBy) || {}).no || "") : ""}</div>`).join("")}
          </div>
        </details>`
          : ""
      }`;
  }

  function proformaDoc(job, doc) {
    return `
      <div class="card">
        <div class="card__body" style="padding-bottom:0">
          ${banner(
            "warn",
            "&#9888;",
            `<b>Proforma — not a tax invoice.</b> This document shows what the customer will be billed.
             No payment is due against it, and it creates no balance or Vehicle Hold.`,
          )}
        </div>
        <div class="doc">
          <div class="doc__top">
            <div>
              <div class="doc__label">Proforma invoice</div>
              <div class="doc__no">${esc(doc.no)}</div>
              <div class="sub" style="margin-top:4px">${esc(job.garageName)} &middot; ${esc(job.jobNo)}</div>
            </div>
            <div class="doc__meta">
              <div>${pill(doc.status)}</div>
              <div style="margin-top:8px">Issued <b>${fmtDay(doc.issuedAt)}</b></div>
              <div>Valid until <b>${fmtDay(doc.dueAt)}</b></div>
            </div>
          </div>
          ${linesTable(doc)}
          <div class="card__body" style="padding:16px 0 0">
            <div class="totals">
              <div class="totals__row"><span>Subtotal <span class="sub">(excl. tax)</span></span><span>${money(doc.subtotal)}</span></div>
              ${taxBlock(doc.taxes)}
              <div class="totals__row totals__row--major"><span>Estimated total</span><span>${money(doc.total)}</span></div>
              ${doc.depositRequired > 0 ? `<div class="totals__row"><span>Deposit that will be required</span><span>${money(doc.depositRequired)}</span></div>` : ""}
            </div>
          </div>
        </div>
        <div class="card__foot">
          ${S.role === "garage" ? btn("Convert to tax invoice", "generateInvoices", job.id, "btn btn--primary") : ""}
          <span class="spacer"></span>
          <span class="sub">Proforma numbers (PRO-####) never become tax invoices — a new INV-#### is issued.</span>
        </div>
      </div>`;
  }

  function linesTable(doc) {
    return `<table class="table">
      <thead><tr>
        <th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>${doc.lines
        .map(
          (l) => `
        <tr>
          <td>
            <div>${esc(l.description)}</div>
            <div class="sub">${l.isAddon ? '<span class="tag tag--addon">Add-on</span> ' : ""}${l.quoteType === "SETTLEMENT" ? '<span class="tag tag--set">Settlement</span> ' : ""}${taxChip(l)}</div>
          </td>
          <td class="num">${l.qty}</td>
          <td class="num">${money(l.unitPrice)}</td>
          <td class="num">${money(lineTotal(l))}</td>
        </tr>`,
        )
        .join("")}
      </tbody>
    </table>`;
  }

  /*
     Receipt rows printed inside a document's totals block.
     They are deliberately NOT invoice lines — a receipt is money coming in, not
     a charge. Only VALID receipts are deducted; voided ones stay visible
     (struck through) so the history is complete but never counted twice.
  */
  function receiptRows(inv) {
    const list = sel.receiptsForInvoice(inv.id);
    if (!list.length) return "";
    const valid = list.filter((r) => r.status === "VALID");
    return `
      <div class="rcpt-block">
        <div class="rcpt-block__head">
          <span>Receipts</span>
          <span class="rcpt-block__note">payments received — not charges on this invoice</span>
        </div>
        ${
          valid.length
            ? valid
                .map(
                  (r) => `
          <button type="button" class="rcpt-row" data-act="receiptModal" data-id="${r.id}" title="Open receipt ${esc(r.no)}">
            <span class="rcpt-row__no mono">${esc(r.no)}</span>
            <span class="rcpt-row__meta">${esc(r.method || "")} · ${fmtDay(r.issuedAt)}</span>
            <span class="rcpt-row__amt">&minus;${money(r.amount || 0)}</span>
          </button>`,
                )
                .join("")
            : `<div class="rcpt-row rcpt-row--empty"><span class="sub">No valid receipt — see voided below</span></div>`
        }
        ${list
          .filter((r) => r.status === "VOID")
          .map(
            (r) => `
          <button type="button" class="rcpt-row rcpt-row--void" data-act="receiptModal" data-id="${r.id}" title="Void receipt — kept for the audit trail">
            <span class="rcpt-row__no mono">${esc(r.no)}</span>
            <span class="rcpt-row__meta">${esc(r.method || "")} · ${fmtDay(r.issuedAt)}</span>
            <span class="tag">VOID</span>
            <span class="rcpt-row__amt rcpt-row__amt--void">${money(r.amount || 0)}</span>
          </button>`,
          )
          .join("")}
      </div>`;
  }

  /*
     A standalone, printable document — the SAME markup is used for the screen
     download and for print-to-PDF, so the two can never drift apart.
     Contains no app chrome: no tabs, no buttons, no sidebar.
  */
  function printableDoc(inv) {
    const job = sel.job(inv.jobId);
    const isVoid = inv.status === "VOID";
    const isProforma = inv.kind === "PROFORMA";
    const isWarranty = inv.kind === "WARRANTY";
    const label = isProforma
      ? "Proforma invoice"
      : isWarranty
        ? "Warranty invoice"
        : "Tax invoice";
    const receipts = sel.receiptsForInvoice(inv.id);
    const valid = receipts.filter((r) => r.status === "VALID");

    const lineRows = (inv.lines || [])
      .map(
        (l) => `<tr>
          <td>${esc(l.description)}${l.isAddon ? ' <span class="d-tag">Add-on</span>' : ""}${l.taxCode ? ` <span class="d-tag d-tag--tax">${esc(l.taxCode)}</span>` : ""}</td>
          <td class="num">${l.qty}</td>
          <td class="num">${money(l.unitPrice)}</td>
          <td class="num">${money(lineTotal(l))}</td>
        </tr>`,
      )
      .join("");

    const taxRows = (inv.taxes || [])
      .map(
        (t) => `<tr>
          <td class="d-muted">${esc(t.code)} ${t.kind === "PERCENT" ? (t.value / 100).toFixed(2) + "%" : money(t.value) + "/unit"}${t.inclusive ? " (included)" : ""}</td>
          <td class="num">${money(t.amount)}</td>
        </tr>`,
      )
      .join("");

    return `
      ${isVoid ? '<div class="d-void-mark">VOID — NOT PAYABLE</div>' : ""}
      <header class="d-head">
        <div>
          <div class="d-garage">${esc(job.garageName)}</div>
          <div class="d-muted">${esc(job.jobNo)} · ${esc(job.vehicle.year + " " + job.vehicle.make + " " + job.vehicle.model)} · ${esc(job.vehicle.plate)}</div>
        </div>
        <div class="d-meta">
          <div class="d-label">${esc(label)}</div>
          <div class="d-no">${esc(inv.no)}</div>
          <div class="d-muted">${isVoid ? "Voided " + fmtDay(inv.voidedAt) : "Issued " + fmtDay(inv.issuedAt)}</div>
          <div class="d-muted">${isVoid ? esc(inv.voidReason || "") : "Due " + fmtDay(inv.dueAt)}</div>
        </div>
      </header>

      <section class="d-parties">
        <div>
          <div class="d-label">Billed to</div>
          <div><b>${esc(job.customerName)}</b></div>
          <div class="d-muted">${esc(job.customerEmail || "")}</div>
        </div>
        <div>
          <div class="d-label">Vehicle</div>
          <div><b>${esc(job.vehicle.year + " " + job.vehicle.make + " " + job.vehicle.model)}</b></div>
          <div class="d-muted">${esc(job.vehicle.plate)} · VIN ${esc(job.vehicle.vin)}</div>
        </div>
      </section>

      <table class="d-table">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
        <tbody>${lineRows}</tbody>
      </table>

      <section class="d-totals">
        <table>
          <tr><td>Subtotal (excl. tax)</td><td class="num">${money(inv.subtotal)}</td></tr>
          ${taxRows}
          <tr class="d-major"><td>Total</td><td class="num">${money(inv.total)}</td></tr>
          ${inv.carriedPaid > 0 ? `<tr><td>Paid on consolidated invoices</td><td class="num">&minus;${money(inv.carriedPaid)}</td></tr>` : ""}
          ${valid.length ? `<tr><td colspan="2" class="d-section">Receipts — payments received, not charges</td></tr>` : ""}
          ${valid.map((r) => `<tr><td class="d-muted">${esc(r.no)} · ${esc(r.method || "")} · ${fmtDay(r.issuedAt)}</td><td class="num">&minus;${money(r.amount || 0)}</td></tr>`).join("")}
          ${inv.refunded > 0 ? `<tr><td>Refunded</td><td class="num">${money(inv.refunded)}</td></tr>` : ""}
          <tr class="d-due"><td>Remaining balance</td><td class="num">${money(inv.balance)}</td></tr>
        </table>
      </section>

      ${
        receipts.filter((r) => r.status === "VOID").length
          ? `<section class="d-note"><b>Void receipts (kept for the audit trail):</b>
             ${receipts
               .filter((r) => r.status === "VOID")
               .map((r) => `${esc(r.no)} ${money(r.amount || 0)}`)
               .join(" · ")}</section>`
          : ""
      }

      ${isProforma ? '<section class="d-note"><b>Proforma — not a tax invoice.</b> No payment is due against this document.</section>' : ""}
      ${isVoid ? '<section class="d-note"><b>This document has been voided.</b> It is kept for the record only and is not payable.</section>' : ""}

      <footer class="d-foot">${esc(job.garageName)} · ${esc(job.jobNo)} · Generated ${fmtDateTime(nowISO())}</footer>`;
  }

  function invoiceDoc(job, inv) {
    const label = S.role === "customer" ? "Bill" : "Invoice";
    const credits = sel.creditNotesForInvoice(inv.id);
    const stale =
      inv.kind === "TAX_INVOICE" ? invoiceNeedsUpdate(job.id) : null;

    return `
      <div class="card">
        ${
          inv.vehicleHold
            ? `<div class="card__body" style="padding-bottom:0">${banner(
                "hold",
                "&#128274;",
                `<b>Vehicle Hold.</b> ${money(inv.balance)} outstanding. Keys and vehicle must not be released.`,
              )}</div>`
            : ""
        }
        ${
          stale
            ? `<div class="card__body" style="padding-bottom:0">${banner(
                "warn",
                "&#9888;",
                `<b>Accepted work not yet billed.</b> ${stale.quotes} quote${stale.quotes === 1 ? "" : "s"} accepted but not on an invoice
           (${money(stale.delta)}, ${stale.lines} line${stale.lines === 1 ? "" : "s"}). Use <b>Generate</b> on the Invoice tab.`,
              )}</div>`
            : ""
        }

        <div class="doc">
          <div class="doc__top">
            <div>
              <div class="doc__label">${inv.kind === "WARRANTY" ? "Warranty invoice" : esc(label)}</div>
              <div class="doc__no">${esc(inv.no)}</div>
              <div class="sub" style="margin-top:4px">${esc(job.garageName)} &middot; ${esc(job.jobNo)}</div>
            </div>
            <div class="doc__meta">
              <div>${pill(inv.status)}</div>
              ${
                (inv.seq || 1) > 1 || inv.supersedes
                  ? `<div style="margin-top:4px">Version <b>${inv.seq || 1}</b>${
                      inv.supersedes
                        ? ` · replaces <span class="mono">${esc((sel.invoice(inv.supersedes) || {}).no || "—")}</span>`
                        : ""
                    }</div>`
                  : ""
              }
              <div style="margin-top:8px">Issued <b>${fmtDay(inv.issuedAt)}</b></div>
              <div>Due <b>${fmtDay(inv.dueAt)}</b></div>
              ${inv.kind === "WARRANTY" ? `<div>Rework for <b>${esc((sel.invoice(inv.originalInvoiceId) || {}).no || "—")}</b></div>` : ""}
              ${inv.settlementQuoteId ? "<div><b>Settlement</b> applied</div>" : ""}
              ${inv.quoteId && sel.quote(inv.quoteId) ? `<div>From quote <b class="mono">${esc(sel.quote(inv.quoteId).no)}</b></div>` : ""}
              ${inv.combinedFromInvoiceIds && inv.combinedFromInvoiceIds.length ? `<div><b>Combined</b> ${inv.combinedFromInvoiceIds.map((id) => esc((sel.invoice(id) || {}).no || "—")).join(", ")}</div>` : ""}
            </div>
          </div>

          <div class="doc__parties">
            <div><span class="doc__label">Billed to</span><div><b>${esc(job.customerName)}</b><br>${esc(job.customerEmail)}</div></div>
            <div><span class="doc__label">Vehicle</span><div><b>${esc(job.vehicle.year + " " + job.vehicle.make + " " + job.vehicle.model)}</b><br>${esc(job.vehicle.plate)}</div></div>
          </div>

          ${linesTable(inv)}

          <div class="card__body" style="padding:16px 0 0">
            <div class="totals">
              <div class="totals__row"><span>Subtotal <span class="sub">(excl. tax)</span></span><span>${money(inv.subtotal)}</span></div>
              ${taxBlock(inv.taxes)}
              <div class="totals__row totals__row--major"><span>Total</span><span>${money(inv.total)}</span></div>
              ${inv.carriedPaid > 0 ? `<div class="totals__row totals__row--carried"><span>Paid on consolidated invoices <span class="sub">(${(inv.combinedFromInvoiceIds || []).length} documents)</span></span><span>&minus;${money(inv.carriedPaid)}</span></div>` : ""}
              ${inv.refunded > 0 ? `<div class="totals__row"><span>Refunded</span><span>${money(inv.refunded)}</span></div>` : ""}
              <div class="totals__row totals__row--due ${inv.balance === 0 ? "is-zero" : "is-due"}">
                <span>Remaining balance</span><span>${money(inv.balance)}</span>
              </div>
            </div>
            ${receiptRows(inv)}
          </div>

          ${
            credits.length
              ? `
          <div class="card__body" style="padding:14px 0 0;border-top:1px dashed var(--line);margin-top:14px">
            <div class="sub" style="font-weight:650;color:var(--ink-2);margin-bottom:6px">Credit notes</div>
            ${credits.map((c) => `<div class="sub">${esc(c.no)} · ${money(c.amount)} · ${fmtDay(c.issuedAt)} · ${esc(c.reason)}</div>`).join("")}
          </div>`
              : ""
          }
        </div>

        <div class="card__foot">
          ${
            inv.kind === "TAX_INVOICE" && inv.balance > 0
              ? btn(
                  `Record payment (${money(inv.balance)})`,
                  "payModal",
                  inv.id,
                  "btn btn--primary",
                )
              : `<span class="turn-hint">${inv.kind === "TAX_INVOICE" ? "Settled in full." : "Zero-dollar warranty document."}</span>`
          }
          ${stale && S.role === "garage" ? btn("Generate invoice for new work", "generateInvoices", job.id, "btn btn--primary") : ""}
          ${btn("Download", "downloadDoc", inv.id, "btn btn--ghost btn--sm", `title="Print to PDF or download a standalone copy"`)}
          ${
            inv.kind === "TAX_INVOICE" &&
            inv.amountPaid === 0 &&
            S.role === "garage"
              ? btn(
                  "Void invoice",
                  "voidInvoiceModal",
                  inv.id,
                  "btn btn--danger-soft",
                )
              : ""
          }
          <span class="spacer"></span>
          <span class="sub">A voided document is never payable — combine or reissue to change what is owed.</span>
        </div>
      </div>`;
  }

  /* =========================================================
     INVOICE VERSION HISTORY
     A tax invoice is never edited or deleted. Every payment issues a new
     version and voids the one before it, so the chain stays auditable.
     ========================================================= */
  /*
     Voided documents: collapsed by default so the live invoice stays the focus.
     Opening the block lists the history; each row opens its frozen document.
  */
  function versionHistory(job, voided) {
    const rows = voided
      .map(
        (v) => `
        <tr>
          <td><span class="tag">v${v.seq || 1}</span></td>
          <td><span class="mono">${esc(v.no)}</span></td>
          <td class="sub nowrap">${fmtDay(v.issuedAt)}</td>
          <td class="sub nowrap">${fmtDay(v.voidedAt)}</td>
          <td class="num">${money(v.total)}</td>
          <td class="num sub">${money(v.amountPaid || 0)}</td>
          <td class="sub">${esc(v.voidReason || "—")}</td>
          <td class="sub">${v.supersededBy ? `<span class="mono">${esc((sel.invoice(v.supersededBy) || {}).no || "—")}</span>` : "nothing"}</td>
        </tr>`,
      )
      .join("");

    return `
      <details class="voided-acc">
        <summary>
          <span class="voided-acc__chev">&#9656;</span>
          <span class="voided-acc__title">Voided invoices</span>
          <span class="voided-acc__count">${voided.length}</span>
          <span class="voided-acc__hint">Kept for the audit trail — never payable, never deleted</span>
        </summary>
        <div class="voided-acc__body">
          <table class="table">
            <thead><tr>
              <th>Version</th><th>Document</th><th>Issued</th><th>Voided</th>
              <th class="num">Total then</th><th class="num">Paid then</th><th>Reason</th><th>Replaced by</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="voided-acc__docs">
            ${voided
              .map(
                (v) => `
              <details class="voided-doc">
                <summary>
                  <span class="voided-acc__chev">&#9656;</span>
                  <span class="mono">${esc(v.no)}</span>
                  <span class="sub">· version ${v.seq || 1} · voided ${fmtDay(v.voidedAt)} · ${money(v.total)}</span>
                </summary>
                ${voidedDoc(job, v)}
              </details>`,
              )
              .join("")}
          </div>
        </div>
      </details>`;
  }

  /* A voided document: full detail, read-only, never payable. */
  function voidedDoc(job, inv) {
    return `
      <div class="card">
        <div class="card__body" style="padding-bottom:0">
          ${banner(
            "warn",
            "&#9888;",
            `<b>Void — not payable.</b> ${esc(inv.voidReason || "Voided.")}
             This document is kept for the audit trail only; nothing can be paid against it.`,
          )}
        </div>
        <div class="doc doc--void">
          <div class="doc__top">
            <div>
              <div class="doc__label">Void invoice · version ${inv.seq || 1}</div>
              <div class="doc__no">${esc(inv.no)}</div>
              <div class="sub" style="margin-top:4px">${esc(job.garageName)} &middot; ${esc(job.jobNo)}</div>
            </div>
            <div class="doc__meta">
              <div>${pill("VOID")}</div>
              <div style="margin-top:8px">Issued <b>${fmtDay(inv.issuedAt)}</b></div>
              <div>Voided <b>${fmtDay(inv.voidedAt)}</b></div>
              ${inv.supersededBy ? `<div>Replaced by <b>${esc((sel.invoice(inv.supersededBy) || {}).no || "—")}</b></div>` : "<div>Not replaced</div>"}
            </div>
          </div>

          <div class="doc__parties">
            <div><span class="doc__label">Billed to</span><div><b>${esc(job.customerName)}</b><br>${esc(job.customerEmail)}</div></div>
            <div><span class="doc__label">Vehicle</span><div><b>${esc(job.vehicle.year + " " + job.vehicle.make + " " + job.vehicle.model)}</b><br>${esc(job.vehicle.plate)}</div></div>
          </div>

          ${linesTable(inv)}

          <div class="card__body" style="padding:16px 0 0">
            <div class="totals">
              <div class="totals__row"><span>Subtotal <span class="sub">(excl. tax)</span></span><span>${money(inv.subtotal)}</span></div>
              ${taxBlock(inv.taxes)}
              <div class="totals__row totals__row--major"><span>Total as issued</span><span>${money(inv.total)}</span></div>
              ${inv.carriedPaid > 0 ? `<div class="totals__row"><span>Carried forward from earlier invoices</span><span>${money(inv.carriedPaid)}</span></div>` : ""}
              <div class="totals__row totals__row--paid"><span>Paid at the time it was voided</span><span>&minus;${money(inv.amountPaid || 0)}</span></div>
              <div class="totals__row"><span>Balance then</span><span>${money(inv.balance || 0)}</span></div>
            </div>
          </div>
        </div>
        <div class="card__foot">
          <span class="sub">Frozen snapshot — later payments and later invoice versions do not change these numbers.</span>
        </div>
      </div>`;
  }

  /* =========================================================
     PAYMENTS
     ========================================================= */
  function viewPayments(job) {
    /* Voided versions are history: money is only ever collected on the live one. */
    const invs = sel
      .invoicesForJob(job.id)
      .filter((i) => i.kind === "TAX_INVOICE" && i.status !== "VOID");
    if (!invs.length) {
      return empty(
        "No payments possible yet",
        "A live tax invoice must exist before money can be taken. Proformas are informational only, and voided invoices can never be paid.",
      );
    }
    const totals = sel.jobTotals(job.id);

    const rows = sel
      .paymentsForJob(job.id)
      .map((p) => {
        const rc = sel.receiptForPayment(p.id);
        const inv = sel.invoice(p.invoiceId);
        return `<tr>
        <td><span class="mono">${esc(p.no)}</span><div class="sub">${esc(p.type)} · ${esc(p.method)}</div></td>
        <td>
          <span class="mono">${esc(inv ? inv.no : "—")}</span>
          ${
            inv && inv.status === "VOID"
              ? `<div class="sub">void${
                  inv.supersededBy
                    ? " · replaced by " +
                      esc(
                        (sel.invoice(inv.supersededBy) || {}).no ||
                          "a later version",
                      )
                    : " · not replaced"
                }</div>`
              : ""
          }
        </td>
        <td class="num">${money(p.amount)}</td>
        <td class="num sub">${money(sel.balanceAfter(p.id))}</td>
        <td>${pill(p.status)}</td>
        <td class="sub nowrap">${fmtDateTime(p.paidAt)}</td>
        <td>${
          rc
            ? `<button class="link" data-act="receiptModal" data-id="${rc.id}">${esc(rc.no)}</button>${
                rc.status === "VOID" ? ' <span class="sub">(void)</span>' : ""
              }`
            : "—"
        }</td>
        <td class="nowrap">
          ${
            ["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status) &&
            S.role === "customer"
              ? btn(
                  "Request refund",
                  "refundRequestModal",
                  p.id,
                  "btn btn--ghost btn--sm",
                )
              : ""
          }
          ${
            ["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status) &&
            S.role === "garage"
              ? btn(
                  "Issue refund",
                  "refundIssueModal",
                  p.id,
                  "btn btn--ghost btn--sm",
                )
              : ""
          }
        </td>
      </tr>`;
      })
      .join("");

    const payCards = invs
      .map((inv) => {
        const depOutstanding = Math.max(
          0,
          inv.depositRequired - inv.amountPaid,
        );
        return `
        <div class="card">
          <div class="card__head">
            <div>
              <div class="card__title">${esc(inv.no)} ${pill(inv.status)}</div>
              <div class="card__sub">Total ${money(inv.total)} · paid ${money(inv.amountPaid)} · remaining ${money(inv.balance)}</div>
            </div>
          </div>
          <div class="card__body">
            ${
              depOutstanding > 0
                ? banner(
                    "info",
                    "&#128176;",
                    `<b>Upfront deposit required:</b> ${money(depOutstanding)} before work begins
               (${inv.depositType === "PERCENT" ? inv.depositValue + "% of total" : "flat fee"}).`,
                  )
                : ""
            }
            ${inv.balance === 0 ? banner("ok", "&#10003;", "<b>Fully paid.</b> Vehicle Hold released — the vehicle may be collected.") : ""}
            <div class="row">
              ${
                inv.balance > 0 && depOutstanding > 0
                  ? btn(
                      `Pay deposit · ${money(depOutstanding)}`,
                      "payModal",
                      inv.id,
                      "btn btn--primary",
                    )
                  : ""
              }
              ${
                inv.balance > 0 && depOutstanding === 0
                  ? btn(
                      `Pay balance · ${money(inv.balance)}`,
                      "payModal",
                      inv.id,
                      "btn btn--primary",
                    )
                  : ""
              }
              ${inv.balance > 0 ? btn("Other amount / milestone", "payModal", inv.id, "btn btn--ghost btn--sm") : ""}
            </div>
          </div>
        </div>`;
      })
      .join("");

    return `
      ${
        invs.length > 1
          ? `<div class="card summary">
        <div class="card__body">
          <div class="row" style="align-items:flex-end;gap:28px">
            <div><div class="kpi__label">Total across ${invs.length} live invoices</div>
              <div class="kpi__value">${money(totals.total)}</div></div>
            <div><div class="kpi__label">Paid</div>
              <div class="kpi__value">${money(totals.paid)}</div></div>
            <div><div class="kpi__label">Remaining balance</div>
              <div class="kpi__value ${totals.balance > 0 ? "is-due" : "is-ok"}">${money(totals.balance)}</div></div>
          </div>
        </div>
      </div>`
          : ""
      }
      ${payCards}
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Payment ledger</div>
            <div class="card__sub">Every transaction on this job. A receipt is generated automatically on success.</div>
          </div>
        </div>
        ${
          rows
            ? `
        <table class="table">
          <thead><tr>
            <th>Payment</th><th>Invoice</th><th class="num">Amount</th><th class="num">Remaining after</th><th>Status</th><th>Paid</th><th>Receipt</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`
            : `<div class="card__body">${empty("No payments yet", "Record a deposit or balance payment above.")}</div>`
        }
      </div>`;
  }

  /* =========================================================
     REFUNDS
     ========================================================= */
  function viewRefunds(job) {
    const refunds = sel.refundsForJob(job.id);
    const paidPayments = sel
      .paymentsForJob(job.id)
      .filter((p) => ["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status));

    const rows = refunds
      .map((r) => {
        const p = sel.payment(r.paymentId);
        const cn = r.creditNoteId
          ? S.creditNotes.find((c) => c.id === r.creditNoteId)
          : null;
        return `<tr>
        <td><div>${esc(p ? p.no : "—")}</div><div class="sub">${esc(r.type)} refund · ${esc(r.reason)}</div></td>
        <td class="num">${money(r.amount)}</td>
        <td>${pill(r.status)}</td>
        <td class="sub">${esc(r.requestedBy)} · ${fmtDateTime(r.createdAt)}</td>
        <td>${cn ? `<span class="mono">${esc(cn.no)}</span>` : '<span class="sub">—</span>'}</td>
        <td class="nowrap">
          ${
            S.role === "garage" && r.status === "REQUESTED"
              ? `${btn("Approve", "refundApprove", r.id, "btn btn--ok btn--sm")}
               ${btn("Decline", "refundDecline", r.id, "btn btn--danger-soft btn--sm")}`
              : ""
          }
          ${
            S.role === "garage" && r.status === "PROCESSING"
              ? btn(
                  "Mark completed",
                  "refundComplete",
                  r.id,
                  "btn btn--primary btn--sm",
                )
              : ""
          }
        </td>
      </tr>`;
      })
      .join("");

    return `
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Refunds</div>
            <div class="card__sub">A completed refund always generates a Credit Note so the books stay balanced.</div>
          </div>
        </div>
        ${
          rows
            ? `
        <table class="table">
          <thead><tr><th>Payment</th><th class="num">Amount</th><th>Status</th><th>Requested</th><th>Credit note</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
            : `<div class="card__body">${empty("No refunds", "None requested or issued for this job.")}</div>`
        }
      </div>

      ${
        S.role === "customer" && paidPayments.length
          ? `
      <div class="card">
        <div class="card__head"><div><div class="card__title">Request a refund</div>
          <div class="card__sub">The garage must approve before money moves.</div></div></div>
        <div class="card__body">
          <div class="row">
            ${paidPayments.map((p) => btn(`Refund ${p.no} · ${money(p.amount)}`, "refundRequestModal", p.id, "btn btn--ghost btn--sm")).join("")}
          </div>
        </div>
      </div>`
          : ""
      }`;
  }

  /* =========================================================
     AUDIT
     ========================================================= */
  function viewAudit(job) {
    const tl = sel.timelineForJob(job.id);
    if (!tl.length)
      return empty(
        "No activity yet",
        "Every quote, document, payment and refund action lands here.",
      );

    return `
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Audit trail</div>
            <div class="card__sub">Append-only log — the record both parties can rely on if there is a dispute.</div>
          </div>
        </div>
        <div class="card__body">
          <ul class="timeline">
            ${tl
              .map((e) => {
                const who = e.actor.toLowerCase();
                const delta =
                  e.amountBefore !== null &&
                  e.amountAfter !== null &&
                  e.amountBefore !== e.amountAfter
                    ? `${money(e.amountBefore)} &rarr; ${money(e.amountAfter)}`
                    : e.amountAfter !== null && e.amountAfter !== undefined
                      ? money(e.amountAfter)
                      : "";
                return `<li class="is-${who}">
                <div class="tl__head">
                  <span class="tl__action">${esc(e.action.replace(/_/g, " "))}</span>
                  <span class="tl__actor is-${who}">${esc(e.actor)}</span>
                  <span class="tl__time">${fmtDateTime(e.at)}</span>
                </div>
                ${e.note ? `<div class="tl__note">${esc(e.note)}</div>` : ""}
                ${delta ? `<div class="tl__delta">${delta}</div>` : ""}
              </li>`;
              })
              .join("")}
          </ul>
        </div>
      </div>`;
  }

  /* =========================================================
     QUOTE BUILDER (full screen, garage)
     ========================================================= */
  function viewBuilder() {
    const q = sel.quote(S.builderQuoteId);
    if (!q) {
      return empty(
        "No quote open",
        "Start one from a job.",
        btn("Back to jobs", "closeBuilder", null, "btn btn--primary"),
      );
    }

    const job = sel.job(q.jobId);
    const totals = quoteTotals(q);
    const cats = ["all", ...new Set(S.services.map((s) => s.category))];
    const search = (S.builderSearch || "").toLowerCase();
    const services = S.services.filter((s) => {
      const inCat = S.builderCat === "all" || s.category === S.builderCat;
      const inSearch =
        !search ||
        s.name.toLowerCase().includes(search) ||
        s.category.toLowerCase().includes(search);
      return inCat && inSearch;
    });

    const title =
      q.type === "SUPPLEMENTARY"
        ? "New add-on quote"
        : q.type === "WARRANTY"
          ? "Warranty quote"
          : "New quote";

    /* ---------- catalog panel ---------- */
    const side = `
      <div class="builder__side card">
        <div class="card__head">
          <div>
            <div class="card__title">Service catalog</div>
            <div class="card__sub">Click a service to add it to the quote</div>
          </div>
        </div>
        <div class="card__body" style="padding-bottom:10px">
          <input id="svcSearch" class="svc-search" type="text" placeholder="Search services…"
                 value="${esc(S.builderSearch)}" autocomplete="off">
          <div class="svc-cats">
            ${cats
              .map(
                (
                  c,
                ) => `<button type="button" class="svc-cat ${S.builderCat === c ? "is-active" : ""}"
              data-act="builderCat" data-id="${esc(c)}">${c === "all" ? "All" : esc(c)}</button>`,
              )
              .join("")}
          </div>
        </div>
        <div class="svc-list" id="svcList">
          ${
            services.length
              ? services
                  .map(
                    (s) => `
            <button type="button" class="svc-row" data-act="builderAddService" data-id="${s.id}"
                    data-name="${esc(s.name.toLowerCase())}" data-cat="${esc(s.category.toLowerCase())}">
              <span class="svc-row__name">${esc(s.name)}</span>
              <span class="svc-row__meta"><span class="taxchip">${esc(s.taxCode || "none")}</span> ${money(s.price)}</span>
              <span class="svc-row__add">+</span>
            </button>`,
                  )
                  .join("")
              : `<div class="sub" style="padding:16px 12px">Nothing matches that search.</div>`
          }
        </div>
        <div class="card__foot">
          ${btn("+ Create new service", "builderNewService", q.id, "btn btn--ghost btn--sm")}
        </div>
      </div>`;

    /* ---------- lines panel ---------- */
    const taxOptions = (line) =>
      `<option value="">No tax</option>` +
      activeTaxes()
        .map(
          (tx) =>
            `<option value="${tx.id}" ${line.taxId === tx.id ? "selected" : ""}>${esc(tx.code)} · ${esc(taxRateLabel(tx))}${tx.inclusive ? " (incl.)" : ""}</option>`,
        )
        .join("");

    const rows = q.items.length
      ? q.items
          .map(
            (i) => `
      <tr>
        <td><input type="text" data-item-id="${i.id}" data-quote-id="${q.id}" data-field="description" value="${esc(i.description)}"></td>
        <td class="num" style="width:72px"><input class="num-input" type="number" step="0.5" min="0"
            data-item-id="${i.id}" data-quote-id="${q.id}" data-field="qty" value="${i.qty}"></td>
        <td class="num" style="width:96px"><input class="num-input" type="number" step="0.01" min="0"
            data-item-id="${i.id}" data-quote-id="${q.id}" data-field="unitPrice" value="${(i.unitPrice / 100).toFixed(2)}"></td>
        <td style="width:150px">
          <select class="tax-select" data-tax-select data-quote-id="${q.id}" data-item-id="${i.id}">${taxOptions(i)}</select>
        </td>
        <td class="num" id="lt-${i.id}" style="width:92px">${money(lineTotal(i))}</td>
        <td style="width:36px"><button type="button" class="icon-btn" data-act="builderRemove" data-id="${i.id}">&#10005;</button></td>
      </tr>`,
          )
          .join("")
      : `<tr><td colspan="6"><div class="sub" style="padding:18px 0;text-align:center">
           No lines yet — pick a service on the left, or add a blank line below.
         </div></td></tr>`;

    const dep = depositFor(q);
    const showDeposit = q.type === "STANDARD" || q.type === "SUPPLEMENTARY";

    const main = `
      <div class="builder__main card">
        <div class="card__head">
          <div>
            <div class="card__title">Quote lines <span class="sub">${q.items.length}</span></div>
            <div class="card__sub">Everything is editable — description, quantity, price and tax.</div>
          </div>
        </div>

        <table class="table">
          <thead><tr>
            <th>Description</th><th class="num">Qty</th><th class="num">Price</th>
            <th>Tax</th><th class="num">Amount</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <div class="card__body" style="padding:10px 18px">
          ${btn("+ Blank custom line", "builderBlank", null, "btn btn--ghost btn--sm")}
        </div>

        <div class="card__body" style="border-top:1px solid var(--line)">
          <div class="totals">
            <div class="totals__row"><span>Subtotal <span class="sub">(excl. tax)</span></span><span>${money(totals.subtotal)}</span></div>
            ${taxBlock(totals.taxes)}
            <div class="totals__row totals__row--major"><span>Total</span><span id="qtotal-${q.id}">${money(totals.total)}</span></div>
            ${dep > 0 ? `<div class="totals__row"><span>Deposit</span><span>${money(dep)}</span></div>` : ""}
          </div>
        </div>

        <div class="card__foot">
          ${
            showDeposit
              ? `
            <label class="inline-field">Deposit
              <select data-deposit-type data-quote-id="${q.id}">
                <option value="NONE" ${q.depositType === "NONE" ? "selected" : ""}>None</option>
                <option value="PERCENT" ${q.depositType === "PERCENT" ? "selected" : ""}>Percent %</option>
                <option value="FLAT" ${q.depositType === "FLAT" ? "selected" : ""}>Flat $</option>
              </select>
              <input type="number" min="0" step="0.5" data-deposit-value data-quote-id="${q.id}"
                     value="${q.depositValue || 0}" ${q.depositType === "NONE" ? "disabled" : ""}>
            </label>`
              : ""
          }
          ${
            q.type === "SUPPLEMENTARY"
              ? `
            <label class="checkline" style="margin:0">
              <input type="checkbox" data-act="toggleDependency" data-id="${q.id}" ${q.hasDependency ? "checked" : ""}>
              <span>Blocks ongoing work</span>
            </label>`
              : ""
          }
          ${btn("+ Condition", "addCondition", q.id, "btn btn--ghost btn--sm")}
          <span class="spacer"></span>
          ${btn("Back to job", "closeBuilder", null)}
          ${btn("Save as draft", "builderSaveDraft", null)}
          ${btn("Send to customer", "builderSend", null, "btn btn--primary")}
        </div>
      </div>`;

    return `
      <div class="page-head">
        <div>
          <button type="button" class="link" data-act="closeBuilder">&larr; Back to job</button>
          <h2 style="margin-top:6px">${esc(title)} · <span class="mono">${esc(q.no)}</span></h2>
          <p class="sub">${esc(job.jobNo)} · ${esc(job.vehicle.year + " " + job.vehicle.make + " " + job.vehicle.model)} · ${esc(job.vehicle.plate)}</p>
        </div>
        <div class="row">${pill(q.status)}</div>
      </div>

      ${
        q.type === "WARRANTY"
          ? banner(
              "info",
              "&#8505;",
              "Warranty rework — every line is priced at <b>$0.00</b>. Accepting produces a zero-dollar invoice.",
            )
          : ""
      }

      <div class="builder">
        ${side}
        ${main}
      </div>`;
  }

  /* =========================================================
     TAXES SCREEN
     ========================================================= */
  function viewTaxes() {
    const active = S.taxes.filter((t) => t.active);
    const history = S.taxes.filter((t) => !t.active);
    const appliesLabel = (t) =>
      t.appliesTo && t.appliesTo.length
        ? t.appliesTo.join(", ")
        : "manual only";

    const row = (t, isActive) => `
      <tr>
        <td><span class="mono">${esc(t.code)}</span>${t.inclusive ? ' <span class="tag tag--war">incl.</span>' : ""}</td>
        <td>${esc(t.name)}</td>
        <td>${t.kind === "PERCENT" ? "Percent" : "Fixed"}</td>
        <td class="num"><b>${taxRateLabel(t)}</b></td>
        <td class="sub">${esc(appliesLabel(t))}</td>
        <td class="sub nowrap">${fmtDay(t.effectiveFrom)}${t.effectiveTo ? " → " + fmtDay(t.effectiveTo) : ""}</td>
        <td>${isActive ? pill("ISSUED") : pill("SUPERSEDED")}</td>
        <td class="nowrap">
          ${
            isActive
              ? `${btn("Change rate", "taxModal", t.id, "btn btn--ghost btn--sm")}
                         ${btn("Deactivate", "taxDeactivate", t.id, "btn btn--danger-soft btn--sm")}`
              : ""
          }
        </td>
      </tr>`;

    return `
      <div class="page-head">
        <div>
          <h2>Taxes</h2>
          <p class="sub">Rates are versioned. Changing a rate closes the old one and opens a new one — existing
             quotes and invoices keep the rate they were written with.</p>
        </div>
        ${btn("+ New tax", "taxModal", null, "btn btn--primary")}
      </div>

      <div class="card">
        <div class="card__head"><div><div class="card__title">Active rates</div>
          <div class="card__sub">Offered on every new quote line. Defaults are routed by line type.</div></div></div>
        <table class="table">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th class="num">Value</th><th>Applies to</th><th>Effective</th><th>Status</th><th></th></tr></thead>
          <tbody>${active.map((t) => row(t, true)).join("")}</tbody>
        </table>
      </div>

      ${
        history.length
          ? `
      <div class="card">
        <div class="card__head"><div><div class="card__title">History</div>
          <div class="card__sub">Superseded rates. Still referenced by documents issued while they were live.</div></div></div>
        <table class="table">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th class="num">Value</th><th>Applies to</th><th>Effective</th><th>Status</th><th></th></tr></thead>
          <tbody>${history.map((t) => row(t, false)).join("")}</tbody>
        </table>
      </div>`
          : ""
      }

      <div class="card">
        <div class="card__body">
          ${banner(
            "info",
            "&#8505;",
            `<b>Why a snapshot?</b> Every quote and invoice line stores the tax code, type and value it was written with.
             Re-rating a tax therefore cannot change a document that has already been sent.`,
          )}
          <div class="sub">Totals are always re-computed on the server from the line snapshots — never trusted from the browser.</div>
        </div>
      </div>`;
  }

  /* =========================================================
     SERVICE CATALOG SCREEN
     ========================================================= */
  function viewCatalog() {
    const cats = [...new Set(S.services.map((s) => s.category))];
    return `
      <div class="page-head">
        <div>
          <h2>Service catalog</h2>
          <p class="sub">Dummy services the garage can drop straight into a quote. Each carries a default price and tax.</p>
        </div>
        ${btn("+ New service", "serviceModal", null, "btn btn--primary")}
      </div>

      ${cats
        .map(
          (cat) => `
        <div class="card">
          <div class="card__head"><div><div class="card__title">${esc(cat)}</div></div></div>
          <table class="table">
            <thead><tr><th>Service</th><th class="num">Default price</th><th>Unit</th><th>Default tax</th><th></th></tr></thead>
            <tbody>
              ${S.services
                .filter((s) => s.category === cat)
                .map(
                  (s) => `
                <tr>
                  <td><b>${esc(s.name)}</b></td>
                  <td class="num">${money(s.price)}</td>
                  <td class="sub">${esc(s.unit || "job")}</td>
                  <td><span class="taxchip">${esc(s.taxCode || "none")}</span></td>
                  <td class="nowrap">
                    ${btn("Edit", "serviceModal", s.id, "btn btn--ghost btn--sm")}
                    ${btn("Remove", "serviceRemove", s.id, "btn btn--danger-soft btn--sm")}
                  </td>
                </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>`,
        )
        .join("")}`;
  }

  /* =========================================================
     PUBLIC
     ========================================================= */
  function render() {
    renderSidebar();
    renderMain();
  }

  global.Views = { render, printableDoc };
})(window);
