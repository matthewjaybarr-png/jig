// Same interface as ui/lib/fs-tauri.js, for the tests and the import script.
import fs from "node:fs/promises";

export const nodeFs = {
  readBytes: async (p) => new Uint8Array(await fs.readFile(p)),
  readText: (p) => fs.readFile(p, "utf8"),
  writeBytes: async (p, bytes, { createNew = false } = {}) => fs.writeFile(p, bytes, { flag: createNew ? "wx" : "w" }),
  list: async (p) => (await fs.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
  stat: async (p) => {
    try {
      const s = await fs.stat(p);
      return { isDir: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  mkdirs: (p) => fs.mkdir(p, { recursive: true }),
  rename: (a, b) => fs.rename(a, b),
  remove: (p) => fs.rm(p, { recursive: true, force: true }),
  copy: (a, b) => fs.copyFile(a, b),
};
