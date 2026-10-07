import postgres from "postgres";

let _sql;

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING
  );
}

export function getSql() {
  if (_sql) return _sql;

  const url = getDatabaseUrl();
  if (!url) {
    throw new Error(
      "Database not configured. Set DATABASE_URL (or POSTGRES_URL) in your environment.",
    );
  }

  _sql = postgres(url, {
    ssl: process.env.NODE_ENV === "production" ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    // Schema initialisation uses IF NOT EXISTS everywhere; the resulting
    // "already exists, skipping" notices are expected and only add log noise.
    onnotice: () => {},
  });

  return _sql;
}

