"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

// components/ui/slider.tsx — Chantier C, Tâche 5 : enveloppe shadcn du `Slider` Base UI, calquée sur
// components/ui/switch.tsx (mêmes conventions `data-slot`, même style « ne rien réimplémenter, juste
// habiller »). Pure primitive de présentation — SANS test propre (couverte par
// components/studio/property-fields.tsx#SliderField, le SEUL appelant de ce fichier). `Slider.Root`
// est générique (`number | readonly number[]`) mais ce dépôt n'a besoin QUE d'un curseur À UN THUMB
// (aucun champ n'édite une PLAGE de valeurs) — la signature reste donc celle de Base UI telle quelle
// plutôt que de la rétrécir artificiellement, un futur besoin de plage n'aurait alors rien à défaire.
function Slider({
  className,
  ...props
}: SliderPrimitive.Root.Props) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center py-1 select-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Control data-slot="slider-control" className="flex w-full items-center">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"
        >
          <SliderPrimitive.Indicator data-slot="slider-indicator" className="absolute h-full bg-primary" />
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            className="block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
