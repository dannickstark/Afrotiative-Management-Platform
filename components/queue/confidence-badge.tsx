import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
export function ConfidenceBadge() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex text-[var(--status-pending)]" />}><AlertTriangle className="size-4" /></TooltipTrigger>
      <TooltipContent>Faible confiance IA — à vérifier en priorité (catégorie, image ou regroupement incertain).</TooltipContent>
    </Tooltip>
  );
}
