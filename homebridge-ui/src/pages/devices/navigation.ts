interface LayoutScheduler {
  frame(callback: () => void): void;
  observeResize(callback: () => void): () => void;
  observeInteraction?(callback: () => void): () => void;
}

/** Wait out the host's resize feedback chain, without continuing after navigation or unmount. */
export function afterStableLayout(action: () => void, isCurrent: () => boolean, scheduler: LayoutScheduler = {
  frame: (callback) => requestAnimationFrame(callback),
  observeResize: (callback) => {
    const observer = new ResizeObserver(callback);
    observer.observe(document.documentElement);
    observer.observe(document.body);
    return () => observer.disconnect();
  },
  observeInteraction: (callback) => {
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    events.forEach((event) => document.addEventListener(event, callback, { capture: true, passive: true }));
    return () => events.forEach((event) => document.removeEventListener(event, callback, true));
  },
}): void {
  let quietFrames = 0;
  let totalFrames = 0;
  let interrupted = false;
  const stopResize = scheduler.observeResize(() => {
    quietFrames = 0;
  });
  const stopInteraction = scheduler.observeInteraction?.(() => {
    interrupted = true;
  });
  const stop = () => {
    stopResize(); stopInteraction?.();
  };
  const frame = () => {
    if (interrupted || !isCurrent()) {
      stop();
      return;
    }
    totalFrames++;
    quietFrames++;
    if (quietFrames >= 3 || totalFrames >= 30) {
      stop();
      action();
      return;
    }
    scheduler.frame(frame);
  };
  scheduler.frame(frame);
}
