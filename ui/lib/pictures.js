// Pictures on a sheet: kept as given in assets/; converted only when a copy is made.
import { base64 } from "./copies.js";

export const PICTURE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
export const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
export const mimeOf = (file) => MIME[extOf(file)] || "application/octet-stream";
export const dataUrl = (bytes, file) => `data:${mimeOf(file)};base64,${base64(bytes)}`;

const MAX_SIDE = 2400; // pixels; enough to print a full page width at 300 dpi or so

/**
 * Browser only (the app): a picture as the PDF writer wants it, {kind, w, h, data}.
 * Drawn through a canvas, so a phone photo comes out the right way up (its EXIF turn applied) and very large
 * pictures are scaled down. Photos (JPEG) stay JPEG; anything else becomes lossless deflated RGB, which keeps
 * screenshots and drawings sharp. Transparent areas print white.
 */
export async function pdfImage(bytes, file) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mimeOf(file) }));
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  if (/^jpe?g$/.test(extOf(file))) {
    const blob = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.9));
    return { kind: "jpeg", w, h, data: new Uint8Array(await blob.arrayBuffer()) };
  }
  const rgba = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) (rgb[j] = rgba[i]), (rgb[j + 1] = rgba[i + 1]), (rgb[j + 2] = rgba[i + 2]);
  // CompressionStream "deflate" is zlib format, which is what the PDF's /FlateDecode reads
  const data = new Uint8Array(await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  return { kind: "rgb", w, h, data };
}
