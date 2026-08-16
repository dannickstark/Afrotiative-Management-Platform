import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import { previewCache, previewCacheKey } from "@/lib/studio/preview-cache";
import { sceneForFormat } from "@/lib/studio/relayout";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/export.ts — nommage et orchestration des exports PNG du mode Rendu réel.
//
// Aucun zip : un fichier unique exigerait une dépendance (jszip) pour un gain qui ne le justifie pas
// à huit fichiers. On enchaîne donc huit téléchargements espacés — un navigateur qui en reçoit huit
// dans la même frame en avale silencieusement une partie. Chrome demande une confirmation unique
// pour les téléchargements multiples : c'est un fait à connaître, pas un motif d'y renoncer.
const DOWNLOAD_SPACING_MS = 150;

// Le nom porte le format ET ses dimensions : un dossier de téléchargements où traînent huit PNG du
// même gabarit doit rester lisible sans les ouvrir.
export function previewFileName(templateId: string, format: FormatKey): string {
  const preset = FORMAT_PRESETS[format];
  return `${templateId}-${format}-${preset.width}x${preset.height}.png`;
}

// Les trois effets de bord de cet orchestrateur — rendre, enregistrer, attendre — sont INJECTABLES.
// C'est ce qui rend la logique d'enchaînement (ordre, espacement, progression, saut d'un échec)
// testable sans DOM ni réseau, dans la voie parallèle. La vraie composition ne les fournit jamais.
export type ExportDeps = {
  render: (format: FormatKey) => Promise<string | null>;
  save: (dataUri: string, fileName: string) => void;
  delay: (ms: number) => Promise<void>;
};

export async function downloadAllFormats(input: {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  articleId: string | null;
  onProgress: (done: number, total: number) => void;
  deps?: ExportDeps;
}): Promise<void> {
  const { templateId, scene, nativeFormat, articleId, onProgress } = input;
  const deps = input.deps ?? defaultDeps(templateId, scene, nativeFormat, articleId);
  const total = FORMAT_KEYS.length;

  for (let i = 0; i < FORMAT_KEYS.length; i++) {
    const format = FORMAT_KEYS[i]!;
    const dataUri = await deps.render(format);
    // Un format qui échoue est SAUTÉ : sept exports valides valent mieux qu'un abandon global à
    // cause du huitième.
    if (dataUri !== null) deps.save(dataUri, previewFileName(templateId, format));
    onProgress(i + 1, total);
    if (i < FORMAT_KEYS.length - 1) await deps.delay(DOWNLOAD_SPACING_MS);
  }
}

function defaultDeps(
  templateId: string, scene: Scene, nativeFormat: FormatKey, articleId: string | null,
): ExportDeps {
  return {
    // Réutilise le mémo : les formats déjà affichés sur la planche ne sont pas re-rendus, seuls les
    // manquants coûtent un aller-retour.
    render: async (format) => {
      const variant = sceneForFormat(scene, format, nativeFormat);
      const key = previewCacheKey(templateId, variant, format, articleId);
      const hit = previewCache.get(key);
      if (hit) return hit.dataUri;
      const res = await previewTemplate({
        templateId, scene: variant, format, articleId: articleId ?? undefined,
      });
      if (!res.ok) return null;
      previewCache.set(key, {
        dataUri: res.dataUri, degraded: res.degraded,
        overflowingLayerIds: res.overflowingLayerIds, lowResLayerIds: res.lowResLayerIds,
      });
      return res.dataUri;
    },
    save: (dataUri, fileName) => {
      const a = document.createElement("a");
      a.href = dataUri;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
