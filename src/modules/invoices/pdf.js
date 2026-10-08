/**
 * Minimal dependency-free PDF writer (A4, Helvetica, text only). Enough for a printable GST
 * invoice / credit note without adding a PDF library.
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

/** Render an Invoice or CreditNote document to a PDF buffer. */
export function renderTaxDocumentPdf(docData, { title = "TAX INVOICE", number, date } = {}) {
  const d = typeof docData?.toObject === "function" ? docData.toObject() : docData || {};
  const pdf = new Doc();
  const L = MARGIN;
  const W = PAGE_W - 2 * MARGIN;

  pdf.text(L, title, { size: 16, bold: true });
  pdf.text(L, `No. ${number || d.invoiceNumber || d.creditNoteNumber || ""}`, { size: 10, align: "right", width: W });
  pdf.line(16);
  pdf.text(L, `Date: ${new Date(date || d.issuedAt || Date.now()).toISOString().slice(0, 10)}`, { size: 9 });
  pdf.text(L, `Order: ${d.orderNumber || ""}`, { size: 9, align: "right", width: W });
  pdf.line(12);
  if (d.invoiceNumber && d.creditNoteNumber) {
    pdf.text(L, `Against invoice: ${d.invoiceNumber}`, { size: 9 });
    pdf.line(12);
  }
  if (d.placeOfSupplyUnknown) {
    pdf.text(L, "Note: place of supply unknown, IGST charged. Review required.", { size: 8 });
    pdf.line(12);
  }
  pdf.line(6);

  const seller = d.seller || {};
  const buyer = d.buyer || {};
  const half = W / 2;
  pdf.text(L, "Seller", { bold: true });
  pdf.text(L + half, "Bill to", { bold: true });
  pdf.line(12);
  const left = [seller.legalName || seller.name, seller.address, seller.state && `State: ${seller.state}`, seller.gstin && `GSTIN: ${seller.gstin}`];
  const right = [buyer.company || buyer.name, buyer.address, buyer.state && `State: ${buyer.state}`, buyer.gstin && `GSTIN: ${buyer.gstin}`];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i]) pdf.text(L, String(left[i]).slice(0, 60));
    if (right[i]) pdf.text(L + half, String(right[i]).slice(0, 60));
    pdf.line(11);
  }
  pdf.text(L, `Place of supply: ${d.placeOfSupply || "-"}   Supply: ${d.supplyType === "inter" ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)"}`);
  pdf.line(18);

  const cols = [
    { x: L, key: "description", label: "Item", w: 170 },
    { x: L + 175, key: "hsn", label: "HSN/SAC", w: 50 },
    { x: L + 228, key: "qty", label: "Qty", w: 30, align: "right" },
    { x: L + 262, key: "taxableValue", label: "Taxable", w: 60, align: "right", money: true },
    { x: L + 326, key: "taxRate", label: "GST%", w: 30, align: "right" },
    { x: L + 360, key: "cgst", label: "CGST", w: 40, align: "right", money: true },
    { x: L + 402, key: "sgst", label: "SGST", w: 40, align: "right", money: true },
    { x: L + 444, key: "igst", label: "IGST", w: 30, align: "right", money: true },
    { x: L + 470, key: "total", label: "Total", w: W - 470, align: "right", money: true },
  ];
  pdf.row(cols.map((c) => ({ x: c.x, w: c.w, align: c.align, text: c.label })), { bold: true });
  pdf.rule();
  for (const line of d.lines || []) {
    pdf.row(
      cols.map((c) => ({
        x: c.x,
        w: c.w,
        align: c.align,
        text: c.money ? money(line[c.key]) : String(line[c.key] ?? "").slice(0, c.key === "description" ? 38 : 12),
      }))
    );
  }
  pdf.rule();
  pdf.line(4);
  const t = d.totals || {};
  for (const [label, value] of [
    ["Gross", t.grossAmount],
    ["Discount", t.discount],
    ["Taxable value", t.taxableValue],
    ["CGST", t.cgst],
    ["SGST", t.sgst],
    ["IGST", t.igst],
    ["Grand total (Rs.)", t.grandTotal],
  ]) {
    pdf.ensure(14);
    pdf.text(L + 300, label, { bold: label.startsWith("Grand") });
    pdf.text(L + 400, money(value), { align: "right", width: W - 400, bold: label.startsWith("Grand") });
    pdf.line(13);
  }
  pdf.line(10);
  pdf.text(L, "Prices are inclusive of GST. This is a computer-generated document.", { size: 8 });
  return pdf.render();
}
