import { writeFile } from "node:fs/promises";
import { assertProductionSecrets, config } from "./config.js";
import { closeDatabase, query } from "./db.js";
import { reclaimStuckMessages, recordHeartbeat, runWorkerTick, workerId } from "./worker-service.js";
import { tickSchedules } from "./scheduler.js";

let stopping = false;
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Bản trước: một lỗi bất kỳ trong runWorkerTick (ví dụ DB chớp tắt) làm main()
 * reject và worker thoát hẳn — mà compose lại không có restart policy, nên
 * worker nằm luôn trong khi healthcheck vẫn báo xanh vì nó chỉ kiểm tra sự tồn
 * tại của một file ghi lúc khởi động.
 *
 * Bản này: vòng lặp tự phục hồi sau lỗi tạm thời, chỉ thoát khi lỗi liên tiếp
 * vượt ngưỡng (để orchestrator restart container sạch sẽ).
 */
const MAX_CONSECUTIVE_FAILURES = 10;

async function main() {
  assertProductionSecrets();
  await query("SELECT 1");
  await recordHeartbeat("starting");
  await writeFile("/tmp/tm-worker-ready", new Date().toISOString(), "utf8");
  console.log(`TM worker ${workerId} started in ${config.APP_ENV} as PID ${process.pid}`);

  let consecutiveFailures = 0;
  let lastHeartbeat = 0;
  let lastReclaim = Date.now();
  let lastSchedule = 0;

  while (!stopping) {
    let worked = false;
    try {
      worked = await runWorkerTick();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Worker tick failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, message);
      await recordHeartbeat("running", message).catch(() => undefined);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`Worker dừng sau ${consecutiveFailures} lỗi liên tiếp: ${message}`);
      }
      // Backoff tăng dần, tối đa 5 giây.
      await wait(Math.min(5_000, 200 * consecutiveFailures));
    }

    // Heartbeat để API/UI biết worker còn sống — healthcheck theo file không
    // phát hiện được worker treo.
    const now = Date.now();
    if (now - lastHeartbeat >= config.WORKER_HEARTBEAT_SECONDS * 1000) {
      lastHeartbeat = now;
      await recordHeartbeat("running").catch((error) => console.error("Heartbeat failed", error));
      await writeFile("/tmp/tm-worker-ready", new Date().toISOString(), "utf8").catch(() => undefined);
    }

    // Quét tin nhắn kẹt mỗi phút — rẻ, và là lưới an toàn cho trường hợp
    // tiến trình chết giữa các pha của processConversation.
    if (now - lastReclaim >= 60_000) {
      lastReclaim = now;
      await reclaimStuckMessages().catch((error) => console.error("Reclaim failed", error));
    }

    // Quét lịch định kỳ mỗi 30 giây. Cron nhỏ nhất là phút nên thế là đủ.
    if (now - lastSchedule >= 30_000) {
      lastSchedule = now;
      const queued = await tickSchedules().catch((error) => {
        console.error("Scheduler failed", error);
        return 0;
      });
      if (queued) console.log(`Scheduler đẩy ${queued} job theo lịch`);
    }

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
  .finally(async () => {
    await recordHeartbeat("stopped").catch(() => undefined);
    await closeDatabase();
  });
