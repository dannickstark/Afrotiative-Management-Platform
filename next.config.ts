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
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
