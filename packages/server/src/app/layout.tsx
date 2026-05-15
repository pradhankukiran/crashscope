/**
 * Root layout — ships the Tailwind stylesheet and wires `next/font` for the
 * Inter body font + JetBrains Mono for inline code/monospace blocks.
 *
 * The page is committed to a single (light) theme; we do not toggle a `dark`
 * class on the `html` element. `metadata` lives here (not in `page.tsx`) so
 * social previews work for any future sub-page that doesn't override it.
 */
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const SITE_TITLE = "Crashscope — AI-powered error triage";
const SITE_DESCRIPTION =
  "Crashscope joins your error tracker with session replay and uses Claude to produce ranked, actionable triage reports for Slack, the CLI, or your own automation via REST.";
const SITE_URL = "https://crashscope.dev";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: "Crashscope",
  keywords: [
    "error triage",
    "sentry",
    "rollbar",
    "bugsnag",
    "honeybadger",
    "posthog",
    "logrocket",
    "claude",
    "anthropic",
    "incident response",
  ],
  authors: [{ name: "Crashscope" }],
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: "Crashscope",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased">
        <div className="flex min-h-dvh flex-col">{children}</div>
      </body>
    </html>
  );
}
