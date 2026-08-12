"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BrandMark } from "./brand-mark";
import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";
import { visibleNavSections } from "./nav-items";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Role } from "@/lib/auth";
import type { SessionUser } from "@/lib/session";

export function AppSidebar({
  role,
  pendingCount,
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  role: Role;
  pendingCount: number;
  user: SessionUser;
}) {
  const pathname = usePathname();
  const sections = visibleNavSections(role);
  const { state: sidebarState } = useSidebar();

  // État d'ouverture par section, indépendant du repli en icônes du sidebar : ce sont deux replis
  // orthogonaux (une section peut être fermée alors que le sidebar entier est en mode expansé, et
  // inversement). Calculé une seule fois au montage à partir de la page courante — même sémantique
  // que le `defaultOpen` d'un composant non contrôlé, "au rechargement".
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      sections.map((section) => [
        section.id,
        section.id === "redaction" ||
          section.items.some(
            (item) =>
              pathname.startsWith(item.href) || item.items?.some((c) => pathname.startsWith(c.href)),
          ),
      ]),
    ),
  );

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              <BrandMark variant={sidebarState === "collapsed" ? "mark" : "full"} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {sections.map((section) => {
          // En mode icônes, le libellé de groupe est masqué (classe `hidden` plus bas) mais la
          // section doit quand même montrer toutes ses icônes, y compris si l'utilisateur l'avait
          // repliée en mode expansé — le repli de section et le repli du sidebar sont deux états
          // indépendants. On force donc `open` à true tant que le sidebar est en icônes, sans
          // perdre l'état "réel" de la section (repris tel quel au retour en mode expansé).
          //
          // Le contraire (garder le panneau démonté et tenter de le réafficher via CSS quand
          // `hidden` est déjà posé par Base UI) ne marche pas : la feuille de style user-agent
          // masque `[hidden]` avec une priorité qu'aucune règle d'auteur — même `!important` — ne
          // peut emporter ; vérifié empiriquement avant d'adopter cette approche pilotée par état.
          const open = sidebarState === "collapsed" ? true : (openSections[section.id] ?? false);
          return (
            <Collapsible
              key={section.id}
              open={open}
              onOpenChange={(nextOpen) =>
                setOpenSections((prev) => ({ ...prev, [section.id]: nextOpen }))
              }
              className="group/section"
              render={<SidebarGroup />}
            >
              <CollapsibleTrigger
                render={
                  // SidebarGroupLabel rend un <div> par défaut ; CollapsibleTrigger attend un
                  // <button> natif (nativeButton=true) et avertit sinon (perte de la sémantique
                  // clavier/ARIA d'un vrai bouton). On force ici le même choix que
                  // SidebarMenuButton (déjà un <button>) via le propre `render` de
                  // SidebarGroupLabel, sans rien perdre de son style de libellé de groupe.
                  <SidebarGroupLabel
                    render={<button type="button" />}
                    className="w-full cursor-pointer select-none group-data-[collapsible=icon]:hidden"
                  />
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
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
