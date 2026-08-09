# Shell — sections repliables `sidebar-02` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the sidebar navigation into collapsible top-level sections, the pattern shadcn's `sidebar-02` block is built around, so the nav stays usable as the studio/diffusion program adds ~8 entries.

**Architecture:** `nav-items.ts` gains a `NavSection` layer above the existing `NavItem`; `app-sidebar.tsx` renders one `Collapsible` `SidebarGroup` per section; `nav-main.tsx` keeps rendering the items within a section unchanged (it already handles sub-menus and badges). The existing `variant="inset"`, `collapsible="icon"` and `SidebarRail` are **kept** — plain `sidebar-02` drops all three, which would be an unrequested regression.

**Tech Stack:** Next.js 16 App Router · shadcn on Base UI (`base-nova` preset — components use the `render` prop, never `asChild`) · Tailwind v4

## Global Constraints

- **Do not run `npx shadcn@latest add sidebar-02`.** The precedent is documented in
  `docs/superpowers/specs/2026-08-08-afrotiative-shell-sidebar-07-design.md`: the registry block
  writes `app/dashboard/page.tsx` (route collision with `app/(app)/dashboard/page.tsx`, build
  failure), duplicates `components/nav-user.tsx`, and imports registry-internal paths. Every
  primitive it needs — `Collapsible`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupContent` —
  is **already** in `components/ui/`. Port the structure by hand.
- **All UI strings in French.**
- **Role filtering must survive the refactor** at all three levels: section, item, sub-item. A
  section whose items are all filtered out must not render an empty group.
- **Base UI, not Radix:** use `render={<Component />}`, never `asChild`.
- Commit message prefix `feat(shell):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Introduce the section layer in `nav-items.ts`

**Files:**
- Modify: `components/shell/nav-items.ts`
- Test: `tests/nav-sections.test.ts`

**Interfaces:**
- Consumes: existing `NavItem`, `NavChild`, `Role`.
- Produces: `NavSection = { id: string; label: string; roles?: Role[]; items: NavItem[] }`; `NAV_SECTIONS: NavSection[]`; `visibleNavSections(role: Role): NavSection[]`. `NAV_ITEMS` becomes a **derived** flat list (`NAV_SECTIONS.flatMap(s => s.items)`) so `ROUTE_LABELS`, `deriveCrumbs` and `SETTINGS_CHILDREN` keep working untouched. `visibleNavItems` is kept as a thin wrapper over `visibleNavSections` so nothing else breaks.

- [ ] **Step 1: Write the failing test**

Create `tests/nav-sections.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { NAV_SECTIONS, NAV_ITEMS, visibleNavSections, deriveCrumbs, ROUTE_LABELS } from "@/components/shell/nav-items";

describe("NAV_SECTIONS", () => {
  it("expose des sections non vides avec des identifiants uniques", () => {
    expect(NAV_SECTIONS.length).toBeGreaterThan(1);
    const ids = NAV_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of NAV_SECTIONS) expect(s.items.length).toBeGreaterThan(0);
  });

  it("NAV_ITEMS reste l'aplatissement des sections", () => {
    expect(NAV_ITEMS).toEqual(NAV_SECTIONS.flatMap((s) => s.items));
  });

  it("chaque href de section a un libellé de fil d'Ariane", () => {
    for (const item of NAV_ITEMS) expect(ROUTE_LABELS[item.href]).toBeTruthy();
  });
});

describe("visibleNavSections", () => {
  it("un journaliste ne voit ni Exécutions ni Réglages", () => {
    const hrefs = visibleNavSections("journalist").flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/queue");
    expect(hrefs).not.toContain("/runs");
    expect(hrefs).not.toContain("/settings");
  });

  it("un éditeur voit Réglages mais seulement ses sous-pages autorisées", () => {
    const settings = visibleNavSections("editor").flatMap((s) => s.items).find((i) => i.href === "/settings");
    expect(settings).toBeDefined();
    const childHrefs = settings!.items!.map((c) => c.href);
    expect(childHrefs).toContain("/settings/feeds");
    expect(childHrefs).not.toContain("/settings/team");
  });

  it("un admin voit tout", () => {
    const hrefs = visibleNavSections("admin").flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toEqual(expect.arrayContaining(["/dashboard", "/queue", "/runs", "/settings"]));
  });

  it("ne renvoie jamais une section vide", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      for (const s of visibleNavSections(role)) expect(s.items.length).toBeGreaterThan(0);
    }
  });

  it("ne mute pas NAV_SECTIONS", () => {
    const before = JSON.stringify(NAV_SECTIONS.map((s) => ({ id: s.id, n: s.items.length })));
    visibleNavSections("journalist");
    expect(JSON.stringify(NAV_SECTIONS.map((s) => ({ id: s.id, n: s.items.length })))).toBe(before);
  });
});

describe("deriveCrumbs", () => {
  it("reste inchangé après le passage aux sections", () => {
    expect(deriveCrumbs("/settings/feeds")).toEqual([
      { href: "/settings", label: "Réglages" },
      { href: "/settings/feeds", label: "Sources RSS" },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/nav-sections.test.ts`
Expected: FAIL — `NAV_SECTIONS` is not exported.

- [ ] **Step 3: Restructure `components/shell/nav-items.ts`**

Keep `NavChild`, `NavItem`, `SETTINGS_CHILDREN`, `Crumb`, `deriveCrumbs` exactly as they are. Replace the `NAV_ITEMS` declaration and `visibleNavItems` with:

```ts
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
      { href: "/calendar", label: "Calendrier", icon: Calendar },
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
// Retourne toujours de nouveaux objets — NAV_SECTIONS n'est jamais muté.
export function visibleNavSections(role: Role): NavSection[] {
  return NAV_SECTIONS
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

// Conservé pour les appelants qui veulent la liste plate visible (aucun aujourd'hui hors tests,
// mais l'API publique de ce module ne doit pas casser sans raison).
export function visibleNavItems(role: Role): NavItem[] {
  return visibleNavSections(role).flatMap((s) => s.items);
}
```

`ROUTE_LABELS` sits **after** this block and is unchanged — it already derives from `NAV_ITEMS` and `SETTINGS_CHILDREN`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/nav-sections.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test
git add components/shell/nav-items.ts tests/nav-sections.test.ts
git commit -m "feat(shell): sections de navigation de premier niveau"
```

---

### Task 2: Render collapsible sections in the sidebar

**Files:**
- Modify: `components/shell/app-sidebar.tsx`
- Test: manual, in the browser

**Interfaces:**
- Consumes: `visibleNavSections`, `NavSection`.
- Produces: no new exports. `AppSidebar`'s props are unchanged (`role`, `pendingCount`, `user`).

- [ ] **Step 1: Confirm the primitives exist**

```bash
grep -n "SidebarGroupLabel\|SidebarGroupContent\|SidebarGroup\b" components/ui/sidebar.tsx | head
grep -n "export" components/ui/collapsible.tsx
```

Expected: `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupContent` all exported from
`components/ui/sidebar.tsx`; `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` from
`components/ui/collapsible.tsx`. If `SidebarGroupLabel` is missing, stop and report — do not run
the shadcn CLI.

- [ ] **Step 2: Rewrite the `SidebarContent` block of `components/shell/app-sidebar.tsx`**

Replace the imports of `visibleNavItems` with `visibleNavSections`, add `ChevronRight` from
`lucide-react` and the `Collapsible*` + `SidebarGroupLabel` imports, then replace the single
`<SidebarGroup>` with:

```tsx
      <SidebarContent>
        {sections.map((section) => {
          // Une section est ouverte d'office si elle contient la page courante ; sinon elle suit
          // son état par défaut. Le repli en icônes (collapsible="icon") masque les libellés de
          // groupe : dans cet état les sections rendent simplement leurs icônes à la suite.
          const hasActive = section.items.some(
            (item) => pathname.startsWith(item.href) || item.items?.some((c) => pathname.startsWith(c.href)),
          );
          return (
            <Collapsible
              key={section.id}
              defaultOpen={hasActive || section.id === "redaction"}
              className="group/section"
              render={<SidebarGroup />}
            >
              <CollapsibleTrigger
                render={
                  <SidebarGroupLabel className="w-full cursor-pointer select-none group-data-[collapsible=icon]/sidebar-wrapper:hidden" />
                }
              >
                {section.label}
                <ChevronRight className="ml-auto size-3.5 transition-transform duration-200 group-data-open/section:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <NavMain items={section.items} pendingCount={pendingCount} />
                </SidebarGroupContent>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </SidebarContent>
```

Above the `return`, replace `const items = visibleNavItems(role);` with:

```tsx
  const pathname = usePathname();
  const sections = visibleNavSections(role);
```

and add `import { usePathname } from "next/navigation";`. The component is already `"use client"`.

`nav-main.tsx` needs **no change** — it already renders a `SidebarMenu` from a `NavItem[]`,
including sub-menus and the pending badge.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Verify in the browser**

```bash
bun run dev
```

Check, logged in as admin at `http://localhost:3000/dashboard`:
1. Three section headers — Rédaction, Supervision, Réglages — each collapsible by clicking the header.
2. The chevron rotates when a section opens.
3. Navigating to `/settings/feeds` leaves the Réglages section **open** on reload.
4. The pending badge still shows on *File de revue*.
5. Toggling the sidebar to icon mode (the trigger in the header) hides section labels and still shows every icon; the rail still resizes.
6. Log in as `journaliste@afrotiative.com` — only Rédaction is present, no empty groups.

- [ ] **Step 5: Commit**

```bash
git add components/shell/app-sidebar.tsx
git commit -m "feat(shell): sections repliables dans la barre latérale"
```

---

### Task 3: Reconcile the uncommitted layout changes and verify

**Files:**
- Modify: `app/layout.tsx`, `app/(app)/layout.tsx`

**Context:** Both files carry uncommitted edits that predate this work:
`app/layout.tsx` added `overflow-hidden group/body overscroll-none [--footer-height:--spacing(14)] xl:[--footer-height:--spacing(24)] theme-default` to `<body>`, and `app/(app)/layout.tsx` **removed**
`overflow-auto` from `<main>`. Together those leave no scroll container — long pages such as
`/queue` cannot scroll. That has to be resolved before this branch is mergeable.

- [ ] **Step 1: Reproduce the problem**

With `bun run dev` running, open `/queue` with enough articles to overflow the viewport and confirm
the page does not scroll.

- [ ] **Step 2: Restore a scroll container**

In `app/(app)/layout.tsx`, restore the overflow on `<main>`:

```tsx
        <main className="flex-1 overflow-auto p-6">{children}</main>
```

In `app/layout.tsx`, drop `overflow-hidden` and `overscroll-none` from `<body>` — with the shell's
`SidebarInset` owning layout, they only suppress scrolling. Keep `group/body`, the
`--footer-height` custom properties and `theme-default`, which are inert and may be intended for
later work:

```tsx
      <body className="min-h-full flex flex-col font-sans antialiased group/body [--footer-height:--spacing(14)] xl:[--footer-height:--spacing(24)] theme-default">
```

- [ ] **Step 3: Verify scrolling is back**

Reload `/queue`: the list scrolls, the header stays put, the sidebar does not scroll with the content.

- [ ] **Step 4: Full verification**

```bash
bun run typecheck && bun test && bun run build
```

Expected: typecheck clean, all tests pass, production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx "app/(app)/layout.tsx"
git commit -m "fix(shell): rétablir le conteneur de défilement du contenu"
```

---

## Self-Review

**Coverage:** the request was "migrate to sidebar-02". Task 1 adds the section data model, Task 2
renders the collapsible groups that *are* sidebar-02's defining feature, Task 3 clears the
pre-existing layout breakage that would otherwise be blamed on this change.

**Deliberate deviation from plain sidebar-02, stated for the reviewer:** `variant="inset"`,
`collapsible="icon"`, `SidebarRail`, the `NavUser` footer and the brand header are all **kept**.
The stock block uses the default variant with offcanvas collapse and adds a version switcher and a
search form that have no counterpart in this product. Adopting it literally would have removed
working features.

**Risk:** `SidebarGroupLabel` renders a `div` sized for a static label; using it as a
`CollapsibleTrigger` may need `cursor-pointer` and a hover style to read as interactive — Task 2
Step 2 includes both. If the Base UI `Collapsible` refuses a `SidebarGroup` via `render`, fall back
to wrapping: `<SidebarGroup><Collapsible …>…</Collapsible></SidebarGroup>`.
