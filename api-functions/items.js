import { pool } from "../index.js";

export async function getItems(_req, res) {
  try {
    const { rows } = await pool.query("SELECT * FROM items ORDER BY id");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
}
