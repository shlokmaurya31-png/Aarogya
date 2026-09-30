import { NextRequest } from "next/server";
import { getStorageAdapter, verifyDownloadToken, sniffContentType } from "@/lib/storage";

/**
 * Phase 1.1 — token-gated download for the local-disk storage adapter.
 *
 * The token IS the capability: it is minted only from authenticated, authorised,
 * audited code paths (via adapter.signedDownloadUrl) and names exactly one
 * storageRef with a short expiry. This route verifies the HMAC + expiry and
 * streams the bytes; it grants nothing a valid token does not already authorise.
 *
 * When the S3 adapter is active, downloads use provider-native presigned URLs
 * and never reach this route.
 */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

  const storageRef = verifyDownloadToken(token);
  if (!storageRef) return new Response("Invalid or expired token", { status: 403 });

  try {
    const { bytes } = await getStorageAdapter().get(storageRef);
    const contentType = sniffContentType(bytes) ?? "application/octet-stream";
    const filename = storageRef.split("/").pop() ?? "file";
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
