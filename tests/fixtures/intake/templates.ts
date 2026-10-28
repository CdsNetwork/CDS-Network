/**
 * Invented emails in the shapes of the request templates CDS receives (Ryder pick up
 * request, First Student iProcure purchase order, website fleet request form, XPO free text)
 * and of the emails intake must ignore. Every name, address, phone, email and number here is
 * made up; only the layout follows the real templates.
 */
import type { NormalizedEmail } from "@/lib/intake/types";

let n = 0;
function email(partial: Partial<NormalizedEmail> & Pick<NormalizedEmail, "from" | "subject">): NormalizedEmail {
  n += 1;
  return {
    messageId: `<template-${n}@fixtures.example>`,
    to: ["dispatch@cds.direct"],
    receivedAt: "2026-10-19T15:00:00Z",
    text: null,
    html: null,
    attachments: [],
    ...partial,
  };
}

// ---------------------------------------------------------------- Ryder

const RYDER_FROM = "'Central Desk' via Ryder Dispatch <ryder@cds.direct>";

/** HTML label/value table, as the Ryder form sends it. DPF cleaning plus clamps and gaskets. */
export const ryderDpfClamps = email({
  from: RYDER_FROM,
  to: ["ryder@cds.direct"],
  subject: '***Ryder Location 424-LAKEMONT has a ["DPF Cleaning ","DPF Clamps and Gaskets "] ready for pick up***',
  html: `<html><body><p>Clean Diesel Specialists Pick Up Request</p>
<table>
<tr><td>Customer Name</td><td>Ryder System Inc</td></tr>
<tr><td>Region</td><td>Northeast</td></tr>
<tr><td>Date Requested</td><td>10/21/2026</td></tr>
<tr><td>Order Type</td><td>G14 Classified</td></tr>
<tr><td>Pick Up Location</td><td>Ryder - LAKEMONT</td></tr>
<tr><td>Pick Up Address</td><td>400 Example Rd</td></tr>
<tr><td>Ship to City, State, ZIP</td><td>Lakemont, PA 15000</td></tr>
<tr><td>Unit #</td><td>284113</td></tr>
<tr><td>Manufacturer</td><td>Freightliner</td></tr>
<tr><td>Miles</td><td>412,550</td></tr>
<tr><td>Serial #</td><td>SN-FAKE-77120</td></tr>
<tr><td>PO #</td><td>0424118833</td></tr>
<tr><td>Part #</td><td>A0009999</td></tr>
<tr><td>COMMENTS</td><td>Filter is on the rack by bay 2</td></tr>
</table></body></html>`,
});

/** Plain text "Label: value". EGR cooler to be returned to the location. */
export const ryderEgrReturn = email({
  from: RYDER_FROM,
  to: ["ryder@cds.direct"],
  subject: '***Ryder Location 611-NORTH HAVEN has a ["EGR Cooler Cleaning (Please return to my location) "] ready for pick up***',
  text: [
    "Clean Diesel Specialists Pick Up Request",
    "Customer Name: Ryder System Inc",
    "Region: Northeast",
    "Date Requested: 10/22/2026",
    "Order Type: G14 Classified",
    "Pick Up Location: Ryder - NORTH HAVEN",
    "Pick Up Address: 61 Demo Ave",
    "Ship to City, State, ZIP: North Haven, CT 06000",
    "Unit #: 51207",
    "Manufacturer: International",
    "Miles: 287004",
    "Serial #: EGR-FAKE-0042",
    "PO #: 0611200457",
    "Part #:",
    "COMMENTS: Please call before arriving",
  ].join("\n"),
});

/** Several services, and a Part # that is a CDS kit's OE cross: the kit is proposed. */
export const ryderDocKit = email({
  from: RYDER_FROM,
  to: ["ryder@cds.direct"],
  subject: '***Ryder Location 424-LAKEMONT has a ["DPF Cleaning ","DOC Cleaning ","DPF Clamps and Gaskets "] ready for pick up***',
  text: [
    "Customer Name\tRyder System Inc",
    "Region\tNortheast",
    "Date Requested\t10/23/2026",
    "Order Type\tStandard",
    "Pick Up Location\tRyder - LAKEMONT",
    "Pick Up Address\t400 Example Rd",
    "Ship to City, State, ZIP\tLakemont, PA 15000",
    "Unit #\t284190",
    "Manufacturer\tCummins",
    "Miles\t198000",
    "Serial #\tSN-FAKE-11",
    "PO #\t0424118900",
    "Part #\tA6801234",
    "COMMENTS\tIsuzu filter already cleaned",
  ].join("\n"),
});

/** Unknown location, no unit, PO or miles. */
export const ryderMissing = email({
  from: RYDER_FROM,
  to: ["ryder@cds.direct"],
  subject: '***Ryder Location 999-NOWHERE has a ["DOC Cleaning "] ready for pick up***',
  text: [
    "Customer Name: Ryder System Inc",
    "Region: Central",
    "Date Requested: 10/24/2026",
    "Order Type:",
    "Pick Up Location: Ryder - NOWHERE",
    "Pick Up Address: 1 Nowhere Lane",
    "Ship to City, State, ZIP: Nowhere, KS 66000",
    "Unit #:",
    "Manufacturer:",
    "Miles:",
    "Serial #:",
    "PO #:",
    "Part #:",
    "COMMENTS:",
  ].join("\n"),
});

/** The PO paperwork Ryder sends later for a job: not a new request. */
export const ryderPoIssued = email({
  from: "Ryder Purchase Order <po-notify@ryder.example>",
  subject: "Ryder Purchase Order: PO # 0424118833 Issued for Ryder Location 424-LAKEMONT",
  text: "Please see the attached purchase order.\n",
  attachments: [{ filename: "RyderPO_0424118833.pdf", contentType: "application/pdf", size: 20480 }],
});

/** A table row as the text part of the Ryder form carries it: cells joined by tabs expanded to 8-column stops. */
const tabRow = (...cells: string[]) =>
  cells.reduce((out, cell, i) => (i === cells.length - 1 ? out + cell : out + cell + " ".repeat(8 - ((out + cell).length % 8))), "");

/**
 * The Ryder form's text part: four cells per row, so a label, its value and the next label
 * share a line, and the service list leaks into the Manufacturer and Serial # cells.
 */
function ryderTextForm(o: { list: string; unit: string; manufacturer: string; po: string; comments: string }): string {
  return [
    "Hello Team CDS,",
    "",
    `Please see below for a ${o.list} pickup`,
    "",
    "Clean Diesel Specialists Pick Up Request",
    tabRow("Customer Name", "Ryder System Inc", "Region", "North Region"),
    tabRow("Date Requested", "10/27/2026", "Order Type", "G14 Classified"),
    tabRow("Pick Up Location", "Ryder - LAKEMONT"),
    tabRow("Pick Up Address", "400 Example Rd"),
    tabRow("Ship to City, State", "LAKEMONT, PA", "ZIP", "15000"),
    tabRow("Unit #", o.unit, `${o.list} Manufacturer`, o.manufacturer),
    "Miles",
    tabRow(`${o.list} Serial #`, "", "PO #", o.po),
    "Part #",
    "COMMENTS",
    o.comments,
    "",
    "Thank you,",
    "Project Desk",
  ].join("\n");
}

/** The real text layout of the form, with a unit number. */
export const ryderTextRows = email({
  from: RYDER_FROM,
  to: ["ryder@cds.direct"],
  subject: '***Ryder Location 424-LAKEMONT has a ["DPF Cleaning ","DPF Clamps and Gaskets "] ready for pick up***',
  text: ryderTextForm({
    list: '["DPF Cleaning ","DPF Clamps and Gaskets "]',
    unit: "284177",
    manufacturer: "Detroit",
    po: "0424118850",
    comments: "please send clamps and gaskets",
  }),
});

/**
 * A reply on that request: the dispatcher's sentence names "PO #" first, and the mail app
 * turned the quoted address and PO into links.
 */
export const ryderTextRowsReply = email({
  from: "Dana Sample <dana_sample@ryder.example>",
  to: ["ryder@cds.direct"],
  subject: `Re: ${ryderTextRows.subject}`,
  inReplyTo: "<dispatch-reply-1@cds.example>",
  text: [
    "The filter is on the rack.",
    "",
    "From: Central Dispatch <dispatch@cds.direct>",
    `Subject: Re: ${ryderTextRows.subject}`,
    "",
    "Please ensure your filter is marked with your location name and PO # to avoid any mix ups.",
    "",
    "On Tue, Oct 27, 2026 at 11:43 AM 'Central Desk' via Ryder Dispatch <ryder@cds.direct> wrote:",
    "",
    ryderTextRows
      .text!.replace("400 Example Rd", "400 Example Rd<https://maps.example/search/400+Example+Rd>")
      .replace("0424118850", "0424118850<tel:(042)%20411-8850>"),
  ].join("\n"),
});

/** The same layout with the unit and manufacturer left empty. */
export const ryderTextRowsNoUnit = email({
  from: RYDER_FROM,
  to: ["ryder@cds.direct"],
  subject: '***Ryder Location 424-LAKEMONT has a ["DPF Cleaning "] ready for pick up***',
  text: ryderTextForm({ list: '["DPF Cleaning "]', unit: "", manufacturer: "", po: "0424118851", comments: "" }),
});

/** The form's cells in order: label, value, label, value, ... ("" for an empty cell). */
const RYDER_GAP_CELLS = (unit: string) => [
  ["Customer Name", "Ryder System Inc"],
  ["Region", "South Region"],
  ["Date Requested", "10/23/2026"],
  ["Order Type", "G14 Classified"],
  ["Pick Up Location", "Ryder - LAKEMONT"],
  ["Pick Up Address", "400 Example Rd"],
  ["Ship to City, State", "LAKEMONT, PA"],
  ["ZIP", "15000"],
  ["Unit #", unit],
  ['["DPF Clamps and Gaskets "] Manufacturer', "Detroit Diesel"],
  ["Miles", ""],
  ['["DPF Clamps and Gaskets "] Serial #', ""],
  ["PO #", "0424951800"],
  ["Part #", "EA0024900001"],
];

/**
 * A reply quoting the form as Outlook does: every cell on its own line, with a blank line
 * between a label and its value. Empty cells (Miles, Serial #) leave the next label right
 * after the gap.
 */
function ryderGapText(unit: string): string {
  const subject = '***Ryder Location 424-LAKEMONT has a ["DPF Clamps and Gaskets "] ready for pick up***';
  return [
    "Do you have an eta on this filter coming back to me?  I have a truck waiting on it?",
    "",
    "From: Sam Example <sam_example@ryder.example>",
    "Sent: Friday, October 23, 2026 11:44 AM",
    "To: Central Dispatch <dispatch@cds.direct>",
    `Subject: Re: ${subject}`,
    "",
    "Please provide pictures of the filter's inlet and outlet.",
    "",
    "On Fri, Oct 23, 2026 at 7:46 AM 'Central Desk' via Ryder Dispatch <ryder@cds.direct<mailto:ryder@cds.direct>> wrote:",
    "",
    "Hello Team CDS,",
    "",
    'Please see below for a ["DPF Clamps and Gaskets "] pickup',
    "",
    "Clean Diesel Specialists Pick Up Request",
    "",
    ...RYDER_GAP_CELLS(unit)
      .flatMap(([label, value]) => [label, value])
      .filter((cell, i) => i % 2 === 0 || cell !== "")
      .map((cell) => (cell === "400 Example Rd" ? "400 Example Rd<https://maps.example/search/400+Example+Rd>" : cell))
      .flatMap((cell) => [cell, ""]),
    "COMMENTS",
    "",
    "18 x 17 x 17 45lbs",
    "",
    "Thank you,",
    "Project Desk",
  ].join("\n");
}

/** The same form as Outlook's HTML part: a <p> in each table cell. */
function ryderGapHtml(unit: string): string {
  const cell = (v: string) => `<td style="padding:.75pt"${v ? "" : ' colspan="3"'}>\n${v ? `<p class="xmsonormal">${v}<o:p></o:p></p>\n` : ""}</td>`;
  const pairs = RYDER_GAP_CELLS(unit).map(([l, v]) => [l.replace(/"/g, "&quot;"), v]);
  const rows: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) rows.push(`<tr>\n${pairs.slice(i, i + 2).flatMap(([l, v]) => [cell(l), cell(v)]).join("\n")}\n</tr>`);
  return [
    "<div><p>Do you have an eta on this filter coming back to me?</p>",
    "<p><br><br></p>",
    "<p>Hello Team CDS,<o:p></o:p></p>",
    "<p>Please see below for a [&quot;DPF Clamps and Gaskets&nbsp;&quot;] pickup<o:p></o:p></p>",
    '<table class="MsoNormalTable" border="1"><tbody>',
    '<tr><td colspan="4"><h3><span><br>\nClean Diesel Specialists Pick Up Request</span></h3></td></tr>',
    ...rows,
    "<tr><td><p>COMMENTS</p></td><td><p>18 x 17 x 17 45lbs</p></td></tr>",
    "</tbody></table>",
    "<p>Thank you,<br>Project Desk</p></div>",
  ].join("\n");
}

const RYDER_GAP_SUBJECT = 'RE: ***Ryder Location 424-LAKEMONT has a ["DPF Clamps and Gaskets "] ready for pick up***';

/** A reply whose quoted form has a blank line between each label and its value (text part). */
export const ryderGapReply = email({
  from: "Sam Example <sam_example@ryder.example>",
  to: ["dispatch@cds.direct"],
  subject: RYDER_GAP_SUBJECT,
  inReplyTo: "<dispatch-reply-2@cds.example>",
  text: ryderGapText("540001"),
  html: ryderGapHtml("540001"),
});

/** The same reply with only the HTML part. */
export const ryderGapReplyHtml = email({
  from: "Sam Example <sam_example@ryder.example>",
  to: ["dispatch@cds.direct"],
  subject: RYDER_GAP_SUBJECT,
  inReplyTo: "<dispatch-reply-3@cds.example>",
  text: null,
  html: ryderGapHtml("540001"),
});

/** The gapped reply with the unit cell left empty: "Unit #" is followed by the next label. */
export const ryderGapReplyNoUnit = email({
  from: "Sam Example <sam_example@ryder.example>",
  to: ["dispatch@cds.direct"],
  subject: RYDER_GAP_SUBJECT,
  inReplyTo: "<dispatch-reply-4@cds.example>",
  text: ryderGapText(""),
});

// ---------------------------------------------------------------- First Student iProcure

const IPROCURE_FROM = "Administrator - iProcure <notify@iprocure.example>";

/** Parts order: a sensor at a price that differs from the portal, and gaskets. */
export const fsIprocureParts = email({
  from: IPROCURE_FROM,
  subject: "New Purchase Order FSTL0098123 from First Student Company - First Student US (Account Number: 4007)",
  text: [
    "A new purchase order has been issued.",
    "",
    "PO Number: 5512345",
    "Order Description: NOX SENSORS AND GASKETS BUS 4410",
    "Total: 900.00",
    "Buyer: First Student Company (Account Number: 4007)",
    "Contact Name: Robin Sample",
    "E-Mail: robin.sample@firststudent.example",
    "Ship To Address:",
    "First Student 12723 Brookside - MM",
    "9 Placeholder Way",
    "Brookside, IL 60000",
    "",
    "Line Number: 1",
    "Item Number: ENV-NOX-1619",
    "Description: NOX SENSOR OUTLET",
    "Required Date: 10/28/2026",
    "Price: 410.00",
    "UOM: EA",
    "Quantity Requested: 2",
    "Taxable: 1",
    "Cost Center: 12723-MAINT",
    "Supplier Item Number: ENV-NOX-1619",
    "",
    "Line Number: 2",
    "Item Number: CDS-G-1051",
    "Description: DPF GASKET",
    "Required Date: 10/28/2026",
    "Price: 20.00",
    "UOM: EA",
    "Quantity Requested: 4",
    "Taxable: 1",
    "Cost Center: 12723-MAINT",
    "Supplier Item Number: CDS-G-1051",
  ].join("\n"),
});

/** Cleaning order through the customer's alias for the DPF cleaning, at the portal price. */
export const fsIprocureCleaning = email({
  from: IPROCURE_FROM,
  subject: "New Purchase Order FSTL0098200 from First Student Company - First Student US (Account Number: 4007)",
  text: [
    "PO Number: 5512399",
    "Order Description: DPF CLEANING UNIT 7720",
    "Total: 325.00",
    "Buyer: First Student Company (Account Number: 4007)",
    "Contact Name: Lee Placeholder",
    "E-Mail: lee.placeholder@firststudent.example",
    "Ship To Address:",
    "First Student 30418 Maple Grove - MM",
    "77 Orchard Lane",
    "Maple Grove, MN 55369",
    "",
    "Line Number: 1",
    "Item Number: CDS-DPF-CLEAN",
    "Description: DPF CLEANING",
    "Required Date: 10/30/2026",
    "Price: 325.00",
    "UOM: EA",
    "Quantity Requested: 1",
    "Taxable: 0",
    "Cost Center: 30418-SHOP",
    "Supplier Item Number: CDS-DPF-CLEAN",
  ].join("\n"),
});

// ---------------------------------------------------------------- website form (Wix)

const WIX_FROM = "Clean Diesel Specialists, Inc <no-reply@forms.wix.example>";

export const webFormPepsi = email({
  from: WIX_FROM,
  subject: "Website FORM SUBMISSION: Fleet Requests - Pepsi",
  text: [
    "CONTACT INFO",
    "Name: Jordan Fictional",
    "Store Room #: 3381",
    "Shop Phone #: (555) 010-2233",
    "Shop Email: shop3381@pepsi.example",
    "PC Email: pc3381@pepsi.example",
    "",
    "ADDRESS & PICKUP INFORMATION",
    "Location Address: 500 Example Blvd, Springfield, IL 62700",
    "Pickup Address: Same as above, dock 4",
    "Pickup / Delivery Options: Pick up at my location",
    "",
    "JOB DETAILS",
    "Mileage: 312,000",
    "PO #: 4500012345",
    "VIN #: 1FUJGLDR5CLZZ1234",
    "Part #: A0009999",
    "Filter Options: DPF",
    "Parts or Service: Emission Service",
    "",
    "Comments: Filter is wrapped on a pallet",
  ].join("\n"),
});

/** A fleet that is not a portal customer yet; ship option; DPF and DOC. */
export const webFormAmerit = email({
  from: WIX_FROM,
  subject: "Website FORM SUBMISSION: Fleet Requests - Amerit Fleet",
  text: [
    "CONTACT INFO",
    "Name: Casey Madeup",
    "Store Room #:",
    "Shop Phone #: (555) 010-9876",
    "Shop Email: casey@amerit.example",
    "PC Email:",
    "",
    "ADDRESS & PICKUP INFORMATION",
    "Location Address: 88 Sample Pkwy, Riverside, CA 92500",
    "Pickup Address:",
    "Pickup / Delivery Options: I will ship it",
    "",
    "JOB DETAILS",
    "Mileage: 154000",
    "PO #:",
    "VIN #: 4V4NC9EH1EN990123",
    "Part #:",
    "Filter Options: DPF, DOC",
    "Parts or Service: Emission Service",
    "",
    "Comments:",
  ].join("\n"),
});

// ---------------------------------------------------------------- XPO (free text, xpo@ inbox)

export const xpoRequest = email({
  from: "Tech Fakename <tech.fakename@xpo.example>",
  to: ["xpo@cds.direct"],
  subject: "SFS DPF CLEANING PICKUP",
  text: [
    "PO# 902814 UNIT # 0632-4471 METER 512,880 PICK UP FOR CLEANING QTY. 1 A6809999 DPF MODULE",
    "",
    "Tech Fakename",
    "Maintenance Technician",
    "XPO Yard SFS",
    "1200 Fictional Ave, Santa Fe Springs, CA 90670",
  ].join("\n"),
});

// ---------------------------------------------------------------- not requests

export const ignored: { name: string; kind: string; email: NormalizedEmail }[] = [
  {
    name: "reply on an existing thread (Re:)",
    kind: "reply",
    email: email({ from: "Shop Desk <desk@shop.example>", subject: "Re: WO 100245 pickup", text: "Driver will be there at 2pm. Unit 284113 DPF clean.\n" }),
  },
  {
    name: "reply by In-Reply-To without Re:",
    kind: "reply",
    email: email({
      from: "Shop Desk <desk@shop.example>",
      subject: "WO 100245 pickup",
      inReplyTo: "<earlier-message@shop.example>",
      text: "ETA tomorrow for the DPF cleaning on unit 284113.\n",
    }),
  },
  {
    name: "forward on an existing thread",
    kind: "reply",
    email: email({ from: "Someone <someone@fleet.example>", subject: "Fwd: Unit 5521 DPF", text: "See below. DPF cleaning unit 5521 PO 1234.\n" }),
  },
  {
    name: "shop invoice (QuickBooks)",
    kind: "invoice",
    email: email({ from: "Example Diesel Shop <quickbooks@notification.intuit.example>", subject: "Invoice 1042 from Example Diesel Shop", text: "Your invoice for DPF cleaning unit 284113 is attached.\n" }),
  },
  {
    name: "payment request",
    kind: "invoice",
    email: email({ from: "Example Diesel Shop <billing@shop.example>", subject: "New payment request from Example Diesel Shop", text: "Payment requested for DPF cleaning.\n" }),
  },
  {
    name: "XPO AP confirmation of a CDS invoice",
    kind: "invoice",
    email: email({ from: "AP Intake <ap@xpo.example>", to: ["xpo@cds.direct"], subject: "Accepted For Processing : Invoice 3-40012", text: "Your invoice for DPF cleaning has been accepted.\n" }),
  },
  {
    name: "cleaning shop invoice (Service Order)",
    kind: "invoice",
    email: email({
      from: "Shop Billing <billing@socal-shop.example>",
      to: ["xpo@cds.direct"],
      subject: "Invoice: 3-40055 | Service Order | PO # 902814 | Unit # 0632-4471 | Clean Diesel Specialists So Cal Inc. ANAHEIM",
      text: "Invoice attached for the DPF cleaning.\n",
    }),
  },
  {
    name: "Worldwide Express notice",
    kind: "carrier",
    email: email({ from: "Worldwide Express <notify@wwex.example>", subject: "Shipment Delivered: PRO 55501", text: "Your shipment of 1 DPF was delivered.\n" }),
  },
  {
    name: "UPS notice",
    kind: "carrier",
    email: email({ from: "UPS <mcinfo@ups.com>", subject: "UPS Update: Package Scheduled for Delivery Today", text: "Your package with DPF gasket will be delivered.\n" }),
  },
  {
    name: "Roadie notice",
    kind: "carrier",
    email: email({ from: "Roadie <hello@roadie.com>", subject: "Your Roadie delivery is complete", text: "The DPF pickup was delivered.\n" }),
  },
  {
    name: "Google security alert",
    kind: "security",
    email: email({ from: "Google <no-reply@accounts.google.com>", subject: "Security alert", text: "A new sign-in on Mac.\n" }),
  },
  {
    name: "sent by dispatch@cds.direct itself",
    kind: "cds_sent",
    email: email({ from: "CDS Dispatch <dispatch@cds.direct>", subject: "FS Location 12723- Shipping ORDER", text: "Please ship 2 x CDS-G-1051 DPF gaskets, unit 4410, PO 5512345.\n" }),
  },
  {
    name: "CDS's own Ryder pick up notice to a shop (no stars)",
    kind: "cds_sent",
    email: email({ from: "Dispatch Desk <desk@cds-shop.example>", subject: "Ryder Location 424-LAKEMONT has a DPF ready for pick up", text: "Unit 284113 DPF cleaning, PO 0424118833.\n" }),
  },
  {
    name: "CDS's outgoing XPO cleaning request",
    kind: "cds_sent",
    email: email({
      from: "XPO Dispatch <xpo@cds.direct>",
      to: ["shop@socal-shop.example"],
      subject: "New Cleaning Request: XPO Location: 1200 Fictional Ave",
      text: "New Cleaning Request: XPO Location: 1200 Fictional Ave M: 555-0100 PO: 902814 Filter MFG: Cummins Unit Number: 0632-4471 Mileage: 512880 Notes/Comments:\n",
    }),
  },
];
