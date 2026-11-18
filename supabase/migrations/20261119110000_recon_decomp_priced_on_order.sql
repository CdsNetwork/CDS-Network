-- RECON DECOMP in "Priced on this order" (Sarah, CDS, 2026-11-18: "We don't have
-- 'Reconditioned Decomp' in the 'Priced on this order' drop down").
--
-- The QuickBooks catalog sync (20261119070000_qbo_catalog_sync.sql) created the item SKU
-- CDS-DECOMP-RECON5418127 as a plain part: price_per_line false, pass_through true (the
-- majority of parts, which carry the column default). The work order page lists in "Priced on
-- this order" the active items with price_per_line and not pass_through, like CDS-RECON-DPF,
-- CDS-RECON-DOC, CDS-RECON-SCR and CDS-NEW-FILTER: CDS types the customer price on each order.
-- This gives the item the same flags. No other item changes. Does nothing where the SKU does
-- not exist or already has these flags. New lines only: lines already on orders keep their
-- prices. New items from the sync are plain items now (src/lib/qbo/catalog-sync.ts).

update public.catalog_items
   set price_per_line = true, pass_through = false
 where sku = 'CDS-DECOMP-RECON5418127'
   and (not price_per_line or pass_through);
