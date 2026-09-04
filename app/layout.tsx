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

const SITE_URL = (process.env.NEXT_PUBLIC_URL || "https://jessehillclimb.online").replace(/\/+$/, "");
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Jesse Hill Climb";
const BASE_APP_ID = (process.env.NEXT_PUBLIC_BASE_APP_ID || "6976213f88e3bac59cf3d818").trim();
const DESCRIPTION = "Jesse Hill Climb, an onchain hill climb racing game on Base.";
const imageUrl = `${SITE_URL}/social-card-v4.jpg`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: APP_NAME,
  description: DESCRIPTION,
  alternates: {
    canonical: SITE_URL,
  },
  robots: {
    index: true,
    follow: true,
  },
  other: {
    // Redundant with app/head.tsx, but required by some Base verification paths.
    "base:app_id": BASE_APP_ID,
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: APP_NAME,
    locale: "en_US",
    title: APP_NAME,
    description: DESCRIPTION,
    images: [
      {
        url: imageUrl,
        width: 1200,
        height: 630,
        type: "image/jpeg",
        alt: "Jesse Hill Climb racing game",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: APP_NAME,
    description: DESCRIPTION,
    images: [
      {
        url: imageUrl,
        width: 1200,
        height: 630,
        alt: "Jesse Hill Climb racing game",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
