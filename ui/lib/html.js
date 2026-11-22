// The HTML offline copy: one file with the sheet and its pictures (data: URLs) inside, so it opens from any
// disk with no network. No script: a picture zooms with CSS alone (:target), which also works in the editor's
// preview, where the app's security policy blocks inline scripts. Prints like the PDF.
import { FIXTURE, OFFSET_COLS, TOOL_COLS, SIGNOFF, TITLE_W, titleCells, isEmpty, usedCols } from "./schema.js";
import { NAME, MAKER, VERSION, when } from "./copies.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CSS = `
*{box-sizing:border-box}
:root{--ink:#1b1f24;--muted:#5c6670;--line:#c9cfd6;--head:#eef1f4;--page:#fff;--bg:#e4e7eb;--accent:#1d5fa8}
@media (prefers-color-scheme:dark){:root{--ink:#d7dcf5;--muted:#8c95c8;--line:#5a659c;--head:#1a2550;--page:#141e48;--bg:#0a1028;--accent:#38bdfa}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,"Segoe UI",Arial,sans-serif}
main{max-width:960px;margin:16px auto;padding:22px 26px;background:var(--page);border-radius:6px}
.lbl{font-size:12px;color:var(--muted)}
.tb{display:grid;grid-template-columns:${TITLE_W.map((w) => w + "fr").join(" ")};gap:1px;background:var(--line);border:2px solid var(--ink)}
.tb>div{background:var(--page);padding:4px 8px 6px;min-height:46px}
.tb .v{font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere}
.tb .prog{display:flex;flex-direction:column;justify-content:space-between}
h1{margin:6px 0 0;font-size:40px;line-height:1.05;letter-spacing:-.01em;overflow-wrap:anywhere}
h2{font-size:17px;margin:22px 0 6px;padding-bottom:3px;border-bottom:1.5px solid var(--ink)}
.grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);border-left:1px solid var(--line);border-top:1px solid var(--line);margin-top:10px}
.grid>div{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px 7px;min-height:44px}
.grid .v{font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--line);padding:4px 7px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}
th{background:var(--head);font-size:13px}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
td.key{font-weight:700}
.text{white-space:pre-wrap}
ol{margin:4px 0;padding-left:28px}ol li{margin:3px 0;white-space:pre-wrap}ol li::marker{font-weight:700}
.pics{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
figure{margin:0;text-align:center}
figure.wide{grid-column:1/-1}figure.wide img{max-height:85vh}
figure img{max-width:100%;max-height:360px;background:#fff;border:1px solid var(--line);border-radius:4px;cursor:zoom-in}
figcaption{color:var(--muted);font-size:13px;margin-top:3px;white-space:pre-wrap}
figure a.close{display:none}
figure:target{position:fixed;inset:0;z-index:9;background:#000e;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px}
figure:target img{max-height:calc(100vh - 60px);max-width:100%;cursor:zoom-out}
figure:target figcaption{color:#ddd;font-size:15px}
figure:target a.close{display:block;position:absolute;inset:0}
.missing{padding:30px;border:1px dashed var(--line);color:var(--muted)}
.sign{--cols:4}.sign>div{min-height:52px}
footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:22px;padding-top:6px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:700px){main{margin:0;border-radius:0;padding:14px 12px}.grid{--cols:2!important}h1{font-size:30px}
 .tb{grid-template-columns:1fr 1fr}.tb>div{grid-column:auto!important;grid-row:auto!important}.tb .prog{grid-column:1/-1!important}}
@media print{body{background:#fff;color:#000;font-size:11pt}main{max-width:none;margin:0;padding:0}
 :root{--ink:#000;--muted:#555;--line:#999;--head:#e8e8e8;--page:#fff}
 tr,figure,.grid>div{break-inside:avoid}h2{break-after:avoid}figure img{max-height:4in;cursor:default}figure.wide img{max-height:7.5in}}
body.big{font-size:18px}body.big main{max-width:1500px}body.big .pics{grid-template-columns:repeat(auto-fill,minmax(440px,1fr))}
body.big h1{font-size:52px}body.big figure img{max-height:560px}body.big figure.wide img{max-height:85vh}body.big th{font-size:15px}
`;

const grid = (cells, cols, cls = "") =>
  `<div class="grid ${cls}" style="--cols:${cols}">${cells.map(([l, v]) => `<div><div class="lbl">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;

// empty columns are left out, as in the PDF; numbers sit right-aligned so their decimal points line up;
// the first column (the tool number, the offset) is bold: it is what the operator matches at the machine
const NUM = new Set(["length"]);
const table = (all, rows, cols = usedCols(all, rows)) =>
  `<table><thead><tr>${cols.map(([k, l]) => `<th${NUM.has(k) ? ' class="num"' : ""}>${esc(l)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map(([k], i) => `<td${NUM.has(k) ? ' class="num"' : i === 0 ? ' class="key"' : ""}>${esc(r[k])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

/**
 * sheet -> the whole page as a string. pictures = {file: "data:image/...;base64,..."}; now = when the copy was made.
 * stamp replaces the footer's "Copy made ..." (the machine viewer says when the sheet was published instead).
 * big: larger text, a wider page and bigger pictures, for reading at the machine (the machine viewer).
 */
export function sheetHtml(sheet, pictures = {}, now = new Date(), { stamp, big } = {}) {
  const s = sheet;
  const parts = [];
  // the title block (schema.js titleCells); the program number is the page's one big thing
  parts.push(`<div class="tb">${titleCells(s)
    .map(([l, v, c, cs, r, rs], i) => `<div${i === 0 ? ' class="prog"' : ""} style="grid-column:${c + 1}/span ${cs};grid-row:${r + 1}/span ${rs}"><div class="lbl">${esc(l)}</div>${
      i === 0 ? `<h1>${esc(v)}</h1>` : `<div class="v">${esc(v)}</div>`}</div>`)
    .join("")}</div>`);
  if (!isEmpty.fixture(s)) {
    parts.push(`<h2>Fixture</h2>` + grid(FIXTURE.map(([k, l]) => [l, s.fixture[k]]), 2));
    if (s.fixture.notes.trim()) parts.push(`<p class="text">${esc(s.fixture.notes)}</p>`);
  }
  const offsets = s.offsets.filter((o) => OFFSET_COLS.some(([k]) => o[k].trim()));
  const tools = s.tools.filter((t) => TOOL_COLS.some(([k]) => t[k].trim()));
  if (!isEmpty.offsets(s)) parts.push(`<h2>Work offsets (${offsets.length})</h2>` + table(OFFSET_COLS, offsets));
  if (!isEmpty.tools(s)) parts.push(`<h2>Tools (${tools.length})</h2>` + table(TOOL_COLS, tools));
  if (!isEmpty.steps(s)) parts.push(`<h2>Set-up steps</h2><ol>${s.steps.filter((x) => x.trim()).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`);
  if (!isEmpty.notes(s)) parts.push(`<h2>Notes</h2><p class="text">${esc(s.notes)}</p>`);
  if (s.pictures.length) {
    parts.push(`<h2>Pictures (${s.pictures.length})</h2><div class="pics">${s.pictures
      .map((p, i) => {
        const cap = p.caption.trim() ? `<figcaption>${esc(p.caption)}</figcaption>` : "";
        if (!pictures[p.file]) return `<figure${p.wide ? ' class="wide"' : ""}><div class="missing">Picture missing: ${esc(p.file)}</div>${cap}</figure>`;
        // click: #pic-n is targeted and fills the screen; click again (the cover link) to go back
        return `<figure id="pic-${i + 1}"${p.wide ? ' class="wide"' : ""}><a href="#pic-${i + 1}"><img src="${pictures[p.file]}" alt="${esc(p.caption || "picture " + (i + 1))}"></a>${cap}<a class="close" href="#_" aria-label="Close"></a></figure>`;
      })
      .join("")}</div>`);
  }
  parts.push(`<h2>Sign-off</h2>` + grid(SIGNOFF.map(([k, l]) => [l, s.signoff[k]]), 4, "sign"));
  const saved = s.saved_at ? `Saved ${when(s.saved_at)} by ${s.saved_by}` : "Not saved yet";
  parts.push(`<footer><span>${esc(s.program)} &nbsp; ${esc(s.group)}</span><span>${esc(saved)}</span><span>${esc(stamp || `Copy made ${when(now.toISOString())} by ${NAME} ${VERSION}`)}</span></footer>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="generator" content="${MAKER} ${VERSION}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.program)} set-up sheet (${esc(s.group)})</title>
<style>${CSS}</style>
</head>
<body${big ? ' class="big"' : ""}>
<main>
${parts.join("\n")}
</main>
</body>
</html>
`;
}
