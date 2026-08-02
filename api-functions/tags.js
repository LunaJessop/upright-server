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
