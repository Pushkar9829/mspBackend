import { EventEmitter } from "events";
import { recordAnalyticsSafe } from "../modules/analytics/ingest.js";

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitDomain(event, payload = {}) {
  recordAnalyticsSafe(event, payload);
  bus.emit(event, payload);
  bus.emit("*", { event, payload });
}
