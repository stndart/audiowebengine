import { createNanoEvents, type Emitter } from "nanoevents";
import type { EngineEvents } from "./types.js";

export type EngineEmitter = Emitter<EngineEvents>;

export function createEngineEmitter(): EngineEmitter {
  return createNanoEvents<EngineEvents>();
}
