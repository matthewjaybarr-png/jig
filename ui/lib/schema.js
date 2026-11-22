// One set-up sheet (sheet.json). Every value is text as typed: a set-up sheet is a document, not a
// calculation, and the shops write lengths, offsets and tool numbers in different ways.
export const SCHEMA_VERSION = 1;

export const PART = [
  ["number", "Part number"], ["revision", "Rev"], ["name", "Part name"],
  ["operation", "Operation"], ["material", "Material"], ["stock", "Stock"], ["cycle_time", "Cycle time"],
];
export const FIXTURE = [["name", "Fixture"], ["workholding", "Workholding"]];
export const OFFSET_COLS = [["name", "Offset"], ["location", "Where it is"]];
export const TOOL_COLS = [["number", "Tool"], ["pocket", "Pocket"], ["description", "Description"], ["length", "Length"], ["offset", "Offset"], ["speed", "Speed"], ["feed", "Feed"], ["notes", "Notes"]];
export const SIGNOFF = [["programmer", "Programmer"], ["date", "Date"], ["proven_by", "Proven by"], ["proven_date", "Date"]];

/**
 * The title block at the top of the copies, ruled like the title block on a drawing. Four columns, TITLE_W wide in points (the HTML copy uses the same proportions); each cell is
 * [label, value, column, columns spanned, row, rows spanned]. The program number fills the big cell.
 */
export const TITLE_W = [200, 150, 120, 70];
export const titleCells = (s) => [
  ["Set-up sheet for program", s.program, 0, 1, 0, 2],
  ["Part number", s.part.number, 1, 2, 0, 1],
  ["Rev", s.part.revision, 3, 1, 0, 1],
  ["Part name", s.part.name, 1, 3, 1, 1],
  ["Machine group", s.group, 0, 1, 2, 1],
  ["Machines", s.machines.join(", "), 1, 1, 2, 1],
  ["Operation", s.part.operation, 2, 2, 2, 1],
  ["Material", s.part.material, 0, 1, 3, 1],
  ["Stock", s.part.stock, 1, 1, 3, 1],
  ["Cycle time", s.part.cycle_time, 2, 2, 3, 1],
];

const blankOf = (cols) => Object.fromEntries(cols.map(([k]) => [k, ""]));
/** the columns with something in at least one row (the offline copies leave the empty ones out) */
export const usedCols = (cols, rows) => cols.filter(([k]) => rows.some((r) => String(r[k] ?? "").trim()));
export const blankTool = () => blankOf(TOOL_COLS);
export const blankOffset = () => blankOf(OFFSET_COLS);

export function blankSheet(group, program) {
  return {
    schema_version: SCHEMA_VERSION,
    group, program, machines: [],
    part: blankOf(PART),
    fixture: { ...blankOf(FIXTURE), notes: "" },
    offsets: [],
    tools: [],
    steps: [],
    pictures: [], // {file: "<sha256>.<ext>" in assets/, caption, wide?: true = the whole page width in print}
    notes: "",
    signoff: blankOf(SIGNOFF),
    sources: [], // files imported into this sheet: {kind, name, sha256, imported_at, as_written?: {date: the old file's words}}
    saved_at: null, saved_by: null,
  };
}

/** Fill in anything an older or hand-edited file lacks, so the editor and the copies never meet undefined. */
export function normalize(s) {
  const b = blankSheet(s.group ?? "", s.program ?? "");
  const out = { ...b, ...s };
  const text = (v) => (v == null ? "" : String(v));
  const fill = (blank, o) => ({ ...o, ...Object.fromEntries(Object.keys(blank).map((k) => [k, text(o?.[k])])) });
  for (const k of ["part", "fixture", "signoff"]) out[k] = fill(b[k], s[k]);
  for (const k of ["machines", "offsets", "tools", "steps", "pictures", "sources"]) if (!Array.isArray(out[k])) out[k] = [];
  out.machines = out.machines.map(text);
  out.offsets = out.offsets.map((o) => fill(blankOffset(), o));
  out.tools = out.tools.map((t) => fill(blankTool(), t));
  out.steps = out.steps.map(text);
  out.notes = text(out.notes);
  out.pictures = out.pictures.filter((p) => p?.file).map(({ wide, ...p }) => ({ ...p, caption: text(p.caption), ...(wide === true ? { wide } : {}) }));
  return out;
}

// Group and program become folder names (and the offline copies' file names), on Windows shares too.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** null if usable as a folder name, else why not */
export function badName(name, what) {
  if (!name) return `${what} is empty`;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return `${what} "${name}" has a character Windows does not allow in a file name (\\ / : * ? " < > |)`;
  if (name !== name.trim() || /[. ]$/.test(name)) return `${what} "${name}" starts or ends with a space or ends with a dot`;
  if (RESERVED.test(name)) return `${what} "${name}" is a name Windows reserves`;
  if (name.length > 80) return `${what} is longer than 80 characters`;
  return null;
}

export function validate(s) {
  const errs = [badName(s.group, "Machine group"), badName(s.program, "Program")].filter(Boolean);
  if (s.schema_version > SCHEMA_VERSION) errs.push(`made by a newer Jig (schema ${s.schema_version}) - update this app`);
  return errs;
}

/** Sections with nothing in them are left out of the copies (the sign-off block always prints). */
export const isEmpty = {
  part: (s) => PART.every(([k]) => !s.part[k].trim()),
  fixture: (s) => !s.fixture.name.trim() && !s.fixture.workholding.trim() && !s.fixture.notes.trim(),
  offsets: (s) => !s.offsets.some((o) => OFFSET_COLS.some(([k]) => o[k].trim())),
  tools: (s) => !s.tools.some((t) => TOOL_COLS.some(([k]) => t[k].trim())),
  steps: (s) => !s.steps.some((x) => x.trim()),
  notes: (s) => !s.notes.trim(),
};
