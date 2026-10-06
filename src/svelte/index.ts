import { readable, type Readable } from "svelte/store";
import type { AudioEngine } from "../engine.js";
import type { EngineMode, TrackMeta } from "../types.js";

export type AudioEngineStore = {
  playing: boolean;
  currentTime: number;
  duration: number;
  currentIndex: number;
  currentMeta: TrackMeta | undefined;
  queueId: string | undefined;
  mode: EngineMode | null;
};

/**
 * Thin Svelte readable store mirroring AudioEngine state.
 * Playback actions stay on the engine instance.
 */
export function createAudioStore(
  engine: AudioEngine,
): Readable<AudioEngineStore> {
  const snapshot = (): AudioEngineStore => ({
    playing: engine.playing,
    currentTime: engine.currentTime,
    duration: engine.duration,
    currentIndex: engine.currentIndex,
    currentMeta: engine.currentMeta,
    queueId: engine.queueId,
    mode: engine.mode,
  });

  return readable(snapshot(), (set) => {
    const refresh = () => set(snapshot());
    const unsubs = [
      engine.on("play", refresh),
      engine.on("pause", refresh),
      engine.on("trackchange", refresh),
      engine.on("trackclear", refresh),
      engine.on("timeupdate", refresh),
      engine.on("ended", refresh),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  });
}
