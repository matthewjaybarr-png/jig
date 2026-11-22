// Offline copies of a sheet: "<program> SET-UP.pdf" (to print or attach) and "<program> SET-UP.html" (to view
// on screen, pictures zoom on click). Both need nothing else: no network, no app, no other files.
// They go to the offline copies folder from Settings ({group} = the sheet's machine group, e.g.
// D:\Shop\{group}\SET-UP SHEETS), or next to sheet.json when that is not set.
import { join, dirname, writeAtomic } from "./util.js";

// NAME is the name people see. MAKER is the marker inside every copy (below), so copies are known as ours even if
// the name changes. NAME and VERSION are the running app's (tauri.conf.json, the one place they are written), set at start.
export let NAME = "Jig";
export const MAKER = "Jig";
export let VERSION = "";
export const setApp = (name, version) => ((NAME = name || NAME), (VERSION = version || VERSION));

export const copyNames = (program) => ({ pdf: `${program} SET-UP.pdf`, html: `${program} SET-UP.html` });

export function copiesFolder(template, sheetDir, group) {
  const t = (template || "").trim().replace(/[\\/]+$/, "");
  return t ? t.replaceAll("{group}", group) : sheetDir;
}

/** "2026-11-01 14:05" in this PC's time zone; "" for none */
export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Each copy carries a marker near its start: the PDF's /Producer, the HTML's generator meta tag.
const MARK = { pdf: `/Producer (${MAKER}`, html: `<meta name="generator" content="${MAKER}` };
export const isOurs = (bytes, kind) => new TextDecoder("latin1").decode(bytes.subarray(0, 4096)).includes(MARK[kind]);

/**
 * Write both copies. A file of the same name that this app did not make (an original set-up sheet, say)
 * is never replaced: nothing is written and the error names it. Only the folder's last level is created,
 * so a mistyped group does not grow a new tree on the share. -> {pdf, html} full paths
 */
export async function writeCopies(fs, folder, program, files) {
  if (!(await fs.stat(folder))) {
    if (!(await fs.stat(dirname(folder)))) throw new Error(`The offline copies folder is not there: ${dirname(folder)}\nCheck the machine group name, or the offline copies folder in Settings.`);
    await fs.mkdirs(folder);
  }
  const names = copyNames(program);
  const paths = { pdf: join(folder, names.pdf), html: join(folder, names.html) };
  for (const k of ["pdf", "html"])
    if ((await fs.stat(paths[k])) && !isOurs(await fs.readBytes(paths[k]), k))
      throw new Error(`${paths[k]} is already there and was not made by ${NAME}, so nothing was written.\nRename or move that file, then make the copies again.`);
  for (const k of ["pdf", "html"]) await writeAtomic(fs, paths[k], files[k]);
  return paths;
}

/**
 * Offline copies this app made whose sheet is gone: deleted, or moved to another group
 * (its "<program> SET-UP.html" and ".pdf" would otherwise stay in the copies folder). Looks in the copies folder of every
 * group folder there is (template "D:\Shop\{group}\SET-UP SHEETS": each D:\Shop\<group>\SET-UP SHEETS), or in
 * the one folder when the template has no {group}; empty template = next to each sheet, which go with it.
 * sheets = listSheets(). -> [{path, program, group (null: one folder for every group)}]; only files carrying this app's
 * marker, so a sheet someone else made is never listed.
 */
export async function orphanCopies(fs, template, sheets, groupNames) {
  const t = (template || "").trim().replace(/[\\/]+$/, "");
  if (!t) return [];
  const folders = []; // [folder, group | null]
  if (!t.includes("{group}")) folders.push([t, null]);
  else {
    const groups = new Set([...sheets.map((s) => s.group), ...(groupNames ?? [])]);
    const [before] = t.split("{group}");
    if (/[\\/]$/.test(before)) for (const e of await fs.list(before.replace(/[\\/]+$/, "")).catch(() => [])) if (e.isDir) groups.add(e.name);
    for (const g of groups) folders.push([t.replaceAll("{group}", g), g]);
  }
  const out = [];
  for (const [folder, group] of folders) {
    const files = await fs.list(folder).catch(() => []);
    for (const e of files) {
      const m = /^(.+) SET-UP\.(pdf|html)$/i.exec(e.name);
      if (e.isDir || !m) continue;
      const program = m[1];
      if (sheets.some((s) => s.program.toLowerCase() === program.toLowerCase() && (group == null || s.group.toLowerCase() === group.toLowerCase()))) continue;
      const path = join(folder, e.name);
      if (isOurs(await fs.readBytes(path), m[2].toLowerCase())) out.push({ path, program, group });
    }
  }
  return out;
}

/** Removes copies listed by orphanCopies, each only if it still carries this app's marker. -> paths removed */
export async function removeCopies(fs, list) {
  const gone = [];
  for (const c of list) {
    const kind = /\.pdf$/i.test(c.path) ? "pdf" : "html";
    const st = await fs.stat(c.path);
    if (st && !st.isDir && isOurs(await fs.readBytes(c.path), kind)) (await fs.remove(c.path), gone.push(c.path));
  }
  return gone;
}

export function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
