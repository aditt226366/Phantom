import type { Metadata, Viewport } from "next";
import { EB_Garamond, Inter } from "next/font/google";
import "./globals.css";

/**
 * Display face.
 *
 * The design doc specifies Waldenburg Light at weight 300 and names
 * EB Garamond as the open-source substitute. Google Fonts ships EB Garamond
 * on a 400-800 weight axis - there is no 300 cut - so 400 is the lightest
 * available and the display weight token is set to it. The "never bold" rule
 * is unaffected.
 *
 * To get a literal 300: swap this import for Cormorant_Garamond (which does
 * ship a 300), add "300" to its weight array, and set --wa-display-weight to
 * 300 in globals.css. Nothing else in the system needs to change.
 */
const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-eb-garamond",
  display: "swap",
});

/** Body face. Inter at 400/500, plus 600 for the uppercase caption step. */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "whatsapp-os",
    template: "%s · whatsapp-os",
  },
  description: "whatsapp-os — foundation scaffold.",
};

export const viewport: Viewport = {
  themeColor: "#f5f5f5",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${ebGaramond.variable} ${inter.variable}`}>
      <body className="min-h-dvh bg-canvas font-body text-body-md text-body antialiased">
        {children}
      </body>
    </html>
  );
}
