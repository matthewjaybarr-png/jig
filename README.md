# Jig

A desktop app for CNC set-up sheets. Each sheet covers one program. It holds:

- the part;
- the fixture and workholding;
- the work offsets;
- the tool list;
- the set-up steps;
- pictures;
- notes;
- a sign-off block.

Jig saves each sheet as a plain `sheet.json` file in a folder you choose. It can also make offline copies, as PDF and as a single-file HTML page. You can print those copies or open them on a machine PC.

Jig starts empty. It has no built-in shop, machines or programs. Add your own machines in **Settings → Machines** and give each one a name and a controller. Fanuc, Haas, Okuma OSP, Mazak, Heidenhain, Siemens and Other are offered. The controller only changes the hint that tells you how that control names its work offsets.

## Features

- Sheets are grouped by a machine group you name, such as a cell or a pair of machines. There is one sheet per program number.
- Each sheet has tick boxes for the machines it runs on.
- A sheet is locked while someone edits it, so two people cannot overwrite each other on a shared drive.
- **Publish** copies finished sheets to a release folder.
- **Viewer mode** is for machine PCs. It shows the published sheets and keeps the last good copy if the share drops out.
- Sign-off before publishing is optional.

## Build

You need [Node.js](https://nodejs.org) and [Rust](https://rustup.rs). You also need the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npx tauri build
```

To run it while developing, use `npx tauri dev`. To run the tests, use `node test/run.mjs`.

## Related apps

Jig is one of a set of separate, independent machining apps:

- [Swarf](https://github.com/matthewjaybarr-png/swarf): a G-code editor.
- [Gauge](https://github.com/matthewjaybarr-png/gauge): a machining calculator.
- [Crib](https://github.com/matthewjaybarr-png/crib): a tool library.
- [Apphub](https://github.com/matthewjaybarr-png/apphub): installs and updates the apps.

## License

Jig is free software under the [GNU General Public License v3.0](LICENSE) or later. You may use, study, change and share it. If you share a changed version, you must share its source under the same license.

The bundled JetBrains Mono Nerd Font files are under the SIL Open Font License. See `ui/fonts/OFL.txt`.
