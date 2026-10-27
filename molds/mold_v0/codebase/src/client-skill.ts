/**
 * The client skill's files and zip (mold_v0-144; what it holds and its config: src/client-skill-config.ts). Built from
 * the build's profile, its config (src/client-skill.generated.ts), the address AI clients connect to and what the
 * customer MCP server itself lists (its instructions and tools, asked over an in-memory client as the customer docs'
 * tool table is: scripts/export-mcp-tools.ts). Kept per process and address: the build's tools do not change while it
 * runs. The zip is deterministic: sorted entries, one fixed time, so it changes only when its content does.
 */
import { deflateRawSync } from "node:zlib";
import { GENERATED_CLIENT_SKILL } from "./client-skill.generated.js";
import { skillFiles, skillName, type ClientSkillConfig, type SkillFacts } from "./client-skill-config.js";
import { PROFILE } from "./profile.js";

const CONFIG = GENERATED_CLIENT_SKILL as ClientSkillConfig | null;

/** The skill's name (its folder in the zip, and the zip's name: <name>-skill.zip). */
export const clientSkillName = () => skillName(CONFIG, PROFILE.mcp_server_name);
export const clientSkillFile = () => `${clientSkillName()}-skill.zip`;

/** What the customer MCP server lists to a caller with no account context: its instructions and tools. */
async function serverFacts(): Promise<Pick<SkillFacts, "instructions" | "tools">> {
  const [{ createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    import("./server.js"), import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/inMemory.js")]);
  const server = createServer({ orgId: 0, slug: "docs", name: "Docs" });
  const client = new Client({ name: "client-skill", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const { tools } = await client.listTools();
    return { instructions: client.getInstructions() ?? "",
      tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title ?? null, description: t.description ?? "", read_only: t.annotations?.readOnlyHint === true })) };
  } finally { await client.close(); }
}

const cache = new Map<string, Promise<{ files: Record<string, string>; zip: Buffer }>>();

/** The skill for the connector at `mcpBase` (the front door, without /mcp): its files by path, and the zip. */
export function clientSkill(mcpBase: string): Promise<{ files: Record<string, string>; zip: Buffer }> {
  const base = mcpBase.replace(/\/+$/, "");
  let got = cache.get(base);
  if (!got) {
    got = serverFacts().then((s) => {
      const files = skillFiles(CONFIG, { product: PROFILE.name, server: PROFILE.mcp_server_name, summary: PROFILE.short_description,
        url: `${base}/mcp`, install: `${base}/install`, ...s });
      return { files, zip: zip(Object.entries(files).map(([p, t]) => [`${clientSkillName()}/${p}`, Buffer.from(t, "utf8")])) };
    });
    got.catch(() => cache.delete(base));
    cache.set(base, got);
  }
  return got;
}

// ---------- a small zip writer (deflate, no dependency) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** 2026-01-01 00:00 in MS-DOS time and date: every entry's, so equal content makes an equal zip. */
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A zip of the entries (name -> bytes), deflated, in the order given; each file readable by everyone (0644). */
export function zip(entries: [string, Buffer][]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8"), body = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    local.push(h, n, body); central.push(c, n);
    offset += h.length + n.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
