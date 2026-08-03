import { db } from "@/db";
import {
  feeds, articles, articleSources, articleTags, articleRevisions,
  wpCategories, wpTags, clusters, pipelineRuns, pipelineSteps, distributions, user,
} from "@/db/schema";
import { createCredentialUser } from "@/lib/create-user";
import { inArray } from "drizzle-orm";

const CATS = ["Économie", "Finance", "Marchés", "Startups & Tech", "Énergie",
  "Politique économique", "Entreprises", "International"];
const TAGS = ["BRVM", "FCFA", "BCEAO", "pétrole", "fintech", "inflation", "BAD",
  "zone franc", "mobile money", "or", "cacao", "Nigeria", "Cameroun", "UEMOA", "dette"];

async function main() {
  // wipe app tables (keep migrations)
  await db.delete(distributions); await db.delete(pipelineSteps); await db.delete(pipelineRuns);
  await db.delete(articleRevisions); await db.delete(articleTags); await db.delete(articleSources);
  await db.delete(articles); await db.delete(clusters); await db.delete(feeds);
  await db.delete(wpTags); await db.delete(wpCategories);

  const seedUsers = [
    { email: "admin@afrotiative.com", name: "Awa Diallo", role: "admin" as const },
    { email: "editor@afrotiative.com", name: "Koffi Mensah", role: "editor" as const },
    { email: "journaliste@afrotiative.com", name: "Zara Okonkwo", role: "journalist" as const },
  ];
  for (const u of seedUsers) {
    await db.delete(user).where(inArray(user.email, [u.email]));
    await createCredentialUser({ ...u, password: "Afrotiative2026!" });
  }
  const [admin] = await db.select().from(user).where(inArray(user.email, ["admin@afrotiative.com"]));

  const cats = await db.insert(wpCategories).values(
    CATS.map((name, i) => ({ name, slug: name.toLowerCase().replace(/[^a-z]+/g, "-"), wpId: i + 1 }))
  ).returning();
  await db.insert(wpTags).values(
    TAGS.map((name, i) => ({ name, slug: name.toLowerCase().replace(/[^a-z]+/g, "-"), wpId: i + 1 }))
  );

  await db.insert(feeds).values([
    { name: "Financial Afrik", feedUrl: "https://www.financialafrik.com/feed/", siteUrl: "https://www.financialafrik.com", lastFetchStatus: "ok", itemsCaptured7d: 34, lastFetchAt: new Date(Date.now() - 36e5) },
    { name: "Jeune Afrique — Éco", feedUrl: "https://www.jeuneafrique.com/economie/feed/", siteUrl: "https://www.jeuneafrique.com", lastFetchStatus: "ok", itemsCaptured7d: 51, lastFetchAt: new Date(Date.now() - 72e5) },
    { name: "Agence Ecofin", feedUrl: "https://www.agenceecofin.com/rss", siteUrl: "https://www.agenceecofin.com", lastFetchStatus: "ok", itemsCaptured7d: 78, lastFetchAt: new Date(Date.now() - 18e5) },
    { name: "Sika Finance", feedUrl: "https://www.sikafinance.com/rss", siteUrl: "https://www.sikafinance.com", lastFetchStatus: "error", itemsCaptured7d: 0, lastFetchAt: new Date(Date.now() - 864e5) },
    { name: "La Tribune Afrique", feedUrl: "https://afrique.latribune.fr/feed", siteUrl: "https://afrique.latribune.fr", lastFetchStatus: "ok", itemsCaptured7d: 22, lastFetchAt: new Date(Date.now() - 54e5) },
    { name: "Bloomberg Africa", feedUrl: "https://www.bloomberg.com/africa/rss", siteUrl: "https://www.bloomberg.com", lastFetchStatus: "never", itemsCaptured7d: 0 },
  ]);

  // helper to build one article
  const statuses = ["pending","pending","pending","in_review","approved","published","rejected","draft"] as const;
  const rows = Array.from({ length: 25 }).map((_, i) => {
    const status = statuses[i % statuses.length];
    const cat = cats[i % cats.length];
    const lowConf = i % 5 === 0;
    return {
      title: SAMPLE_TITLES[i % SAMPLE_TITLES.length],
      bodyHtml: `<p>${SAMPLE_BODY}</p><h2>Contexte</h2><p>${SAMPLE_BODY}</p>`,
      excerpt: SAMPLE_TITLES[i % SAMPLE_TITLES.length].slice(0, 120),
      status,
      categoryId: lowConf ? null : cat.id,
      featuredImageUrl: lowConf ? null : `https://picsum.photos/seed/afro${i}/800/450`,
      imageCredit: lowConf ? null : "Financial Afrik",
      imageSourceUrl: lowConf ? null : "https://www.financialafrik.com",
      aiAuthor: status !== "draft",
      createdBy: admin.id,
      confidenceFlags: lowConf ? { categoryUncertain: true, imageMissing: true } : {},
      generatedAt: new Date(Date.now() - (i + 1) * 36e5),
      publishedAt: status === "published" ? new Date(Date.now() - i * 36e5) : null,
    };
  });
  const inserted = await db.insert(articles).values(rows).returning();

  for (const a of inserted) {
    await db.insert(articleSources).values([
      { articleId: a.id, mediaName: "Financial Afrik", url: "https://www.financialafrik.com/article" },
      { articleId: a.id, mediaName: "Agence Ecofin", url: "https://www.agenceecofin.com/article" },
    ]);
    await db.insert(articleTags).values([
      { articleId: a.id, tagName: "BRVM", isNew: false },
      { articleId: a.id, tagName: "prévisions 2026", isNew: true },
    ]);
    await db.insert(articleRevisions).values({ articleId: a.id, actorId: admin.id, action: "généré par IA" });
  }

  const [run1] = await db.insert(pipelineRuns).values(
    { triggeredBy: "scheduled", status: "failed", feedsRead: 6, newItems: 12, published: 0, finishedAt: new Date(Date.now() - 6e5) }
  ).returning();
  await db.insert(pipelineSteps).values([
    { runId: run1.id, name: "Lecture des flux", status: "success", durationMs: 1840 },
    { runId: run1.id, name: "Extraction du contenu", status: "failed", durationMs: 5200,
      errorMessage: "L'extraction du contenu a échoué pour Sika Finance (le site n'a pas répondu à temps).",
      errorTechnical: "FetchError: ETIMEDOUT https://www.sikafinance.com after 30000ms" },
  ]);
  await db.insert(pipelineRuns).values([
    { triggeredBy: "scheduled", status: "success", feedsRead: 6, newItems: 8, published: 3, finishedAt: new Date(Date.now() - 9e6) },
    { triggeredBy: "manual", status: "partial", feedsRead: 6, newItems: 5, published: 2, finishedAt: new Date(Date.now() - 18e6) },
  ]);

  console.log(`Seed OK: ${inserted.length} articles, ${seedUsers.length} users.`);
  process.exit(0);
}

const SAMPLE_TITLES = [
  "La BRVM franchit un nouveau record porté par le secteur bancaire",
  "Zone franc : la BCEAO maintient son taux directeur face à l'inflation",
  "Mobile money : le Cameroun dépasse les 20 millions de comptes actifs",
  "Pétrole : le Nigeria révise à la hausse ses prévisions de production",
  "Fintech ouest-africaine : une levée de fonds record pour une startup ivoirienne",
  "Cacao : les cours mondiaux repartent à la hausse avant la récolte",
  "La BAD approuve un prêt de 300 M$ pour l'énergie solaire au Sahel",
  "UEMOA : la dette publique régionale sous surveillance du FMI",
];
const SAMPLE_BODY = "Selon plusieurs sources concordantes, l'évolution récente confirme une tendance de fond sur les marchés régionaux, avec des implications pour les investisseurs et les décideurs publics.";

main().catch((e) => { console.error(e); process.exit(1); });
