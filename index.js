import "dotenv/config";
import cors from "cors";
import express from "express";
import pg from "pg";
import { getItems } from "./api-functions/items.js";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required. Use Neon's pooled connection string (ends with -pooler).",
  );
}

export const pool = new Pool({
  connectionString,
  ...(connectionString.includes("neon.tech")
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/items", getItems);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Vercel: the default export IS the handler — no listen() needed
export default app;

// Local dev: bind a port as usual
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}, closing server and database pool…`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}