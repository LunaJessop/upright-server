import pg from "pg";

const { Pool } = pg;

const pooledUrl = process.env.DATABASE_URL?.trim();
if (!pooledUrl) {
  throw new Error(
    "DATABASE_URL is required. Use Neon’s pooled connection string (ends with -pooler).",
  );
}

function poolOptions(connectionString) {
  const isNeon = connectionString.includes("neon.tech");
  return {
    connectionString,
    ...(isNeon ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

/** Pooled connections for the API (Neon pooler / DATABASE_URL). */
export const pool = new Pool(poolOptions(pooledUrl));

const unpooledUrl = process.env.DATABASE_URL_UNPOOLED?.trim();

/** Direct Neon session for migrations or long transactions; omit if unused. */
export const unpooledPool = unpooledUrl
  ? new Pool(poolOptions(unpooledUrl))
  : null;

export async function closePool() {
  await pool.end();
  if (unpooledPool) await unpooledPool.end();
}
