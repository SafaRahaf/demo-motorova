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

  const isMyTurn = (q) =>
    (q.status === "PENDING_CUSTOMER_APPROVAL" && S.role === "customer") ||
    (q.status === "PENDING_GARAGE_APPROVAL" && S.role === "garage") ||
    (q.status === "DRAFT" && S.role === "garage");

  const isOpen = (q) =>
    ["DRAFT", "PENDING_GARAGE_APPROVAL", "PENDING_CUSTOMER_APPROVAL"].includes(
      q.status,
    );

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
        : "";

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
    const pro = sel.openProforma(job.id);
    const cancel = sel.openCancellation(job.id);

    const kpis = `
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">Open quote</div>
          <div class="kpi__value">${active ? money(quoteTotals(active).total) : "—"}</div>
          <div class="kpi__hint">${active ? esc(active.no + " · " + (STATUS[active.status] || [active.status])[0]) : "No quote in play"}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">${inv ? (S.role === "customer" ? "Bill total" : "Invoice total") : "Proforma"}</div>
          <div class="kpi__value">${inv ? money(inv.total) : pro ? money(pro.total) : "—"}</div>
          <div class="kpi__hint">${inv ? esc(inv.no + " · " + inv.status.replace("_", " ")) : pro ? esc(pro.no + " · proforma") : "No document yet"}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">Remaining balance</div>
          <div class="kpi__value ${inv && inv.balance > 0 ? "is-due" : "is-ok"}">${inv ? money(inv.balance) : "—"}</div>
          <div class="kpi__hint">${inv ? "Paid " + money(inv.amountPaid) + (inv.refunded ? " · Refunded " + money(inv.refunded) : "") : "Nothing payable yet"}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">Vehicle hold</div>
          <div class="kpi__value ${inv && inv.vehicleHold ? "is-due" : "is-ok"}">${inv ? (inv.vehicleHold ? "ON" : "OFF") : "—"}</div>
          <div class="kpi__hint">${inv && inv.vehicleHold ? "Keys cannot be released" : "Release permitted"}</div>
        </div>
      </div>`;

    let holdBanner = "";
    if (inv && inv.vehicleHold) {
      holdBanner = banner(
        "hold",
        "&#128274;",
        `<b>Vehicle Hold active.</b> ${money(inv.balance)} still owed on ${esc(inv.no)}.
         Garage staff must not release the vehicle or keys until the balance reaches $0.00.`,
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
  function viewBill(job) {
    const inv = sel.stdInvoice(job.id);
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
    const built = buildLines(job.id);
    const label = S.role === "customer" ? "bill" : "invoice";

    /* nothing issued yet */
    if (!inv && !pro) {
      if (!built.base) {
        return empty(
          "No " + label + " yet",
          "A document can only be issued once a quote is accepted.",
        );
      }
      const acceptedWarranty = sel
        .quotesForJob(job.id)
        .find(
          (q) =>
            q.type === "WARRANTY" && q.status === "ACCEPTED" && !q.invoicedAt,
        );
      return `
        <div class="card">
          <div class="card__head">
            <div>
              <div class="card__title">Quote accepted — no document issued yet</div>
              <div class="card__sub">
                ${esc(built.base.no)} locked at ${money(docTotals(built.lines).total)}.
                Nothing is payable until the garage issues a tax invoice.
              </div>
            </div>
          </div>
          <div class="card__body">
            ${
              S.role === "garage"
                ? banner(
                    "info",
                    "&#8505;",
                    `<b>Choose a document.</b> A <b>proforma</b> is informational — it shows the customer what they will be billed.
                   A <b>tax invoice</b> is the payable document that creates the balance and the Vehicle Hold.`,
                  )
                : banner(
                    "info",
                    "&#8505;",
                    "The garage has not issued a bill yet. You will be notified when it arrives.",
                  )
            }
          </div>
          <div class="card__foot">
            ${
              S.role === "garage"
                ? `
              ${
                acceptedWarranty
                  ? btn(
                      "Generate warranty invoice ($0.00)",
                      "generateInvoice",
                      job.id,
                      "btn btn--primary",
                    )
                  : `${btn("Generate proforma", "generateProforma", job.id)}
                   ${btn("Generate invoice", "generateInvoice", job.id, "btn btn--primary")}`
              }`
                : ""
            }
            <span class="spacer"></span>
            <span class="sub">Nothing is created automatically.</span>
          </div>
        </div>
        ${voidedDocs.length ? versionHistory(job, voidedDocs) : ""}`;
    }

    return `
      ${pro ? proformaDoc(job, pro) : ""}
      ${inv ? invoiceDoc(job, inv) : ""}
      ${warrantyDocs.map((d) => invoiceDoc(job, d)).join("")}
      ${voidedDocs.length ? versionHistory(job, voidedDocs) : ""}
      ${
        supersededPros.length
          ? `
        <div class="card">
          <div class="card__body">
            <div class="card__sub" style="font-weight:650;color:var(--ink-2);margin-bottom:6px">Superseded proformas</div>
            ${supersededPros.map((p) => `<div class="sub">${esc(p.no)} · ${money(p.total)} · ${esc(p.status.toLowerCase())}${p.supersededBy ? " by " + esc((sel.invoice(p.supersededBy) || {}).no || "") : ""}</div>`).join("")}
          </div>
        </div>`
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
          ${S.role === "garage" ? btn("Convert to tax invoice", "generateInvoice", job.id, "btn btn--primary") : ""}
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
                `<b>Accepted work not yet billed.</b> The invoice is out of date by ${money(Math.abs(stale.delta))}
           (${stale.lines > 0 ? "+" : ""}${stale.lines} line${Math.abs(stale.lines) === 1 ? "" : "s"}).
           Regenerate it to include the add-on work.`,
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
              ${inv.depositRequired > 0 ? `<div class="totals__row"><span>Deposit required upfront</span><span>${money(inv.depositRequired)}</span></div>` : ""}
              <div class="totals__row totals__row--paid"><span>Paid to date</span><span>&minus;${money(inv.amountPaid)}</span></div>
              ${inv.refunded > 0 ? `<div class="totals__row"><span>Refunded</span><span>${money(inv.refunded)}</span></div>` : ""}
              <div class="totals__row totals__row--due ${inv.balance === 0 ? "is-zero" : "is-due"}">
                <span>Remaining balance</span><span>${money(inv.balance)}</span>
              </div>
            </div>
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
          ${stale && S.role === "garage" ? btn("Update invoice", "generateInvoice", job.id, "btn btn--primary") : ""}
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
          <span class="sub">The database row is always <code>Invoice</code>; the label changes per viewer.</span>
        </div>
      </div>`;
  }

  /* =========================================================
     INVOICE VERSION HISTORY
     A tax invoice is never edited or deleted. Every payment issues a new
     version and voids the one before it, so the chain stays auditable.
     ========================================================= */
  function versionHistory(job, voided) {
    return `
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Voided versions</div>
            <div class="card__sub">Kept, never deleted. A paid document is replaced by a new version — an unpaid one can be voided outright.</div>
          </div>
        </div>
        <table class="table">
          <thead><tr>
            <th>Version</th><th>Document</th><th>Issued</th><th>Voided</th>
            <th class="num">Total then</th><th class="num">Paid then</th><th>Reason</th><th>Replaced by</th>
          </tr></thead>
          <tbody>
            ${voided
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
              .join("")}
          </tbody>
        </table>
        <div class="card__foot">
          <span class="sub">Each version below is frozen at the figures it had when it was voided.</span>
        </div>
      </div>
      ${voided.map((v) => voidedDoc(job, v)).join("")}`;
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
            <th>Payment</th><th>Invoice</th><th class="num">Amount</th><th>Status</th><th>Paid</th><th>Receipt</th><th></th>
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
    document
      .querySelectorAll("#roleSwitch button")
      .forEach((b) =>
        b.classList.toggle("is-active", b.dataset.role === S.role),
      );
    renderSidebar();
    renderMain();
  }

  global.Views = { render };
})(window);
