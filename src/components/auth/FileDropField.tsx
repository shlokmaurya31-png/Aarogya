"use client";

import { useRef, useState } from "react";
import { FileUp, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function FileDropField({
  label,
  hint,
  file,
  onChange,
  accept = "image/*,.pdf",
  error,
}: {
  label: string;
  hint?: string;
  file: File | null;
  onChange: (file: File | null) => void;
  accept?: string;
  error?: string;
}) {
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList | null) {
    const f = files?.[0];
    if (f) onChange(f);
  }

  return (
    <div>
      <p className="mb-1.5 text-[12.5px] font-medium text-text-secondary">{label}</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-6 text-center transition-colors",
          dragActive ? "border-cyan/50 bg-cyan/[0.06]" : "border-hairline-strong bg-black/[0.02] hover:border-cyan/30",
          error && "border-red/40 bg-red/[0.04]"
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {file ? (
          <div className="flex items-center gap-2 text-[12.5px] text-text-primary">
            <Paperclip size={13} className="text-cyan" />
            <span className="max-w-[220px] truncate">{file.name}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              className="text-text-tertiary hover:text-red"
              aria-label="Remove file"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <>
            <FileUp size={18} className="text-text-tertiary" />
            <p className="text-[12.5px] text-text-secondary">
              Drop a file here or <span className="text-cyan">browse</span>
            </p>
          </>
        )}
      </div>
      {hint && !error && <p className="mt-1.5 text-[11px] text-text-tertiary">{hint}</p>}
      {error && <p className="mt-1.5 text-[11px] text-red">{error}</p>}
    </div>
  );
}
