-- Customer subtotal and gross margin with the customer shipping charge (Sarah, CDS,
-- 2026-11-19: a work order showed "Customer subtotal (before tax) $250.00" and "Gross margin
-- -$15.40, after $60.40 shipping cost", while the QuickBooks invoice also charged the $28
-- shipping; "it doesn't actually account for the amount of shipping we are adding").
--
-- public.work_order_financials, as in 20261117010000_work_order_without_price.sql, except:
--   * lines_subtotal (new): the customer lines, what customer_subtotal was until now. A
--     shipping line added by hand (SVC-SHIP) is one of them, as it is a line on the invoice.
--   * customer_shipping (new): the automatic shipping charge for the invoice's Shipping box
--     and "Shipping and Handling (G)" line (public.work_order_customer_shipping.amount: First
--     Student exemption, GESi rates and CDS's override already applied; 0 without a row).
--   * customer_from_invoice (new): true when customer_subtotal is the QuickBooks invoice's
--     own amount, i.e. the order has its own QuickBooks invoice (no other work order records
--     the same invoice) with its total and tax stored (work_order_internal.qb_total,
--     qb_tax_total, 20261113020000_qb_invoice_amounts.sql).
--   * customer_subtotal: QuickBooks invoice total - tax when customer_from_invoice (what
--     QuickBooks charged before tax, shipping included), else lines_subtotal +
--     customer_shipping (what the invoice will charge before tax).
--     An invoice that covers two linked work orders (20261119080000_combined_invoice.sql)
--     stores the whole invoice's total on both, so each keeps its own computed share: the
--     sum over both orders is not counted twice.
--   * margin_before_shipping and margin use that customer_subtotal (margin = customer
--     subtotal - shop payable - shipping cost, as before).
-- Columns are added at the end, so the existing readers keep working; grants unchanged
-- (create or replace keeps them, CDS only through private.is_cds()). Shops read nothing here.

create or replace view public.work_order_financials with (security_invoker = true) as
select
  w.id as work_order_id,
  w.wo_number,
  r.customer_subtotal,
  (coalesce(l.shop_subtotal, 0) + coalesce(d.deductions, 0))::numeric(12,2) as shop_subtotal,
  coalesce(s.shipping_cost, 0)::numeric(12,2) as shipping_cost,
  (r.customer_subtotal - coalesce(l.shop_subtotal, 0) - coalesce(d.deductions, 0))::numeric(12,2)
    as margin_before_shipping,
  (r.customer_subtotal - coalesce(l.shop_subtotal, 0) - coalesce(d.deductions, 0)
    - coalesce(s.shipping_cost, 0))::numeric(12,2) as margin,
  (i.supplier_cost_tbd or coalesce(l.rate_missing, false)) as supplier_cost_tbd,
  coalesce(d.deductions, 0)::numeric(12,2) as shop_deductions,
  coalesce(l.price_missing, false) as customer_price_missing,
  coalesce(l.customer_subtotal, 0)::numeric(12,2) as lines_subtotal,
  coalesce(cs.amount, 0)::numeric(12,2) as customer_shipping,
  q.own_invoice as customer_from_invoice
from public.work_order_internal i
join public.work_orders w on w.id = i.work_order_id
left join lateral (
  select sum(p.customer_unit_price * ln.qty) as customer_subtotal,
         sum(coalesce(ln.shop_unit_rate, 0) * ln.qty) as shop_subtotal,
         bool_or(ln.shop_unit_rate is null) as rate_missing,
         bool_or(p.line_id is null) as price_missing
  from public.work_order_lines ln
  left join public.work_order_line_pricing p on p.line_id = ln.id
  where ln.work_order_id = w.id
) l on true
left join lateral (
  select sum(sd.amount) as deductions
  from public.work_order_shop_deductions sd
  where sd.work_order_id = w.id
) d on true
left join lateral (
  select sum(coalesce(c.actual_cost, c.quoted_cost, 0)) as shipping_cost
  from public.shipments sh
  join public.shipment_internal c on c.shipment_id = sh.id
  where sh.work_order_id = w.id
) s on true
left join lateral (
  select x.amount from public.work_order_customer_shipping x where x.work_order_id = w.id
) cs on true
cross join lateral (
  select (i.qb_invoice_id is not null and i.qb_total is not null and i.qb_tax_total is not null
          and not exists (
            select 1 from public.work_order_internal o
             where o.qb_invoice_id = i.qb_invoice_id and o.work_order_id <> i.work_order_id
          )) as own_invoice
) q
cross join lateral (
  select (case when q.own_invoice then i.qb_total - i.qb_tax_total
               else coalesce(l.customer_subtotal, 0) + coalesce(cs.amount, 0) end)::numeric(12,2) as customer_subtotal
) r
where (select private.is_cds());

comment on view public.work_order_financials is
  'CDS only. customer_subtotal = what the customer is charged before tax: the QuickBooks invoice total - tax when the order has its own invoice with amounts (customer_from_invoice), else the lines (lines_subtotal) + the customer shipping charge (customer_shipping, public.work_order_customer_shipping). margin = customer_subtotal - shop_subtotal (shop payable, deductions included) - shipping_cost (labels). 20261119230000_financials_customer_shipping.sql.';
