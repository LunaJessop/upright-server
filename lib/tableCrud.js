import { pool } from "../db/pool.js";

export async function listRows(table) {
  const r = await pool.query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return r.rows;
}

export async function getRow(table, id) {
  const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function deleteRow(table, id) {
  const r = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function insertRow(table, body, allowed) {
  const keys = allowed.filter(
    (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined,
  );
  if (keys.length === 0) {
    const err = new Error("No valid fields to insert");
    err.statusCode = 400;
    throw err;
  }
  const vals = keys.map((k) => body[k]);
  const cols = keys.join(", ");
  const ph = keys.map((_, i) => `$${i + 1}`).join(", ");
  const r = await pool.query(
    `INSERT INTO ${table} (${cols}) VALUES (${ph}) RETURNING *`,
    vals,
  );
  return r.rows[0];
}

export async function updateRow(table, id, body, allowed, bumpUpdatedAt) {
  const keys = allowed.filter(
    (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined,
  );
  const sets = [];
  const vals = [];
  let n = 1;
  for (const k of keys) {
    sets.push(`${k} = $${n}`);
    vals.push(body[k]);
    n += 1;
  }
  if (bumpUpdatedAt) {
    sets.push("updated_at = CURRENT_TIMESTAMP");
  }
  if (sets.length === 0) {
    return getRow(table, id);
  }
  vals.push(id);
  const r = await pool.query(
    `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`,
    vals,
  );
  return r.rows[0] ?? null;
}
