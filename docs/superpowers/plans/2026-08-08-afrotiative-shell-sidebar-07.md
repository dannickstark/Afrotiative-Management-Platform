# Shell — structure `sidebar-07` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopter la structure du bloc shadcn `sidebar-07` — sous-menus repliables (Réglages), fil d'Ariane dans l'en-tête, rail de redimensionnement — sans lancer le CLI du bloc, qui casserait le routage.

**Architecture:** `nav-items.ts` devient la source unique de la navigation (élément parent + enfants + libellés de route), avec deux fonctions pures testables (`visibleNavItems`, `deriveCrumbs`). Un nouveau `NavMain` rend les deux formes de menu ; un nouveau `Breadcrumbs` consomme `deriveCrumbs`. `app-sidebar.tsx` et `app/(app)/layout.tsx` se contentent de câbler.

**Tech Stack:** Next.js 16 (App Router, RSC), React 19, shadcn/ui sur **Base UI** (`@base-ui/react`) — style `base-nova`, prop `render` et non `asChild`, Tailwind 4, Bun pour les tests.

**Spec:** `docs/superpowers/specs/2026-08-08-afrotiative-shell-sidebar-07-design.md`

## Global Constraints

- **Base UI, pas Radix.** Aucun `asChild` : la composition passe par `render={<Element />}`. Voir `components/confirm-dialog.tsx:8-13` pour la note de convention déjà écrite dans la base de code.
- **Ne PAS lancer `npx shadcn@latest add sidebar-07`.** Le bloc cible `app/dashboard/page.tsx`, qui entre en collision de route avec `app/(app)/dashboard/page.tsx`. Seul `breadcrumb` est installé par le CLI.
- Toute chaîne visible par l'utilisateur est en **français**.
- Les tests tournent avec `bun test` et ne doivent ni toucher le réseau ni exiger de clés d'API.
- `components/ui/sidebar.tsx` n'est **pas** modifié : il exporte déjà `SidebarRail`, `SidebarGroupLabel`, `SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton`.
- Le fichier `AGENTS.md` est réécrit par `next dev` ; s'il apparaît modifié, le committer avec le travail.

**Écart assumé par rapport à la spec :** la spec plaçait `deriveCrumbs` dans `breadcrumbs.tsx`. Ce plan la met dans `nav-items.ts`, à côté de `ROUTE_LABELS` qui est sa seule source de données — `nav-items.ts` est un module sans JSX, donc directement importable par `bun test` sans charger React.

---

### Task 1 : Modèle de navigation et fonctions pures

**Files:**
- Modify: `components/shell/nav-items.ts` (réécriture complète)
- Test: `tests/shell-nav.test.ts` (créer)

**Interfaces:**
- Consumes: `Role` depuis `@/lib/auth`
- Produces:
  - `type NavChild = { href: string; label: string; roles?: Role[] }`
  - `type NavItem = { href: string; label: string; icon: typeof Inbox; roles?: Role[]; badgeKey?: "pending"; items?: NavChild[] }`
  - `type Crumb = { href: string; label: string }`
  - `SETTINGS_CHILDREN: NavChild[]`
  - `NAV_ITEMS: NavItem[]`
  - `ROUTE_LABELS: Record<string, string>`
  - `visibleNavItems(role: Role): NavItem[]`
  - `deriveCrumbs(pathname: string): Crumb[]`

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `tests/shell-nav.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  NAV_ITEMS, SETTINGS_CHILDREN, ROUTE_LABELS, visibleNavItems, deriveCrumbs,
} from "@/components/shell/nav-items";

describe("visibleNavItems", () => {
  it("un journaliste ne voit ni Réglages ni Exécutions", () => {
    const hrefs = visibleNavItems("journalist").map((i) => i.href);
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/runs");
    expect(hrefs).toContain("/queue");
  });

  it("un éditeur voit Réglages avec exactement ses deux sous-pages autorisées", () => {
    const settings = visibleNavItems("editor").find((i) => i.href === "/settings");
    expect(settings).toBeDefined();
    expect(settings!.items!.map((c) => c.href)).toEqual([
      "/settings/feeds",
      "/settings/taxonomy",
    ]);
  });

  it("un admin voit les cinq sous-pages de Réglages", () => {
    const settings = visibleNavItems("admin").find((i) => i.href === "/settings");
    expect(settings!.items).toHaveLength(5);
  });

  it("un parent dont tous les enfants sont refusés n'est pas rendu", () => {
    // Garde-fou structurel : aucun parent de NAV_ITEMS ne doit survivre avec items: [].
    for (const role of ["admin", "editor", "journalist"] as const) {
      for (const item of visibleNavItems(role)) {
        if (item.items) expect(item.items.length).toBeGreaterThan(0);
      }
    }
  });

  it("ne mute pas NAV_ITEMS", () => {
    const before = NAV_ITEMS.find((i) => i.href === "/settings")!.items!.length;
    visibleNavItems("editor");
    expect(NAV_ITEMS.find((i) => i.href === "/settings")!.items!.length).toBe(before);
    expect(before).toBe(SETTINGS_CHILDREN.length);
  });
});

describe("ROUTE_LABELS", () => {
  it("couvre toute route de NAV_ITEMS et de ses enfants", () => {
    for (const item of NAV_ITEMS) {
      expect(ROUTE_LABELS[item.href]).toBeTruthy();
      for (const child of item.items ?? []) expect(ROUTE_LABELS[child.href]).toBeTruthy();
    }
  });
});

describe("deriveCrumbs", () => {
  it("une sous-page de réglages donne deux éléments", () => {
    expect(deriveCrumbs("/settings/team")).toEqual([
      { href: "/settings", label: "Réglages" },
      { href: "/settings/team", label: "Équipe" },
    ]);
  });

  it("une page de premier niveau donne un élément", () => {
    expect(deriveCrumbs("/queue")).toEqual([{ href: "/queue", label: "File de revue" }]);
  });

  it("une route dynamique retombe sur le libellé de son préfixe", () => {
    expect(deriveCrumbs("/article/8f1c6f2e-0000-4000-8000-000000000000")).toEqual([
      { href: "/article", label: "Article" },
    ]);
  });

  it("une route inconnue ne produit aucun élément", () => {
    expect(deriveCrumbs("/inconnu/quelque-part")).toEqual([]);
  });

  it("la racine ne produit aucun élément", () => {
    expect(deriveCrumbs("/")).toEqual([]);
  });
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/shell-nav.test.ts`
Expected: FAIL — `visibleNavItems`, `deriveCrumbs`, `ROUTE_LABELS`, `SETTINGS_CHILDREN` n'existent pas encore (`SyntaxError: export ... not found`).

- [ ] **Step 3 : Réécrire `components/shell/nav-items.ts`**

```ts
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
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `bun test tests/shell-nav.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5 : Faire compiler les consommateurs existants**

`components/shell/app-sidebar.tsx:35` fait encore `NAV_ITEMS.filter(...)`. Le remplacer par
`visibleNavItems(role)` (une ligne) pour que `bun run typecheck` passe ; le rendu des sous-menus
arrive en Task 2.

```tsx
const items = visibleNavItems(role);
```

et l'import : `import { visibleNavItems } from "./nav-items";`

Run: `bun run typecheck`
Expected: aucune erreur.

- [ ] **Step 6 : Commit**

```bash
git add components/shell/nav-items.ts components/shell/app-sidebar.tsx tests/shell-nav.test.ts
git commit -m "feat(shell): nav model with children + ROUTE_LABELS + deriveCrumbs (pure, tested)"
```

---

### Task 2 : `NavMain` — sous-menus repliables

**Files:**
- Create: `components/shell/nav-main.tsx`
- Modify: `components/shell/app-sidebar.tsx`
- Modify: `components/settings/settings-nav.tsx`

**Interfaces:**
- Consumes: `visibleNavItems`, `NavItem` (Task 1) ; `SETTINGS_CHILDREN` (Task 1)
- Produces: `NavMain({ items, pendingCount }: { items: NavItem[]; pendingCount: number })`

- [ ] **Step 1 : Créer `components/shell/nav-main.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { NavItem } from "./nav-items";

export function NavMain({ items, pendingCount }: { items: NavItem[]; pendingCount: number }) {
  const pathname = usePathname();

  return (
    <SidebarMenu>
      {items.map((item) => {
        const Icon = item.icon;

        // Élément parent : déclencheur de repli, jamais un lien (voir la note sur href:"/settings"
        // dans nav-items.ts). Ouvert d'office quand une de ses sous-pages est active, pour que la
        // page courante soit toujours visible dans le menu au chargement.
        if (item.items) {
          const childActive = item.items.some((c) => pathname.startsWith(c.href));
          return (
            <Collapsible
              key={item.href}
              defaultOpen={childActive}
              className="group/collapsible"
              render={<SidebarMenuItem />}
            >
              <CollapsibleTrigger
                render={<SidebarMenuButton isActive={childActive} tooltip={item.label} />}
              >
                <Icon />
                <span>{item.label}</span>
                <ChevronRight className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {item.items.map((child) => (
                    <SidebarMenuSubItem key={child.href}>
                      <SidebarMenuSubButton
                        isActive={pathname.startsWith(child.href)}
                        render={<Link href={child.href} />}
                      >
                        <span>{child.label}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </Collapsible>
          );
        }

        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              isActive={pathname.startsWith(item.href)}
              tooltip={item.label}
              render={<Link href={item.href} />}
            >
              <Icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
            {item.badgeKey === "pending" && pendingCount > 0 && (
              <SidebarMenuBadge className="rounded-full bg-[var(--accent-brand)] px-1.5 text-[var(--accent-brand-foreground)]">
                {pendingCount}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
```

- [ ] **Step 2 : Vérifier la signature de `SidebarMenuSubButton`**

Run: `sed -n '666,700p' components/ui/sidebar.tsx`
Expected: le composant accepte `isActive` et `render`. **S'il n'accepte pas `isActive`**, retirer
cette prop de l'appel ci-dessus (l'état actif du parent suffit) — ne PAS modifier
`components/ui/sidebar.tsx`.

- [ ] **Step 3 : Câbler dans `app-sidebar.tsx`**

Remplacer le bloc `<SidebarMenu>…</SidebarMenu>` (l. 57-75 d'origine) par `<NavMain … />`, et
ajouter le rail. Le `SidebarHeader` de marque et le `SidebarFooter` sont inchangés.

```tsx
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <NavMain items={items} pendingCount={pendingCount} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
```

Imports à ajuster : ajouter `NavMain` et `SidebarRail` ; retirer `SidebarMenu`,
`SidebarMenuBadge`, `SidebarMenuItem` s'ils ne servent plus qu'à l'en-tête de marque (celui-ci
utilise `SidebarMenu`/`SidebarMenuItem`/`SidebarMenuButton` — les garder), et retirer
`usePathname` devenu inutilisé ici.

- [ ] **Step 4 : `settings-nav.tsx` consomme la liste partagée**

Remplacer le tableau local `SETTINGS_NAV_ITEMS` par `SETTINGS_CHILDREN` importé de
`@/components/shell/nav-items`. Les icônes restent locales à ce fichier (`nav-items.ts` n'en
porte pas pour les enfants) via une table :

```tsx
import { Rss, Tags, Users, Plug, SlidersHorizontal } from "lucide-react";
import { SETTINGS_CHILDREN } from "@/components/shell/nav-items";

const SETTINGS_ICON: Record<string, typeof Rss> = {
  "/settings/feeds": Rss,
  "/settings/taxonomy": Tags,
  "/settings/team": Users,
  "/settings/integrations": Plug,
  "/settings/pipeline": SlidersHorizontal,
};
```

et dans le rendu : `SETTINGS_CHILDREN.filter((item) => item.roles!.includes(role))`, avec
`const Icon = SETTINGS_ICON[item.href];`.

- [ ] **Step 5 : Vérifier**

Run: `bun run typecheck && bun test tests/shell-nav.test.ts`
Expected: aucune erreur, 11 tests PASS.

- [ ] **Step 6 : Vérification visuelle**

Run: `bun run dev` puis ouvrir `http://localhost:3000/settings/team` en admin.
Expected: « Réglages » est ouvert avec ses cinq sous-pages, « Équipe » est marquée active ; le
repli en mode icône affiche l'infobulle ; le rail permet de replier au clic sur le bord.

- [ ] **Step 7 : Commit**

```bash
git add components/shell/nav-main.tsx components/shell/app-sidebar.tsx components/settings/settings-nav.tsx
git commit -m "feat(shell): collapsible Réglages submenu via NavMain + SidebarRail"
```

---

### Task 3 : Fil d'Ariane dans l'en-tête

**Files:**
- Create: `components/ui/breadcrumb.tsx` (via CLI)
- Create: `components/shell/breadcrumbs.tsx`
- Modify: `app/(app)/layout.tsx:29-36`

**Interfaces:**
- Consumes: `deriveCrumbs`, `Crumb` (Task 1)
- Produces: `Breadcrumbs()` — sans props, lit `usePathname()`

- [ ] **Step 1 : Installer la primitive**

```bash
npx shadcn@latest add breadcrumb
```

`components.json` fixe `"style": "base-nova"` : la variante Base UI est récupérée
automatiquement. Vérifier que le fichier créé est bien `components/ui/breadcrumb.tsx` et qu'il
n'a rien écrasé d'autre :

Run: `git status --short`
Expected: un seul fichier ajouté, `components/ui/breadcrumb.tsx`.

- [ ] **Step 2 : Créer `components/shell/breadcrumbs.tsx`**

```tsx
"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { deriveCrumbs } from "./nav-items";

export function Breadcrumbs() {
  const crumbs = deriveCrumbs(usePathname());
  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={crumb.href}>
              <BreadcrumbItem className={last ? undefined : "hidden md:block"}>
                {last ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={crumb.href} />}>{crumb.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
```

Les éléments non terminaux sont masqués sous `md` — c'est le comportement du bloc `sidebar-07`,
qui garde la page courante lisible sur mobile.

- [ ] **Step 3 : Câbler l'en-tête dans `app/(app)/layout.tsx`**

Remplacer le `<header>` (l. 29-36) par :

```tsx
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <Breadcrumbs />
          {canSeeAlerts && (
            <div className="ml-auto">
              <NotificationsBell unreadCount={unreadAlertCount} alerts={recentAlerts} />
            </div>
          )}
        </header>
```

Imports à ajouter : `Separator` depuis `@/components/ui/separator`, `Breadcrumbs` depuis
`@/components/shell/breadcrumbs`.

- [ ] **Step 4 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur ; la suite complète passe (aucun test existant ne touche l'en-tête).

- [ ] **Step 5 : Vérification visuelle**

Run: `bun run dev`, puis parcourir `/dashboard`, `/queue`, `/settings/team`, `/article/<id>`.
Expected: le fil d'Ariane affiche respectivement `Tableau de bord`, `File de revue`,
`Réglages › Équipe`, `Article` ; la cloche de notifications reste à droite ; l'en-tête rétrécit
au repli en mode icône.

- [ ] **Step 6 : Commit**

```bash
git add components/ui/breadcrumb.tsx components/shell/breadcrumbs.tsx "app/(app)/layout.tsx"
git commit -m "feat(shell): breadcrumb header driven by deriveCrumbs"
```

---

## Vérification finale du sous-projet

- [ ] `bun run typecheck` — aucune erreur
- [ ] `bun test` — suite complète verte
- [ ] `bun run build` — build de production réussi (confirme l'absence de collision de route)
- [ ] Revue visuelle aux trois rôles : admin (5 sous-pages), éditeur (2 sous-pages), journaliste
      (pas de Réglages ni d'Exécutions)
