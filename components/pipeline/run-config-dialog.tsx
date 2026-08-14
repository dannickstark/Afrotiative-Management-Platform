"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getRunConfigOptions, startPipelineRun } from "@/lib/actions/pipeline-actions";
import type { RunParamsInput } from "@/lib/validation";

const AGE_PRESETS = [
  { value: "6", label: "6 heures" }, { value: "12", label: "12 heures" }, { value: "24", label: "24 heures" },
  { value: "48", label: "48 heures" }, { value: "72", label: "72 heures" }, { value: "168", label: "7 jours" },
];

// If the current hours value isn't one of AGE_PRESETS (e.g. a non-preset defaultMaxItemAgeHours
// from settings, like 36), inject it as an extra option — in numeric order — so the Select has a
// matching SelectItem and doesn't render blank. Presets stay untouched otherwise.
function ageOptionsFor(hours: string) {
  if (AGE_PRESETS.some((p) => p.value === hours)) return AGE_PRESETS;
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return AGE_PRESETS;
  return [...AGE_PRESETS, { value: hours, label: `${n} heures` }].sort((a, b) => Number(a.value) - Number(b.value));
}

type Feed = { id: string; name: string };
type Category = { id: string; name: string };
type RecencyMode = "none" | "age" | "since";

// Pure — extracted so the run/all-categories logic is unit-testable without mounting the dialog
// (this repo has no React component testing). Mirrors how buildInput derives feedIds: an empty
// checked set means "no explicit scope" → null → executeRun/stageSources include every category.
export function toCategoryIds(checkedIds: string[]): string[] | null {
  return checkedIds.length > 0 ? checkedIds : null;
}

export function RunConfigDialog({ onStarted }: { onStarted: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<RecencyMode>("none");
  const [ageHours, setAgeHours] = useState("48");
  const [sinceDate, setSinceDate] = useState("");
  const [sinceTime, setSinceTime] = useState("09:00");
  const [maxItems, setMaxItems] = useState("");
  const [isPending, startTransition] = useTransition();

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setLoading(true);
      try {
        const opts = await getRunConfigOptions();
        setFeeds(opts.feeds);
        setSelected(new Set(opts.feeds.map((f) => f.id)));           // all feeds by default
        setCategories(opts.categories);
        setSelectedCategories(new Set());                            // none checked = all categories by default
        setMaxItems(String(opts.defaults.maxItemsPerRun));
        if (opts.defaults.defaultMaxItemAgeHours != null) {
          setMode("age");
          setAgeHours(String(opts.defaults.defaultMaxItemAgeHours));
        }
      } catch {
        toast.error("Impossible de charger les options d'exécution.");
        setOpen(false);
      } finally { setLoading(false); }
    }
  }

  function toggleFeed(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleCategory(id: string) {
    setSelectedCategories((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function buildInput(): RunParamsInput | null {
    let recency: RunParamsInput["recency"];
    if (mode === "none") recency = { kind: "none" };
    else if (mode === "age") recency = { kind: "age", hours: Number(ageHours) };
    else {
      if (!sinceDate) { toast.error("Choisissez une date « depuis »."); return null; }
      const at = new Date(`${sinceDate}T${sinceTime || "00:00"}`);        // local → ISO with tz
      if (Number.isNaN(at.getTime())) { toast.error("Date « depuis » invalide."); return null; }
      if (at.getTime() > Date.now()) { toast.error("La date « depuis » ne peut pas être dans le futur."); return null; }
      recency = { kind: "since", at: at.toISOString() };
    }
    const allSelected = selected.size === feeds.length;
    return {
      recency,
      feedIds: allSelected ? null : [...selected],
      categoryIds: toCategoryIds([...selectedCategories]),
      maxItems: maxItems.trim() ? Number(maxItems) : undefined,
    };
  }

  function handleLaunch() {
    if (selected.size === 0) { toast.error("Sélectionnez au moins un flux."); return; }
    const input = buildInput();
    if (!input) return;
    startTransition(async () => {
      try {
        const r = await startPipelineRun(input);
        if (!r.ok) { toast.error(r.message); return; }
        setOpen(false);
        onStarted(r.runId);
      } catch { toast.error("Une erreur inattendue est survenue."); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button><Play aria-hidden /> Configurer l&apos;exécution…</Button>} />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configurer l&apos;exécution</DialogTitle>
          <DialogDescription>Ajustez les paramètres avant de lancer. Les valeurs par défaut viennent des réglages.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin" aria-hidden /></div>
        ) : (
          <div className="space-y-4">
            {/* Récence */}
            <div className="space-y-1.5">
              <Label>Récence</Label>
              <Select value={mode} onValueChange={(v) => setMode((v as RecencyMode) ?? "none")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Aucune limite</SelectItem>
                  <SelectItem value="age">Derniers…</SelectItem>
                  <SelectItem value="since">Depuis une date</SelectItem>
                </SelectContent>
              </Select>
              {mode === "age" && (
                <Select value={ageHours} onValueChange={(v) => setAgeHours(v ?? "48")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{ageOptionsFor(ageHours).map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {mode === "since" && (
                <div className="flex gap-2">
                  <Input type="date" value={sinceDate} onChange={(e) => setSinceDate(e.target.value)} />
                  <Input type="time" value={sinceTime} onChange={(e) => setSinceTime(e.target.value)} />
                </div>
              )}
            </div>

            {/* Flux */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Flux ({selected.size}/{feeds.length})</Label>
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSelected(selected.size === feeds.length ? new Set() : new Set(feeds.map((f) => f.id)))}>
                  {selected.size === feeds.length ? "Tout désélectionner" : "Tout sélectionner"}
                </button>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {feeds.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleFeed(f.id)} />
                    <span className="truncate">{f.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Catégories */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Catégories ({selectedCategories.size}/{categories.length})</Label>
                {selectedCategories.size > 0 && (
                  <button type="button" className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setSelectedCategories(new Set())}>
                    Tout désélectionner
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Aucune sélection = toutes les catégories.</p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {categories.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={selectedCategories.has(c.id)} onChange={() => toggleCategory(c.id)} />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Max items */}
            <div className="space-y-1.5">
              <Label htmlFor="run-max-items">Nombre max de nouveaux éléments</Label>
              <Input id="run-max-items" type="number" min={1} max={500} value={maxItems}
                onChange={(e) => setMaxItems(e.target.value)} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={handleLaunch} disabled={isPending || loading}>
            {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            {isPending ? "Démarrage…" : "Lancer l'exécution"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
