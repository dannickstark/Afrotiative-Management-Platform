import { z } from "zod";
import { payloadSchema, PLATFORMS, RATIOS } from "@/lib/video/schema";

// LE registre. Le serveur (app/api/mcp/route.ts) enregistre ce qu'il contient, et l'écran de
// réglages affiche ce qu'il contient. Un outil ajouté à l'un sans l'autre serait un pouvoir accordé
// en silence — c'est pourquoi les deux dérivent d'ici et qu'un test vérifie leur correspondance.
export type ToolKind = "lecture" | "ecriture";

// Le DOMAINE de données auquel un outil touche — l'axe « articles » de la portée d'un jeton
// (lib/mcp/scope.ts) se lit ici, et nulle part ailleurs. OBLIGATOIRE : un outil ajouté sans domaine
// ne compile pas, exactement comme un outil ajouté au dispatch sans entrée de registre est attrapé
// par tests/mcp-registry.test.ts. Un pouvoir accordé en silence est le défaut que ce registre
// existe pour rendre impossible.
export type ToolDomain = "video" | "article";

export type ToolSpec = {
  name: string;
  kind: ToolKind;
  domain: ToolDomain;
  description: string;
  inputSchema: z.ZodRawShape;
};

const uuid = z.string().uuid();

export const TOOL_REGISTRY: readonly ToolSpec[] = [
  {
    name: "list_video_projects",
    kind: "lecture",
    domain: "video",
    description: "Liste les espaces vidéo existants : titre, statut, plateformes et durée estimée.",
    inputSchema: {},
  },
  {
    name: "get_script",
    kind: "lecture",
    domain: "video",
    description:
      "Renvoie l'état actuel d'une variante sous la forme du contrat JSON lui-même (`payload`), révisable puis resoumettable tel quel à submit_script, plus les identifiants internes (`beatId`, `insertId`) qu'exigent update_beat et update_insert. À appeler avant toute révision : c'est ce qui permet de corriger un script plutôt que de le réécrire entièrement.",
    inputSchema: { variantId: uuid },
  },
  {
    name: "get_video_brief",
    kind: "lecture",
    domain: "video",
    description:
      "Renvoie le brief d'un projet : le style maison de la rédaction et le contrat JSON attendu en réponse.",
    inputSchema: { projectId: uuid },
  },
  {
    name: "list_articles",
    kind: "lecture",
    domain: "article",
    description: "Liste les articles approuvés ou publiés, pour partir d'un sujet déjà sourcé.",
    inputSchema: { search: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() },
  },
  {
    name: "get_article",
    kind: "lecture",
    domain: "article",
    description: "Renvoie le titre, le chapô, le corps et les sources d'un article.",
    inputSchema: { articleId: uuid },
  },
  {
    name: "list_video_categories",
    kind: "lecture",
    domain: "video",
    description:
      "Liste les catégories de vidéo utilisables à la création d'un espace vidéo (identifiant, nom, description). À appeler avant create_video_project pour choisir un categoryId pertinent.",
    inputSchema: {},
  },
  {
    name: "create_video_project",
    kind: "ecriture",
    domain: "video",
    description:
      "Crée un espace vidéo et renvoie son brief dans la même réponse. Une variante par défaut est créée avec la plateforme, la durée cible et le cadrage donnés. Rattache-la à une catégorie avec categoryId (appelle d'abord list_video_categories pour en choisir une) : les instructions de cette catégorie apparaîtront automatiquement dans le brief renvoyé par CET appel.",
    inputSchema: {
      title: z.string().min(1).max(200),
      subject: z.string().max(2000).optional(),
      platform: z.enum(PLATFORMS),
      targetDurationSec: z.number().int().min(5).max(14400).optional(),
      aspectRatio: z.enum(RATIOS).optional(),
      articleId: uuid.optional(),
      categoryId: uuid.optional(),
    },
  },
  {
    name: "submit_script",
    kind: "ecriture",
    domain: "video",
    description:
      "Valide un script au format du contrat et prépare son import. Renvoie soit le diff de ce qui changerait, soit le rapport d'erreurs — chemin, message et valeur reçue — pour que tu corriges et resoumettes.",
    inputSchema: { projectId: uuid, variantId: uuid.optional(), payload: payloadSchema },
  },
  {
    name: "apply_script",
    kind: "ecriture",
    domain: "video",
    description:
      "Applique un import préparé. Sans sélection explicite, applique les ajouts et les modifications, jamais les suppressions ni les conflits — ceux-là doivent être demandés nommément.",
    inputSchema: { journalId: uuid, variantId: uuid, accept: z.array(z.string()).optional() },
  },
  {
    name: "update_beat",
    kind: "ecriture",
    domain: "video",
    description:
      "Retouche un beat : texte parlé, note de réalisation, texte à l'écran, transitions. Le TYPE d'un beat ne se retouche pas ici — il repasse par submit_script, donc par la fusion.",
    inputSchema: {
      beatId: uuid,
      spokenText: z.string().max(20000).optional(),
      directionNote: z.string().max(1000).nullable().optional(),
      screenText: z.string().max(300).nullable().optional(),
      transitionIn: z.string().max(120).nullable().optional(),
      transitionOut: z.string().max(120).nullable().optional(),
      // `kind` retiré (revue Task 5) : le cœur (updateBeatCore) ne sait pas l'écrire. Annoncer un
      // paramètre qu'on refuse ensuite est un mauvais contrat — l'agent voit une capacité qui
      // n'existe pas, l'essaie, échoue, et ne comprend pas pourquoi.
    },
  },
  {
    name: "reorder_beats",
    kind: "ecriture",
    domain: "video",
    description:
      "Réordonne les beats d'une variante, sans réécrire le script. L'ordre se donne avec les identifiants de beat du contrat (« b-01-accroche »), ceux-là mêmes que tu as écrits.",
    // Des `externalId`, PAS des UUID (revue Task 5) : l'agent connaît naturellement les identifiants
    // qu'il a lui-même écrits, et c'est aussi la clé sur laquelle travaille le cœur
    // (reorderBeatsCore apparie sur `script_beats.external_id`). Réclamer l'UUID de ligne lui
    // imposerait un aller-retour de lecture pour manipuler une clé qui ne lui dit rien.
    inputSchema: { variantId: uuid, order: z.array(z.string().min(1).max(120)).min(1) },
  },
  {
    name: "update_insert",
    kind: "ecriture",
    domain: "video",
    description:
      "Corrige l'URL d'un insert. Le lien repasse à « non vérifié » : une URL changée à la main n'a jamais été contrôlée.",
    inputSchema: { insertId: uuid, url: z.string().nullable() },
  },
] as const;

export function toolByName(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
