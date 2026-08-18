import type { Metadata } from "next";
import { StarlineGame } from "./StarlineGame";

// The whole game is a client component, so there is nothing to render per
// request. vinext's build-time classifier cannot prove that by static analysis
// and falls back to treating the route as dynamic, which makes `output:
// "export"` skip it — so say it outright.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "STARLINE Foundry // Level Editor",
  description: "Build, tune, save, and play custom side-scrolling space shooter levels.",
};

export default function Home() {
  return <StarlineGame />;
}
