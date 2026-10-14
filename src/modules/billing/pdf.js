/**
 * Subscription GST invoice PDF (platform -> seller). Same dependency-free writer as
 * invoices/pdf.js (A4, Helvetica, text only); prices here are GST-EXCLUSIVE with GST added.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;

function ascii(value) {
  return String(value ?? "")
    .replace(/₹/g, "Rs.")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "");
}

function esc(value) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function money(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

/** Approximate Helvetica width (good enough for right-aligning numbers). */
function textWidth(text, size) {
  return ascii(text).length * size * 0.5;
}

class Doc {
  constructor() {
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height) {
    if (this.y - height < MARGIN) this.newPage();
  }

  text(x, text, { size = 9, bold = false, align = "left", width = 0 } = {}) {
    let tx = x;
    if (align === "right") tx = x + width - textWidth(text, size);
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${tx.toFixed(1)} ${this.y.toFixed(1)} Td (${esc(text)}) Tj ET`);
  }

  line(height = 12) {
    this.y -= height;
  }

  rule() {
    this.ops.push(`${MARGIN} ${(this.y + 4).toFixed(1)} m ${PAGE_W - MARGIN} ${(this.y + 4).toFixed(1)} l 0.5 w S`);
  }

  row(cols, opts = {}) {
    this.ensure(14);
    for (const col of cols) this.text(col.x, col.text, { ...opts, align: col.align, width: col.w || 0 });
    this.line(13);
  }

  render() {
    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length;
    };
    const catalogId = add(null);
    const pagesId = add(null);
    const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
            `/Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentId} 0 R >>`
        )
      );
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}


const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

/** Render a SubscriptionInvoice to a PDF buffer. */
export function renderSubscriptionInvoicePdf(invoice) {
  const d = typeof invoice?.toObject === "function" ? invoice.toObject() : invoice || {};
  const pdf = new Doc();
  const L = MARGIN;
  const W = PAGE_W - 2 * MARGIN;
  const title = d.status === "void" ? "TAX INVOICE (VOID)" : "TAX INVOICE";

  pdf.text(L, title, { size: 16, bold: true });
  pdf.text(L, `No. ${d.number || "DRAFT"}`, { size: 10, align: "right", width: W });
  pdf.line(16);
  pdf.text(L, `Date: ${day(d.issuedAt || d.createdAt)}`, { size: 9 });
  pdf.text(L, `Status: ${String(d.status || "").toUpperCase()}${d.paidAt ? ` (paid ${day(d.paidAt)})` : d.dueAt ? ` (due ${day(d.dueAt)})` : ""}`, {
    size: 9,
    align: "right",
    width: W,
  });
  pdf.line(12);
  if (d.period?.start) {
    pdf.text(L, `Billing period: ${day(d.period.start)} to ${day(d.period.end)}`, { size: 9 });
    pdf.line(12);
  }
  pdf.line(6);

  const supplier = d.supplier || {};
  const recipient = d.recipient || {};
  const half = W / 2;
  pdf.text(L, "Supplier", { bold: true });
  pdf.text(L + half, "Bill to", { bold: true });
  pdf.line(12);
  const left = [supplier.legalName || supplier.name, supplier.address, supplier.state && `State: ${supplier.state}`, supplier.gstin && `GSTIN: ${supplier.gstin}`];
  const right = [
    recipient.legalName || recipient.name,
    recipient.address,
    recipient.state && `State: ${recipient.state}`,
    recipient.gstin && `GSTIN: ${recipient.gstin}`,
  ];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i]) pdf.text(L, String(left[i]).slice(0, 60));
    if (right[i]) pdf.text(L + half, String(right[i]).slice(0, 60));
    pdf.line(11);
  }
  pdf.text(L, `Place of supply: ${d.placeOfSupply || "-"}   Supply: ${d.supplyType === "intra" ? "Intra-state (CGST+SGST)" : "Inter-state (IGST)"}`);
  pdf.line(18);

  pdf.row(
    [
      { x: L, text: "Description" },
      { x: L + 340, text: "SAC" },
      { x: L + 400, w: W - 400, align: "right", text: "Amount (Rs.)" },
    ],
    { bold: true }
  );
  pdf.rule();
  for (const line of d.lines || []) {
    pdf.row([
      { x: L, text: String(line.description || "").slice(0, 64) },
      { x: L + 340, text: String(line.sac || "") },
      { x: L + 400, w: W - 400, align: "right", text: money(line.amount) },
    ]);
  }
  pdf.rule();
  pdf.line(4);
  const tax = d.tax || {};
  const rate = Number(d.taxRate) || 18;
  const rows = [["Taxable value", d.subtotal]];
  if (d.supplyType === "intra") {
    rows.push([`CGST @ ${rate / 2}%`, tax.cgst], [`SGST @ ${rate / 2}%`, tax.sgst]);
  } else {
    rows.push([`IGST @ ${rate}%`, tax.igst]);
  }
  rows.push(["Total (Rs.)", d.total]);
  for (const [label, value] of rows) {
    pdf.ensure(14);
    const bold = label.startsWith("Total");
    pdf.text(L + 300, label, { bold });
    pdf.text(L + 400, money(value), { align: "right", width: W - 400, bold });
    pdf.line(13);
  }
  pdf.line(10);
  if (d.payment?.method) {
    const ref = d.payment.razorpayPaymentId || d.payment.reference || "";
    pdf.text(L, `Payment: ${d.payment.method === "razorpay" ? "Online (Razorpay)" : d.payment.mode || "Recorded by platform"}${ref ? `  Ref: ${ref}` : ""}`, { size: 8 });
    pdf.line(12);
  }
  pdf.text(L, "Subscription fee for use of the marketplace platform. Amounts exclude GST; GST is added as shown.", { size: 8 });
  pdf.line(11);
  pdf.text(L, "This is a computer-generated document.", { size: 8 });
  return pdf.render();
}
