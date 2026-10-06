# AudioEngine event model

The engine reports committed state changes. Track identity, playback state, and
position are separate. A native media event is evidence of a transition, not a
reason to announce the current track again.

## State and identity

The current item is identified by mode, queue, queue index, and track id. Discrete
queues use `queueId`, or the loaded ids when no queue id is supplied. Continuous
queues use the adapter's queue key. Payloads retain the resolved `queueId`.
Duplicate track ids at different queue positions are different items.

`EngineEventState` owns identity and playback transitions across mode replacement.
Modes commit selection only after a source/seek succeeds. Playback handlers update
the shared playing flag; they do not announce track identity. Public getters
already reflect the transition when its listeners run.

## Command/event matrix

| Operation | Track events | Playback events | Position/hooks |
|---|---|---|---|
| Load a different item, paused | One `trackchange` | `pause` if replacing playback | New logical clock |
| Load a different item, autoplay | One `trackchange` | Old `pause` if needed, then `play` | New clock; hooks may run during playback |
| `playAt(currentIndex)` while playing | None | None | Preserve position, source, warm slot, and hooks |
| `playAt(currentIndex)` while paused | None | One `play` | Preserve position and hooks |
| `play()` / `pause()` | None unless a continuous clock moved to a different item | Only actual transitions | Immediate clock update on transition |
| Discrete next/previous/other index | One `trackchange` | `pause` if needed, then `play` | New item and hooks |
| Continuous next/previous/other index | One `trackchange` | `play` only if previously paused | Seek to the different item |
| Continuous natural boundary or absolute media seek | One `trackchange` per observed item change | None | Logical clock and hooks switch to that item |
| Seek within the current item | None | None | Immediate clock; reset hooks only if position moved |
| Seek while paused | None for within-item seek | None | Update clock; no playback progress hooks |
| Replace source preserving position | None | `pause`/`play` if replacing playback | Restore before playback/listeners observe the new source |
| Continuous replacement without preserving position | `trackchange` if the logical item changed | As above | New absolute clock |
| Native end | None unless final continuous clock reveals another item | `pause` if needed, then one `ended` | Final clock and configured progress thresholds |
| Empty queue / failed new load | One `trackclear` if a selection existed | `pause` if needed | Getters/store show no current track |
| Priming / warm loading / stale operation | None | None | No public playback telemetry |
| Destroy | None | None | Cancel pending work, remove listeners |

Discrete `ended` advances to the next item automatically. Continuous `ended`
means the queue source ended, rather than each logical track ending. At queue
bounds, next/previous are no-ops. A requested ended item may start again; restart
of a still-current, unfinished item is explicit `seek(0)`.

## Clock and hooks

`timeupdate` samples the logical track clock on the configured interval and drops
unchanged snapshots. Real play/pause transitions, changed seeks, and native end
publish immediately. `progress` describes position thresholds, not buffered data
or accumulated listening time. Paused selection/seeking does not count as
playback. Resume and unchanged requests preserve the hook firing history.

## Failures and async ownership

Operational failures emit `error`; cancelled/superseded work is silent. Failed
new loads clear the previous selection. Native media errors and fatal hls.js
errors are observable; recoverable HLS failures remain with hls.js recovery.
Expected operation failures settle the command promise after reporting the event;
setup misuse, such as a missing adapter, still rejects.

Each operation checks its generation and cancellation signal before committing or
starting playback. Playback intent is tracked separately: a later pause prevents
an in-flight load/source refresh from starting or resuming audio. Metadata listeners/timers are removed on cancellation.
Attachments on the same element are serialized, and returned destruction handles
are idempotent: disposing a retired source cannot clear its successor. The warm
slot has no current-media listeners until it is promoted.

## Frontend binding

`playTrack(queue, index)` should route same-queue requests through `playAt(index)`.
The engine handles the current-index case without the host comparing playback
position or state. Use `trackchange` to update now-playing identity/history,
`trackclear` to clear it, and `play`/`pause` for playback controls. An explicit
`load` replaces a queue/source; it is not the idempotent resume command.

The existing `trackchange` payload is unchanged. `trackclear` is additive and the
Svelte store subscribes to it. No frontend deduplication is required for unchanged
current-item notifications.
