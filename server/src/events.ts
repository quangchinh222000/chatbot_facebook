import { EventEmitter } from "node:events";
import pg from "pg";
import { config } from "./config.js";

const { Client } = pg;
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(500);

let listener: pg.Client | null = null;

export async function startEventListener() {
  listener = new Client({ connectionString: config.DATABASE_URL });
  await listener.connect();
  await listener.query("LISTEN tm_events");
  listener.on("notification", (message) => {
    if (!message.payload) return;
    try {
      eventBus.emit("event", JSON.parse(message.payload));
    } catch (error) {
      console.error("Invalid tm_events payload", error);
    }
  });
  listener.on("error", (error) => console.error("PostgreSQL LISTEN error", error));
}

export async function stopEventListener() {
  if (listener) await listener.end();
  listener = null;
}

