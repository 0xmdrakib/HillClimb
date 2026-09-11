import {
  CAREncoderStream,
  createFileEncoderStream,
  type Block,
} from "ipfs-car";
import { LIGHTHOUSE_DELIVERY_GATEWAY } from "@/lib/nftGateway";

const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 540;
const JPEG_QUALITY = 0.9;

export type RunNftPackage = {
  carBase64: string;
  carBytes: number;
  imageBytes: number;
  rootCid: string;
  tokenUri: string;
};

type RunNftPackageInput = {
  snapshotDataUrl: string;
  meters: number;
  coins: number;
  driver: string;
  vehicle: string;
  terrain: string;
  result: "Crash" | "Out of fuel";
  siteUrl: string;
};

function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not prepare the run image"));
    };
    image.src = objectUrl;
  });
}

async function compressSnapshot(dataUrl: string): Promise<Blob> {
  if (!dataUrl.startsWith("data:image/")) throw new Error("Run snapshot is unavailable");

  const source = await fetch(dataUrl).then((response) => response.blob());
  const image = await imageFromBlob(source);
  const scale = Math.min(1, IMAGE_WIDTH / image.naturalWidth, IMAGE_HEIGHT / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not prepare the run image");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);

  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!jpeg) throw new Error("Could not compress the run image");
  return jpeg;
}

async function collectBlocks(stream: ReadableStream<Block>): Promise<Block[]> {
  const blocks: Block[] = [];
  await stream.pipeTo(new WritableStream<Block>({ write: (block) => { blocks.push(block); } }));
  if (blocks.length === 0) throw new Error("Could not build the IPFS package");
  return blocks;
}

async function encodeCar(blocks: Block[], roots: Block["cid"][]): Promise<Uint8Array> {
  const blockStream = new ReadableStream<Block>({
    start(controller) {
      for (const block of blocks) controller.enqueue(block);
      controller.close();
    },
  });
  const carStream = blockStream.pipeThrough(new CAREncoderStream(roots));
  return new Uint8Array(await new Response(carStream).arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Build the complete IPFS archive locally. Nothing is uploaded here. */
export async function buildRunNftPackage(input: RunNftPackageInput): Promise<RunNftPackage> {
  const imageBlob = await compressSnapshot(input.snapshotDataUrl);
  const imageFile = new File([imageBlob], "run.jpg", { type: "image/jpeg" });
  const imageBlocks = await collectBlocks(createFileEncoderStream(imageFile));
  const imageRoot = imageBlocks.at(-1)!.cid;
  const imageCid = imageRoot.toString();
  const imageGatewayUrl = `${LIGHTHOUSE_DELIVERY_GATEWAY}/${imageCid}`;
  const meters = Math.max(0, Math.floor(input.meters));
  const coins = Math.max(0, Math.floor(input.coins));

  const metadata = {
    name: `Jesse Hill Climb — ${meters}m Run`,
    description: "A hill-climb run captured at the finish on Base.",
    // Use the project's paid content-addressed gateway for marketplace delivery.
    // The canonical IPFS URI remains in properties.files below.
    image: imageGatewayUrl,
    external_url: input.siteUrl,
    background_color: "EAF3F8",
    attributes: [
      { trait_type: "Distance", value: meters, display_type: "number" },
      { trait_type: "Driver", value: input.driver },
      { trait_type: "Vehicle", value: input.vehicle },
      { trait_type: "Terrain", value: input.terrain },
      { trait_type: "Coins collected", value: coins, display_type: "number" },
      { trait_type: "Result", value: input.result },
    ],
    properties: {
      category: "image",
      files: [{ uri: `ipfs://${imageCid}`, type: "image/jpeg" }],
    },
  };

  const metadataFile = new File(
    [JSON.stringify(metadata)],
    "metadata.json",
    { type: "application/json" },
  );
  const metadataBlocks = await collectBlocks(createFileEncoderStream(metadataFile));
  const metadataRoot = metadataBlocks.at(-1)!.cid;
  const metadataCid = metadataRoot.toString();
  // Both files are CAR roots. Lighthouse pins the exact metadata and image CIDs
  // only after the mint succeeds.
  const car = await encodeCar([...metadataBlocks, ...imageBlocks], [metadataRoot, imageRoot]);

  return {
    carBase64: bytesToBase64(car),
    carBytes: car.byteLength,
    imageBytes: imageBlob.size,
    rootCid: metadataCid,
    // The URL remains immutable and content-addressed while using the paid
    // Lighthouse delivery gateway configured for this project.
    tokenUri: `${LIGHTHOUSE_DELIVERY_GATEWAY}/${metadataCid}`,
  };
}
