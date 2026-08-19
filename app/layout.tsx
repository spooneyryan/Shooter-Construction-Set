import type { Metadata } from "next";
import { Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import "@ccllc/studio/styles.css";
// Components only, no theme.css: the token layer comes from globals.css, which
// maps ElectricBlazor's --eb-* contract onto Starline's own palette.
import "@electricblazor/react/styles.css";

const display = Space_Grotesk({ variable: "--font-display", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

// This used to read the request `host` to build absolute card images, which is
// a per-request server call and the one thing keeping the route dynamic. Social
// cards need absolute URLs, so the public address is baked in at build time
// instead and `metadataBase` resolves the card below against it.
//
// The path matters: the game is served from a subdirectory of the arcade, and a
// card URL with a leading slash would resolve against the origin root instead.
// Hence the relative "og-foundry.png".
const publicUrl = process.env.STARLINE_PUBLIC_URL ??
  "https://victorious-flower-0b12ecd10.7.azurestaticapps.net/games/starline/";

const title = "STARLINE Foundry // Level Editor";
const description = "Build, tune, save, and play custom side-scrolling space shooter levels.";
const card = { url: "og-foundry.png", width: 1536, height: 1024, alt: "Starline Foundry level editor" };

export const metadata: Metadata = {
  metadataBase: new URL(publicUrl),
  title,
  description,
  openGraph: { title, description, images: [card] },
  twitter: { card: "summary_large_image", title, description, images: [card.url] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${display.variable} ${mono.variable}`}>{children}</body></html>;
}
