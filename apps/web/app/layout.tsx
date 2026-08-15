import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Both faces are self-hosted, from files committed under app/fonts.
 *
 * ---------------------------------------------------------------------------
 * Why not next/font/google
 * ---------------------------------------------------------------------------
 *
 * next/font/google fetches the CSS from fonts.googleapis.com and the woff2
 * files from fonts.gstatic.com *at build time*. That makes every production
 * build depend on Google's CDN answering, and on the exact file hashes it
 * happens to be serving — Google rotates those, and a rotated hash 404s a URL
 * the build has already committed to.
 *
 * The failure hides behind the build cache: once .next holds a downloaded
 * copy, the build keeps succeeding, so the first machine to see it is a clean
 * CI checkout or a new laptop.
 *
 * Self-hosting removes the dependency rather than pinning it. The files came
 * from @fontsource, which was a delivery mechanism only — the packages are
 * uninstalled, because leaving them would imply something still reads from
 * node_modules.
 *
 * ---------------------------------------------------------------------------
 * Which cuts, and why so few
 * ---------------------------------------------------------------------------
 *
 * latin and latin-ext only. cyrillic, greek and vietnamese are most of the
 * byte weight of these families and this is an English and Indic-language
 * product.
 *
 * EB Garamond ships one weight here: 400. That is not a trim, it is the whole
 * display scale — --wa-display-weight is 400 and nothing else references the
 * face. The previous config also pulled 500 and italic; neither appeared
 * anywhere in the app, and loading a bold cut for a system whose single most
 * load-bearing rule is "never bold display copy" was an invitation.
 *
 * The design doc specifies Waldenburg Light at 300 and names EB Garamond as
 * the open-source substitute. EB Garamond has no 300 cut — its axis starts at
 * 400 — so 400 is the lightest that exists. Do not "fix" this. To get a
 * literal 300, swap the face to Cormorant Garamond, which does ship one, and
 * set --wa-display-weight to 300 in globals.css. Nothing else changes.
 */
const ebGaramond = localFont({
  src: [
    {
      path: "./fonts/eb-garamond-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/eb-garamond-latin-ext-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
  ],
  variable: "--font-eb-garamond",
  display: "swap",
});

/** Body face. Inter at 400/500, plus 600 for the uppercase caption step. */
const inter = localFont({
  src: [
    {
      path: "./fonts/inter-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/inter-latin-ext-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/inter-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/inter-latin-ext-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/inter-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/inter-latin-ext-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
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
