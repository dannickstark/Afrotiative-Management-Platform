import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ProjectHeader appelle useRouter() (next/navigation) via useTransition + router.refresh() pour le
// bouton d'avancement — même recette que tests/tournage-view.test.ts et
// tests/variant-manager.test.ts : posée AVANT le premier import du composant, donc import
// dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { ProjectHeader } = await import("@/components/video/project-header");
type ProjectHeaderVariant = Parameters<typeof ProjectHeader>[0]["variants"][number];
type ProjectHeaderSpeaker = Parameters<typeof ProjectHeader>[0]["speakers"][number];
type ProjectHeaderJournalEntry = Parameters<typeof ProjectHeader>[0]["journal"][number];

const variantA: ProjectHeaderVariant = {
  id: "v-1",
  platform: "youtube_long",
  aspectRatio: "16:9",
  targetDurationSec: 600,
  beats: [
    { durationOverrideSec: null, estimatedDurationSec: 300, inserts: [{ linkStatus: "ok" }] },
    { durationOverrideSec: 30, estimatedDurationSec: 45, inserts: [{ linkStatus: "mort" }, { linkStatus: "ok" }] },
  ],
};

const variantB: ProjectHeaderVariant = {
  id: "v-2",
  platform: "tiktok",
  aspectRatio: "9:16",
  targetDurationSec: null,
  beats: [
    { durationOverrideSec: null, estimatedDurationSec: 20, inserts: [{ linkStatus: "interdit" }] },
  ],
};

function render(overrides: Partial<Parameters<typeof ProjectHeader>[0]> = {}) {
  return renderToStaticMarkup(
    React.createElement(ProjectHeader, {
      projectId: "p-1",
      title: "La success story de Babadampulu",
      subject: "Comment une PME ivoirienne a conquis l'export",
      status: "en_ecriture",
      variants: [variantA],
      activeVariantId: "v-1",
      currentTab: "ecriture",
      journal: [],
      speakers: [],
      canManage: true,
      ...overrides,
    }),
  );
}

describe("ProjectHeader", () => {
  it("affiche le titre et la pastille de statut avec son libellé français", () => {
    const html = render();
    expect(html).toContain("La success story de Babadampulu");
    expect(html).toContain("En écriture");
  });

  it("met en évidence l'étape courante du pipeline et laisse les autres en sourdine", () => {
    const html = render({ status: "pret_a_tourner" });
    // Étape courante : texte en gras (font-semibold), pas les autres.
    expect(html).toMatch(/font-semibold[^>]*>Prêt à tourner</);
    expect(html).not.toMatch(/font-semibold[^>]*>Tourné</);
  });

  it("affiche les six étapes du pipeline", () => {
    const html = render();
    for (const label of ["Brouillon", "En écriture", "Prêt à tourner", "Tourné", "En montage", "Publié"]) {
      expect(html).toContain(label);
    }
  });

  it("affiche le sélecteur de variante avec la variante active marquée", () => {
    const html = render({ variants: [variantA, variantB], activeVariantId: "v-1" });
    expect(html).toContain("YouTube long");
    expect(html).toContain("TikTok");
    expect(html).toContain('href="/video/p-1?tab=ecriture&amp;variant=v-1"');
    expect(html).toContain('href="/video/p-1?tab=ecriture&amp;variant=v-2"');
    // La sélection se lit sur `aria-current`, pas sur une classe : la pastille active n'est plus en
    // terracotta pleine (DESIGN.md, règle « Actions Only » — revue finale, F4).
    expect(html).toContain('aria-current="true"');
    // La pastille active est `secondary` + anneau, jamais `bg-primary` (terracotta) : celle-ci
    // reste réservée aux actions primaires (ici le seul bouton d'avancement).
    expect(html).toMatch(/bg-secondary[^>]*ring-1[^>]*aria-current="true"/);
    expect(html).not.toMatch(/bg-primary[^>]*aria-current="true"/);
  });

  it("préserve l'onglet courant dans les liens du sélecteur de variante", () => {
    const html = render({ variants: [variantA, variantB], activeVariantId: "v-1", currentTab: "montage" });
    expect(html).toContain('href="/video/p-1?tab=montage&amp;variant=v-2"');
  });

  it("affiche la durée cumulée de la variante active au format m:ss face à sa cible", () => {
    const html = render();
    // 300 (durée estimée) + 30 (override) = 330 s = 5:30 ; cible 600 s = 10:00.
    expect(html).toContain("5:30");
    expect(html).toContain("/ 10:00");
  });

  it("affiche un tiret pour la cible quand la variante active n'en a pas", () => {
    const html = render({ variants: [variantA, variantB], activeVariantId: "v-2" });
    expect(html).toContain("/ —");
  });

  it("compte les beats et les inserts de la variante active", () => {
    const html = render();
    expect(html).toContain("2 beats");
    expect(html).toContain("3 inserts");
  });

  it("affiche le badge « lien(s) mort(s) » compté sur TOUTES les variantes, pas seulement l'active", () => {
    const html = render({ variants: [variantA, variantB], activeVariantId: "v-1" });
    // 1 "mort" (variantA) + 1 "interdit" (variantB) = 2. Le libellé dit explicitement « sur le
    // projet » : le conducteur (onglet Montage) affiche juste en dessous le même libellé compté sur
    // la seule variante active (revue finale, F2).
    expect(html).toContain("2 lien(s) mort(s) sur le projet");
  });

  it("affiche le badge « non relue(s) » à partir des écritures d'agent MCP non relues", () => {
    const journal: ProjectHeaderJournalEntry[] = [
      { source: "mcp", reviewedAt: null },
      { source: "mcp", reviewedAt: "2026-08-20T10:00:00.000Z" },
      { source: "human", reviewedAt: null },
    ];
    const html = render({ journal });
    expect(html).toContain("1 non relue");
  });

  it("affiche le badge « consentement(s) » à partir des intervenants sans consentement", () => {
    const speakers: ProjectHeaderSpeaker[] = [
      { id: "s-1", name: "Awa Koné", consentGiven: false },
      { id: "s-2", name: "Jean Dupont", consentGiven: true },
    ];
    const html = render({ speakers });
    expect(html).toContain("1 consentement(s)");
  });

  it("n'affiche aucun badge d'alerte quand rien ne réclame d'action", () => {
    const cleanVariant: ProjectHeaderVariant = {
      ...variantA,
      beats: variantA.beats.map((b) => ({ ...b, inserts: [{ linkStatus: "ok" }] })),
    };
    const html = render({ variants: [cleanVariant], activeVariantId: cleanVariant.id });
    expect(html).not.toContain("non relue");
    expect(html).not.toContain("lien(s) mort(s)");
    expect(html).not.toContain("consentement(s)");
  });

  it("affiche l'alerte de consentement bloquant quand le projet est tourné et qu'un consentement manque", () => {
    const speakers: ProjectHeaderSpeaker[] = [{ id: "s-1", name: "Awa Koné", consentGiven: false }];
    const html = render({ status: "tourne", speakers });
    expect(html).toContain("Awa Koné");
    expect(html).toContain("n&#x27;a pas donné son consentement");
    expect(html).toContain("la mise en montage est bloquée");
    expect(html).toContain('href="/video/p-1?tab=intervenants"');
  });

  it("agrège les intervenants sans consentement dans UNE seule région d'alerte", () => {
    const speakers: ProjectHeaderSpeaker[] = [
      { id: "s-1", name: "Awa Koné", consentGiven: false },
      { id: "s-2", name: "Jean Dupont", consentGiven: false },
      { id: "s-3", name: "Fatou Diallo", consentGiven: true },
    ];
    const html = render({ status: "tourne", speakers });
    // Une seule annonce pour un lecteur d'écran, un seul lien — pas une par personne (F7).
    expect(html.match(/role="alert"/g)?.length).toBe(1);
    expect(html.match(/tab=intervenants/g)?.length).toBe(1);
    expect(html).toContain("Awa Koné, Jean Dupont");
    expect(html).toContain("n&#x27;ont pas donné leur consentement");
  });

  it("n'affiche pas l'alerte de consentement quand le projet n'est pas encore tourné", () => {
    const speakers: ProjectHeaderSpeaker[] = [{ id: "s-1", name: "Awa Koné", consentGiven: false }];
    const html = render({ status: "en_ecriture", speakers });
    expect(html).not.toContain("n'a pas donné son consentement");
  });

  it("affiche le bouton d'avancement adapté au statut quand l'utilisateur a video:manage", () => {
    expect(render({ status: "en_ecriture", canManage: true })).toContain("Marquer prêt à tourner");
    expect(render({ status: "pret_a_tourner", canManage: true })).toContain("Démarrer le tournage");
    expect(render({ status: "tourne", canManage: true })).toContain("Tournage terminé");
  });

  it("n'affiche pas de bouton d'avancement pour un statut sans transition (publié)", () => {
    const html = render({ status: "publie", canManage: true });
    expect(html).not.toContain("Marquer prêt à tourner");
    expect(html).not.toContain("Démarrer le tournage");
    expect(html).not.toContain("Tournage terminé");
  });

  it("n'affiche jamais le bouton d'avancement sans la permission video:manage", () => {
    const html = render({ status: "en_ecriture", canManage: false });
    expect(html).not.toContain("Marquer prêt à tourner");
  });

  it("affiche le sujet du projet sous le titre", () => {
    const html = render();
    expect(html).toContain("Comment une PME ivoirienne a conquis l&#x27;export");
  });

  it("n'affiche pas de ligne de sujet quand le projet n'en a pas", () => {
    const html = render({ subject: null });
    expect(html).toContain("La success story de Babadampulu");
    expect(html).not.toContain("Comment une PME ivoirienne");
  });
});
