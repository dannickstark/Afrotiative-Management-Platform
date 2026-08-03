import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "./theme-toggle";
import { ROLE_LABEL } from "@/lib/rbac";
import type { SessionUser } from "@/lib/session";

export function Topbar({ user }: { user: SessionUser }) {
  return (
    <header className="h-14 border-b flex items-center justify-end gap-3 px-4">
      <Badge variant="secondary">{ROLE_LABEL[user.role]}</Badge>
      <span className="text-sm text-muted-foreground">{user.name}</span>
      <ThemeToggle />
    </header>
  );
}
