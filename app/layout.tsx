import "./globals.css";
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// IMPORTANT:
// Base's "Verify & Add URL" checks for <meta name="base:app_id" ...> in the initial HTML <head>.
// Next.js can stream metadata, which may place tags in <body> in some cases.
// Keep metadata synchronous/static and put base:app_id in app/head.tsx.

const URL = process.env.NEXT_PUBLIC_URL || "https://jessehillclimb.online";
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Jesse Hill Climb";
const BASE_APP_ID = (process.env.NEXT_PUBLIC_BASE_APP_ID || "6976213f88e3bac59cf3d818").trim();

const imageUrl = process.env.NEXT_PUBLIC_APP_HERO_IMAGE || `${URL}/embed.png`;

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Jesse Hill Climb, an onchain hill climb racing game on Base.",
  other: {
    // Redundant with app/head.tsx, but required by some Base verification paths.
    "base:app_id": BASE_APP_ID,
  },
  openGraph: {
    title: APP_NAME,
    description: "Jesse Hill Climb, an onchain hill climb racing game on Base.",
    images: [{ url: imageUrl }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
