"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NavUser } from "./nav-user";
import { visibleNavItems } from "./nav-items";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
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
  const items = visibleNavItems(role);

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-[var(--accent-brand)] text-sm font-semibold text-[var(--accent-brand-foreground)]">
                A
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Afrotiative</span>
                <span className="truncate text-xs text-sidebar-foreground/70">Back-office</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const active = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton isActive={active} tooltip={item.label} render={<Link href={item.href} />}>
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
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
