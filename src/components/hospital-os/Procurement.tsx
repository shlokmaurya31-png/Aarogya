"use client";

import { useEffect, useState, useCallback } from "react";
import { Truck, ClipboardList, PackageCheck } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { minorToRupees } from "@/lib/hospital/billing/money";

interface RequisitionRow {
  id: string;
  requisitionNumber: string | null;
  status: string;
  priority: string;
  justification: string;
  lines: { itemId: string; quantity: number }[];
}
interface PurchaseOrderRow {
  id: string;
  orderNumber: string | null;
  status: string;
  totalMinor: number;
  currency: string;
  supplier: { name: string };
  lines: { itemId: string; orderedQuantity: number; receivedQuantity: number }[];
}
interface GoodsReceiptRow {
  id: string;
  receiptNumber: string | null;
  status: string;
  recordedAt: string;
  lines: { acceptedQuantity: number; rejectedQuantity: number }[];
}

type Tab = "requisitions" | "purchase-orders" | "goods-receipts";

function money(minor: number, currency: string) {
  return `${currency === "INR" ? "₹" : currency + " "}${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

export function Procurement() {
  const [tab, setTab] = useState<Tab>("purchase-orders");
  const [requisitions, setRequisitions] = useState<RequisitionRow[] | null>(null);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRow[] | null>(null);
  const [goodsReceipts, setGoodsReceipts] = useState<GoodsReceiptRow[] | null>(null);

  const load = useCallback(() => {
    if (tab === "requisitions") fetch("/api/hospital/procurement/requisitions").then((r) => r.json()).then((d) => setRequisitions(d.requisitions));
    else if (tab === "purchase-orders") fetch("/api/hospital/procurement/purchase-orders").then((r) => r.json()).then((d) => setPurchaseOrders(d.purchaseOrders));
    else if (tab === "goods-receipts") fetch("/api/hospital/procurement/goods-receipts").then((r) => r.json()).then((d) => setGoodsReceipts(d.goodsReceipts));
  }, [tab]);
  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center gap-2">
        <Truck size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Procurement</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">Requisition → purchase order → goods receipt, each stage gated behind a separate-actor approval.</p>

      <div className="mt-4 flex gap-1 border-b border-hairline-strong pb-px">
        {[
          { key: "requisitions" as const, label: "Requisitions", icon: ClipboardList },
          { key: "purchase-orders" as const, label: "Purchase Orders", icon: Truck },
          { key: "goods-receipts" as const, label: "Goods Receipts", icon: PackageCheck },
        ].map((t) => (
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
        {tab === "requisitions" && (
          <Card className="rounded-[20px]">
            <CardLabel>Requisitions</CardLabel>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {requisitions?.map((r) => (
                <div key={r.id} className="flex items-center justify-between border-b border-hairline py-1.5 last:border-0">
                  <span>{r.requisitionNumber ?? "(draft)"} — {r.justification} <span className="text-text-tertiary">({r.lines.length} line(s), {r.priority})</span></span>
                  <span className="tabular-nums text-text-secondary">{r.status}</span>
                </div>
              ))}
              {requisitions?.length === 0 && <p className="text-text-tertiary">No requisitions yet.</p>}
            </div>
          </Card>
        )}

        {tab === "purchase-orders" && (
          <Card className="rounded-[20px]">
            <CardLabel>Purchase Orders</CardLabel>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {purchaseOrders?.map((po) => (
                <div key={po.id} className="flex items-center justify-between border-b border-hairline py-1.5 last:border-0">
                  <span>{po.orderNumber ?? "(draft)"} — {po.supplier.name} <span className="text-text-tertiary">({po.lines.length} line(s))</span></span>
                  <span className="tabular-nums text-text-secondary">{money(po.totalMinor, po.currency)} · {po.status}</span>
                </div>
              ))}
              {purchaseOrders?.length === 0 && <p className="text-text-tertiary">No purchase orders yet.</p>}
            </div>
          </Card>
        )}

        {tab === "goods-receipts" && (
          <Card className="rounded-[20px]">
            <CardLabel>Goods Receipts</CardLabel>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {goodsReceipts?.map((gr) => {
                const accepted = gr.lines.reduce((s, l) => s + l.acceptedQuantity, 0);
                const rejected = gr.lines.reduce((s, l) => s + l.rejectedQuantity, 0);
                return (
                  <div key={gr.id} className="flex items-center justify-between border-b border-hairline py-1.5 last:border-0">
                    <span>{gr.receiptNumber ?? "(unnumbered)"} — {new Date(gr.recordedAt).toLocaleDateString()}</span>
                    <span className="tabular-nums text-text-secondary">
                      {accepted} accepted{rejected > 0 ? `, ${rejected} rejected` : ""} · {gr.status}
                    </span>
                  </div>
                );
              })}
              {goodsReceipts?.length === 0 && <p className="text-text-tertiary">No goods receipts yet.</p>}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
