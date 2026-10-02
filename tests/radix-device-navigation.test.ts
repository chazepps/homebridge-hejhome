import { describe, expect, it, vi } from 'vitest';
import { afterStableLayout } from '../homebridge-ui/src/pages/devices/navigation.js';

function scheduler() {
  let callback: (() => void) | undefined;
  let onResize = () => {};
  let onInteraction = () => {};
  const stop = vi.fn();
  return {
    frame: (next: () => void) => {
      callback = next;
    },
    observeResize: (next: () => void) => {
      onResize = next; return stop;
    },
    observeInteraction: (next: () => void) => {
      onInteraction = next; return () => {};
    },
    tick: () => {
      const next = callback; callback = undefined; next?.();
    },
    resize: () => onResize(),
    interact: () => onInteraction(),
    stop,
  };
}

describe('device navigation layout settling', () => {
  it('postpones scroll restoration when the host resizes again after the first layout', () => {
    const layout = scheduler();
    const restore = vi.fn();
    afterStableLayout(restore, () => true, layout);
    layout.tick(); layout.tick();
    layout.resize();
    layout.tick(); layout.tick();
    expect(restore).not.toHaveBeenCalled();
    layout.tick();
    expect(restore).toHaveBeenCalledOnce();
    expect(layout.stop).toHaveBeenCalledOnce();
  });

  it('disconnects without stealing focus after another navigation', () => {
    const layout = scheduler();
    const restore = vi.fn();
    let current = true;
    afterStableLayout(restore, () => current, layout);
    layout.tick();
    current = false;
    layout.tick();
    expect(restore).not.toHaveBeenCalled();
    expect(layout.stop).toHaveBeenCalledOnce();
  });

  it('bounds observation if the host continually changes layout', () => {
    const layout = scheduler();
    const restore = vi.fn();
    afterStableLayout(restore, () => true, layout);
    for (let frame = 0; frame < 30; frame++) {
      layout.resize(); layout.tick();
    }
    expect(restore).toHaveBeenCalledOnce();
    expect(layout.stop).toHaveBeenCalledOnce();
  });

  it('does not undo user scrolling or keyboard navigation while waiting for layout', () => {
    const layout = scheduler();
    const restore = vi.fn();
    afterStableLayout(restore, () => true, layout);
    layout.tick(); layout.interact(); layout.tick();
    expect(restore).not.toHaveBeenCalled();
    expect(layout.stop).toHaveBeenCalledOnce();
  });
});
