import type { NextConfig } from "next";

// Starline is a client-side game: the whole of StarlineGame.tsx is "use client",
// state lives in localStorage, and nothing fetches. The Cloudflare Worker it
// used to build into was scaffolding from the template, not a requirement — so
// it exports to static HTML and joins the rest of the arcade on Azure.
//
// Where the deploy pipeline stages it under the site root. Static export writes
// absolute asset URLs, so this has to be baked in at build time.
//
// `assetPrefix`, not `basePath`: vinext 1.0.0-beta.2's prerender step does not
// prefix its own fetch, so a basePath makes the route fail to export with "RSC
// handler returned 404". assetPrefix is the right tool here anyway — the game is
// a single client-side route with no client navigation, so only asset URLs need
// to know where they live.
const assetPrefix = process.env.STARLINE_ASSET_PREFIX ?? "/games/starline";

const nextConfig: NextConfig = {
  output: "export",
  assetPrefix,
  // Trailing slashes keep `/games/starline/` resolving to index.html on a
  // static host that does no rewriting of its own.
  trailingSlash: true,
  images: {
    // There is no server to run the optimizer endpoint.
    unoptimized: true,
  },
};

export default nextConfig;
