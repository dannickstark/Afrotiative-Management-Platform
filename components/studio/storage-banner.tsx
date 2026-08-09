import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

// components/studio/storage-banner.tsx — Tâche 15 (spec §8) : « R2 non configuré → le studio
// s'affiche en lecture seule avec une bannière explicite ; téléversement et aperçu désactivés ».
// Étendu ici aux QUATRE surfaces mutantes du studio (téléversement, aperçu, publication,
// génération — cf. brief Tâche 15) : sans stockage, aucune des quatre ne peut produire quoi que ce
// soit de durable, donc le studio entier bascule en lecture seule plutôt que de laisser certaines
// actions fonctionner et d'autres échouer au clic avec une pile brute.
//
// Composant Server (pas de "use client") : aucun état, aucun gestionnaire — chaque page/composant
// qui l'utilise décide lui-même, côté serveur, si getStudioConfig() est null (voir
// app/(app)/studio/page.tsx et consorts), donc AUCUN bundle client ne charge jamais
// lib/studio/config.ts par ce composant.
export function StorageBanner() {
  return (
    <Card className="border-[var(--status-pending)]/40 bg-[var(--status-pending)]/10" data-testid="storage-banner">
      <CardContent className="flex items-start gap-3 py-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--status-pending)]" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-medium">Stockage R2 non configuré</p>
          <p className="text-sm text-muted-foreground">
            Le Studio s&rsquo;affiche en lecture seule : téléversement, aperçu, publication et
            génération sont désactivés tant que les cinq variables <code>R2_*</code> ne sont pas
            renseignées (voir <code>docs/DEPLOYMENT.md</code>).
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
