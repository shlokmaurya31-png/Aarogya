import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { revenueReport, arAgingReport, paymentReport, reconciliationReport } from "@/lib/commercial/analytics/reports";

/**
 * Platform-only commercial reports. `?report=revenue|ar_aging|payments|
 * reconciliation` and optional `?format=csv`. Canonical data, bounded periods,
 * currency-preserved, no secrets.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const report = q.get("report");
  const format = q.get("format");
  const fromISO = q.get("from") ?? undefined;
  const toISO = q.get("to") ?? undefined;

  // CSV needs a raw response, so it is handled outside withApiErrors' JSON wrapper.
  const build = async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    switch (report) {
      case "revenue": return revenueReport(m, { fromISO, toISO });
      case "ar_aging": return arAgingReport(m);
      case "payments": return paymentReport(m, { fromISO, toISO });
      case "reconciliation": return reconciliationReport(m);
      default: throw new BadRequestError("Unknown report.");
    }
  };

  if (format === "csv") {
    try {
      const result = await build();
      return new NextResponse(result.csv, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${result.report}.csv"` },
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return NextResponse.json({ error: status >= 400 && status < 500 ? (err as Error).message : "Internal error." }, { status });
    }
  }
  return withApiErrors(build);
}
