"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UploadCloud, Trash2, Image as ImageIcon, Type as TypeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { uploadAsset, deleteAsset } from "@/lib/actions/asset-actions";
import { fontFaceFamily, fontProxyUrl } from "@/lib/studio/font-face";
import { StorageBanner } from "./storage-banner";
import type { AssetRow } from "@/lib/queries/assets";

// components/studio/asset-library.tsx — Tâche 11 : la page bibliothèque, deux formulaires de
// téléversement (image / police, spec §5) au-dessus d'une liste de ce qui existe déjà. uploadAsset
// et deleteAsset (lib/actions/asset-actions.ts) appellent déjà revalidatePath("/studio/assets")
// côté serveur ; router.refresh() ci-dessous est un doublon délibéré — même convention que
// components/studio/editor-shell.tsx:handlePublish, dont le commentaire documente pourquoi un appel
// direct à une Server Action (pas un <form action=…> natif) mérite ce filet en plus.
function bytesLabel(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;
}

const FONT_WEIGHTS = [
  { value: "100", label: "100 — Fin" },
  { value: "300", label: "300 — Léger" },
  { value: "400", label: "400 — Normal" },
  { value: "500", label: "500 — Moyen" },
  { value: "600", label: "600 — Demi-gras" },
  { value: "700", label: "700 — Gras" },
  { value: "800", label: "800 — Extra-gras" },
  { value: "900", label: "900 — Noir" },
];

function ImageUploadCard({ onUploaded, disabled }: { onUploaded: () => void; disabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");

  function submit() {
    if (!file) { toast.error("Choisissez un fichier image."); return; }
    const fd = new FormData();
    fd.set("kind", "image");
    fd.set("file", file);
    if (name.trim()) fd.set("name", name.trim());
    startTransition(async () => {
      const res = await uploadAsset(fd);
      if (res.ok) {
        toast.success("Image téléversée.");
        setFile(null);
        setName("");
        onUploaded();
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm"><ImageIcon className="size-4" />Téléverser une image</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="space-y-1">
          <Label className="text-xs font-normal text-muted-foreground">Fichier (PNG, JPEG, WebP ou SVG — 5 Mo max)</Label>
          <Input
            type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-field="image-file"
            disabled={disabled}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs font-normal text-muted-foreground">Nom (optionnel)</Label>
          <Input value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} placeholder={file?.name ?? "logo-marque.png"} />
        </div>
        <Button
          type="button" onClick={submit} disabled={disabled || pending || !file} data-action="upload-image"
          title={disabled ? "Indisponible : stockage R2 non configuré." : undefined}
        >
          <UploadCloud />{pending ? "Téléversement…" : "Téléverser"}
        </Button>
      </CardContent>
    </Card>
  );
}

function FontUploadCard({ onUploaded, disabled }: { onUploaded: () => void; disabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [fontFamily, setFontFamily] = useState("");
  const [fontWeight, setFontWeight] = useState("400");
  const [italic, setItalic] = useState(false);

  function submit() {
    if (!file) { toast.error("Choisissez un fichier de police."); return; }
    const fd = new FormData();
    fd.set("kind", "font");
    fd.set("file", file);
    if (name.trim()) fd.set("name", name.trim());
    if (fontFamily.trim()) fd.set("fontFamily", fontFamily.trim());
    fd.set("fontWeight", fontWeight);
    fd.set("fontStyle", italic ? "italic" : "normal");
    startTransition(async () => {
      const res = await uploadAsset(fd);
      if (res.ok) {
        toast.success("Police téléversée.");
        setFile(null);
        setName("");
        setFontFamily("");
        setFontWeight("400");
        setItalic(false);
        onUploaded();
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm"><TypeIcon className="size-4" />Téléverser une police</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="space-y-1">
          <Label className="text-xs font-normal text-muted-foreground">
            Fichier (TTF ou OTF — 2 Mo max ; le WOFF2 n&rsquo;est pas pris en charge)
          </Label>
          <Input
            type="file" accept=".ttf,.otf,font/ttf,font/otf,application/x-font-ttf,application/vnd.ms-opentype"
            data-field="font-file"
            disabled={disabled}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs font-normal text-muted-foreground">Nom</Label>
            <Input value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} placeholder={file?.name ?? "Ma police"} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-normal text-muted-foreground">Famille (nom affiché dans l&rsquo;éditeur)</Label>
            <Input value={fontFamily} disabled={disabled} onChange={(e) => setFontFamily(e.target.value)} placeholder={name || "Ma police"} />
          </div>
        </div>
        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <Label className="text-xs font-normal text-muted-foreground">Graisse</Label>
            <Select value={fontWeight} onValueChange={(v) => v && setFontWeight(v)} disabled={disabled}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choisir…">
                  {(v: string | null) => FONT_WEIGHTS.find((o) => o.value === v)?.label ?? "Choisir…"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {FONT_WEIGHTS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <label className="flex h-8 items-center gap-1.5 text-sm">
            <Switch checked={italic} onCheckedChange={(v) => setItalic(!!v)} disabled={disabled} />Italique
          </label>
        </div>
        <Button
          type="button" onClick={submit} disabled={disabled || pending || !file} data-action="upload-font"
          title={disabled ? "Indisponible : stockage R2 non configuré." : undefined}
        >
          <UploadCloud />{pending ? "Téléversement…" : "Téléverser"}
        </Button>
      </CardContent>
    </Card>
  );
}

function DeleteAssetButton({ asset, onDeleted }: { asset: AssetRow; onDeleted: () => void }) {
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const res = await deleteAsset(asset.id);
      if (res.ok) {
        toast.success(`« ${asset.name} » supprimé.`);
        onDeleted();
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button" variant="destructive" size="icon-sm" disabled={pending}
          aria-label={`Supprimer « ${asset.name} »`} data-action="delete-asset" data-asset-id={asset.id}
        >
          <Trash2 />
        </Button>
      }
      title={`Supprimer « ${asset.name} » ?`}
      description="Cet asset sera définitivement supprimé de la bibliothèque et du stockage. Impossible tant qu'un gabarit actif (non archivé) le référence — la suppression échouera alors en nommant ce ou ces gabarits."
      confirmLabel="Supprimer"
      destructive
      onConfirm={handleDelete}
    />
  );
}

function AssetGrid({ assets, onDeleted }: { assets: AssetRow[]; onDeleted: () => void }) {
  const images = assets.filter((a) => a.kind === "image");
  const fonts = assets.filter((a) => a.kind === "font");

  return (
    <div className="space-y-6">
      <section className="space-y-2" data-testid="asset-images-section">
        <h2 className="text-sm font-semibold">Images ({images.length})</h2>
        {images.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune image téléversée pour l&rsquo;instant.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {images.map((a) => (
              <div key={a.id} data-asset-id={a.id} className="relative overflow-hidden rounded-lg border">
                {/* Miniature — Tâche 11/13 : les deux surfaces (bibliothèque et sélecteur) montrent
                    la même vignette, dérivée du champ url (public R2), jamais téléchargée à
                    nouveau ici. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.name} className="aspect-square w-full bg-muted object-cover" />
                <div className="space-y-0.5 p-1.5">
                  <p className="truncate text-xs font-medium">{a.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {a.width}×{a.height} · {bytesLabel(a.bytes)}
                  </p>
                </div>
                <div className="absolute top-1 right-1">
                  <DeleteAssetButton asset={a} onDeleted={onDeleted} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2" data-testid="asset-fonts-section">
        <h2 className="text-sm font-semibold">Polices ({fonts.length})</h2>
        {fonts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune police téléversée pour l&rsquo;instant.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {fonts.map((a) => (
              <div key={a.id} data-asset-id={a.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                {/* Échantillon rendu — @font-face pointé sur le proxy même origine (fontProxyUrl),
                    PAS l'URL publique R2 : @font-face exige des en-têtes CORS que le bucket public
                    n'envoie pas (repéré en navigateur réel, voir la note du proxy). Les navigateurs
                    lisent TTF/OTF nativement (contrairement à Satori côté serveur), donc ceci
                    prouve visuellement que le fichier téléversé est une vraie police exploitable. */}
                <style>{`@font-face { font-family: "${fontFaceFamily(a.id)}"; src: url("${fontProxyUrl(a.id)}"); font-weight: ${a.fontWeight ?? 400}; font-style: ${a.fontStyle ?? "normal"}; font-display: swap; }`}</style>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.fontFamily ?? a.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.name} · graisse {a.fontWeight ?? 400}{a.fontStyle === "italic" ? " · italique" : ""} · {bytesLabel(a.bytes)}
                  </p>
                </div>
                <p
                  className="hidden flex-1 truncate text-xl sm:block"
                  style={{ fontFamily: `"${fontFaceFamily(a.id)}"` }}
                  data-testid={`font-sample-${a.id}`}
                >
                  Abécédaire 0123 — Échantillon
                </p>
                <DeleteAssetButton asset={a} onDeleted={onDeleted} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// Tâche 15 (spec §8) : storageConfigured, redescendu depuis app/(app)/studio/assets/page.tsx
// (getStudioConfig(), lu côté serveur). Désactive les DEUX cartes de téléversement plutôt que de
// laisser uploadAssetCore échouer au clic avec son propre message gracieux (lib/studio/asset-core.ts)
// — la suppression, elle, reste active : deleteAssetCore fonctionne sans R2 (elle saute simplement
// le nettoyage de l'objet R2 quand cfg est null), donc rien à désactiver ici.
export function AssetLibrary({ assets, storageConfigured }: { assets: AssetRow[]; storageConfigured: boolean }) {
  const router = useRouter();
  function refresh() { router.refresh(); }

  return (
    <div className="space-y-6" data-testid="asset-library">
      <div>
        <h1 className="text-xl font-semibold">Bibliothèque d&rsquo;assets</h1>
        <p className="text-sm text-muted-foreground">
          Images et polices utilisables dans les gabarits du Studio.
        </p>
      </div>

      {!storageConfigured && <StorageBanner />}

      <div className="grid gap-3 sm:grid-cols-2">
        <ImageUploadCard onUploaded={refresh} disabled={!storageConfigured} />
        <FontUploadCard onUploaded={refresh} disabled={!storageConfigured} />
      </div>

      <AssetGrid assets={assets} onDeleted={refresh} />
    </div>
  );
}
