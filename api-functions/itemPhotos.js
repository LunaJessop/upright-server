import { pool } from "../lib/db.js";
import {
  consumePhotoUpload,
  itemPhotoColumnsReady,
  itemPhotoPublicId,
  itemPhotoPublicIdMatches,
  photoStorage,
  prepareItemPhoto,
  presentItemPhoto,
  readPhotoBody,
  storedPhotoIsSafe,
} from "../lib/itemPhotos.js";

function storageUnavailable(res) {
  return res.status(503).json({
    error: "Item photos are not set up yet.",
    code: "PHOTO_STORAGE_UNAVAILABLE",
  });
}

function storageUnconfigured(res) {
  return res.status(503).json({
    error: "Photo storage is not configured.",
    code: "PHOTO_STORAGE_UNCONFIGURED",
  });
}

function photoError(res, error) {
  return res.status(error.status || 400).json({ error: error.error, code: error.code });
}

function itemIdFrom(req) {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  return itemId;
}

async function ownedItem(clientId, itemId) {
  const { rows } = await pool.query(
    `SELECT id, image_public_id, image_format
     FROM items
     WHERE id = $1 AND client_id = $2`,
    [itemId, clientId]
  );
  return rows[0] ?? null;
}

async function discardNew(storage, publicId, keepId) {
  if (!publicId || publicId === keepId) return;
  try {
    await storage.destroy(publicId);
  } catch {
    console.error("new photo could not be removed");
  }
}

export async function uploadItemPhoto(req, res) {
  const itemId = itemIdFrom(req);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });
  const { clientId } = req.auth;
  let uploadedId = null;
  let previousId = null;
  let storage = null;

  try {
    if (!(await itemPhotoColumnsReady(pool))) return storageUnavailable(res);
    const item = await ownedItem(clientId, itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });
    previousId = item.image_public_id || null;
    if (!consumePhotoUpload(clientId)) {
      return res.status(429).json({
        error: "Too many photo uploads. Try again in a few minutes.",
        code: "PHOTO_RATE_LIMITED",
      });
    }

    const incoming = await readPhotoBody(req);
    if (incoming.error) return photoError(res, incoming.error);

    const prepared = await prepareItemPhoto(incoming.buffer);
    if (!prepared.ok) return photoError(res, prepared);

    storage = photoStorage();
    if (!storage) return storageUnconfigured(res);

    const publicId = itemPhotoPublicId(clientId, itemId);
    let stored;
    try {
      stored = await storage.upload(prepared.buffer, publicId);
    } catch {
      console.error("photo upload failed");
      return res.status(502).json({ error: "The photo could not be stored. Try again." });
    }
    uploadedId = stored?.public_id === publicId ? publicId : null;
    const safe = storedPhotoIsSafe(
      {
        ...stored,
        width: stored?.width ?? prepared.width,
        height: stored?.height ?? prepared.height,
        bytes: stored?.bytes ?? prepared.bytes,
        format: stored?.format ?? prepared.format,
        resource_type: stored?.resource_type ?? "image",
      },
      publicId
    );
    if (!uploadedId || !safe) {
      if (stored?.public_id === publicId) {
        await discardNew(storage, publicId, previousId);
      }
      uploadedId = null;
      return res.status(400).json({
        error: "This photo is too large to store. Try a smaller one.",
        code: "PHOTO_TOO_LARGE",
      });
    }

    const { rows } = await pool.query(
      `UPDATE items
       SET image_public_id = $1,
           image_width = $2,
           image_height = $3,
           image_bytes = $4,
           image_format = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND client_id = $7
       RETURNING id, image_public_id, image_width, image_height, image_bytes, image_format`,
      [
        uploadedId,
        Number(stored.width ?? prepared.width),
        Number(stored.height ?? prepared.height),
        Number(stored.bytes ?? prepared.bytes),
        String(stored.format ?? prepared.format).toLowerCase(),
        itemId,
        clientId,
      ]
    );
    if (!rows[0]) {
      await discardNew(storage, uploadedId, previousId);
      uploadedId = null;
      return res.status(404).json({ error: "Item not found" });
    }

    if (
      previousId &&
      previousId !== uploadedId &&
      itemPhotoPublicIdMatches(previousId, clientId, itemId)
    ) {
      try {
        await storage.destroy(previousId);
      } catch {
        console.error("previous photo could not be removed");
      }
    }
    uploadedId = null;
    res.json({ photo: presentItemPhoto(rows[0]).photo });
  } catch {
    if (storage && uploadedId) await discardNew(storage, uploadedId, previousId);
    console.error("photo save failed");
    res.status(500).json({ error: "Failed to save photo" });
  }
}

export async function getItemPhoto(req, res) {
  const itemId = itemIdFrom(req);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });
  const { clientId } = req.auth;

  try {
    if (!(await itemPhotoColumnsReady(pool))) return storageUnavailable(res);
    const item = await ownedItem(clientId, itemId);
    if (!item?.image_public_id) {
      return res.status(404).json({ error: "This item has no photo." });
    }
    if (!itemPhotoPublicIdMatches(item.image_public_id, clientId, itemId)) {
      return res.status(404).json({ error: "This item has no photo." });
    }
    const storage = photoStorage();
    if (!storage) return storageUnconfigured(res);
    const bytes = await storage.download(item.image_public_id, item.image_format || "webp");
    const format = item.image_format === "jpeg" || item.image_format === "jpg" ? "jpeg" : "webp";
    res.setHeader("Content-Type", `image/${format}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(bytes);
  } catch {
    console.error("photo read failed");
    res.status(502).json({ error: "The photo could not be loaded. Try again." });
  }
}

export async function deleteItemPhoto(req, res) {
  const itemId = itemIdFrom(req);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });
  const { clientId } = req.auth;

  try {
    if (!(await itemPhotoColumnsReady(pool))) return storageUnavailable(res);
    const item = await ownedItem(clientId, itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (!item.image_public_id) {
      return res.status(404).json({ error: "This item has no photo." });
    }
    if (!itemPhotoPublicIdMatches(item.image_public_id, clientId, itemId)) {
      return res.status(409).json({
        error: "That photo does not belong to this item.",
        code: "PHOTO_WRONG_ITEM",
      });
    }

    const storage = photoStorage();
    if (!storage) return storageUnconfigured(res);
    let destroyed;
    try {
      destroyed = await storage.destroy(item.image_public_id);
    } catch {
      console.error("photo delete failed");
      return res.status(502).json({ error: "The photo could not be removed. Try again." });
    }
    if (destroyed?.result !== "ok" && destroyed?.result !== "not found") {
      return res.status(502).json({ error: "The photo could not be removed. Try again." });
    }

    await pool.query(
      `UPDATE items
       SET image_public_id = NULL,
           image_width = NULL,
           image_height = NULL,
           image_bytes = NULL,
           image_format = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND client_id = $2 AND image_public_id = $3`,
      [itemId, clientId, item.image_public_id]
    );
    res.json({ photo: null });
  } catch {
    console.error("photo delete failed");
    res.status(500).json({ error: "Failed to remove photo" });
  }
}
