import { Doc, PAGE_W, MARGIN } from "../invoices/pdf.js";

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
// IST calendar day (statements are IST months).
const day = (d) => new Date(new Date(d).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

/** Seller monthly statement (from taxReports.sellerStatement) as a text PDF. */
export function renderStatementPdf(st) {
  const pdf = new Doc();
  const L = MARGIN;
  const W = PAGE_W - 2 * MARGIN;
  pdf.text(L, "SELLER STATEMENT", { size: 16, bold: true });
  pdf.text(L, st.month, { size: 11, align: "right", width: W });
  pdf.line(18);
  pdf.text(L, `${st.store.legalName || st.store.name}`, { bold: true });
  pdf.line(12);
  if (st.store.gstin) {
    pdf.text(L, `GSTIN: ${st.store.gstin}${st.store.pan ? `   PAN: ${st.store.pan}` : ""}`);
    pdf.line(12);
  }
  pdf.line(6);
  pdf.text(L, "Opening balance", { bold: true });
  pdf.text(L, money(st.openingBalance), { align: "right", width: W, bold: true });
  pdf.line(16);
  const cols = [
    { x: L, label: "Date", w: 60 },
    { x: L + 62, label: "Order", w: 90 },
    { x: L + 154, label: "Type", w: 100 },
    { x: L + 256, label: "Memo", w: 130 },
    { x: L + 388, label: "Amount", w: 60, align: "right" },
    { x: L + 450, label: "Balance", w: W - 450, align: "right" },
  ];
  pdf.row(cols.map((c) => ({ ...c, text: c.label })), { bold: true });
  pdf.rule();
  for (const l of st.lines) {
    const vals = [day(l.date), l.orderNumber || "", `${l.kindLabel}${l.held ? " (held)" : ""}`, l.memo || "", money(l.amount), money(l.balance)];
    pdf.row(cols.map((c, i) => ({ x: c.x, w: c.w, align: c.align, text: String(vals[i]).slice(0, i === 3 ? 26 : 22) })), { size: 8 });
  }
  pdf.rule();
  pdf.line(4);
  for (const [label, value] of [
    ["Credits", st.totals.credits],
    ["Debits", -st.totals.debits],
    ["Closing balance", st.closingBalance],
    ["GST TCS withheld (month)", st.totals.tcs],
    ["TDS 194-O withheld (month)", st.totals.tds],
    ["Held at month end", st.totals.heldAtClose],
  ]) {
    pdf.ensure(14);
    pdf.text(L + 250, label, { bold: label === "Closing balance" });
    pdf.text(L + 400, money(value), { align: "right", width: W - 400, bold: label === "Closing balance" });
    pdf.line(13);
  }
  pdf.line(8);
  pdf.text(L, "Positive amounts are owed to the seller; negative amounts are owed to the platform. Computer-generated statement.", { size: 7 });
  return pdf.render();
}
