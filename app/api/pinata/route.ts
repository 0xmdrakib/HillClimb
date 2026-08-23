import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  readBodyWithLimit,
  requestTooLargeResponse,
  RequestBodyTooLargeError,
} from "@/lib/apiProtection";

export const runtime = "nodejs";

type Body = {
  imageDataUrl: string;
  tokenId: string; // stringified uint256
  driverName: string;
  driverId: number;
  meters: number;
  gameUrl?: string;
};

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const RATE_LIMIT = {
  name: "pinata",
  ip: [
    { limit: 5, windowMs: 60_000 },
    { limit: 30, windowMs: 60 * 60_000 },
  ],
  global: [{ limit: 100, windowMs: 60_000 }],
} as const;

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1];
  if (!ALLOWED_IMAGE_TYPES.has(mime.toLowerCase())) throw new Error("Unsupported image type");
  const b64 = m[2];
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("Image is empty");
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds 4 MB");
  return { mime, bytes: new Uint8Array(buf) };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, RATE_LIMIT);
  if (limited) return limited;

  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: Body;
  try {
    body = JSON.parse(await readBodyWithLimit(req, MAX_BODY_BYTES)) as Body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestTooLargeResponse(error);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const imageDataUrl = String(body.imageDataUrl || "");
    const tokenId = String(body.tokenId || "").trim();
    const driverName = (String(body.driverName || "").trim() || "Driver").slice(0, 40);
    const driverId = Number(body.driverId ?? 0);
    const meters = Math.max(0, Math.floor(Number(body.meters ?? 0)));
    const gameUrl = typeof body.gameUrl === "string" ? body.gameUrl : undefined;

    if (!imageDataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "imageDataUrl must be a data URL" }, { status: 400 });
    }
    if (!/^\d{1,78}$/.test(tokenId)) {
      return NextResponse.json({ error: "tokenId must be a uint256 decimal string" }, { status: 400 });
    }

    const jwt = (process.env.PINATA_JWT ?? "").trim();
    if (!jwt) {
      // Dev fallback: return a data: tokenURI (not ideal for production, but keeps app usable).
      const name = `Jesse Hill Climb #${tokenId} — ${driverName} — ${meters}m`;
      const metadata = {
        name,
        description: "An onchain run from Jesse Hill Climb (Base app).",
        image: imageDataUrl,
        external_url: gameUrl,
        attributes: [
          { trait_type: "Driver", value: driverName },
          { trait_type: "DriverId", value: driverId },
          { trait_type: "Meters", value: meters },
          { trait_type: "Run", value: tokenId },
          { trait_type: "Chain", value: "Base" },
        ],
      };

      const tokenUri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
      return NextResponse.json({ tokenUri, mode: "datauri" });
    }

    const { mime, bytes } = parseDataUrl(imageDataUrl);

    // 1) Pin image
    const imgForm = new FormData();
    const imgBlob = new Blob([toArrayBuffer(bytes)], { type: mime || "image/png" });
    imgForm.append("file", imgBlob, `run_${tokenId}.png`);

    const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      body: imgForm,
    });

    if (!imgRes.ok) {
      const t = await imgRes.text();
      return NextResponse.json({ error: `Pinata image upload failed: ${t}` }, { status: 502 });
    }

    const imgJson: any = await imgRes.json();
    const imageCid = String(imgJson?.IpfsHash || imgJson?.Hash || "");
    if (!imageCid) return NextResponse.json({ error: "Pinata image response missing IpfsHash" }, { status: 502 });

    // 2) Pin metadata JSON
    const name = `Jesse Hill Climb #${tokenId} — ${driverName} — ${meters}m`;
    const metadata = {
      name,
      description: "An onchain run from Jesse Hill Climb (Base app).",
      image: `ipfs://${imageCid}`,
      external_url: gameUrl,
      attributes: [
        { trait_type: "Driver", value: driverName },
        { trait_type: "DriverId", value: driverId },
        { trait_type: "Meters", value: meters },
        { trait_type: "Run", value: tokenId },
        { trait_type: "Chain", value: "Base" },
      ],
    };

    const metaRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    });

    if (!metaRes.ok) {
      const t = await metaRes.text();
      return NextResponse.json({ error: `Pinata metadata upload failed: ${t}` }, { status: 502 });
    }

    const metaJson: any = await metaRes.json();
    const metadataCid = String(metaJson?.IpfsHash || metaJson?.Hash || "");
    if (!metadataCid) return NextResponse.json({ error: "Pinata metadata response missing IpfsHash" }, { status: 502 });

    const tokenUri = `ipfs://${metadataCid}`;
    return NextResponse.json({ tokenUri, imageCid, metadataCid, mode: "pinata" });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
