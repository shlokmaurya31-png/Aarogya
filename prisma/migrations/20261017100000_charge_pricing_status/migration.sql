-- Batch 5, decision 1: a charge's pricing is explicit. charge-capture posts a
-- zero-priced charge when no tariff exists (description "… (needs pricing)");
-- billing must price it or waive it (with a reason) before the invoice that
-- carries it can be issued.
--
-- Refuses rather than guesses: a charge described as "(needs pricing)" that
-- already carries an amount is named and must be resolved by hand.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('charge %s (unit %s, net %s)', id, "unitPriceMinor", "netAmountMinor"), '; ')
    INTO bad
    FROM (SELECT id, "unitPriceMinor", "netAmountMinor" FROM "Charge"
           WHERE description LIKE '%(needs pricing)' AND ("unitPriceMinor" <> 0 OR "netAmountMinor" <> 0)
           ORDER BY id LIMIT 20) c;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Charges marked "(needs pricing)" already carry an amount; resolve them by hand first: %', bad;
  END IF;
END $$;

CREATE TYPE "ChargePricingStatus" AS ENUM ('PRICED', 'NEEDS_PRICING', 'WAIVED');
CREATE TYPE "ChargeWaiverReason" AS ENUM ('PACKAGE_INCLUDED', 'GOODWILL', 'CHARITY', 'CLINICAL_ERROR', 'NOT_BILLABLE', 'OTHER');

ALTER TABLE "Charge"
  ADD COLUMN "pricingStatus" "ChargePricingStatus" NOT NULL DEFAULT 'PRICED',
  ADD COLUMN "waiverReason" "ChargeWaiverReason",
  ADD COLUMN "pricedAt" TIMESTAMP(3),
  ADD COLUMN "pricedByUserId" TEXT,
  ADD COLUMN "waivedAt" TIMESTAMP(3),
  ADD COLUMN "waivedByUserId" TEXT;

UPDATE "Charge" SET "pricingStatus" = 'NEEDS_PRICING'
 WHERE description LIKE '%(needs pricing)' AND "unitPriceMinor" = 0 AND "netAmountMinor" = 0;

-- A charge awaiting a price carries no amount; a waived one carries a reason and no amount.
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_needs_pricing_zero_check"
  CHECK ("pricingStatus" <> 'NEEDS_PRICING' OR ("unitPriceMinor" = 0 AND "netAmountMinor" = 0));
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_waived_reason_check"
  CHECK ("pricingStatus" <> 'WAIVED' OR ("waiverReason" IS NOT NULL AND "netAmountMinor" = 0));
