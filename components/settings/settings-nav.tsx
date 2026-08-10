"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Rss, Tags, Users, Plug, SlidersHorizontal, Share2 } from "lucide-react";
import type { Role } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SETTINGS_CHILDREN } from "@/components/shell/nav-items";

const SETTINGS_ICON: Record<string, typeof Rss> = {
  "/settings/feeds": Rss,
  "/settings/taxonomy": Tags,
  "/settings/team": Users,
  "/settings/integrations": Plug,
  "/settings/pipeline": SlidersHorizontal,
  "/settings/social": Share2,
};

export function SettingsNav({ role }: { role: Role }) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 border-b px-1">
      {SETTINGS_CHILDREN.filter((item) => item.roles!.includes(role)).map((item) => {
        const active = pathname.startsWith(item.href);
        const Icon = SETTINGS_ICON[item.href];
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
