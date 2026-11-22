// PDF's WinAnsiEncoding (Windows-1252): WIN_ANSI[byte] = Unicode code point, null where no character.
// Text in the PDF is written in this encoding so the built-in Helvetica fonts can show it.
const HIGH = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];
export const WIN_ANSI = Array.from({ length: 256 }, (_, i) => (i < 32 || i === 127 ? null : i >= 128 && i < 160 ? HIGH[i - 128] : i));

const toByte = new Map(WIN_ANSI.map((u, i) => [u, i]).filter(([u]) => u != null));
// machining characters with no WinAnsi byte, shown as the nearest one that has
const NEAR = { 0x2300: 0xd8 /* diameter -> Ø */, 0x2205: 0xd8, 0x2212: 0x2d /* minus */, 0x00a0: 0x20, 0x2032: 0x27, 0x2033: 0x22 };
const SPELL = { 0x2264: "<=", 0x2265: ">=", 0x2192: "->", 0x2190: "<-" };

/** text -> WinAnsi bytes; tabs become spaces, characters it cannot show become "?" */
export function encodeWinAnsi(text) {
  const out = [];
  for (const ch of String(text).replace(/\t/g, "    ")) {
    const u = ch.codePointAt(0);
    if (SPELL[u]) out.push(...[...SPELL[u]].map((c) => c.charCodeAt(0)));
    else out.push(toByte.get(u) ?? NEAR[u] ?? 0x3f);
  }
  return out;
}
