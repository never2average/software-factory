import "server-only";
import ExcelJS from "exceljs";

/**
 * The roster workbook — built and read on the SERVER, in one place.
 *
 * This replaces a browser-side implementation built on npm's `xlsx`, which is
 * abandoned at 0.18.5 with unfixed high-severity prototype-pollution and ReDoS
 * advisories; parsing untrusted bytes with it anywhere was a mitigation at best.
 * ExcelJS is maintained and advisory-free, and being server-side it can do
 * things the community build of SheetJS cannot write at all — notably real
 * dropdown validation on manager_email, which turns the most error-prone column
 * in the file into a pick-list.
 *
 * One module still both writes and reads the format, so the columns a person is
 * asked to fill and the columns the importer looks for cannot drift apart.
 */

export interface RosterPerson {
  email: string;
  name: string | null;
  team: string | null;
  managerEmail: string | null;
  escalations?: { email: string; reason: string }[];
}

export const PEOPLE_SHEET = "People";
export const ESCALATIONS_SHEET = "Escalations";
const README_SHEET = "How to use";

/** Blank means "leave alone", so emptying a value needs a word for it. */
export const CLEAR = "CLEAR";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/* ------------------------------- writing ---------------------------------- */

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2937" },
};

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFF9FAFB" } };
  row.fill = HEADER_FILL;
  row.height = 20;
}

export async function buildRosterWorkbook(
  people: RosterPerson[],
  orgLabel: string,
  generatedAt: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Delivered";
  wb.created = new Date(generatedAt);

  /* --- How to use ---------------------------------------------------------- */
  const readme = wb.addWorksheet(README_SHEET, {
    views: [{ showGridLines: false }],
  });
  readme.columns = [{ width: 100 }];
  const lines: [string, boolean?][] = [
    ["Roster import", true],
    [""],
    [`Workspace: ${orgLabel}`],
    [`Generated: ${new Date(generatedAt).toLocaleString("en-GB")}`],
    [""],
    ["This file is also your backup — it holds the roster exactly as it stood when you", false],
    ["downloaded it, so re-importing it undoes whatever you do next.", false],
    [""],
    ["How to fill it in", true],
    ["1. Edit the People sheet. One row per person."],
    ["2. email is the key. An existing address updates that person; a new one adds them."],
    [`3. A blank cell leaves the current value alone. Type ${CLEAR} to empty it.`],
    ["4. manager_email must appear in the People sheet's email column, or be blank."],
    ["   That column is a dropdown — pick from it rather than typing."],
    ["5. Escalations are optional, on their own sheet, and one person may have several."],
    ["6. Upload it back at Workspace → People → Invite ▾ → Import roster."],
    [""],
    ["Nothing is written until you have read the list of changes the import shows you."],
    [""],
    ["Rules the importer enforces", true],
    ["• Reporting lines may not form a loop (A reports to B reports to A is rejected)."],
    ["• Nobody may report to themselves."],
    ["• An email may appear only once on the People sheet."],
    ["• Every problem in the file is reported at once, not one upload at a time."],
  ];
  for (const [text, bold] of lines) {
    const row = readme.addRow([text]);
    if (bold) row.font = { bold: true, size: 12 };
  }

  /* --- People -------------------------------------------------------------- */
  const ws = wb.addWorksheet(PEOPLE_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "email", key: "email", width: 34 },
    { header: "name", key: "name", width: 24 },
    { header: "team", key: "team", width: 18 },
    { header: "manager_email", key: "manager_email", width: 34 },
  ];
  styleHeader(ws.getRow(1));
  for (const p of people) {
    ws.addRow({
      email: p.email,
      name: p.name ?? "",
      team: p.team ?? "",
      manager_email: p.managerEmail ?? "",
    });
  }
  ws.autoFilter = { from: "A1", to: "D1" };

  /**
   * Dropdown on manager_email, over the emails already in column A.
   *
   * The single biggest source of a broken import is a mistyped manager address,
   * which the importer can only reject after the fact. A list validation stops
   * it being typed at all. Applied generously past the last row so pasting new
   * people keeps the constraint.
   */
  const lastDataRow = Math.max(people.length + 1, 2);
  const validationLimit = lastDataRow + 200;
  if (people.length > 0) {
    for (let r = 2; r <= validationLimit; r++) {
      ws.getCell(`D${r}`).dataValidation = {
        type: "list",
        allowBlank: true,
        // A range reference rather than a literal list: a literal is capped at
        // 255 characters, which a dozen work addresses blow straight past.
        formulae: [`=$A$2:$A$${lastDataRow}`],
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: "Not on this sheet",
        error: "Pick someone from the email column, or leave it blank.",
      };
    }
  }

  /* --- Escalations --------------------------------------------------------- */
  const esc = wb.addWorksheet(ESCALATIONS_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  esc.columns = [
    { header: "email", key: "email", width: 34 },
    { header: "escalate_to", key: "escalate_to", width: 34 },
    { header: "reason", key: "reason", width: 32 },
  ];
  styleHeader(esc.getRow(1));
  for (const p of people) {
    for (const e of p.escalations ?? []) {
      esc.addRow({ email: p.email, escalate_to: e.email, reason: e.reason });
    }
  }
  esc.autoFilter = { from: "A1", to: "C1" };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/* ------------------------------- reading ---------------------------------- */

export interface ParsedRoster {
  people: RosterPerson[];
  problems: string[];
}

/** Cell text, tolerant of the shapes ExcelJS hands back (formula, rich text, hyperlink). */
function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    // ExcelJS's union covers formula/rich-text/hyperlink/error shapes; go through
    // unknown rather than asserting one of them.
    const o = v as unknown as Record<string, unknown>;
    // A pasted email often arrives as a hyperlink or rich-text run rather than
    // a plain string; reading .value alone would silently produce "[object]".
    if (typeof o.text === "string") return o.text.trim();
    if (Array.isArray(o.richText)) {
      return o.richText.map((r) => String((r as { text?: string }).text ?? "")).join("").trim();
    }
    if (typeof o.result === "string") return o.result.trim();
    if (o.hyperlink && typeof o.hyperlink === "string") {
      return o.hyperlink.replace(/^mailto:/i, "").trim();
    }
  }
  return "";
}

/** Column index by header name, so a reordered or inserted column still works. */
function headerMap(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const key = cellText(cell).toLowerCase().replace(/\s+/g, "_");
    if (key) map.set(key, col);
  });
  return map;
}

export async function parseRosterWorkbook(bytes: Uint8Array): Promise<ParsedRoster> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS declares its own `Buffer`, which no longer unifies with the global
  // one now that @types/node made Buffer generic over ArrayBufferLike. Deriving
  // the parameter type keeps the cast honest instead of naming a type that means
  // something different on each side of the package boundary.
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const problems: string[] = [];

  const ws = wb.getWorksheet(PEOPLE_SHEET) ?? wb.worksheets[0];
  if (!ws) return { people: [], problems: [`No "${PEOPLE_SHEET}" sheet in this file.`] };

  const cols = headerMap(ws);
  const emailCol = cols.get("email");
  if (!emailCol) {
    return {
      people: [],
      problems: [`The ${PEOPLE_SHEET} sheet has no "email" column — is this the template?`],
    };
  }
  const get = (row: ExcelJS.Row, name: string): string => {
    const c = cols.get(name);
    return c ? cellText(row.getCell(c)) : "";
  };

  const byEmail = new Map<string, RosterPerson>();
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const email = get(row, "email").toLowerCase();
    const name = get(row, "name");
    const team = get(row, "team");
    const manager = get(row, "manager_email").toLowerCase();

    if (!email) {
      // Trailing blank rows are normal in a hand-edited sheet.
      if (name || team || manager) problems.push(`${PEOPLE_SHEET} row ${rowNumber}: email is required.`);
      return;
    }
    if (!EMAIL_RE.test(email)) {
      problems.push(`${PEOPLE_SHEET} row ${rowNumber}: "${email}" is not an email address.`);
      return;
    }
    if (byEmail.has(email)) {
      problems.push(`${PEOPLE_SHEET} row ${rowNumber}: ${email} appears more than once.`);
      return;
    }
    if (manager && manager !== CLEAR.toLowerCase() && !EMAIL_RE.test(manager)) {
      problems.push(
        `${PEOPLE_SHEET} row ${rowNumber}: manager_email "${manager}" is not an email address.`,
      );
      return;
    }
    if (manager && manager === email) {
      problems.push(`${PEOPLE_SHEET} row ${rowNumber}: ${email} cannot report to themselves.`);
      return;
    }
    byEmail.set(email, {
      email,
      name: supplied(name),
      team: supplied(team),
      managerEmail: supplied(manager),
    });
  });

  const escWs = wb.getWorksheet(ESCALATIONS_SHEET);
  if (escWs) {
    const eCols = headerMap(escWs);
    const eGet = (row: ExcelJS.Row, name: string): string => {
      const c = eCols.get(name);
      return c ? cellText(row.getCell(c)) : "";
    };
    escWs.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const email = eGet(row, "email").toLowerCase();
      const to = eGet(row, "escalate_to").toLowerCase();
      const reason = eGet(row, "reason");
      if (!email && !to && !reason) return;
      if (!email || !to || !reason) {
        problems.push(
          `${ESCALATIONS_SHEET} row ${rowNumber}: email, escalate_to and reason are all required.`,
        );
        return;
      }
      if (!EMAIL_RE.test(email) || !EMAIL_RE.test(to)) {
        problems.push(`${ESCALATIONS_SHEET} row ${rowNumber}: not an email address.`);
        return;
      }
      const person = byEmail.get(email);
      if (!person) {
        problems.push(
          `${ESCALATIONS_SHEET} row ${rowNumber}: ${email} is not on the ${PEOPLE_SHEET} sheet.`,
        );
        return;
      }
      (person.escalations ??= []).push({ email: to, reason });
    });
  }

  for (const p of byEmail.values()) {
    if (p.managerEmail && p.managerEmail !== CLEAR && !byEmail.has(p.managerEmail)) {
      problems.push(`${p.email}: manager ${p.managerEmail} is not on the ${PEOPLE_SHEET} sheet.`);
    }
  }
  problems.push(...loopProblems(byEmail));

  return { people: [...byEmail.values()], problems };
}

/** "" → not supplied (null). CLEAR → empty it (""). Otherwise the value. */
function supplied(v: string): string | null {
  if (v === "") return null;
  return v.toUpperCase() === CLEAR ? "" : v;
}

/**
 * A reporting loop makes the chain unwalkable and any "who does this roll up to"
 * traversal non-terminating, so it is refused at the door.
 */
function loopProblems(byEmail: Map<string, RosterPerson>): string[] {
  const out: string[] = [];
  const reported = new Set<string>();
  for (const start of byEmail.keys()) {
    const path: string[] = [];
    const visiting = new Set<string>();
    let cur: string | undefined = start;
    while (cur && byEmail.has(cur)) {
      if (visiting.has(cur)) {
        const loop = [...path.slice(path.indexOf(cur)), cur];
        // Key on the SET of members: walking from a gives a→b→a and from b
        // gives b→a→b, which are one problem, not two.
        const key = [...new Set(loop)].sort().join(">");
        if (!reported.has(key)) {
          reported.add(key);
          out.push(`Reporting loop: ${loop.join(" → ")}.`);
        }
        break;
      }
      visiting.add(cur);
      path.push(cur);
      const next: string | null = byEmail.get(cur)?.managerEmail ?? null;
      cur = next && next !== CLEAR ? next : undefined;
    }
  }
  return out;
}

/* -------------------------------- diffing --------------------------------- */

export interface RosterChange {
  email: string;
  isNew: boolean;
  fields: { field: "name" | "team" | "manager_email" | "escalations"; from: string; to: string }[];
}

export function diffRoster(current: RosterPerson[], incoming: RosterPerson[]): RosterChange[] {
  const cur = new Map(current.map((p) => [p.email.toLowerCase(), p]));
  const out: RosterChange[] = [];
  for (const next of incoming) {
    const before = cur.get(next.email);
    const fields: RosterChange["fields"] = [];
    const cmp = (field: RosterChange["fields"][number]["field"], from: string | null, to: string | null) => {
      if (to === null) return; // not supplied is not a change
      if ((from ?? "") !== to) fields.push({ field, from: from || "—", to: to || "—" });
    };
    cmp("name", before?.name ?? null, next.name);
    cmp("team", before?.team ?? null, next.team);
    cmp("manager_email", before?.managerEmail ?? null, next.managerEmail);

    if (next.escalations) {
      const asText = (e: { email: string; reason: string }[]) =>
        e.map((x) => `${x.email} (${x.reason})`).sort().join(", ");
      const from = asText(before?.escalations ?? []);
      const to = asText(next.escalations);
      if (from !== to) fields.push({ field: "escalations", from: from || "—", to: to || "—" });
    }

    if (!before || fields.length) out.push({ email: next.email, isNew: !before, fields });
  }
  return out;
}
