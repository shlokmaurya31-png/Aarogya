"use client";

import { useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { useRequireAdmin } from "@/hooks/useRequireAdmin";

const inputClass =
  "w-full rounded-md border border-hairline bg-black/[0.02] px-3.5 py-2.5 text-[13px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]";

export default function AdminStaffPage() {
  const { t } = useTranslation();
  const isAdmin = useRequireAdmin();
  const staffAccounts = useAuthStore((s) => s.staffAccounts);
  const addStaffAccount = useAuthStore((s) => s.addStaffAccount);
  const removeStaffAccount = useAuthStore((s) => s.removeStaffAccount);
  const push = useToastStore((s) => s.push);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result = addStaffAccount({ name, email, password });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push(t("admin.staff.toast.added"), "emerald");
    setName("");
    setEmail("");
    setPassword("");
  }

  function handleRemove(id: string, memberName: string) {
    removeStaffAccount(id);
    push(`${memberName} ${t("admin.staff.toast.removed")}`, "amber");
  }

  if (!isAdmin) return null;

  return (
    <div>
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-text-primary">{t("admin.staff.title")}</h1>
        <p className="mt-1 text-[12.5px] text-text-secondary">{t("admin.staff.subtitle")}</p>
      </div>

      <Card className="mt-6 rounded-lg">
        <CardLabel>{t("admin.staff.addTitle")}</CardLabel>
        <form onSubmit={handleAdd} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">{t("admin.staff.nameLabel")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} placeholder="Priya Sharma" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">{t("admin.staff.emailLabel")}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
              placeholder="priya@aarogya.ai"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">{t("admin.staff.passwordLabel")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={inputClass}
              placeholder="••••••••"
            />
          </label>
          <button
            type="submit"
            className="flex items-center justify-center gap-1.5 rounded-md bg-cyan px-4 py-2.5 text-[12.5px] font-medium text-ink transition hover:brightness-110"
          >
            <UserPlus size={14} /> {t("admin.staff.addButton")}
          </button>
        </form>
        {error && <p className="mt-2.5 text-[12.5px] text-red">{error}</p>}
        <p className="mt-3 rounded-lg border border-amber/20 bg-amber/[0.06] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-amber">
          {t("admin.staff.accessNote")}
        </p>
      </Card>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-[15px] font-medium">{t("admin.staff.listTitle")}</h2>
        <span className="text-[11.5px] text-text-tertiary">{staffAccounts.length}</span>
      </div>

      <div className="mt-3 space-y-2.5">
        {staffAccounts.length === 0 && (
          <Card className="rounded-lg text-center text-[13px] text-text-tertiary">{t("admin.staff.empty")}</Card>
        )}
        {staffAccounts.map((account) => (
          <Card key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg py-3.5">
            <div>
              <p className="text-[13px] font-medium text-text-primary">{account.name}</p>
              <p className="mt-0.5 text-[11.5px] text-text-tertiary">
                {account.email} · {t("admin.staff.createdOn")} {account.createdAt}
              </p>
            </div>
            <button
              onClick={() => handleRemove(account.id, account.name)}
              className="flex items-center gap-1.5 rounded-md border border-red/30 px-3.5 py-2 text-[12px] font-medium text-red transition hover:bg-red/10"
            >
              <Trash2 size={13} /> {t("admin.staff.removeButton")}
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}
