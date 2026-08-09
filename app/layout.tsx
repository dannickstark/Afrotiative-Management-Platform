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
      <body className="min-h-full flex flex-col font-sans antialiased group/body overscroll-none [--footer-height:--spacing(14)] xl:[--footer-height:--spacing(24)] theme-default">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
