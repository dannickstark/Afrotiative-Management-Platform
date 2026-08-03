"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./nav-items";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/auth";
import { cn } from "@/lib/utils";

export function Sidebar({ role, pendingCount }: { role: Role; pendingCount: number }) {
  const pathname = usePathname();
  return (
    <aside className="w-60 shrink-0 border-r bg-muted/30 flex flex-col">
      <div className="h-14 flex items-center px-4 font-semibold tracking-tight">
        <span className="text-[var(--accent-brand)]">Afrotiative</span>
      </div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV_ITEMS.filter((i) => !i.roles || i.roles.includes(role)).map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href}
              className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-background/60")}>
              <Icon className="size-4" /> <span className="flex-1">{item.label}</span>
              {item.badgeKey === "pending" && pendingCount > 0 && (
                <Badge className="bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]">{pendingCount}</Badge>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
