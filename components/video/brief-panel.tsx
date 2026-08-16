"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

// Task 11 — panneau Brief : le texte que l'utilisateur colle dans un chat Claude, puis dont il
// rapporte la réponse JSON dans l'onglet Importer (Task 12). Client Component pour
// `navigator.clipboard.writeText`, indisponible côté serveur.
export function BriefPanel({ brief, unknownVars }: { brief: string; unknownVars: string[] }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(brief);
    setCopied(true);
    toast.success("Brief copié.");
  }

  return (
    <div className="space-y-4">
      {/* Point de conception : une variable de modèle inconnue est AFFICHÉE, jamais avalée en
          silence — c'est tout l'intérêt de l'avoir laissée telle quelle dans le texte
          (voir lib/video/brief.ts, renderTemplate). */}
      {unknownVars.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Variable inconnue dans le modèle de brief</p>
            <p>
              Le modèle référence {unknownVars.length > 1 ? "des variables absentes" : "une variable absente"} du
              contrat : <span className="font-mono">{unknownVars.join(", ")}</span>. Corrigez le modèle dans les
              réglages du module vidéo.
            </p>
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Collez ce brief dans un chat Claude, puis rapportez sa réponse JSON dans l&apos;onglet Importer.
      </p>

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={handleCopy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          Copier le brief
        </Button>
      </div>

      <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
        {brief}
      </pre>
    </div>
  );
}
