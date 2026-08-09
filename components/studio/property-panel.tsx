"use client";

import { useEffect, useState, type Dispatch, type ReactNode } from "react";
import { Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Layer, Scene, TextLayer, ImageLayer, ShapeLayer, QrLayer, Gradient } from "@/lib/studio/scene";
import { type EditorAction, setLayerProp } from "@/lib/studio/editor-state";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { AssetRow } from "@/lib/queries/assets";
import { TokenPicker, tokensFor, TOKEN_LABELS } from "./token-picker";
import { ImageAssetPicker, FontAssetPicker, pickImageAsset, pickFont } from "./asset-picker";

// components/studio/property-panel.tsx — Tâche 8 : un formulaire PAR TYPE de calque, couvrant tous
// les champs que l'union Layer autorise (spec Tâche 8). Deux principes traversent tout ce fichier :
//
//  1. Chaque champ est TAMPONNÉ localement et ne committe qu'à la perte de focus (ou Entrée) — pas
//     à chaque frappe. Même raisonnement que components/studio/layer-panel.tsx:RenameField :
//     setLayerProp (lib/studio/editor-state.ts) empile une entrée d'historique à CHAQUE appel
//     réussi, donc committer à chaque caractère saperait « un geste = une entrée » (déjà appliqué
//     au glisser, Tâche 6). Le bloc de champs est en outre placé sous `key={layer.id}` (voir
//     PropertyPanel plus bas) : changer de calque sélectionné REMONTE tous les champs, qui repartent
//     donc d'un tampon propre — pas de valeur d'un calque qui fuiterait dans le tampon d'un autre.
//
//  2. `patch()` construit toujours l'objet imbriqué ENTIER (ex. `{ font: { ...layer.font, size } }`),
//     jamais un correctif partiel sur un sous-objet : editor-state.ts fusionne LayerPatch en
//     SUPERFICIEL (`{...layer, ...patch}`), donc un correctif `{ font: { size } }` remplacerait tout
//     `layer.font` par `{ size }` et perdrait family/weight — ce fichier ne fait jamais cette erreur.
export interface PropertyPanelProps {
  scene: Scene;
  selectedId: string | null;
  context: TemplateContext;
  dispatch: Dispatch<EditorAction>;
  // Tâche 13 (Lot 3) : la bibliothèque d'assets (Tâche 11), chargée UNE FOIS par le composant
  // Server au sommet (app/(app)/studio/[id]/page.tsx) et redescendue en prop — même schéma que
  // `context` ci-dessus, jamais rechargée depuis ce panneau lui-même. Défaut `[]` : les appelants
  // historiques (tests, Storybook éventuel) qui ne fournissent pas encore cette prop continuent de
  // rendre un panneau fonctionnel, simplement sans rien à choisir dans les sélecteurs d'assets.
  assets?: AssetRow[];
}

type Patch = (p: Record<string, unknown>) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Primitives de champ — chacune tamponne localement, résout au blur/Entrée, et Échap annule.

function FieldRow({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1">
        <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}

function useCommitBuffer<T>(value: T) {
  const [local, setLocal] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setLocal(value); }, [value, editing]);
  return { local, setLocal, editing, setEditing };
}

function TextField({
  label, value, onCommit, action, multiline, placeholder, hint, dataField,
}: {
  label: string; value: string; onCommit: (v: string) => void; action?: ReactNode;
  multiline?: boolean; placeholder?: string; hint?: string; dataField?: string;
}) {
  const { local, setLocal, editing, setEditing } = useCommitBuffer(value);
  function commit() {
    setEditing(false);
    if (local !== value) onCommit(local);
  }
  const shared = {
    value: local,
    onFocus: () => setEditing(true),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setLocal(e.target.value),
    onBlur: commit,
    placeholder,
    "data-field": dataField,
  };
  return (
    <FieldRow label={label} action={action}>
      {multiline ? (
        <Textarea
          {...shared}
          rows={3}
          onKeyDown={(e) => { if (e.key === "Escape") { setLocal(value); setEditing(false); e.currentTarget.blur(); } }}
        />
      ) : (
        <Input
          {...shared}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") { setLocal(value); setEditing(false); e.currentTarget.blur(); }
          }}
        />
      )}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </FieldRow>
  );
}

function NumberField({
  label, value, onCommit, step, min, max, action, dataField,
}: {
  label: string; value: number; onCommit: (v: number) => void;
  step?: number; min?: number; max?: number; action?: ReactNode; dataField?: string;
}) {
  const strValue = Number.isFinite(value) ? String(value) : "0";
  const { local, setLocal, editing, setEditing } = useCommitBuffer(strValue);
  function commit() {
    setEditing(false);
    const n = Number(local);
    if (!Number.isFinite(n)) { setLocal(strValue); return; }
    if (n !== value) onCommit(n);
    else setLocal(strValue);
  }
  return (
    <FieldRow label={label} action={action}>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={local}
        data-field={dataField}
        onFocus={() => setEditing(true)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") { setLocal(strValue); setEditing(false); e.currentTarget.blur(); }
        }}
      />
    </FieldRow>
  );
}

// Une couleur de calque est TOUJOURS une valeur unique — hex, "transparent", ou un jeton entier
// (schema hexColor, lib/studio/scene.ts) — jamais un mélange : sélectionner un jeton REMPLACE donc
// tout le champ, contrairement au contenu texte (voir TextFields.content plus bas, où l'insertion
// se fait au contraire par CONCATÉNATION).
function ColorField({
  label, value, context, onCommit, action = true, dataField,
}: {
  label: string; value: string; context: TemplateContext; onCommit: (v: string) => void;
  action?: boolean; dataField?: string;
}) {
  const { local, setLocal, editing, setEditing } = useCommitBuffer(value);
  function commit() {
    setEditing(false);
    if (local !== value) onCommit(local);
  }
  const isToken = local.startsWith("{{");
  return (
    <FieldRow
      label={label}
      action={action ? (
        <TokenPicker
          context={context}
          kind="color"
          title="Insérer une couleur de jeton"
          onPick={(t) => { const v = `{{${t}}}`; setLocal(v); onCommit(v); }}
        />
      ) : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-6 shrink-0 rounded border border-input"
          style={
            isToken || local === "transparent" || local === ""
              ? { background: "repeating-linear-gradient(45deg, #999 0, #999 3px, #ccc 3px, #ccc 6px)" }
              : { backgroundColor: local }
          }
        />
        <Input
          value={local}
          data-field={dataField}
          onFocus={() => setEditing(true)}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") { setLocal(value); setEditing(false); e.currentTarget.blur(); }
          }}
          placeholder="#RRGGBB"
        />
      </div>
    </FieldRow>
  );
}

// Booléen : pas de tampon — un bascule est un geste unique, pas une frappe à amortir.
function SwitchField({ label, checked, onCommit }: { label: string; checked: boolean; onCommit: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      <Switch checked={checked} onCheckedChange={(v) => onCommit(!!v)} />
    </div>
  );
}

function SelectField({
  label, value, options, onCommit, placeholder,
}: {
  label: string; value: string; options: { value: string; label: string }[]; onCommit: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldRow label={label}>
      <Select value={value} onValueChange={(v) => { if (v) onCommit(v); }}>
        <SelectTrigger className="w-full">
          {/* Base UI's <SelectValue> ne dérive PAS automatiquement le libellé du <SelectItem>
              correspondant (contrairement à un <select> natif) — repéré en vérifiant l'écran réel
              dans un navigateur : sans ce mappeur explicite, chaque sélecteur de ce panneau
              (alignement, graisse de police, ajustement d'image…) affichait sa valeur technique
              brute ("left", "700"…) au lieu de son libellé français — même piège déjà corrigé dans
              components/studio/preview-pane.tsx, voir sa note. */}
          <SelectValue placeholder={placeholder ?? "Choisir…"}>
            {(v: string | null) => options.find((o) => o.value === v)?.label ?? placeholder ?? "Choisir…"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5 border-b pb-3 last:border-0" data-section={title}>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
const FONT_WEIGHTS = [
  { value: "100", label: "100 — Fin" },
  { value: "200", label: "200 — Extra-léger" },
  { value: "300", label: "300 — Léger" },
  { value: "400", label: "400 — Normal" },
  { value: "500", label: "500 — Moyen" },
  { value: "600", label: "600 — Demi-gras" },
  { value: "700", label: "700 — Gras" },
  { value: "800", label: "800 — Extra-gras" },
  { value: "900", label: "900 — Noir" },
];
const ALIGN_OPTIONS = [{ value: "left", label: "Gauche" }, { value: "center", label: "Centre" }, { value: "right", label: "Droite" }];
const VALIGN_OPTIONS = [{ value: "top", label: "Haut" }, { value: "middle", label: "Milieu" }, { value: "bottom", label: "Bas" }];
const SIDE_LABEL: Record<"top" | "right" | "bottom" | "left", string> = { top: "Haut", right: "Droite", bottom: "Bas", left: "Gauche" };
const SIDES = ["top", "right", "bottom", "left"] as const;

function TextFields({
  layer, context, patch, assets,
}: { layer: TextLayer; context: TemplateContext; patch: Patch; assets: AssetRow[] }) {
  return (
    <>
      <Section title="Texte">
        <TextField
          label="Contenu"
          value={layer.content}
          multiline
          dataField="content"
          onCommit={(v) => patch({ content: v })}
          action={
            <TokenPicker
              context={context}
              kind="text"
              title="Insérer un jeton dans le texte"
              // Le contenu texte peut MÉLANGER texte libre et jetons (ex. "Bonjour {{article.title}}",
              // extractTokens le scanne partout dans la chaîne — tokens.ts) : à la différence d'une
              // couleur, insérer un jeton ici CONCATÈNE plutôt que de remplacer tout le champ.
              onPick={(t) => patch({ content: `${layer.content}{{${t}}}` })}
            />
          }
        />
      </Section>

      <Section title="Police">
        <FieldRow label="Police téléversée">
          {/* Tâche 13 : choisir parmi les polices téléversées (Tâche 11), la police embarquée
              (Noto Sans) restant toujours sélectionnable en premier — pickFont() écrit à la fois
              font.assetId ET font.family, donc le champ "Famille" juste en dessous reflète
              immédiatement le choix fait ici (et reste éditable à la main pour un ajustement fin). */}
          <FontAssetPicker
            assets={assets}
            value={layer.font.assetId}
            onPick={(pick) => patch({ font: pickFont(layer.font, pick) })}
          />
        </FieldRow>
        <TextField label="Famille" value={layer.font.family} onCommit={(v) => patch({ font: { ...layer.font, family: v } })} />
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Taille" value={layer.font.size} min={1} onCommit={(v) => patch({ font: { ...layer.font, size: Math.max(1, v) } })} />
          <SelectField
            label="Graisse"
            value={String(layer.font.weight)}
            options={FONT_WEIGHTS}
            onCommit={(v) => patch({ font: { ...layer.font, weight: Number(v) } })}
          />
        </div>
        <SwitchField label="Italique" checked={!!layer.font.italic} onCommit={(v) => patch({ font: { ...layer.font, italic: v } })} />
      </Section>

      <Section title="Apparence">
        <ColorField label="Couleur" value={layer.color} context={context} onCommit={(v) => patch({ color: v })} />
        <div className="grid grid-cols-2 gap-2">
          <SelectField label="Alignement" value={layer.align} options={ALIGN_OPTIONS} onCommit={(v) => patch({ align: v })} />
          <SelectField label="Alignement vertical" value={layer.vAlign} options={VALIGN_OPTIONS} onCommit={(v) => patch({ vAlign: v })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Interligne" value={layer.lineHeight} step={0.1} min={0.1}
            onCommit={(v) => patch({ lineHeight: Math.max(0.1, v) })}
          />
          <NumberField label="Espacement lettres" value={layer.letterSpacing ?? 0} onCommit={(v) => patch({ letterSpacing: v || undefined })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Lignes max (0 = illimité)" value={layer.maxLines ?? 0} min={0} step={1}
            onCommit={(v) => patch({ maxLines: v > 0 ? Math.round(v) : undefined })}
          />
          <SwitchField label="Ajustement auto" checked={!!layer.autoFit} onCommit={(v) => patch({ autoFit: v })} />
        </div>
      </Section>

      <Section title="Ombre">
        <SwitchField
          label="Activer l'ombre"
          checked={!!layer.shadow}
          onCommit={(v) => patch({ shadow: v ? { x: 0, y: 2, blur: 4, color: "#000000" } : undefined })}
        />
        {layer.shadow && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="X" value={layer.shadow.x} onCommit={(v) => patch({ shadow: { ...layer.shadow, x: v } })} />
              <NumberField label="Y" value={layer.shadow.y} onCommit={(v) => patch({ shadow: { ...layer.shadow, y: v } })} />
              <NumberField label="Flou" value={layer.shadow.blur} min={0} onCommit={(v) => patch({ shadow: { ...layer.shadow, blur: Math.max(0, v) } })} />
            </div>
            <ColorField
              label="Couleur de l'ombre" value={layer.shadow.color} context={context}
              onCommit={(v) => patch({ shadow: { ...layer.shadow, color: v } })}
            />
          </>
        )}
      </Section>

      <Section title="Contour">
        <SwitchField
          label="Activer le contour"
          checked={!!layer.stroke}
          onCommit={(v) => patch({ stroke: v ? { width: 1, color: "#000000" } : undefined })}
        />
        {layer.stroke && (
          <>
            <NumberField label="Épaisseur" value={layer.stroke.width} min={0.1} onCommit={(v) => patch({ stroke: { ...layer.stroke, width: Math.max(0.1, v) } })} />
            <ColorField
              label="Couleur du contour" value={layer.stroke.color} context={context}
              onCommit={(v) => patch({ stroke: { ...layer.stroke, color: v } })}
            />
          </>
        )}
      </Section>
    </>
  );
}

function ImageFields({
  layer, context, patch, assets,
}: { layer: ImageLayer; context: TemplateContext; patch: Patch; assets: AssetRow[] }) {
  const source = layer.source;
  const imageTokens = tokensFor(context, "image");
  // Premier asset image disponible — sert de valeur de repli VALIDE au premier passage sur l'onglet
  // "Bibliothèque" (voir onValueChange ci-dessous, correctif Tâche 13).
  const firstImageAssetId = assets.find((a) => a.kind === "image")?.id;
  // Correctif Minor 4 (revue finale V2) : bibliothèque vide → PLUS de repli sur un identifiant
  // connu pour ne résoudre à rien ("bibliotheque-vide") — validateScene est pure et ne peut pas
  // détecter une référence d'asset pendante, donc un tel repli pouvait atteindre *publié* et faire
  // échouer TOUT rendu du gabarit. L'onglet est désactivé tant qu'aucune image n'est disponible ;
  // `source.kind === "asset"` reste autorisé pour PRÉSERVER un choix déjà valide (calque chargé
  // avec un assetId existant), jamais pour en fabriquer un nouveau à partir de rien.
  const canUseAssetTab = !!firstImageAssetId || source.kind === "asset";
  return (
    <>
      <Section title="Source de l'image">
        <Tabs
          value={source.kind}
          onValueChange={(v) => {
            if (v === "slot") patch({ source: { kind: "slot", slot: imageTokens[0] ?? "article.image" } });
            // "https://" seul échoue z.string().url() (aucun hôte) — repéré en pilotant un vrai
            // navigateur : le premier clic sur l'onglet "URL" ne faisait STRICTEMENT rien à l'écran,
            // sans la moindre erreur console. lib/studio/editor-state.ts:commit() valide CHAQUE
            // correctif avec parseScene et rejette SILENCIEUSEMENT toute scène invalide (state
            // inchangé, même référence) — un rejet par conception, mais qui rendait ici l'onglet
            // entier inutilisable : `value={source.kind}` restait bloqué sur "slot" pour toujours,
            // le clic semblant chaque fois sans effet. Un exemple d'URL complet et valide dès le
            // premier passage évite ce piège.
            else if (v === "url") patch({ source: { kind: "url", url: source.kind === "url" ? source.url : "https://exemple.com/image.jpg" } });
            // Même piège, même correctif : assetId "" échoue z.string().min(1) — l'onglet
            // "Bibliothèque" (Tâche 13) était, lui aussi, silencieusement inutilisable au premier
            // clic. Repli sur le PREMIER asset image disponible (sélection immédiatement valide et
            // utile, pas un simple bouchon). Correctif Minor 4 : PLUS de repli sur un identifiant
            // connu pour ne résoudre à rien quand la bibliothèque est vide — ce cas n'atteint plus
            // cette branche du tout, l'onglet étant alors DÉSACTIVÉ ci-dessous (canUseAssetTab).
            else if (v === "asset" && canUseAssetTab) {
              patch({
                source: {
                  kind: "asset",
                  assetId: source.kind === "asset" ? source.assetId : firstImageAssetId!,
                },
              });
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="slot" data-action="image-source-slot">Jeton</TabsTrigger>
            <TabsTrigger value="url" data-action="image-source-url">URL</TabsTrigger>
            <TabsTrigger value="asset" data-action="image-source-asset" disabled={!canUseAssetTab}>
              Bibliothèque
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {!canUseAssetTab && (
          <p className="text-[11px] text-muted-foreground">
            Aucune image dans la bibliothèque — téléversez-en une depuis Studio → Bibliothèque pour
            utiliser cette source.
          </p>
        )}

        {source.kind === "slot" && (
          imageTokens.length > 0 ? (
            <SelectField
              label="Emplacement (jeton image)"
              value={source.slot}
              options={imageTokens.map((id) => ({ value: id, label: TOKEN_LABELS[id] }))}
              onCommit={(v) => patch({ source: { kind: "slot", slot: v } })}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">Aucun jeton image disponible dans ce contexte.</p>
          )
        )}
        {source.kind === "url" && (
          <TextField label="URL de l'image" value={source.url} onCommit={(v) => patch({ source: { kind: "url", url: v } })} />
        )}
        {source.kind === "asset" && (
          <FieldRow label="Image de la bibliothèque">
            {/* Tâche 13 : la bibliothèque d'assets (Tâche 11) est désormais branchée — plus besoin
                de coller un identifiant à la main (ancien texte d'aide, retiré). */}
            <ImageAssetPicker
              assets={assets}
              value={source.assetId}
              onPick={(assetId) => patch({ source: pickImageAsset(assetId) })}
            />
          </FieldRow>
        )}
      </Section>

      <Section title="Apparence">
        <SelectField
          label="Ajustement"
          value={layer.fit}
          options={[{ value: "cover", label: "Recadrer (cover)" }, { value: "contain", label: "Contenir (contain)" }]}
          onCommit={(v) => patch({ fit: v })}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Rayon" value={layer.radius ?? 0} min={0} onCommit={(v) => patch({ radius: v || undefined })} />
          <NumberField label="Flou" value={layer.blur ?? 0} min={0} max={200} onCommit={(v) => patch({ blur: v || undefined })} />
        </div>
        <ColorField
          label="Voile (overlay)" value={layer.overlay ?? "transparent"} context={context}
          onCommit={(v) => patch({ overlay: v === "transparent" || v === "" ? undefined : v })}
        />
      </Section>
    </>
  );
}

function replaceStop<T>(arr: readonly T[], i: number, v: T): T[] {
  const copy = arr.slice();
  copy[i] = v;
  return copy;
}

function GradientEditor({ gradient, context, onChange }: { gradient: Gradient; context: TemplateContext; onChange: (g: Gradient) => void }) {
  return (
    <div className="space-y-2">
      <NumberField label="Angle (°)" value={gradient.angle} onCommit={(v) => onChange({ ...gradient, angle: v })} />
      {gradient.stops.map((stop, i) => (
        <div key={i} className="flex items-end gap-1.5">
          <div className="flex-1">
            <ColorField
              label={`Étape ${i + 1}`} value={stop.color} context={context} action={false}
              onCommit={(v) => onChange({ ...gradient, stops: replaceStop(gradient.stops, i, { ...stop, color: v }) })}
            />
          </div>
          <div className="w-20">
            <NumberField
              label="Position" value={stop.at} step={0.05} min={0} max={1}
              onCommit={(v) => onChange({ ...gradient, stops: replaceStop(gradient.stops, i, { ...stop, at: Math.min(1, Math.max(0, v)) }) })}
            />
          </div>
          <Button
            type="button" variant="ghost" size="icon-sm" aria-label="Supprimer l'étape"
            disabled={gradient.stops.length <= 2}
            onClick={() => onChange({ ...gradient, stops: gradient.stops.filter((_, j) => j !== i) })}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button" variant="outline" size="sm"
        onClick={() => onChange({ ...gradient, stops: [...gradient.stops, { color: "#FFFFFF", at: 1 }] })}
      >
        <Plus />Ajouter une étape
      </Button>
    </div>
  );
}

function ShapeFields({ layer, context, patch }: { layer: ShapeLayer; context: TemplateContext; patch: Patch }) {
  const isGradient = typeof layer.fill !== "string";
  const sides = layer.border?.sides ?? SIDES;
  return (
    <>
      <Section title="Remplissage">
        <Tabs
          value={isGradient ? "gradient" : "solid"}
          onValueChange={(v) => {
            if (v === "solid" && isGradient) patch({ fill: "#CCCCCC" });
            else if (v === "gradient" && !isGradient) {
              patch({ fill: { angle: 90, stops: [{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }] } as Gradient });
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="solid" data-action="fill-solid">Uni</TabsTrigger>
            <TabsTrigger value="gradient" data-action="fill-gradient">Dégradé</TabsTrigger>
          </TabsList>
        </Tabs>
        {!isGradient && (
          <ColorField label="Couleur" value={layer.fill as string} context={context} onCommit={(v) => patch({ fill: v })} />
        )}
        {isGradient && (
          <GradientEditor gradient={layer.fill as Gradient} context={context} onChange={(g) => patch({ fill: g })} />
        )}
      </Section>

      <Section title="Forme">
        <NumberField label="Rayon des coins" value={layer.radius ?? 0} min={0} onCommit={(v) => patch({ radius: v || undefined })} />
      </Section>

      <Section title="Bordure">
        <SwitchField
          label="Activer la bordure"
          checked={!!layer.border}
          onCommit={(v) => patch({ border: v ? { width: 2, color: "#000000", sides: [...SIDES] } : undefined })}
        />
        {layer.border && (
          <>
            <NumberField
              label="Épaisseur" value={layer.border.width} min={0.1}
              onCommit={(v) => patch({ border: { ...layer.border, width: Math.max(0.1, v) } })}
            />
            <ColorField
              label="Couleur" value={layer.border.color} context={context}
              onCommit={(v) => patch({ border: { ...layer.border, color: v } })}
            />
            <div className="grid grid-cols-2 gap-1.5">
              {SIDES.map((side) => (
                <SwitchField
                  key={side}
                  label={SIDE_LABEL[side]}
                  checked={sides.includes(side)}
                  onCommit={(checked) => {
                    const next = checked ? [...sides, side] : sides.filter((s) => s !== side);
                    patch({ border: { ...layer.border, sides: next } });
                  }}
                />
              ))}
            </div>
          </>
        )}
      </Section>
    </>
  );
}

function QrFields({ layer, context, patch }: { layer: QrLayer; context: TemplateContext; patch: Patch }) {
  const urlTokens = tokensFor(context, "url");
  return (
    <Section title="QR code">
      {urlTokens.length > 0 ? (
        <SelectField
          label="Emplacement (jeton URL)"
          value={layer.slot}
          options={urlTokens.map((id) => ({ value: id, label: TOKEN_LABELS[id] }))}
          onCommit={(v) => patch({ slot: v })}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">Aucun jeton URL disponible dans ce contexte — un QR code n&rsquo;y a rien à encoder.</p>
      )}
      <ColorField label="Couleur (premier plan)" value={layer.fg} context={context} onCommit={(v) => patch({ fg: v })} />
      <ColorField label="Couleur de fond" value={layer.bg} context={context} onCommit={(v) => patch({ bg: v })} />
      <NumberField label="Marge" value={layer.margin} min={0} step={1} onCommit={(v) => patch({ margin: Math.max(0, Math.round(v)) })} />
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export function PropertyPanel({ scene, selectedId, context, dispatch, assets = [] }: PropertyPanelProps) {
  const layer = scene.layers.find((l) => l.id === selectedId) ?? null;

  if (!layer) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground"
        data-testid="property-panel-empty"
      >
        Sélectionnez un calque pour modifier ses propriétés.
      </div>
    );
  }

  const patch: Patch = (p) => dispatch(setLayerProp(layer.id, p));

  return (
    // key={layer.id} : REMONTE tout le sous-arbre de champs à chaque changement de sélection — voir
    // la note en tête de fichier, point 1. C'est ce qui évite qu'un tampon local (useCommitBuffer)
    // affiche encore la valeur d'un calque après avoir sélectionné le suivant.
    <div className="flex flex-col gap-4 overflow-auto p-3" data-testid="property-panel" key={layer.id}>
      <Section title="Cadre">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={layer.frame.x} dataField="frame.x" onCommit={(v) => patch({ frame: { ...layer.frame, x: v } })} />
          <NumberField label="Y" value={layer.frame.y} dataField="frame.y" onCommit={(v) => patch({ frame: { ...layer.frame, y: v } })} />
          <NumberField
            label="Largeur" value={layer.frame.w} min={1} dataField="frame.w"
            onCommit={(v) => patch({ frame: { ...layer.frame, w: Math.max(1, v) } })}
          />
          <NumberField
            label="Hauteur" value={layer.frame.h} min={1} dataField="frame.h"
            onCommit={(v) => patch({ frame: { ...layer.frame, h: Math.max(1, v) } })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Rotation (°)" value={layer.rotation ?? 0} dataField="rotation" onCommit={(v) => patch({ rotation: v || undefined })} />
          <NumberField
            label="Opacité (0–1)" value={layer.opacity ?? 1} step={0.05} min={0} max={1} dataField="opacity"
            onCommit={(v) => patch({ opacity: Math.min(1, Math.max(0, v)) })}
          />
        </div>
      </Section>

      {layer.type === "text" && <TextFields layer={layer} context={context} patch={patch} assets={assets} />}
      {layer.type === "image" && <ImageFields layer={layer} context={context} patch={patch} assets={assets} />}
      {layer.type === "shape" && <ShapeFields layer={layer} context={context} patch={patch} />}
      {layer.type === "qr" && <QrFields layer={layer} context={context} patch={patch} />}
    </div>
  );
}
