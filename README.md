# CDS Network Portal

Work orders for Clean Diesel Specialists staff and network shops. Next.js (App Router) on
Vercel, Supabase (Postgres, Auth, Storage) for data and logins.

## Access model

- Two kinds of login: CDS staff (see everything) and one login per shop.
- Shops see only their own dispatched work orders and their own pay rate. Customer
  prices, margins, tax and internal notes live in CDS-only tables protected by row level
  security, so they never reach a shop's browser.
- Every shop action (accept, decline, measurements, parts, extra work requests, complete)
  goes through a database function that checks the caller and the work order status.
- Prices are copied onto each work order line when it is added, so price list changes
  never rewrite existing orders.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Supabase URL and keys.
3. `npm run dev`

Database changes live in `supabase/migrations`. Apply them with `supabase db push` on a
linked project. `supabase/seed.sql` holds invented demo data for local or staging use.

## Tests

`npm run test:db` runs the access tests against a local Supabase stack (`supabase start`).
`scripts/test-db-remote.sh` runs them against the linked project. The tests create their
own logins and data and remove them afterwards.
