import { tauriFs as fs } from "./lib/fs-tauri.js";
import { join, dirname } from "./lib/util.js";
import * as store from "./lib/store.js";
import { blankSheet, blankTool, blankOffset, PART, FIXTURE, OFFSET_COLS, TOOL_COLS, SIGNOFF, badName } from "./lib/schema.js";
import { sheetHtml } from "./lib/html.js";
import { sheetPdf } from "./lib/pdf.js";
import { CONTROLLERS, offsetHint as machineHint } from "./lib/machines.js";
import { NAME, setApp, copiesFolder, writeCopies, when, copyNames, isOurs, orphanCopies, removeCopies } from "./lib/copies.js";
import { PICTURE_EXT, extOf, mimeOf, dataUrl, pdfImage } from "./lib/pictures.js";
import * as rel from "./lib/release.js";
import { syncOnce, readCache, loadSheet, findSheets, splitGroups } from "./lib/sync.js";
import { isoDate, ISO_DATE } from "./lib/dates.js";

const T = window.__TAURI__;
const app = document.getElementById("app");
const inv = (c, a) => T.core.invoke(c, a);
let settings = {};
let timers = [];
let canLeave = null; // set by an open sheet: asks about unsaved edits, releases the lock

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null && k !== false));
  return e;
};
// replaceChildren, skipping the null / false / undefined that optional parts leave
const fill = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k != null && k !== false));
const btn = (text, onclick, cls, title) => el("button", { textContent: text, onclick, className: cls || "", title: title || "" });
// a sheet in a list: a button, so Tab reaches it and Enter opens it
const card = (onclick, ...kids) => el("button", { type: "button", className: "card", onclick }, ...kids);
const saveSettings = () => inv("settings_write", { text: JSON.stringify(settings, null, 1) });
// Windows' folder box lists folders only, so the title says what is wanted (a file was expected, found 0.2.0)
const pickFolder = async (title, defaultPath) => T.dialog.open({ directory: true, title, defaultPath });
// Sheets kept in any folder: this PC remembers every sheet opened or saved, and the folder last used
// for each machine group. A failed settings write only loses the reminder, never the sheet.
const rememberSheet = (dir, sheet) => {
  settings.sheets = store.remember(settings.sheets, dir, sheet.group, sheet.program);
  settings.lastFolders = { ...settings.lastFolders, [sheet.group]: store.parentOf(dir) };
  return saveSettings().catch(() => {});
};
// The folder box for a new sheet: it starts in the folder last used for this group. -> the folder picked, or null
async function pickSheetFolder(group, program) {
  const tries = [settings.lastFolders?.[group], settings.root && join(settings.root, group), settings.root];
  let start;
  for (const t of tries) if (t && (await fs.stat(t).catch(() => null))) { start = t; break; }
  const parent = await pickFolder(`Choose the folder to keep ${group} / ${program} in (a folder ${program} is made in it)`, start);
  if (!parent) return null;
  settings.lastFolders = { ...settings.lastFolders, [group]: parent };
  return parent;
}
// In-page notices: window.alert showed nothing in the Windows webview.
const note = document.body.appendChild(Object.assign(document.createElement("div"), { id: "notice", hidden: true, title: "Click to dismiss", onclick: () => (note.hidden = true) }));
let noteTimer = 0;
// Escape closes it too, so an error can be dismissed from the keyboard
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !note.hidden) note.hidden = true; });
const notify = (text, isErr) => {
  clearTimeout(noteTimer);
  note.role = isErr ? "alert" : "status"; // read out by a screen reader
  note.textContent = text;
  note.className = isErr ? "err" : "ok";
  note.hidden = false;
  // a done message goes by itself, after time to read it (it covers the sheet); errors stay
  if (!isErr) noteTimer = setTimeout(() => (note.hidden = true), Math.min(15000, 4000 + 50 * text.length));
};
const fail = (err) => notify(String(err?.message || err), true);
// In-page question. window.confirm shows nothing in the Windows app and answers OK by itself (leaving an edited
// sheet would save it without asking), so every question goes through this.
// -> the text of the button clicked; Escape = the last button. Tab stays on its buttons, and focus goes back where it
// was when it closes.
function ask(text, buttons, focus = 0) {
  return new Promise((done) => {
    const back = document.activeElement;
    const close = (b) => { box.remove(); document.removeEventListener("keydown", onKey, true); back?.focus?.(); done(b); };
    const onKey = (e) => {
      if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), close(buttons.at(-1));
      if (e.key !== "Tab") return;
      e.preventDefault();
      const bs = [...box.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
      bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
    };
    const dialog = el("div", { className: "dialog", role: "dialog", ariaModal: "true" },
      el("p", { id: "ask-text", textContent: text }),
      el("div", { className: "row end" }, ...buttons.map((b, i) => btn(b, () => close(b), i === focus ? "primary" : ""))));
    dialog.setAttribute("aria-labelledby", "ask-text");
    const box = el("div", { className: "modal" }, dialog);
    document.body.append(box);
    document.addEventListener("keydown", onKey, true);
    box.querySelectorAll("button")[focus].focus();
  });
}
const clearTimers = () => (timers.forEach(clearInterval), (timers = []));
// The bundled font on the programmer screens only; a machine PC keeps the system font (app.css, body.editor)
// The programmer screens sit beside a sidebar: pages, machine groups and Ctrl+K are always one
// click away. The first-run settings page and the machine PC viewer have no sidebar.
let here = ""; // the page the sidebar marks: home, settings, sheet
let known = []; // the last sheets list read (home), for the sidebar's groups and the Ctrl+K list
let groupFilter = ""; // a machine group picked in the sidebar: the list shows only it
let openNew = false; // New sheet... in the sidebar: home opens its form
const show = (...kids) => {
  clearTimers();
  canLeave = null;
  document.body.classList.toggle("editor", settings.mode !== "machine");
  const shell = settings.mode !== "machine" && Boolean(settings.root);
  document.body.classList.toggle("shell", shell);
  app.replaceChildren(...(shell ? [sidebar(), el("main", { className: "main" }, ...kids)] : kids));
};
const leaveThen = (fn) => async () => { if (!canLeave || (await canLeave())) fn(); };
// small line icons, drawn here: the app's CSP loads nothing from outside
const ICONS = {
  logo: "M12 2v20M2 12h20M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z",
  list: "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01",
  plus: "M12 5v14M5 12h14",
  send: "M21 3L10 14M21 3l-6 18-4-8-8-4z",
  gear: "M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M15 4v4M9 10v4M17 16v4",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4-4",
  folder: "M3 6h6l2 2h10v11H3z",
  sheet: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
  run: "M5 12h14M13 6l6 6-6 6",
};
const ico = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name]);
  svg.append(p);
  return svg;
};
// Publish from a sheet: leave it first (asks about edits, lets go of the lock), so a cancelled file box
// does not leave a released sheet on screen
const fromHome = (fn) => leaveThen(() => { home(); fn(); });
const goGroup = (g) => leaveThen(() => { groupFilter = g; home(); });
function sidebar() {
  const nav = (icon, text, onclick, on, title) => el("button", { type: "button", className: "nav" + (on ? " on" : ""), onclick, title: title || text }, ico(icon), el("span", { textContent: text }));
  const counts = new Map();
  for (const s of known) counts.set(s.group, (counts.get(s.group) || 0) + 1);
  return el("aside", { className: "side" },
    el("div", { className: "brand" }, ico("logo"), el("span", { textContent: NAME })),
    el("button", { type: "button", className: "cmdk", onclick: palette, title: "Find a sheet or run a command (Ctrl+K)" }, ico("search"), el("span", { textContent: "Search..." }), el("kbd", { textContent: "Ctrl K" })),
    el("nav", {},
      nav("list", "All sheets", goGroup(""), here === "home" && !groupFilter),
      nav("plus", "New sheet...", leaveThen(() => { openNew = true; home(); }), false, "Make an empty sheet"),
      nav("send", "Publish...", fromHome(publishNow), false, "Send the saved sheets to the machine PCs"),
      nav("gear", "Settings", leaveThen(settingsPage), here === "settings")),
    counts.size > 0 && el("div", { className: "side-h", textContent: "Machine groups" }),
    counts.size > 0 && el("nav", { className: "groups" }, ...[...counts].map(([g, n]) =>
      el("button", { type: "button", className: "nav" + (here === "home" && groupFilter === g ? " on" : ""), onclick: goGroup(g), title: `Show only ${g}` },
        ico("folder"), el("span", { textContent: g }), el("span", { className: "count", textContent: n })))),
    el("div", { className: "side-foot small" }, el("kbd", { textContent: "Ctrl K" }), " commands  ", el("kbd", { textContent: "/" }), " find"));
}
const drawSide = () => document.querySelector("aside.side")?.replaceWith(sidebar());

// Ctrl+K: one box to open any sheet or press any button of the page. A page button is run by clicking it, so it does
// exactly what it does on the page.
function palette() {
  if (!document.body.classList.contains("shell") || document.querySelector(".modal, .overlay")) return;
  const back = document.activeElement;
  const seen = new Set();
  const cmds = [];
  const add = (c) => { if (!seen.has(c.text)) { seen.add(c.text); cmds.push(c); } };
  for (const b of document.querySelectorAll("main header button:not(:disabled), main .previewbar button:not(:disabled)")) add({ icon: "run", text: b.textContent.trim(), hint: b.title || "This page", run: () => b.click() });
  add({ icon: "list", text: "All sheets", hint: "Go to", run: goGroup("") });
  add({ icon: "plus", text: "New sheet...", hint: "Go to", run: leaveThen(() => { openNew = true; home(); }) });
  add({ icon: "send", text: "Publish...", hint: "Send the saved sheets to the machine PCs", run: fromHome(publishNow) });
  add({ icon: "gear", text: "Settings", hint: "Go to", run: leaveThen(settingsPage) });
  for (const g of new Set(known.map((s) => s.group))) add({ icon: "folder", text: `Group ${g}`, hint: "Show only this machine group", run: goGroup(g) });
  for (const s of known) if (!s.error && !s.missing) add({ icon: "sheet", text: `${s.group} / ${s.program}`, hint: [s.sheet?.part.number, s.sheet?.part.name, s.sheet?.part.operation].filter(Boolean).join("  "), run: leaveThen(() => openSheet(s.dir)) });
  const input = el("input", { type: "search", placeholder: "Type a program, part, group or command...", ariaLabel: "Search or run a command" });
  const list = el("div", { className: "pal-list", role: "listbox" });
  let shown = [], sel = 0;
  const close = () => { box.remove(); back?.focus?.(); };
  const run = (c) => { close(); c.run(); };
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = cmds.filter((c) => words.every((w) => (c.text + " " + c.hint).toLowerCase().includes(w))).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    fill(list, ...shown.map((c, i) => el("button", { type: "button", className: "pal-item" + (i === sel ? " on" : ""), role: "option", onclick: () => run(c), onmousemove: () => { if (sel !== i) { sel = i; draw(); } } },
      ico(c.icon), el("span", { className: "pal-text", textContent: c.text }), el("span", { className: "pal-hint", textContent: c.hint }))),
      !shown.length && el("p", { className: "muted", textContent: "Nothing matches." }));
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  input.oninput = () => { sel = 0; draw(); };
  // block bodies, so no key is stopped by a handler that returns false
  input.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[sel]) run(shown[sel]); }
    else if (e.key === "Tab") { e.preventDefault(); }
  };
  const box = el("div", { className: "overlay", onmousedown: (e) => { if (e.target === box) close(); } },
    el("div", { className: "palette", role: "dialog", ariaModal: "true", ariaLabel: "Search or run a command" },
      el("div", { className: "pal-in" }, ico("search"), input), list,
      el("div", { className: "pal-foot small muted" }, el("kbd", { textContent: "↑↓" }), " choose  ", el("kbd", { textContent: "Enter" }), " open  ", el("kbd", { textContent: "Esc" }), " close")));
  document.body.append(box);
  draw();
  input.focus();
}
document.addEventListener("keydown", (e) => {
  if (!document.body.classList.contains("shell")) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette();
  } else if (e.key === "/" && !e.ctrlKey && !e.altKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.querySelector(".modal, .overlay")) {
    const find = document.querySelector("main input[type=search]");
    if (find) {
      e.preventDefault();
      find.focus();
    }
  }
});
const header = (...kids) => el("header", {}, el("h1", { textContent: NAME }), ...kids);
const sid = () => crypto.getRandomValues(new Uint32Array(2)).join("-");

// The machines are the user's own, added in Settings (name + controller). The controller only changes the work-offset
// hint on the sheet: what that kind of control calls its work offsets.
const machineList = () => (Array.isArray(settings.machines) ? settings.machines : []);
// a tick box per machine from Settings; a machine already on the sheet but no longer in Settings stays listed
function machinePicker(chosen, onchange, disabled) {
  const names = [...new Set([...machineList().map((m) => m.name), ...chosen])];
  if (!names.length) return el("span", { className: "muted small", textContent: "No machines yet: add them in Settings, under Machines." });
  const boxes = names.map((n) => el("input", { type: "checkbox", checked: chosen.includes(n), disabled }));
  for (const b of boxes) b.onchange = () => onchange(names.filter((_, i) => boxes[i].checked));
  return el("span", { className: "row" }, ...names.map((n, i) => el("label", { className: "check tight" }, boxes[i], el("span", { textContent: n }))));
}
const offsetHint = (names) => machineHint(machineList(), names);
// "O1000.NC" -> "O1000": the sheet is named by the program number, not its file
const programName = (s) => s.trim().replace(/\.(nc|tap|eia|min|mpf|h|txt)$/i, "");
// a list line's part, in columns so they read down the list: part number, rev, name (takes the room), operation
const partCols = (p) => [
  el("span", { className: "col pn", textContent: p?.number || "", title: p?.number || "" }),
  el("span", { className: "col rev", textContent: p?.revision ? "Rev " + p.revision : "" }),
  el("span", { className: "col grow", textContent: p?.name || "", title: p?.name || "" }),
  el("span", { className: "col op", textContent: p?.operation || "", title: p?.operation || "" }),
];
// the name and operation columns start as wide as the longest of each in the list
const fitCols = (node, parts) => {
  const ch = (f) => Math.max(6, ...parts.map((p) => (f(p) || "").length)) + "ch";
  node.style.setProperty("--name-ch", ch((p) => p?.name));
  node.style.setProperty("--op-ch", ch((p) => p?.operation));
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Programmer PCs edit sheets; machine PCs only show the published ones
const start = () => (settings.mode === "machine" ? viewerHome() : home());

// ================= sheets list =================
// Offline copies whose sheet is gone, looked for at most every two minutes: with
// {group} in the copies folder that is a folder per machine group, maybe on a share. null = look again.
let orphans = null; // {at, list}
async function home() {
  if (!settings.root) return settingsPage(true);
  const q = el("input", { type: "search", placeholder: "Find: program, part number, part name, operation..." });
  const list = el("div", {}, el("p", { className: "muted", textContent: "Reading the set-up sheets folder..." }));
  const groups = el("datalist", { id: "groups" });
  const form = newSheetForm();
  const pubLine = el("div", { className: "row muted small" });
  const copiesLine = el("div", { className: "row small" });
  const chip = el("span", { className: "chips" });
  const count = el("span", { className: "muted small" });
  const toggleForm = () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector("input").focus(); };
  here = "home";
  show(
    header(el("span", { className: "crumb" }, groupFilter ? el("span", { className: "muted", textContent: "All sheets / " }) : null, groupFilter || "All sheets"), count,
      el("span", { className: "spacer" }), btn("Publish...", publishNow, "", "Send the saved sheets to the machine PCs"), btn("Settings", settingsPage)),
    el("div", { className: "page wide" },
      el("div", { className: "row" }, el("label", { className: "find" }, ico("search"), q, el("kbd", { textContent: "/" })), btn("Open set-up sheet...", openFromFolder, "", "Add a set-up sheet kept in any folder to this list"),
        btn("New sheet...", toggleForm, "primary")),
      chip, pubLine, copiesLine, form, groups, list)
  );
  q.focus();
  if (openNew) {
    openNew = false;
    toggleForm();
  }
  // Arrow keys walk the list; Down from the find box goes to the first sheet
  const cards = () => [...list.querySelectorAll("button.card")];
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && cards().length) {
      e.preventDefault();
      cards()[0].focus();
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cs = cards(), i = cs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && i === 0) q.focus();
    else cs[Math.min(cs.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  });
  const { sheets: all, rootError } = await store.listAll(fs, settings.root, settings.sheets);
  const rootLine = rootError && el("p", { className: "err", textContent: `Cannot read the set-up sheets folder ${settings.root}: ${rootError}` });
  known = all;
  if (groupFilter && !all.some((s) => s.group === groupFilter)) groupFilter = "";
  drawSide();
  groups.append(...[...new Set(all.map((s) => s.group))].map((g) => el("option", { value: g })));
  let published = null; // "group/program" -> its line in the published manifest; null = not known
  // what Publish would change for this sheet; nothing when it is published as saved
  const tag = (s) => {
    if (!published || !s.sheet) return null;
    const p = published.get(`${s.group}/${s.program}`);
    if (p && p.saved_at === s.sheet.saved_at) return null;
    const why = !s.sheet.saved_at ? "never saved" : settings.needSignoff && !rel.signedOff(s.sheet) ? "not signed off" : "";
    return el("span", { className: "tag" + (p ? " warn" : ""), textContent: (p ? "changed since Publish" : "not published") + (why && ` - ${why}`) });
  };
  const draw = () => {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (s) => [s.group, s.program, s.dir, ...(s.sheet ? [...s.sheet.machines, s.sheet.part.number, s.sheet.part.name, s.sheet.part.operation, s.sheet.fixture.name] : [])].join(" ").toLowerCase();
    const shown = all.filter((s) => (!groupFilter || s.group === groupFilter) && words.every((w) => hay(s).includes(w)));
    fill(chip, groupFilter && el("span", { className: "chip" }, ico("folder"), `Group ${groupFilter}`,
      btn("✕", () => { groupFilter = ""; drawSide(); home(); }, "small ghost", "Show every machine group")));
    count.textContent = shown.length === all.length ? plural(all.length, "sheet") : `${shown.length} of ${plural(all.length, "sheet")}`;
    const out = [];
    let group = null;
    const inGroup = new Map();
    for (const s of shown) inGroup.set(s.group, (inGroup.get(s.group) || 0) + 1);
    // the column names once, above the list (a plain row, not a button)
    if (shown.length) out.push(el("div", { className: "card head", ariaHidden: "true" },
      el("span", { className: "name", textContent: "Program" }), el("span", { className: "col pn", textContent: "Part number" }), el("span", { className: "col rev", textContent: "Rev" }),
      el("span", { className: "col grow", textContent: "Part name" }), el("span", { className: "col op", textContent: "Op.", title: "Operation" }),
      published && el("span", { className: "col state", textContent: "Machine PCs" }), el("span", { className: "col saved", textContent: "Saved" })));
    for (const s of shown) {
      if (s.group !== group) out.push(el("h3", { className: "group" }, (group = s.group), el("span", { className: "count", textContent: inGroup.get(s.group) })));
      const where = el("span", { className: "where", textContent: store.parentOf(s.dir) }); // two sheets of one name: the folder tells them apart
      // a folder that cannot be reached stays listed, greyed; Remove from list only forgets it, the files are not touched
      if (s.missing) out.push(el("div", { className: "card two missing" },
        el("span", { className: "line" }, el("span", { className: "name", textContent: s.program }),
          el("span", { className: "grow", textContent: `folder not found: ${s.dir}` }),
          btn("Remove from list", () => forgetSheet(s), "small", "Forget this sheet on this PC. No files are deleted.")),
        where));
      else out.push(card(() => openSheet(s.dir),
        el("span", { className: "line" }, el("span", { className: "name", textContent: s.program }),
          ...(s.error ? [el("span", { className: "grow err", textContent: "Cannot read sheet.json: " + s.error })] : partCols(s.sheet?.part)),
          published && el("span", { className: "col state" }, tag(s)), // no publish manifest: no Publish slot, its room goes to the columns
          el("span", { className: "col saved small", textContent: s.sheet?.saved_at ? `${when(s.sheet.saved_at)}  ${s.sheet.saved_by}` : "" })),
        where));
      if (!s.missing) out.at(-1).classList.add("two");
    }
    if (rootLine) out.unshift(rootLine);
    if (!all.length) out.push(el("div", { className: "empty" }, ico("sheet"),
      el("p", { textContent: "No set-up sheets in this folder yet." }),
      el("p", { className: "muted", textContent: "Start an empty one, or open a sheet kept in another folder." }),
      el("div", { className: "row" }, btn("New sheet...", toggleForm, "primary"))));
    else if (!shown.length) out.push(el("div", { className: "empty" }, el("p", { className: "muted", textContent: "Nothing matches." }),
      el("div", { className: "row" }, btn("Clear the search", () => { q.value = ""; draw(); q.focus(); }), groupFilter && btn("Show every group", () => { groupFilter = ""; drawSide(); home(); }))));
    fitCols(list, shown.map((s) => s.sheet?.part));
    list.replaceChildren(...out);
  };
  const forgetSheet = async (s) => {
    if ((await ask(`Remove ${s.group} / ${s.program} from the list on this PC?\n\n${s.dir}\n\nNo files are deleted. Open set-up sheet... brings it back.`, ["Remove from list", "Cancel"])) !== "Remove from list") return;
    settings.sheets = store.forget(settings.sheets, s.dir);
    await saveSettings().catch(fail);
    home();
  };
  q.oninput = draw;
  draw();
  showOrphans(all, copiesLine);

  // what the machine PCs get now, read from the publish folder
  const rollBack = async (m) => {
    if ((await ask(`Point the machine PCs back at release ${m.cur.previous}?\n\nThey switch at their next check (within a minute). Roll back again to return to release ${m.cur.release}.`, ["Roll back", "Cancel"])) !== "Roll back") return;
    try {
      const n = await underPublishLock(async () => rel.rollback(fs, settings.publishDir, await inv("whoami")));
      if (n != null) notify(`The machine PCs now get release ${n}.`);
    } catch (err) {
      fail(err);
    }
    home();
  };
  const dir = settings.publishDir;
  if (!dir) return fill(pubLine, el("span", { textContent: "Publish folder: not set yet (Settings)." }));
  try {
    const m = await rel.readManifest(fs, dir);
    const why = !m && (await rel.folderProblem(fs, dir, settings.root));
    if (why) return fill(pubLine, el("span", { className: "err", textContent: why.split("\n")[0] }));
    if (!m && !(await fs.stat(dir))) return fill(pubLine, el("span", { textContent: `Publish folder ${dir}: not there yet, or cannot be reached.` }));
    const back = m && m.cur.previous > m.cur.release ? `, rolled back from release ${m.cur.previous}` : "";
    fill(pubLine,
      el("span", { textContent: m ? `Machine PCs get release ${m.cur.release}: ${plural(m.manifest.sheets.length, "sheet")}, published ${when(m.manifest.published_at)}${m.manifest.author ? " by " + m.manifest.author : ""}${back}.` : `Nothing published yet to ${dir}.` }),
      m?.cur.previous != null && btn(`Roll back to release ${m.cur.previous}...`, () => rollBack(m), "small"));
    published = new Map((m?.manifest.sheets || []).map((e) => [`${e.group}/${e.program}`, e]));
    draw();
  } catch (err) {
    fill(pubLine, el("span", { className: "err", textContent: `Cannot read the publish folder ${dir}: ${err.message || err}` }));
  }
}

async function showOrphans(all, line) {
  if (!settings.copiesDir) return;
  try {
    if (!orphans || Date.now() - orphans.at > 120000) orphans = { at: Date.now(), list: await orphanCopies(fs, settings.copiesDir, all) };
  } catch {
    return; // a copies folder that cannot be read says so when copies are made
  }
  const list = orphans.list;
  if (!list.length) return fill(line);
  const files = list.map((c) => c.path.split(/[\\/]/).pop());
  const shown = files.slice(0, 4).join(", ") + (files.length > 4 ? ` and ${files.length - 4} more` : "");
  fill(line,
    el("span", { className: "warn", textContent: `${list.length === 1 ? "An offline copy has" : `${list.length} offline copies have`} no sheet any more: ${shown}.` }),
    btn("Remove them...", async () => {
      const where = [...new Set(list.map((c) => dirname(c.path)))].join("\n");
      if ((await ask(`Remove ${list.length === 1 ? "this offline copy" : `these ${list.length} offline copies`}? Their sheets were deleted or moved.\n\n${files.join("\n")}\n\nin ${where}\n\nOnly copies made by ${NAME} are removed.`, ["Remove them", "Cancel"])) !== "Remove them") return;
      try {
        const gone = await removeCopies(fs, list);
        notify(`Removed ${gone.length === 1 ? "1 offline copy" : `${gone.length} offline copies`}.`);
      } catch (err) {
        fail(err);
      }
      orphans = null;
      showOrphans(all, line);
    }, "small", "Remove the offline copies whose sheet is gone"));
}

// A sheet kept in any folder: pick its sheet.json (or its folder's) and it is listed from now on
async function openFromFolder() {
  const f = await T.dialog.open({ title: "Open a set-up sheet (its sheet.json)", filters: [{ name: "Set-up sheet", extensions: ["json"] }], defaultPath: settings.lastOpenFolder || settings.root || undefined });
  if (!f) return;
  const dir = /sheet\.json$/i.test(f) ? dirname(f) : f;
  if (!(await fs.stat(join(dir, store.FILE)).catch(() => null))) return fail(`${f} is not a ${NAME} set-up sheet: pick the sheet.json in the sheet's folder.`);
  settings.lastOpenFolder = store.parentOf(dir);
  openSheet(dir);
}

// Publish and Roll back hold .publish.lock while they run. One left by a Publish that was cut off (the app closed,
// the PC lost the share) would block every later one, so the user is asked whether to clear it. -> run's result, or null
async function underPublishLock(run) {
  try {
    return await run();
  } catch (err) {
    if (!err.lock) throw err;
    const l = err.lock;
    const a = await ask(`${l.user || "Someone"} on ${l.host || "an unknown PC"} started publishing${l.time ? " " + when(l.time) : ""} and has not finished.\n\nIf that Publish was cut off (${NAME} closed, or the PC lost the share), clear it and carry on?`, ["Clear it and carry on", "Cancel"]);
    if (a !== "Clear it and carry on") return null;
    await rel.clearPublishLock(fs, settings.publishDir, l);
    return run();
  }
}

// Every saved sheet goes to the publish folder as one new release; the machine PCs switch to it at their next check.
async function publishNow() {
  const out = settings.publishDir;
  if (!out) return fail("Set the publish folder in Settings first. It is the folder the machine PCs read.");
  note.hidden = true; // an older notice would sit under the question
  const needSignoff = Boolean(settings.needSignoff);
  // one sheet a line under each heading (one long comma list is hard to read)
  const names = (list) => list.slice(0, 8).map((x) => "    " + x).join("\n") + (list.length > 8 ? `\n    and ${list.length - 8} more` : "");
  const part = (head, list) => list.length > 0 && `${head} (${list.length}):\n${names(list)}`;
  try {
    const why = await rel.folderProblem(fs, out, settings.root);
    if (why) return fail("Nothing was published. " + why); // before the question, not after it
    const plan = await rel.planPublish(fs, settings.root, { needSignoff, known: settings.sheets });
    if (plan.problems.length) return fail("Nothing was published. Fix these first:\n" + plan.problems.slice(0, 10).join("\n"));
    const held = plan.held.map((h) => `${h.group} / ${h.program} (${h.why})`);
    if (!plan.sheets.length) return fail("There are no saved sheets to publish." + (held.length ? "\n\n" + part("Held back", held) : ""));
    const now = await rel.readManifest(fs, out).catch(() => null);
    const c = rel.changes(plan, now?.manifest);
    const same = now && !c.added.length && !c.changed.length && !c.removed.length;
    const go = same ? "Publish anyway" : "Publish";
    const text = [
      (same ? `Nothing has changed since release ${now.cur.release}. Publish again anyway?` : `Publish ${plural(plan.sheets.length, "saved sheet")}?`) + `\nTo: ${out}`,
      part("New", c.added),
      part("Changed", c.changed),
      part("Taken off the machines", c.removed),
      c.same.length > 0 && `The same as now: ${plural(c.same.length, "sheet")}`,
      part("Held back", held),
      "The machine PCs switch to it at their next check (within a minute). Edits not saved yet are not included.",
    ].filter(Boolean);
    if ((await ask(text.join("\n\n"), [go, "Cancel"])) !== go) return;
    notify("Publishing...");
    const who = await inv("whoami");
    const r = await underPublishLock(() => rel.publish(fs, settings.root, out, { who, needSignoff, known: settings.sheets }));
    if (!r) return (note.hidden = true);
    notify(`Published release ${r.release} to ${out}: ${plural(r.sheets, "sheet")}.`);
  } catch (err) {
    fail(err);
  }
  home();
}

function newSheetForm() {
  const group = el("input", { placeholder: "e.g. Mill cell", size: 22 });
  group.setAttribute("list", "groups");
  const program = el("input", { placeholder: "e.g. O1000", size: 18 });
  let chosen = [];
  const create = async () => {
    const sheet = blankSheet(group.value.trim(), programName(program.value));
    sheet.machines = chosen;
    const bad = badName(sheet.group, "Machine group") || badName(sheet.program, "Program");
    if (bad) return fail(bad);
    try {
      const parent = await pickSheetFolder(sheet.group, sheet.program);
      if (!parent) return;
      openSheet(await store.createSheet(fs, settings.root, sheet, join(parent, sheet.program)));
    } catch (err) {
      fail(err);
    }
  };
  // A block body on purpose: a handler that gives back false cancels the key, and `e.key === "Enter" && create()`
  // gave back false for every other key, so nothing could be typed in the box.
  group.onkeydown = program.onkeydown = (e) => { if (e.key === "Enter") create(); };
  const box = (label, input) => el("label", { className: "field" }, el("span", { textContent: label }), input);
  return el("div", { className: "panel", hidden: true },
    el("div", { className: "row bottom" }, box("Machine group", group), box("Program number", program), btn("Create", create, "primary")),
    el("div", { className: "field" }, el("span", { textContent: "Machines" }), machinePicker(chosen, (list) => (chosen = list))),
    el("div", { className: "muted small", textContent: "Type the group and program, tick the machines it runs on, then Create and choose the folder to keep it in: it makes an empty sheet to fill in. The machine group is any name you sort sheets by (a cell, a line, a pair of machines). One sheet per program number." }));
}

// The set-up sheets folder can be typed as well as chosen: a whole path, a folder not a file, made when missing.
// -> true when it is there now
async function rootReady(p) {
  const no = (text) => (fail(text), false);
  if (!p) return no("Type or choose the set-up sheets folder first.");
  if (!/^([A-Za-z]:[\\/]|\\\\[^\\]|\/)/.test(p)) return no("Type the whole path of the set-up sheets folder, starting with the drive, e.g. C:\\SET-UP SHEETS. Or use Choose....");
  const st = await fs.stat(p);
  if (st && !st.isDir) return no(`${p} is a file. The set-up sheets folder must be a folder: the app makes its own files in it.`);
  if (st) return true;
  if ((await ask(`There is no folder ${p} yet. Make it?`, ["Make it", "Cancel"])) !== "Make it") return false;
  try {
    await fs.mkdirs(p);
    return true;
  } catch (err) {
    return no(`Could not make ${p}: ${err.message || err}`);
  }
}

function settingsPage(first) {
  const machine = el("input", { type: "radio", name: "mode", checked: settings.mode === "machine" });
  const editor = el("input", { type: "radio", name: "mode", checked: settings.mode !== "machine" });
  const root = el("input", { value: settings.root || "", placeholder: "e.g. C:\\SET-UP SHEETS" });
  const copies = el("input", { value: settings.copiesDir || "", placeholder: "empty = next to each sheet" });
  const pub = el("input", { value: settings.publishDir || "", placeholder: "not set" });
  const ms = machineList().map((m) => ({ ...m })); // edited here, kept on Save settings
  const msBox = el("div");
  const drawMs = () => fill(msBox,
    ms.length ? el("table", { className: "edit" },
      el("thead", {}, el("tr", {}, el("th", { textContent: "Machine" }), el("th", { textContent: "Controller" }), el("th"))),
      el("tbody", {}, ...ms.map((m, i) => {
        const name = el("input", { value: m.name, placeholder: "e.g. Mill 1" });
        name.oninput = () => (m.name = name.value);
        const ctl = el("select", {}, ...Object.keys(CONTROLLERS).map((c) => el("option", { value: c, textContent: c, selected: c === m.controller })));
        ctl.onchange = () => (m.controller = ctl.value);
        return el("tr", {}, el("td", {}, name), el("td", {}, ctl), el("td", {}, btn("✕", () => { ms.splice(i, 1); drawMs(); }, "small", "Remove this machine")));
      }))) : null,
    el("div", { className: "row" }, btn("Add machine", () => { ms.push({ name: "", controller: "Fanuc" }); drawMs(); msBox.querySelector("tr:last-child input")?.focus(); })));
  drawMs();
  const sign = el("input", { type: "checkbox", checked: Boolean(settings.needSignoff) });
  const groups = el("input", { value: settings.viewGroups || "", placeholder: "empty = every machine group" });
  const choose = (input, title) => btn("Choose...", async () => { const p = await pickFolder(title); if (p) input.value = p; });
  const pubHint = el("p", { className: "muted" });
  const forEditor = el("div", {},
    el("h2", { textContent: "Set-up sheets folder" }),
    el("p", { className: "muted", textContent: "A folder, not a file: the folder this app keeps its set-up sheets in. Use a new, empty one (type its path and it is made for you, or Choose... an existing one). The app makes everything inside it: <machine group>\\<program>\\sheet.json, with its pictures beside it." }),
    el("div", { className: "row" }, root, choose(root, "Choose the set-up sheets folder (a folder, not a file)")),
    el("h2", { textContent: "Offline copies folder" }),
    el("p", { className: "muted", textContent: "Where Make offline copies writes \"<program> SET-UP.pdf\" and \".html\". {group} is replaced by the sheet's machine group, for example D:\\Shop\\{group}\\SET-UP SHEETS. Empty = next to each sheet's sheet.json. A file there that this app did not make is never replaced." }),
    el("div", { className: "row" }, copies, choose(copies, "Choose the offline copies folder")),
    el("h2", { textContent: "Machines" }),
    el("p", { className: "muted", textContent: "The machines your sheets are for. Each sheet ticks the ones it runs on. The controller only changes the hint for naming work offsets (G54, G15 H1, a zero-point table row)." }),
    msBox);
  // off unless sheets must be signed off before they reach the machines
  const forPublish = el("label", { className: "check" }, sign,
    el("span", {}, "Publish only signed-off sheets ", el("span", { className: "muted", textContent: "(Programmer and its Date filled in; the others are held back and listed when you publish)" })));
  const forMachine = el("div", {},
    el("h2", { textContent: "Machine groups to show" }),
    el("p", { className: "muted", textContent: "The machine groups this PC lists, separated by commas, e.g. Mill cell. Empty = every group." }),
    el("div", { className: "row" }, groups));
  const drawMode = () => {
    forEditor.hidden = forPublish.hidden = machine.checked;
    forMachine.hidden = !machine.checked;
    pubHint.textContent = machine.checked
      ? "The folder the programmers publish to. This PC copies it to its own disk and shows that copy, so the sheets still show when the network is down."
      : "Where Publish writes the saved sheets for the machine PCs, which read this folder. Use an empty folder they can reach (on a shared drive, say); nothing else goes in it.";
  };
  machine.onchange = editor.onchange = drawMode;
  drawMode();
  const ready = settings.mode === "machine" ? settings.publishDir : settings.root;
  here = "settings";
  show(
    header(el("span", { className: "crumb", textContent: "Settings" }), el("span", { className: "spacer" }), ready && btn(settings.mode === "machine" ? "Back" : "All sheets", start)),
    el("div", { className: "page" },
      first === true && el("p", { textContent: "Welcome. Choose how this PC is used, then the folders." }),
      el("h2", { textContent: "How is this PC used?" }),
      el("label", { className: "choice" }, editor, el("span", {}, el("b", { textContent: "Programmer" }), el("span", { className: "muted", textContent: " - make and edit set-up sheets, publish them" }))),
      el("label", { className: "choice" }, machine, el("span", {}, el("b", { textContent: "Machine PC" }), el("span", { className: "muted", textContent: " - show the published sheets only; nothing can be changed here" }))),
      forEditor,
      el("h2", { textContent: "Publish folder" }),
      pubHint,
      el("div", { className: "row" }, pub, choose(pub, "Choose the publish folder")),
      forPublish,
      forMachine,
      el("div", { className: "row" }, btn("Save settings", async () => {
        const mode = machine.checked ? "machine" : "editor";
        if (mode === "editor" && !(await rootReady(root.value.trim()))) return;
        if (mode === "machine" && !pub.value.trim()) return fail("Choose the publish folder first: it is what this PC shows.");
        const machines = ms.map((m) => ({ name: m.name.trim(), controller: m.controller })).filter((m) => m.name);
        const dup = machines.find((m, i) => machines.findIndex((x) => x.name.toLowerCase() === m.name.toLowerCase()) !== i);
        if (dup) return fail(`Two machines are called ${dup.name}: give each its own name.`);
        Object.assign(settings, { mode, root: root.value.trim(), copiesDir: copies.value.trim(), publishDir: pub.value.trim(), needSignoff: sign.checked, viewGroups: groups.value.trim(), machines });
        await saveSettings();
        start();
      }, "primary")))
  );
}

// ================= one sheet =================
async function openSheet(dir, keepMe) {
  const me = keepMe || { ...(await inv("whoami")), id: sid() };
  let sheet, hash, lock;
  try {
    lock = await store.acquire(fs, dir, me);
    ({ sheet, hash } = await store.openSheet(fs, dir));
  } catch (err) {
    if (lock?.ok) await store.release(fs, dir, me).catch(() => {});
    return fail(err);
  }
  rememberSheet(dir, sheet);
  let readonly = !lock.ok, lostLock = false;
  const holder = lock.holder;
  const tr = store.tracker();
  const urls = new Map(); // picture file -> blob: URL for its thumbnail

  const status = el("span");
  const saveBtn = btn("Save", () => doSave(), "primary", "Ctrl+S");
  const banner = el("div");
  const body = el("div", { id: "form" });
  // "On this sheet": each section with what is in it, a click away (dev redesign); the one in view is marked
  const rail = el("nav", { className: "rail", ariaLabel: "On this sheet" });
  const railNote = {
    "Work offsets": () => sheet.offsets.length || "",
    Tools: () => sheet.tools.length || "",
    "Set-up steps": () => sheet.steps.length || "",
    Pictures: () => sheet.pictures.length || "",
    "Sign-off": () => (rel.signedOff(sheet) ? "✓" : ""),
  };
  const drawRail = () => {
    if (body.className === "preview") return;
    const secs = [...body.querySelectorAll("section[data-sec]")];
    const top = body.getBoundingClientRect().top + 40;
    const cur = (railPick && secs.includes(railPick) && railPick) || secs.filter((x) => x.getBoundingClientRect().top <= top).at(-1) || secs[0];
    fill(rail, el("div", { className: "side-h", textContent: "On this sheet" }), ...secs.map((x) => {
      const t = x.dataset.sec, n = railNote[t]?.() ?? "";
      const warn = t === "Sign-off" && settings.needSignoff && !n;
      return el("button", { type: "button", className: "nav" + (x === cur ? " on" : ""), onclick: () => { railPick = x; x.scrollIntoView({ block: "start", behavior: "smooth" }); drawRail(); }, title: warn ? "Not signed off yet" : "" },
        el("span", { textContent: t }), warn && el("span", { className: "dot warn", textContent: "●" }), el("span", { className: "count", textContent: n }));
    }));
  };
  let spy = 0, railPick = null; // railPick: the section clicked in the rail stays marked (the last ones can't scroll to the top) until the user scrolls
  for (const e of ["wheel", "keydown", "pointerdown"]) body.addEventListener(e, () => { railPick = null; });
  body.addEventListener("scroll", () => { cancelAnimationFrame(spy); spy = requestAnimationFrame(drawRail); });
  const mark = () => {
    status.textContent = readonly ? "Read only" : tr.dirty ? "Unsaved changes" : sheet.saved_at ? `Saved ${when(sheet.saved_at)}` : "New sheet";
    status.className = tr.dirty ? "warn" : "muted";
    saveBtn.disabled = readonly;
    drawRail();
  };
  const touch = () => (tr.rev++, mark());

  async function doSave() {
    if (readonly) return false;
    try {
      hash = await store.save(fs, dir, sheet, hash, me, tr);
      rememberSheet(dir, sheet);
      mark();
      notify("Saved.");
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function leave() {
    if (tr.dirty) {
      const name = `${sheet.group} / ${sheet.program}`;
      if (readonly) {
        if ((await ask(`Your edits to ${name} cannot be saved: the edit lock is gone.\n(Copy to new sheet... can still keep them.)\n\nDiscard them and leave?`, ["Discard and leave", "Cancel"])) !== "Discard and leave") return false;
      } else {
        const a = await ask(`Save your changes to ${name} before leaving?`, ["Save", "Don't save", "Cancel"]);
        if (a === "Cancel" || (a === "Save" && !(await doSave()))) return false;
      }
    }
    document.removeEventListener("paste", onPaste);
    document.removeEventListener("keydown", onKey);
    for (const u of [...urls.values(), previewUrl]) if (u) URL.revokeObjectURL(u);
    if (!readonly) {
      await store.tidyAssets(fs, dir, me).catch(() => {}); // pictures added and not saved; a failure just leaves them
      await store.release(fs, dir, me).catch(() => {});
    }
    return true;
  }

  function drawBanner() {
    if (lostLock) return banner.replaceChildren(el("div", { className: "banner" }, "The edit lock was lost (someone took over, or the share could not be reached), so this sheet cannot be saved from here. Copy to new sheet... can still keep your edits."));
    if (!readonly) return banner.replaceChildren();
    // yellow: the sheet cannot be changed from here 
    banner.replaceChildren(el("div", { className: "banner" },
      el("span", { textContent: `${holder.user} on ${holder.host} is editing this sheet${holder.time ? ` (last seen ${when(holder.time)})` : ""}. You can look and make offline copies of the saved sheet, but not change it.` }),
      btn("Reload", async () => { if (await leave()) openSheet(dir); }),
      holder.stale && btn("Take over", async () => {
        if ((await ask(`${holder.user}'s lock has not been refreshed for a while, so ${NAME} may have closed without letting go of it.\n\nTake over editing?`, ["Take over", "Cancel"])) !== "Take over") return;
        try {
          await store.takeOver(fs, dir, me, holder);
          if (await leave()) openSheet(dir, me); // the lock is now this window's, under the same id
        } catch (err) {
          fail(err);
        }
      })));
  }

  // ---- form pieces
  const field = (obj, key, label, { area, wide } = {}) => {
    const input = el(area ? "textarea" : "input", { value: obj[key], disabled: readonly });
    input.oninput = () => { obj[key] = input.value; touch(); };
    return el("label", { className: "field" + (wide ? " wide" : "") }, el("span", { textContent: label }), input);
  };
  // Dates are kept one way, 2026-11-03. A date typed another way gets a button that rewrites it; nothing changes without that click.
  const dateField = (obj, key, label) => {
    const box = field(obj, key, label), input = box.querySelector("input"), hint = el("div", { className: "small" });
    input.placeholder = "e.g. 2026-11-03";
    const check = () => {
      const v = obj[key].trim(), d = isoDate(v);
      fill(hint, !v || ISO_DATE.test(v) ? null : !ISO_DATE.test(d) ? el("span", { className: "warn", textContent: "Not a date the app can read: write it like 2026-11-03" })
        : !readonly && btn(`Use ${d}`, () => { obj[key] = input.value = d; touch(); check(); }, "small", `Write it the app's way, ${d}`));
    };
    input.addEventListener("input", check);
    check();
    box.append(hint);
    return box;
  };
  const fixed = (label, value) => el("div", { className: "field" }, el("span", { textContent: label }), el("div", { className: "fixed", textContent: value }));
  const sec = (title, ...kids) => { const x = el("section", {}, el("h3", { textContent: title }), ...kids); x.dataset.sec = title; return x; };
  const move = (arr, i, d, redraw) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    touch();
    redraw();
  };
  const rowButtons = (arr, i, redraw, what) => readonly ? null : el("span", { className: "rowbtns" },
    btn("↑", () => move(arr, i, -1, redraw), "small", "Move up"),
    btn("↓", () => move(arr, i, 1, redraw), "small", "Move down"),
    btn("✕", () => { arr.splice(i, 1); touch(); redraw(); }, "small", "Remove this " + what));

  const COL_W = { number: "7%", pocket: "7%", description: "30%", length: "9%", offset: "8%", speed: "8%", feed: "8%", name: "18%" };
  function editTable(cols, rows, blank, what) {
    const box = el("div");
    const focusRow = (i) => box.querySelector(`input[data-row="${i}"]`)?.focus();
    const insert = (i) => { rows.splice(i, 0, blank()); touch(); redraw(); focusRow(i); };
    const cell = (r, k, i) => {
      const input = el("input", { value: r[k], disabled: readonly });
      input.dataset.row = i;
      input.oninput = () => { r[k] = input.value; touch(); };
      input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); insert(i + 1); } };
      return input;
    };
    function redraw() {
      fill(box,
        rows.length ? el("table", { className: "edit" },
          el("thead", {}, el("tr", {}, ...cols.map(([k, l]) => el("th", { textContent: l, style: COL_W[k] ? `width:${COL_W[k]}` : "" })), el("th"))),
          el("tbody", {}, ...rows.map((r, i) => el("tr", {}, ...cols.map(([k]) => el("td", {}, cell(r, k, i))), el("td", {}, rowButtons(rows, i, redraw, what)))))) : null,
        !readonly && el("div", { className: "row" }, btn("Add " + what, () => insert(rows.length)),
          rows.length > 0 && el("span", { className: "muted small", textContent: "Enter in a row adds a new row below it." })));
    }
    redraw();
    box.redraw = redraw;
    return box;
  }

  const stepsBox = el("div");
  function drawSteps() {
    fill(stepsBox,
      sheet.steps.length ? el("ol", { className: "steps" }, ...sheet.steps.map((s, i) => {
        const ta = el("textarea", { value: s, disabled: readonly, rows: 2 });
        ta.oninput = () => { sheet.steps[i] = ta.value; touch(); };
        return el("li", {}, el("div", { className: "steprow" }, ta, rowButtons(sheet.steps, i, drawSteps, "step")));
      })) : null,
      !readonly && btn("Add step", () => { sheet.steps.push(""); touch(); drawSteps(); [...stepsBox.querySelectorAll("textarea")].at(-1)?.focus(); }));
  }

  // ---- pictures: Add pictures..., drag files in, or paste (a CAM screenshot, say)
  const picsBox = el("div");
  const picsSec = sec("Pictures", picsBox);
  async function thumb(file) {
    if (!urls.has(file)) {
      try {
        urls.set(file, URL.createObjectURL(new Blob([await fs.readBytes(join(dir, "assets", file))], { type: mimeOf(file) })));
      } catch {
        urls.set(file, null);
      }
    }
    return urls.get(file);
  }
  async function drawPics() {
    const cards = [];
    for (const [i, p] of sheet.pictures.entries()) {
      const url = await thumb(p.file);
      const cap = el("input", { value: p.caption, placeholder: "Caption", disabled: readonly });
      cap.oninput = () => { p.caption = cap.value; touch(); };
      // a drawing with small dimensions prints the whole page wide
      const wide = el("input", { type: "checkbox", checked: p.wide === true, disabled: readonly });
      wide.onchange = () => { if (wide.checked) p.wide = true; else delete p.wide; touch(); };
      cards.push(el("div", { className: "pic" },
        url ? el("img", { src: url, alt: p.caption }) : el("div", { className: "missing", textContent: "Picture missing: " + p.file }),
        cap,
        el("label", { className: "check tight small", title: "For drawings: the picture gets a row of its own, the whole page wide, in the PDF and the HTML copy" }, wide, el("span", { textContent: "Whole page width in print" })),
        rowButtons(sheet.pictures, i, drawPics, "picture")));
    }
    fill(picsBox,
      cards.length ? el("div", { className: "pics" }, ...cards) : null,
      !readonly && el("div", { className: "row" }, btn("Add pictures...", pickPictures),
        el("span", { className: "muted small", textContent: "or drag picture files here, or paste a screenshot (Ctrl+V)" })));
  }
  async function addPicture(bytes, name) {
    let ext = extOf(name);
    if (ext === "jpeg") ext = "jpg";
    if (!PICTURE_EXT.includes(ext)) throw new Error(`${name} is not a picture this app can use (${PICTURE_EXT.join(", ")})`);
    sheet.pictures.push({ file: await store.addAsset(fs, dir, bytes, ext), caption: "" });
    touch();
  }
  const addAll = async (items) => {
    try {
      for (const [bytes, name] of items) await addPicture(await bytes(), name);
    } catch (err) {
      fail(err);
    }
    drawPics();
  };
  // Opens where pictures were last picked on this PC, else the Pictures folder (snips and phone photos land there).
  // Once a start folder is given, Windows no longer remembers the last one itself, so the app keeps it in settings.
  async function pickPictures() {
    const start = settings.pictureDir || (await T.path?.pictureDir?.().catch(() => null)) || undefined;
    const picked = await T.dialog.open({ multiple: true, defaultPath: start, filters: [{ name: "Pictures", extensions: PICTURE_EXT }] });
    if (!picked) return;
    const list = [].concat(picked);
    settings.pictureDir = dirname(list[0]).replace(/^([A-Za-z]:)$/, "$1\\"); // "C:" alone means C:'s current folder
    saveSettings().catch(() => {});
    await addAll(list.map((p) => [() => fs.readBytes(p), p]));
  }
  picsSec.ondragover = (e) => { if (!readonly && e.dataTransfer.types.includes("Files")) (e.preventDefault(), picsSec.classList.add("drop")); };
  picsSec.ondragleave = () => picsSec.classList.remove("drop");
  picsSec.ondrop = (e) => {
    e.preventDefault();
    picsSec.classList.remove("drop");
    if (!readonly) addAll([...e.dataTransfer.files].map((f) => [async () => new Uint8Array(await f.arrayBuffer()), f.name]));
  };
  const PASTE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
  function onPaste(e) {
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file" && PASTE_EXT[it.type]).map((it) => it.getAsFile());
    if (readonly || !files.length) return; // plain text pastes into the field as usual
    e.preventDefault();
    addAll(files.map((f) => [async () => new Uint8Array(await f.arrayBuffer()), "pasted." + PASTE_EXT[f.type]])).then(() => notify("Picture added at the end of Pictures."));
  }
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") (e.preventDefault(), doSave());
  }

  function draw() {
    const top = body.scrollTop;
    const hint = el("p", { className: "muted small", textContent: offsetHint(sheet.machines) });
    const machines = machinePicker(sheet.machines, (list) => { sheet.machines = list; hint.textContent = offsetHint(list); touch(); }, readonly);
    body.className = "";
    fill(body,
      sec("Sheet", el("div", { className: "fields" },
        fixed("Machine group", sheet.group), fixed("Program", sheet.program),
        el("div", { className: "field wide" }, el("span", { textContent: "Machines" }), machines))),
      sec("Part", el("div", { className: "fields" }, ...PART.map(([k, l]) => field(sheet.part, k, l)))),
      sec("Fixture", el("div", { className: "fields" }, ...FIXTURE.map(([k, l]) => field(sheet.fixture, k, l))), field(sheet.fixture, "notes", "Fixture notes", { area: true, wide: true })),
      sec("Work offsets", hint, editTable(OFFSET_COLS, sheet.offsets, blankOffset, "offset")),
      sec("Tools", editTable(TOOL_COLS, sheet.tools, blankTool, "tool")),
      sec("Set-up steps", stepsBox),
      picsSec,
      sec("Notes", field(sheet, "notes", "Notes for the operator", { area: true, wide: true })),
      sec("Sign-off", el("div", { className: "fields" }, ...SIGNOFF.map(([k, l]) => (k.endsWith("date") ? dateField : field)(sheet.signoff, k, l)))),
      sheet.copied_from && el("p", { className: "muted small", textContent: `Started as a copy of ${sheet.copied_from}.` })
    );
    drawSteps();
    rail.hidden = false;
    drawRail();
    drawPics().then(() => (body.scrollTop = top));
  }

  // data: URLs for the HTML, converted pictures for the PDF; a missing picture file is shown as missing
  async function pictureData() {
    const pics = {}, imgs = {};
    for (const p of sheet.pictures) {
      if (pics[p.file]) continue;
      let bytes;
      try {
        bytes = await fs.readBytes(join(dir, "assets", p.file));
      } catch {
        continue;
      }
      pics[p.file] = dataUrl(bytes, p.file);
      imgs[p.file] = await pdfImage(bytes, p.file);
    }
    return { pics, imgs };
  }

  // The preview is the HTML copy at a blob: address of its own. In a srcdoc frame the pictures' "#pic-n" zoom links
  // resolved against the app's address and loaded the whole app into the frame (seen in the Windows app).
  // Sandboxed without allow-scripts: nothing in the preview can run.
  let previewUrl = null;
  async function preview() {
    const { pics } = await pictureData();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([sheetHtml(sheet, pics)], { type: "text/html" }));
    const frame = el("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.src = previewUrl;
    body.className = "preview";
    rail.hidden = true;
    fill(body,
      el("div", { className: "previewbar" }, btn("Back to editing", draw, "primary"),
        el("span", { className: "muted small", textContent: "The HTML copy as it would be made now, unsaved edits included. The PDF has the same content on Letter pages." })),
      frame);
  }

  async function makeCopies() {
    if (tr.dirty) {
      if (readonly) return fail("These edits cannot be saved (no edit lock), so no copies were made.");
      if (!(await doSave())) return;
    }
    notify("Making the offline copies...");
    try {
      const { pics, imgs } = await pictureData();
      const now = new Date();
      const paths = await writeCopies(fs, copiesFolder(settings.copiesDir, dir, sheet.group), sheet.program, {
        pdf: sheetPdf(sheet, imgs, now),
        html: new TextEncoder().encode(sheetHtml(sheet, pics, now)),
      });
      notify(`Offline copies written:\n${paths.pdf}\n${paths.html}`);
      orphans = null;
    } catch (err) {
      fail(err);
    }
  }

  // ---- move to another machine group, pictures and all: a sheet filed under the wrong group
  const mGroup = el("input", { placeholder: "e.g. Mill cell", size: 18 });
  mGroup.setAttribute("list", "groups");
  mGroup.onkeydown = (e) => { if (e.key === "Enter") moveNow(); };
  const movePanel = el("div", { className: "panel", hidden: true },
    el("div", { className: "row" }, el("span", { textContent: "Move to machine group:" }), mGroup, btn("Move", () => moveNow(), "primary"), btn("Cancel", () => (movePanel.hidden = true))),
    el("div", { className: "muted small", textContent: "Moves this sheet's folder, pictures and all, to the new group. The next Publish sends it to the new group's machines." }));
  let moving = false;
  async function moveNow() {
    const to = mGroup.value.trim(), from = sheet.group;
    if (readonly) return fail("This sheet cannot be moved from here: the edit lock is someone else's.");
    if (!to || to === from) return fail(`Type the machine group to move ${sheet.program} to.`);
    const bad = badName(to, "Machine group");
    if (bad) return fail(bad);
    if (tr.dirty && ((await ask(`Save your changes to ${from} / ${sheet.program} and move it to ${to}?`, ["Save and move", "Cancel"])) !== "Save and move" || !(await doSave()))) return;
    const perGroup = (settings.copiesDir || "").includes("{group}");
    moving = true; // no heartbeat while the folder is renamed
    let nd;
    try {
      nd = await store.moveSheet(fs, settings.root, dir, me, to, null);
    } catch (err) {
      moving = false;
      return fail(`Not moved: ${err.message || err}`);
    }
    settings.sheets = store.forget(settings.sheets, dir); // remembered again where it is now when it opens
    dir = nd; // leave() lets go of the lock where it is now
    await leave();
    // copies made before say the old group. With {group} they stay behind in the old group's folder: offer to remove
    // them. In one folder for every group, or next to sheet.json (moved with it), the next Make replaces them.
    const at = copiesFolder(settings.copiesDir, nd, from), old = [];
    for (const n of Object.values(copyNames(sheet.program))) {
      const p = join(at, n);
      if ((await fs.stat(p).catch(() => null)) && isOurs(await fs.readBytes(p), n.endsWith(".pdf") ? "pdf" : "html")) old.push({ path: p });
    }
    let said = old.length ? ` Its offline copies still say ${from}: Make offline copies again.` : "";
    if (old.length && perGroup) {
      const a = await ask(`${from} / ${sheet.program} is now ${to} / ${sheet.program}.\n\nIts offline copies made for ${from} are still in ${at}. Remove them? Make offline copies again from the moved sheet.`, ["Remove them", "Keep them"]);
      const gone = a === "Remove them" ? (await removeCopies(fs, old).catch((err) => (fail(err), []))).length : 0;
      said = gone ? ` Its old offline copies were removed: Make offline copies writes them for ${to}.` : ` Its offline copies in ${at} still say ${from}.`;
    }
    orphans = null;
    await openSheet(nd, me);
    notify(`Moved to ${to} / ${sheet.program}.${said}`);
  }

  // ---- copy to a new sheet (another program, or another group)
  const cGroup = el("input", { value: sheet.group, size: 18 });
  cGroup.setAttribute("list", "groups");
  const cProgram = el("input", { placeholder: "New program, e.g. O1001", size: 18 });
  const copyPanel = el("div", { className: "panel", hidden: true },
    el("div", { className: "row" }, el("span", { textContent: "Copy to:" }), cGroup, cProgram,
      btn("Make the copy", async () => {
        try {
          const g = cGroup.value.trim(), p = programName(cProgram.value);
          const bad = badName(g, "Machine group") || badName(p, "Program");
          if (bad) return fail(bad);
          const parent = await pickSheetFolder(g, p);
          if (!parent) return;
          const nd = await store.copySheet(fs, dir, sheet, settings.root, g, p, parent);
          notify(`Copy made: ${cGroup.value.trim()} / ${programName(cProgram.value)}`);
          if (await leave()) openSheet(nd);
        } catch (err) {
          fail(err);
        }
      }, "primary"),
      btn("Cancel", () => (copyPanel.hidden = true))),
    el("div", { className: "muted small", textContent: "Copies what is on screen now, pictures included, into the folder you choose. Proven by and its date are left empty on the copy." }));

  const groups = el("datalist", { id: "groups" });
  fs.list(settings.root).then((es) => groups.append(...es.filter((e) => e.isDir && !e.name.startsWith(".")).map((e) => el("option", { value: e.name }))), () => {});
  here = "sheet";
  show(
    header(
      btn("All sheets", leaveThen(home)),
      el("span", { className: "crumb" }, el("span", { className: "muted", textContent: `${sheet.group} / ` }), sheet.program),
      status,
      el("span", { className: "spacer" }),
      btn("Preview", preview),
      btn("Copy to new sheet...", () => { copyPanel.hidden = !copyPanel.hidden; cProgram.focus(); }),
      btn("Move to group...", () => { movePanel.hidden = !movePanel.hidden; mGroup.focus(); }, "", "Move this sheet to another machine group"),
      btn("Make offline copies", makeCopies, "", "Save, then write the PDF and HTML copies"),
      saveBtn),
    banner, copyPanel, movePanel, groups, el("div", { className: "editwrap" }, body, rail));
  canLeave = leave;
  document.addEventListener("paste", onPaste);
  document.addEventListener("keydown", onKey);
  timers.push(setInterval(async () => {
    if (readonly || moving || (await store.heartbeat(fs, dir, me).catch(() => false))) return;
    readonly = lostLock = true;
    drawBanner();
    mark();
    draw();
  }, 30000));
  drawBanner();
  mark();
  draw();
}

// ================= machine PC: the published sheets, read only =================
// Shows this PC's own copy of the publish folder, never the share itself, and checks the
// share every minute for a new release. If the share cannot be read, the last good copy stays and a banner says so.
async function viewerHome() {
  if (!settings.publishDir) return settingsPage(true);
  const cache = await inv("cache_root");
  const groups = splitGroups(settings.viewGroups);
  let have = null; // this PC's copy: {cur, manifest}
  let status = null; // the last check of the publish folder; null until the first one is done
  let damaged = null; // why this PC's copy cannot be read, if it cannot
  let open = null; // the sheet shown: its line in the manifest
  let busy = false, url = null;

  const state = el("span", { className: "muted" });
  const banner = el("div");
  const q = el("input", { type: "search", className: "big", placeholder: "Program number, e.g. 1001" });
  const results = el("div");
  const listView = el("div", { className: "page wide" },
    el("div", { className: "row" }, q, groups.length > 0 && el("span", { className: "muted", textContent: "Machine groups " + groups.join(", ") })),
    results);
  const crumb = el("span", { className: "crumb" });
  const newer = el("span", { className: "row" });
  const frame = el("iframe");
  frame.setAttribute("sandbox", "allow-same-origin"); // the HTML copy has no script; nothing in it may run
  const sheetView = el("div", { className: "sheetview", hidden: true },
    el("div", { className: "previewbar" }, btn("Back to the list", back, "primary"), crumb, newer), frame);

  function drawState() {
    const m = have?.manifest;
    const what = m ? `Release ${have.cur.release}, published ${when(m.published_at)}` : "";
    state.textContent = !status ? `${what ? what + " · " : ""}checking the publish folder...` : status.online ? `${what} · checked ${when(status.checked_at)}` : what;
    const warn = damaged || (status && !status.online && (m
      ? `Showing the copy kept on this PC (release ${have.cur.release}, published ${when(m.published_at)}). The publish folder could not be read at ${when(status.checked_at)}, so a newer copy may have been published since. It is checked again every minute.\n${status.error}`
      : `There are no published sheets on this PC yet, and the publish folder could not be read:\n${status.error}`));
    fill(banner, warn && el("div", { className: "banner pre", textContent: warn }));
  }

  function drawList() {
    const all = have?.manifest.sheets || [];
    const shown = findSheets(all, q.value, groups);
    const out = [];
    let group = null;
    for (const e of shown) {
      if (e.group !== group) out.push(el("h3", { className: "group", textContent: (group = e.group) }));
      out.push(card(() => view(e),
        el("span", { className: "name", textContent: e.program }),
        ...partCols(e.part)));
    }
    if (!all.length) out.push(el("p", { className: "muted", textContent: have ? "Nothing is published." : status || damaged ? "No published sheets on this PC yet." : "Reading this PC's copy..." }));
    else if (!findSheets(all, "", groups).length) out.push(el("p", { className: "muted", textContent: `Nothing is published for machine group ${groups.join(", ")} (Settings: Machine groups to show).` }));
    else if (!shown.length) out.push(el("p", { className: "muted", textContent: "Nothing matches." }));
    fitCols(results, shown.map((e) => e.part));
    results.replaceChildren(...out);
  }

  // the sheet as its HTML copy, made from this PC's copy (each file checked against its name)
  async function view(e) {
    const from = have;
    try {
      const { sheet, pictures } = await loadSheet(fs, cache, e);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([sheetHtml(sheet, pictures, new Date(), { stamp: `Published ${when(from.manifest.published_at)} (release ${from.cur.release})`, big: true })], { type: "text/html" }));
      frame.src = url;
      open = e;
      crumb.textContent = `${e.group} / ${e.program}`;
      newer.replaceChildren();
      listView.hidden = true;
      sheetView.hidden = false;
    } catch (err) {
      fail(err);
    }
  }
  function back() {
    open = null;
    sheetView.hidden = true;
    listView.hidden = false;
    q.focus();
    q.select();
  }
  // after a new release arrives, say so above the sheet on screen
  function checkOpen() {
    if (!open) return;
    const now = have?.manifest.sheets.find((x) => x.group === open.group && x.program === open.program);
    if (now?.file === open.file) return newer.replaceChildren();
    fill(newer, el("span", { className: "warn", textContent: now ? "A newer version of this sheet was published." : "This sheet is no longer published." }), now && btn("Show it", () => view(now)));
  }

  async function reload() {
    const before = have?.cur.manifest_sha256;
    try {
      have = await readCache(fs, cache);
      damaged = null;
    } catch (err) {
      have = null;
      damaged = String(err.message || err);
    }
    drawState();
    if (!have || have.cur.manifest_sha256 !== before) {
      drawList();
      checkOpen();
    }
  }
  async function check() {
    if (busy) return; // a slow share: the last check is still copying
    busy = true;
    try {
      status = await syncOnce(fs, settings.publishDir, cache);
    } catch (err) {
      status = { online: false, release: null, error: String(err.message || err), checked_at: new Date().toISOString() };
    } finally {
      busy = false;
    }
    await reload();
  }

  q.oninput = drawList;
  q.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const shown = findSheets(have?.manifest.sheets || [], q.value, groups);
    const exact = shown.filter((x) => x.program.toLowerCase() === q.value.trim().toLowerCase());
    if (exact.length === 1 || shown.length === 1) view(exact[0] || shown[0]);
  };
  show(header(el("span", { className: "crumb", textContent: "Machine PC" }), state, el("span", { className: "spacer" }), btn("Settings", settingsPage)), banner, listView, sheetView);
  timers.push(setInterval(check, 60000));
  q.focus();
  drawList();
  reload().then(check);
}

// closing the window asks about unsaved edits and lets go of the edit lock
T.window?.getCurrentWindow?.().onCloseRequested(async (e) => {
  if (document.querySelector(".modal")) return e.preventDefault(); // a question is already open: answer that first
  if (canLeave && !(await canLeave())) e.preventDefault();
});

async function boot() {
  try {
    settings = JSON.parse(await inv("settings_read"));
  } catch {
    settings = {};
  }
  try {
    setApp(await T.app.getName(), await T.app.getVersion());
  } catch {} // copies then say the app name with no version: better than a wrong one
  start();
}
boot();
