// Machine side: mirror a publish folder into this PC's cache, only ever switching the cache to a release whose
// files all arrived and hashed correctly. On any failure the cache keeps the last good copy, and the viewer shows it.
// A file already in the cache
// under its content name with the right size is not read again at every check (a folder of photos would be
// re-read each minute); instead each file is hashed when it is copied, and again when the viewer shows it.
import { join, dirname, dec, sha256, toJson, writeAtomic } from "./util.js";
import { SAFE_PATH, safeRelease, matches, readCurrent, readManifest, prune } from "./release.js";
import { normalize } from "./schema.js";
import { dataUrl } from "./pictures.js";

async function copyFile(fs, src, dst, want) {
  const bytes = await fs.readBytes(src);
  if (want && (await sha256(bytes)) !== want) throw new Error(`${src}: hash does not match the manifest`);
  await fs.mkdirs(dirname(dst));
  await writeAtomic(fs, dst, bytes);
}

/** -> {online, release, error?, checked_at}. online = this PC's copy is the publish folder's current release. Also writes <cache>/status.json. */
export async function syncOnce(fs, src, cache) {
  let status;
  try {
    if (!(await fs.stat(src))) throw new Error(`cannot reach the publish folder ${src}`);
    const cur = await readCurrent(fs, src);
    if (!cur) throw new Error(`nothing has been published to ${src} yet`);
    const mpath = `releases/${safeRelease(cur.release)}/manifest.json`;
    const mbytes = await fs.readBytes(join(src, mpath));
    if ((await sha256(mbytes)) !== cur.manifest_sha256) throw new Error("manifest does not match current.json");
    for (const f of JSON.parse(dec(mbytes)).files) {
      if (!SAFE_PATH.test(f.path)) throw new Error("unsafe path in manifest: " + f.path);
      const dst = join(cache, f.path);
      if ((await fs.stat(dst))?.size !== f.size) await copyFile(fs, join(src, f.path), dst, f.sha256);
    }
    if (!(await matches(fs, join(cache, mpath), { size: mbytes.length, sha256: cur.manifest_sha256 }))) {
      await fs.mkdirs(join(cache, dirname(mpath)));
      await writeAtomic(fs, join(cache, mpath), mbytes);
    }
    if ((await readCurrent(fs, cache).catch(() => null))?.manifest_sha256 !== cur.manifest_sha256) {
      await writeAtomic(fs, join(cache, "current.json"), toJson(cur)); // the switch
      await prune(fs, cache);
    }
    status = { online: true, release: cur.release };
  } catch (err) {
    const have = await readCurrent(fs, cache).catch(() => null);
    status = { online: false, release: have?.release ?? null, error: String(err.message || err) };
  }
  status.checked_at = new Date().toISOString();
  await fs.mkdirs(cache);
  await writeAtomic(fs, join(cache, "status.json"), toJson(status));
  return status;
}

/** This PC's copy: {cur, manifest}, or null when nothing has been copied here yet. */
export async function readCache(fs, cache) {
  try {
    return await readManifest(fs, cache);
  } catch (err) {
    throw new Error(`This PC's copy of the published sheets is damaged (${err.message || err}). The next check copies it again.`);
  }
}

// A file of the cache, checked against its content name. A damaged file is removed, so the next check copies it
// again (it looks for missing files). -> bytes, or null if missing or damaged
async function readChecked(fs, cache, path) {
  let bytes;
  try {
    bytes = await fs.readBytes(join(cache, path));
  } catch {
    return null;
  }
  if ((await sha256(bytes)) === path.slice(path.indexOf("/") + 1).split(".")[0]) return bytes;
  await fs.remove(join(cache, path)).catch(() => {});
  return null;
}

/**
 * One published sheet from this PC's copy, for the viewer. entry = one of manifest.sheets.
 * A missing or damaged picture shows as "Picture missing" (and is copied again at the next check).
 * -> {sheet, pictures: {file: data URL}}
 */
export async function loadSheet(fs, cache, entry) {
  const bytes = SAFE_PATH.test(entry.file) ? await readChecked(fs, cache, entry.file) : null;
  if (!bytes) throw new Error(`${entry.group} / ${entry.program} cannot be read from this PC's copy. It is copied again at the next check, if the publish folder can be reached.`);
  const sheet = normalize(JSON.parse(dec(bytes)));
  const pictures = {};
  for (const p of sheet.pictures) {
    if (pictures[p.file] || !SAFE_PATH.test("assets/" + p.file)) continue;
    const b = await readChecked(fs, cache, "assets/" + p.file);
    if (b) pictures[p.file] = dataUrl(b, p.file);
  }
  return { sheet, pictures };
}

/** "Mill cell, Lathe 2" -> ["Mill cell", "Lathe 2"] (group names can hold spaces) */
export const splitGroups = (text) => (text || "").split(/[,;]/).map((g) => g.trim()).filter(Boolean);

/** The sheets the viewer lists: in groups (none = all), matching every word of q, by group then program number. */
export function findSheets(entries, q, groups = []) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const want = new Set(groups.map((g) => g.toLowerCase()));
  const hay = (e) => [e.program, e.group, e.part?.number, e.part?.name, e.part?.operation].join(" ").toLowerCase();
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  return entries
    .filter((e) => (!want.size || want.has(e.group.toLowerCase())) && words.every((w) => hay(e).includes(w)))
    .sort((a, b) => cmp(a.group, b.group) || cmp(a.program, b.program));
}
