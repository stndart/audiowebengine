import type { TrackMeta } from "./types.js";

export type TimelineEntry = {
  id: string;
  title: string;
  artist: string;
  album: string;
  artwork?: TrackMeta["artwork"];
  /** Absolute start offset on the continuous media timeline (seconds). */
  start: number;
  /** Track length in seconds. */
  duration: number;
};

/** Build a virtual track map over a continuous HLS (or concatenated) timeline. */
export function buildTimeline(tracks: TrackMeta[]): TimelineEntry[] {
  let offset = 0;
  const out: TimelineEntry[] = [];
  for (const t of tracks) {
    const duration = Math.max(0.001, t.duration ?? 0.001);
    out.push({
      id: t.id,
      title: t.title,
      artist: t.artist ?? "",
      album: t.album ?? "",
      artwork: t.artwork,
      start: offset,
      duration,
    });
    offset += duration;
  }
  return out;
}

/** Media clocks often land a hair before the exact `start` we seeked to. */
const TIMELINE_INDEX_EPS = 1e-3;

export function findTimelineIndex(timeline: TimelineEntry[], t: number): number {
  if (!timeline.length) return 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (t + TIMELINE_INDEX_EPS >= timeline[i]!.start) return i;
  }
  return 0;
}

/** Seek target inside a timeline entry (avoids landing on the previous track). */
export function timelineSeekTime(
  entry: TimelineEntry,
  offsetSec = 0,
): number {
  const into = Math.min(0.05, Math.max(0, entry.duration * 0.001));
  const offset = Number.isFinite(offsetSec) ? Math.max(0, offsetSec) : 0;
  const maxOff = Math.max(0, entry.duration - 0.05);
  return entry.start + Math.min(maxOff, Math.max(into, offset));
}

export function timelineEntryToMeta(entry: TimelineEntry): TrackMeta {
  return {
    id: entry.id,
    title: entry.title,
    artist: entry.artist || undefined,
    album: entry.album || undefined,
    artwork: entry.artwork,
    duration: entry.duration,
  };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
