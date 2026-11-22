// node test/run.mjs   - sheet shape, folder store, edit lock + safe save, offline copies (HTML + PDF),
//                       publish (releases, kill midway, rollback), the machine viewer's last good copy, and machines.
// The PDF is also checked with qpdf --check and pdftotext when they are installed (poppler, qpdf).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeFs } from "./nodefs.mjs";
import { join, sha256, enc } from "../ui/lib/util.js";
import { blankSheet, blankTool, normalize, validate, badName, isEmpty, TOOL_COLS } from "../ui/lib/schema.js";
import * as store from "../ui/lib/store.js";
import { copiesFolder, writeCopies, isOurs, copyNames, orphanCopies, removeCopies } from "../ui/lib/copies.js";
import { sheetHtml } from "../ui/lib/html.js";
import { sheetPdf, wrap, textWidth, layoutSheet, fitCols, toolWidths } from "../ui/lib/pdf.js";
import { encodeWinAnsi } from "../ui/lib/winansi.js";
import { dataUrl, extOf } from "../ui/lib/pictures.js";
import * as rel from "../ui/lib/release.js";
import { syncOnce, readCache, loadSheet, findSheets, splitGroups } from "../ui/lib/sync.js";
import { CONTROLLERS, offsetHint } from "../ui/lib/machines.js";

// ---- child mode: publish, but die right before current.json is replaced (simulates a kill)
if (process.argv[2] === "--kill-publish") {
  const [, , , root, out] = process.argv;
  const dying = { ...nodeFs, rename: async (a, b) => (b.endsWith("current.json") ? process.exit(9) : nodeFs.rename(a, b)) };
  await rel.publish(dying, root, out);
  process.exit(0);
}

const tmp = await fs.mkdtemp(join(process.env.SS_TEST_ROOT || os.tmpdir(), "sstest-")); // SS_TEST_ROOT: run on a share
const step = (s) => console.log("ok -", s);
const has = (cmd) => spawnSync(cmd, ["--version"]).status === 0 || spawnSync(cmd, ["-v"]).status === 0;
const JPEG = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAGAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCLAGlTf//Z", "base64"));

function sample() {
  const s = blankSheet("Cell 3", "O1001-1");
  s.machines = ["Mill 1", "Mill 2"];
  Object.assign(s.part, { number: "1001", revision: "C", name: 'Pump casing 4" <B&W>', operation: "OP 10", material: "CI/DI", stock: "Casting", cycle_time: "14:30" });
  Object.assign(s.fixture, { name: "FIX1", workholding: "Tombstone", notes: "Locate on the Ø10 pins." });
  s.offsets = [{ name: "Work 1", location: "X0 Y0 center of Ø120 bore ±0.002" }];
  s.tools = [{ ...blankTool(), number: "12", pocket: "3", description: "1/2 4FL EM", length: "4.250", offset: "H12" }, blankTool()];
  s.steps = ["Clean the pins.", "   ", "Probe Work 1."];
  s.notes = "Line one\nLine two (with parens) and a back\\slash";
  s.signoff.programmer = "Sam";
  return s;
}

// ---- schema
{
  assert.deepEqual(validate(sample()), []);
  assert.match(badName("Mill 1/2", "g"), /character/);
  assert.match(badName("O1001-1.", "p"), /ends with/);
  assert.match(badName(" O1", "p"), /starts or ends/);
  assert.match(badName("CON", "p"), /reserves/);
  assert.match(badName("", "p"), /empty/);
  assert.equal(badName("Lathe cell", "g"), null);
  const n = normalize({ group: "g", program: "p", part: { number: 1001 }, tools: [{ number: 5 }], steps: [7], pictures: [{ file: "a.png" }, {}] });
  assert.equal(n.part.number, "1001");
  assert.equal(n.part.name, "");
  assert.deepEqual(n.tools[0], { ...blankTool(), number: "5" });
  assert.deepEqual(n.steps, ["7"]);
  assert.deepEqual(n.pictures, [{ file: "a.png", caption: "" }]);
  assert.ok(isEmpty.tools(blankSheet("g", "p")) && !isEmpty.tools(sample()));
  assert.ok(validate({ ...sample(), schema_version: 99 }).some((e) => /newer/.test(e)));
  step("sheet shape: names, normalize, empty sections");
}

// ---- machines: the user's own list; the controller only picks the work-offset hint
{
  const ms = [{ name: "Mill 1", controller: "Fanuc" }, { name: "Mill 2", controller: "Fanuc" }, { name: "Lathe", controller: "Heidenhain" }, { name: "Saw", controller: "Other" }];
  assert.equal(offsetHint(ms, ["Mill 1", "Mill 2"]), `Fanuc: ${CONTROLLERS.Fanuc}`, "one hint per controller");
  assert.equal(offsetHint(ms, ["Mill 1", "Lathe"]), `Fanuc: ${CONTROLLERS.Fanuc}  ·  Heidenhain: ${CONTROLLERS.Heidenhain}`);
  assert.equal(offsetHint(ms, ["Saw"]), "", "Other has no hint");
  assert.equal(offsetHint(ms, ["Gone"]), "", "a machine no longer in Settings has no hint");
  assert.equal(offsetHint([], ["Mill 1"]), "", "no machines set up yet");
  step("machines: offset hint from the controller");
}

// ---- store: create, list, lock, save
const root = join(tmp, "sheets");
await fs.mkdir(root);
const me = { user: "sam", host: "pc1", id: "a" };
const other = { user: "bob", host: "pc2", id: "b" };
let dir;
{
  dir = await store.createSheet(nodeFs, root, sample());
  assert.equal(dir, join(root, "Cell 3", "O1001-1"));
  await assert.rejects(store.createSheet(nodeFs, root, sample()), /already exists/);
  await assert.rejects(store.createSheet(nodeFs, root, blankSheet("Cell 3", "bad?")), /character/);
  await store.createSheet(nodeFs, root, blankSheet("Cell 3", "O900-1"));
  await store.createSheet(nodeFs, root, blankSheet("Cell 1", "O77"));
  await fs.writeFile(join(root, "Cell 3", "notes.txt"), "not a sheet");
  await fs.mkdir(join(root, "Cell 3", "empty folder"));
  await fs.mkdir(join(root, "Cell 5", "O5"), { recursive: true });
  await fs.writeFile(join(root, "Cell 5", "O5", "sheet.json"), "{ broken");
  const list = await store.listSheets(nodeFs, root);
  assert.deepEqual(list.map((s) => `${s.group}/${s.program}`), ["Cell 1/O77", "Cell 3/O900-1", "Cell 3/O1001-1", "Cell 5/O5"]); // numeric order: O900 before O1001
  assert.ok(list[3].error && !list[3].sheet);
  assert.equal(list[2].sheet.part.number, "1001");
  step("store: create, refuse duplicates and bad names, list in number order, broken file listed");
}
{
  assert.deepEqual(await store.acquire(nodeFs, dir, me), { ok: true });
  assert.deepEqual(await store.acquire(nodeFs, dir, me), { ok: true }, "same window again");
  const r = await store.acquire(nodeFs, dir, other);
  assert.equal(r.ok, false);
  assert.equal(r.holder.user, "sam");
  assert.equal(r.holder.stale, false);
  let { sheet, hash } = await store.openSheet(nodeFs, dir);
  const tr = store.tracker();
  sheet.part.name = "Changed";
  tr.rev++;
  assert.ok(tr.dirty);
  hash = await store.save(nodeFs, dir, sheet, hash, me, tr);
  assert.ok(!tr.dirty);
  const back = (await store.openSheet(nodeFs, dir)).sheet;
  assert.equal(back.part.name, "Changed");
  assert.equal(back.saved_by, "sam");
  assert.ok(Date.now() - Date.parse(back.saved_at) < 60000);
  await assert.rejects(store.save(nodeFs, dir, sheet, hash, other), /lock was lost/);
  // someone changed sheet.json behind our back
  await fs.writeFile(join(dir, "sheet.json"), JSON.stringify({ ...back, notes: "edited elsewhere" }));
  await assert.rejects(store.save(nodeFs, dir, sheet, hash, me), /changed on disk/);
  await assert.rejects(store.save(nodeFs, dir, { ...sheet, program: "a/b" }, hash, me), /Not saved/);
  assert.equal(await store.heartbeat(nodeFs, dir, me), true);
  assert.equal(await store.heartbeat(nodeFs, dir, other), false);
  // stale lock: bob may take over, then sam's heartbeat reports the loss
  const lock = JSON.parse(await fs.readFile(join(dir, ".lock"), "utf8"));
  lock.time = new Date(Date.now() - store.STALE_MS - 1000).toISOString();
  await fs.writeFile(join(dir, ".lock"), JSON.stringify(lock));
  const seen = (await store.acquire(nodeFs, dir, other)).holder;
  assert.equal(seen.stale, true);
  await assert.rejects(store.takeOver(nodeFs, dir, other, { ...seen, time: "x" }), /changed since you looked/);
  await store.takeOver(nodeFs, dir, other, seen);
  assert.equal(await store.heartbeat(nodeFs, dir, me), false);
  assert.deepEqual(await store.acquire(nodeFs, dir, other), { ok: true }, "the taker keeps its id");
  await store.release(nodeFs, dir, me); // not ours: left alone
  assert.ok(await nodeFs.stat(join(dir, ".lock")));
  await store.release(nodeFs, dir, other);
  assert.equal(await nodeFs.stat(join(dir, ".lock")), null);
  await fs.writeFile(join(dir, "sheet.json"), JSON.stringify(sample())); // back to the sample for the copies below
  step("lock + save: one editor, stamped, refuses lost lock / changed file / bad name, stale takeover");
}
{
  const a = await store.addAsset(nodeFs, dir, JPEG, "jpg");
  assert.equal(a, (await sha256(JPEG)) + ".jpg");
  assert.equal(await store.addAsset(nodeFs, dir, JPEG, "jpg"), a, "same picture, same file");
  const s = sample();
  s.pictures = [{ file: a, caption: "Front" }];
  s.signoff.proven_by = "Bob";
  const cd = await store.copySheet(nodeFs, dir, s, root, "Cell 3", "O1001-2");
  const c = (await store.openSheet(nodeFs, cd)).sheet;
  assert.equal(c.program, "O1001-2");
  assert.equal(c.signoff.proven_by, "");
  assert.equal(c.signoff.programmer, "Sam");
  assert.equal(c.copied_from, "Cell 3 / O1001-1");
  assert.equal(c.saved_at, null);
  assert.ok(await nodeFs.stat(join(cd, "assets", a)));
  await assert.rejects(store.copySheet(nodeFs, dir, s, root, "Cell 3", "O1001-2"), /already exists/);
  await assert.rejects(store.copySheet(nodeFs, dir, s, root, "Cell 3", "x:y"), /character/);
  step("pictures stored by content hash; copy to a new program carries pictures, clears proven");

  // leaving: pictures the saved sheet does not use are removed, and nothing else
  const unsaved = await store.addAsset(nodeFs, cd, enc("added, never saved"), "png");
  await fs.writeFile(join(cd, "assets", "notes.txt"), "someone's file");
  const present = async () => (await fs.readdir(join(cd, "assets"))).sort();
  const before = await present();
  assert.deepEqual(await store.tidyAssets(nodeFs, cd, me), [], "no lock: nothing removed");
  assert.ok((await store.acquire(nodeFs, cd, other)).ok);
  assert.deepEqual(await store.tidyAssets(nodeFs, cd, me), [], "someone else's lock: nothing removed");
  await store.release(nodeFs, cd, other);
  assert.ok((await store.acquire(nodeFs, cd, me)).ok);
  const good = await fs.readFile(join(cd, "sheet.json"));
  await fs.writeFile(join(cd, "sheet.json"), "{ half written");
  await assert.rejects(store.tidyAssets(nodeFs, cd, me));
  assert.deepEqual(await present(), before, "unreadable sheet.json: nothing removed");
  await fs.writeFile(join(cd, "sheet.json"), good);
  assert.deepEqual(await store.tidyAssets(nodeFs, cd, me), [unsaved]);
  assert.deepEqual(await present(), [a, "notes.txt"].sort());
  assert.equal(await nodeFs.stat(join(cd, ".lock.guard")), null);
  await store.release(nodeFs, cd, me);
  step("leaving removes only unused pictures, only while holding the lock, never on an unreadable sheet");
}

// ---- winansi + wrapping
{
  assert.deepEqual(encodeWinAnsi("Ø±°"), [0xd8, 0xb1, 0xb0]);
  assert.deepEqual(encodeWinAnsi("⌀5 – “x” €"), [0xd8, 0x35, 0x20, 0x96, 0x20, 0x93, 0x78, 0x94, 0x20, 0x80]);
  assert.deepEqual(encodeWinAnsi("a≤b\tc"), [..."a<=b    c"].map((c) => c.charCodeAt(0)));
  assert.deepEqual(encodeWinAnsi("中"), [0x3f]);
  assert.equal(textWidth("AAAA", "R", 10), 4 * 6.67);
  const lines = wrap("one two three four five six seven eight nine ten\nsecond paragraph", "R", 10, 80);
  assert.ok(lines.length > 3 && lines.every((l) => textWidth(l, "R", 10) <= 80), lines.join("|"));
  assert.equal(lines.at(-1), "paragraph");
  const long = wrap("X".repeat(200), "R", 10, 100);
  assert.ok(long.length > 1 && long.every((l) => textWidth(l, "R", 10) <= 100) && long.join("") === "X".repeat(200));
  assert.deepEqual(wrap("", "R", 10, 100), [""]);
  step("PDF text: WinAnsi bytes (Ø ± ⌀ quotes), wrapping keeps lines inside the width");
}

// ---- HTML copy
{
  const s = sample();
  s.pictures = [{ file: "a.jpg", caption: "Front <view>" }, { file: "gone.png", caption: "" }];
  const html = sheetHtml(s, { "a.jpg": dataUrl(JPEG, "a.jpg") }, new Date("2026-11-01T12:00:00Z"));
  assert.ok(isOurs(new TextEncoder().encode(html), "html"));
  assert.ok(html.includes("Pump casing 4&quot; &lt;B&amp;W&gt;"), "escaped");
  assert.ok(!html.includes("<B&W>"));
  assert.ok(html.includes('src="data:image/jpeg;base64,/9j/'));
  assert.ok(html.includes("Front &lt;view&gt;"));
  assert.ok(html.includes("Picture missing: gone.png"));
  assert.ok(html.includes("<li>Clean the pins.</li><li>Probe Work 1.</li>"), "blank steps dropped, numbering stays tight");
  assert.equal((html.match(/<tr>/g) || []).length, 1 + 1 + 1 + 1, "offset head+row, tool head+row; the blank tool row is left out");
  assert.ok(!/<script/i.test(html), "no script: the preview's security policy would block it");
  const bare = sheetHtml(blankSheet("g", "p"));
  assert.ok(!bare.includes("<h2>Tools</h2>") && !bare.includes("<h2>Fixture</h2>") && bare.includes("<h2>Sign-off</h2>"));
  assert.equal(extOf("A.JPEG"), "jpeg");
  step("HTML copy: escaped, pictures inline, missing picture shown, empty sections left out, marker present");
}

// ---- empty columns left out, wide pictures, the machine viewer's big page
{
  const s = sample();
  s.tools = [{ ...blankTool(), number: "1", description: '2.5" CERATIZIT 45 DEG ROUGH FACE MILL', length: "10.836" }, { ...blankTool(), number: "2", description: "DRILL", length: "9.9436" }];
  const W = { number: 46, pocket: 46, description: 170, length: 58, offset: 50, speed: 50, feed: 50, notes: 70 };
  const cols = fitCols(TOOL_COLS, W, s.tools, "description");
  assert.deepEqual(cols.map(([k]) => k), ["number", "description", "length"], "Pocket, Offset and Notes empty: left out");
  assert.equal(cols.reduce((a, [, , w]) => a + w, 0), 540, "still the full width");
  assert.equal(cols.find(([k]) => k === "description")[2], 170 + 46 + 50 + 50 + 50 + 70, "the spare width goes to Description");
  assert.equal(fitCols(TOOL_COLS, W, [{ ...blankTool(), number: "1", notes: "x" }], "description").at(-1)[2], 540 - 46, "no Description: the last column takes it");
  const noted = [{ ...blankTool(), number: "1", description: "DRILL", notes: "x" }];
  const nw = Object.fromEntries(fitCols(TOOL_COLS, toolWidths(noted), noted, "description").map(([k, , w]) => [k, w]));
  assert.equal(nw.notes, 150, "Speed and Feed empty: Notes gets their width");
  assert.equal(Object.values(nw).reduce((a, b) => a + b, 0), 540);
  const sf = [{ ...noted[0], speed: "1200" }];
  assert.equal(fitCols(TOOL_COLS, toolWidths(sf), sf, "description").find(([k]) => k === "notes")[2], 70, "Speed used: the normal widths");
  const html = sheetHtml(s);
  assert.ok(!html.includes("<th>Pocket</th>") && !html.includes("<th>Notes</th>") && html.includes('<td class="num">10.836</td>'));
  assert.ok(!html.includes('<body class="big">') && sheetHtml(s, {}, new Date(), { big: true }).includes('<body class="big">'));

  assert.equal(normalize({ ...s, pictures: [{ file: "a.png", caption: "", wide: "yes" }] }).pictures[0].wide, undefined, "wide only when true");
  assert.equal(normalize({ ...s, pictures: [{ file: "a.png", caption: "", wide: true }] }).pictures[0].wide, true);
  const img = { kind: "rgb", w: 400, h: 200, data: zlib.deflateSync(new Uint8Array(400 * 200 * 3)) };
  s.pictures = [{ file: "a.png", caption: "" }, { file: "d.png", caption: "", wide: true }, { file: "b.png", caption: "" }, { file: "c.png", caption: "" }];
  const L = layoutSheet(s, { "a.png": img, "b.png": img, "c.png": img, "d.png": img });
  const draws = L.pages.flatMap((p) => p.ops.filter((o) => typeof o === "string" && o.includes(" Do Q")).map((o) => o.match(/^q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) /).slice(1).map(Number)));
  assert.equal(draws.length, 4);
  assert.equal(draws[1][0], 540, "the wide picture is the whole width");
  assert.ok(draws[0][0] <= 264 && draws[2][0] <= 264 && draws[3][0] <= 264, "the others half");
  assert.ok(draws[0][2] === 36 + (264 - draws[0][0]) / 2, "the picture before a wide one sits alone, in the left half");
  assert.ok(sheetHtml(s, { "d.png": "data:image/png;base64,AA" }).includes('<figure id="pic-2" class="wide">'));
  step("copies: empty table columns left out (width to Description), lengths right-aligned, wide pictures a row of their own");
}

// ---- PDF copy
function checkPdf(bytes, label) {
  const text = new TextDecoder("latin1").decode(bytes);
  assert.ok(text.startsWith("%PDF-1.4\n"), label);
  assert.ok(isOurs(bytes, "pdf"), label + ": marker");
  // every xref offset points at its "n 0 obj"
  const xref = text.lastIndexOf("\nxref\n") + 1;
  assert.equal(Number(text.match(/startxref\n(\d+)/)[1]), xref, label + ": startxref");
  const [, count] = text.slice(xref).match(/^xref\n0 (\d+)\n/);
  const rows = text.slice(xref).split("\n").slice(3, 2 + Number(count));
  rows.forEach((r, i) => assert.ok(text.startsWith(`${i + 1} 0 obj\n`, Number(r.slice(0, 10))), `${label}: object ${i + 1} offset`));
  // every stream's /Length is right
  for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) assert.equal(text.slice(m.index + m[0].length + Number(m[1]), m.index + m[0].length + Number(m[1]) + 10), "\nendstream", label + ": stream length");
}
const tools = (n) => Array.from({ length: n }, (_, i) => ({ ...blankTool(), number: String(i + 1), description: i % 4 ? "1/2 EM" : "FACE MILL 45° with a long description that wraps onto more lines than one" }));
{
  const s = sample();
  s.saved_at = "2026-11-01T18:05:00Z";
  s.saved_by = "sam";
  const rgb = new Uint8Array(30 * 20 * 3).fill(200);
  s.pictures = [{ file: "p.png", caption: "Fixture (top view)" }, { file: "j.jpg", caption: "" }, { file: "gone.png", caption: "lost" }];
  const imgs = { "p.png": { kind: "rgb", w: 30, h: 20, data: zlib.deflateSync(rgb) }, "j.jpg": { kind: "jpeg", w: 8, h: 6, data: JPEG } };
  const pdf = sheetPdf(s, imgs, new Date("2026-11-01T12:00:00Z"));
  checkPdf(pdf, "sample");
  const t = new TextDecoder("latin1").decode(pdf);
  assert.equal((t.match(/\/Subtype \/Image/g) || []).length, 2);
  assert.ok(t.includes("/Filter /DCTDecode") && t.includes("/Filter /FlateDecode"));
  assert.ok(t.includes("(Line two \\(with parens\\) and a back\\\\slash) Tj"), "escaped string");
  const big = { ...sample(), tools: tools(90) };
  const L = layoutSheet(big);
  assert.ok(L.pages.length >= 3, "90 tools run over several pages");
  const bigPdf = sheetPdf(big);
  checkPdf(bigPdf, "big");
  const bt = new TextDecoder("latin1").decode(bigPdf);
  const lits = (p) => p.ops.filter((o) => typeof o !== "string").map((o) => new TextDecoder("latin1").decode(o));
  const toolPages = L.pages.filter((p) => lits(p).includes("(1/2 EM)"));
  assert.ok(toolPages.length >= 2 && toolPages.every((p) => lits(p).includes("(Description)")), "table head on every page the tool list runs onto");
  assert.ok(bt.includes(`(Page ${L.pages.length} of ${L.pages.length})`));
  const title = new TextDecoder("latin1").decode(sheetPdf(blankSheet("Lathe cell", "Ø-1")));
  assert.ok(title.includes("/Title <feff"), "non-ASCII title as UTF-16");

  const out = join(tmp, "check");
  await fs.mkdir(out);
  await fs.writeFile(join(out, "s.pdf"), pdf);
  await fs.writeFile(join(out, "big.pdf"), bigPdf);
  if (has("qpdf")) {
    for (const f of ["s.pdf", "big.pdf"]) {
      const r = spawnSync("qpdf", ["--check", join(out, f)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
  } else console.log("   (qpdf not installed: skipped its check)");
  if (has("pdftotext")) {
    const r = spawnSync("pdftotext", ["-layout", join(out, "s.pdf"), "-"], { encoding: "utf8" });
    for (const want of ["O1001-1", "Cell 3", "Mill 1, Mill 2", "Set-up sheet for program", 'Pump casing 4" <B&W>', "Locate on the Ø10 pins.", "X0 Y0 center of Ø120 bore ±0.002", "1/2 4FL EM", "1. Clean the pins.", "2. Probe Work 1.", "Fixture (top view)", "Picture missing: gone.png", "Saved 2026-11-01", "Page 1 of"]) assert.ok(r.stdout.replace(/ +/g, " ").includes(want.replace(/ +/g, " ")), `pdftotext: "${want}" missing in:\n${r.stdout}`);
    const big = spawnSync("pdftotext", [join(out, "big.pdf"), "-"], { encoding: "utf8" }).stdout;
    for (let i = 1; i <= 90; i++) assert.ok(new RegExp(`^${i}$`, "m").test(big), `tool ${i} in the big PDF`);
  } else console.log("   (pdftotext not installed: skipped the text check)");
  step("PDF copy: valid structure, pictures embedded (JPEG + deflated RGB), text reads back, long tool list paginates");
}

// ---- writing the copies
{
  const files = { pdf: sheetPdf(sample()), html: new TextEncoder().encode(sheetHtml(sample())) };
  assert.equal(copiesFolder("", dir, "Cell 3"), dir);
  assert.equal(join("C:\\jobs\\Cell 3\\SET-UP SHEETS\\", "O1 SET-UP.pdf"), "C:\\jobs\\Cell 3\\SET-UP SHEETS\\O1 SET-UP.pdf");
  assert.equal(join("\\\\server\\m_data", "Cell 3", "x"), "\\\\server\\m_data\\Cell 3\\x");
  assert.equal(join("/home/m/sheets/", "Cell 3"), "/home/m/sheets/Cell 3");
  assert.equal(copiesFolder("D:\\Shop\\{group}\\SET-UP SHEETS\\", dir, "Cell 3"), "D:\\Shop\\Cell 3\\SET-UP SHEETS");
  const machines = join(tmp, "Machines");
  await fs.mkdir(join(machines, "Cell 3"), { recursive: true });
  const target = copiesFolder(join(machines, "{group}", "SET-UP SHEETS"), dir, "Cell 3");
  const paths = await writeCopies(nodeFs, target, "O1001-1", files);
  assert.deepEqual(paths, { pdf: join(target, "O1001-1 SET-UP.pdf"), html: join(target, "O1001-1 SET-UP.html") });
  assert.deepEqual(new Uint8Array(await fs.readFile(paths.pdf)), files.pdf);
  await writeCopies(nodeFs, target, "O1001-1", files); // its own copies are replaced
  // a group folder that does not exist: refused, nothing created
  await assert.rejects(writeCopies(nodeFs, copiesFolder(join(machines, "{group}", "SET-UP SHEETS"), dir, "Cell 33"), "O1", files), /not there/);
  assert.equal(await nodeFs.stat(join(machines, "Cell 33")), null);
  // an original sheet with the same name is never replaced, and then neither copy is written
  await fs.writeFile(join(target, copyNames("O2").html), "<html>the original sheet</html>");
  await assert.rejects(writeCopies(nodeFs, target, "O2", files), /not made by Jig/);
  assert.equal(await nodeFs.stat(join(target, copyNames("O2").pdf)), null);
  assert.equal(await fs.readFile(join(target, copyNames("O2").html), "utf8"), "<html>the original sheet</html>");
  assert.ok(!isOurs(new TextEncoder().encode("%PDF-1.7 something else"), "pdf"));
  step("copies: {group} folder, last level created, own copies replaced, other files never touched");
}

// ---- publish: every saved sheet, as one release in the publish folder
const pubRoot = join(tmp, "pub-sheets");
const out = join(tmp, "Published", "setup-sheets");
const who = { user: "sam", host: "pc1" };
const saved = (s, extra = {}) => ({ ...s, ...extra, saved_at: new Date().toISOString(), saved_by: "sam" });
const resave = async (d, change) => {
  const s = JSON.parse(await fs.readFile(join(d, "sheet.json"), "utf8"));
  change(s);
  await fs.writeFile(join(d, "sheet.json"), JSON.stringify(saved(s)));
};
const spyFs = (reads) => ({ ...nodeFs, readBytes: (p) => (reads.push(p), nodeFs.readBytes(p)) });
const signed = { programmer: "Sam", date: "2026-11-01", proven_by: "", proven_date: "" };
let dirs, pic;
{
  await fs.mkdir(pubRoot);
  await fs.mkdir(join(tmp, "Published"));
  dirs = {
    a: await store.createSheet(nodeFs, pubRoot, saved(sample())), // Programmer filled, Date not: not signed off
    b: await store.createSheet(nodeFs, pubRoot, saved({ ...sample(), program: "O1001-2", signoff: signed })),
    c: await store.createSheet(nodeFs, pubRoot, blankSheet("Cell 1", "O77")), // made, never saved
    d: await store.createSheet(nodeFs, pubRoot, saved({ ...blankSheet("Cell 5", "O5"), signoff: signed })),
  };
  pic = await store.addAsset(nodeFs, dirs.a, JPEG, "jpg");
  await store.addAsset(nodeFs, dirs.b, JPEG, "jpg");
  await resave(dirs.a, (s) => (s.pictures = [{ file: pic, caption: "Front" }, { file: pic, caption: "Same picture again" }]));
  await resave(dirs.b, (s) => (s.pictures = [{ file: pic, caption: "" }]));

  let plan = await rel.planPublish(nodeFs, pubRoot);
  assert.deepEqual(plan.sheets.map((s) => s.program), ["O1001-1", "O1001-2", "O5"]);
  assert.deepEqual(plan.held, [{ group: "Cell 1", program: "O77", why: "never saved" }]);
  plan = await rel.planPublish(nodeFs, pubRoot, { needSignoff: true });
  assert.deepEqual(plan.sheets.map((s) => s.program), ["O1001-2", "O5"]);
  assert.deepEqual(plan.held.map((h) => h.program + " " + h.why), ["O77 never saved", "O1001-1 not signed off"]);
  assert.ok(rel.signedOff({ signoff: signed }) && !rel.signedOff({ signoff: { ...signed, date: " " } }));

  const r = await rel.publish(nodeFs, pubRoot, out, { who });
  assert.deepEqual([r.release, r.sheets, r.held.length], [1, 3, 1]);
  assert.deepEqual(await rel.verify(nodeFs, out), []);
  const { cur, manifest } = await rel.readManifest(nodeFs, out);
  assert.deepEqual([cur.release, cur.previous], [1, null]);
  assert.deepEqual([manifest.author, manifest.signoff_required], ["sam", false]);
  const a = manifest.sheets.find((x) => x.program === "O1001-1");
  assert.deepEqual(a.pictures, ["assets/" + pic], "the same picture twice is listed once");
  assert.deepEqual(a.part, { number: "1001", revision: "C", name: 'Pump casing 4" <B&W>', operation: "OP 10" });
  assert.equal(manifest.files.filter((f) => f.path === "assets/" + pic).length, 1, "a picture two sheets share is published once");
  const back = JSON.parse(await fs.readFile(join(out, a.file), "utf8"));
  assert.deepEqual(back, (await store.openSheet(nodeFs, dirs.a)).sheet, "published = the saved sheet");
  assert.equal(await nodeFs.stat(join(out, ".publish.lock")), null);
  const same = rel.changes(await rel.planPublish(nodeFs, pubRoot), manifest);
  assert.deepEqual([same.added, same.changed, same.removed, same.same.length], [[], [], [], 3]);
  assert.deepEqual(rel.changes(plan, null).added, ["Cell 3 / O1001-2", "Cell 5 / O5"]);
  step("publish: saved sheets only (never-saved and, when asked, unsigned held back), pictures once, verified");
}
{
  // nothing is published while something is wrong, and the published copy stays as it was
  const before = await fs.readFile(join(out, "current.json"), "utf8");
  await fs.mkdir(join(pubRoot, "500", "O9"), { recursive: true });
  await fs.writeFile(join(pubRoot, "500", "O9", "sheet.json"), "{ broken");
  await assert.rejects(rel.publish(nodeFs, pubRoot, out), /Nothing was published\. Fix these first:\n500 \/ O9: cannot read sheet\.json/);
  await fs.writeFile(join(pubRoot, "500", "O9", "sheet.json"), JSON.stringify(saved({ ...blankSheet("500", "O9"), pictures: [{ file: "f".repeat(64) + ".png", caption: "" }] })));
  await assert.rejects(rel.publish(nodeFs, pubRoot, out), /picture f{64}\.png is missing/);
  await fs.writeFile(join(pubRoot, "500", "O9", "sheet.json"), JSON.stringify(saved({ ...blankSheet("500", "O9"), pictures: [{ file: "../../x.png", caption: "" }] })));
  await assert.rejects(rel.publish(nodeFs, pubRoot, out), /not a name this app gives pictures/);
  // a picture whose bytes do not match its name: refused while copying, and the lock is let go
  const fake = (await sha256(enc("what the name says"))) + ".png";
  await fs.mkdir(join(pubRoot, "500", "O9", "assets"));
  await fs.writeFile(join(pubRoot, "500", "O9", "assets", fake), "something else");
  await fs.writeFile(join(pubRoot, "500", "O9", "sheet.json"), JSON.stringify(saved({ ...blankSheet("500", "O9"), pictures: [{ file: fake, caption: "" }] })));
  await assert.rejects(rel.publish(nodeFs, pubRoot, out), /does not match its name/);
  assert.equal(await nodeFs.stat(join(out, ".publish.lock")), null, "lock released after a failed publish");
  assert.equal(await fs.readFile(join(out, "current.json"), "utf8"), before);
  await fs.rm(join(pubRoot, "500"), { recursive: true });
  // the wrong folder: one holding other things, one whose parent is not there, the sheets folder itself
  const other = join(tmp, "Machines-by-mistake");
  await fs.mkdir(join(other, "assets"), { recursive: true });
  await fs.writeFile(join(other, "assets", "keep.png"), "someone's picture");
  await fs.writeFile(join(other, "notes.txt"), "x");
  await assert.rejects(rel.publish(nodeFs, pubRoot, other), /^Error: Nothing was published\. .* is not a publish folder \(it holds notes\.txt\)/);
  assert.ok(await nodeFs.stat(join(other, "assets", "keep.png")));
  await assert.rejects(rel.publish(nodeFs, pubRoot, join(tmp, "nope", "pub")), /not there/);
  assert.equal(await nodeFs.stat(join(tmp, "nope")), null);
  await assert.rejects(rel.publish(nodeFs, pubRoot, pubRoot + "/"), /cannot be the set-up sheets folder/);
  // the same check on its own, which the app makes before asking "Publish ...?": it says why and writes nothing
  assert.match(await rel.folderProblem(nodeFs, other, pubRoot), /not a publish folder \(it holds notes\.txt\)/);
  assert.match(await rel.folderProblem(nodeFs, join(tmp, "nope", "pub"), pubRoot), /not there/);
  assert.match(await rel.folderProblem(nodeFs, pubRoot, pubRoot), /cannot be the set-up sheets folder/);
  assert.equal(await rel.folderProblem(nodeFs, out, pubRoot), null, "a publish folder is fine");
  assert.equal(await rel.folderProblem(nodeFs, join(tmp, "new-pub"), pubRoot), null, "a new folder is fine");
  assert.equal(await nodeFs.stat(join(tmp, "new-pub")), null, "and is not made by the check");
  step("publish refuses: unreadable sheet, missing / odd / damaged picture, a folder that is not a publish folder");
}
{
  // a second publish moves only what changed
  await resave(dirs.b, (s) => (s.notes = "Changed after release 1"));
  const plan = await rel.planPublish(nodeFs, pubRoot);
  const c = rel.changes(plan, (await rel.readManifest(nodeFs, out)).manifest);
  assert.deepEqual([c.added, c.changed, c.same], [[], ["Cell 3 / O1001-2"], ["Cell 3 / O1001-1", "Cell 5 / O5"]]);
  const oldB = (await rel.readManifest(nodeFs, out)).manifest.sheets.find((x) => x.program === "O1001-2").file;
  const mtime = (await fs.stat(join(out, "assets", pic))).mtimeMs;
  const reads = [];
  assert.equal((await rel.publish(spyFs(reads), pubRoot, out, { who })).release, 2);
  assert.ok(!reads.some((p) => p.endsWith(pic)), "a picture already published is not read again: " + reads.join("\n"));
  assert.equal((await fs.stat(join(out, "assets", pic))).mtimeMs, mtime);
  assert.ok(await nodeFs.stat(join(out, oldB)), "release 1's sheet kept while release 1 is the previous one");
  assert.equal((await rel.publish(nodeFs, pubRoot, out, { who })).release, 3);
  assert.deepEqual((await fs.readdir(join(out, "releases"))).sort(), ["2", "3"], "kept current and previous only");
  assert.equal(await nodeFs.stat(join(out, oldB)), null, "a sheet no kept release uses is removed");
  assert.deepEqual(await rel.verify(nodeFs, out), []);

  // killed just before current.json: the old release stays current; its lock is left, and can be cleared once
  await resave(dirs.d, (s) => (s.notes = "for the killed publish"));
  const k = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--kill-publish", pubRoot, out]);
  assert.equal(k.status, 9, String(k.stderr));
  assert.equal((await rel.readCurrent(nodeFs, out)).release, 3, "old release still current after kill");
  assert.deepEqual(await rel.verify(nodeFs, out), []);
  const err = await rel.publish(nodeFs, pubRoot, out, { who }).catch((e) => e);
  assert.match(err.message, /is publishing to/);
  assert.ok(err.lock?.time, "the error carries the lock it found");
  await assert.rejects(rel.clearPublishLock(nodeFs, out, { raw: "not what is there" }), /changed since you looked/);
  await rel.clearPublishLock(nodeFs, out, err.lock);
  assert.equal((await rel.publish(nodeFs, pubRoot, out, { who })).release, 5, "number 4 is left as garbage, never reused");
  assert.deepEqual((await fs.readdir(join(out, "releases"))).sort(), ["3", "5"]);

  // tamper, then rollback and forward again
  await fs.writeFile(join(out, "assets", pic), "tampered");
  assert.match((await rel.verify(nodeFs, out)).join(), /hash differs/);
  await fs.writeFile(join(out, "assets", pic), JPEG);
  assert.equal(await rel.rollback(nodeFs, out, who), 3);
  assert.deepEqual([(await rel.readCurrent(nodeFs, out)).release, (await rel.readCurrent(nodeFs, out)).previous], [3, 5]);
  assert.deepEqual(await rel.verify(nodeFs, out), []);
  assert.equal(await rel.rollback(nodeFs, out, who), 5);
  assert.equal(await nodeFs.stat(join(out, ".publish.lock")), null);
  step("publish: only changes copied, prune, kill midway keeps old release, cut-off lock cleared, tamper, rollback");
}

// ---- machine viewer: this PC's own copy of the publish folder, the last good one kept
const cache = join(tmp, "cache");
{
  let st = await syncOnce(nodeFs, out, cache);
  assert.deepEqual([st.online, st.release], [true, 5]);
  assert.deepEqual(await rel.verify(nodeFs, cache), []);
  let { cur, manifest } = await readCache(nodeFs, cache);
  assert.equal(cur.release, 5);
  const entry = (m, program) => m.sheets.find((x) => x.program === program);
  const { sheet, pictures } = await loadSheet(nodeFs, cache, entry(manifest, "O1001-1"));
  assert.equal(sheet.part.name, 'Pump casing 4" <B&W>');
  assert.ok(pictures[pic].startsWith("data:image/jpeg;base64,/9j/"));
  // checking again with nothing new reads no sheet or picture
  let reads = [];
  assert.ok((await syncOnce(spyFs(reads), out, cache)).online);
  assert.deepEqual(reads.filter((p) => /[\\/](assets|sheets)[\\/]/.test(p)), []);
  // a new picture on one sheet: only that sheet and that picture travel
  const png2 = enc("second picture");
  const pic2 = await store.addAsset(nodeFs, dirs.d, png2, "png");
  await resave(dirs.d, (s) => (s.pictures = [{ file: pic2, caption: "New" }]));
  await rel.publish(nodeFs, pubRoot, out, { who });
  reads = [];
  st = await syncOnce(spyFs(reads), out, cache);
  assert.equal(st.release, 6);
  const newD = entry((await readCache(nodeFs, cache)).manifest, "O5").file;
  assert.deepEqual(reads.filter((p) => p.startsWith(out) && /[\\/](assets|sheets)[\\/]/.test(p)).map((p) => p.slice(out.length + 1)).sort(), ["assets/" + pic2, newD].sort());
  assert.deepEqual(await rel.verify(nodeFs, cache), []);
  step("machine copy: first copy, nothing re-read when unchanged, only the new sheet and picture travel");

  // share unplugged: the copy on this PC is kept and still shows; status says so
  await fs.rename(out, out + "-gone");
  st = await syncOnce(nodeFs, out, cache);
  assert.deepEqual([st.online, st.release], [false, 6]);
  assert.match(st.error, /cannot reach the publish folder/);
  assert.equal(JSON.parse(await fs.readFile(join(cache, "status.json"), "utf8")).online, false);
  ({ manifest } = await readCache(nodeFs, cache));
  assert.equal((await loadSheet(nodeFs, cache, entry(manifest, "O5"))).pictures[pic2], dataUrl(png2, pic2));
  await fs.rename(out + "-gone", out);
  assert.deepEqual([(st = await syncOnce(nodeFs, out, cache)).online, st.release], [true, 6]);

  // a damaged file in a new release: the PC keeps the last good release, then takes the new one once it is whole
  await resave(dirs.b, (s) => (s.notes = "release 7"));
  await rel.publish(nodeFs, pubRoot, out, { who });
  const b7 = entry((await rel.readManifest(nodeFs, out)).manifest, "O1001-2").file;
  const good = await fs.readFile(join(out, b7));
  await fs.writeFile(join(out, b7), Buffer.alloc(good.length, 32)); // same size, wrong content
  st = await syncOnce(nodeFs, out, cache);
  assert.ok(!st.online && st.release === 6 && /hash does not match/.test(st.error), JSON.stringify(st));
  ({ cur, manifest } = await readCache(nodeFs, cache));
  assert.equal(cur.release, 6);
  assert.equal((await loadSheet(nodeFs, cache, entry(manifest, "O1001-2"))).sheet.notes, "Changed after release 1", "the last good copy still shows");
  await fs.writeFile(join(out, b7), good);
  assert.equal((await syncOnce(nodeFs, out, cache)).release, 7);
  ({ manifest } = await readCache(nodeFs, cache));
  assert.equal((await loadSheet(nodeFs, cache, entry(manifest, "O1001-2"))).sheet.notes, "release 7");
  step("machine copy: share unplugged or a damaged new release -> the last good copy stays and shows; recovers");

  // damaged files on this PC: found when shown, removed, copied again at the next check
  const aFile = entry(manifest, "O1001-1").file;
  const aBytes = await fs.readFile(join(cache, aFile));
  await fs.writeFile(join(cache, aFile), Buffer.alloc(aBytes.length, 32));
  await assert.rejects(loadSheet(nodeFs, cache, entry(manifest, "O1001-1")), /cannot be read from this PC's copy/);
  assert.equal(await nodeFs.stat(join(cache, aFile)), null);
  await fs.writeFile(join(cache, "assets", pic), Buffer.alloc(JPEG.length, 1));
  assert.equal((await loadSheet(nodeFs, cache, entry(manifest, "O1001-2"))).pictures[pic], undefined, "damaged picture shows as missing");
  assert.equal(await nodeFs.stat(join(cache, "assets", pic)), null);
  await fs.writeFile(join(cache, "releases", "7", "manifest.json"), "{}");
  await assert.rejects(readCache(nodeFs, cache), /damaged/);
  assert.ok((await syncOnce(nodeFs, out, cache)).online);
  assert.deepEqual(await rel.verify(nodeFs, cache), [], "all three copied again");
  assert.equal((await loadSheet(nodeFs, cache, entry(manifest, "O1001-1"))).pictures[pic].length > 30, true);
  st = await syncOnce(nodeFs, join(tmp, "Published"), join(tmp, "cache2"));
  assert.deepEqual([st.online, st.release], [false, null]);
  assert.match(st.error, /nothing has been published/);
  assert.equal(await readCache(nodeFs, join(tmp, "cache2")), null);
  step("machine copy: damaged file on the PC found when shown, copied again; nothing published yet reported");

  // sign-off switch on: the unsigned sheet comes off the machines at the next check
  const r = await rel.publish(nodeFs, pubRoot, out, { who, needSignoff: true });
  assert.deepEqual(r.held.map((h) => h.program), ["O77", "O1001-1"]);
  await syncOnce(nodeFs, out, cache);
  ({ manifest } = await readCache(nodeFs, cache));
  assert.deepEqual(manifest.sheets.map((x) => x.program), ["O1001-2", "O5"]);
  assert.equal(manifest.signoff_required, true);

  // finding a sheet: program number first of all, any group, or only this PC's groups
  const all = [...(await rel.readManifest(nodeFs, join(out))).manifest.sheets, { group: "Cell 3", program: "O900", part: {} }, { group: "Lathe cell", program: "O1001-9", part: { number: "77-1" } }];
  assert.deepEqual(findSheets(all, "1001").map((x) => x.group + "/" + x.program), ["Cell 3/O1001-2", "Lathe cell/O1001-9"]);
  assert.deepEqual(findSheets(all, "").map((x) => x.program), ["O900", "O1001-2", "O5", "O1001-9"], "by group, then program number");
  assert.deepEqual(findSheets(all, "1001", ["lathe cell"]).map((x) => x.program), ["O1001-9"]);
  assert.deepEqual(findSheets(all, "pump casing").map((x) => x.program), ["O1001-2"], "part name words");
  assert.deepEqual(splitGroups(" Cell 3, Lathe cell; "), ["Cell 3", "Lathe cell"]);
  const page = sheetHtml(sample(), {}, new Date(), { stamp: "Published 2026-11-01 14:05 (release 7)" });
  assert.ok(page.includes("<span>Published 2026-11-01 14:05 (release 7)</span>") && !page.includes("Copy made"));
  step("viewer: sign-off switch reaches the machines; search by program number, part, group filter");
}

// ---- move a sheet to another group, pictures and all
{
  const mr = join(tmp, "moving");
  await fs.mkdir(mr);
  const s = blankSheet("Cell 3", "O4004-1");
  s.machines = ["Mill 1", "Mill 2"];
  const dir = await store.createSheet(nodeFs, mr, s);
  assert.deepEqual(await store.acquire(nodeFs, dir, me), { ok: true });
  let { sheet, hash } = await store.openSheet(nodeFs, dir);
  sheet.pictures = [{ file: await store.addAsset(nodeFs, dir, JPEG, "jpg"), caption: "OP 10 on the vise" }];
  hash = await store.save(nodeFs, dir, sheet, hash, me);
  await assert.rejects(store.moveSheet(nodeFs, mr, dir, other, "Cell 4", null), /lock was lost/, "only the lock holder moves it");
  await store.createSheet(nodeFs, mr, blankSheet("Cell 2", "O4004-1"));
  await assert.rejects(store.moveSheet(nodeFs, mr, dir, me, "Cell 2", null), /already exists, so this sheet was not moved/);
  await assert.rejects(store.moveSheet(nodeFs, mr, dir, me, "a/b", null), /character/);
  await fs.writeFile(join(dir, ".lock.guard"), "x");
  await assert.rejects(store.moveSheet(nodeFs, mr, dir, me, "Cell 4", null), /being saved/);
  await fs.rm(join(dir, ".lock.guard"));
  // saving waits a moment for a short-lived guard (a heartbeat), and gives up on one that stays
  await fs.writeFile(join(dir, ".lock.guard"), "x");
  const gone = setTimeout(() => fs.rm(join(dir, ".lock.guard")), 300);
  hash = await store.save(nodeFs, dir, sheet, hash, me);
  clearTimeout(gone);
  await fs.writeFile(join(dir, ".lock.guard"), "x");
  await assert.rejects(store.save(nodeFs, dir, sheet, hash, me), /being saved/);
  await fs.rm(join(dir, ".lock.guard"));
  const to = await store.moveSheet(nodeFs, mr, dir, me, "Cell 4", ["HMC 1", "HMC 2"]);
  assert.equal(to, join(mr, "Cell 4", "O4004-1"));
  assert.equal(await nodeFs.stat(dir), null, "the old folder is gone");
  const moved = (await store.openSheet(nodeFs, to)).sheet;
  assert.deepEqual([moved.group, moved.machines, moved.moved_from, moved.saved_at], ["Cell 4", ["HMC 1", "HMC 2"], "Cell 3 / O4004-1", sheet.saved_at]);
  assert.ok(await nodeFs.stat(join(to, "assets", moved.pictures[0].file)), "its picture moved with it");
  assert.deepEqual(await store.acquire(nodeFs, to, me), { ok: true }, "the lock moved with it: still this window's");
  const back = await store.moveSheet(nodeFs, mr, to, me, "Cell 3", null);
  assert.deepEqual((await store.openSheet(nodeFs, back)).sheet.machines, ["HMC 1", "HMC 2"], "machines = null keeps them");
  const copy = (await store.openSheet(nodeFs, await store.copySheet(nodeFs, back, moved, mr, "Cell 3", "O4004-2"))).sheet;
  assert.equal(copy.moved_from, undefined, "a copy does not say it was moved");
  step("move to another machine group: folder, pictures and lock move together; never over a sheet, never mid-save");
}

// ---- 2.5: offline copies whose sheet is gone, and only this app's
{
  const cr = join(tmp, "orphans"), sheets = join(cr, "sheets"), copies = join(cr, "Machines");
  await fs.mkdir(sheets, { recursive: true });
  const keep = blankSheet("Cell 3", "O2002-1");
  await store.createSheet(nodeFs, sheets, keep);
  const files = (sheet) => ({ pdf: sheetPdf(sheet, {}), html: enc(sheetHtml(sheet, {})) });
  await fs.mkdir(join(copies, "Cell 3", "SET-UP SHEETS"), { recursive: true });
  await writeCopies(nodeFs, join(copies, "Cell 3", "SET-UP SHEETS"), "O2002-1", files(keep));
  await writeCopies(nodeFs, join(copies, "Cell 3", "SET-UP SHEETS"), "O1001-1", files(blankSheet("Cell 3", "O1001-1"))); // its sheet deleted
  await fs.mkdir(join(copies, "Cell 6", "SET-UP SHEETS"), { recursive: true });
  await writeCopies(nodeFs, join(copies, "Cell 6", "SET-UP SHEETS"), "O3003-1HT", files(blankSheet("Cell 6", "O3003-1HT"))); // group gone too
  await fs.writeFile(join(copies, "Cell 3", "SET-UP SHEETS", "O9-1 SET-UP.pdf"), "%PDF-1.4 made by another program"); // not ours
  await fs.writeFile(join(copies, "Cell 3", "SET-UP SHEETS", "O2002-1.pdf"), "%PDF-1.4 the CAM system's own sheet");
  const all = await store.listSheets(nodeFs, sheets);
  const tpl = join(copies, "{group}", "SET-UP SHEETS");
  const found = await orphanCopies(nodeFs, tpl, all);
  assert.deepEqual(found.map((c) => `${c.group} ${c.path.split(/[\\/]/).pop()}`).sort(),
    ["Cell 3 O1001-1 SET-UP.html", "Cell 3 O1001-1 SET-UP.pdf", "Cell 6 O3003-1HT SET-UP.html", "Cell 6 O3003-1HT SET-UP.pdf"]);
  assert.deepEqual(await orphanCopies(nodeFs, "", all), [], "copies next to each sheet go with it");
  const one = await orphanCopies(nodeFs, join(copies, "Cell 3", "SET-UP SHEETS"), all);
  assert.deepEqual(one.map((c) => [c.program, c.group]), [["O1001-1", null], ["O1001-1", null]], "one folder for every group: a sheet of that program anywhere keeps it");
  await fs.writeFile(found[0].path, "replaced by hand"); // no longer ours by the time Remove is clicked
  const gone = await removeCopies(nodeFs, found);
  assert.equal(gone.length, 3, "a file that lost the marker is left alone");
  assert.ok(await nodeFs.stat(join(copies, "Cell 3", "SET-UP SHEETS", "O9-1 SET-UP.pdf")), "another maker's file is never touched");
  assert.ok(await nodeFs.stat(join(copies, "Cell 3", "SET-UP SHEETS", "O2002-1 SET-UP.pdf")), "a sheet's own copies stay");
  step("offline copies with no sheet: found per group or in one folder, only this app's removed");
}

// ---- sheets kept in any folder : Cell 3\SET-UP SHEETS and Cell 6-7\TOOLSHEETS, and the main folder
{
  const H = join(tmp, "H", "Machines"), main = join(tmp, "anyfolder-main");
  const a = join(H, "Cell 3", "SET-UP SHEETS"), b = join(H, "Cell 6-7", "TOOLSHEETS");
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  const old = await store.createSheet(nodeFs, main, sample()); // a sheet in the main folder
  const s1 = { ...sample(), program: "O2002-1" };
  const d1 = await store.createSheet(nodeFs, main, s1, join(a, "O2002-1"));
  assert.equal(d1, join(a, "O2002-1"));
  await store.addAsset(nodeFs, d1, JPEG, "jpg");
  const s2 = { ...sample(), group: "Cell 6-7", program: "O2002-1" }; // same program number, another folder
  const d2 = await store.createSheet(nodeFs, main, s2, join(b, "O2002-1"));
  await assert.rejects(store.createSheet(nodeFs, main, s2, d2), /already exists in .*TOOLSHEETS/);
  let known = store.remember([], d1, "Cell 3", "O2002-1");
  known = store.remember(known, d2, "Cell 6-7", "O2002-1");
  known = store.remember(known, d1, "Cell 3", "O2002-1"); // opened again: still once
  known = store.remember(known, old, "Cell 3", "O1001-1"); // a main-folder sheet opened: still listed once
  assert.equal(known.length, 3);
  const names = (r) => r.sheets.map((x) => `${x.group}/${x.program}${x.missing ? " missing" : ""}`);
  let r = await store.listAll(nodeFs, main, known);
  assert.deepEqual(names(r), ["Cell 3/O1001-1", "Cell 3/O2002-1", "Cell 6-7/O2002-1"]);
  assert.ok(r.sheets[0].inRoot && !r.sheets[1].inRoot && r.sheets[1].sheet && !r.rootError);
  assert.equal(store.parentOf(r.sheets[2].dir), b); // the folder shown tells the two O2002-1 apart
  assert.ok(store.sameDir("D:\\Shop\\Cell 3\\", "d:/shop/cell 3") && !store.sameDir("D:\\a", "D:\\ab"));
  // after a restart: settings carry the list, nothing else
  r = await store.listAll(nodeFs, main, JSON.parse(JSON.stringify(known)));
  assert.equal(r.sheets.length, 3);
  // a folder unplugged: listed, greyed, under the names it had; the others still read; back again with no re-adding
  await fs.rename(b, b + " (unplugged)");
  r = await store.listAll(nodeFs, main, known);
  assert.deepEqual(names(r), ["Cell 3/O1001-1", "Cell 3/O2002-1", "Cell 6-7/O2002-1 missing"]);
  let plan = await rel.planPublish(nodeFs, main, { known });
  assert.ok(plan.problems.some((p) => /folder not found: .*TOOLSHEETS/.test(p))); // publishing now would take it off the machines
  await fs.rename(b + " (unplugged)", b);
  assert.deepEqual(names(await store.listAll(nodeFs, main, known)), ["Cell 3/O1001-1", "Cell 3/O2002-1", "Cell 6-7/O2002-1"]);
  // the main folder offline: the known sheets still list
  r = await store.listAll(nodeFs, join(tmp, "no such main"), known);
  assert.ok(r.rootError && r.sheets.length === 3);
  // Remove from list forgets, never deletes
  assert.equal(store.forget(known, d2).length, 2);
  assert.ok(await nodeFs.stat(join(d2, "sheet.json")));
  // publish takes every listed sheet, pictures from each sheet's own folder; one group / program in two folders stops it
  for (const [d, x] of [[old, sample()], [d1, s1], [d2, s2]]) {
    const { hash } = await store.openSheet(nodeFs, d);
    if (d === d1) x.pictures = [{ file: (await fs.readdir(join(d1, "assets")))[0], caption: "" }];
    await store.acquire(nodeFs, d, me);
    await store.save(nodeFs, d, x, hash, me);
    await store.release(nodeFs, d, me);
  }
  const pub = join(tmp, "anyfolder-pub");
  const res = await rel.publish(nodeFs, main, pub, { known });
  assert.equal(res.sheets, 3);
  const twin = join(b, "O1001-1");
  await store.createSheet(nodeFs, main, sample(), twin);
  plan = await rel.planPublish(nodeFs, main, { known: store.remember(known, twin, "Cell 3", "O1001-1") });
  assert.ok(plan.problems.some((p) => /Cell 3 \/ O1001-1 is in two folders/.test(p)));
  // Move to another group: a sheet outside the main folder's layout stays put, only its group changes
  const mv = { ...me, id: "mv" };
  await store.acquire(nodeFs, d2, mv);
  assert.equal(await store.moveSheet(nodeFs, main, d2, mv, "Cell 6-7B", null), d2);
  assert.equal((await store.openSheet(nodeFs, d2)).sheet.group, "Cell 6-7B");
  await store.release(nodeFs, d2, mv);
  // Copy to a new sheet in a folder picked
  const cd = await store.copySheet(nodeFs, d1, s1, main, "Cell 3", "O2002-2", a);
  assert.equal(cd, join(a, "O2002-2"));
  assert.equal((await fs.readdir(join(cd, "assets"))).length, 1);
  step("sheets in any folder: two folders, same name kept apart, unplugged stays listed, publish, move, copy");
}

console.log("all passed");
