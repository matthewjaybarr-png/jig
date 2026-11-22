//! Jig - thin file access for the web UI. All set-up sheet logic is in ui/lib (JS), so it can be
//! tested with node. cache_root is for the machine viewer, which reads the cache with the file
//! commands and shows each sheet as its HTML copy.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::ipc::{self, InvokeBody};
use tauri::{AppHandle, Manager};

type R<T> = Result<T, String>;

fn e(err: std::io::Error) -> String {
    err.to_string()
}

#[derive(Serialize)]
struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
struct Stat {
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn read_file(path: String) -> R<ipc::Response> {
    fs::read(path).map(ipc::Response::new).map_err(e)
}

/// Body = file bytes; path in the "path" header (URL-encoded); header "create-new"
/// makes it fail if the file exists (used for the lock).
#[tauri::command]
fn write_file(request: ipc::Request) -> R<()> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path header")?;
    let path = percent_decode(path);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let mut o = fs::OpenOptions::new();
    o.write(true);
    if request.headers().contains_key("create-new") {
        o.create_new(true);
    } else {
        o.create(true).truncate(true);
    }
    let mut f = o.open(&path).map_err(e)?;
    f.write_all(bytes).map_err(e)?;
    f.sync_all().map_err(e)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn list_dir(path: String) -> R<Vec<Entry>> {
    let mut v = vec![];
    for ent in fs::read_dir(path).map_err(e)? {
        let ent = ent.map_err(e)?;
        let m = ent.metadata().map_err(e)?;
        v.push(Entry { name: ent.file_name().to_string_lossy().into_owned(), is_dir: m.is_dir(), size: m.len() });
    }
    Ok(v)
}

#[tauri::command]
fn stat(path: String) -> Option<Stat> {
    fs::metadata(path).ok().map(|m| Stat { is_dir: m.is_dir(), size: m.len() })
}

#[tauri::command]
fn mkdirs(path: String) -> R<()> {
    fs::create_dir_all(path).map_err(e)
}

/// Replaces an existing target (MoveFileEx REPLACE_EXISTING on Windows).
#[tauri::command]
fn rename(from: String, to: String) -> R<()> {
    fs::rename(from, to).map_err(e)
}

#[tauri::command]
fn remove(path: String) -> R<()> {
    match fs::metadata(&path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path).map_err(e),
        Ok(_) => fs::remove_file(path).map_err(e),
        Err(_) => Ok(()),
    }
}

#[tauri::command]
fn copy_file(from: String, to: String) -> R<()> {
    fs::copy(from, to).map(|_| ()).map_err(e)
}

#[tauri::command]
fn whoami() -> serde_json::Value {
    let var = |a: &str, b: &str| std::env::var(a).or_else(|_| std::env::var(b)).unwrap_or_else(|_| "unknown".into());
    serde_json::json!({ "user": var("USERNAME", "USER"), "host": var("COMPUTERNAME", "HOSTNAME") })
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("jig"))
}

/// Machine PC: the last good published copy is kept here (this PC's own disk, not the share)
#[tauri::command]
fn cache_root(app: AppHandle) -> String {
    data_dir(&app).join("cache").to_string_lossy().into_owned()
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("jig"));
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

#[tauri::command]
fn settings_read(app: AppHandle) -> String {
    fs::read_to_string(settings_path(&app)).unwrap_or_else(|_| "{}".into())
}

#[tauri::command]
fn settings_write(app: AppHandle, text: String) -> R<()> {
    fs::write(settings_path(&app), text).map_err(e)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, list_dir, stat, mkdirs, rename, remove, copy_file, whoami, cache_root,
            settings_read, settings_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jig");
}
