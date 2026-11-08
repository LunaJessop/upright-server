import { pool } from "../lib/db.js";
import {
  assessStoredPhoto,
  consumePhotoUpload,
  itemPhotoColumnsReady,
  itemPhotoPublicIdMatches,
  photoStorage,
  presentItemPhoto,
  uploadSignature,
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

function itemIdFrom(req) {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  return itemId;
}

async function ownedItem(clientId, itemId) {
  const { rows } = await pool.query(
    `SELECT id, image_public_id
     FROM items
     WHERE id = $1 AND client_id = $2`,
    [itemId, clientId]
  );
  return rows[0] ?? null;
}

export async function createItemPhotoUpload(req, res) {
  const itemId = itemIdFrom(req);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });
  const { clientId } = req.auth;

  try {
    if (!(await itemPhotoColumnsReady(pool))) return storageUnavailable(res);
    const item = await ownedItem(clientId, itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (!consumePhotoUpload(clientId)) {
      return res.status(429).json({
        error: "Too many photo uploads. Try again in a few minutes.",
        code: "PHOTO_RATE_LIMITED",
      });
    }
    const upload = uploadSignature(clientId, itemId);
    if (!upload) return storageUnconfigured(res);
    res.json({ upload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start photo upload" });
  }
}

export async function saveItemPhoto(req, res) {
  const itemId = itemIdFrom(req);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });
  const { clientId } = req.auth;
  const publicId = req.body?.publicId;
  if (typeof publicId !== "string" || !itemPhotoPublicIdMatches(publicId, clientId, itemId)) {
    return res.status(400).json({
      error: "That photo does not belong to this item.",
      code: "PHOTO_WRONG_ITEM",
    });
  }

  try {
    if (!(await itemPhotoColumnsReady(pool))) return storageUnavailable(res);
    const item = await ownedItem(clientId, itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    const storage = photoStorage();
    if (!storage) return storageUnconfigured(res);

    let resource;
    try {
      resource = await storage.fetchResource(publicId);
    } catch (err) {
      console.error(err?.message || err);
      return res.status(400).json({
        error: "That photo was not found. Upload it again.",
        code: "PHOTO_NOT_FOUND",
      });
    }

    const assessed = assessStoredPhoto(resource);
    if (!assessed.ok) {
      await discard(storage, publicId);
      return res.status(400).json({ error: assessed.error, code: assessed.code });
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
       RETURNING id, name, image_public_id, image_width, image_height, image_bytes, image_format`,
      [
        publicId,
        assessed.width,
        assessed.height,
        assessed.bytes,
        assessed.format,
        itemId,
        clientId,
      ]
    );
    const saved = rows[0];
    if (!saved) {
      await discard(storage, publicId);
      return res.status(404).json({ error: "Item not found" });
    }

    const previous = item.image_public_id;
    if (previous && previous !== publicId) {
      await discard(storage, previous);
    }
    res.json({ photo: presentItemPhoto(saved).photo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save photo" });
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

    const storage = photoStorage();
    if (!storage) return storageUnconfigured(res);
    if (itemPhotoPublicIdMatches(item.image_public_id, clientId, itemId)) {
      const destroyed = await storage.destroy(item.image_public_id);
      if (destroyed?.result !== "ok" && destroyed?.result !== "not found") {
        return res.status(502).json({ error: "The photo could not be removed. Try again." });
      }
    }

    await pool.query(
      `UPDATE items
       SET image_public_id = NULL,
           image_width = NULL,
           image_height = NULL,
           image_bytes = NULL,
           image_format = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND client_id = $2`,
      [itemId, clientId]
    );
    res.json({ photo: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove photo" });
  }
}

async function discard(storage, publicId) {
  try {
    await storage.destroy(publicId);
  } catch (err) {
    console.error(err?.message || err);
  }
}
