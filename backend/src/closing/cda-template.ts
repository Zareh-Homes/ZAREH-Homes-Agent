/**
 * Print-ready Commission Disbursement Authorization (HTML + CSS, US Letter).
 *
 * Two audiences:
 *   lawyer   – what the closing lawyer (or listing brokerage) needs to pay
 *   internal – the same, plus each agent's commission statement and the
 *              brokerage's HST position
 *
 * Every value is HTML-escaped. No external fonts, scripts or images, so the
 * file prints identically anywhere and can be archived as-is.
 */

import type { AgentClosingLine, ClosingComputation, Taxed } from "./calculate.ts";

const SIDE_TEXT = { LISTING: "Represents the seller", BUYER: "Represents the buyer", BOTH: "Represents seller and buyer" } as const;

export interface BrokerageProfile {
  legalName: string;
  address: string;
  phone: string;
  email: string;
  hstNumber: string;
  recoRegistration: string | null;
  brokerOfRecord: string;
}

export interface CdaRenderOptions {
  audience: "lawyer" | "internal";
  status: "DRAFT" | "FINAL";
  issuedOn: string; // YYYY-MM-DD
  computationSha?: string;
  replaces?: { cdaNumber: string; reason: string }; // a reissue after a void
}

const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (cents: number): string => {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-CA")}.${String(abs % 100).padStart(2, "0")}`;
};

const longDate = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

const SIDE_LABEL: Record<string, string> = {
  LISTING: "Listing Brokerage",
  BUYER: "Buyer's (Co-operating) Brokerage",
  // Whether this is multiple representation depends on the representation agreements, not on both sides being ours
  DUAL: "Listing and Buyer's Brokerage (seller and buyer are both clients of this brokerage)",
  LANDLORD: "Listing Brokerage (lease, landlord's brokerage)",
  TENANT: "Tenant's (Co-operating) Brokerage (lease)",
};

function taxedRow(label: string, t: Taxed, note = ""): string {
  return `<tr><td>${esc(label)}${note ? `<div class="note">${esc(note)}</div>` : ""}</td>
    <td class="num">${money(t.base)}</td><td class="num">${money(t.hst)}</td><td class="num">${money(t.total)}</td></tr>`;
}

const PROVINCES: Record<string, string> = {
  ON: "Ontario", QC: "Quebec", NS: "Nova Scotia", NB: "New Brunswick", MB: "Manitoba", BC: "British Columbia", PE: "Prince Edward Island",
  SK: "Saskatchewan", AB: "Alberta", NL: "Newfoundland and Labrador", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
};

function agentStatement(a: AgentClosingLine, rate: number, brokerageName: string, tax: string): string {
  const feeRows = a.fees.map((f) =>
    `<tr><td class="indent">Less: ${esc(f.name)}</td><td class="num">−${money(f.base)}</td><td class="num">−${money(f.hst)}</td><td class="num">−${money(f.total)}</td></tr>`).join("");
  const adjustmentRows = (a.adjustments ?? []).map((x) => {
    const sign = x.kind === "BONUS" ? "" : "−";
    const label = x.kind === "BONUS" ? "Plus" : x.kind === "RECOVERY" ? "Less (recovery of an earlier overpayment)" : "Less";
    return `<tr><td class="indent">${label}: ${esc(x.description)}</td><td class="num">${sign}${money(x.base)}</td><td class="num">${sign}${money(x.hst)}</td><td class="num">${sign}${money(x.total)}</td></tr>`;
  }).join("");
  const cap = a.capReachedOnThisDeal
    ? "Annual cap reached on this deal: 100% split thereafter."
    : a.capRemainingAfter === null ? "No annual cap." : `Remaining to cap after this deal: ${money(a.capRemainingAfter)}.`;
  return `
  <div class="statement">
    <h3>${esc(a.name)}${a.isPrec ? ` <span class="tag">PREC</span>` : ""}</h3>
    <p class="meta">Payee: <strong>${esc(a.payeeName)}</strong> · ${tax} ${a.hstNumber ? `Reg. ${esc(a.hstNumber)}` : `not registered (no ${tax} charged on split)`}
      · ${a.fromSides ? `${SIDE_TEXT[a.side ?? "BOTH"]}: ${[a.fromSides.listing ? `${money(a.fromSides.listing)} from the listing side` : "", a.fromSides.buyer ? `${money(a.fromSides.buyer)} from the buyer side` : ""].filter(Boolean).join(" + ")}`
        : `Share of deal GCI ${money(a.allocatedBaseGci)}`} · Effective split ${pct(a.effectiveSplitBps)}</p>
    <table>
      <thead><tr><th></th><th class="num">Base</th><th class="num">${tax} ${pct(rate)}</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${taxedRow("Agent base split", a.split)}
        ${feeRows}
        ${adjustmentRows}
        <tr class="total"><td>Net agent payout</td><td class="num">${money(a.net.base)}</td><td class="num">${money(a.net.hst)}</td><td class="num">${money(a.payout)}</td></tr>
      </tbody>
    </table>
    <p class="meta">Paid by ${esc(brokerageName)} once the commission is received and the payout is approved
      ${a.owes > 0 ? ` · <strong>Agent owes ${money(a.owes)} in fees</strong>` : ""} · House share ${money(a.houseSplitBase)}. ${esc(cap)}</p>
  </div>`;
}

export function renderCda(c: ClosingComputation, b: BrokerageProfile, opts: CdaRenderOptions): string {
  const d = c.deal;
  const tax = c.taxName ?? "HST";
  const address = `${d.unit ? `${d.unit} – ` : ""}${d.streetAddress}, ${d.city}, ${PROVINCES[d.province ?? "ON"] ?? d.province}`;
  const lease = d.side === "LANDLORD" || d.side === "TENANT";
  const toLandlord = c.payer.kind === "LANDLORD";
  // The payer on our side of the trade: the seller's lawyer on a sale, the landlord on a landlord-side lease
  const toLawyer = c.payer.kind === "SELLER_LAWYER" || toLandlord;
  const who = toLandlord ? "landlord" : "lawyer";
  const appliesDeposit = c.trust.distributions.length > 0 || (toLawyer && d.trustDepositHolder === "OUR_BROKERAGE");
  const dueLabel = c.trust.balanceDueToLawyer > 0 ? `Balance due TO ${who}` : toLawyer ? `Balance due FROM ${who}` : "Amount due from listing brokerage";
  const dueAmount = c.trust.balanceDueToLawyer > 0 ? c.trust.balanceDueToLawyer : c.wiresTotal;
  const holderLabel: Record<string, string> = {
    OUR_BROKERAGE: b.legalName, COOP_BROKERAGE: "the co-operating brokerage", LAWYER: "a lawyer in trust", BUILDER: "the builder / trustee",
  };

  const person = toLandlord ? c.landlord ?? null : c.closingLawyer;
  const contact = person
    ? `<strong>${esc(person.name)}</strong>${person.email ? `<br>${esc(person.email)}` : ""}${person.phone ? `<br>${esc(person.phone)}` : ""}`
    : "—";

  const depositRows = c.trust.deposits.map((dep) =>
    `<tr><td>Deposit${dep.receiptNumber ? ` · Trust receipt #${dep.receiptNumber}` : ""} · ${esc(dep.payor)}</td><td>${esc(longDate(dep.date))}</td><td class="num">${money(dep.amount)}</td></tr>`).join("");

  const distributionRows = c.trust.distributions.map((t, i) =>
    `<tr><td>${i + 1}</td><td>${esc(t.payee)}<div class="note">${esc(t.purpose)}</div></td><td class="num">${money(t.amount)}</td></tr>`).join("");

  const wireRows = c.wires.map((w, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${esc(w.payeeName)}</strong>
        <div class="note">Total commission incl. HST · HST Reg. ${esc(b.hstNumber)}</div></td>
      <td class="num">${money(w.owed.base)}</td>
      <td class="num">${money(w.owed.hst)}</td>
      <td class="num">${w.lessFromTrust ? `−${money(w.lessFromTrust)}` : "—"}</td>
      <td class="num strong">${money(w.amount)}</td>
    </tr>`).join("");

  const internal = opts.audience === "internal" ? `
  <section class="page-break">
    <h2>5. Agent commission statements <span class="tag internal">Internal – do not send</span></h2>
    ${c.agents.map((a) => agentStatement(a, c.hstRate, b.legalName, c.taxName ?? "HST")).join("")}
    <h3>Brokerage</h3>
    <table>
      <tbody>
        <tr><td>House share of split (counts toward agents' caps)</td><td class="num">${money(c.brokerage.houseSplitBase)}</td></tr>
        <tr><td>Fees charged to agents (base)</td><td class="num">${money(c.brokerage.feesChargedBase)}</td></tr>
        ${c.brokerage.referral ? `<tr><td>Outside referral to ${esc(c.brokerage.referral.payee)} (incl. HST)</td><td class="num">${money(c.brokerage.referral.total)}</td></tr>` : ""}
        <tr><td>Brokerage net earned share (base + HST)</td><td class="num">${money(c.brokerage.netEarnedShare.base)} + ${money(c.brokerage.netEarnedShare.hst)}</td></tr>
        <tr><td>Agent payouts owed by the brokerage (paid after funds are received)</td><td class="num">${money(c.brokerage.agentPayablesTotal)}</td></tr>
        <tr class="total"><td>Estimated net HST on this deal<div class="note">HST charged less HST paid to agents and referrals. Not the brokerage's HST return: other input tax credits apply.</div></td><td class="num">${money(c.brokerage.netHstEstimate)}</td></tr>
      </tbody>
    </table>
    ${c.warnings.length ? `<p class="warning"><strong>Warnings:</strong> ${c.warnings.map(esc).join(" · ")}</p>` : ""}
  </section>` : "";

  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.cdaNumber)} – Commission Disbursement Authorization</title>
<style>
  @page { size: letter; margin: 16mm 14mm 18mm; }
  :root { --ink: #16181d; --muted: #5d6470; --line: #d9dde3; --soft: #f4f6f8; --accent: #0f3d5e; --warn: #8a5300; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #fff; color: var(--ink); font: 10.5pt/1.45 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .doc { max-width: 7.9in; margin: 0 auto; padding: 0.3in 0; position: relative; }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2.5px solid var(--accent); padding-bottom: 12px; }
  .brand { font-size: 15pt; font-weight: 700; color: var(--accent); letter-spacing: -0.2px; }
  .brand-meta, .meta, .note { color: var(--muted); font-size: 9pt; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 12.5pt; letter-spacing: 0.8px; text-transform: uppercase; }
  .status { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 3px; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.6px; }
  .status.FINAL { background: var(--accent); color: #fff; }
  .status.DRAFT { background: #fff3d6; color: var(--warn); border: 1px solid #e8c77a; }
  .parties { display: grid; grid-template-columns: 1fr 1.35fr; gap: 18px; margin: 16px 0 6px; }
  .box { border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px; }
  .box h4 { margin: 0 0 4px; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.7px; color: var(--muted); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; }
  dt { color: var(--muted); } dd { margin: 0; font-weight: 600; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.7px; color: var(--accent); margin: 20px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 10.5pt; margin: 14px 0 2px; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0; }
  th { text-align: left; font-size: 8.5pt; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1.5px solid var(--ink); padding: 4px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .strong { font-weight: 700; }
  .indent { padding-left: 18px; }
  tr.total td { font-weight: 700; border-top: 1.5px solid var(--ink); border-bottom: none; background: var(--soft); }
  .callout { display: flex; justify-content: space-between; align-items: center; margin: 10px 0; padding: 10px 14px; background: var(--soft); border-left: 4px solid var(--accent); font-size: 11.5pt; font-weight: 700; }
  .callout span:last-child { font-variant-numeric: tabular-nums; }
  .zero { color: #1d6b3a; font-weight: 700; }
  .fraud { margin: 14px 0; padding: 9px 12px; border: 1.5px solid #d9a441; background: #fffaf0; border-radius: 4px; font-size: 9.5pt; }
  .warning { color: var(--warn); font-size: 9pt; }
  .tag { display: inline-block; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 3px; background: #e7eef4; color: var(--accent); vertical-align: middle; }
  .tag.internal { background: #fde8e8; color: #9b1c1c; }
  .statement { margin-bottom: 12px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 28px; }
  .sign div { border-top: 1px solid var(--ink); padding-top: 4px; font-size: 9pt; color: var(--muted); }
  footer { margin-top: 24px; padding-top: 6px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; font-size: 8pt; color: var(--muted); }
  .watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; font-size: 96pt; font-weight: 800; color: rgba(138, 83, 0, 0.07); transform: rotate(-24deg); pointer-events: none; z-index: 0; }
  @media print { .page-break { break-before: page; } .doc { padding: 0; } tr, .box, .statement { break-inside: avoid; } }
  @media screen and (max-width: 640px) { .parties, .sign { grid-template-columns: 1fr; } header { flex-direction: column; } .title { text-align: left; } .doc { padding: 16px; } table { font-size: 9pt; } }
</style>
</head>
<body>
${opts.status === "DRAFT" ? `<div class="watermark" aria-hidden="true">DRAFT</div>` : ""}
<div class="doc">
  <header>
    <div>
      <div class="brand">${esc(b.legalName)}</div>
      <div class="brand-meta">${esc(b.address)}<br>${esc(b.phone)} · ${esc(b.email)}<br>
        HST Reg. ${esc(b.hstNumber)}${b.recoRegistration ? ` · RECO Reg. ${esc(b.recoRegistration)}` : ""}</div>
    </div>
    <div class="title">
      <h1>Commission Disbursement<br>Authorization</h1>
      <div class="meta">No. <strong>${esc(c.cdaNumber)}</strong> · Issued ${esc(longDate(opts.issuedOn))}</div>
      <span class="status ${opts.status}">${opts.status}</span>
    </div>
  </header>
  ${opts.replaces ? `<p class="warning"><strong>This CDA replaces ${esc(opts.replaces.cdaNumber)}</strong>, which was voided: ${esc(opts.replaces.reason)}. Disregard the earlier version.</p>` : ""}

  <div class="parties">
    <div class="box">
      <h4>${toLandlord ? "To: Landlord" : toLawyer ? "To: Closing lawyer (Seller's solicitor)" : "To: Listing brokerage (commission payer)"}</h4>
      ${toLawyer ? contact : `<strong>${esc(c.payer.name)}</strong>${c.closingLawyer ? `<div class="note">Closing lawyer: ${esc(c.closingLawyer.name)}</div>` : ""}`}
    </div>
    <div class="box">
      <h4>Re: Transaction</h4>
      <dl>
        <dt>Property</dt><dd>${esc(address)}</dd>
        <dt>${lease ? "Lease commencement" : "Closing date"}</dt><dd>${esc(longDate(d.closeDate))}</dd>
        <dt>${lease ? "Rent" : "Sale price"}</dt><dd>${money(d.salePrice)}</dd>
        ${d.mlsNumber ? `<dt>MLS®</dt><dd>${esc(d.mlsNumber)}</dd>` : ""}
        <dt>${lease ? "Landlord(s)" : "Seller(s)"}</dt><dd>${esc(d.sellers.join(", ") || "—")}</dd>
        <dt>${lease ? "Tenant(s)" : "Buyer(s)"}</dt><dd>${esc(d.buyers.join(", ") || "—")}</dd>
        <dt>Our role</dt><dd>${esc(SIDE_LABEL[d.side] ?? d.side)} · Deal ${esc(d.dealNumber)}</dd>
      </dl>
    </div>
  </div>

  <section>
    <h2>1. Commission payable on closing</h2>
    <table>
      <thead><tr><th>Item</th><th class="num">Base</th><th class="num">${tax} ${pct(c.hstRate)}</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${taxedRow(`Commission – ${b.legalName}`, c.incoming.commission)}
        ${c.incoming.sides ? `<tr><td class="indent">of which listing side (seller's agreement)</td><td class="num">${money(c.incoming.sides.listing)}</td><td></td><td></td></tr>
        <tr><td class="indent">of which buyer side (buyer's agreement)</td><td class="num">${money(c.incoming.sides.buyer)}</td><td></td><td></td></tr>` : ""}
        ${c.incoming.coop.total > 0 ? taxedRow("Co-operating brokerage commission", c.incoming.coop, "Payable to the co-operating brokerage through the listing brokerage") : ""}
        <tr class="total"><td>Total commission payable</td>
          <td class="num">${money(c.incoming.commission.base + c.incoming.coop.base)}</td>
          <td class="num">${money(c.incoming.commission.hst + c.incoming.coop.hst)}</td>
          <td class="num">${money(c.incoming.totalPayable)}</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>2. Deposit</h2>
    ${appliesDeposit ? `
    <table>
      <thead><tr><th>Held in ${esc(b.legalName)} real estate trust account</th><th>Received</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${depositRows}
        <tr class="total"><td colspan="2">Deposit held in trust</td><td class="num">${money(c.trust.held)}</td></tr>
        <tr><td colspan="2">Applied to commission payable</td><td class="num">−${money(c.trust.appliedToCommission)}</td></tr>
      </tbody>
    </table>` : `<p>The deposit is <strong>not</strong> held by ${esc(b.legalName)}${d.trustDepositHolder !== "OUR_BROKERAGE" ? ` (held by ${esc(holderLabel[d.trustDepositHolder] ?? d.trustDepositHolder)})` : ""}. No deposit is applied to commission.</p>`}
    <div class="callout"><span>${esc(dueLabel)}</span><span>${money(dueAmount)}</span></div>
  </section>

  <section>
    <h2>3. Trust money distribution</h2>
    ${c.trust.distributions.length ? `
    <table>
      <thead><tr><th>#</th><th>From ${esc(b.legalName)} trust account to</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${distributionRows}
        <tr class="total"><td></td><td>Total distributed</td><td class="num">${money(c.trust.held)}</td></tr>
      </tbody>
    </table>` : `<p>No trust funds are held for this deal.</p>`}
    <p>Trust balance for this deal after closing: <span class="zero">${money(c.trust.balanceAfter)}</span></p>
  </section>

  <section>
    <h2>4. Payment instructions</h2>
    ${c.wires.length ? `
    <table>
      <thead><tr><th>#</th><th>Pay to</th><th class="num">Base</th><th class="num">HST</th><th class="num">Less from trust</th><th class="num">Wire amount</th></tr></thead>
      <tbody>
        ${wireRows}
        <tr class="total"><td></td><td colspan="4">Total to be paid by ${esc(c.payer.name)}</td><td class="num">${money(c.wiresTotal)}</td></tr>
      </tbody>
    </table>
    <p>Pay the amount shown in this section to ${esc(b.legalName)} only. It is the commission payable to ${esc(b.legalName)} under this
      transaction, not necessarily the whole commission on the property. Do not pay any salesperson, broker or personal real estate
      corporation directly; the brokerage pays its agents.</p>` : `<p>No payment is required from ${esc(c.payer.name)}: the deposit held in trust covers the full commission${c.trust.balanceDueToLawyer > 0 ? `, and ${money(c.trust.balanceDueToLawyer)} will be returned to you in trust` : ""}.</p>`}
    <div class="fraud"><strong>Wire fraud warning.</strong> Banking details are provided separately and are never changed by email.
      Before sending any funds, confirm the instructions by phone with ${esc(b.legalName)} at ${esc(b.phone)}.</div>
  </section>

  <section>
    <h2>Authorization</h2>
    <p>${esc(b.legalName)} authorizes and directs ${esc(c.payer.name)} to pay the commission set out above on closing,
      as shown in section 4${c.trust.balanceDueToLawyer > 0 ? `, and will remit ${money(c.trust.balanceDueToLawyer)} from its trust account as shown in section 3` : ""}.
      Amounts include ${tax} at ${pct(c.hstRate)}. This authorization replaces any earlier version for this transaction.</p>
    <div class="sign">
      <div>${esc(b.brokerOfRecord)}, Broker of Record – signature and date</div>
      <div>${toLawyer ? `${toLandlord ? "Landlord" : "Seller(s)"} acknowledgment – ${esc(d.sellers.join(", ") || "signature")}` : `Received by ${esc(c.payer.name)}`}</div>
    </div>
  </section>
  ${internal}
  <footer>
    <span>${esc(c.cdaNumber)} · ${esc(b.legalName)}</span>
    <span>${opts.computationSha ? `Verification ${esc(opts.computationSha.slice(0, 16))}` : "Draft – figures may change until finalized"}</span>
  </footer>
</div>
</body>
</html>`;
}
