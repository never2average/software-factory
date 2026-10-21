// The data-repository fixture's loader (mold_v0-059): the code a pack adds when its declared map is not enough. It
// reads an upstream catalog the way the second app's declaration describes one (a vocabulary of regulators, a registry
// of instruments naming each instrument's catalog file, and catalogs of controls in groups), only through the shell's
// RepositoryInput (files at the pinned commit, never a workspace or a database), and returns rows by area. Every row is
// then checked and written by the shell. File names and kinds come from the repository's own settings.
import { definePack, type RepositoryInput, type RepositoryRows } from "../../src/pack-api.js";

const json = async (input: RepositoryInput, rel: string) => {
  const body = await input.read(rel);
  if (body === null) throw new Error(`${rel} is missing at the pin`);
  return JSON.parse(body);
};
const only = (fields: string[], data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([k, v]) => fields.includes(k) && v !== undefined));

export async function catalogLoader(input: RepositoryInput): Promise<RepositoryRows> {
  const s = input.settings as { files: Record<string, string>; catalog_kind: string; instruments_kind: string };
  const source = input.areas.find((a) => a.role === "source")!, check = input.areas.find((a) => a.role === "check")!;
  const codes: string[] = (await json(input, s.files.regulators!)).enum ?? [];
  const reg = await json(input, s.files.instruments!);
  if (reg.kind !== s.instruments_kind) throw new Error(`instruments: kind ${reg.kind}`);
  const instruments: Record<string, any>[] = reg.instruments ?? [];
  const controls: RepositoryRows[string] = [];
  const counts: Record<string, number> = {};
  for (const x of instruments) {
    if (!x.catalogFile) continue;
    const cat = await json(input, String(x.catalogFile));
    if (cat.kind !== s.catalog_kind || cat.instrumentId !== x.instrumentId) throw new Error(`${x.catalogFile}: not ${x.instrumentId}'s catalog`);
    counts[x.instrumentId] = 0;
    for (const g of cat.groups ?? []) for (const c of g.controls ?? []) {
      counts[x.instrumentId]!++;
      // The control's own id, ( and ) kept: the shell takes such keys as they are (mold_v0-066).
      controls.push({ key: `${x.instrumentId}:${c.id}`, title: c.title ?? String(c.id), data: only(check.fields, {
        instrument: x.instrumentId, regulator: x.regulator, control_id: String(c.id), group_id: g.id, group_title: g.title, prose: c.prose,
        mandatory: typeof c.mandatory === "boolean" ? c.mandatory : undefined, default_severity: c.defaultSeverity, upstream_path: x.catalogFile }) });
    }
  }
  const sources = [
    ...codes.map((code) => ({ key: code, title: code, data: only(source.fields, { kind: "regulator", instruments: instruments.filter((x) => x.regulator === code).map((x) => x.instrumentId), upstream_path: s.files.regulators }) })),
    ...instruments.map((x) => ({ key: x.instrumentId, title: x.shortName ?? x.instrumentId, data: only(source.fields, {
      kind: "instrument", regulator: x.regulator, short_name: x.shortName, status: x.status, catalog_controls: x.catalogFile ? counts[x.instrumentId] : undefined,
      upstream_path: x.catalogFile ?? s.files.instruments }) })),
  ];
  return { [source.name]: sources, [check.name]: controls };
}

export default definePack({ id: "fixture_catalog", loaders: { catalogs: catalogLoader } });
