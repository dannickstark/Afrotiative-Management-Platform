// lib/studio/safe-areas.ts — Tâche 6 (U2, spec §7) : LES BANDES de zones sûres, c'est-à-dire les
// régions qu'un habillage d'application (icône de profil, bouton d'action, barre de réponse…) recouvre
// quand le visuel est consulté sur la plateforme cible. Le TOGGLE et son défaut par format étaient de
// U1 (components/studio/canvas-chrome.tsx#safeAreaDefaultFor) ; ce module ne porte QUE la table de
// chiffres, et components/studio/canvas-chrome.tsx la dessine.
//
// ─────────────────────────────────────────────────────────────────────────────
// POURQUOI CE MODULE EST UNE TABLE DE SOURCES, PAS UNE TABLE DE CONSTANTES
//
// Chaque entrée ci-dessous est un FAIT PLATEFORME, pas un choix de design : elle affirme ce que
// l'interface d'Instagram/Meta recouvre réellement. Un chiffre inventé serait pire que pas de chiffre
// du tout — il éloignerait silencieusement de vraies maquettes de la surface utilisable, et personne
// ne pourrait plus, plus tard, distinguer un nombre inventé d'un nombre vérifié. RÈGLE ABSOLUE pour
// quiconque ajoute une entrée ici : soit une source publiée que le lecteur peut ouvrir et vérifier,
// citée dans le commentaire de l'entrée ; soit une mesure/un raisonnement, ALORS DIT COMME TEL. Un
// format pour lequel on ne peut établir aucun chiffre reste ABSENT de la table (voir la liste des
// absences volontaires plus bas) : l'éditeur ne dessine alors aucune bande, ce qui est le comportement
// honnête.
//
// Les valeurs sont des FRACTIONS des dimensions du format (hauteur pour haut/bas, largeur pour les
// côtés), jamais des pixels : c'est la forme sous laquelle Meta publie désormais ses zones de sécurité,
// et la seule qui reste juste quel que soit le zoom d'affichage de l'éditeur ou une future variante de
// résolution du même rapport d'image.
//
// ─────────────────────────────────────────────────────────────────────────────
// `story` (1080×1920, 9:16) — SOURCE PUBLIÉE, guide des publicités Meta
//
// Page consultée le 2026-08-11 :
//   https://en-gb.facebook.com/business/ads-guide/update/image/instagram-story
// Phrase citée VERBATIM :
//   « Consider leaving roughly 14% of the top, 35% of the bottom, and 6% on each side of your asset
//     free from text, logos or other key creative elements to avoid cropping key elements or covering
//     them with the profile icon or call to action. »
// Les MÊMES trois chiffres figurent sur les pages sœurs du même guide (stories Facebook :
// .../image/facebook-story ; reels Instagram : .../image/instagram-reels) — Meta a unifié la zone de
// sécurité des stories et des reels.
//
// TROIS RÉSERVES À CONNAÎTRE, écrites ici plutôt que lissées :
//  1. Ces pourcentages sont ceux des PLACEMENTS PUBLICITAIRES. Les 35 % du bas réservent la place du
//     bouton d'appel à l'action, qui n'existe PAS sur une story organique (le bas y porte la barre de
//     réponse / « Envoyer un message », nettement moins haute). C'est donc une borne CONSERVATRICE
//     pour un visuel organique. Nous la gardons telle quelle parce que c'est le seul chiffre que l'on
//     puisse montrer : Meta ne publie pas d'équivalent pour l'organique. La desserrer est un geste
//     légitime — mais il faudra une source, pas une intuition.
//  2. Des chiffres en PIXELS circulent très largement — « 14 % (250 px) en haut, 20 % (340 px) en bas »
//     sur une toile 1080×1920. Ils viennent de TIERS (guides d'agences, vérificateurs de zones sûres),
//     et c'est tout ce que l'on peut en dire : AUCUNE page de première partie appariant ces
//     pourcentages à ces pixels n'a pu être trouvée ni ouverte. Ce fichier n'affirme donc RIEN sur ce
//     que la documentation de Meta a pu dire par le passé — le faire serait précisément la faute que la
//     RÈGLE ABSOLUE ci-dessus interdit (correctif de la revue de la Tâche 6, point 3 : la version
//     précédente de ce paragraphe présentait ces chiffres comme « une version antérieure » de Meta et
//     qualifiait sa documentation d'approximative, deux affirmations sans URL citable). Deux constats
//     vérifiables par simple arithmétique, à titre d'ordre de grandeur : 250/1920 = 13,02 % et
//     340/1920 = 17,71 %, donc ces pixels ne valent pas les pourcentages auxquels les tiers les
//     apparient d'habitude ; et ces mêmes tiers rattachent les 340 px du bas à la pile du bouton
//     d'action, pas à un pourcentage publié. Nous suivons les POURCENTAGES cités plus haut, lus sur une
//     page que le lecteur peut ouvrir.
//  3. Le préréglage s'appelle « Story (Instagram / WhatsApp) ». Le chiffre ci-dessus est établi pour
//     Instagram/Facebook. Nous n'avons trouvé AUCUNE zone de sécurité publiée pour le statut WhatsApp ;
//     l'appliquer là aussi est un RAISONNEMENT (même toile 9:16 plein écran, même famille
//     d'habillage), pas une spécification — dit explicitement pour que ce ne soit pas relu comme un
//     fait vérifié.
//
// ─────────────────────────────────────────────────────────────────────────────
// ABSENCES VOLONTAIRES — sept formats sur huit, et pourquoi
//
//  · `ig_portrait` (1080×1350). Le brief de la Tâche 6 demandait des bandes « en haut et en bas sur
//    `story` ET `ig_portrait` en particulier ». Aucun chiffre n'a pu être établi : la page du guide des
//    publicités Meta pour le FIL Instagram (https://www.facebook.com/business/ads-guide/update/image/
//    instagram-feed, consultée le 2026-08-11, rapport 4:5, 1440×1800) ne publie AUCUNE zone de
//    sécurité, et c'est cohérent avec ce que fait l'application : dans le fil, le nom du compte est
//    AU-DESSUS de l'image et les actions EN DESSOUS — rien ne recouvre le visuel. Le seul recouvrement
//    documentable pour du 4:5 est le RECADRAGE de la grille de profil, qui n'est pas un habillage et
//    qui a DÉJÀ changé une fois de façon documentée (grille carrée → grille 4:5) : en faire une bande
//    figée serait inventer une stabilité qui n'existe pas. (Formulation resserrée après la revue de la
//    Tâche 6, nit 1 : ce texte disait « au moins deux fois » alors que la parenthèse n'en nommait
//    qu'une — la borne haute n'était pas soutenue par ce qu'elle citait.) `ig_portrait` reste donc SANS bandes, et
//    c'est signalé comme défaut de brief dans le rapport de la tâche plutôt que comblé par un chiffre
//    plausible.
//  · `ig_square`, `wa_square` (1080×1080) : publications de fil, même raison que ci-dessus.
//  · `fb_link`, `li_link`, `x_landscape`, `website_featured` : aperçus de lien et image à la une. Ils
//    s'affichent dans une carte dont l'habillage (titre, domaine) vit HORS de l'image. Certaines
//    surfaces les RECADRENT (un 16:9 rogné en 2:1, par exemple), mais un recadrage n'est pas un
//    habillage, aucune des plateformes concernées ne publie de fraction, et U2 se clôt sur cette
//    tâche : rien n'est deviné ici.
//
// Conséquence assumée, épinglée par un test : `safeAreaDefaultFor` (dérivé de l'ORIENTATION) met le
// toggle sur ON par défaut pour `ig_portrait`, alors qu'aucune bande n'y sera dessinée. L'implication
// ne vaut que dans un sens — « des bandes ⇒ le défaut est ON » — jamais l'inverse.
import type { FormatKey } from "@/lib/studio/formats";

export type SafeAreaEdge = "top" | "bottom" | "left" | "right";

export interface SafeAreaBand {
  edge: SafeAreaEdge;
  /** Fraction de la HAUTEUR du format pour `top`/`bottom`, de sa LARGEUR pour `left`/`right`. */
  fraction: number;
  /**
   * Étiquette courte, en français, affichée DANS la bande. Sans apostrophe droite : `react-dom`
   * l'échapperait en `&#x27;` dans le HTML sérialisé, ce qui rendrait l'étiquette pénible à vérifier
   * en test et n'apporterait rien à l'écran.
   */
  label: string;
}

const TABLE: Partial<Record<FormatKey, readonly SafeAreaBand[]>> = {
  story: [
    { edge: "top", fraction: 0.14, label: "Haut — profil" },
    // « (pub) » — revue de la Tâche 6, point 2. Sans marqueur, l'utilisateur voit une bande « Bas —
    // action » de 672 px sans rien qui dise LAQUELLE des deux bornes il regarde : celle-ci réserve le
    // bouton d'appel à l'action PUBLICITAIRE, absent d'une story organique (sur-réservation d'un
    // facteur ≈2,7 par rapport aux ~250 px d'obstruction organique relayés par des tiers). Le détail
    // complet vit dans l'infobulle du bouton « Zones sûres » (components/studio/canvas-chrome.tsx) ;
    // ici il faut tenir en une étiquette courte.
    { edge: "bottom", fraction: 0.35, label: "Bas — action (pub)" },
    { edge: "left", fraction: 0.06, label: "Gauche" },
    { edge: "right", fraction: 0.06, label: "Droite" },
  ],
};

/**
 * Les bandes de zones sûres du format, ou un tableau VIDE si aucun chiffre n'a pu être établi pour lui
 * (voir « ABSENCES VOLONTAIRES » en tête de fichier). Un tableau vide veut dire « on ne sait pas »,
 * jamais « la zone sûre est le format entier ».
 *
 * Rend une COPIE (tableau et entrées) : la table est un fait partagé par tout l'éditeur, et un
 * appelant qui trierait ou pousserait dans le résultat la corromprait pour tous les suivants.
 */
export function safeAreaBandsFor(format: FormatKey): SafeAreaBand[] {
  return (TABLE[format] ?? []).map((band) => ({ ...band }));
}
