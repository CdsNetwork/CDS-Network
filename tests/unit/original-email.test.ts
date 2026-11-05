/**
 * A work order made from an email shows that email on the CDS work order page (CDS dispatch,
 * 2026-11-05), so the team can check the items and the ship-to address there. It is plain
 * text only: the HTML part is converted with htmlToText and never rendered. Shops never see
 * it: inbound_emails has the CDS policy only, and no shop page reads it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { htmlToText } from "@/lib/intake/email";

const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));
const source = (path: string) => readFileSync(join(srcDir, path), "utf8");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("htmlToText for the original email", () => {
  it("strips tags and keeps the text", () => {
    expect(htmlToText('<div><b>Ship to:</b> <a href="x">First Student</a></div>')).toBe("Ship to: First Student");
  });

  it("decodes common entities", () => {
    expect(htmlToText("A &amp; B &lt;5&gt; &quot;x&quot; &#39;y&#39; &#x41;&nbsp;Z")).toBe(`A & B <5> "x" 'y' A Z`);
  });

  it("keeps line breaks for br, p, div, tr and li", () => {
    const text = htmlToText(
      "Line 1<br>Line 2<br/><p>Para</p><div>Block</div><table><tr><td>FS-1</td><td>2</td></tr><tr><td>FS-2</td><td>1</td></tr></table><ul><li>One</li><li>Two</li></ul>",
    );
    expect(text.split("\n")).toEqual(["Line 1", "Line 2", "Para", "Block", "FS-1\t2\t", "FS-2\t1\t", "", "One", "Two"]);
  });

  it("drops script, style and head content", () => {
    const text = htmlToText(
      "<head><title>T</title></head><style>p { color: red }</style><p>Hello</p><script>alert(1)</script><SCRIPT type='x'>evil()</SCRIPT>",
    );
    expect(text).toBe("Hello");
  });

  it("keeps encoded markup as text and does not throw on bad character codes", () => {
    expect(htmlToText("&lt;script&gt;x&lt;/script&gt;")).toBe("<script>x</script>");
    expect(htmlToText("a &#99999999; b &#x110000; c")).toBe("a &#99999999; b &#x110000; c");
  });
});

describe("original email on the CDS work order page", () => {
  const page = source("app/cds/work-orders/[id]/page.tsx");

  it("loads the emails linked to the order, newest first", () => {
    expect(page).toMatch(
      /supabase\.from\("inbound_emails"\)\.select\(EMAIL_COLUMNS\)\.eq\("work_order_id", id\)\.order\("received_at", \{ ascending: false \}\)/,
    );
    expect(page).toMatch(/const EMAIL_COLUMNS = "id, from_header, from_address, to_addresses, subject, received_at, body_text, body_html, attachments"/);
  });

  it("shows it right after Internal notes, as plain text", () => {
    expect(page).toMatch(/<Fact label="Internal notes">\{internal\?\.internal_notes\}<\/Fact>\s*\{emails\.map\(\(e\) => \(\s*<OriginalEmail /);
    expect(page).toContain("htmlToText(email.body_html");
    expect(page).not.toContain("dangerouslySetInnerHTML");
  });

  it("no shop page reads inbound_emails", () => {
    const shopFiles = filesUnder(join(srcDir, "app/shop"));
    expect(shopFiles.length).toBeGreaterThan(0);
    for (const f of shopFiles) expect(readFileSync(f, "utf8"), f).not.toMatch(/inbound_emails|intake/);
  });
});
