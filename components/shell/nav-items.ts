import { LayoutDashboard, Inbox, Calendar, Newspaper, Activity, Settings } from "lucide-react";
import type { Role } from "@/lib/auth";

export type NavChild = { href: string; label: string; roles?: Role[] };
export type NavItem = {
  href: string;
  label: string;
  icon: typeof Inbox;
  roles?: Role[];
  badgeKey?: "pending";
  items?: NavChild[];
};

// Les cinq sous-pages de Réglages, avec leurs rôles propres. Reprises de
// components/settings/settings-nav.tsx, qui importe désormais cette liste au lieu de la
// redéclarer — une seule définition, donc pas de dérive entre la barre latérale et la
// navigation horizontale interne aux pages de réglages.
export const SETTINGS_CHILDREN: NavChild[] = [
  { href: "/settings/feeds", label: "Sources RSS", roles: ["admin", "editor"] },
  { href: "/settings/taxonomy", label: "Catégories & Tags", roles: ["admin", "editor"] },
  { href: "/settings/team", label: "Équipe", roles: ["admin"] },
  { href: "/settings/integrations", label: "Intégrations", roles: ["admin"] },
  { href: "/settings/pipeline", label: "Pipeline", roles: ["admin"] },
];

// NOTE sur `href: "/settings"` : il n'existe pas de page à cette adresse (app/(app)/settings/
// n'a qu'un layout.tsx et des sous-dossiers). Ce href ne sert JAMAIS de lien — NavMain rend un
// parent avec enfants comme déclencheur de repli, pas comme <Link>. Il sert uniquement à la
// détection d'état actif (pathname.startsWith) et au fil d'Ariane.
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/queue", label: "File de revue", icon: Inbox, badgeKey: "pending" },
  { href: "/calendar", label: "Calendrier", icon: Calendar },
  { href: "/published", label: "Articles publiés", icon: Newspaper },
  { href: "/runs", label: "Exécutions", icon: Activity, roles: ["admin", "editor"] },
  {
    href: "/settings", label: "Réglages", icon: Settings,
    roles: ["admin", "editor"], items: SETTINGS_CHILDREN,
  },
];

// Filtrage par rôle sur DEUX niveaux : les enfants d'abord, puis les parents devenus vides.
// Un éditeur voit « Réglages » (il a accès aux flux et à la taxonomie) ; si un jour tous les
// enfants passaient admin-only, le parent disparaîtrait au lieu de mener à un menu vide.
// Retourne toujours de nouveaux objets — NAV_ITEMS n'est jamais muté.
export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS
    .filter((item) => !item.roles || item.roles.includes(role))
    .map((item) =>
      item.items
        ? { ...item, items: item.items.filter((c) => !c.roles || c.roles.includes(role)) }
        : item,
    )
    .filter((item) => !item.items || item.items.length > 0);
}

export type Crumb = { href: string; label: string };

// href → libellé, pour le fil d'Ariane. Dérivé de NAV_ITEMS pour qu'un libellé de menu et un
// libellé de fil d'Ariane ne puissent jamais diverger. `/article` est ajouté à la main : c'est
// un préfixe de route dynamique (/article/[id]) qui n'apparaît pas dans le menu.
export const ROUTE_LABELS: Record<string, string> = {
  ...Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label])),
  ...Object.fromEntries(SETTINGS_CHILDREN.map((c) => [c.href, c.label])),
  "/article": "Article",
};

// Construit la piste en accumulant les segments et en ne gardant que ceux qui ont un libellé
// connu. Un segment dynamique (l'UUID de /article/[id]) n'a pas de libellé et se trouve donc
// naturellement écarté, sans traitement particulier.
export function deriveCrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [];
  let acc = "";
  for (const segment of pathname.split("/").filter(Boolean)) {
    acc += `/${segment}`;
    const label = ROUTE_LABELS[acc];
    if (label) crumbs.push({ href: acc, label });
  }
  return crumbs;
}
