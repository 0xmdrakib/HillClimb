const DEFAULT_LIGHTHOUSE_DELIVERY_GATEWAY = "https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs";

function normalizedHttpsGateway(value: string | undefined): string {
  const candidate = (value ?? "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(candidate);
    // A syntactically valid HTTPS URL is not sufficient: metadata and image
    // URLs must stay on a dedicated Lighthouse delivery host. Reject inherited
    // generic gateway settings, credential-bearing URLs and extra URL parts.
    if (
      url.protocol === "https:"
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lighthouseweb3\.xyz$/.test(url.hostname)
      && url.pathname === "/ipfs"
      && !url.port
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && !candidate.includes("?")
      && !candidate.includes("#")
    ) return `${url.origin}/ipfs`;
  } catch { /* Use the project's paid Lighthouse gateway. */ }
  return DEFAULT_LIGHTHOUSE_DELIVERY_GATEWAY;
}

/** The project's paid gateway is the sole NFT delivery and verification host. */
export const LIGHTHOUSE_DELIVERY_GATEWAY = normalizedHttpsGateway(
  process.env.NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL,
);
