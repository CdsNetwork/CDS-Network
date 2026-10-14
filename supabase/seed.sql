-- Demo data for local development and staging. Every name, address and number here is
-- invented. Logins are not seeded: create them with the admin screen or the auth API.

insert into public.customers (id, code, name) values
  ('c0000000-0000-4000-8000-000000000001', 'NORTHWIND', 'Northwind Fleet Leasing'),
  ('c0000000-0000-4000-8000-000000000002', 'BLUEBIRD', 'Bluebird Student Transit'),
  ('c0000000-0000-4000-8000-000000000003', 'PARCELWAY', 'Parcelway Logistics'),
  ('c0000000-0000-4000-8000-000000000004', 'OTHER', 'Other');

insert into public.customer_billing (customer_id, billing_email) values
  ('c0000000-0000-4000-8000-000000000001', 'ap@northwind.example'),
  ('c0000000-0000-4000-8000-000000000002', 'invoices@bluebird.example'),
  ('c0000000-0000-4000-8000-000000000003', 'payables@parcelway.example');

insert into public.affiliates (id, short_code, display_name, kind, city, region, can_egr, can_oil_soaked) values
  ('a0000000-0000-4000-8000-000000000001', 'HARBOR', 'Harbor DPF Works', 'service_shop', 'Port Delmar', 'CA', true, true),
  ('a0000000-0000-4000-8000-000000000002', 'MESA', 'Mesa Filter Clean', 'service_shop', 'Red Mesa', 'AZ', true, false),
  ('a0000000-0000-4000-8000-000000000003', 'LAKESIDE', 'Lakeside Emissions', 'service_shop', 'Clearwater Falls', 'OH', false, true),
  ('a0000000-0000-4000-8000-000000000004', 'SUPPLY1', 'Summit Parts Supply', 'parts_supplier', 'Granite City', 'TX', null, null);

insert into public.affiliate_contacts (affiliate_id, email, label) values
  ('a0000000-0000-4000-8000-000000000001', 'dispatch@harbor-dpf.example', 'dispatch'),
  ('a0000000-0000-4000-8000-000000000002', 'jobs@mesafilter.example', 'dispatch'),
  ('a0000000-0000-4000-8000-000000000003', 'office@lakeside-emissions.example', 'dispatch'),
  ('a0000000-0000-4000-8000-000000000004', 'orders@summitparts.example', 'dispatch');

insert into public.customer_locations
  (customer_id, code, location_number, name, address_raw, address_line1, city, region, postal_code,
   default_affiliate_id, fulfillment)
values
  ('c0000000-0000-4000-8000-000000000001', '101-PORT DELMAR', '101', 'PORT DELMAR',
   '100 Example Way Port Delmar CA 90001', '100 Example Way', 'Port Delmar', 'CA', '90001',
   'a0000000-0000-4000-8000-000000000001', 'pickup'),
  ('c0000000-0000-4000-8000-000000000001', '102-RED MESA', '102', 'RED MESA',
   '200 Sample Rd Red Mesa AZ 85001', '200 Sample Rd', 'Red Mesa', 'AZ', '85001',
   'a0000000-0000-4000-8000-000000000002', 'shipping'),
  ('c0000000-0000-4000-8000-000000000001', '103-CLEARWATER', '103', 'CLEARWATER FALLS',
   '300 Test Ave Clearwater Falls OH 43001', '300 Test Ave', 'Clearwater Falls', 'OH', '43001',
   'a0000000-0000-4000-8000-000000000003', 'pickup'),
  ('c0000000-0000-4000-8000-000000000002', 'BB-2001', '2001', 'BLUEBIRD NORTH YARD',
   '400 Demo Blvd Port Delmar CA 90002', '400 Demo Blvd', 'Port Delmar', 'CA', '90002',
   'a0000000-0000-4000-8000-000000000001', 'pickup');

-- Catalog: services pay the shop a flat service rate; parts pay the network figure.
insert into public.catalog_items (id, sku, category, name, oe_cross, tax_class) values
  ('10000000-0000-4000-8000-000000000001', 'SVC-DPF', 'service', 'DPF Cleaning', 'Diesel particulate filter thermal clean', 'labor'),
  ('10000000-0000-4000-8000-000000000002', 'SVC-DOC', 'service', 'DOC Cleaning', 'Diesel oxidation catalyst clean', 'labor'),
  ('10000000-0000-4000-8000-000000000003', 'SVC-EGR', 'service', 'EGR Cooler Test', 'Pressure test, pass or fail', 'labor'),
  ('10000000-0000-4000-8000-000000000004', 'SVC-SHIP', 'service', 'Shipping and Handling', 'Freight to and from shop', 'shipping'),
  ('10000000-0000-4000-8000-000000000005', 'SVC-TOLL', 'service', 'Toll Pass-Through', 'Billed at cost', 'labor'),
  ('10000000-0000-4000-8000-000000000006', 'DEMO-G-001', 'gasket', 'DPF Inlet Gasket 10.5 in', 'X100-1 / Y200-2', 'parts'),
  ('10000000-0000-4000-8000-000000000007', 'DEMO-G-002', 'gasket', 'DOC Outlet Gasket 9 in', 'X100-7', 'parts'),
  ('10000000-0000-4000-8000-000000000008', 'DEMO-C-001', 'clamp', 'V-Band Clamp 10.5 in', 'Z300-4', 'parts'),
  ('10000000-0000-4000-8000-000000000009', 'DEMO-B-001', 'bung', 'Sensor Bung M20', 'B10-20', 'parts');

insert into public.shop_rates (catalog_item_id, amount, effective_from) values
  ('10000000-0000-4000-8000-000000000001', 200.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000002', 120.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000003', 95.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000004', 25.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000005', 15.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000006', 11.50, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000007', 9.80, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000008', 22.40, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000009', 6.10, '2026-01-01');

insert into public.sell_prices (catalog_item_id, amount, effective_from) values
  ('10000000-0000-4000-8000-000000000001', 310.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000002', 185.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000003', 140.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000004', 30.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000005', 15.00, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000006', 12.65, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000007', 10.78, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000008', 24.64, '2026-01-01'),
  ('10000000-0000-4000-8000-000000000009', 6.71, '2026-01-01');

insert into public.customer_price_overrides (customer_id, catalog_item_id, amount, effective_from, note) values
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 295.00, '2026-01-01', 'Demo contract price'),
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 175.00, '2026-01-01', 'Demo contract price');

insert into public.tax_rates (market, region, postal_code, rate, taxes_parts, taxes_labor, taxes_shipping, label) values
  ('US', 'CA', null, 7.250, true, false, true, 'Demo state rate'),
  ('US', 'AZ', null, 5.600, true, false, true, 'Demo state rate'),
  ('US', 'OH', null, 5.750, true, true, true, 'Demo state rate');

-- Work orders across the flow.
insert into public.work_orders
  (id, customer_id, location_label, site_address, fulfillment, affiliate_id, status, unit_number, po_number,
   requested_work, pickup_window, affiliate_invoice_ref)
values
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', '101-PORT DELMAR',
   '100 Example Way Port Delmar CA 90001', 'pickup', null, 'pending_review', 'NW-1001', null,
   'DPF Cleaning', null, null),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', '101-PORT DELMAR',
   '100 Example Way Port Delmar CA 90001', 'pickup', 'a0000000-0000-4000-8000-000000000001', 'awaiting_acceptance',
   'NW-1002', 'PO-DEMO-2002', 'DPF Cleaning + DOC Cleaning', null, null),
  ('d0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', '102-RED MESA',
   '200 Sample Rd Red Mesa AZ 85001', 'shipping', 'a0000000-0000-4000-8000-000000000002', 'in_process',
   'NW-1003', 'PO-DEMO-2003', 'DPF Cleaning', null, null),
  ('d0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002', 'BB-2001',
   '400 Demo Blvd Port Delmar CA 90002', 'pickup', 'a0000000-0000-4000-8000-000000000001', 'completed',
   'BB-77', 'PO-DEMO-2004', 'DPF Cleaning + EGR test', '10-12', 'HDW-5501');

insert into public.work_order_internal (work_order_id, review_reason, tax_rate, tax_jurisdiction, tax_source) values
  ('d0000000-0000-4000-8000-000000000001', 'PO number missing', 7.250, 'CA', 'state_fallback'),
  ('d0000000-0000-4000-8000-000000000002', null, 7.250, 'CA', 'state_fallback'),
  ('d0000000-0000-4000-8000-000000000003', null, 5.600, 'AZ', 'state_fallback'),
  ('d0000000-0000-4000-8000-000000000004', null, 7.250, 'CA', 'state_fallback');

insert into public.work_order_lines (work_order_id, catalog_item_id, qty) values
  ('d0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 1),
  ('d0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 1),
  ('d0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1),
  ('d0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 1),
  ('d0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 2),
  ('d0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 1),
  ('d0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 1),
  ('d0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000006', 2);

insert into public.work_order_components
  (work_order_id, seq, component_type, manufacturer, part_number, serial_number,
   dp_before, dp_after, weight_before_g, weight_after_g, result, result_note)
values
  ('d0000000-0000-4000-8000-000000000004', 1, 'DPF', 'DemoCat', 'DC-1050', 'SN-DEMO-0001',
   4.8, 1.2, 16040, 15890, 'cleaned', null),
  ('d0000000-0000-4000-8000-000000000004', 2, 'EGR', 'DemoCool', 'EC-220', 'SN-DEMO-0002',
   null, null, null, null, 'passed', null);

insert into public.work_order_events (work_order_id, event_type, to_status, message, shop_visible) values
  ('d0000000-0000-4000-8000-000000000001', 'import', 'pending_review', 'Created; PO missing, held for review', false),
  ('d0000000-0000-4000-8000-000000000002', 'dispatch', 'awaiting_acceptance', 'Dispatched to Harbor DPF Works', true),
  ('d0000000-0000-4000-8000-000000000004', 'status_change', 'completed', 'Completed by shop', true);
