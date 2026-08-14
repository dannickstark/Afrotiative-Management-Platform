"use client";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export function DataTableToolbar({
  globalValue, onGlobalChange, searchPlaceholder, children,
}: {
  globalValue: string;
  onGlobalChange: (v: string) => void;
  searchPlaceholder?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={searchPlaceholder ?? "Rechercher…"}
          aria-label={searchPlaceholder ?? "Rechercher"}
          value={globalValue}
          onChange={(e) => onGlobalChange(e.target.value)}
          className="pl-8"
        />
      </div>
      {children}
    </div>
  );
}
