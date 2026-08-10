import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getTemplateById, listArticlesForPreview, listTemplates, listCategoriesForManual } from "@/lib/queries/studio";
import { listAssets } from "@/lib/queries/assets";
import { getTaxonomy } from "@/lib/queries/settings";
import { getStudioConfig } from "@/lib/studio/config";
import { brandLogoUrl } from "@/lib/studio/bindings";
import { EditorShell } from "@/components/studio/editor-shell";

// Même forme canonique que app/(app)/article/[id]/page.tsx : Server Component, `params` est une
// Promise (breaking change de cette version de Next.js — voir AGENTS.md), requireUser() +
// requirePermission() avant toute requête, puis rendu d'un Client Component recevant les données
// déjà chargées.
export default async function StudioTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  requirePermission(user.role, "template", "read");

  const template = await getTemplateById(id);
  if (!template) notFound();

  // Le sélecteur d'article de l'aperçu (Tâche 10, spec §4) n'a de sens que pour les contextes
  // rendus AVANT toute saisie manuelle — article_image / social_post. Les contextes à saisie
  // manuelle (quote_card, newsletter_header, recap_card) n'ont pas d'article associé ; épargner la
  // requête pour eux.
  const previewArticles =
    template.context === "article_image" || template.context === "social_post"
      ? await listArticlesForPreview()
      : [];

  // Tâche 13 (Lot 3) : la bibliothèque d'assets, chargée UNE FOIS ici (Server Component) et
  // redescendue en prop jusqu'aux sélecteurs de components/studio/property-panel.tsx — même schéma
  // que previewArticles ci-dessus, jamais rechargée depuis un composant client.
  //
  // Tâche 2 (U1, spec §3) : trois requêtes SUPPLÉMENTAIRES pour les panneaux Modèles/Marque —
  // indépendantes les unes des autres ET de `previewArticles` (qui dépend de template.context, donc
  // reste séquentielle ci-dessus), lancées ici EN PARALLÈLE (guide Next.js « Parallel data
  // fetching », node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md) plutôt
  // qu'attendues une par une. `listTemplates`/`listCategoriesForManual` sont les MÊMES requêtes que
  // app/(app)/studio/page.tsx (aucune nouvelle requête écrite pour ce panneau) ; `getTaxonomy` (déjà
  // utilisée par app/(app)/settings/taxonomy/page.tsx) fournit `wpCategories.color`, qu'aucune
  // requête studio existante ne projette. Toutes trois sont des LECTURES ; aucune ne demande de
  // permission au-delà du template:read déjà vérifié plus haut (même statut que
  // listCategoriesForManual, déjà appelée sans vérification supplémentaire ailleurs dans le studio).
  const [assets, templates, categories, taxonomy] = await Promise.all([
    listAssets(),
    listTemplates(),
    listCategoriesForManual(),
    getTaxonomy(),
  ]);
  // Tâche 15 (spec §8) : bannière de lecture seule + aperçu/publication désactivés quand le
  // stockage R2 n'est pas configuré, plutôt que d'échouer au clic avec une pile brute.
  const storageConfigured = !!getStudioConfig();

  return (
    <EditorShell
      key={template.id}
      template={template}
      initialScene={template.scene}
      publishedScene={template.publishedScene}
      versions={template.versions}
      previewArticles={previewArticles}
      assets={assets}
      storageConfigured={storageConfigured}
      templates={templates}
      categories={categories}
      brandLogoUrl={brandLogoUrl()}
      categoryColors={taxonomy.categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
    />
  );
}
