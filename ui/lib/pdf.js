// The PDF offline copy, written by hand: US Letter pages, PDF's built-in Helvetica (nothing embedded; text is
// WinAnsi, see winansi.js), pictures as JPEG or deflated RGB. Plain JavaScript so it runs and is tested under node,
// and comes out the same on Windows and Linux (the webview's print does not).
import { HELVETICA, HELVETICA_BOLD } from "./pdf-metrics.js";
import { encodeWinAnsi } from "./winansi.js";
import { FIXTURE, OFFSET_COLS, TOOL_COLS, SIGNOFF, TITLE_W, titleCells, isEmpty, usedCols } from "./schema.js";
import { MAKER, VERSION, when } from "./copies.js";

const PW = 612, PH = 792; // Letter, in points (1/72 in)
const M = 36; // margin
const CW = PW - 2 * M; // content width
const BOTTOM = PH - 44; // content stops here; the footer is below
const WIDTHS = { R: HELVETICA, B: HELVETICA_BOLD };
const GREY = "0.38 g", BLACK = "0 g", LINE = "0.7 G";
const n = (v) => String(Math.round(v * 100) / 100);

export function textWidth(text, font, size) {
  let w = 0;
  for (const b of encodeWinAnsi(text)) w += WIDTHS[font][b] || 0;
  return (w * size) / 1000;
}

/** Lines that fit width; words longer than a line are broken. Keeps the text's own line breaks. */
export function wrap(text, font, size, width) {
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = "";
    for (let word of para.split(/ +/)) {
      const cand = line ? line + " " + word : word;
      if (textWidth(cand, font, size) <= width) {
        line = cand;
        continue;
      }
      if (line) lines.push(line);
      while (textWidth(word, font, size) > width && word.length > 1) {
        let i = 1;
        while (i < word.length - 1 && textWidth(word.slice(0, i + 1), font, size) <= width) i++;
        lines.push(word.slice(0, i));
        word = word.slice(i);
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

// "(...)" with ( ) \ escaped; bytes are WinAnsi
function literal(bytes) {
  const out = [0x28];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return Uint8Array.from(out);
}

// ---- page layout. y runs top-down from the page's top edge; drawing converts to PDF's bottom-up.
class Layout {
  constructor(images) {
    this.images = images; // {file: {kind, w, h, data}}
    this.imageIds = new Map(); // file -> "Im<n>"
    this.pages = [];
    this.newPage();
  }
  newPage() {
    this.page = { ops: [], images: new Set() };
    this.pages.push(this.page);
    this.y = M;
  }
  /** start a new page unless h fits (a page that is still empty takes it anyway) */
  ensure(h) {
    if (this.y + h > BOTTOM && this.y > M + 1) this.newPage();
  }
  op(s) {
    this.page.ops.push(s + "\n");
  }
  text(x, top, str, font, size, color = BLACK) {
    if (!str) return;
    this.page.ops.push(`${color} BT /${font} ${size} Tf ${n(x)} ${n(PH - top - size * 0.88)} Td `, literal(encodeWinAnsi(str)), " Tj ET\n");
  }
  textRight(right, top, str, font, size, color) {
    this.text(right - textWidth(str, font, size), top, str, font, size, color);
  }
  line(x1, y1, x2, y2, width = 0.5, color = LINE) {
    this.op(`${color} ${width} w ${n(x1)} ${n(PH - y1)} m ${n(x2)} ${n(PH - y2)} l S`);
  }
  box(x, top, w, h, fill) {
    this.op(fill ? `${fill} ${n(x)} ${n(PH - top - h)} ${n(w)} ${n(h)} re f` : `${LINE} 0.5 w ${n(x)} ${n(PH - top - h)} ${n(w)} ${n(h)} re S`);
  }
  image(file, x, top, w, h) {
    if (!this.imageIds.has(file)) this.imageIds.set(file, "Im" + (this.imageIds.size + 1));
    this.page.images.add(file);
    this.op(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(PH - top - h)} cm /${this.imageIds.get(file)} Do Q`);
  }

  heading(title, keep = 40) {
    this.ensure(26 + keep);
    this.y += 10;
    this.text(M, this.y, title, "B", 12);
    this.y += 15;
    this.line(M, this.y, M + CW, this.y, 1, "0.2 G");
    this.y += 5;
  }

  /** label/value cells, cols per row; each row as tall as its tallest value */
  grid(cells, cols) {
    const w = CW / cols;
    for (let i = 0; i < cells.length; i += cols) {
      const row = cells.slice(i, i + cols);
      const lines = row.map(([, v]) => wrap(v, "B", 10, w - 10));
      const h = 16 + 12 * Math.max(1, ...lines.map((l) => l.length));
      this.ensure(h);
      row.forEach(([label], c) => {
        const x = M + c * w;
        this.box(x, this.y, w, h);
        this.text(x + 5, this.y + 3, label, "R", 7.5, GREY);
        lines[c].forEach((l, k) => this.text(x + 5, this.y + 13 + 12 * k, l, "B", 10));
      });
      this.y += h;
    }
  }

  /** cols = [[key, label, width]]; the header row repeats on every page the table runs onto */
  table(cols, rows) {
    const head = () => {
      let x = M;
      this.box(M, this.y, CW, 15, "0.9 g");
      for (const [, label, w] of cols) {
        this.text(x + 4, this.y + 4, label, "B", 8);
        x += w;
      }
      this.y += 15;
    };
    this.ensure(15 + 20);
    head();
    for (const r of rows) {
      const lines = cols.map(([k, , w], c) => wrap(r[k], c === 0 ? "B" : "R", 9, w - 8));
      const h = 6 + 11 * Math.max(1, ...lines.map((l) => l.length));
      if (this.y + h > BOTTOM) {
        this.newPage();
        head();
      }
      let x = M;
      cols.forEach(([key, , w], c) => {
        this.box(x, this.y, w, h);
        // lengths right-aligned, so their decimal points line up near enough (Helvetica's digits are all one width)
        // the first column (tool number, offset) bold: it is what the operator matches at the machine
        lines[c].forEach((l, k) => (key === "length" ? this.textRight(x + w - 4, this.y + 4 + 11 * k, l, "R", 9) : this.text(x + 4, this.y + 4 + 11 * k, l, c === 0 ? "B" : "R", 9)));
        x += w;
      });
      this.y += h;
    }
  }

  paragraph(text, indent = 0, size = 10) {
    for (const l of wrap(text, "R", size, CW - indent)) {
      this.ensure(size * 1.3);
      this.text(M + indent, this.y, l, "R", size);
      this.y += size * 1.3;
    }
  }
}

// widths add up to CW (540)
const OFFSET_W = { name: 110, location: 430 };
const TOOL_W = { number: 46, pocket: 46, description: 170, length: 58, offset: 50, speed: 50, feed: 50, notes: 70 };
// with Speed and Feed empty, their width goes to Description and Notes
const TOOL_W_NO_SF = { ...TOOL_W, description: 190, speed: 0, feed: 0, notes: 150 };
export const toolWidths = (rows) => (rows.some((t) => String(t.speed ?? "").trim() || String(t.feed ?? "").trim()) ? TOOL_W : TOOL_W_NO_SF);

/** [[key, label, width]] for the columns with something in them; the width of the empty ones goes to grow */
export function fitCols(cols, widths, rows, grow) {
  const kept = usedCols(cols, rows);
  const spare = cols.filter((c) => !kept.includes(c)).reduce((a, [k]) => a + widths[k], 0);
  const to = kept.some(([k]) => k === grow) ? grow : kept.at(-1)?.[0];
  return kept.map(([k, label]) => [k, label, widths[k] + (k === to ? spare : 0)]);
}

/** sheet -> the laid-out pages. images = {file: {kind: "jpeg"|"rgb", w, h, data}} (see pictures.js pdfImage) */
export function layoutSheet(sheet, images = {}) {
  const L = new Layout(images);
  // the title block, ruled like a drawing's (schema.js titleCells): thin rules inside, a heavy one round it
  const xs = TITLE_W.map((_, i) => M + TITLE_W.slice(0, i).reduce((a, b) => a + b, 0));
  const cells = titleCells(sheet).map(([label, v, c, cs, r, rs], i) => {
    const w = TITLE_W.slice(c, c + cs).reduce((a, b) => a + b, 0);
    const lines = i === 0 ? wrap(v, "B", 24, w - 12) : wrap(v, "B", 10, w - 10);
    return { label, lines, c, r, rs, w, need: i === 0 ? 16 + 26 * lines.length : 16 + 12 * lines.length };
  });
  const rowH = [0, 1, 2, 3].map((r) => Math.max(28, ...cells.filter((c) => c.r === r && c.rs === 1).map((c) => c.need)));
  const big = cells[0];
  if (rowH[0] + rowH[1] < big.need) rowH[1] = big.need - rowH[0];
  const top = L.y, ys = rowH.map((_, r) => top + rowH.slice(0, r).reduce((a, b) => a + b, 0));
  for (const c of cells) {
    const x = xs[c.c], y = ys[c.r], h = rowH.slice(c.r, c.r + c.rs).reduce((a, b) => a + b, 0);
    L.box(x, y, c.w, h);
    L.text(x + 5, y + 3, c.label, "R", 7.5, GREY);
    if (c === big) c.lines.forEach((l, k) => L.text(x + 6, y + h - 6 - 26 * (c.lines.length - k) + 4, l, "B", 24));
    else c.lines.forEach((l, k) => L.text(x + 5, y + 13 + 12 * k, l, "B", 10));
  }
  const tbH = rowH.reduce((a, b) => a + b, 0);
  L.op(`0 G 1.5 w ${n(M)} ${n(PH - top - tbH)} ${n(CW)} ${n(tbH)} re S`);
  L.y += tbH + 4;
  if (!isEmpty.fixture(sheet)) {
    L.heading("Fixture");
    L.grid(FIXTURE.map(([k, label]) => [label, sheet.fixture[k]]), 2);
    if (sheet.fixture.notes.trim()) {
      L.y += 6;
      L.paragraph(sheet.fixture.notes);
    }
  }
  if (!isEmpty.offsets(sheet)) {
    const rows = sheet.offsets.filter((o) => OFFSET_COLS.some(([k]) => o[k].trim()));
    L.heading(`Work offsets (${rows.length})`);
    L.table(fitCols(OFFSET_COLS, OFFSET_W, rows, "location"), rows);
  }
  if (!isEmpty.tools(sheet)) {
    const rows = sheet.tools.filter((t) => TOOL_COLS.some(([k]) => t[k].trim()));
    L.heading(`Tools (${rows.length})`);
    L.table(fitCols(TOOL_COLS, toolWidths(rows), rows, "description"), rows);
  }
  if (!isEmpty.steps(sheet)) {
    L.heading("Set-up steps");
    sheet.steps.filter((s) => s.trim()).forEach((s, i) => {
      const lines = wrap(s, "R", 10, CW - 22);
      lines.forEach((l, k) => {
        L.ensure(13);
        if (k === 0) L.textRight(M + 16, L.y, `${i + 1}.`, "B", 10);
        L.text(M + 22, L.y, l, "R", 10);
        L.y += 13;
      });
      L.y += 3;
    });
  }
  if (!isEmpty.notes(sheet)) {
    L.heading("Notes");
    L.paragraph(sheet.notes);
  }
  if (sheet.pictures.length) {
    // two across, each at most half the width, 250 pt tall and 1.5x its size at 96 dpi; caption under each.
    // A wide picture (a line drawing, see schema.js) has a row of its own: the whole width, up to 560 pt tall and
    // 3x, so the dimensions on a drawing can be read on paper.
    const GAP = 12, half = (CW - GAP) / 2;
    const items = sheet.pictures.map((p) => {
      const img = images[p.file], cw = p.wide ? CW : half;
      const s = img ? Math.min(cw / img.w, (p.wide ? 560 : 250) / img.h, p.wide ? 3 : 1.5) : 0;
      return { p, img, cw, w: img ? img.w * s : cw, h: img ? img.h * s : 60, cap: p.caption.trim() ? wrap(p.caption, "R", 9, cw) : [] };
    });
    const rows = [];
    for (const it of items) {
      const last = rows.at(-1);
      if (!it.p.wide && last && last.length === 1 && !last[0].p.wide) last.push(it);
      else rows.push([it]);
    }
    rows.forEach((row, i) => {
      // a wide picture that would start a new page shrinks into the space left instead, if 300 pt or more is left
      // (else every drawing took a page of its own, and the title page stood nearly empty)
      const it0 = row[0];
      if (it0.p.wide && it0.img) {
        const room = BOTTOM - L.y - (i === 0 ? 30 : 0) - 4 - 12 * it0.cap.length - 12;
        if (it0.h > room && room >= 300) (it0.w *= room / it0.h), (it0.h = room);
      }
      const h = Math.max(...row.map((it) => it.h + 4 + 12 * it.cap.length)) + 12;
      if (i === 0) L.heading(`Pictures (${sheet.pictures.length})`, h);
      else L.ensure(h);
      row.forEach((it, c) => {
        const cx = M + c * (it.cw + GAP), x = cx + (it.cw - it.w) / 2;
        if (it.img) L.image(it.p.file, x, L.y, it.w, it.h);
        else {
          L.box(x, L.y, it.w, it.h);
          wrap("Picture missing: " + it.p.file, "R", 8, it.w - 12).forEach((l, k) => L.text(x + 6, L.y + 8 + 10 * k, l, "R", 8, GREY));
        }
        it.cap.forEach((l, k) => L.text(cx + (it.cw - textWidth(l, "R", 9)) / 2, L.y + it.h + 4 + 12 * k, l, "R", 9, GREY));
      });
      L.y += h;
    });
  }
  L.heading("Sign-off", 36);
  const widths = [180, 90, 180, 90];
  let x = M;
  SIGNOFF.forEach(([k, label], i) => {
    L.box(x, L.y, widths[i], 34);
    L.text(x + 5, L.y + 3, label, "R", 7.5, GREY);
    L.text(x + 5, L.y + 16, sheet.signoff[k], "B", 10);
    x += widths[i];
  });
  L.y += 34;

  // footer on every page, now that the page count is known
  const saved = sheet.saved_at ? `Saved ${when(sheet.saved_at)} by ${sheet.saved_by}` : "Not saved yet";
  L.pages.forEach((pg, i) => {
    L.page = pg;
    L.line(M, PH - 32, M + CW, PH - 32, 0.5);
    L.text(M, PH - 28, `${sheet.program}   ${sheet.group}`, "B", 8, GREY);
    L.text(M + CW / 2 - textWidth(saved, "R", 8) / 2, PH - 28, saved, "R", 8, GREY);
    L.textRight(M + CW, PH - 28, `Page ${i + 1} of ${L.pages.length}`, "R", 8, GREY);
  });
  return L;
}

// ---- the file
const enc = (s) => new TextEncoder().encode(s);

function concat(parts) {
  const bytes = parts.map((p) => (typeof p === "string" ? enc(p) : p));
  const out = new Uint8Array(bytes.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of bytes) out.set(b, o), (o += b.length);
  return out;
}

// a text string outside content streams (the Title): ASCII as a literal, anything else as UTF-16BE
function pdfString(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return new TextDecoder().decode(literal(enc(s)));
  const hex = [0xfeff, ...[...s].flatMap((ch) => { const c = ch.codePointAt(0); return c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c]; })];
  return "<" + hex.map((c) => c.toString(16).padStart(4, "0")).join("") + ">";
}

const pdfDate = (d) => "D:" + d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";

/** sheet -> PDF bytes. now = the copy's date (tests pass a fixed one). */
export function sheetPdf(sheet, images = {}, now = new Date()) {
  const L = layoutSheet(sheet, images);
  const objs = [];
  const add = (body) => objs.push(body); // -> the new object's number
  const stream = (dict, data) => concat([`<< ${dict} /Length ${data.length} >>\nstream\n`, data, "\nendstream"]);
  // the Info dictionary is object 1, so the /Producer marker (copies.js isOurs) sits in the first bytes
  add(`<< /Producer (${MAKER} ${VERSION}) /Title ${pdfString(`${sheet.program} set-up sheet (${sheet.group})`)} /CreationDate (${pdfDate(now)}) >>`);
  const catalog = add(null), pagesId = add(null);
  const fontR = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontB = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const imageObj = new Map();
  for (const [file, name] of L.imageIds) {
    const im = images[file];
    const filter = im.kind === "jpeg" ? "/DCTDecode" : "/FlateDecode";
    imageObj.set(name, add(stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter}`, im.data)));
  }
  const kids = L.pages.map((pg) => {
    const contents = add(stream("", concat(pg.ops)));
    const xo = [...pg.images].map((f) => L.imageIds.get(f)).map((nm) => `/${nm} ${imageObj.get(nm)} 0 R`).join(" ");
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /R ${fontR} 0 R /B ${fontB} 0 R >>${xo ? ` /XObject << ${xo} >>` : ""} >> /Contents ${contents} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  const parts = [concat(["%PDF-1.4\n%", Uint8Array.from([0xe2, 0xe3, 0xcf, 0xd3]), "\n"])];
  let pos = parts[0].length;
  const offsets = objs.map((body, i) => {
    const part = concat([`${i + 1} 0 obj\n`, body, "\nendobj\n"]);
    parts.push(part);
    const at = pos;
    pos += part.length;
    return at;
  });
  parts.push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join(""));
  parts.push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`);
  return concat(parts);
}
