// What each kind of control calls its work offsets. The machines are the user's own (Settings: name + controller);
// the controller only changes this hint on the sheet.
export const CONTROLLERS = {
  Fanuc: "G54-G59, more with G54.1 P1-P48",
  Haas: "G54-G59, more with G154 P1-P99",
  "Okuma OSP": "work coordinate systems G15 H1, G15 H2, ...",
  Mazak: "G54-G59, more with G54.1 P1-P48 (EIA programs)",
  Heidenhain: "zero-point table rows, called with CYCL DEF 7",
  Siemens: "G54-G57, more with G505-G599",
  Other: "",
};

/** machines = [{name, controller}], names = the sheet's machines -> "Fanuc: G54-G59, ..." once per controller */
export const offsetHint = (machines, names) =>
  [...new Set(machines.filter((m) => names.includes(m.name) && CONTROLLERS[m.controller]).map((m) => `${m.controller}: ${CONTROLLERS[m.controller]}`))].join("  ·  ");
