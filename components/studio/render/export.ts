import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/export.ts — nommage et orchestration des exports PNG du mode Rendu réel.
//
// Le nom porte le format ET ses dimensions : un dossier de téléchargements où traînent huit PNG du
// même gabarit doit rester lisible sans les ouvrir.
export function previewFileName(templateId: string, format: FormatKey): string {
  const preset = FORMAT_PRESETS[format];
  return `${templateId}-${format}-${preset.width}x${preset.height}.png`;
}

// Amorce de Tâche 6 (chantier D) — signature exacte que render-mode.tsx appelle (bouton « Tout
// télécharger »), corps rempli par la Tâche 7. Garde cette tâche autonome : sans ce stub, l'import
// de render-mode.tsx échouerait à la compilation avant même d'atteindre la Tâche 7.
export async function downloadAllFormats(_input: {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  articleId: string | null;
  onProgress: (done: number, total: number) => void;
}): Promise<void> {
  throw new Error("Non implémenté — voir la Tâche 7.");
}
