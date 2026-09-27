import { pool } from "../lib/db.js";

export async function getTags(req, res) {
  const { clientId } = req.auth;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, created_at
       FROM tags
       WHERE client_id = $1
       ORDER BY lower(name) ASC`,
      [clientId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch tags" });
  }
}

export async function createTag(req, res) {
  const { clientId } = req.auth;
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    return res.status(400).json({ error: "Tag name is required" });
  }

  try {
    const existing = await pool.query(
      `SELECT id, name, created_at
       FROM tags
       WHERE client_id = $1 AND lower(name) = lower($2)`,
      [clientId, name]
    );
    if (existing.rows[0]) {
      return res.json(existing.rows[0]);
    }

    const { rows } = await pool.query(
      `INSERT INTO tags (client_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [clientId, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      const { rows } = await pool.query(
        `SELECT id, name, created_at
         FROM tags
         WHERE client_id = $1 AND lower(name) = lower($2)`,
        [clientId, name]
      );
      if (rows[0]) return res.json(rows[0]);
      return res.status(409).json({ error: "Tag already exists" });
    }
    res.status(500).json({ error: "Failed to create tag" });
  }
}

function tagIdFromParams(id) {
  const tagId = Number(id);
  if (!Number.isInteger(tagId) || tagId <= 0) return null;
  return tagId;
}

function duplicateTagMessage(name) {
  return `You already have a tag called ${name}.`;
}

export async function updateTag(req, res) {
  const { clientId } = req.auth;
  const tagId = tagIdFromParams(req.params.id);
  if (!tagId) {
    return res.status(404).json({ error: "Tag not found" });
  }

  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    return res.status(400).json({ error: "Tag name is required" });
  }

  try {
    const current = await pool.query(
      `SELECT id FROM tags WHERE id = $1 AND client_id = $2`,
      [tagId, clientId]
    );
    if (!current.rows[0]) {
      return res.status(404).json({ error: "Tag not found" });
    }

    const conflict = await pool.query(
      `SELECT id, name
       FROM tags
       WHERE client_id = $1 AND lower(name) = lower($2) AND id <> $3`,
      [clientId, name, tagId]
    );
    if (conflict.rows[0]) {
      return res.status(409).json({
        error: duplicateTagMessage(conflict.rows[0].name),
      });
    }

    const { rows } = await pool.query(
      `UPDATE tags
       SET name = $1
       WHERE id = $2 AND client_id = $3
       RETURNING id, name, created_at`,
      [name, tagId, clientId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: "Tag not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      const { rows } = await pool.query(
        `SELECT name
         FROM tags
         WHERE client_id = $1 AND lower(name) = lower($2) AND id <> $3`,
        [clientId, name, tagId]
      );
      return res.status(409).json({
        error: duplicateTagMessage(rows[0]?.name ?? name),
      });
    }
    res.status(500).json({ error: "Failed to update tag" });
  }
}

export async function deleteTag(req, res) {
  const { clientId } = req.auth;
  const tagId = tagIdFromParams(req.params.id);
  if (!tagId) {
    return res.status(404).json({ error: "Tag not found" });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const current = await dbClient.query(
      `SELECT id FROM tags WHERE id = $1 AND client_id = $2`,
      [tagId, clientId]
    );
    if (!current.rows[0]) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Tag not found" });
    }

    await dbClient.query(`DELETE FROM item_tags WHERE tag_id = $1`, [tagId]);
    const { rows } = await dbClient.query(
      `DELETE FROM tags
       WHERE id = $1 AND client_id = $2
       RETURNING id`,
      [tagId, clientId]
    );
    if (!rows[0]) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Tag not found" });
    }

    await dbClient.query("COMMIT");
    res.status(204).send();
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to delete tag" });
  } finally {
    dbClient.release();
  }
}
