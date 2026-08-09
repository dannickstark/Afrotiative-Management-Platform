import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Lora } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const lora = Lora({ subsets: ["latin"], variable: "--font-editorial" });

export const metadata: Metadata = {
  title: "Afrotiative Media — Console éditoriale",
  description: "Plateforme interne de gestion de contenu",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="fr"
      suppressHydrationWarning
      className={`${inter.variable} ${lora.variable} h-full`}
    >
      {/* `h-full` + `overflow-hidden` : body est borné à la hauteur du viewport et ne défile pas
          lui-même. C'est ce qui permet à <main className="overflow-auto"> (app/(app)/layout.tsx)
          d'être le SEUL conteneur de défilement, laissant l'en-tête et la barre latérale
          immobiles. Sans le `h-full` ici, `min-h-full` seul (plancher, pas plafond) laisse body
          grandir avec son contenu : la page entière défile alors et l'en-tête part avec elle —
          vérifié dans le navigateur avant d'ajouter `h-full` et de conserver `overflow-hidden`
          plutôt que de le retirer. `overscroll-none` reste retiré (inutile une fois que body ne
          défile plus du tout). */}
      <body className="h-full min-h-full flex flex-col overflow-hidden font-sans antialiased group/body [--footer-height:--spacing(14)] xl:[--footer-height:--spacing(24)] theme-default">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
