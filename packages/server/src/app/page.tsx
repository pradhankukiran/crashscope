/**
 * Landing page — single-page marketing surface assembled from the components
 * in `./components`. The page itself stays a server component; only the
 * "Try it now" block ({@link DemoSection}) is a client island.
 *
 * Vertical rhythm comes from each child section's own padding, so we don't
 * need wrappers here.
 */
import { AdapterMatrix } from "./components/AdapterMatrix";
import { DemoSection } from "./components/DemoSection";
import { Deploy } from "./components/Deploy";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { QuickStart } from "./components/QuickStart";

export default function HomePage(): JSX.Element {
  return (
    <main className="flex-1">
      <Hero />
      <DemoSection />
      <HowItWorks />
      <AdapterMatrix />
      <QuickStart />
      <Deploy />
    </main>
  );
}
