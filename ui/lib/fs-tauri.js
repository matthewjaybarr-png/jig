// File access for the app (the Rust side is plain file calls; see src-tauri/src/lib.rs).
const inv = (cmd, args, opts) => window.__TAURI__.core.invoke(cmd, args, opts);

export const tauriFs = {
  readBytes: async (path) => new Uint8Array(await inv("read_file", { path })),
  writeBytes: (path, bytes, { createNew = false } = {}) =>
    inv("write_file", bytes, { headers: { path: encodeURIComponent(path), ...(createNew ? { "create-new": "1" } : {}) } }),
  list: async (path) => (await inv("list_dir", { path })).map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size })),
  stat: async (path) => {
    const s = await inv("stat", { path });
    return s && { isDir: s.is_dir, size: s.size };
  },
  mkdirs: (path) => inv("mkdirs", { path }),
  rename: (from, to) => inv("rename", { from, to }),
  remove: (path) => inv("remove", { path }),
  copy: (from, to) => inv("copy_file", { from, to }),
  readText: async (path) => new TextDecoder().decode(await tauriFs.readBytes(path)),
};
