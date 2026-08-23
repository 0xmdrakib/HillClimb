import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/apiProtection";

// Server-side helper for Tip modal: fetch live ETH/USD.
// Primary: Coinbase public spot price endpoint.
// Fallback: CoinGecko simple price.

const RATE_LIMIT = {
  name: "ethusd",
  ip: [
    { limit: 20, windowMs: 60_000 },
    { limit: 200, windowMs: 60 * 60_000 },
  ],
  global: [{ limit: 500, windowMs: 60_000 }],
} as const;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, RATE_LIMIT);
  if (limited) return limited;

  // Coinbase (no auth required)
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
      // keep it fresh but avoid spamming
      next: { revalidate: 30 },
      headers: { "Accept": "application/json" },
    });

    if (r.ok) {
      const j: any = await r.json();
      const usd = Number(j?.data?.amount);
      if (Number.isFinite(usd) && usd > 0) {
        return NextResponse.json({ usd, source: "coinbase" });
      }
    }
  } catch {
    // ignore
  }

  // CoinGecko fallback
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { next: { revalidate: 30 }, headers: { "Accept": "application/json" } },
    );

    if (r.ok) {
      const j: any = await r.json();
      const usd = Number(j?.ethereum?.usd);
      if (Number.isFinite(usd) && usd > 0) {
        return NextResponse.json({ usd, source: "coingecko" });
      }
    }
  } catch {
    // ignore
  }

  return NextResponse.json({ error: "price_unavailable" }, { status: 502 });
}
