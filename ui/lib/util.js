// A Windows path ("C:\x", "\\server\x") is joined with "\", so paths shown in messages look normal there.
export const join = (a, ...b) => [a.replace(/[\\/]+$/, ""), ...b].join(/\\/.test(a) && !a.includes("/") ? "\\" : "/");
export const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "");
export const enc = (s) => new TextEncoder().encode(s);
export const dec = (b) => new TextDecoder().decode(b);

export async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const toJson = (o) => JSON.stringify(o, null, 1) + "\n";

// write to <path>.tmp then rename over the target: readers see the old or the new file, never half
export async function writeAtomic(fs, path, bytes) {
  const tmp = path + ".tmp";
  await fs.writeBytes(tmp, typeof bytes === "string" ? enc(bytes) : bytes);
  await fs.rename(tmp, path);
}
