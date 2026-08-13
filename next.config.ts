import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly: Turbopack otherwise walks up from this
  // repo looking for the nearest lockfile and can pick up an unrelated one
  // from a parent directory (e.g. a stray lockfile in $HOME), which is
  // environment-dependent and not reproducible across machines.
  turbopack: {
    root: __dirname,
  },
  // Keep the pipeline's extraction chain OUT of the server bundle so these CJS
  // packages load via native require() at runtime. jsdom → css-tree does a
  // relative `require('../data/patch.json')` that Turbopack cannot resolve when
  // it tries to bundle the externalized CJS package, which 500s the pipeline
  // server actions (startPipelineRun / reprocessRawItem) and the /api/pipeline/run
  // route at REQUEST time. Listing them here defers resolution to Node's loader.
  //
  // @resvg/resvg-js (Studio V2, Tâche 10): son binaire natif est chargé via un sous-paquet
  // dépendant de la plateforme (@resvg/resvg-js-darwin-arm64, …, choisi par optionalDependencies) —
  // Turbopack ne sait pas le résoudre statiquement. Repéré en vérifiant l'écran réel de l'éditeur
  // dans un navigateur (pas seulement en lisant le code) : previewTemplate (lib/actions/
  // studio-preview-actions.ts) est le PREMIER module "use server" à tirer lib/studio/render.ts dans
  // le graphe d'une Server Action — bun test ne l'a jamais détecté puisque bun exécute lib/studio/
  // render.ts nativement, sans jamais passer par le bundler Turbopack des Server Actions.
  //
  // V3 (Tâche 1) : la revue de branche V1 a renvoyé ici la question de `sharp` et `satori` — aucun
  // code applicatif n'importait lib/studio avant que V3 ajoute previewArticleImage (Server Action).
  // Vérifié contre les versions RÉELLEMENT installées, pas supposé :
  //   - `sharp` (0.35.3) : DÉJÀ dans la liste par défaut de Next lui-même — voir
  //     node_modules/next/dist/lib/server-external-packages.jsonc, ligne "sharp". Aucune entrée à
  //     ajouter ici, elle serait redondante.
  //   - `satori` (0.29.0) : lib/studio/render.ts importe le point d'entrée PAR DÉFAUT du paquet
  //     ("satori" → dist/index.js, cf. l'export "." de node_modules/satori/package.json), pas le
  //     sous-chemin "./wasm". Ce fichier ne charge aucun binaire natif ni aucun yoga.wasm à
  //     l'exécution : le moteur de mise en page Yoga y est porté en JS pur et directement inclus
  //     dans le bundle (vérifié : dist/index.js ne référence la chaîne "yoga.wasm" nulle part).
  //     Rien à externaliser.
  // `@resvg/resvg-js`, lui, reste listé ci-dessous — voir le commentaire dédié juste après.
  serverExternalPackages: ["jsdom", "css-tree", "@mozilla/readability", "isomorphic-dompurify", "@resvg/resvg-js"],
  // Studio V2 Tâche 11 (bibliothèque d'assets) : uploadAsset (lib/actions/asset-actions.ts) reçoit
  // un fichier binaire — jusqu'à 5 Mo pour une image (spec §5) — dans le corps d'une Server Action.
  // Next.js plafonne ce corps à 1 Mo par défaut (node_modules/next/dist/docs/01-app/03-api-reference/
  // 05-config/01-next-config-js/serverActions.md — lu avant d'écrire cette action, voir AGENTS.md) :
  // sans cette limite relevée, TOUTE image de plus d'environ 700 Ko (le corps multipart ajoute des
  // limites de partie/en-têtes en plus des octets du fichier) serait rejetée par le FRAMEWORK avant
  // même d'atteindre uploadAssetCore — un échec qu'aucun test `bun test` ne peut détecter (bun
  // exécute lib/studio/asset-core.ts nativement, jamais à travers le serveur Next.js), seulement une
  // vérification en navigateur réel.
  // Désactive la génération des source maps du build Turbopack. `next build` (Turbopack 16.3.0)
  // plante en phase d'ÉMISSION avec « <Code as GenerateSourceMap>::generate_source_map was
  // canceled » (emit_all_output_assets → emit_assets → SourceMapAsset::content) : la génération des
  // source maps consomme de la mémoire en plus (doc Next : 01-app/02-guides/memory-usage.md
  // « Disable source maps ») et la tâche est ANNULÉE sous la pression mémoire du conteneur de build
  // Railway — déterministe là-bas (RAM plus serrée), seulement intermittent en local. Ce ne sont que
  // des aides au débogage prod : `productionBrowserSourceMaps` est déjà à false par défaut (les
  // source maps navigateur ne sont donc pas en cause) ; on coupe ici les DEUX restantes —
  // `turbopackSourceMaps` (les chunks émis par Turbopack, la tâche qui plante) et `serverSourceMaps`
  // (le bundle serveur). Repéré uniquement sur le build Railway réel, jamais par `bun test` ni `bun
  // run build` local (voir AGENTS.md : lire node_modules/next/dist/docs avant de toucher la config).
  productionBrowserSourceMaps: false,
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
    turbopackSourceMaps: false,
    serverSourceMaps: false,
  },
};

export default nextConfig;
