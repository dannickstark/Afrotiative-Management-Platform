import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FORMAT_PRESETS, TEMPLATE_CONTEXTS, type TemplateContext } from "@/lib/studio";
import type { TemplateRow } from "@/lib/queries/studio";

// Purement présentationnel, sans état ni gestionnaire — Server Component par défaut (aucun
// "use client" ici) même si Table/Badge en portent un dans leur propre module : un Server Component
// peut rendre un Client Component sans devenir lui-même client (voir la doc Next.js sur les Server
// et Client Components). Les actions (créer/dupliquer/archiver, Tâche 2 du plan) transformeront ce
// fichier en Client Component quand elles y ajouteront de l'interactivité — pas avant.
const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

const CHANNEL_LABEL: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  x: "X",
  tiktok: "TikTok",
};

// Portée affichée : canal, catégorie, les deux, ou « Défaut » si ni l'un ni l'autre — c'est
// littéralement le gabarit appliqué à tout le contexte, sans restriction. Un canal inconnu de
// CHANNEL_LABEL (ex. une valeur "test-*" injectée par une suite de tests) s'affiche tel quel :
// render_templates.channel est du texte libre en base (db/schema.ts), pas un enum.
function scopeLabel(row: TemplateRow): string {
  const channel = row.channel ? (CHANNEL_LABEL[row.channel] ?? row.channel) : null;
  const parts = [channel, row.categoryName].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(" · ") : "Défaut";
}

// État affiché : archivé prime sur tout, sinon brouillon (jamais publié) / publié à jour /
// modifications non publiées — exactement le triplet du §1 du design ("brouillon / publié /
// modifications non publiées"), l'archivage s'y ajoutant comme un quatrième état orthogonal.
function StateBadge({ row }: { row: TemplateRow }) {
  if (row.archived) return <Badge variant="outline">Archivé</Badge>;
  if (row.publishedVersion === null) return <Badge variant="secondary">Brouillon</Badge>;
  if (row.hasUnpublishedChanges) return <Badge variant="secondary">Modifications non publiées</Badge>;
  return <Badge>Publié</Badge>;
}

function formatLabel(row: TemplateRow): string {
  const preset = (FORMAT_PRESETS as Record<string, { label: string }>)[row.format];
  const label = preset?.label ?? row.format;
  return `${label} (${row.width}×${row.height})`;
}

const dateFormatter = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

export function TemplatesTable({ templates }: { templates: TemplateRow[] }) {
  const groups = TEMPLATE_CONTEXTS
    .map((context) => ({ context, rows: templates.filter((t) => t.context === context) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Gabarits</h1>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Aucun gabarit pour l&rsquo;instant.
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.context}>
            <CardHeader>
              <CardTitle>{CONTEXT_LABEL[group.context]}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <div className="mx-(--card-spacing) rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nom</TableHead>
                      <TableHead>Portée</TableHead>
                      <TableHead>Format</TableHead>
                      <TableHead>État</TableHead>
                      <TableHead className="text-right">Modifié</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="text-muted-foreground">{scopeLabel(row)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatLabel(row)}</TableCell>
                        <TableCell>
                          <StateBadge row={row} />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {dateFormatter.format(row.updatedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
