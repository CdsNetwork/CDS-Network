import { describe, expect, it } from "vitest";
import {
  bodyText,
  emailAddress,
  emailDomain,
  htmlToText,
  isForwarded,
  pastedMessageId,
  quotedSenders,
  validateNormalizedEmail,
} from "@/lib/intake/email";
import { extractDeterministic, findKnownPartNumbers, quantityOnLine, requestedCleanings, vinCheckDigitOk } from "@/lib/intake/extract";
import { fixture } from "../fixtures/intake/reference";

const det = (name: string) => {
  const e = fixture(name);
  return extractDeterministic(e.subject, bodyText(e));
};

describe("validateNormalizedEmail", () => {
  it("accepts a minimal email and fills defaults", () => {
    const r = validateNormalizedEmail({ messageId: "<a@b>", from: "x@y.example", text: "hello", to: "dispatch@cds.direct, b@c.example" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.to).toEqual(["dispatch@cds.direct", "b@c.example"]);
    expect(r.value.subject).toBe("");
    expect(r.value.attachments).toEqual([]);
    expect(Number.isNaN(new Date(r.value.receivedAt).getTime())).toBe(false);
  });

  it.each([
    [null, "body must be a JSON object"],
    [{ from: "a@b.example", text: "x" }, "messageId is required"],
    [{ messageId: "1", text: "x" }, "from is required"],
    [{ messageId: "1", from: "a@b.example" }, "text or html is required"],
    [{ messageId: "1", from: "a@b.example", text: "x", receivedAt: "not a date" }, "receivedAt must be an ISO date"],
  ])("rejects %j", (input, error) => {
    expect(validateNormalizedEmail(input)).toEqual({ ok: false, error });
  });

  it("keeps attachment metadata only and drops bad entries", () => {
    const r = validateNormalizedEmail({
      messageId: "1",
      from: "a@b.example",
      text: "x",
      attachments: [{ filename: "tag.jpg", contentType: "image/jpeg", size: 10, content: "AAAA" }, { size: 4 }, "nope"],
    });
    expect(r.ok && r.value.attachments).toEqual([{ filename: "tag.jpg", contentType: "image/jpeg", size: 10 }]);
  });

  it("loads every fixture", () => {
    expect(fixture("ryder-dpf-pickup").attachments).toHaveLength(1);
  });
});

describe("addresses and bodies", () => {
  it("extracts bare addresses and domains", () => {
    expect(emailAddress("Marcus Delgado <MDelgado@Ryder.example>")).toBe("mdelgado@ryder.example");
    expect(emailAddress("plain@x.example")).toBe("plain@x.example");
    expect(emailAddress("no address here")).toBeNull();
    expect(emailDomain("a@Sub.Fleet.example")).toBe("sub.fleet.example");
  });

  it("turns HTML into text with line breaks and table cells", () => {
    const text = htmlToText("<p>Unit <b>T-1</b></p><table><tr><td>FS-1</td><td>2</td></tr></table><script>x()</script>&amp; done");
    expect(text).toContain("Unit T-1");
    expect(text).toContain("FS-1\t2");
    expect(text).not.toContain("x()");
    expect(text).toContain("& done");
  });

  it("uses the HTML part when there is no text part", () => {
    expect(bodyText(fixture("no-location-number"))).toContain("1180 Industrial Pkwy, Fairview, OH 44126");
  });

  it("finds the original authors of a forwarded chain, oldest first", () => {
    const e = fixture("forwarded-chain");
    expect(isForwarded(e, bodyText(e))).toBe(true);
    expect(quotedSenders(bodyText(e))).toEqual(["shoplead611@ryder.example", "dwhitfield@ryder.example"]);
    expect(quotedSenders("no forward here")).toEqual([]);
  });

  it("gives a pasted email a stable id", () => {
    const a = pastedMessageId("A@x.example ", "Subj", "Body\n");
    expect(a).toBe(pastedMessageId("a@x.example", "Subj", "Body"));
    expect(a).not.toBe(pastedMessageId("a@x.example", "Subj", "Other"));
    expect(a).toMatch(/^pasted-[0-9a-f]{40}$/);
  });
});

describe("extractDeterministic", () => {
  it("reads a Ryder style request", () => {
    const d = det("ryder-dpf-pickup");
    expect(d.poNumber).toBe("7741200");
    expect(d.unitNumber).toBe("284113");
    expect(d.locationNumbers).toEqual(["0424"]);
    expect(d.vin).toBe("3AKJHHDR0KSKA7731");
    expect(d.vinValid).toBe(true);
    expect(d.fulfillment).toBe("pickup");
    expect(d.components).toEqual(["DPF", "DOC"]);
    expect(d.nonWorkReason).toBeNull();
  });

  it("reads a First Student request with department codes and shipping", () => {
    const d = det("first-student-parts");
    expect(d.poNumber).toBe("4500123987");
    expect(d.unitNumber).toBe("3318");
    expect(d.locationNumbers).toEqual(["12723M"]);
    expect(d.fulfillment).toBe("shipping");
    expect(d.vin).toBeNull();
  });

  it("reads the request inside a forwarded chain", () => {
    const d = det("forwarded-chain");
    expect(d.poNumber).toBe("7741388");
    expect(d.unitNumber).toBe("51207");
    expect(d.locationNumbers).toEqual(["611"]);
    expect(d.fulfillment).toBe("shipping");
  });

  it("reads an email without a location number or PO", () => {
    const d = det("no-location-number");
    expect(d.locationNumbers).toEqual([]);
    expect(d.poNumber).toBeNull();
    expect(d.unitNumber).toBe("T-55021");
    expect(d.zip).toBe("44126");
    expect(d.fulfillment).toBe("pickup");
  });

  it("skips a table label before the vehicle number and ignores Ship To", () => {
    const d = det("first-student-html-portal");
    expect(d.unitNumber).toBe("7720");
    expect(d.poNumber).toBe("4500124410");
    expect(d.locationNumbers).toEqual(["30418M"]);
    expect(d.fulfillment).toBe("pickup");
    expect(d.fulfillmentConflict).toBe(false);
  });

  it("flags a remittance notice as not a work request", () => {
    expect(det("not-work-request").nonWorkReason).toBe("Payment or remittance notice");
  });

  it("does not read PO Box or words as numbers", () => {
    const d = extractDeterministic("", "Mail to PO Box 4410. No PO yet. Postal code later. Unit pending.");
    expect(d.poNumber).toBeNull();
    expect(d.unitNumber).toBeNull();
  });

  it("checks VIN check digits", () => {
    expect(vinCheckDigitOk("3AKJHHDR0KSKA7731")).toBe(true);
    expect(vinCheckDigitOk("3AKJHHDR1KSKA7731")).toBe(false);
    expect(vinCheckDigitOk("SHORT")).toBe(false);
  });
});

describe("part numbers and quantities", () => {
  it("finds known part numbers with their quantity", () => {
    const text = "FS Part No.   Description   Qty\nFS-DPF-0097   DPF cleaning   1\nFS-GSK-1201   Gasket   2\n";
    expect(findKnownPartNumbers(text, ["FS-DPF-0097", "FS-GSK-1201", "FS-XXX-0001"])).toEqual([
      { partNumber: "FS-DPF-0097", qty: 1 },
      { partNumber: "FS-GSK-1201", qty: 2 },
    ]);
  });

  it("does not match inside a longer part number", () => {
    expect(findKnownPartNumbers("Part FS-GSK-12011 please", ["FS-GSK-1201"])).toEqual([]);
  });

  it.each([
    ["FS-1 qty: 3", 3],
    ["FS-1 x2", 2],
    ["(4) FS-1", 4],
    ["FS-1 5 ea", 5],
    ["FS-1\tgasket\t6", 6],
    ["FS-1 gasket", 1],
  ])("reads the quantity in %j", (line, qty) => {
    expect(quantityOnLine(line, "FS-1")).toBe(qty);
  });
});

describe("requestedCleanings", () => {
  it("finds components asked to be cleaned, not components named in a part description", () => {
    expect(requestedCleanings("Work needed: DPF clean.")).toEqual(["DPF"]);
    expect(requestedCleanings("DPF and DOC cleaning please")).toEqual(["DPF", "DOC"]);
    expect(requestedCleanings("Please clean and bake the DPF")).toEqual(["DPF"]);
    expect(requestedCleanings("EGR cooler cleaning")).toEqual(["EGR"]);
    expect(requestedCleanings("Send 2 DPF inlet gaskets")).toEqual([]);
    expect(requestedCleanings("Hi Clean Diesel team, DPF gasket needed")).toEqual([]);
  });

  it("BUG-M2-7: reads every component in a list after or before one cleaning word", () => {
    expect(requestedCleanings("Please clean the DPF and DOC, and add CDS-G-1051 x1")).toEqual(["DPF", "DOC"]);
    expect(requestedCleanings("Clean DPF, DOC and SCR")).toEqual(["DPF", "DOC", "SCR"]);
    expect(requestedCleanings("Clean DPF, DOC, and SCR please")).toEqual(["DPF", "DOC", "SCR"]);
    expect(requestedCleanings("Needs DPF/DOC/SCR cleaning")).toEqual(["DPF", "DOC", "SCR"]);
    expect(requestedCleanings("DPF, DOC & EGR cooler to be cleaned")).toEqual(["DPF", "DOC", "EGR"]);
    // A component after the list that is not part of it is still not a cleaning request.
    expect(requestedCleanings("Clean the DPF. Also send 2 DOC gaskets")).toEqual(["DPF"]);
  });

  it("does not read a cleaning that is declined or a part named next to the component", () => {
    expect(requestedCleanings("DPF inlet gasket and DOC clamp, no cleaning")).toEqual([]);
    expect(requestedCleanings("Need a DOC clamp, no cleaning")).toEqual([]);
    expect(requestedCleanings("DPF clean, no DOC cleaning")).toEqual(["DPF"]);
    expect(requestedCleanings("Do not clean the DOC, just the DPF gasket")).toEqual([]);
    expect(requestedCleanings("Don't need DOC cleaning this time")).toEqual([]);
    expect(requestedCleanings("Clean the DPF without the DOC")).toEqual(["DPF"]);
  });

  it("reads a component added to the list with a filler word", () => {
    expect(requestedCleanings("Clean DPF and also the DOC")).toEqual(["DPF", "DOC"]);
    expect(requestedCleanings("Please clean the DPF and then the DOC")).toEqual(["DPF", "DOC"]);
    expect(requestedCleanings("Clean the DPF plus the DOC")).toEqual(["DPF", "DOC"]);
  });
});

describe("BUG-M2-12: requestedCleanings with parts after the list and 'then'", () => {
  it("a component followed by a part word is a part, not a cleaning", () => {
    expect(requestedCleanings("CDS-G-1051 x1. We need a DPF cleaning and new DOC clamps")).toEqual(["DPF"]);
    expect(requestedCleanings("Clean the DPF and send DOC clamps")).toEqual(["DPF"]);
    expect(requestedCleanings("Please clean DPF and the DOC inlet gasket")).toEqual(["DPF"]);
    // The part word belongs to a later sentence: the list stays a cleaning request.
    expect(requestedCleanings("Clean the DPF and DOC. Gaskets too")).toEqual(["DPF", "DOC"]);
  });

  it("reads 'then' between components", () => {
    expect(requestedCleanings("Clean DPF then DOC")).toEqual(["DPF", "DOC"]);
    expect(requestedCleanings("Clean DPF then ship it back")).toEqual(["DPF"]);
  });
});
