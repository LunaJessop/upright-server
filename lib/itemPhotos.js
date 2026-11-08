import { randomBytes, timingSafeEqual } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";

/**
 * Item photos.
 *
 * Env: CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
 * The API secret stays on the server. Responses include the cloud name and
 * the public API key only because Cloudinary's browser upload requires them.
 *
 * Storage type is `authenticated`, not public. A signed delivery URL is
 * minted for the logged-in company. That signature does not expire by itself;
 * replacing or deleting the photo invalidates it. There is no upload preset.
 *
 * Incoming formats: JPEG, PNG, WebP, HEIC/HEIF. Cloudinary stores a WebP
 * resized to fit inside 1600×1600 at quality 75. The server rejects the saved
 * file when it is over 500 KB, not WebP/JPEG, or larger than 1600 px.
 *
 * Users and clients have no avatar or logo columns. Those are not uploaded here.
 *
 * The column check is remembered in memory and starts empty on each process,
 * so a deploy picks up the columns on the first photo request.
 */

export const ITEM_PHOTO_MAX_EDGE = 1600;
export const ITEM_PHOTO_MAX_BYTES = 500 * 1024;
export const ITEM_PHOTO_UPLOADS_PER_WINDOW = 20;
export const ITEM_PHOTO_WINDOW_MS = 15 * 60 * 1000;

const PHOTO_COLUMNS = [
  "image_public_id",
  "image_width",
  "image_height",
  "image_bytes",
  "image_format",
];

const INPUT_FORMATS = "heic,heif,jpeg,jpg,png,webp";
const STORED_FORMATS = new Set(["webp", "jpg", "jpeg"]);

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
  return {
    config,
    signUpload(params) {
      return cloudinary.utils.api_sign_request(params, config.apiSecret);
    },
    deliveryUrl(publicId, format) {
      return cloudinary.url(publicId, {
        cloud_name: config.cloudName,
        api_secret: config.apiSecret,
        secure: true,
        sign_url: true,
        type: "authenticated",
        resource_type: "image",
        format: format || "webp",
        analytics: false,
        urlAnalytics: false,
      });
    },
    fetchResource(publicId) {
      cloudinary.config({
        cloud_name: config.cloudName,
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        secure: true,
      });
      return cloudinary.api.resource(publicId, {
        resource_type: "image",
        type: "authenticated",
      });
    },
    destroy(publicId) {
      cloudinary.config({
        cloud_name: config.cloudName,
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        secure: true,
      });
      return cloudinary.uploader.destroy(publicId, {
        resource_type: "image",
        type: "authenticated",
        invalidate: true,
      });
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
    console.error(err);
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

export function uploadSignature(clientId, itemId, nowSec = Math.floor(Date.now() / 1000)) {
  const active = photoStorage();
  if (!active) return null;
  const publicId = itemPhotoPublicId(clientId, itemId);
  const params = {
    allowed_formats: INPUT_FORMATS,
    public_id: publicId,
    timestamp: nowSec,
    transformation: "c_limit,h_1600,w_1600/f_webp/q_75",
    type: "authenticated",
  };
  return {
    cloudName: active.config.cloudName,
    apiKey: active.config.apiKey,
    url: `https://api.cloudinary.com/v1_1/${active.config.cloudName}/image/upload`,
    fields: {
      ...params,
      signature: active.signUpload(params),
    },
  };
}

export function presentItemPhoto(row) {
  if (!row || typeof row !== "object") return row;
  const next = { ...row };
  const publicId = next.image_public_id;
  const width = next.image_width ?? null;
  const height = next.image_height ?? null;
  const bytes = next.image_bytes ?? null;
  const format = next.image_format ?? null;
  for (const key of PHOTO_COLUMNS) delete next[key];
  if (!publicId) {
    next.photo = null;
    return next;
  }
  const active = photoStorage();
  const url = active ? active.deliveryUrl(publicId, format) : null;
  next.photo = { url, width, height, bytes, format };
  return next;
}

export function assessStoredPhoto(resource) {
  if (!resource || resource.resource_type !== "image") {
    return { ok: false, code: "PHOTO_INVALID", error: "Use a JPEG, PNG, WebP, or iPhone photo." };
  }
  const format = String(resource.format || "").toLowerCase();
  if (!STORED_FORMATS.has(format)) {
    return { ok: false, code: "PHOTO_INVALID", error: "Use a JPEG, PNG, WebP, or iPhone photo." };
  }
  const width = Number(resource.width);
  const height = Number(resource.height);
  const bytes = Number(resource.bytes);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return { ok: false, code: "PHOTO_INVALID", error: "That photo could not be read. Try another one." };
  }
  if (width > ITEM_PHOTO_MAX_EDGE || height > ITEM_PHOTO_MAX_EDGE) {
    return {
      ok: false,
      code: "PHOTO_TOO_LARGE",
      error: "This photo is too large to store. Try a smaller one.",
    };
  }
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > ITEM_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      code: "PHOTO_TOO_LARGE",
      error: "This photo is too large to store. Try a smaller one.",
    };
  }
  return { ok: true, width, height, bytes, format };
}

export function signatureMatches(params, signature, apiSecret) {
  const expected = cloudinary.utils.api_sign_request(params, apiSecret);
  const left = Buffer.from(String(signature));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
