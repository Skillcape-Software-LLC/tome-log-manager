import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const sql = postgres(connectionString, {
  max: 10,              // connection pool size
  idle_timeout: 30,     // close idle connections after 30s
  connect_timeout: 5,   // fail fast if DB unreachable
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await sql.end({ timeout: 5 });
  process.exit(0);
});
