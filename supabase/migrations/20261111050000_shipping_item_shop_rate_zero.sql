-- The shop is not paid for shipping: CDS charges the customer for shipping and the shop's bill
-- gets the $15 per filter shipping deduction instead (20261111030000). The catalog default
-- shop rate for the Shipping item (SVC-SHIP) was +15.00, which would cancel the deduction out
-- if a Shipping line were added. Set that default to 0. Existing lines keep their snapshotted rate.
update public.shop_rates
   set amount = 0
 where catalog_item_id = (select id from public.catalog_items where sku = 'SVC-SHIP')
   and affiliate_id is null
   and customer_id is null
   and amount = 15;
