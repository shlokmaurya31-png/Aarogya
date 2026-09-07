"use client";

import { useEffect, useState, useCallback } from "react";
import { Boxes, AlertTriangle, Clock, Ban, ShieldAlert } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";

interface StockBalanceRow {
  id: string;
  onHandQty: number;
  reservedQty: number;
  available: number;
  item: { name: string; sku: string; category: string };
  lot: { lotNumber: string; expiresAt: string | null; status: string };
  location: { name: string };
}
interface LotRow {
  id: string;
  lotNumber: string;
  expiresAt: string | null;
  status: string;
  item: { name: string; sku: string };
}
interface LowStockRow {
  itemId: string;
  totalOnHand: number;
  reorderPoint: number | null;
  reorderQuantity: number | null;
}

type Tab = "overview" | "low-stock" | "expiring-soon" | "expired" | "quarantined";

const TABS: { key: Tab; label: string; icon: typeof Boxes }[] = [
  { key: "overview", label: "Stock Overview", icon: Boxes },
  { key: "low-stock", label: "Low Stock", icon: AlertTriangle },
  { key: "expiring-soon", label: "Expiring Soon", icon: Clock },
  { key: "expired", label: "Expired", icon: Ban },
  { key: "quarantined", label: "Quarantined", icon: ShieldAlert },
];

export function InventoryStock() {
  const [tab, setTab] = useState<Tab>("overview");
  const [balances, setBalances] = useState<StockBalanceRow[] | null>(null);
  const [lowStock, setLowStock] = useState<LowStockRow[] | null>(null);
  const [lots, setLots] = useState<LotRow[] | null>(null);

  const load = useCallback(() => {
    if (tab === "overview") fetch("/api/hospital/inventory/stock/overview").then((r) => r.json()).then((d) => setBalances(d.balances));
    else if (tab === "low-stock") fetch("/api/hospital/inventory/stock/low-stock").then((r) => r.json()).then((d) => setLowStock(d.lowStock));
    else if (tab === "expiring-soon") fetch("/api/hospital/inventory/stock/expiring-soon").then((r) => r.json()).then((d) => setLots(d.lots));
    else if (tab === "expired") fetch("/api/hospital/inventory/stock/expired").then((r) => r.json()).then((d) => setLots(d.lots));
    else if (tab === "quarantined") fetch("/api/hospital/inventory/stock/quarantined").then((r) => r.json()).then((d) => setLots(d.lots));
  }, [tab]);
  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center gap-2">
        <Boxes size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Inventory</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">Stock ledger is authoritative — every balance below is derivable from an immutable movement history.</p>

      <div className="mt-4 flex gap-1 border-b border-hairline-strong pb-px">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-[12.5px] font-medium transition-colors ${
              tab === t.key ? "border-b-2 border-cyan text-ink" : "text-text-secondary hover:text-ink"
            }`}
          >
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "overview" && (
          <Card className="rounded-[20px]">
            <CardLabel>Stock by item / lot / location</CardLabel>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {balances?.map((b) => (
                <div key={b.id} className="flex items-center justify-between border-b border-hairline py-1.5 last:border-0">
                  <div>
                    <span className="font-medium">{b.item.name}</span>{" "}
                    <span className="text-text-tertiary">({b.item.sku}) · lot {b.lot.lotNumber} · {b.location.name}</span>
                  </div>
                  <span className="tabular-nums">
                    {b.available} available <span className="text-text-tertiary">/ {b.onHandQty} on-hand{b.reservedQty > 0 ? `, ${b.reservedQty} reserved` : ""}</span>
                  </span>
                </div>
              ))}
              {balances?.length === 0 && <p className="text-text-tertiary">No stock balances yet.</p>}
              {balances === null && <p className="text-text-tertiary">Loading…</p>}
            </div>
          </Card>
        )}

        {tab === "low-stock" && (
          <Card className="rounded-[20px]">
            <CardLabel>Below reorder point</CardLabel>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {lowStock?.map((row) => (
                <div key={row.itemId} className="flex items-center justify-between border-b border-hairline py-1.5 last:border-0">
                  <span>Item {row.itemId}</span>
                  <span className="tabular-nums text-amber-600">
                    {row.totalOnHand} on-hand (reorder point {row.reorderPoint}, suggested reorder qty {row.reorderQuantity})
                  </span>
                </div>
              ))}
              {lowStock?.length === 0 && <p className="text-text-tertiary">Nothing below its reorder point.</p>}
            </div>
          </Card>
        )}

        {(tab === "expiring-soon" || tab === "expired" || tab === "quarantined") && (
          <Card className="rounded-[20px]">
            <CardLabel>{TABS.find((t) => t.key === tab)?.label}</CardLabel>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {lots?.map((lot) => (
                <div key={lot.id} className="flex items-center justify-between border-b border-hairline py-1.5 last:border-0">
                  <span>{lot.item.name} <span className="text-text-tertiary">({lot.item.sku})</span> — lot {lot.lotNumber}</span>
                  <span className="tabular-nums text-text-secondary">{lot.expiresAt ? new Date(lot.expiresAt).toLocaleDateString() : "no expiry"} · {lot.status}</span>
                </div>
              ))}
              {lots?.length === 0 && <p className="text-text-tertiary">None.</p>}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
