import { randomBytes } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import sharp from "sharp";

/**
 * Item photos are uploaded through this API, then stored in Cloudinary.
 *
 * A signed browser upload cannot enforce the original file's byte or pixel
 * limits. Cloudinary applies transformations after it accepts the file, and
 * its upload signature ignores resource_type (and file, cloud_name, api_key).
 * A client could reuse a signature against a different resource type. There
 * is also no signed parameter for a maximum incoming size. The browser
 * therefore posts the bytes here. This server rejects oversized or unreadable
 * files before it resizes them, then uploads only the small result.
 *
 * Env: CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
 * The secret is never returned or logged. No upload preset is used.
 *
 * Stored files are type `authenticated`. Item JSON does not include a
 * Cloudinary URL. GET /api/items/:id/photo reads the bytes for the logged-in
 * company and sends Cache-Control: private, no-store. That header asks the
 * browser not to store the response. It does not erase a copy a client already
 * kept, and Cloudinary's invalidate flag only asks Cloudinary to drop its own
 * CDN entry.
 *
 * auth_rate_limits cannot count this. Its action check allows only login,
 * register, forgot_password, and reset_password. A photo action would need a
 * constraint change, which is not approved. The 20-per-15-minute cap is
 * therefore in memory for this process only. Another serverless instance has
 * its own counter.
 *
 * Users and clients have no avatar or logo columns.
 * The column check starts empty in each process.
 */

export const ITEM_PHOTO_MAX_EDGE = 1600;
export const ITEM_PHOTO_MAX_BYTES = 500 * 1024;
export const ITEM_PHOTO_MAX_INCOMING_BYTES = 12 * 1024 * 1024;
export const ITEM_PHOTO_MAX_INCOMING_PIXELS = 50_000_000;
export const ITEM_PHOTO_MAX_INCOMING_EDGE = 9000;
export const ITEM_PHOTO_UPLOADS_PER_WINDOW = 20;
export const ITEM_PHOTO_WINDOW_MS = 15 * 60 * 1000;

const PHOTO_COLUMNS = [
  "image_public_id",
  "image_width",
  "image_height",
  "image_bytes",
  "image_format",
];

let photoColumnsReady = null;
let testStorage;
const uploadTimes = new Map();

export function resetItemPhotosForTests() {
  photoColumnsReady = null;
  testStorage = undefined;
  uploadTimes.clear();
}

export function setPhotoStorageForTests(storage) {
  testStorage = storage;
}

export function readCloudinaryConfig(env = process.env) {
  const raw = env.CLOUDINARY_URL;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "cloudinary:") return null;
  const apiKey = decodeURIComponent(parsed.username || "");
  const apiSecret = decodeURIComponent(parsed.password || "");
  const cloudName = parsed.hostname;
  if (!apiKey || !apiSecret || !cloudName) return null;
  return { apiKey, apiSecret, cloudName };
}

export function photoStorage() {
  if (testStorage !== undefined) return testStorage;
  const config = readCloudinaryConfig();
  if (!config) return null;
  return cloudinaryStorage(config);
}

export function cloudinaryStorage(config) {
  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });
  return {
    async upload(buffer, publicId) {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            public_id: publicId,
            resource_type: "image",
            type: "authenticated",
            overwrite: false,
            format: "webp",
            invalidate: false,
          },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(buffer);
      });
    },
    async destroy(publicId) {
      return cloudinary.uploader.destroy(publicId, {
        resource_type: "image",
        type: "authenticated",
        invalidate: true,
      });
    },
    async download(publicId, format) {
      const url = cloudinary.utils.private_download_url(publicId, format || "webp", {
        cloud_name: config.cloudName,
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        resource_type: "image",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("photo download failed");
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

export async function itemPhotoColumnsReady(db) {
  if (photoColumnsReady != null) return photoColumnsReady;
  try {
    const { rows } = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'items'
         AND column_name = ANY($1::text[])`,
      [PHOTO_COLUMNS]
    );
    const found = new Set(rows.map((row) => row.column_name));
    photoColumnsReady = PHOTO_COLUMNS.every((name) => found.has(name));
    return photoColumnsReady;
  } catch (err) {
    console.error("item photo column check failed");
    return false;
  }
}

export function itemPhotoPublicId(clientId, itemId) {
  return `c/${clientId}/items/${itemId}/${randomBytes(16).toString("hex")}`;
}

export function itemPhotoPublicIdMatches(publicId, clientId, itemId) {
  const prefix = `c/${clientId}/items/${itemId}/`;
  if (typeof publicId !== "string" || !publicId.startsWith(prefix)) return false;
  return /^[a-f0-9]{32}$/.test(publicId.slice(prefix.length));
}

export function consumePhotoUpload(clientId, now = Date.now()) {
  const recent = (uploadTimes.get(clientId) ?? []).filter(
    (at) => now - at < ITEM_PHOTO_WINDOW_MS
  );
  if (recent.length >= ITEM_PHOTO_UPLOADS_PER_WINDOW) {
    uploadTimes.set(clientId, recent);
    return false;
  }
  recent.push(now);
  uploadTimes.set(clientId, recent);
  return true;
}

export function sniffPhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1", "avif"].includes(brand)) {
      return "heic";
    }
  }
  return null;
}

export async function readPhotoBody(req) {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > ITEM_PHOTO_MAX_INCOMING_BYTES) {
    return { error: tooLargeIncoming() };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > ITEM_PHOTO_MAX_INCOMING_BYTES) {
      req.destroy?.();
      return { error: tooLargeIncoming() };
    }
    chunks.push(buf);
  }
  if (total < 1) {
    return {
      error: {
        status: 400,
        code: "PHOTO_INVALID",
        error: "Choose a photo to upload.",
      },
    };
  }
  return { buffer: Buffer.concat(chunks, total) };
}

function tooLargeIncoming() {
  return {
    status: 400,
    code: "PHOTO_TOO_LARGE",
    error: "This photo is too large. Use one under 12 MB.",
  };
}

export async function prepareItemPhoto(buffer) {
  const sniffed = sniffPhoto(buffer);
  if (!sniffed) {
    return {
      ok: false,
      code: "PHOTO_INVALID",
      error: "Use a JPEG, PNG, WebP, or iPhone photo.",
    };
  }

  try {
    const input = sharp(buffer, {
      limitInputPixels: ITEM_PHOTO_MAX_INCOMING_PIXELS,
      failOn: "error",
      animated: false,
    });
    const meta = await input.metadata();
    const width = Number(meta.width);
    const height = Number(meta.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      return {
        ok: false,
        code: "PHOTO_INVALID",
        error: "That photo could not be read. Try another one.",
      };
    }
    if (
      width > ITEM_PHOTO_MAX_INCOMING_EDGE ||
      height > ITEM_PHOTO_MAX_INCOMING_EDGE ||
      width * height > ITEM_PHOTO_MAX_INCOMING_PIXELS
    ) {
      return {
        ok: false,
        code: "PHOTO_TOO_LARGE",
        error: "This photo is too large to store. Try a smaller one.",
      };
    }

    let encoded = null;
    for (const quality of [75, 60, 45, 30]) {
      const result = await sharp(buffer, {
        limitInputPixels: ITEM_PHOTO_MAX_INCOMING_PIXELS,
        failOn: "error",
        animated: false,
      })
        .rotate()
        .resize({
          width: ITEM_PHOTO_MAX_EDGE,
          height: ITEM_PHOTO_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      encoded = result;
      if (result.data.length <= ITEM_PHOTO_MAX_BYTES) break;
    }

    if (!encoded || encoded.data.length > ITEM_PHOTO_MAX_BYTES) {
      return {
        ok: false,
        code: "PHOTO_TOO_LARGE",
        error: "This photo is too large to store. Try a smaller one.",
      };
    }
    if (
      encoded.info.width > ITEM_PHOTO_MAX_EDGE ||
      encoded.info.height > ITEM_PHOTO_MAX_EDGE
    ) {
      return {
        ok: false,
        code: "PHOTO_TOO_LARGE",
        error: "This photo is too large to store. Try a smaller one.",
      };
    }
    return {
      ok: true,
      buffer: encoded.data,
      width: encoded.info.width,
      height: encoded.info.height,
      bytes: encoded.data.length,
      format: "webp",
    };
  } catch {
    return {
      ok: false,
      code: "PHOTO_INVALID",
      error: "That photo could not be read. Try another one.",
    };
  }
}

export function presentItemPhoto(row) {
  if (!row || typeof row !== "object") return row;
  const next = { ...row };
  const hasPhoto = Boolean(next.image_public_id);
  const photo = hasPhoto
    ? {
        width: next.image_width ?? null,
        height: next.image_height ?? null,
        bytes: next.image_bytes ?? null,
        format: next.image_format ?? null,
      }
    : null;
  for (const key of PHOTO_COLUMNS) delete next[key];
  next.photo = photo;
  return next;
}

export function storedPhotoIsSafe(result, publicId) {
  if (!result || result.public_id !== publicId) return false;
  if (result.resource_type && result.resource_type !== "image") return false;
  const format = String(result.format || "webp").toLowerCase();
  if (format !== "webp" && format !== "jpg" && format !== "jpeg") return false;
  const width = Number(result.width);
  const height = Number(result.height);
  const bytes = Number(result.bytes);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width < 1 || height < 1 || width > ITEM_PHOTO_MAX_EDGE || height > ITEM_PHOTO_MAX_EDGE) {
    return false;
  }
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > ITEM_PHOTO_MAX_BYTES) return false;
  return true;
}
