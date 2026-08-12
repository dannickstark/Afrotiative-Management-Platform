import { LayoutDashboard, Inbox, Newspaper, Activity, Settings, LayoutTemplate, Images, Wand2 } from "lucide-react";
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
  // D1 §6: admin-only (social:manage) — the editor gets read/send from the article page's
  // Diffusion panel, not this administration surface (same split as team/integrations/pipeline
  // above, all admin-only for the analogous reason).
  { href: "/settings/social", label: "Réseaux sociaux", roles: ["admin"] },
];

// NOTE sur `href: "/settings"` : il n'existe pas de page à cette adresse (app/(app)/settings/
// n'a qu'un layout.tsx et des sous-dossiers). Ce href ne sert JAMAIS de lien — NavMain rend un
// parent avec enfants comme déclencheur de repli, pas comme <Link>. Il sert uniquement à la
// détection d'état actif (pathname.startsWith) et au fil d'Ariane.

// ---- Sections de premier niveau (structure sidebar-02) ----
// Un groupe repliable par section. Motivation : le programme « Studio visuel & diffusion »
// ajoute ~8 entrées de navigation ; une liste plate deviendrait illisible. Les sections Studio et
// Diffusion seront ajoutées ici par V2 et D1 — c'est le seul endroit à modifier.
export type NavSection = { id: string; label: string; roles?: Role[]; items: NavItem[] };

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "redaction",
    label: "Rédaction",
    items: [
      { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
      { href: "/queue", label: "File de revue", icon: Inbox, badgeKey: "pending" },
      { href: "/published", label: "Articles publiés", icon: Newspaper },
    ],
  },
  {
    id: "supervision",
    label: "Supervision",
    roles: ["admin", "editor"],
    items: [
      { href: "/runs", label: "Exécutions", icon: Activity, roles: ["admin", "editor"] },
    ],
  },
  {
    id: "studio",
    label: "Studio",
    roles: ["admin", "editor"],
    items: [
      { href: "/studio", label: "Gabarits", icon: LayoutTemplate, roles: ["admin", "editor"] },
      // Tâche 11 (Lot 3) : la bibliothèque d'assets (téléversement images/polices, render_assets).
      { href: "/studio/assets", label: "Bibliothèque", icon: Images, roles: ["admin", "editor"] },
      // Tâche 14 (Lot 4) : génération ponctuelle pour les contextes à saisie manuelle (citation,
      // bandeau, récap — spec §7).
      { href: "/studio/generer", label: "Génération", icon: Wand2, roles: ["admin", "editor"] },
    ],
  },
  {
    id: "reglages",
    label: "Réglages",
    roles: ["admin", "editor"],
    items: [
      {
        href: "/settings", label: "Réglages", icon: Settings,
        roles: ["admin", "editor"], items: SETTINGS_CHILDREN,
      },
    ],
  },
];

// DÉRIVÉ, jamais déclaré à part : ROUTE_LABELS et deriveCrumbs continuent de fonctionner sans
// modification, et un lien ajouté à une section ne peut pas manquer dans le fil d'Ariane.
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

// Filtrage par rôle sur TROIS niveaux : sous-éléments, éléments, puis sections devenues vides.
// Retourne toujours de nouveaux objets — `sections` n'est jamais muté. Extrait en fonction pure
// (paramètre `sections` plutôt que NAV_SECTIONS en dur) pour rester testable contre des fixtures
// synthétiques : avec les données réelles actuelles, aucun rôle ne fait jamais survivre une
// section à son propre filtre de rôle pour ensuite se vider entièrement au niveau des éléments —
// ça ne dira rien tant qu'une section future (ex. Studio, Diffusion) n'aura pas des droits plus
// larges au niveau section qu'au niveau de chacun de ses éléments.
export function filterSections(sections: NavSection[], role: Role): NavSection[] {
  return sections
    .filter((section) => !section.roles || section.roles.includes(role))
    .map((section) => ({
      ...section,
      items: section.items
        .filter((item) => !item.roles || item.roles.includes(role))
        .map((item) =>
          item.items
            ? { ...item, items: item.items.filter((c) => !c.roles || c.roles.includes(role)) }
            : item,
        )
        .filter((item) => !item.items || item.items.length > 0),
    }))
    .filter((section) => section.items.length > 0);
}

export function visibleNavSections(role: Role): NavSection[] {
  return filterSections(NAV_SECTIONS, role);
}

// Conservé pour les appelants qui veulent la liste plate visible (aucun aujourd'hui hors tests,
// mais l'API publique de ce module ne doit pas casser sans raison).
export function visibleNavItems(role: Role): NavItem[] {
  return visibleNavSections(role).flatMap((s) => s.items);
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
