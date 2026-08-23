import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = {
  imageDataUrl: string;
  tokenId: string; // stringified uint256
  driverName: string;
  driverId: number;
  meters: number;
  gameUrl?: string;
};

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, "base64");
  return { mime, bytes: new Uint8Array(buf) };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const imageDataUrl = String(body.imageDataUrl || "");
    const tokenId = String(body.tokenId || "").trim();
    const driverName = String(body.driverName || "").trim() || "Driver";
    const driverId = Number(body.driverId ?? 0);
    const meters = Math.max(0, Math.floor(Number(body.meters ?? 0)));
    const gameUrl = typeof body.gameUrl === "string" ? body.gameUrl : undefined;

    if (!imageDataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "imageDataUrl must be a data URL" }, { status: 400 });
    }
    if (!tokenId) {
      return NextResponse.json({ error: "tokenId is required" }, { status: 400 });
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
