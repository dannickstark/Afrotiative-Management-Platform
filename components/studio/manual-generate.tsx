"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Download, Wand2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { renderManual } from "@/lib/actions/studio-manual-actions";
import { fieldsForContext, MANUAL_CONTEXTS, type ManualField } from "@/lib/studio/manual-form";
import { CHANNELS, CHANNEL_LABELS, type TemplateContext, type Channel, type TokenId } from "@/lib/studio/tokens";
import type { TokenValues } from "@/lib/studio/values";
import { SAMPLE_VALUES } from "@/lib/studio/sample-values";
import { TOKEN_LABELS } from "./token-picker";
import { ImageAssetPicker } from "./asset-picker";
import { StorageBanner } from "./storage-banner";
import type { AssetRow } from "@/lib/queries/assets";
import type { CategoryOption } from "@/lib/queries/studio";

// components/studio/manual-generate.tsx — Tâche 14 (spec §7) : /studio/generer, le formulaire de
// génération ponctuelle pour les trois contextes à saisie manuelle. C'est ce qui rend enfin utiles
// les jetons quote.* / edition.* / recap.* déclarés en V1 sans le moindre fournisseur de valeurs.
//
// Contraste avec l'aperçu de l'éditeur (hooks/use-preview.ts) : ce formulaire appelle
// renderManual — gardé, et qui ÉCRIT (R2 + une ligne `renders`, subjectType "manual") — jamais
// previewTemplate. Il n'y a d'ailleurs ni brouillon ni scène ici à prévisualiser : le formulaire
// choisit une PORTÉE (contexte / canal / catégorie) exactement comme render_templates lui-même, et
// laisse resolveTemplate() trouver le gabarit déjà PUBLIÉ à cette portée, comme le fait tout rendu
// V1 côté article.

const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

const NO_CHANNEL = "__aucun__";
const NO_CATEGORY = "__aucune__";

// ─────────────────────────────────────────────────────────────────────────────
// Un champ par jeton — le WIDGET dépend de TOKEN_KINDS (texte, couleur, image), mais l'ENSEMBLE des
// champs vient de fieldsForContext (lib/studio/manual-form.ts), jamais d'une liste recopiée ici.
// `data-field={token}` sur le conteneur, quel que soit le widget : c'est ce qui permet à
// tests/studio-manual.test.ts de vérifier, sur le VRAI rendu du composant (react-dom/server, comme
// tests/studio-property-panel.test.ts), que l'ensemble affiché correspond exactement à
// CONTEXT_TOKENS[context] — pas seulement à la fonction pure qui le calcule.
function ManualFieldRow({
  field, value, onChange, assets,
}: { field: ManualField; value: string; onChange: (v: string) => void; assets: AssetRow[] }) {
  const { token, kind } = field;
  const label = TOKEN_LABELS[token];

  return (
    <div className="space-y-1" data-field={token} data-kind={kind}>
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {kind === "image" ? (
        <ImageAssetPicker
          assets={assets}
          // Un jeton de saisie manuelle attend une URL (values.ts:substitute l'insère telle quelle
          // dans la source de l'image, PAS un identifiant d'asset — contrairement au sélecteur de
          // source d'un calque, lib/studio/scene.ts:ImageSource, qui accepte lui un
          // {kind:"asset",assetId}). On réutilise donc le MÊME sélecteur visuel (spec §7 : « avec
          // sélecteur d'asset pour les images ») mais on committe l'URL publique de l'asset choisi,
          // pas son identifiant.
          value={assets.find((a) => a.url === value)?.id ?? ""}
          onPick={(assetId) => {
            const asset = assets.find((a) => a.id === assetId);
            if (asset) onChange(asset.url);
          }}
        />
      ) : kind === "color" ? (
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-6 shrink-0 rounded border border-input"
            style={{ backgroundColor: value || "transparent" }}
          />
          <Input
            value={value}
            data-testid={`field-input-${token}`}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#RRGGBB"
          />
        </div>
      ) : (
        <Input
          value={value}
          data-testid={`field-input-${token}`}
          onChange={(e) => onChange(e.target.value)}
          placeholder={SAMPLE_VALUES[token]}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export interface ManualGenerateProps {
  assets: AssetRow[];
  categories: CategoryOption[];
  storageConfigured: boolean;
  // Amorce de test UNIQUEMENT (comme `store`/`fetchImpl` dans lib/studio/manual-core.ts) — la vraie
  // page (app/(app)/studio/generer/page.tsx) ne la passe jamais : le formulaire démarre toujours sur
  // MANUAL_CONTEXTS[0]. Elle permet à tests/studio-manual.test.ts de rendre ce composant pour
  // CHACUN des trois contextes manuels et de vérifier que l'ensemble de champs affiché en dépend
  // vraiment — sans elle, seul le premier contexte serait jamais exercé par un rendu structurel.
  initialContext?: TemplateContext;
}

type GenerateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; degraded: boolean }
  | { status: "error"; message: string };

export function ManualGenerate({ assets, categories, storageConfigured, initialContext }: ManualGenerateProps) {
  const [context, setContext] = useState<TemplateContext>(initialContext ?? MANUAL_CONTEXTS[0]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [values, setValues] = useState<TokenValues>({});
  const [state, setState] = useState<GenerateState>({ status: "idle" });
  const [pending, startTransition] = useTransition();

  const fields = useMemo(() => fieldsForContext(context), [context]);

  function switchContext(next: TemplateContext) {
    setContext(next);
    // Un contexte n'a pas les mêmes jetons qu'un autre (quote.* vs recap.* …) : repartir d'un
    // formulaire vide plutôt que de laisser traîner une valeur qui n'a plus aucun champ pour la
    // porter — un report accidentel de "quote.text" vers "recap.title" serait un bug silencieux.
    setValues({});
    setState({ status: "idle" });
  }

  function setField(token: TokenId, v: string) {
    setValues((prev) => ({ ...prev, [token]: v }));
  }

  // Correctif Important 3 (revue finale V2) : lib/studio/tokens.ts place `brand.logo` (kind
  // "image") dans les TROIS contextes manuels, et son seul widget (ImageAssetPicker) n'a pas de
  // repli texte libre — avec une bibliothèque vide, `allFilled` ne pouvait donc JAMAIS valoir true,
  // quel que soit le gabarit publié. `allFilled` reste un indice visuel (voir le paragraphe
  // d'aide plus bas) mais NE gate plus ni la soumission ni le bouton : c'est renderManualCore qui
  // tranche, avec le message français précis de MissingTokensError nommant les jetons que la SCÈNE
  // référence réellement (jamais tous les jetons du contexte) — le chemin que
  // tests/studio-manual.test.ts vérifie déjà côté action, mais que ce gate rendait inatteignable
  // depuis le bouton.
  const allFilled = fields.every((f) => (values[f.token] ?? "").trim().length > 0);

  function submit() {
    setState({ status: "loading" });
    startTransition(async () => {
      const res = await renderManual({ context, channel, categoryId, values });
      if (res.ok) {
        setState({ status: "ready", url: res.url, degraded: res.degraded });
        toast.success("Image générée.");
      } else {
        setState({ status: "error", message: res.message });
        toast.error(res.message);
      }
    });
  }

  return (
    <div className="space-y-4" data-testid="manual-generate">
      <div>
        <h1 className="text-xl font-semibold">Génération ponctuelle</h1>
        <p className="text-sm text-muted-foreground">
          Citation, bandeau de newsletter ou carte récap — remplissez le formulaire, l&rsquo;image est
          générée puis conservée, prête à télécharger.
        </p>
      </div>

      {!storageConfigured && <StorageBanner />}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Portée</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs font-normal text-muted-foreground">Contexte</Label>
            <Select value={context} onValueChange={(v) => v && switchContext(v as TemplateContext)}>
              <SelectTrigger className="w-full" data-action="manual-context-select">
                <SelectValue placeholder="Choisir…">
                  {(v: string | null) => CONTEXT_LABEL[(v ?? context) as TemplateContext] ?? "Choisir…"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MANUAL_CONTEXTS.map((c) => <SelectItem key={c} value={c}>{CONTEXT_LABEL[c]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-normal text-muted-foreground">Canal (optionnel)</Label>
            <Select
              value={channel ?? NO_CHANNEL}
              onValueChange={(v) => setChannel(v && v !== NO_CHANNEL ? (v as Channel) : null)}
            >
              <SelectTrigger className="w-full" data-action="manual-channel-select">
                <SelectValue placeholder="Aucun">
                  {(v: string | null) => (v && v !== NO_CHANNEL ? CHANNEL_LABELS[v as Channel] : "Aucun")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Aucun</SelectItem>
                {CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-normal text-muted-foreground">Catégorie (optionnel)</Label>
            <Select
              value={categoryId ?? NO_CATEGORY}
              onValueChange={(v) => setCategoryId(v && v !== NO_CATEGORY ? v : null)}
            >
              <SelectTrigger className="w-full" data-action="manual-category-select">
                <SelectValue placeholder="Aucune">
                  {(v: string | null) => (v && v !== NO_CATEGORY ? categories.find((c) => c.id === v)?.name ?? v : "Aucune")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>Aucune</SelectItem>
                {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{CONTEXT_LABEL[context]}</CardTitle>
        </CardHeader>
        {/* key={context} : remonte tous les champs au changement de contexte — même garantie que
            components/studio/property-panel.tsx:key={layer.id}, pour qu'aucune valeur tamponnée
            d'un contexte ne fuite visuellement dans l'affichage d'un autre (l'état, lui, est déjà
            vidé par switchContext ci-dessus ; ce `key` couvre en plus tout état interne propre aux
            widgets, ex. ImageAssetPicker). */}
        <CardContent className="grid gap-3 sm:grid-cols-2" key={context} data-testid="manual-fields">
          {fields.map((f) => (
            <ManualFieldRow key={f.token} field={f} value={values[f.token] ?? ""} onChange={(v) => setField(f.token, v)} assets={assets} />
          ))}
        </CardContent>
      </Card>

      {state.status === "error" && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="manual-generate-error"
        >
          {state.message}
        </div>
      )}

      {state.status === "ready" && (
        <div className="flex items-center gap-3 rounded-lg border p-3" data-testid="manual-generate-result">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.url} alt="Image générée" className="h-24 w-24 shrink-0 rounded object-cover" />
          <div className="min-w-0 flex-1 space-y-1">
            {state.degraded && <Badge variant="secondary" data-testid="manual-degraded-badge">Rendu dégradé</Badge>}
            <p className="truncate text-xs text-muted-foreground">{state.url}</p>
          </div>
          <a
            href={state.url} download target="_blank" rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline" }))}
            data-action="download-manual-render"
          >
            <Download />Télécharger
          </a>
        </div>
      )}

      <Button
        type="button" data-action="generate"
        disabled={!storageConfigured || pending}
        // Correctif Important 3 : allFilled n'entre plus dans `disabled` (voir plus haut) — seul
        // storageConfigured (une vraie condition bloquante, la bannière R2 ci-dessus) désactive
        // encore ce bouton. Un contexte dont la scène publiée ne référence pas tous les jetons
        // (ex. `recap_card` sans `{{brand.logo}}`) est déjà générable sans que RIEN ne soit rempli.
        title={!storageConfigured ? "Indisponible : stockage R2 non configuré." : undefined}
        onClick={submit}
      >
        <Wand2 />{pending ? "Génération…" : "Générer"}
      </Button>
      {storageConfigured && !allFilled && (
        // Pur indice visuel, ne bloque plus rien : certains champs vides sont sans conséquence si
        // le gabarit publié pour ce contexte ne les référence pas ; sinon, cliquer sur *Générer*
        // affiche le message français précis de MissingTokensError (jetons manquants nommés un par
        // un), pas ce texte générique.
        <p className="text-xs text-muted-foreground" data-testid="manual-generate-incomplete-hint">
          Certains champs sont vides. S&rsquo;ils sont utilisés par le gabarit publié pour ce
          contexte, la génération l&rsquo;indiquera précisément.
        </p>
      )}
    </div>
  );
}
