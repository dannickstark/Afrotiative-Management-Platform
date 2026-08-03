import { LayoutDashboard, Inbox, Calendar, Newspaper, Activity, Settings } from "lucide-react";
import type { Role } from "@/lib/auth";

export type NavItem = { href: string; label: string; icon: typeof Inbox; roles?: Role[]; badgeKey?: "pending" };
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/queue", label: "File de revue", icon: Inbox, badgeKey: "pending" },
  { href: "/calendar", label: "Calendrier", icon: Calendar },
  { href: "/published", label: "Articles publiés", icon: Newspaper },
  { href: "/runs", label: "Exécutions", icon: Activity },
  { href: "/settings/feeds", label: "Réglages", icon: Settings, roles: ["admin", "editor"] },
];
