// Dates are stored one way everywhere: 2026-11-03. isoDate turns a typed date into that form, or gives the
// text back unchanged when it is not a date it knows. Month-first for slashed dates (11/03/2026).
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y < 100 ? 2000 + y : y}-${pad(m)}-${pad(d)}` : null);
export function isoDate(text) {
  const t = String(text ?? "").trim();
  let m = /([a-z]{3})[a-z]*\.?\s*(\d{1,2})(?:,\s*|\s+)(\d{4})/i.exec(t); // September 19, 2019; Saturday,January.13,2023
  if (m && MONTHS.includes(m[1].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]) ?? t;
  m = /\b([a-z]{3})\s+(\d{1,2})\s+[\d:]+\s+(\d{4})\b/i.exec(t); // Mar 02 13:52:11 2026 (a ctime stamp)
  if (m && MONTHS.includes(m[1].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]) ?? t;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t); // 05-13-2023 (month first)
  if (m) return iso(+m[3], +m[1], +m[2]) ?? t;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]) ?? t;
  return t;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
