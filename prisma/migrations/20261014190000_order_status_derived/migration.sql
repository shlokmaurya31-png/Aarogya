-- D9: Order.status is derived from the specific order's lifecycle
-- (src/lib/hospital/orderEnvelope.ts deriveOrderStatus). Recompute every
-- envelope that has a specific order; the mapping here must match DERIVED.

UPDATE "Order" o SET "status" = (CASE m."status"::text
    WHEN 'DRAFT' THEN 'DRAFT' WHEN 'HELD' THEN 'ON_HOLD' WHEN 'COMPLETED' THEN 'COMPLETED'
    WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'REJECTED' THEN 'CANCELLED' WHEN 'DISCONTINUED' THEN 'DISCONTINUED'
    ELSE 'ACTIVE' END)::"OrderStatus"
FROM "MedicationOrder" m WHERE m."orderId" = o."id";

UPDATE "Order" o SET "status" = (CASE l."status"::text
    WHEN 'RESULTED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'ACTIVE' END)::"OrderStatus"
FROM "LabOrder" l WHERE l."orderId" = o."id";

UPDATE "Order" o SET "status" = (CASE i."status"::text
    WHEN 'REPORTED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'ACTIVE' END)::"OrderStatus"
FROM "ImagingOrder" i WHERE i."orderId" = o."id";

UPDATE "Order" o SET "status" = (CASE r."status"
    WHEN 'DRAFT' THEN 'DRAFT' WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'REJECTED' THEN 'CANCELLED'
    ELSE 'ACTIVE' END)::"OrderStatus"
FROM "Referral" r WHERE r."orderId" = o."id";

UPDATE "Order" SET "cancelledAt" = COALESCE("cancelledAt", CURRENT_TIMESTAMP) WHERE "status" = 'CANCELLED';
UPDATE "Order" SET "discontinueAt" = COALESCE("discontinueAt", CURRENT_TIMESTAMP) WHERE "status" = 'DISCONTINUED';
