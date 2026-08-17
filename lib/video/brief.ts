import { contractJsonSchema, EXAMPLE_PAYLOAD, SCHEMA_VERSION } from "@/lib/video/schema";

// Le brief se colle dans un chat Claude. Trois blocs : le style maison (éditable en Réglages), les
// instructions de recherche (code), le contrat (code, NON modifiable — c'est lui qui garantit que
// l'import fonctionne).
export type BriefVars = {
  titre: string; sujet: string; plateforme: string; duree_cible: string; ratio: string;
  article_titre: string; article_url: string; article_extrait: string;
};

export const DEFAULT_BRIEF_TEMPLATE = `Tu m'aides à écrire le script d'une vidéo pour Afrotiative Media.

Sujet : {{titre}}
Angle : {{sujet}}
Format : {{plateforme}}, durée cible {{duree_cible}}, cadrage {{ratio}}
Article de référence : {{article_titre}} {{article_url}}

Ligne éditoriale : business et finance panafricains francophones. Ton posé, factuel, jamais
sensationnaliste. Le premier beat doit donner une raison concrète de rester ; pas de formule
d'accroche creuse. Phrases courtes, écrites pour être DITES à voix haute, pas lues.

{{article_extrait}}`;

const RESEARCH_BLOCK = `## Recherche attendue

Avant d'écrire, cherche sur Internet :
- les faits, dates et chiffres du sujet, avec pour chacun l'URL de la source ;
- des images et des extraits vidéo réutilisables pour illustrer chaque section — donne l'URL exacte,
  et pour une vidéo les timecodes de début et de fin du passage utile ;
- le crédit à afficher pour chaque média, quand il est connu.

Rattache chaque affirmation chiffrée à une source dans le champ \`sources\` du beat concerné.`;

export type BriefCategory = { name: string; instructions: string };

export function categoryBlock(category: BriefCategory): string {
  return `## Instructions de la catégorie — ${category.name}

${category.instructions.trim()}`;
}

/**
 * Interpolation `{{cle}}`. Une variable inconnue est LAISSÉE TELLE QUELLE et remontée à l'appelant :
 * la remplacer par du vide ferait disparaître une faute de frappe dans un prompt qu'on colle sans
 * le relire.
 */
export function renderTemplate(template: string, vars: BriefVars): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    if (key in vars) return String(vars[key as keyof BriefVars] ?? "");
    if (!unknown.includes(key)) unknown.push(key);
    return match;
  });
  return { text, unknown };
}

export function contractBlock(): string {
  return `## Format de réponse — impératif

Réponds **uniquement** par un objet JSON, sans texte avant ni après, sans balises de code.

Règles dures :
- \`schema_version\` vaut "${SCHEMA_VERSION}".
- Chaque beat porte un \`id\` stable, en minuscules, de la forme \`b-01-accroche\`. Ces identifiants
  doivent rester **identiques** d'une génération à l'autre pour un même script : c'est ce qui permet
  de fusionner tes corrections sans écraser le travail déjà fait.
- Ne réutilise jamais un \`id\` pour un autre beat. Un \`id\` est **unique** dans une variante.
- Pour un insert vidéo, \`tc_out\` doit être postérieur à \`tc_in\`.
- Toute URL (\`url\` d'un insert, entrées de \`sources\`) doit commencer par \`http://\` ou \`https://\`.
  Aucun autre schéma n'est accepté. Énoncé ici parce que JSON-Schema ne l'exprime pas.
- N'invente aucune clé : toute clé absente du schéma fait échouer l'import.

### Schéma JSON

\`\`\`json
${JSON.stringify(contractJsonSchema(), null, 2)}
\`\`\`

### Exemple complet et valide

${JSON.stringify(EXAMPLE_PAYLOAD, null, 2)}`;
}

/**
 * Le bloc de la catégorie s'insère entre le style maison et le bloc Recherche — jamais après le
 * contrat, qui doit rester le dernier mot du brief (c'est lui qui garantit que l'import fonctionne).
 * Catégorie absente ou instructions blanches ⇒ brief strictement identique à celui d'avant.
 */
export function buildBrief(
  template: string, vars: BriefVars, category?: BriefCategory | null,
): { text: string; unknown: string[] } {
  const rendered = renderTemplate(template, vars);
  const blocks = [rendered.text];
  if (category && category.instructions.trim() !== "") blocks.push(categoryBlock(category));
  blocks.push(RESEARCH_BLOCK, contractBlock());
  return { text: blocks.join("\n\n"), unknown: rendered.unknown };
}
