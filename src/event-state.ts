import type { EngineEmitter } from "./events.js";
import { setMediaSessionPlaybackState, updateMediaSessionMetadata } from "./media-session.js";
import type { TrackChangePayload } from "./types.js";

/** Committed state shared by both modes, independent of native event counts. */
export class EngineEventState {
  private selection: string | undefined;
  private _playing = false;
  private ended = false;

  constructor(private emitter: EngineEmitter) {}

  get hasEnded(): boolean {
    return this.ended;
  }

  get playing(): boolean {
    return this._playing;
  }

  select(context: string, payload: TrackChangePayload): boolean {
    const identity = JSON.stringify([context, payload.queueId, payload.index, payload.track.id]);
    updateMediaSessionMetadata(payload.track);
    if (identity === this.selection) return false;
    this.selection = identity;
    this.ended = false;
    this.emitter.emit("trackchange", payload);
    return true;
  }

  clear(): void {
    if (!this.selection) return;
    this.selection = undefined;
    this.ended = false;
    updateMediaSessionMetadata(undefined);
    this.emitter.emit("trackclear");
  }

  setPlaying(playing: boolean): boolean {
    if (playing === this._playing) return false;
    this._playing = playing;
    if (playing) this.ended = false;
    setMediaSessionPlaybackState(playing ? "playing" : "paused");
    this.emitter.emit(playing ? "play" : "pause");
    return true;
  }

  end(): boolean {
    if (this.ended) return false;
    this.setPlaying(false);
    this.ended = true;
    this.emitter.emit("ended");
    return true;
  }
}
