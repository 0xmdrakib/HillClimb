const DEFAULT_LIGHTHOUSE_DELIVERY_GATEWAY = "https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs";

function normalizedHttpsGateway(value: string | undefined): string {
  const candidate = (value ?? "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:") return url.toString().replace(/\/+$/, "");
  } catch { /* Use the project's paid Lighthouse gateway. */ }
  return DEFAULT_LIGHTHOUSE_DELIVERY_GATEWAY;
}

/** The project's paid gateway is the sole NFT delivery and verification host. */
export const LIGHTHOUSE_DELIVERY_GATEWAY = normalizedHttpsGateway(
  process.env.NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL,
);
