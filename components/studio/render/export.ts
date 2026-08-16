import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";

// components/studio/render/export.ts — nommage et orchestration des exports PNG du mode Rendu réel.
//
// Le nom porte le format ET ses dimensions : un dossier de téléchargements où traînent huit PNG du
// même gabarit doit rester lisible sans les ouvrir.
export function previewFileName(templateId: string, format: FormatKey): string {
  const preset = FORMAT_PRESETS[format];
  return `${templateId}-${format}-${preset.width}x${preset.height}.png`;
}
