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
                render={
                  <SidebarMenuButton
                    isActive={childActive}
                    tooltip={item.label}
                    className="data-active:text-accent-brand"
                  />
                }
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
                        className="data-active:text-accent-brand"
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
              className="data-active:text-accent-brand"
            >
              <Icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
            {item.badgeKey === "pending" && pendingCount > 0 && (
              <SidebarMenuBadge className="rounded-full bg-accent-brand px-1.5 text-accent-brand-foreground">
                {pendingCount}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
