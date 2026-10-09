"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  DownloadIcon,
  ExternalLinkIcon,
  FileWarningIcon,
  Maximize2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { opsFetchRaw } from "./ops/lib";
import { MAX_PDF_PREVIEW_BYTES, dataroomPdfHref, megabytes } from "@/lib/pdf-preview";
import "./pdf-view.css";

/**
 * In-app PDF viewer.
 *
 * Why not an <iframe> or <embed>: the page's CSP says `object-src 'none'`,
 * `frame-src 'self' blob:` and `connect-src 'self'`, so the browser's own PDF
 * plugin is unreliable here and another host's PDF can be neither framed nor
 * fetched — and an <iframe src> could not carry the bearer token anyway. So the
 * BYTES are fetched with the signed-in fetch and drawn to <canvas> by pdf.js:
 *
 *   - a stored artifact  → the freshly signed same-origin proxy url (`storedSrc`)
 *   - a DATA-ROOM file   → /api/dataroom?path=…&as=bytes (`dataroomPath`), the
 *     same workspace-scoped read every other data-room fetch goes through
 *   - any other https host → /api/ops/pdf-fetch, the server's guarded public fetch
 *
 * THIS IS THE ONLY PDF VIEWER, and until now it was reachable from ONE of those
 * three. That meant a PDF the agent PUBLISHED previewed, while the documents
 * this desk actually runs on — a filing an analyst uploads into the data room,
 * a deck they attach in chat — had no preview at all: listed, downloadable, and
 * nothing else. `dataroomPath` is that gap closed. Nothing about the drawing,
 * the memory behaviour or the failure vocabulary differs between the sources.
 *
 * pdf.js is imported lazily, so none of it is in the main bundle; its worker is
 * emitted by the bundler as a same-origin asset (`worker-src 'self'`).
 *
 * Pages render only when they come near the viewport and give their canvas back
 * when they leave, so a 400-page annual report costs a few pages of memory.
 */

/** Shared with the server, which refuses an over-size object before it streams. */
const MAX_PREVIEW_BYTES = MAX_PDF_PREVIEW_BYTES;
/** Backing-store budget per page canvas (~48 MB RGBA). Past this, render softer. */
const MAX_CANVAS_PIXELS = 12_000_000;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const PAGE_GAP = 12;
const PAGE_PAD = 16;

type PdfJs = typeof import("pdfjs-dist");
type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return lib;
  });
  pdfjsPromise.catch(() => {
    pdfjsPromise = null; // a failed chunk load should be retryable
  });
  return pdfjsPromise;
}

type Failure = "not_pdf" | "too_large" | "blocked" | "signin" | "expired" | "missing" | "password" | "generic";

const FAILURE_TEXT: Record<Failure, string> = {
  not_pdf: "This link is not a PDF.",
  /**
   * Names the limit from the ONE constant the server refuses by, so the two can
   * never quote different numbers at the same person.
   *
   * It no longer ends "— open the original": the "Open original" button below
   * appears only when there IS an original to open, and a data-room file has
   * none, so that half-sentence pointed at nothing. When the SERVER refused the
   * file it sends a better line than this one (it knows the actual size) and
   * that is what gets shown; this is the fallback for the case where nothing
   * declared a length and the streaming cap tripped.
   */
  too_large: `Too large to preview here (over ${megabytes(MAX_PDF_PREVIEW_BYTES)}).`,
  blocked: "This address cannot be previewed.",
  signin: "Your sign-in has expired. Sign in again, then reopen this file.",
  expired: "This file link has expired — reopen the file for a fresh one.",
  missing: "That file is no longer at this address.",
  password: "This PDF is password-protected, so it cannot be previewed here.",
  generic: "Couldn't show this PDF here.",
};

class PdfLoadError extends Error {
  readonly failure: Failure;
  /** The server's own sentence, when it wrote a better one than ours (it knows
   *  the file's actual size; we only know the limit). */
  readonly detail?: string;
  constructor(failure: Failure, detail?: string) {
    super(failure);
    this.failure = failure;
    this.detail = detail;
  }
}

/** Which of the three sources a fetch came from — they fail differently. */
type Source = { external: string } | { stored: string } | { dataroom: string };

function failureFor(status: number, code: string | undefined, source: Source): Failure {
  const signedIn = !("stored" in source); // a stored src carries its own signature
  if (code === "not_pdf" || status === 415) return "not_pdf";
  if (code === "too_large" || status === 413) return "too_large";
  if (code === "blocked_host") return "blocked";
  /**
   * 401 means two different things and they need different sentences. On a
   * route we authenticate to (the public fetch, the data room) it is OUR bearer
   * that has expired — an hour-old tab — and the fix is to sign in again. On a
   * stored artifact the request carried no identity at all; the signature in
   * the url was the authority and it is the thing that ran out.
   */
  if (status === 401) return signedIn ? "signin" : "expired";
  if (code === "upstream_missing" || status === 404) return "missing";
  if (status === 403 && !signedIn) return "expired";
  return "generic";
}

/** Read a response body with a byte cap; a stream that BREAKS at the cap means
 *  the server cut an over-size file it had no content-length for. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) throw new PdfLoadError("too_large");
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PREVIEW_BYTES) {
        void reader.cancel();
        throw new PdfLoadError("too_large");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PdfLoadError) throw err;
    throw new PdfLoadError(total >= MAX_PREVIEW_BYTES - 1024 * 1024 ? "too_large" : "generic");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024) - 4;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

async function fetchPdfBytes(source: Source): Promise<Uint8Array> {
  let res: Response;
  try {
    res =
      "external" in source
        ? await opsFetchRaw(`/api/ops/pdf-fetch?url=${encodeURIComponent(source.external)}`)
        : "dataroom" in source
          ? // The signed-in read. `opsFetchRaw` carries the bearer AND the active
            // workspace header, so this asks for the file exactly as the data
            // room's own list and text reads do — no second notion of who the
            // caller is, and no signed blob url ever reaching the browser.
            await opsFetchRaw(dataroomPdfHref(source.dataroom))
          : await fetch(source.stored);
  } catch {
    throw new PdfLoadError("generic");
  }
  if (!res.ok) {
    let code: string | undefined;
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { code?: string; error?: string };
      code = body.code;
      detail = body.error;
    } catch {
      /* not JSON */
    }
    throw new PdfLoadError(failureFor(res.status, code, source), detail);
  }
  const bytes = await readCapped(res);
  if (!hasPdfHeader(bytes)) throw new PdfLoadError("not_pdf");
  return bytes;
}

export function PdfView({
  storedSrc,
  externalUrl,
  dataroomPath,
  originalHref,
  filename,
  ready = true,
}: {
  /** Same-origin url to read a STORED artifact's bytes from (already signed). */
  readonly storedSrc?: string;
  /** A PDF on someone else's https host — read through /api/ops/pdf-fetch. */
  readonly externalUrl?: string;
  /** A logical data-room path ("{folder:uploads}/<person>/<file>.pdf") — read through
   *  /api/dataroom, which resolves it inside the CALLER'S workspace. */
  readonly dataroomPath?: string;
  /** Where "Open original" goes: the real address, in a new tab. */
  readonly originalHref?: string;
  readonly filename: string;
  /** False while the stored link is still being signed. */
  readonly ready?: boolean;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; failure: Failure; detail?: string }
    | { status: "ready"; pdfjs: PdfJs; doc: PdfDoc; base: { w: number; h: number } }
  >({ status: "loading" });

  useEffect(() => {
    if (!ready) return;
    const source: Source | null = externalUrl
      ? { external: externalUrl }
      : dataroomPath
        ? { dataroom: dataroomPath }
        : storedSrc
          ? { stored: storedSrc }
          : null;
    if (!source) {
      setState({ status: "error", failure: "generic" });
      return;
    }
    let cancelled = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    setState({ status: "loading" });
    (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([loadPdfJs(), fetchPdfBytes(source)]);
        if (cancelled) return;
        task = pdfjs.getDocument({
          data: bytes,
          // Same-origin copies made by scripts/copy-pdfjs-assets.mjs.
          wasmUrl: "/pdfjs/wasm/",
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          iccUrl: "/pdfjs/iccs/",
          // A PDF is untrusted input. We draw pages and text only: no XFA
          // forms, and no annotation/scripting layer is ever mounted, so nothing
          // the file carries can run or navigate.
          enableXfa: false,
        });
        const doc = await task.promise;
        if (cancelled) return;
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (!cancelled) setState({ status: "ready", pdfjs, doc, base: { w: vp.width, h: vp.height } });
      } catch (err) {
        if (cancelled) return;
        const failure: Failure =
          err instanceof PdfLoadError
            ? err.failure
            : (err as { name?: string })?.name === "PasswordException"
              ? "password"
              : (err as { name?: string })?.name === "InvalidPDFException"
                ? "not_pdf"
                : "generic";
        setState({
          status: "error",
          failure,
          detail: err instanceof PdfLoadError ? err.detail : undefined,
        });
      }
    })();
    return () => {
      cancelled = true;
      // Destroys the document and its worker-side state with it.
      if (task) void task.destroy();
    };
  }, [ready, storedSrc, externalUrl, dataroomPath]);

  if (state.status === "loading") {
    return (
      <div className="grid h-full place-items-center p-8 text-muted-foreground text-sm" role="status">
        <span className="flex items-center gap-2">
          <Spinner className="size-4" />
          Loading PDF…
        </span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="grid h-full place-items-center p-8 text-center" role="alert" data-testid="pdf-error" data-failure={state.failure}>
        <div className="flex flex-col items-center gap-3">
          <FileWarningIcon className="size-10 text-muted-foreground" />
          <p className="font-medium text-sm">{filename}</p>
          {/* The server's sentence when it has one — for "too large" it names
              the file's REAL size, which we cannot know from here, and a number
              is the difference between "it's broken" and "it's too big". */}
          <p className="max-w-xs text-muted-foreground text-sm">{state.detail ?? FAILURE_TEXT[state.failure]}</p>
          {originalHref ? (
            <a
              href={originalHref}
              target="_blank"
              rel="noopener noreferrer"
              // The chat intercepts clicks on .pdf links to open THIS viewer;
              // this one must really leave, or the button would loop.
              data-open-original
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
            >
              Open original
              <ExternalLinkIcon className="size-3.5" />
            </a>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <PdfPages pdfjs={state.pdfjs} doc={state.doc} base={state.base} originalHref={originalHref} filename={filename} />
  );
}

function PdfPages({
  pdfjs,
  doc,
  base,
  originalHref,
  filename,
}: {
  readonly pdfjs: PdfJs;
  readonly doc: PdfDoc;
  readonly base: { w: number; h: number };
  readonly originalHref?: string;
  readonly filename: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [current, setCurrent] = useState(1);
  const currentRef = useRef(1);
  const numPages = doc.numPages;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setScrollerEl(el);
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = width > 0 ? Math.max(0.1, (width - PAGE_PAD * 2) / base.w) : 0;
  const scale = zoom === "fit" ? fitScale : zoom;

  // Which page is "the" page: the one crossing the middle of the viewport.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const mid = el.scrollTop + el.clientHeight / 2;
      const pages = el.querySelectorAll<HTMLElement>("[data-pdf-page]");
      let lo = 0;
      let hi = pages.length - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (pages[m].offsetTop + pages[m].offsetHeight < mid) lo = m + 1;
        else hi = m;
      }
      currentRef.current = lo + 1;
      setCurrent(lo + 1);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // A zoom change resizes every page; stay on the page the reader was on.
  const lastScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || lastScale.current === scale) return;
    const wasFirstLayout = lastScale.current === 0;
    lastScale.current = scale;
    if (wasFirstLayout) return;
    const page = el.querySelector<HTMLElement>(`[data-pdf-page="${currentRef.current}"]`);
    if (page) el.scrollTop = page.offsetTop - PAGE_GAP;
  }, [scale]);

  const step = (dir: 1 | -1) => {
    const from = scale || 1;
    const next =
      dir === 1
        ? ZOOM_STEPS.find((z) => z > from + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
        : [...ZOOM_STEPS].reverse().find((z) => z < from - 0.01) ?? ZOOM_STEPS[0];
    setZoom(next);
  };

  const download = useCallback(async () => {
    try {
      const data = await doc.getData();
      const href = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = href;
      a.download = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
      a.setAttribute("data-open-original", "");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch {
      if (originalHref) window.open(originalHref, "_blank", "noopener,noreferrer");
    }
  }, [doc, filename, originalHref]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30" data-testid="pdf-view">
      <div className="flex h-10 shrink-0 items-center gap-1 border-border border-b bg-background px-2 text-xs">
        <span className="px-1 text-muted-foreground tabular-nums" aria-live="polite">
          Page {current} / {numPages}
        </span>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon-xs" onClick={() => step(-1)} aria-label="Zoom out" title="Zoom out">
          <ZoomOutIcon />
        </Button>
        <span className="w-10 text-center text-muted-foreground tabular-nums">{Math.round(scale * 100)}%</span>
        <Button variant="ghost" size="icon-xs" onClick={() => step(1)} aria-label="Zoom in" title="Zoom in">
          <ZoomInIcon />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setZoom("fit")}
          aria-pressed={zoom === "fit"}
          title="Fit to width"
        >
          <Maximize2Icon />
          Fit
        </Button>
        <span className="flex-1" />
        {originalHref ? (
          <Button asChild variant="ghost" size="xs">
            <a href={originalHref} target="_blank" rel="noopener noreferrer" data-open-original>
              <ExternalLinkIcon />
              Open original
            </a>
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" onClick={() => void download()}>
          <DownloadIcon />
          Download
        </Button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        {scale > 0 && scrollerEl ? (
          <div
            className="mx-auto flex w-max min-w-full flex-col items-center"
            style={{ gap: PAGE_GAP, padding: `${PAGE_GAP}px ${PAGE_PAD}px` }}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <PdfPage key={i} pdfjs={pdfjs} doc={doc} number={i + 1} scale={scale} base={base} root={scrollerEl} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const PdfPage = memo(function PdfPage({
  pdfjs,
  doc,
  number,
  scale,
  base,
  root,
}: {
  readonly pdfjs: PdfJs;
  readonly doc: PdfDoc;
  readonly number: number;
  readonly scale: number;
  /** Page 1's size in PDF points — the placeholder until this page reports its own. */
  readonly base: { w: number; h: number };
  readonly root: HTMLElement;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState(base);

  // "Near" = within about a screen and a half of the viewport, either side.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root,
      rootMargin: "150% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const host = canvasHost.current;
    const text = textHost.current;
    if (!host || !text) return;
    if (!near) {
      // Far away: hand the memory back. Zeroing the size frees the backing store
      // at once instead of waiting for the collector.
      for (const c of host.querySelectorAll("canvas")) {
        c.width = 0;
        c.height = 0;
      }
      host.replaceChildren();
      text.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: import("pdfjs-dist").RenderTask | null = null;
    let layer: import("pdfjs-dist").TextLayer | null = null;
    (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const w = viewport.width / scale;
      const h = viewport.height / scale;
      setSize((s) => (Math.abs(s.w - w) > 0.5 || Math.abs(s.h - h) > 0.5 ? { w, h } : s));

      // Sharp on a retina screen, but never past the pixel budget.
      let out = Math.min(window.devicePixelRatio || 1, 3);
      const pixels = viewport.width * viewport.height * out * out;
      if (pixels > MAX_CANVAS_PIXELS) out *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * out));
      canvas.height = Math.max(1, Math.floor(viewport.height * out));
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      task = page.render({
        canvas,
        viewport,
        transform: out === 1 ? undefined : [out, 0, 0, out, 0, 0],
      });
      await task.promise;
      if (cancelled) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      // Swap only once drawn, so a zoom change never flashes a blank page.
      for (const old of host.querySelectorAll("canvas")) {
        old.width = 0;
        old.height = 0;
      }
      host.replaceChildren(canvas);

      // Selectable text over the picture.
      text.replaceChildren();
      layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: text,
        viewport,
      });
      await layer.render();
    })().catch(() => {
      /* a cancelled render rejects by design; a page that fails stays blank */
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [near, scale, doc, number, pdfjs]);

  return (
    <div
      ref={frame}
      data-pdf-page={number}
      className="relative shrink-0 overflow-hidden bg-white shadow-sm ring-1 ring-border"
      style={
        {
          width: Math.floor(size.w * scale),
          height: Math.floor(size.h * scale),
          "--total-scale-factor": scale,
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as CSSProperties
      }
    >
      <div ref={canvasHost} className="absolute inset-0" />
      <div ref={textHost} className="pdfTextLayer" />
    </div>
  );
});
