/**
 * SERVER ONLY — the guard `import "server-only"` gives a Next module, for modules that are also loaded outside Next.
 *
 * Everything under lib/storage/ except hosts.ts holds or reads the file store's credentials (the Vercel Blob token,
 * the S3 keys, the link-signing secret) and must never be bundled for a browser. The deleted lib/blob-read.ts said so
 * with `import "server-only"`. That package cannot be imported here: its default export THROWS unless the importer was
 * resolved with the `react-server` condition, which only Next's server bundles set. These modules are also loaded by
 * the eve agent (agent/lib/dataroom-store.ts, agent/lib/artifact.ts) and by plain `node --experimental-strip-types`
 * (35 script entry points, every `npm run operator:*` command among them), and each of those would stop at the import.
 *
 * So the guard is in two parts, and together they are that import's two effects:
 *
 *   1. at run time, this module: evaluated in a browser it throws, before anything beside it is evaluated;
 *   2. at build time, scripts/check-storage-server-only.mjs (`npm run check:storage-server-only`, in CI): it follows
 *      the import graph from every "use client" file and fails when one reaches a module under lib/storage/ other than
 *      hosts.ts. That is the check `server-only` makes inside `next build`, made for every importer.
 *
 * A browser has a window and a document and is not Node. A test that defines `window` under Node is not a browser.
 */
const g = globalThis as { window?: unknown; document?: unknown; process?: { versions?: { node?: string } } };

if (typeof g.window !== "undefined" && typeof g.document !== "undefined" && !g.process?.versions?.node) {
  throw new Error(
    "lib/storage is server-only: it holds the file store's credentials and cannot be imported from a Client Component. " +
      "A client component may import lib/storage/hosts.ts and nothing else under lib/storage/.",
  );
}

export {};
