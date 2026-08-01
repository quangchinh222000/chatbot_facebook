import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { closeDatabase, pool } from "./db.js";

const sqlDirectory = fileURLToPath(new URL("../sql", import.meta.url));

async function waitForDatabase(maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.log(`Database is not ready; retrying ${attempt}/${maxAttempts}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function migrate() {
  await waitForDatabase();
  await pool.query("CREATE SCHEMA IF NOT EXISTS platform");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(sqlDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of files) {
    const sql = await fs.readFile(path.join(sqlDirectory, filename), "utf8");
    const checksum = Buffer.from(sql).toString("base64url").slice(0, 64);
    const existing = await pool.query<{ checksum: string }>(
      "SELECT checksum FROM platform.schema_migrations WHERE filename = $1",
      [filename]
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.checksum !== checksum) {
        throw new Error(`Migration ${filename} changed after it was applied`);
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO platform.schema_migrations(filename, checksum) VALUES ($1, $2)",
        [filename, checksum]
      );
      await client.query("COMMIT");
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  await pool.query(
    `UPDATE iam.users
     SET email = $1, password_hash = crypt($2, gen_salt('bf', 10)), updated_at = now()
     WHERE id = '00000000-0000-4000-8000-000000000030'`,
    [config.ADMIN_EMAIL, config.ADMIN_PASSWORD]
  );
  if (config.META_PAGE_ID) {
    await pool.query(
      `UPDATE channel.accounts SET provider='facebook_messenger', name=$1, external_page_id=$2,
              graph_version=$3, status='healthy', updated_at=now()
       WHERE id='00000000-0000-4000-8000-000000000100'`,
      [config.META_CHANNEL_NAME, config.META_PAGE_ID, config.META_GRAPH_VERSION]
    );
  }
}

migrate()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error(error);
    await closeDatabase();
    process.exitCode = 1;
  });
