/**
 * The pages Intuit requires before issuing production QuickBooks keys (terms, privacy,
 * the QuickBooks disconnect page and the launch and connect entry points) open without a
 * login, and the legal pages show the draft notice while their content file says draft.
 */
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let signedIn = false;
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: "u1" } : null } }) },
  }),
}));

const { proxy } = await import("@/proxy");
const { parseLegal, DRAFT_NOTICE } = await import("@/lib/legal");

const visit = (path: string) => proxy(new NextRequest(`http://localhost${path}`));

describe("session proxy and the public pages", () => {
  it.each(["/legal/terms", "/legal/privacy", "/quickbooks/disconnected", "/quickbooks/launch", "/quickbooks/connect"])(
    "lets a signed-out visitor open %s",
    async (path) => {
      signedIn = false;
      const res = await visit(path);
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it("still sends a signed-out visitor away from the portal pages", async () => {
    signedIn = false;
    for (const path of ["/cds/admin", "/cds/quickbooks/connect", "/shop", "/legalese"]) {
      const res = await visit(path);
      expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
    }
  });
});

describe("legal pages", () => {
  it.each([
    ["terms", "Terms of Use"],
    ["privacy", "Privacy Policy"],
  ])("/legal/%s renders the approved content file without the draft notice or open items", async (name, title) => {
    const pages = { terms: () => import("@/app/legal/terms/page"), privacy: () => import("@/app/legal/privacy/page") };
    const { default: Page } = await pages[name as "terms" | "privacy"]();
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain(title);
    expect(html).not.toContain(DRAFT_NOTICE);
    expect(html).not.toContain("CDS to confirm");
    expect(html).toContain("Clean Diesel Specialists, Inc.");
    expect(html).toContain('href="/legal/');
  });

  it("hides the draft notice when the content file turns the flag off", () => {
    const on = parseLegal("---\ntitle: Terms of Use\ndraft: true\n---\n\nText.");
    const off = parseLegal("---\ntitle: Terms of Use\ndraft: false\n---\n\nText.");
    expect(on.draft).toBe(true);
    expect(off.draft).toBe(false);
    expect(off.title).toBe("Terms of Use");
  });

  it("reads headings, lists, bold text, links and CDS to confirm markers", () => {
    const doc = parseLegal(
      "---\ntitle: T\ndraft: false\n---\n\n## One\n\nSome **bold** and [a link](https://example.com).\n\n- a\n- b\n\nAsk [CDS to confirm: email].",
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(["h2", "p", "ul", "p"]);
    const p = doc.blocks[1];
    expect(p.type === "p" && p.inline.map((i) => i.type)).toEqual(["text", "strong", "text", "link", "text"]);
    const last = doc.blocks[3];
    expect(last.type === "p" && last.inline.some((i) => i.type === "confirm")).toBe(true);
  });

  it("never uses em or en dashes in the legal text", async () => {
    const { readFileSync } = await import("node:fs");
    for (const name of ["terms", "privacy"]) {
      const text = readFileSync(`src/content/legal/${name}.md`, "utf8");
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("/quickbooks/disconnected", () => {
  it("explains the disconnect and how a CDS admin reconnects", async () => {
    const { default: Page } = await import("@/app/quickbooks/disconnected/page");
    const html = renderToStaticMarkup(Page());
    expect(html).toContain("disconnected from QuickBooks");
    expect(html).toContain('href="/quickbooks/connect"');
  });
});
