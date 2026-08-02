/**
 * Resolve tag payloads (ids and/or names) for a client and sync item_tags.
 * @param {import("pg").PoolClient} dbClient
 * @param {number} clientId
 * @param {number} itemId
 * @param {unknown} tagsInput
 * @returns {Promise<{id: number, name: string}[]>}
 */
export async function syncItemTags(dbClient, clientId, itemId, tagsInput) {
  const entries = Array.isArray(tagsInput) ? tagsInput : [];
  const tagIds = new Set();

  for (const entry of entries) {
    if (entry == null) continue;

    if (typeof entry === "number" || typeof entry === "bigint") {
      const id = Number(entry);
      if (!Number.isFinite(id)) continue;
      const { rows } = await dbClient.query(
        `SELECT id FROM tags WHERE id = $1 AND client_id = $2`,
        [id, clientId]
      );
      if (rows[0]) tagIds.add(rows[0].id);
      continue;
    }

    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      tagIds.add(await upsertTagId(dbClient, clientId, trimmed));
      continue;
    }

    if (typeof entry === "object") {
      const id = entry.id != null ? Number(entry.id) : null;
      if (Number.isFinite(id)) {
        const { rows } = await dbClient.query(
          `SELECT id FROM tags WHERE id = $1 AND client_id = $2`,
          [id, clientId]
        );
        if (rows[0]) {
          tagIds.add(rows[0].id);
          continue;
        }
      }
      const name = String(entry.name ?? "").trim();
      if (!name) continue;
      tagIds.add(await upsertTagId(dbClient, clientId, name));
    }
  }

  await dbClient.query(`DELETE FROM item_tags WHERE item_id = $1`, [itemId]);
  for (const tagId of tagIds) {
    await dbClient.query(
      `INSERT INTO item_tags (item_id, tag_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [itemId, tagId]
    );
  }

  const { rows } = await dbClient.query(
    `SELECT t.id, t.name
     FROM tags t
     JOIN item_tags it ON it.tag_id = t.id
     WHERE it.item_id = $1
     ORDER BY lower(t.name) ASC`,
    [itemId]
  );
  return rows;
}

async function upsertTagId(dbClient, clientId, name) {
  const existing = await dbClient.query(
    `SELECT id FROM tags WHERE client_id = $1 AND lower(name) = lower($2)`,
    [clientId, name]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  try {
    const inserted = await dbClient.query(
      `INSERT INTO tags (client_id, name) VALUES ($1, $2) RETURNING id`,
      [clientId, name]
    );
    return inserted.rows[0].id;
  } catch (err) {
    if (err.code === "23505") {
      const again = await dbClient.query(
        `SELECT id FROM tags WHERE client_id = $1 AND lower(name) = lower($2)`,
        [clientId, name]
      );
      if (again.rows[0]) return again.rows[0].id;
    }
    throw err;
  }
}
