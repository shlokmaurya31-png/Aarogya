"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, NotebookPen } from "lucide-react";
import { Card } from "@/components/ui/Card";

interface Entry { id: string; title: string; body: string; specialty?: string | null; tags: string[]; createdAt: string }

export function StudentNotebook() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [showForm, setShowForm] = useState(false);

  function load() {
    fetch("/api/student/notebook").then((r) => r.json()).then((d) => setEntries(d.entries ?? []));
  }
  useEffect(load, []);

  async function create() {
    if (!title.trim() || !body.trim()) return;
    await fetch("/api/student/notebook", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    setTitle(""); setBody(""); setShowForm(false);
    load();
  }

  async function remove(id: string) {
    await fetch(`/api/student/notebook?id=${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Clinical Notebook</h1>
          <p className="mt-1 text-[13px] text-text-secondary">Private notes — visible only to you.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 rounded-md bg-cyan px-3.5 py-2 text-[12.5px] font-medium text-ink hover:brightness-110">
          <Plus size={13} /> New note
        </button>
      </div>

      {showForm && (
        <Card className="mt-4 rounded-[20px]">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Note..." className="mt-2 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
          <button onClick={create} className="mt-2 rounded-md bg-emerald px-4 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">Save note</button>
        </Card>
      )}

      <div className="mt-4 space-y-3">
        {entries.length === 0 && !showForm && (
          <Card className="rounded-[20px] text-center">
            <NotebookPen size={20} className="mx-auto text-text-tertiary" />
            <p className="mt-2 text-[12.5px] text-text-tertiary">No notes yet. Add revision notes, drug notes, or case reflections here.</p>
          </Card>
        )}
        {entries.map((e) => (
          <Card key={e.id} className="rounded-[20px]">
            <div className="flex items-start justify-between">
              <p className="text-[13.5px] font-medium">{e.title}</p>
              <button onClick={() => remove(e.id)}><Trash2 size={13} className="text-text-tertiary hover:text-red" /></button>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] text-text-secondary">{e.body}</p>
            <p className="mt-2 text-[10.5px] text-text-tertiary">{new Date(e.createdAt).toLocaleDateString()}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
