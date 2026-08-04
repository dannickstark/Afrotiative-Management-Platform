"use client";
import { Textarea } from "@/components/ui/textarea";

export function ExcerptField({
  value, onChange, readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={readOnly}
      placeholder="Chapô / résumé de l'article…"
      aria-label="Chapô"
      className="min-h-20 text-sm"
    />
  );
}
