// The set-up sheets folder: <root>/<machine group>/<program>/ holds sheet.json, assets/<sha256>.<ext> (pictures)
// and .lock (who is editing). One lock per sheet, so two programmers can work on different sheets.
import { join, enc, dec, sha256, toJson } from "./util.js";
import { normalize, validate, badName } from "./schema.js";

export const STALE_MS = 3 * 60 * 1000; // no heartbeat for this long = stale; heartbeat is every 30 s
export const FILE = "sheet.json";
const file = (dir) => join(dir, FILE);
const lockFile = (dir) => join(dir, ".lock");

/** Every sheet under root, sorted by group then program -> [{group, program, dir, sheet | error}] */
export async function listSheets(fs, root) {
  const out = [];
  for (const g of await fs.list(root)) {
    if (!g.isDir || g.name.startsWith(".")) continue;
    for (const p of await fs.list(join(root, g.name))) {
      const dir = join(root, g.name, p.name);
      if (!p.isDir || !(await fs.stat(file(dir)))) continue;
      try {
        out.push({ group: g.name, program: p.name, dir, sheet: normalize(JSON.parse(dec(await fs.readBytes(file(dir))))) });
      } catch (err) {
        out.push({ group: g.name, program: p.name, dir, error: String(err.message || err) });
      }
    }
  }
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  return out.sort((a, b) => cmp(a.group, b.group) || cmp(a.program, b.program));
}

export const sheetDir = (root, group, program) => join(root, group, program);

// Sheets kept in any folder (two machine groups may keep theirs in different places). This PC remembers
// every sheet opened or saved in settings.sheets = [{dir, group, program}]; the main folder's sheets are listed as before.
const dirKey = (dir) => String(dir).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase(); // Windows: case does not count
export const sameDir = (a, b) => dirKey(a) === dirKey(b);
export const parentOf = (dir) => String(dir).replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
/** known with this sheet (re)remembered under its current names -> new list */
export const remember = (known, dir, group, program) => [...(known || []).filter((k) => !sameDir(k.dir, dir)), { dir, group, program }];
export const forget = (known, dir) => (known || []).filter((k) => !sameDir(k.dir, dir));

/**
 * The main folder's sheets and every known one, once each -> {sheets: [{group, program, dir, inRoot, sheet | error |
 * missing}], rootError}. A known sheet whose folder cannot be reached (a share offline, a USB drive out) stays, {missing: true}
 * under the names it last had; a main folder that cannot be read still lists the known ones.
 */
export async function listAll(fs, root, known = []) {
  let out = [], rootError = null;
  if (root) {
    try {
      out = (await listSheets(fs, root)).map((s) => ({ ...s, inRoot: true }));
    } catch (err) {
      rootError = String(err.message || err);
    }
  }
  const seen = new Set(out.map((s) => dirKey(s.dir)));
  for (const k of known || []) {
    if (!k?.dir || seen.has(dirKey(k.dir))) continue;
    seen.add(dirKey(k.dir));
    const base = { group: k.group || "", program: k.program || "", dir: k.dir, inRoot: false };
    if (!(await fs.stat(file(k.dir)).catch(() => null))) out.push({ ...base, missing: true });
    else {
      try {
        const sheet = normalize(JSON.parse(dec(await fs.readBytes(file(k.dir)))));
        out.push({ ...base, group: sheet.group || base.group, program: sheet.program || base.program, sheet });
      } catch (err) {
        out.push({ ...base, error: String(err.message || err) });
      }
    }
  }
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  out.sort((a, b) => cmp(a.group, b.group) || cmp(a.program, b.program) || cmp(a.dir, b.dir));
  return { sheets: out, rootError };
}

/** Writes a new sheet's folder. sheet.group/program name it; refused if that sheet already exists. -> dir */
export async function createSheet(fs, root, sheet, dir = sheetDir(root, sheet.group, sheet.program)) {
  const errs = validate(sheet);
  if (errs.length) throw new Error(errs.join("\n"));
  if (await fs.stat(dir)) throw new Error(`${sheet.group} / ${sheet.program} already exists in ${parentOf(dir)}`);
  await fs.mkdirs(join(dir, "assets"));
  await fs.writeBytes(file(dir), enc(toJson(sheet)), { createNew: true });
  return dir;
}

/** A new sheet for another program from an existing one: same content and pictures, sign-off "proven" cleared. In
 * parent\<program> when parent is given, else in the main folder. -> dir */
export async function copySheet(fs, fromDir, sheet, root, group, program, parent) {
  for (const e of [badName(group, "Machine group"), badName(program, "Program")]) if (e) throw new Error(e);
  const copy = { ...JSON.parse(JSON.stringify(sheet)), group, program, saved_at: null, saved_by: null };
  copy.signoff = { ...copy.signoff, proven_by: "", proven_date: "" };
  copy.copied_from = `${sheet.group} / ${sheet.program}`;
  delete copy.moved_from;
  const dir = await createSheet(fs, root, copy, parent ? join(parent, program) : undefined);
  for (const p of copy.pictures) await fs.copy(join(fromDir, "assets", p.file), join(dir, "assets", p.file));
  return dir;
}

/**
 * Moves a sheet to another machine group, pictures and all: its folder is renamed to
 * <root>/<group>/<program>, then its sheet.json says the new group and machines (machines = null keeps them) and where it
 * was. Only by the lock holder (the lock moves with the folder), never over a sheet already there, never mid-save. -> new dir
 */
export async function moveSheet(fs, root, dir, me, group, machines) {
  const bad = badName(group, "Machine group");
  if (bad) throw new Error(bad);
  const { sheet } = await openSheet(fs, dir);
  // a sheet kept outside the main folder's group layout stays where it is: only its group changes
  const inRoot = !!root && sameDir(parentOf(parentOf(dir)), root);
  const to = inRoot ? sheetDir(root, group, sheet.program) : dir;
  if (inRoot && (await fs.stat(to))) throw new Error(`${group} / ${sheet.program} already exists, so this sheet was not moved.`);
  if ((await readLock(fs, dir))?.id !== me.id) throw new Error("The edit lock was lost - reload the sheet.");
  if (await fs.stat(join(dir, ".lock.guard"))) throw new Error("The sheet is being saved - try again in a moment.");
  if (inRoot) {
    await fs.mkdirs(join(root, group));
    await fs.rename(dir, to);
  }
  const moved = { ...sheet, group, machines: machines ?? sheet.machines, moved_from: `${sheet.group} / ${sheet.program}` };
  await fs.writeBytes(file(to) + ".tmp", enc(toJson(moved)));
  await fs.rename(file(to) + ".tmp", file(to));
  return to;
}

/** -> {sheet, hash}. The hash is of the bytes on disk, so save() can tell if someone else changed the file. */
export async function openSheet(fs, dir) {
  const bytes = await fs.readBytes(file(dir));
  return { sheet: normalize(JSON.parse(dec(bytes))), hash: await sha256(bytes) };
}

// ---- lock. me = {user, host, id}; id is random per open sheet, so two windows of one user differ.
const stamp = (me) => JSON.stringify({ user: me.user, host: me.host, id: me.id, time: new Date().toISOString() });

async function readLock(fs, dir) {
  try {
    const l = JSON.parse(dec(await fs.readBytes(lockFile(dir))));
    return { ...l, stale: !(Date.now() - Date.parse(l.time) < STALE_MS) };
  } catch (err) {
    if (!(await fs.stat(lockFile(dir)))) return null;
    return { user: "unknown", host: "unknown", id: null, time: null, stale: true }; // unreadable lock
  }
}

/** -> {ok:true} or {ok:false, holder:{user,host,time,stale}}. */
export async function acquire(fs, dir, me) {
  try {
    await fs.writeBytes(lockFile(dir), enc(stamp(me)), { createNew: true });
    return { ok: true };
  } catch {
    const holder = await readLock(fs, dir);
    if (!holder) return acquire(fs, dir, me); // released between our two calls
    return holder.id === me.id ? { ok: true } : { ok: false, holder };
  }
}

// Short exclusive guard around every lock change and every save commit, so a takeover, heartbeat,
// release and save never interleave. It is never broken by age: a paused-but-live writer would then
// be overwritten. A guard left by a crash blocks saving until someone deletes .lock.guard (the error says so).
async function guarded(fs, dir, fn) {
  const g = join(dir, ".lock.guard");
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeBytes(g, enc(token), { createNew: true });
  } catch (err) {
    if (!(await fs.stat(g))) throw err;
    throw Object.assign(new Error("The sheet is being saved or taken over - try again in a moment. If this keeps happening, make sure nobody is saving, then delete .lock.guard in the sheet's folder."), { busy: true });
  }
  try {
    return await fn();
  } finally {
    if ((await fs.readText(g).catch(() => null)) === token) await fs.remove(g);
  }
}

/** Only after the user confirmed a stale lock. observed = the holder they saw ({id, time}); refused if it changed. */
export async function takeOver(fs, dir, me, observed) {
  return guarded(fs, dir, async () => {
    const now = await readLock(fs, dir);
    if (now && (now.id !== observed.id || now.time !== observed.time)) throw new Error("The lock changed since you looked - someone is working on it.");
    await fs.writeBytes(lockFile(dir), enc(stamp(me)));
    return true;
  });
}

/** true while the lock is still ours; refreshes its time. A busy guard just skips this beat. */
export async function heartbeat(fs, dir, me) {
  try {
    return await guarded(fs, dir, async () => {
      if ((await readLock(fs, dir))?.id !== me.id) return false;
      await fs.writeBytes(lockFile(dir), enc(stamp(me)));
      return true;
    });
  } catch (err) {
    if (err.busy) return true;
    throw err;
  }
}

// A busy guard is usually a heartbeat or a guard file Windows has not finished deleting: wait a moment
// (5 x 200 ms) before giving up. Used by saving and leaving a sheet.
async function guardedRetry(fs, dir, fn) {
  for (let i = 0; ; i++) {
    try {
      return await guarded(fs, dir, fn);
    } catch (err) {
      if (!err.busy || i >= 4) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function release(fs, dir, me) {
  try {
    return await guardedRetry(fs, dir, async () => {
      if ((await readLock(fs, dir))?.id === me.id) await fs.remove(lockFile(dir));
    });
  } catch (err) {
    if (!err.busy) throw err;
  }
}

/** Counts edits so a save only clears "unsaved" for the edits it actually wrote. */
export const tracker = () => ({ rev: 0, saved: 0, get dirty() { return this.rev !== this.saved; } });

/**
 * Refuses unless we still hold the lock and nobody changed sheet.json since we loaded it.
 * Stamps saved_at / saved_by. -> new hash
 */
export async function save(fs, dir, sheet, loadedHash, me, track) {
  const errs = validate(sheet);
  if (errs.length) throw new Error("Not saved:\n" + errs.join("\n"));
  const rev = track?.rev; // edits made while the write is pending stay unsaved
  let bytes;
  await guardedRetry(fs, dir, async () => {
    if ((await readLock(fs, dir))?.id !== me.id) throw new Error("The edit lock was lost - reload the sheet.");
    const cur = await fs.readBytes(file(dir));
    if ((await sha256(cur)) !== loadedHash) throw new Error("sheet.json changed on disk since you opened it - reload.");
    Object.assign(sheet, { saved_at: new Date().toISOString(), saved_by: me.user });
    bytes = enc(toJson(sheet));
    await fs.writeBytes(file(dir) + ".tmp", bytes);
    await fs.rename(file(dir) + ".tmp", file(dir));
  });
  if (track) track.saved = rev;
  return sha256(bytes);
}

/** Copy a picture into assets/ under its content hash. -> "<sha>.<ext>" */
export async function addAsset(fs, dir, bytes, ext) {
  const name = `${await sha256(bytes)}.${ext}`;
  const p = join(dir, "assets", name);
  if (!(await fs.stat(p))) {
    await fs.mkdirs(join(dir, "assets"));
    await fs.writeBytes(p + ".tmp", bytes);
    await fs.rename(p + ".tmp", p);
  }
  return name;
}

const ASSET = /^[0-9a-f]{64}\.[a-z0-9]+$/i; // only files addAsset could have made are ever removed

/**
 * Removes pictures in assets/ that the saved sheet.json does not use (added and then not saved, or removed
 * and saved). Run when the editor leaves the sheet. Only while we hold the lock, so another editor's unsaved
 * pictures are never touched; if sheet.json cannot be read, it throws and nothing is removed. -> names removed
 */
export async function tidyAssets(fs, dir, me) {
  return guarded(fs, dir, async () => {
    if ((await readLock(fs, dir))?.id !== me.id) return [];
    const used = new Set(normalize(JSON.parse(dec(await fs.readBytes(file(dir))))).pictures.map((p) => p.file));
    const gone = [];
    for (const e of await fs.list(join(dir, "assets")).catch(() => [])) {
      if (e.isDir || !ASSET.test(e.name) || used.has(e.name)) continue;
      await fs.remove(join(dir, "assets", e.name));
      gone.push(e.name);
    }
    return gone;
  });
}
