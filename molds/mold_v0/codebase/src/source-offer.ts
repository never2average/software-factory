/**
 * The source offer (mold_v0-050): where the people who use this service can get the source of the code it runs.
 *
 * Two kinds of code are offered:
 *
 *   upstreams  a pack's pinned upstream project (pack.json `upstream`: repository, full commit, licence). Every one is
 *              listed in the build's DATA-MAP.md; one under a copyleft licence (AGPL, GPL, LGPL, MPL, EUPL, ...) is
 *              offered in the root, landing and install pages' footer, in /install.json and in a line the customer MCP server adds to its instructions, each
 *              naming the project, its licence and the exact commit's address. An agent repository a job kind runs from the
 *              same repository must be at that same commit (refused otherwise: src/packs.ts installPacks), so the commit
 *              offered is the commit that runs.
 *   the app    this build's own source, when the profile says where (profile.json `source_offer.app` = {url, license}).
 *              The shell is distributed under the AGPL-3.0; its licensor's additional permission (the factory's
 *              LICENSE-EXCEPTION.md) lets the licensor and its affiliates run it without offering its source. A deployment
 *              they run says so with `source_offer.app` = "licensor_exception": no link to the app's own source, and
 *              DATA-MAP.md (and, when an upstream is offered, the footer and the MCP line) says why. Absent: the build says
 *              nothing about its own source; whoever else runs a modified copy sets `app` to where its source is.
 *
 * An upstream that is the licensor's own (mold_v0-099): profile.json `source_offer.upstreams` = {"<pack id>":
 * "licensor_owned"} says that pack's pinned upstream project belongs to the app's licensor (its copyright holder, who need
 * not offer its own code's source to anyone). That upstream is then left out of the offer entirely: no footer line,
 * no /install.json sentence, no MCP instructions line, no DATA-MAP.md row; `licensor_owned` lists the packs it was left
 * out for, and DATA-MAP.md drops its "Source code" section when no other upstream is left and the app's own source is
 * not offered (hasSourceSection). A copyleft upstream not marked so is offered exactly as before. Only the app's own profile.json may say
 * so (scripts/gen-packs.mjs refuses it in a host pack's profile, and a pack id the build lacks or that pins no upstream).
 * `app` is unchanged by it: "licensor_exception" still says why the service's own code is not offered, wherever
 * something else is.
 *
 * With zero packs and no `source_offer` nothing is offered: the instructions and the install pages are exactly the
 * shell's. Pure functions over the installed packs and the profile, so the server, the console's API and the tests share
 * them; nothing here reads a secret.
 */

/** An upstream pin as pack.json declares it (src/pack-api.ts UpstreamSchema). */
export interface UpstreamPin { repo: string; commit: string; license?: string }
/** What this module reads of an installed pack (src/packs.ts InstalledPack). */
export interface OfferPack {
  id: string;
  manifest: { name: string; upstream?: UpstreamPin };
  definition: { agentJobKinds?: readonly { name: string; agent: { repository: string; commit: string } }[] };
}
/** profile.json `source_offer` (checked by scripts/gen-packs.mjs). */
export interface SourceOfferSetting {
  app?: { url: string; license: string } | "licensor_exception";
  /** Packs whose pinned upstream is the licensor's own project (mold_v0-099): not offered. */
  upstreams?: Record<string, "licensor_owned">;
}

export interface OfferedUpstream {
  pack: string;
  pack_name: string;
  /** The project's name: the repository's last path segment. */
  project: string;
  repo: string;
  commit: string;
  /** The source at exactly that commit (a browsable tree on GitHub and GitLab; otherwise the repository itself). */
  url: string;
  license: string | null;
  copyleft: boolean;
}
export type AppOffer =
  | { kind: "offered"; url: string; license: string }
  | { kind: "licensor_exception" }
  | { kind: "not_stated" };
export interface SourceOffer {
  /** Every pinned upstream of the build's packs, in pack order. */
  upstreams: OfferedUpstream[];
  app: AppOffer;
  /** Whether the build offers anything: a copyleft upstream, or the app's own source. */
  offered: boolean;
  /** Packs whose upstream the profile says is the licensor's own (mold_v0-099), left out of `upstreams`; absent when none. */
  licensor_owned?: string[];
}

/**
 * Copyleft licences, by SPDX id prefix: the GNU licences (AGPL, GPL, LGPL), the weak and file-level ones (MPL, EPL, CDDL,
 * EUPL, OSL, CPAL, RPL, SSPL, CeCILL). An expression counts when any id in it does ("MIT OR AGPL-3.0-only" is offered:
 * offering is never wrong, missing an offer can be).
 */
const COPYLEFT = /(^|[\s(])(AGPL|GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CPAL|RPL|SSPL|CECILL)-/i;
export const isCopyleft = (license: string | null | undefined) => Boolean(license && COPYLEFT.test(license));

/** A repository address without a trailing slash or .git, lower-cased host: two spellings of one repository compare equal. */
export function sameRepo(a: string, b: string): boolean {
  // GitHub and GitLab compare owners and repositories without case; other hosts only the scheme and host.
  const norm = (u: string) => { const x = u.trim().replace(/\/+$/, "").replace(/\.git$/i, ""); const m = x.match(/^([a-z]+:\/\/[^/]+)(.*)$/i); if (!m) return x; const host = m[1]!.toLowerCase(); return /^https:\/\/(github\.com|gitlab\.com)$/.test(host) ? `${host}${m[2]!.toLowerCase()}` : `${host}${m[2]}`; };
  return norm(a) === norm(b);
}

/** The address of the source at exactly `commit`: GitHub's and GitLab's tree at that commit, else the repository. */
export function commitUrl(repo: string, commit: string): string {
  const base = repo.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(base)) return `${base}/tree/${commit}`;
  if (/^https:\/\/gitlab\.com\/.+\/.+$/i.test(base)) return `${base}/-/tree/${commit}`;
  return base;
}
const projectOf = (repo: string) => repo.trim().replace(/\/+$/, "").replace(/\.git$/i, "").split("/").pop() || repo;

/**
 * Agent job kinds that run the pack's upstream repository at another commit than pack.json pins: the offer would name the
 * wrong code. -> problems ("pack x: ..."), [] when every one runs the pin.
 */
export function upstreamProblems(packs: readonly OfferPack[]): string[] {
  const out: string[] = [];
  for (const p of packs) {
    const up = p.manifest.upstream;
    if (!up) continue;
    for (const k of p.definition.agentJobKinds ?? [])
      if (sameRepo(k.agent.repository, up.repo) && k.agent.commit !== up.commit)
        out.push(`pack ${p.id}: job kind ${k.name} runs ${up.repo} at ${k.agent.commit.slice(0, 12)}, but pack.json upstream pins ${up.commit.slice(0, 12)}: the source offer would name the wrong commit (pin one commit in both)`);
  }
  return out;
}

export function sourceOffer(packs: readonly OfferPack[], setting: SourceOfferSetting | undefined): SourceOffer {
  const owned = (id: string) => setting?.upstreams?.[id] === "licensor_owned";
  const licensor_owned = packs.filter((p) => p.manifest.upstream && owned(p.id)).map((p) => p.id);
  const upstreams = packs.flatMap((p) => {
    const up = p.manifest.upstream;
    if (!up || owned(p.id)) return [];
    const license = up.license ?? null;
    return [{ pack: p.id, pack_name: p.manifest.name, project: projectOf(up.repo), repo: up.repo, commit: up.commit, url: commitUrl(up.repo, up.commit), license, copyleft: isCopyleft(license) }];
  });
  const a = setting?.app;
  const app: AppOffer = a === "licensor_exception" ? { kind: "licensor_exception" } : a && typeof a === "object" ? { kind: "offered", url: a.url, license: a.license } : { kind: "not_stated" };
  return { upstreams, app, offered: upstreams.some((u) => u.copyleft) || app.kind === "offered",
    ...(licensor_owned.length ? { licensor_owned } : {}) };
}

/**
 * Whether DATA-MAP.md has a "Source code" section (src/data-map.ts offerSection): always, unless every upstream the
 * build pins is the licensor's own and the app's own source is not offered either (mold_v0-099): everything the service
 * runs is then the licensor's, nothing is offered anywhere, and the statement says nothing about source code (under
 * "licensor_exception" too: its sentence explains a missing offer, and with no offer anywhere there is none to explain).
 * Without an `upstreams` setting this is always true, so the statement is what it was.
 */
export const hasSourceSection = (o: SourceOffer) => !(o.licensor_owned?.length && !o.upstreams.length && o.app.kind !== "offered");

/** What the licensor's exception means, in one sentence (DATA-MAP.md, the footer, the MCP line). */
export const LICENSOR_EXCEPTION_TEXT =
  "This service's own code is run by its copyright holder or an affiliated entity under an additional permission to the AGPL-3.0 (granted under its section 7) that does not require offering that code's source, so it is not offered here.";

/** The offer as plain sentences, one per offered item: what the footer and the MCP line say. [] when nothing is offered. */
export function offerSentences(o: SourceOffer): string[] {
  if (!o.offered) return [];
  const out = o.upstreams.filter((u) => u.copyleft).map((u) =>
    `${u.pack_name} uses ${u.project} (${u.repo}), licensed ${u.license}, at commit ${u.commit}; its complete source at that commit is at ${u.url}.`);
  if (o.app.kind === "offered") out.push(`The source of this service itself, licensed ${o.app.license}, is at ${o.app.url}.`);
  else if (o.app.kind === "licensor_exception") out.push(LICENSOR_EXCEPTION_TEXT);
  return out;
}

/** The paragraph the customer MCP server adds to its instructions; "" when nothing is offered (a zero-pack build). */
export function instructionsParagraph(o: SourceOffer): string {
  const s = offerSentences(o);
  return s.length ? `\n\nSource code: ${s.join(" ")}` : "";
}

const escHtml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The footer's items, as data (mold_v0-091): each a sentence, with the commit it names and a link when it has one. The
 * install pages' footer (offerFooterHtml) and the console's landing page footer (scripts/gen-packs.mjs writes these into
 * web/src/config/landing.generated.ts) both say exactly these. [] when nothing is offered.
 */
export interface OfferFooterItem { text: string; commit?: string; link?: { href: string; label: string } }
export function offerFooterItems(o: SourceOffer): OfferFooterItem[] {
  if (!o.offered) return [];
  const items: OfferFooterItem[] = o.upstreams.filter((u) => u.copyleft).map((u) =>
    ({ text: `${u.pack_name} uses ${u.project}, licensed ${u.license ?? ""}, at commit`, commit: u.commit, link: { href: u.url, label: "its source at that commit" } }));
  if (o.app.kind === "offered") items.push({ text: `This service, licensed ${o.app.license}`, link: { href: o.app.url, label: "its source" } });
  else if (o.app.kind === "licensor_exception") items.push({ text: LICENSOR_EXCEPTION_TEXT });
  return items;
}

/** The install pages' footer (HTML, every value escaped); "" when nothing is offered. */
export function offerFooterHtml(o: SourceOffer): string {
  const items = offerFooterItems(o).map((i) =>
    `<li>${escHtml(i.text)}${i.commit ? ` <code>${escHtml(i.commit)}</code>` : ""}${i.link ? `: <a href="${escHtml(i.link.href)}">${escHtml(i.link.label)}</a>` : ""}</li>`);
  if (!items.length) return "";
  return `<footer class="muted" id="source-code"><h2>Source code</h2><ul>${items.join("")}</ul></footer>`;
}
