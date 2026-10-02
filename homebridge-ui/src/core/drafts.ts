export interface DraftSnapshot<T> { value: T; dirty: boolean; pending: boolean; error: string }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Drafts are account-owned and survive page mounts. An ACK settles only its submitted edit sequence. */
export class DraftStore<T> {
  private snapshot: DraftSnapshot<T>;
  private baseline: T;
  private external: T;
  private edit = 0;
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(value: T) {
    this.baseline = value;
    this.external = value;
    this.snapshot = { value, dirty: false, pending: false, error: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener); return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<DraftSnapshot<T>>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  setValue = (value: T | ((previous: T) => T)) => {
    const next = typeof value === 'function' ? (value as (previous: T) => T)(this.snapshot.value) : value;
    this.edit++;
    this.publish({ value: next, dirty: this.snapshot.pending || !equal(next, this.baseline), error: '' });
  };
  receive(value: T) {
    if (equal(value, this.external)) {
      return;
    }
    this.external = value;
    // Keep the reset target current without replacing the user's active edit.
    this.baseline = value;
    if (this.snapshot.dirty || this.snapshot.pending) {
      return;
    }
    this.publish({ value });
  }
  reset = () => {
    if (this.snapshot.pending) {
      return;
    }
    this.edit++;
    this.publish({ value: this.baseline, dirty: false, error: '' });
  };
  resetTo = (value: T) => {
    if (this.snapshot.pending) {
      return;
    }
    this.edit++;
    this.baseline = value;
    this.external = value;
    this.publish({ value, dirty: false, error: '' });
  };
  invalidate() {
    this.generation++;
  }
  save = async (submit: (value: T) => Promise<T | void>) => {
    if (this.snapshot.pending) {
      return;
    }
    const value = this.snapshot.value;
    const edit = this.edit;
    const generation = this.generation;
    this.publish({ pending: true, error: '' });
    try {
      const result = await submit(value);
      if (generation !== this.generation) {
        return;
      }
      this.baseline = result === undefined ? value : result;
      this.publish({ value: this.edit === edit ? this.baseline : this.snapshot.value,
        dirty: this.edit !== edit, pending: false });
    } catch (error) {
      if (generation === this.generation) {
        this.publish({ dirty: true, pending: false, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  };
}
