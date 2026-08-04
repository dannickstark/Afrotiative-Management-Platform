"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Rss, Tags, Users, Plug } from "lucide-react";
import type { Role } from "@/lib/auth";
import { cn } from "@/lib/utils";

type SettingsNavItem = { href: string; label: string; icon: typeof Rss; roles: Role[] };

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { href: "/settings/feeds", label: "Sources RSS", icon: Rss, roles: ["admin", "editor"] },
  { href: "/settings/taxonomy", label: "Catégories & Tags", icon: Tags, roles: ["admin", "editor"] },
  { href: "/settings/team", label: "Équipe", icon: Users, roles: ["admin"] },
  { href: "/settings/integrations", label: "Intégrations", icon: Plug, roles: ["admin"] },
];

export function SettingsNav({ role }: { role: Role }) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 border-b px-1">
      {SETTINGS_NAV_ITEMS.filter((item) => item.roles.includes(role)).map((item) => {
        const active = pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href}
            className={cn("flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm",
              active
                ? "border-[var(--accent-brand)] font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" /> {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
