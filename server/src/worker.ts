import { writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { closeDatabase, query } from "./db.js";
import { runWorkerTick } from "./worker-service.js";

let stopping = false;
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  await query("SELECT 1");
  await writeFile("/tmp/tm-worker-ready", new Date().toISOString(), "utf8");
  console.log(`TM worker started in ${config.APP_ENV} as PID ${process.pid}`);
  while (!stopping) {
    const worked = await runWorkerTick();
    if (!worked) await wait(400);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

main()
  .catch((error) => {
    console.error("Worker fatal error", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

