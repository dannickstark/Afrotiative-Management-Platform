import { z } from "zod";

// LA source unique du module vidéo. Quatre choses en sont dérivées et ne sont jamais réécrites à la
// main : le validateur d'import (lib/video/import.ts), le bloc JSON-Schema du brief
// (lib/video/brief.ts), l'exemple montré au chat, et — au SP1 bis — les schémas d'entrée des outils
// MCP. Écrites séparément, ces quatre-là divergent, et la divergence se manifeste en import
// inexplicablement refusé.
export const SCHEMA_VERSION = "1.0";

export const BEAT_KINDS = [
  "narration", "question", "reponse", "insert", "broll",
  "transition", "texte_ecran", "son", "note",
] as const;
export const PLATFORMS = ["youtube_long", "youtube_short", "tiktok", "reel", "interview"] as const;
export const RATIOS = ["16:9", "9:16", "1:1"] as const;

export const TC_RE = /^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;
export const INSERT_KINDS = ["image", "video", "extrait", "graphique", "fichier"] as const;
export type InsertKind = (typeof INSERT_KINDS)[number];
export const BEAT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// Spec §2.2 : « `url` : http/https uniquement ». `z.string().url()` nu laisse passer
// `javascript:alert(1)`, `data:text/html,…` et `ftp://…` — c'est exactement la raison pour laquelle
// le chemin d'édition manuelle (lib/validation.ts#updateInsertSchema) ajoute une contrainte de
// schéma. L'import est le chemin par lequel les URLs arrivent RÉELLEMENT dans le produit, il ne
// pouvait pas rester le seul non protégé.
//
// `z.url({ protocol })` et non un `.refine()` : c'est un contrôle natif de Zod, donc
// `z.toJSONSchema()` (contractJsonSchema, envoyé au chat) ne le fait pas disparaître différemment
// d'un raffinement — la règle reste par ailleurs énoncée en toutes lettres dans le brief
// (lib/video/brief.ts#contractBlock), comme toutes celles que JSON-Schema n'exprime pas.
const HTTP_PROTOCOL = /^https?$/;
const httpUrl = (max: number) => z.url({ protocol: HTTP_PROTOCOL }).max(max);

// `.nullish()` partout sur l'optionnel : un modèle produit indifféremment `null` et l'absence de
// clé, et refuser l'un des deux ferait échouer des payloads sémantiquement identiques.
export const insertPayloadSchema = z.strictObject({
  type: z.enum(["image", "video", "extrait", "graphique", "fichier"]),
  url: httpUrl(2048).nullish(),
  tc_in: z.string().regex(TC_RE).nullish(),
  tc_out: z.string().regex(TC_RE).nullish(),
  duree_affichage_sec: z.number().int().min(1).max(600).nullish(),
  credit: z.string().max(200).nullish(),   // optionnel (décision 7)
  droits: z.string().max(500).nullish(),   // optionnel (décision 7)
});

export const beatPayloadSchema = z.strictObject({
  id: z.string().regex(BEAT_ID_RE),
  type: z.enum(BEAT_KINDS),
  texte: z.string().max(5000).nullish(),
  note_realisation: z.string().max(1000).nullish(),
  texte_ecran: z.string().max(300).nullish(),
  transition_entree: z.string().max(120).nullish(),
  transition_sortie: z.string().max(120).nullish(),
  sources: z.array(httpUrl(2048)).max(20).nullish(),
  inserts: z.array(insertPayloadSchema).max(20).nullish(),
});

export const variantPayloadSchema = z.strictObject({
  plateforme: z.enum(PLATFORMS),
  duree_cible_sec: z.number().int().min(5).max(14400).nullish(),
  ratio: z.enum(RATIOS).nullish(),
  beats: z.array(beatPayloadSchema).min(1).max(500),
});

export const payloadSchema = z.strictObject({
  schema_version: z.string().min(1),
  projet: z.strictObject({
    titre: z.string().min(1).max(200),
    sujet: z.string().max(2000).nullish(),
    angle: z.string().max(2000).nullish(),
  }),
  variantes: z.array(variantPayloadSchema).min(1).max(10),
});

export type InsertPayload = z.infer<typeof insertPayloadSchema>;
export type BeatPayload = z.infer<typeof beatPayloadSchema>;
export type VariantPayload = z.infer<typeof variantPayloadSchema>;
export type Payload = z.infer<typeof payloadSchema>;

// Zod 4.4.3 : z.toJSONSchema est natif, aucune dépendance supplémentaire. Le schéma ne contient
// volontairement AUCUN raffinement (les règles inter-champs sont dans lib/video/import.ts), car
// toJSONSchema les ignorerait — elles disparaîtraient silencieusement du contrat envoyé au chat.
export function contractJsonSchema(): object {
  return z.toJSONSchema(payloadSchema);
}

export const EXAMPLE_PAYLOAD: Payload = {
  schema_version: SCHEMA_VERSION,
  projet: {
    titre: "La success story de Babadampulu",
    sujet: "Comment une PME agroalimentaire ivoirienne est devenue exportatrice régionale",
    angle: "Le tournant de 2019 et ce qu'il coûte à répliquer",
  },
  variantes: [
    {
      plateforme: "youtube_long",
      duree_cible_sec: 720,
      ratio: "16:9",
      beats: [
        {
          id: "b-01-accroche",
          type: "narration",
          texte: "En 2019, cette PME vendait dans deux marchés d'Abidjan. Aujourd'hui elle exporte dans six pays.",
          note_realisation: "Plan serré, regard caméra. Débit rapide.",
          texte_ecran: "Abidjan, 2019",
          transition_entree: null,
          transition_sortie: "cut sec",
          sources: ["https://www.agenceecofin.com/exemple-article"],
          inserts: [
            {
              type: "video",
              url: "https://www.youtube.com/watch?v=exemple",
              tc_in: "00:03:12",
              tc_out: "00:03:19",
              duree_affichage_sec: 7,
              credit: "Bloomberg",
              droits: "extrait court, citation",
            },
          ],
        },
        {
          id: "b-02-contexte",
          type: "narration",
          texte: "Pour comprendre ce basculement, il faut regarder trois chiffres.",
          note_realisation: "Plan large.",
          texte_ecran: null,
          transition_entree: null,
          transition_sortie: null,
          sources: [],
          inserts: [
            {
              type: "graphique",
              url: null,
              tc_in: null,
              tc_out: null,
              duree_affichage_sec: 5,
              credit: null,
              droits: null,
            },
          ],
        },
        // Un beat SANS aucun insert. Il manquait à l'exemple, et c'est ce point aveugle qui a laissé
        // passer l'asymétrie de forme des inserts (round de correction final, I1) : tant que tous
        // les beats de l'exemple portaient un insert, aucun test de bout en bout ne comparait la
        // liste vide produite par le payload à celle produite par les colonnes.
        {
          id: "b-03-cloture",
          type: "narration",
          texte: "Ce qu'il faut retenir, et ce que ça coûterait de le répliquer ailleurs.",
          note_realisation: "Retour plan serré, débit ralenti.",
          texte_ecran: null,
          transition_entree: null,
          transition_sortie: null,
          sources: [],
          inserts: [],
        },
      ],
    },
  ],
};
