// Préréglages de format. Un gabarit choisit UN format à la création ; sa largeur et sa hauteur
// sont ensuite FIGÉES sur la ligne render_templates. Modifier un préréglage ici n'altère donc
// jamais un gabarit existant — c'est voulu : un changement de dimension casserait la mise en page.
export const FORMAT_PRESETS = {
  website_featured: { width: 1200, height: 675,  label: "Image à la une (site)" },
  fb_link:          { width: 1200, height: 630,  label: "Facebook — lien" },
  ig_square:        { width: 1080, height: 1080, label: "Instagram — carré" },
  ig_portrait:      { width: 1080, height: 1350, label: "Instagram — portrait" },
  story:            { width: 1080, height: 1920, label: "Story (Instagram / WhatsApp)" },
  x_landscape:      { width: 1600, height: 900,  label: "X — paysage" },
  wa_square:        { width: 1080, height: 1080, label: "WhatsApp — carré" },
  li_link:          { width: 1200, height: 627,  label: "LinkedIn — lien" },
} as const;

export type FormatKey = keyof typeof FORMAT_PRESETS;
export const FORMAT_KEYS = Object.keys(FORMAT_PRESETS) as FormatKey[];
