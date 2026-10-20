---
title: Privacy Policy
updated: 2026-10-20
draft: true
---

This Privacy Policy explains how Clean Diesel Specialists, Inc., Anaheim, California ("CDS", "we", "us") collects, uses and protects information in the CDS Network Portal (the "Portal"). The Portal is an invite-only business tool used by CDS staff and the independent shops that work with CDS ("Affiliate Shops") to manage diesel emissions component work orders for CDS's fleet customers. It is not offered to consumers. [CDS to confirm: legal entity name and street address]

## 1. Information the Portal processes

### Login and account information

- Name, business email address and role of each CDS staff member and each Affiliate Shop login.
- Password (stored by our authentication provider in hashed form; CDS cannot read it) and session information needed to keep you signed in.
- A record of important changes (for example to prices, the catalog, shops, logins, customers, locations and settings) with the login that made them.

### Work order information

- Work orders: customer (fleet), customer location, unit number, VIN, purchase order number, requested work, status and dates.
- Customer locations: location names, numbers and addresses used for pickup, delivery and sales tax.
- Contact details of fleet staff and shop staff: names, business email addresses and phone numbers.
- Measurements and results recorded by shops (for example weights, pressure readings, pass or fail results and reasons), parts used, shop invoice references, notes, photos and files uploaded to a work order.
- Prices charged to customers, shop pay rates and sales tax (prices are visible to CDS staff only; each shop sees only its own pay rate).

### Shipping information

- Ship-from and ship-to addresses, contact names and phone numbers, package details, shipping labels, tracking numbers and tracking events.

### Incoming work request emails

- Work request emails sent to CDS's dispatch inbox: sender, recipients, subject, date, message text and the names of attachments. [CDS to confirm: which inboxes are forwarded to the Portal and how]

### Invoicing information

- When CDS connects its QuickBooks Online company, the Portal reads and writes the data described in section 3.

The Portal does not ask for or store payment card numbers, bank account numbers or government identification numbers.

## 2. How we use information

- To create, route, dispatch, track and complete work orders between CDS, Affiliate Shops and fleet customers.
- To create shipping labels and follow shipments.
- To read incoming work request emails into draft work orders. CDS staff review every draft before anything is dispatched.
- To create invoices for fleet customers in CDS's QuickBooks Online company and calculate sales tax.
- To send login emails (invitations and password resets).
- To keep the Portal secure, keep a record of changes, fix problems and back up records.

We do not sell personal information. We do not use information in the Portal for advertising, and the Portal contains no advertising, advertising cookies or third-party tracking or analytics.

## 3. QuickBooks Online

CDS can connect the Portal to CDS's own QuickBooks Online company through Intuit's authorization screen. An administrator of the QuickBooks company must approve the connection. Once connected, the Portal uses the QuickBooks Online Accounting API (scope com.intuit.quickbooks.accounting) only to:

- read the company name (company information);
- read whether QuickBooks Automated Sales Tax is turned on (tax preferences);
- read the list of active customers and active products and services (items), so CDS can link them to customers and catalog items in the Portal; and
- create invoices for completed work orders (customer, line items, quantities, prices, taxable or non-taxable lines, ship-to address, and the work order and purchase order numbers), and read back the new invoice's id, number and total.

The Portal does not read bank accounts, payments, payroll, employees or other accounting data.

The access and refresh tokens Intuit issues are encrypted (AES-256-GCM) before they are stored and are only readable by the Portal's server. Only CDS staff can connect or disconnect QuickBooks. You can disconnect at any time: in the Portal (Admin, Settings, Disconnect QuickBooks), which revokes the tokens at Intuit and deletes them from the Portal, or in QuickBooks (Settings, Apps). After a disconnect the Portal can no longer read from or write to QuickBooks. Invoices already created stay in QuickBooks, and the QuickBooks ids and names linked to Portal customers and items stay in the Portal until CDS removes them. [CDS to confirm: QuickBooks company the Portal will connect to in production]

## 4. Service providers (subprocessors)

We share information only with service providers that run the Portal for us, and only as needed for the purposes above:

- **Supabase**: database, user authentication and file storage (photos and files). [CDS to confirm: hosting region, expected United States]
- **Vercel**: hosting of the Portal's web application.
- **Intuit (QuickBooks Online)**: invoicing, as described in section 3.
- **ShipStation**, with the carriers **FedEx** and **UPS** (UPS through Worldwide Express): shipping labels, rates and tracking. Addresses, contact names, phone numbers and package details are sent to create labels.
- **Resend**: delivery of login emails (invitations and password resets) from the cds.direct domain.
- **Anthropic**: the text of incoming work request emails (and the names of their attachments) is sent to Anthropic's API so its Claude model can read it into a draft work order. [CDS to confirm: Anthropic account and data retention settings]
- **Google**: CDS's email (Google Workspace) and a backup of work order records to Google Sheets. [CDS to confirm: Google Sheets backup, not yet in use]

We may also disclose information when required by law, to protect our rights or the safety of others, or as part of a sale or reorganization of CDS's business.

## 5. Who can see what in the Portal

- CDS staff can see all work orders, prices, shops and settings.
- Each Affiliate Shop can see only the work orders assigned to it, the customer location and contact details needed to do that work, and its own pay rate. Shops cannot see customer prices, CDS's margin or other shops' work orders.
- These rules are enforced in the database itself (row level security), not only on screen.

## 6. Security

- Access by invitation only, with role-based permissions (CDS staff or Affiliate Shop).
- Encrypted connections (HTTPS) between your browser and the Portal, and between the Portal and its service providers.
- QuickBooks tokens are encrypted before they are stored. Secret keys for integrations are kept in the hosting provider's encrypted settings, not in the code.
- Photos and files are kept in private storage and are only served to logins allowed to see the work order.

No system is perfectly secure. If we learn of a security incident that affects your information, we will notify you as required by law.

## 7. Retention

We keep work order, shipping and invoicing records for as long as CDS needs them to run its business and to meet legal, tax and accounting obligations. [CDS to confirm: retention period for work orders, photos, incoming emails and change records, for example 7 years] Logins are deactivated when a person or shop no longer works with CDS. QuickBooks tokens are deleted when QuickBooks is disconnected.

## 8. Your choices and rights

You can ask CDS to see, correct or delete personal information about you, or to deactivate your login. Some records, such as completed work orders and invoices, may need to be kept for legal or accounting reasons. Depending on where you live (for example California), you may have additional rights under privacy laws; CDS will respond to requests as those laws require and will not discriminate against you for making a request.

## 9. Children

The Portal is for business use only and is not directed to anyone under 18.

## 10. Changes to this policy

We may update this Privacy Policy. The date at the top shows the latest version. If a change is significant, we will tell users in the Portal or by email.

## 11. Contact

Clean Diesel Specialists, Inc., Anaheim, California. [CDS to confirm: privacy contact email] [CDS to confirm: phone number and street address]

See also the [Terms of Use](/legal/terms).
