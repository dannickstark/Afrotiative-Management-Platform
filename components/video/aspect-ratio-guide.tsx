// components/video/aspect-ratio-guide.tsx — Task 3 (SP6, dernier sous-projet du module Vidéo) :
// un petit schéma SVG de cadrage selon le ratio d'une variante, avec une zone sûre esquissée en
// pointillés. Server-safe (pas de "use client") — utilisé aussi bien dans l'onglet Écriture (page
// serveur) que dans PrompteurMode (composant client) : un composant purement statique se prête aux
// deux.

// Dimensions du schéma (modeste, hauteur ~80px comme demandé) par ratio connu. Un ratio inconnu
// n'a pas d'entrée ici — voir le rendu de secours plus bas, qui affiche le libellé brut sans
// planter.
const SHAPES: Record<string, { width: number; height: number; note: string }> = {
  "16:9": { width: 142, height: 80, note: "Format paysage — cadrez large, les bords latéraux peuvent être coupés à l'affichage." },
  "9:16": { width: 45, height: 80, note: "Gardez l'action dans la zone centrale verticale." },
  "1:1": { width: 80, height: 80, note: "Format carré — centrez le sujet, les coins sont les premiers coupés." },
};

const SAFE_MARGIN_RATIO = 0.12;

export function AspectRatioGuide({ ratio }: { ratio: string }) {
  const shape = SHAPES[ratio];

  if (!shape) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Guide de cadrage indisponible pour le ratio {ratio}.</span>
      </div>
    );
  }

  const { width, height, note } = shape;
  const marginX = width * SAFE_MARGIN_RATIO;
  const marginY = height * SAFE_MARGIN_RATIO;

  return (
    <div className="flex items-center gap-3">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Schéma de cadrage ${ratio} avec zone sûre`}
      >
        <rect
          x={0.5} y={0.5} width={width - 1} height={height - 1}
          fill="none" stroke="currentColor" strokeWidth={1}
          className="text-border"
        />
        <rect
          x={marginX} y={marginY} width={width - marginX * 2} height={height - marginY * 2}
          fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="4 3"
          className="text-muted-foreground"
        />
        <text
          x={width / 2} y={height / 2}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={11} fill="currentColor"
          className="text-foreground"
        >
          {ratio}
        </text>
      </svg>
      <p className="max-w-xs text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
