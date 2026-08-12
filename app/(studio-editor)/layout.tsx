import { requireUser } from "@/lib/session";

// Chantier A T1 — coque plein écran de l'éditeur Studio, HORS de la coque admin.
//
// Ce groupe de routes `(studio-editor)` sert un chemin frère de `(app)` : `(app)/studio/page.tsx`
// résout `/studio` (liste, coque admin) tandis que `(studio-editor)/studio/[id]/page.tsx` résout
// `/studio/[id]` (éditeur, plein écran). Les parenthèses n'entrent PAS dans l'URL
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md), et les
// deux chemins étant distincts (`/studio` ≠ `/studio/[id]`), la mise en garde « Conflicting paths »
// du même doc ne s'applique pas : aucune collision. L'éditeur n'hérite donc plus du layout
// `(app)` (SidebarProvider + AppSidebar + header) — il n'a que ce layout-ci comme ancêtre.
//
// Auth préservée : `requireUser()` ici (redirige vers /login si non connecté), en plus du
// requireUser()+requirePermission() que la page conserve — ceinture et bretelles, même garde
// qu'avant le déplacement.
export default async function StudioEditorLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <div className="h-dvh w-dvw overflow-hidden">{children}</div>;
}
