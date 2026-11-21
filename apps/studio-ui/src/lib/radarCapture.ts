/**
 * Runs a capture from the top-down radar view and always restores the camera,
 * even when the capture or the frame wait throws.
 */

export interface RadarCameraTools {
  setRadarCamera: () => void;
  restoreRadarCamera: () => void;
}

/**
 * Waits one frame, but never forever: hidden/background tabs do not fire
 * requestAnimationFrame, so a short timer also releases the capture.
 */
export const nextFrame = () =>
  new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
    setTimeout(finish, 150);
  });

export async function captureWithRadar<T>(
  tools: RadarCameraTools,
  run: () => Promise<T>,
  wait: () => Promise<void> = nextFrame,
  timeoutMs = 12000,
): Promise<T> {
  tools.setRadarCamera();
  try {
    // A hidden tab can stall the frame wait, PNG encoding or clipboard access
    // indefinitely; bound the whole sequence so the camera is always restored.
    return await Promise.race([
      (async () => {
        await wait();
        return run();
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("radar capture timed out")), timeoutMs),
      ),
    ]);
  } finally {
    tools.restoreRadarCamera();
  }
}
