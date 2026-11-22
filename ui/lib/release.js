// Publish folder layout (what the machine viewers read and copy to their own disk):
//   current.json                      {release, previous, manifest_sha256, published_at}
//   releases/<n>/manifest.json        {release, published_at, author, signoff_required, sheets:[...], files:[{path, sha256, size}]}
//   sheets/<sha256>.json              one published sheet, named by its content, shared by releases
//   assets/<sha256>.<ext>             its pictures, content-addressed, shared by releases
//   .publish.lock                     only while a Publish runs
// current.json is the only thing replaced to switch releases, via write-temp-then-rename.
// A release holds every saved sheet (in sheets/, so an
// unchanged sheet is not copied again), files already published are trusted by name + size instead of being read
// back, one Publish at a time (.publish.lock), and only an empty folder or a publish folder is published into.
// No viewer page files and no offline copy: the viewer is this app, and each sheet has its own offline copies.
import { join, dirname, enc, dec, sha256, toJson, writeAtomic } from "./util.js";
import { validate } from "./schema.js";
import { listAll } from "./store.js";
import { PICTURE_EXT } from "./pictures.js";

// The only paths a manifest may name; anything else (e.g. "../x") is refused before any file is touched.
export const SAFE_PATH = new RegExp(`^(assets/[0-9a-f]{64}\\.(${PICTURE_EXT.join("|")})|sheets/[0-9a-f]{64}\\.json)$`);
export const safeRelease = (n) => {
  if (!Number.isInteger(n) || n < 1) throw new Error("bad release number in current.json");
  return n;
};

/** true if the file exists with exactly this content */
export async function matches(fs, path, f) {
  return (await fs.stat(path))?.size === f.size && (await sha256(await fs.readBytes(path))) === f.sha256;
}

export async function readJson(fs, p) {
  return JSON.parse(dec(await fs.readBytes(p)));
}

export async function readCurrent(fs, root) {
  return (await fs.stat(join(root, "current.json"))) ? readJson(fs, join(root, "current.json")) : null;
}

/** The current release: {cur, manifest}, the manifest checked against current.json; null if nothing is published. */
export async function readManifest(fs, root) {
  const cur = await readCurrent(fs, root);
  if (!cur) return null;
  const bytes = await fs.readBytes(join(root, "releases", String(safeRelease(cur.release)), "manifest.json"));
  if ((await sha256(bytes)) !== cur.manifest_sha256) throw new Error("manifest does not match current.json");
  return { cur, manifest: JSON.parse(dec(bytes)) };
}

/** Problems with the current release (missing/tampered files); [] means good. Reads every file. */
export async function verify(fs, root) {
  const cur = await readCurrent(fs, root);
  if (!cur) return ["no current.json"];
  const mp = join(root, "releases", String(safeRelease(cur.release)), "manifest.json");
  if (!(await fs.stat(mp))) return [`manifest of release ${cur.release} is missing`];
  const mbytes = await fs.readBytes(mp);
  if ((await sha256(mbytes)) !== cur.manifest_sha256) return ["manifest does not match current.json"];
  const bad = [];
  for (const f of JSON.parse(dec(mbytes)).files) {
    if (!SAFE_PATH.test(f.path)) return [`unsafe path in manifest: ${f.path}`];
    const p = join(root, f.path);
    if (!(await fs.stat(p))) bad.push(`${f.path}: missing`);
    else if ((await sha256(await fs.readBytes(p))) !== f.sha256) bad.push(`${f.path}: hash differs`);
  }
  return bad;
}

async function nextRelease(fs, root) {
  let max = 0;
  if (await fs.stat(join(root, "releases"))) for (const e of await fs.list(join(root, "releases"))) max = Math.max(max, Number(e.name) || 0);
  return max + 1; // never reuse a number, so a half-written folder from a killed publish is just garbage
}

/** Drop releases other than current/previous, and sheets and pictures they do not use. */
export async function prune(fs, root) {
  const cur = await readCurrent(fs, root);
  if (!cur) return;
  const keep = new Set([cur.release, cur.previous].filter((n) => n != null).map(String));
  const used = new Set();
  for (const e of await fs.list(join(root, "releases"))) {
    if (!keep.has(e.name)) await fs.remove(join(root, "releases", e.name));
    else if (await fs.stat(join(root, "releases", e.name, "manifest.json"))) {
      for (const f of (await readJson(fs, join(root, "releases", e.name, "manifest.json"))).files) used.add(f.path);
    }
  }
  for (const d of ["assets", "sheets"])
    if (await fs.stat(join(root, d)))
      for (const e of await fs.list(join(root, d))) if (!used.has(`${d}/${e.name}`)) await fs.remove(join(root, d, e.name));
}

// prune deletes what it does not know in assets/ and sheets/, so a folder holding anything else (a whole drive, say,
// chosen by mistake) is refused. Only the folder's last level is created, as for the offline copies.
const OURS = /^((current\.json|releases|assets|sheets|\.publish\.lock)(\.tmp)?|desktop\.ini|thumbs\.db)$/i;

/** Why out cannot be published to, or null if it can (it may not exist yet). root = the set-up sheets folder. Writes nothing. */
export async function folderProblem(fs, out, root) {
  const trim = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  if (root && trim(out) === trim(root)) return "The publish folder cannot be the set-up sheets folder itself.\nChoose another folder in Settings.";
  if (!(await fs.stat(out))) {
    if (!(await fs.stat(dirname(out)))) return `The publish folder is not there, nor the folder it would go in: ${dirname(out)}\nCheck the publish folder in Settings.`;
    return null;
  }
  const other = (await fs.list(out)).map((e) => e.name).filter((n) => !OURS.test(n));
  if (other.length) return `${out} is not a publish folder (it holds ${other.slice(0, 3).join(", ")}${other.length > 3 ? ", ..." : ""}).\nChoose an empty or new folder in Settings.`;
  return null;
}

// One Publish (or Roll back) at a time per publish folder: two at once would pick the same release number.
// Never broken by age, like a sheet's .lock.guard; the error carries who holds it so the app can offer to clear it.
const lockPath = (root) => join(root, ".publish.lock");
async function locked(fs, root, who, fn) {
  const mine = JSON.stringify({ user: who?.user ?? null, host: who?.host ?? null, time: new Date().toISOString(), id: Math.random().toString(36).slice(2) });
  try {
    await fs.writeBytes(lockPath(root), enc(mine), { createNew: true });
  } catch (err) {
    if (!(await fs.stat(lockPath(root)))) throw err;
    const raw = await fs.readText(lockPath(root)).catch(() => "");
    let lock;
    try {
      lock = { ...JSON.parse(raw), raw };
    } catch {
      lock = { user: "someone", host: "unknown", time: null, raw };
    }
    throw Object.assign(new Error(`${lock.user ?? "someone"} on ${lock.host ?? "an unknown PC"} is publishing to ${root} - try again in a minute.`), { lock });
  }
  try {
    return await fn();
  } finally {
    if ((await fs.readText(lockPath(root)).catch(() => null)) === mine) await fs.remove(lockPath(root));
  }
}

/** After the user confirmed that a Publish was cut off. observed = err.lock they saw; refused if it changed. */
export async function clearPublishLock(fs, root, observed) {
  if ((await fs.readText(lockPath(root)).catch(() => null)) !== observed.raw) throw new Error("The publish lock changed since you looked - someone is publishing.");
  await fs.remove(lockPath(root));
}

/** Signed off = Programmer and its Date filled in (Settings: "Publish only signed-off sheets"). */
export const signedOff = (s) => Boolean(s.signoff.programmer.trim() && s.signoff.date.trim());

/**
 * What Publish would send, read from the set-up sheets folder; nothing is written. Every saved sheet goes, as
 * saved (edits not saved yet stay out); a sheet never saved, and with needSignoff one not signed off, is held back.
 * known = this PC's sheets kept in other folders (store.listAll). Problems (a sheet.json that cannot be read, a picture
 * missing from assets/, a known sheet's folder that cannot be reached - publishing without it would take it off the
 * machine PCs - or two sheets for one group / program) stop Publish.
 * -> {sheets: [{group, program, dir, sheet, bytes, path}], held: [{group, program, why}], problems: [text]}
 */
export async function planPublish(fs, root, { needSignoff = false, known = [] } = {}) {
  const plan = { sheets: [], held: [], problems: [] };
  const { sheets, rootError } = await listAll(fs, root, known);
  if (rootError) plan.problems.push(`Cannot read the set-up sheets folder ${root}: ${rootError}`);
  const dirs = new Map(); // "group / program" lower case -> first dir
  for (const s of sheets) {
    const name = `${s.group} / ${s.program}`;
    if (s.missing) {
      plan.problems.push(`${name}: folder not found: ${s.dir} (plug it back in, or Remove from list)`);
      continue;
    }
    const k = name.toLowerCase();
    if (dirs.has(k)) plan.problems.push(`${name} is in two folders, and the machine PCs can only get one: ${dirs.get(k)} and ${s.dir}`);
    else dirs.set(k, s.dir);
    if (s.error) {
      plan.problems.push(`${name}: cannot read sheet.json (${s.error})`);
      continue;
    }
    const errs = validate(s.sheet);
    if (errs.length) plan.problems.push(`${name}: ${errs.join("; ")}`);
    else if (!s.sheet.saved_at) plan.held.push({ group: s.group, program: s.program, why: "never saved" });
    else if (needSignoff && !signedOff(s.sheet)) plan.held.push({ group: s.group, program: s.program, why: "not signed off" });
    else {
      for (const p of s.sheet.pictures) {
        if (!SAFE_PATH.test("assets/" + p.file)) plan.problems.push(`${name}: picture "${p.file}" is not a name this app gives pictures`);
        else if (!(await fs.stat(join(s.dir, "assets", p.file)))) plan.problems.push(`${name}: picture ${p.file} is missing from its assets folder`);
      }
      const bytes = enc(toJson(s.sheet));
      plan.sheets.push({ group: s.group, program: s.program, dir: s.dir, sheet: s.sheet, bytes, path: `sheets/${await sha256(bytes)}.json` });
    }
  }
  return plan;
}

/** A plan against the published manifest (or null): -> {added, changed, removed, same}, each a list of "group / program". */
export function changes(plan, manifest) {
  const key = (s) => `${s.group} / ${s.program}`;
  const before = new Map((manifest?.sheets || []).map((s) => [key(s), s.file]));
  const out = { added: [], changed: [], removed: [], same: [] };
  for (const s of plan.sheets) {
    const was = before.get(key(s));
    (was == null ? out.added : was === s.path ? out.same : out.changed).push(key(s));
    before.delete(key(s));
  }
  out.removed = [...before.keys()];
  return out;
}

/**
 * Publish the saved sheets under root (the set-up sheets folder) to out. opts = {who: {user, host}, needSignoff}.
 * Order matters: pictures, sheets, the release folder, and only then current.json, so neither a machine viewer nor
 * a Publish cut off halfway ever meets a release with files missing. -> {release, sheets (count), held}
 */
export async function publish(fs, root, out, { who = null, needSignoff = false, known = [] } = {}) {
  const why = await folderProblem(fs, out, root);
  if (why) throw new Error("Nothing was published. " + why);
  const plan = await planPublish(fs, root, { needSignoff, known });
  if (plan.problems.length) throw new Error("Nothing was published. Fix these first:\n" + plan.problems.slice(0, 10).join("\n"));
  await fs.mkdirs(out);
  return locked(fs, out, who, async () => {
    const cur = await readCurrent(fs, out);
    const n = await nextRelease(fs, out);
    const at = new Date().toISOString();
    const files = new Map(); // path -> {path, sha256, size}
    // A file already published under its content name with the right size is not read or copied again, so a Publish
    // moves only what changed. Anything copied is checked against its name first.
    const put = async (path, size, getBytes) => {
      if (files.has(path)) return;
      const sha = path.slice(path.indexOf("/") + 1).split(".")[0];
      const dst = join(out, path);
      if ((await fs.stat(dst))?.size !== size) {
        const bytes = await getBytes();
        if ((await sha256(bytes)) !== sha) throw new Error(`${path} does not match its name (the file is damaged), so nothing was published.`);
        await fs.mkdirs(dirname(dst));
        await writeAtomic(fs, dst, bytes);
      }
      files.set(path, { path, sha256: sha, size });
    };
    const index = [];
    for (const s of plan.sheets) {
      const pictures = [...new Set(s.sheet.pictures.map((p) => p.file))];
      for (const file of pictures) {
        const src = join(s.dir, "assets", file);
        await put("assets/" + file, (await fs.stat(src)).size, () => fs.readBytes(src));
      }
      await put(s.path, s.bytes.length, async () => s.bytes);
      const { number, revision, name, operation } = s.sheet.part;
      index.push({ group: s.group, program: s.program, file: s.path, pictures: pictures.map((f) => "assets/" + f), machines: s.sheet.machines, part: { number, revision, name, operation }, saved_at: s.sheet.saved_at, saved_by: s.sheet.saved_by });
    }
    const rel = join(out, "releases", String(n));
    await fs.mkdirs(rel);
    const manifest = enc(toJson({ release: n, published_at: at, author: who?.user ?? null, signoff_required: needSignoff, sheets: index, files: [...files.values()] }));
    await writeAtomic(fs, join(rel, "manifest.json"), manifest);
    await writeAtomic(fs, join(out, "current.json"), toJson({ release: n, previous: cur?.release ?? null, manifest_sha256: await sha256(manifest), published_at: at }));
    await prune(fs, out);
    return { release: n, sheets: index.length, held: plan.held };
  });
}

/** Point current.json back at the previous release (call again to go forward again). */
export async function rollback(fs, root, who = null) {
  return locked(fs, root, who, async () => {
    const cur = await readCurrent(fs, root);
    if (cur?.previous == null) throw new Error("There is no previous release.");
    const mp = join(root, "releases", String(cur.previous), "manifest.json");
    if (!(await fs.stat(mp))) throw new Error(`Release ${cur.previous} is no longer on disk.`);
    await writeAtomic(fs, join(root, "current.json"), toJson({ release: cur.previous, previous: cur.release, manifest_sha256: await sha256(await fs.readBytes(mp)), published_at: new Date().toISOString() }));
    return cur.previous;
  });
}
