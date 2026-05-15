/**
 * Landing page — single-page marketing surface assembled from the
 * components in `./components`. Renders entirely on the server; no client-
 * side state.
 */
import { AdapterMatrix } from "./components/AdapterMatrix";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { QuickStart } from "./components/QuickStart";

export default function HomePage(): JSX.Element {
  return (
    <main className="flex-1">
      <Hero />
      <HowItWorks />
      <AdapterMatrix />
      <QuickStart />
      <Footer />
    </main>
  );
}
