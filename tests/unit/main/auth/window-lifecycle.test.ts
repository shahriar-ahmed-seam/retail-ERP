import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  wireWindowSessionLifecycle,
  type BrowserWindowLike,
  type SessionStoreLike,
  type WebContentsLike,
} from '@main/auth/window-lifecycle';

/**
 * Unit tests for the per-window session lifecycle wiring (Phase 3, task 3.5).
 *
 * The helper is exercised through plain `EventEmitter`-backed stubs that
 * mirror the shape Electron exposes — the goal is to verify that the
 * correct sender id is cleared at the correct moments without dragging
 * the Electron runtime into the unit tier.
 *
 * Validates: Requirements 1.4, 1.5.
 */

class FakeWebContents extends EventEmitter implements WebContentsLike {
  constructor(public readonly id: number) {
    super();
  }

  emitDidStartLoading(): void {
    this.emit('did-start-loading');
  }
}

class FakeBrowserWindow extends EventEmitter implements BrowserWindowLike {
  constructor(public readonly webContents: FakeWebContents) {
    super();
  }

  emitClosed(): void {
    this.emit('closed');
  }
}

function makeStubStore(): SessionStoreLike & { clear: ReturnType<typeof vi.fn> } {
  return { clear: vi.fn() };
}

describe('wireWindowSessionLifecycle', () => {
  it('clears the binding for the renderer when did-start-loading fires (Req 1.4, 1.5)', () => {
    const store = makeStubStore();
    const wc = new FakeWebContents(42);
    const win = new FakeBrowserWindow(wc);

    wireWindowSessionLifecycle(win, store);
    wc.emitDidStartLoading();

    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledWith(42);
  });

  it('clears the binding for the renderer when the window closes (Req 1.4, 1.5)', () => {
    const store = makeStubStore();
    const wc = new FakeWebContents(7);
    const win = new FakeBrowserWindow(wc);

    wireWindowSessionLifecycle(win, store);
    win.emitClosed();

    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledWith(7);
  });

  it('clears multiple times when the renderer reloads more than once', () => {
    const store = makeStubStore();
    const wc = new FakeWebContents(11);
    const win = new FakeBrowserWindow(wc);

    wireWindowSessionLifecycle(win, store);
    wc.emitDidStartLoading();
    wc.emitDidStartLoading();
    wc.emitDidStartLoading();

    expect(store.clear).toHaveBeenCalledTimes(3);
    expect(store.clear).toHaveBeenNthCalledWith(1, 11);
    expect(store.clear).toHaveBeenNthCalledWith(2, 11);
    expect(store.clear).toHaveBeenNthCalledWith(3, 11);
  });

  it('uses the sender id captured at wire time, not a lazy lookup, when closed fires', () => {
    // Regression guard: the previous inline implementation read
    // `win.webContents.id` *inside* the `closed` handler, which is unsafe
    // because Electron destroys the WebContents before this event. Here
    // we simulate that by replacing `webContents` with a getter that
    // throws once `closed` has fired — the helper must still call
    // `store.clear(originalId)` because it captured the id eagerly.
    const store = makeStubStore();
    const wc = new FakeWebContents(99);
    const win = new FakeBrowserWindow(wc);

    wireWindowSessionLifecycle(win, store);

    let destroyed = false;
    Object.defineProperty(win, 'webContents', {
      get(): WebContentsLike {
        if (destroyed) {
          throw new Error('Object has been destroyed');
        }
        return wc;
      },
    });

    destroyed = true;
    win.emitClosed();

    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledWith(99);
  });

  it('keeps per-window wiring isolated when two windows share a store', () => {
    const store = makeStubStore();
    const winA = new FakeBrowserWindow(new FakeWebContents(1));
    const winB = new FakeBrowserWindow(new FakeWebContents(2));

    wireWindowSessionLifecycle(winA, store);
    wireWindowSessionLifecycle(winB, store);

    winA.webContents.emitDidStartLoading();
    winB.emitClosed();

    expect(store.clear).toHaveBeenCalledTimes(2);
    expect(store.clear).toHaveBeenNthCalledWith(1, 1);
    expect(store.clear).toHaveBeenNthCalledWith(2, 2);
  });
});
