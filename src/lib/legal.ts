import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The legal pages (/legal/terms, /legal/privacy) are written in src/content/legal/*.md so
 * CDS can change the wording without touching code. Each file starts with a small header:
 *
 *   ---
 *   title: Terms of Use
 *   updated: 2026-10-20
 *   draft: true
 *   ---
 *
 * draft: true shows DRAFT_NOTICE at the top of the page; set it to false once approved.
 * The body supports a small part of Markdown: ## and ### headings, paragraphs, "- " and
 * "1. " lists, **bold**, [links](https://...) and [CDS to confirm: ...] markers (highlighted).
 */

export const DRAFT_NOTICE = "Draft, pending approval by Clean Diesel Specialists, Inc.";

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "confirm"; text: string };

export type Block =
  | { type: "h2" | "h3" | "p"; inline: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] };

export type LegalDoc = { title: string; updated: string | null; draft: boolean; blocks: Block[] };

const INLINE = /\*\*(.+?)\*\*|\[(CDS to confirm:[^\]]*)\]|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of source.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > at) out.push({ type: "text", text: source.slice(at, index) });
    if (m[1] !== undefined) out.push({ type: "strong", text: m[1] });
    else if (m[2] !== undefined) out.push({ type: "confirm", text: `[${m[2]}]` });
    else {
      const href = m[4];
      // Only portal paths, https and mailto links.
      if (/^(\/(?!\/)|https:\/\/|mailto:)/.test(href)) out.push({ type: "link", text: m[3], href });
      else out.push({ type: "text", text: m[0] });
    }
    at = index + m[0].length;
  }
  if (at < source.length) out.push({ type: "text", text: source.slice(at) });
  return out;
}

function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0];
    if (first.startsWith("### ")) blocks.push({ type: "h3", inline: parseInline(first.slice(4)) });
    else if (first.startsWith("## ")) blocks.push({ type: "h2", inline: parseInline(first.slice(3)) });
    else if (lines.every((l) => l.startsWith("- "))) blocks.push({ type: "ul", items: lines.map((l) => parseInline(l.slice(2))) });
    else if (lines.every((l) => /^\d+\.\s/.test(l))) {
      blocks.push({ type: "ol", items: lines.map((l) => parseInline(l.replace(/^\d+\.\s+/, ""))) });
    } else blocks.push({ type: "p", inline: parseInline(lines.join(" ")) });
    // A heading followed directly by text on the next line.
    if (/^#{2,3} /.test(first) && lines.length > 1) blocks.push(...parseBlocks(lines.slice(1).join("\n")));
  }
  return blocks;
}

export function parseLegal(source: string): LegalDoc {
  const text = source.replace(/\r\n/g, "\n");
  const header = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta: Record<string, string> = {};
  if (header) {
    for (const line of header[1].split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return {
    title: meta.title || "Untitled",
    updated: meta.updated || null,
    // Anything but an explicit false keeps the draft notice on.
    draft: meta.draft?.toLowerCase() !== "false",
    blocks: parseBlocks(header ? text.slice(header[0].length) : text),
  };
}

export type LegalName = "terms" | "privacy";

export function loadLegal(name: LegalName): LegalDoc {
  return parseLegal(readFileSync(path.join(process.cwd(), "src", "content", "legal", `${name}.md`), "utf8"));
}
