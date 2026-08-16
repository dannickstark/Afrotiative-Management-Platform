import { z } from "zod";
import { payloadSchema, PLATFORMS, RATIOS, BEAT_KINDS } from "@/lib/video/schema";

// LE registre. Le serveur (app/api/mcp/route.ts) enregistre ce qu'il contient, et l'écran de
// réglages affiche ce qu'il contient. Un outil ajouté à l'un sans l'autre serait un pouvoir accordé
// en silence — c'est pourquoi les deux dérivent d'ici et qu'un test vérifie leur correspondance.
export type ToolKind = "lecture" | "ecriture";
export type ToolSpec = {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: z.ZodRawShape;
};

const uuid = z.string().uuid();

export const TOOL_REGISTRY: readonly ToolSpec[] = [
  {
    name: "list_video_projects",
    kind: "lecture",
    description: "Liste les espaces vidéo existants : titre, statut, plateformes et durée estimée.",
    inputSchema: {},
  },
  {
    name: "get_script",
    kind: "lecture",
    description:
      "Renvoie l'état actuel des beats d'une variante. À appeler avant toute révision : c'est ce qui permet de corriger un script plutôt que de le réécrire entièrement.",
    inputSchema: { variantId: uuid },
  },
  {
    name: "get_video_brief",
    kind: "lecture",
    description:
      "Renvoie le brief d'un projet : le style maison de la rédaction et le contrat JSON attendu en réponse.",
    inputSchema: { projectId: uuid },
  },
  {
    name: "list_articles",
    kind: "lecture",
    description: "Liste les articles approuvés ou publiés, pour partir d'un sujet déjà sourcé.",
    inputSchema: { search: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() },
  },
  {
    name: "get_article",
    kind: "lecture",
    description: "Renvoie le titre, le chapô, le corps et les sources d'un article.",
    inputSchema: { articleId: uuid },
  },
  {
    name: "create_video_project",
    kind: "ecriture",
    description:
      "Crée un espace vidéo et renvoie son brief dans la même réponse. Une variante par défaut est créée avec la plateforme, la durée cible et le cadrage donnés.",
    inputSchema: {
      title: z.string().min(1).max(200),
      subject: z.string().max(2000).optional(),
      platform: z.enum(PLATFORMS),
      targetDurationSec: z.number().int().min(5).max(14400).optional(),
      aspectRatio: z.enum(RATIOS).optional(),
      articleId: uuid.optional(),
    },
  },
  {
    name: "submit_script",
    kind: "ecriture",
    description:
      "Valide un script au format du contrat et prépare son import. Renvoie soit le diff de ce qui changerait, soit le rapport d'erreurs — chemin, message et valeur reçue — pour que tu corriges et resoumettes.",
    inputSchema: { projectId: uuid, variantId: uuid.optional(), payload: payloadSchema },
  },
  {
    name: "apply_script",
    kind: "ecriture",
    description:
      "Applique un import préparé. Sans sélection explicite, applique les ajouts et les modifications, jamais les suppressions ni les conflits — ceux-là doivent être demandés nommément.",
    inputSchema: { journalId: uuid, variantId: uuid, accept: z.array(z.string()).optional() },
  },
  {
    name: "update_beat",
    kind: "ecriture",
    description: "Retouche un beat : texte parlé, note de réalisation, texte à l'écran, transitions.",
    inputSchema: {
      beatId: uuid,
      spokenText: z.string().max(20000).optional(),
      directionNote: z.string().max(1000).nullable().optional(),
      screenText: z.string().max(300).nullable().optional(),
      transitionIn: z.string().max(120).nullable().optional(),
      transitionOut: z.string().max(120).nullable().optional(),
      kind: z.enum(BEAT_KINDS).optional(),
    },
  },
  {
    name: "reorder_beats",
    kind: "ecriture",
    description: "Réordonne les beats d'une variante, sans réécrire le script.",
    inputSchema: { variantId: uuid, order: z.array(uuid).min(1) },
  },
  {
    name: "update_insert",
    kind: "ecriture",
    description:
      "Corrige l'URL d'un insert. Le lien repasse à « non vérifié » : une URL changée à la main n'a jamais été contrôlée.",
    inputSchema: { insertId: uuid, url: z.string().nullable() },
  },
] as const;

export function toolByName(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
