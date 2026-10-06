/** Restore a position before listeners/playback can observe the new source. */
export async function seekMedia(
  audio: HTMLAudioElement,
  time: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (audio.readyState >= 1) {
    audio.currentTime = time;
    return true;
  }
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", finish);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cleanup();
      resolve(false);
    };
    const finish = () => {
      cleanup();
      if (signal.aborted) return resolve(false);
      try {
        audio.currentTime = time;
        resolve(true);
      } catch (error) {
        reject(error);
      }
    };
    const timeout = setTimeout(finish, 4000);
    audio.addEventListener("loadedmetadata", finish);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
