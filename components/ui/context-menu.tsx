"use client"

// components/ui/context-menu.tsx — Chantier B, Tâche 7 : la primitive de menu contextuel (clic
// droit), construite sur `@base-ui/react/menu` — LE MÊME primitif que components/ui/dropdown-menu.tsx
// enveloppe déjà (Root/Portal/Positioner/Popup/Item/Separator), dont ce fichier MIROITE
// délibérément la structure et les classes `data-slot`/Tailwind (jamais une seconde feuille de
// style qui pourrait diverger). Deux différences assumées, toutes deux pour le clic droit :
//
//  - PAS de `Trigger` exporté ici : dropdown-menu.tsx en a un parce qu'un menu déroulant s'ouvre
//    depuis UN bouton fixe (son `<DropdownMenuTrigger>`). Un menu contextuel, lui, s'ouvre à la
//    position du CLIC DROIT — un point mobile, jamais un élément DOM fixe — donc l'ancrage se fait
//    par un ANCRE VIRTUEL (`anchor`, ci-dessous), pas par un déclencheur. `canvas.tsx` (voir son
//    en-tête) calcule ce point lui-même, via le VRAI événement `contextmenu` du navigateur, et le
//    fait remonter par une prop-callback — CE fichier n'écoute donc jamais lui-même de clic droit.
//  - `ContextMenuContent` accepte `anchor` (repris de `MenuPositioner.Props`, voir
//    utils/useAnchorPositioning.d.ts) : un `VirtualElement` (`{ getBoundingClientRect }`) plutôt
//    qu'un Element DOM réel — exactement le mécanisme que base-ui documente pour ancrer un popup à
//    un point plutôt qu'à un nœud.
//
// ── LE GARDE-FOU DE L'INCIDENT (voir tests/studio-no-popover-in-canvas.test.ts et le commentaire de
// tête de components/studio/canvas.tsx) ────────────────────────────────────────────────────────────
// Ce fichier importe `@base-ui/react/menu`, donc transitivement Portal/Positioner — EXACTEMENT la
// même famille de composants que le Popover qui a déclenché l'incident (`useIsoLayoutEffect` figé en
// no-op pour tout le process `bun test` sans `--isolate`). `components/studio/canvas.tsx` NE DOIT
// JAMAIS importer ce module, ni directement ni via `canvas-context-menu.tsx` — seul
// `components/studio/editor-shell.tsx` (déjà dans l'arbre base-ui-lourd via dropdown-menu.tsx pour
// le menu de zoom) importe `canvas-context-menu.tsx`, qui seul importe CE fichier. Voir la revue de
// `tests/studio-no-popover-in-canvas.test.ts`, dont `FORBIDDEN_SPECIFIER_SUFFIXES` interdit aussi ce
// spécificateur-ci dans canvas.tsx.
import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuContent({
  anchor,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "anchor" | "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        anchor={anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn("z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95", className )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function ContextMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="context-menu-group" {...props} />
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <MenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/context-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
}
