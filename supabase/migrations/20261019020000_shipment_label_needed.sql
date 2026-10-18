-- A shipment leg that has no label yet (new, or its label was voided) gets its own status,
-- "label_needed", instead of "label_created". The value is added in this file on its own so
-- the next migration can use it (a new enum value cannot be used in the transaction that
-- adds it).
alter type public.shipment_status add value if not exists 'label_needed' before 'label_created';
