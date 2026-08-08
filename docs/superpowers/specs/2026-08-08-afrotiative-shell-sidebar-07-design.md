# Shell — migration vers la structure `sidebar-07`

**Date :** 2026-08-08
**Sous-projet :** A (indépendant — aucun prérequis)
**Statut :** validé

## Objectif

Adopter la structure du bloc shadcn `sidebar-07` : sous-menus repliables, fil d'Ariane dans
l'en-tête, rail de redimensionnement. La navigation passe d'une liste plate à une hiérarchie où
**Réglages** devient un groupe repliable exposant ses cinq sous-pages.

## Point de départ

`components/shell/app-sidebar.tsx:38` déclare déjà `<Sidebar variant="inset" collapsible="icon">` —
c'est le cœur de `sidebar-07`. Il manque : les sous-menus, le fil d'Ariane, le rail.

## Pourquoi pas `npx shadcn@latest add sidebar-07`

La commande est **écartée**. Le bloc `base-nova` (vérifié sur le registre) :

1. cible `app/dashboard/page.tsx` — collision de route avec `app/(app)/dashboard/page.tsx`
   existant : deux fichiers résolvent vers `/dashboard`, le build échoue ;
2. écrit `components/nav-user.tsx`, doublon de `components/shell/nav-user.tsx` ;
3. importe `@/app/(create)/components/icon-placeholder`, chemin interne au registre ;
4. embarque un `TeamSwitcher` sans objet — il n'y a qu'une marque.

On installe donc uniquement les primitives manquantes et on porte la structure à la main :

```bash
npx shadcn@latest add breadcrumb
```

`components.json` fixe `"style": "base-nova"`, la variante Base UI est donc récupérée
automatiquement — cohérente avec le reste de `components/ui/`, qui utilise déjà la prop `render`
plutôt que `asChild`.

`components/ui/sidebar.tsx` exporte déjà tout le reste de ce dont on a besoin : `SidebarRail`
(l. 280), `SidebarGroupLabel` (l. 393), `SidebarMenuSub` / `SidebarMenuSubItem` /
`SidebarMenuSubButton` (l. 638-666). Aucune modification de primitive.

## Architecture

### `components/shell/nav-items.ts` — source unique de la navigation

`NavItem` gagne un champ optionnel `items`. Les cinq sous-pages de Réglages sont reprises
telles quelles de `components/settings/settings-nav.tsx:10-16`, **avec leurs rôles respectifs** —
c'est le point subtil : `Équipe`, `Intégrations` et `Pipeline` sont `admin` seul, alors que le
parent `Réglages` est `["admin", "editor"]`.

```ts
export type NavChild = { href: string; label: string; roles?: Role[] };
export type NavItem = {
  href: string; label: string; icon: typeof Inbox;
  roles?: Role[]; badgeKey?: "pending"; items?: NavChild[];
};
```

Le fichier exporte en plus `ROUTE_LABELS: Record<string, string>` — l'aplatissement
`href → label` de `NAV_ITEMS` et de leurs enfants, consommé par le fil d'Ariane. Une seule
définition, donc pas de dérive entre le libellé du menu et celui du fil d'Ariane.

`settings-nav.tsx` reste en place (navigation horizontale interne aux pages de réglages) mais
importe désormais sa liste depuis `nav-items.ts` au lieu de la redéclarer.

### `components/shell/nav-main.tsx` — nouveau

Rend la liste. Deux cas :

- **sans `items`** : exactement le rendu actuel (`SidebarMenuButton` + badge `pendingCount`) ;
- **avec `items`** : `Collapsible` en `render={<SidebarMenuItem />}`, déclencheur
  `CollapsibleTrigger render={<SidebarMenuButton tooltip={…} />}` avec chevron pivotant
  (`group-data-open/collapsible:rotate-90`), contenu en `SidebarMenuSub`.

Le parent s'ouvre par défaut quand une de ses routes enfants est active
(`defaultOpen={item.items.some((c) => pathname.startsWith(c.href))}`).

Le filtrage par rôle s'applique **aux deux niveaux** : les enfants sont filtrés d'abord ; un
parent dont tous les enfants sont refusés n'est pas rendu du tout.

### `components/shell/breadcrumbs.tsx` — nouveau

Client component. Dérive la piste de `usePathname()` contre `ROUTE_LABELS`, du segment le plus
long au plus court : `/settings/team` → `Réglages › Équipe`, `/queue` → `File de revue`. Le dernier
élément est un `BreadcrumbPage`, les précédents des `BreadcrumbLink`. Une route absente de la table
(`/article/[id]`) rend un libellé statique déclaré dans `ROUTE_LABELS` sous sa forme de préfixe
(`/article` → `Article`).

### `app/(app)/layout.tsx` — en-tête

```
SidebarTrigger · Separator (vertical) · Breadcrumb ······ NotificationsBell
```

La hauteur passe de `h-14` à `h-16` avec réduction sur repli icône :
`group-has-data-[collapsible=icon]/sidebar-wrapper:h-12`. `NotificationsBell` conserve son
`ml-auto` et son gardiennage `canSeeAlerts` inchangé.

### `components/shell/app-sidebar.tsx`

Délègue le corps à `<NavMain items={items} pendingCount={pendingCount} />` et ajoute
`<SidebarRail />` avant la fermeture de `<Sidebar>`. L'en-tête de marque Afrotiative et le
`SidebarFooter`/`NavUser` sont inchangés.

## Fichiers

| Fichier | Action |
|---|---|
| `components/ui/breadcrumb.tsx` | ajouté par le CLI shadcn |
| `components/shell/nav-items.ts` | `items` + `ROUTE_LABELS` |
| `components/shell/nav-main.tsx` | nouveau |
| `components/shell/breadcrumbs.tsx` | nouveau |
| `components/shell/app-sidebar.tsx` | délègue à `NavMain`, ajoute `SidebarRail` |
| `components/settings/settings-nav.tsx` | importe sa liste depuis `nav-items.ts` |
| `app/(app)/layout.tsx` | en-tête fil d'Ariane |

## Tests

`tests/shell-nav.test.ts` — pur, sans DOM ni DB :

- filtrage par rôle à deux niveaux : un `journalist` ne voit ni `Réglages` ni aucun de ses enfants ;
  un `editor` voit `Réglages` avec exactement `Sources RSS` et `Catégories & Tags` ;
  un `admin` voit les cinq ;
- un parent dont tous les enfants sont refusés n'est pas rendu ;
- `ROUTE_LABELS` couvre toute route de `NAV_ITEMS` et de ses enfants ;
- la dérivation du fil d'Ariane (fonction pure `deriveCrumbs(pathname)` exportée par
  `breadcrumbs.tsx`) : `/settings/team` → 2 éléments, `/queue` → 1, route inconnue → repli sur le
  préfixe.

## Hors périmètre

`TeamSwitcher` (une seule marque), `NavProjects` (aucun équivalent métier), refonte visuelle des
pages elles-mêmes.
