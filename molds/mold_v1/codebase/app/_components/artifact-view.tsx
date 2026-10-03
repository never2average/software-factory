"use client";

import { lazyPanel } from "@/components/lazy-panel";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useRef, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, FileIcon, Maximize2Icon, PackageIcon, XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageResponse } from "@/components/ai-elements/message";
import { CodeBlock } from "@/components/ai-elements/code-block";
import type { BundledLanguage } from "shiki";
import { cn } from "@/lib/utils";
import { DATAROOM_DOMAIN_IDS, FOLDER, labelOf } from "@/agent/lib/dataroom-folders";
import { headerLabel } from "@/lib/ui-keys";
import { opsFetch } from "./ops/lib";

/** SheetJS, fetched the first time a workbook preview opens (once per page; a failed fetch may be retried). */
let xlsxPromise: Promise<typeof import("xlsx")> | null = null;
function loadXlsx(): Promise<typeof import("xlsx")> {
  xlsxPromise ??= import("xlsx");
  xlsxPromise.catch(() => {
    xlsxPromise = null;
  });
  return xlsxPromise;
}

// The pdf viewer (and pdf.js under it) is fetched when a preview first opens.
const PdfView = lazyPanel(() => import("./pdf-view").then((m) => m.PdfView), {
  label: "The preview",
  placeholder: () => (
    <div role="status" aria-label="Loading preview" className="flex h-full min-h-40 items-center justify-center">
      <Spinner />
    </div>
  ),
});

/** Map a filename's extension to a shiki highlighting language. Unknown types
 *  fall back to "text" (a no-op grammar), so highlighting never throws. */
function langForFilename(filename: string): BundledLanguage {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, BundledLanguage> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    py: "python",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    markdown: "markdown",
    html: "html",
    htm: "html",
    css: "css",
  };
  return map[ext] ?? ("text" as BundledLanguage);
}

type Kind = "frame" | "md" | "csv" | "xlsx" | "docx" | "pptx" | "pdf" | "code";

const KIND_LABEL: Record<Kind, string> = {
  frame: "HTML",
  md: "Markdown",
  csv: "CSV",
  xlsx: "Spreadsheet",
  docx: "Document",
  pptx: "Presentation",
  pdf: "PDF",
  code: "File",
};

/** A column header as a person reads it, in the profile's words (lib/ui-keys.ts). */
const humanizeHeader = headerLabel;

export function kindOf(filename: string): Kind {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (["html", "htm", "svg"].includes(ext)) return "frame";
  if (["md", "markdown"].includes(ext)) return "md";
  if (ext === "csv") return "csv";
  if (["xlsx", "xls"].includes(ext)) return "xlsx";
  if (ext === "docx") return "docx";
  if (["pptx", "ppt"].includes(ext)) return "pptx";
  // Without this a .pdf fell through to "code" and its bytes were shown as text.
  if (ext === "pdf") return "pdf";
  return "code";
}

function previewUrl(url?: string): string | undefined {
  return url ? `/api/artifact-proxy?url=${encodeURIComponent(url)}` : undefined;
}

/**
 * A readable source for an artifact, minted NOW.
 *
 * The url an artifact arrives with is the signed link `publish_artifact` created
 * when it was written, and that link expires (7 days). Reading through it is a
 * bet on how old the artifact is: a report opened from last week's chat answers
 * 403, and so does every download button and every preview iframe pointed at it.
 * So we never read through the published link. We hand its pathname to
 * /api/ops/artifact-link — which verifies the signed-in identity and signs a
 * fresh, short-lived GET — and read through that instead.
 *
 * Returns the same-origin proxy url to read from (`src`), and the direct signed
 * blob url (`href`) for "open in a new tab". Falls back to the published link
 * while the fresh one is in flight, so a still-valid artifact never waits.
 */
export function useLiveArtifactUrl(url?: string): {
  src: string | undefined;
  href: string | undefined;
  ready: boolean;
} {
  const [live, setLive] = useState<{ src: string; href: string } | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setLive(null);
    setSettled(false);
    if (!url) {
      setSettled(true);
      return;
    }
    let cancelled = false;
    opsFetch<{ url: string; proxyUrl: string }>(
      `/api/ops/artifact-link?url=${encodeURIComponent(url)}`,
    )
      .then((d) => {
        if (!cancelled) setLive({ src: d.proxyUrl, href: d.url });
      })
      .catch(() => {
        // Signing failed (not signed in, storage unconfigured, not an
        // `artifacts/` object). Fall back to the published link — it still works
        // until it expires, which is strictly what happened before.
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return {
    src: live?.src ?? previewUrl(url),
    href: live?.href ?? url,
    ready: settled || live !== null,
  };
}

/** A human filename: strip the extension and the trailing content hash, turn
 *  separators into spaces. "<folder>.Master-20kaIFvc…xlsx" → "<folder> Master",
 *  "<folder>_Master.xlsx" → "<folder> Master". A domain's Master workbook is
 *  named the way the deployment profile labels that domain (the file itself keeps
 *  its real name): with the accounts domain labelled "Companies" it reads "Companies Master". */
export function readableArtifactName(filename: string): string {
  let s = decodeURIComponent(filename).replace(/\.[a-z0-9]{1,5}$/i, "");
  s = s.replace(/[-_. ]+[A-Za-z0-9]{16,}$/, ""); // trailing blob hash
  s = s
    .replace(/[_.]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  const master = /^(\S+) Master$/.exec(s);
  if (master) {
    // The file is named by the domain's stored folder; a person reads the domain's label.
    const domain = DATAROOM_DOMAIN_IDS.find((d) => FOLDER[d].toLowerCase() === master[1].toLowerCase());
    if (domain) s = `${labelOf(domain)} Master`;
  }
  return s || filename;
}

/** Extensions we render in-app — clicking such a link should preview, not
 *  download (the browser can't display these, so a bare link just downloads). */
const PREVIEWABLE_EXTS = new Set([
  // Drawn by pdf.js (kindOf → "pdf"). The ONE type that is also previewable on
  // another host — see artifactFromHref.
  "pdf",
  "xlsx",
  "xls",
  "docx",
  "pptx",
  "ppt",
  "csv",
  // Rendered inline as an iframe (kindOf → "frame"); without these an HTML/SVG
  // artifact link fell through to a plain download instead of the viewer.
  "html",
  "htm",
  "svg",
  // Markdown + text/code files — fetched through the proxy and shown inline
  // (kindOf → "md" / "code") instead of a bare "Open file" download.
  "md",
  "markdown",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "py",
  "sql",
  "sh",
  "yaml",
  "yml",
  "toml",
  "txt",
  "log",
]);

/** If an href points at a previewable office artifact, return its url+filename
 *  (so a link click can open the in-app viewer instead of downloading). */
export function artifactFromHref(href: string): { url: string; filename: string } | null {
  try {
    const u = new URL(href, window.location.origin);
    // The extension comes from the PATH alone — a query or hash never counts
    // ("report.pdf?download=1#page=3" is a PDF; "view?file=report.pdf" is not).
    const filename = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    const ext = (filename.split(".").pop() ?? "").toLowerCase();
    if (!PREVIEWABLE_EXTS.has(ext)) return null;
    // Our own files (this site, or the private blob store) preview as before.
    // A link to ANOTHER site is previewable only when it is a PDF over https:
    // that is the one thing the server will fetch from the public web
    // (/api/ops/pdf-fetch). An outside .html or .xlsx stays an ordinary link —
    // opening the viewer for it could only ever show an error.
    if (isExternalHost(u) && !(ext === "pdf" && u.protocol === "https:")) return null;
    return { url: href, filename };
  } catch {
    return null;
  }
}

/** The private blob store — same rule as /api/artifact-proxy. */
function isBlobHost(hostname: string): boolean {
  return hostname === "vercel-storage.com" || hostname.endsWith(".vercel-storage.com");
}

/** Is this url on a host that is neither this site nor our blob store? */
function isExternalHost(u: URL): boolean {
  return u.origin !== window.location.origin && !isBlobHost(u.hostname.toLowerCase());
}

/** The absolute https url of a PDF on another site, or null for one of ours. */
function externalPdfUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    return isExternalHost(u) && u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface ArtifactVersion {
  readonly url: string;
  readonly filename: string;
}

/** Artifact preview as a right-hand SIDE PANEL (like the Control Panel), opened
 *  from a link click — a package icon marks it as an artifact. Not a modal.
 *  When the same artifact was published more than once this session, a version
 *  bar lets the user switch between the publishes (newest last). */
export function ArtifactPanel({
  url,
  filename,
  versions = [],
  onSelectVersion,
  onClose,
}: {
  readonly url: string;
  readonly filename: string;
  readonly versions?: readonly ArtifactVersion[];
  readonly onSelectVersion?: (v: ArtifactVersion) => void;
  readonly onClose: () => void;
}) {
  const kind = kindOf(filename);
  const name = readableArtifactName(filename);
  const activeIndex = versions.findIndex((v) => v.url === url);
  // The download link is a read too — sign it fresh rather than reuse the
  // published link, which 403s once it has expired.
  const download = useLiveArtifactUrl(url);
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-3">
        <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm" title={filename}>
          {name}
        </span>
        <a
          href={download.href}
          target="_blank"
          rel="noreferrer"
          // Tells the chat's link interceptor to let this click through — its
          // href is itself a previewable file, so it would reopen this panel.
          data-open-original
          className="flex shrink-0 items-center gap-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Download"
          aria-label="Download"
        >
          <DownloadIcon className="size-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted"
          aria-label="Close preview"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {versions.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-border border-b bg-muted/20 px-3 py-1.5">
          <span className="shrink-0 text-2xs text-muted-foreground">Versions</span>
          {versions.map((v, i) => (
            <button
              key={v.url}
              type="button"
              onClick={() => onSelectVersion?.(v)}
              className={cn(
                "shrink-0 rounded-md border px-2 py-0.5 text-2xs transition-colors",
                v.url === url
                  ? "border-foreground bg-background font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              v{i + 1}
              {i === versions.length - 1 ? " · latest" : ""}
            </button>
          ))}
          {activeIndex >= 0 ? (
            <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
              Showing v{activeIndex + 1} of {versions.length}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
        <ArtifactBody kind={kind} content="" url={url} filename={filename} />
      </div>
    </div>
  );
}

/** Compact one-row artifact card that expands into a full-screen preview modal. */
export function ArtifactCard({ input, output }: { readonly input: unknown; readonly output: unknown }) {
  const inp = (input ?? {}) as { filename?: string; content?: string };
  const out = (output ?? {}) as { url?: string; expiresAt?: string };
  const filename = inp.filename ?? "artifact";
  const kind = kindOf(filename);
  const [open, setOpen] = useState(false);

  const sub = out.expiresAt
    ? `${KIND_LABEL[kind]} · expires ${new Date(out.expiresAt).toLocaleDateString()}`
    : out.url
      ? KIND_LABEL[kind]
      : `${KIND_LABEL[kind]} · publishing…`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-2 flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
          <FileIcon className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">{filename}</span>
          <span className="block truncate text-muted-foreground text-xs">{sub}</span>
        </span>
        <Maximize2Icon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[90vh] w-[92vw] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-2xl border border-white/10 bg-popover p-0 shadow-2xl sm:max-w-[92vw]">
          <DialogHeader className="sr-only">
            <DialogTitle>{filename}</DialogTitle>
            <DialogDescription>Artifact preview</DialogDescription>
          </DialogHeader>
          <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
            <FileIcon className="size-4 text-muted-foreground" />
            <span className="truncate font-medium text-sm">{filename}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
            {open ? (
              <ArtifactBody kind={kind} content={inp.content ?? ""} url={out.url} filename={filename} />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ArtifactBody({
  kind,
  content,
  url,
  filename,
}: {
  readonly kind: Kind;
  readonly content: string;
  readonly url?: string;
  readonly filename: string;
}) {
  if (kind === "frame") return <FrameView content={content} url={url} />;
  // Text-like kinds (Markdown, CSV, and any code/plain file) may arrive with the
  // content already inline (a publish_artifact card) OR only as a private URL (a
  // link-opened / cockpit artifact). In the URL case, fetch the text through the
  // proxy so it renders inline instead of falling back to a bare "Open file".
  if (kind === "md" || kind === "csv" || kind === "code") {
    if (!content && url) return <TextFileView url={url} kind={kind} filename={filename} />;
    if (kind === "md") {
      return (
        <div className="mx-auto max-w-3xl p-6">
          <MessageResponse>{content}</MessageResponse>
        </div>
      );
    }
    if (kind === "csv") return <CsvTable text={content} />;
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        <CodeBlock code={content} language={langForFilename(filename)} showLineNumbers />
      </div>
    );
  }
  if (kind === "pdf") return <PdfArtifactView url={url} filename={filename} />;
  if (kind === "xlsx") return <XlsxView url={url} />;
  if (kind === "docx") return <DocxView url={url} />;
  if (kind === "pptx") {
    return (
      <OfficeFallback
        url={url}
        filename={filename}
        label="PowerPoint preview isn't rendered inline — open it to view the slides."
      />
    );
  }
  return <pre className="overflow-auto p-4 text-xs leading-relaxed">{content}</pre>;
}

/** HTML/SVG artifact. Inline content renders straight from srcDoc; a stored one
 *  loads through the same-origin proxy on a freshly signed link (the CSP forbids
 *  framing the blob host, and the published link may have expired). */
function FrameView({ content, url }: { readonly content: string; readonly url?: string }) {
  const live = useLiveArtifactUrl(content ? undefined : url);
  if (!content && !live.ready) return <Loading />;
  return (
    <iframe
      title="Artifact preview"
      src={content ? undefined : live.src}
      srcDoc={content || undefined}
      sandbox="allow-scripts"
      className="h-full w-full bg-white"
    />
  );
}

/** Fetch a text/code/markdown artifact through the proxy and render it inline,
 *  with syntax highlighting for code (via the shared shiki CodeBlock). */
function TextFileView({
  url,
  kind,
  filename,
}: {
  readonly url: string;
  readonly kind: Kind;
  readonly filename: string;
}) {
  const [state, setState] = useState<{ status: "loading" | "error" | "ready"; text?: string }>({
    status: "loading",
  });
  const live = useLiveArtifactUrl(url);
  useEffect(() => {
    if (!live.ready) return;
    let cancelled = false;
    (async () => {
      try {
        const proxied = live.src;
        if (!proxied) throw new Error("no url");
        const res = await fetch(proxied);
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const text = await res.text();
        if (!cancelled) setState({ status: "ready", text });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [live.ready, live.src]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error" || state.text === undefined) {
    return <OfficeFallback url={url} label="Couldn't load the file inline." />;
  }
  if (kind === "md") {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <MessageResponse>{state.text}</MessageResponse>
      </div>
    );
  }
  if (kind === "csv") return <CsvTable text={state.text} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
      <CodeBlock code={state.text} language={langForFilename(filename)} showLineNumbers />
    </div>
  );
}

/**
 * A PDF, drawn by pdf.js from BYTES — never framed (see pdf-view.tsx for why).
 * One of ours reads through the freshly signed same-origin proxy link, exactly
 * like the spreadsheet and document renderers; one on another site reads through
 * the server's guarded public fetch, and skips the signing round-trip entirely
 * (there is nothing of ours to sign).
 */
function PdfArtifactView({ url, filename }: { readonly url?: string; readonly filename: string }) {
  const external = externalPdfUrl(url);
  const live = useLiveArtifactUrl(external ? undefined : url);
  if (external) return <PdfView externalUrl={external} originalHref={external} filename={filename} />;
  return <PdfView storedSrc={live.src} originalHref={live.href} filename={filename} ready={live.ready} />;
}

function XlsxView({ url }: { readonly url?: string }) {
  const [state, setState] = useState<{
    status: "loading" | "error" | "ready";
    sheets?: { name: string; rows: string[][] }[];
  }>({ status: "loading" });
  const [active, setActive] = useState(0);
  const live = useLiveArtifactUrl(url);
  // SheetJS starts downloading as the preview opens, alongside the signed link, rather than after it.
  useEffect(() => void loadXlsx().catch(() => {}), []);

  useEffect(() => {
    if (!live.ready) return;
    let cancelled = false;
    (async () => {
      try {
        const proxiedUrl = live.src;
        if (!proxiedUrl) throw new Error("no url");
        const [XLSX, response] = await Promise.all([loadXlsx(), fetch(proxiedUrl)]);
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const buf = await response.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheets = wb.SheetNames.map((name) => ({
          name,
          rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
            header: 1,
            blankrows: false,
            defval: "",
            raw: false,
          }),
        }));
        if (!cancelled) setState({ status: "ready", sheets });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [live.ready, live.src]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error" || !state.sheets?.length) {
    return <OfficeFallback url={url} label="Couldn't render the spreadsheet inline." />;
  }
  const sheet = state.sheets[Math.min(active, state.sheets.length - 1)];
  const [head, ...body] = sheet.rows;
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <table className="w-full border-collapse text-xs">
          {head ? (
            <thead className="sticky top-0">
              <tr className="bg-muted text-left">
                {head.map((h, i) => (
                  <th key={i} className="border border-border px-2 py-1 font-medium">
                    {humanizeHeader(h)}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className={i % 2 ? "bg-muted/10" : ""}>
                {(head ?? r).map((_, j) => (
                  <td key={j} className="border border-border px-2 py-1 align-top">
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.sheets.length > 1 ? (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-border border-t bg-muted/40 px-2 py-1">
          {state.sheets.map((s, i) => (
            <button
              type="button"
              key={s.name}
              onClick={() => setActive(i)}
              className={cn(
                "shrink-0 rounded-t-md border-t-2 px-3 py-1 text-xs transition-colors",
                i === active
                  ? "border-foreground bg-background font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DocxView({ url }: { readonly url?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const live = useLiveArtifactUrl(url);

  useEffect(() => {
    if (!live.ready) return;
    let cancelled = false;
    (async () => {
      try {
        const proxiedUrl = live.src;
        if (!proxiedUrl || !ref.current) throw new Error("no url");
        const response = await fetch(proxiedUrl);
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const buf = await response.arrayBuffer();
        const { renderAsync } = await import("docx-preview");
        ref.current.innerHTML = "";
        await renderAsync(new Blob([buf]), ref.current, undefined, { inWrapper: true });
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [live.ready, live.src]);

  if (status === "error") return <OfficeFallback url={url} label="Couldn't render the document inline." />;
  return (
    <div className="h-full overflow-auto bg-white">
      {status === "loading" ? <Loading /> : null}
      <div ref={ref} className={status === "ready" ? "p-4" : "hidden"} />
    </div>
  );
}

function CsvTable({ text }: { readonly text: string }) {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(0, 500)
    .map((r) => r.split(","));
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0">
          <tr className="bg-muted text-left">
            {(head ?? []).map((h, i) => (
              <th key={i} className="border border-border px-2 py-1 font-medium">
                {humanizeHeader(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className={i % 2 ? "bg-muted/10" : ""}>
              {r.map((c, j) => (
                <td key={j} className="border border-border px-2 py-1 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OfficeFallback({
  url,
  filename,
  label,
}: {
  readonly url?: string;
  readonly filename?: string;
  readonly label?: string;
}) {
  const live = useLiveArtifactUrl(url);
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <FileIcon className="size-10 text-muted-foreground" />
        {filename ? <p className="font-medium text-sm">{filename}</p> : null}
        <p className="max-w-xs text-muted-foreground text-sm">{label ?? "Preview not available."}</p>
        {url ? (
          <a
            href={live.href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Open / download
            <ExternalLinkIcon className="size-3.5" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid h-full place-items-center p-8 text-muted-foreground text-sm">
      Loading preview…
    </div>
  );
}
