/**
 * Custom title bar for the frameless main window.
 *
 * The application opens its `BrowserWindow` with `frame: false`
 * (Discord / WhatsApp / VS Code style — see `src/main/index.ts`).
 * The OS title bar is gone, so this component paints:
 *
 *   - A draggable strip across the top (`-webkit-app-region: drag`)
 *     so the user can still move the window by dragging there.
 *     Buttons inside the bar opt out via `-webkit-app-region:
 *     no-drag` so clicks register normally.
 *
 *   - The product brand on the left (`Core Retail ERP`).
 *
 *   - Three Windows-style window-control buttons on the right:
 *     minimize, maximize/restore, close. Each dispatches a
 *     pre-auth IPC message via `window.windowApi` (exposed by the
 *     preload script). On macOS the OS keeps the traffic-light
 *     overlay buttons visible because `BrowserWindow` is created
 *     with `titleBarStyle: 'hidden'`; the custom buttons here are
 *     redundant on that platform but harmless.
 *
 * The bar's height is fixed at 36 px so the rest of the layout can
 * subtract it cleanly. It uses dark Discord-style colors by default
 * but tints to match the surrounding theme via `background` / `color`
 * inline style overrides if a parent ever needs to pass them.
 *
 * The component is purely presentational and side-effect-light: a
 * single subscription to `windowApi.onMaximizedStateChange` keeps the
 * maximize-button glyph in sync with the actual window state, so the
 * SVG flips between "maximize" and "restore" without polling.
 */

import { useEffect, useState, type ReactElement } from 'react';

/** Height of the title bar in CSS pixels. Exported so layouts can subtract it. */
export const TITLE_BAR_HEIGHT = 36;

export interface TitleBarProps {
  /**
   * Optional override for the brand label. Defaults to
   * `Core Retail ERP`. The setup / migration / login surfaces all
   * use the default; future per-route customization can pass a
   * different string.
   */
  readonly title?: string;
}

export function TitleBar({ title = 'Core Retail ERP' }: TitleBarProps): ReactElement {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // The preload bridge exposes `windowApi` only when the renderer
    // is running inside Electron. In jsdom unit tests the property
    // is missing; bail out cleanly so component-level tests keep
    // mounting the bar without an Electron host.
    const w = (window as Window & {
      windowApi?: {
        onMaximizedStateChange: (
          h: (s: { maximized: boolean }) => void,
        ) => () => void;
      };
    }).windowApi;
    if (w === undefined) return undefined;
    return w.onMaximizedStateChange((state) => {
      setMaximized(state.maximized);
    });
  }, []);

  const dispatch = (action: 'minimize' | 'maximize' | 'close'): void => {
    const w = (window as Window & {
      windowApi?: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
      };
    }).windowApi;
    if (w === undefined) return;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') w.maximize();
    else w.close();
  };

  return (
    <div
      data-testid="title-bar"
      role="toolbar"
      aria-label="Window controls"
      style={{
        // The drag region: anything in this row that is not opted
        // out via `-webkit-app-region: no-drag` becomes part of the
        // window-move surface.
        WebkitAppRegion: 'drag',
        height: TITLE_BAR_HEIGHT,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#0f172a',
        color: '#e2e8f0',
        borderBottom: '1px solid #1e293b',
        userSelect: 'none',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '0.8125rem',
      }}
    >
      <div
        data-testid="title-bar-brand"
        style={{
          padding: '0 0.875rem',
          fontWeight: 600,
          letterSpacing: '0.01em',
          color: '#f1f5f9',
        }}
      >
        {title}
      </div>

      <div
        // The button cluster opts out of the drag region so clicks
        // register normally; buttons further opt in to `no-drag` via
        // their own style block in case a future browser tweaks the
        // inheritance rules.
        style={{
          WebkitAppRegion: 'no-drag',
          display: 'flex',
          height: '100%',
        }}
      >
        <TitleBarButton
          testId="title-bar-minimize"
          ariaLabel="Minimize"
          onClick={() => {
            dispatch('minimize');
          }}
        >
          <MinimizeGlyph />
        </TitleBarButton>
        <TitleBarButton
          testId="title-bar-maximize"
          ariaLabel={maximized ? 'Restore' : 'Maximize'}
          onClick={() => {
            dispatch('maximize');
          }}
        >
          {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </TitleBarButton>
        <TitleBarButton
          testId="title-bar-close"
          ariaLabel="Close"
          variant="close"
          onClick={() => {
            dispatch('close');
          }}
        >
          <CloseGlyph />
        </TitleBarButton>
      </div>
    </div>
  );
}

interface TitleBarButtonProps {
  readonly testId: string;
  readonly ariaLabel: string;
  readonly variant?: 'default' | 'close';
  readonly onClick: () => void;
  readonly children: ReactElement;
}

function TitleBarButton({
  testId,
  ariaLabel,
  variant = 'default',
  onClick,
  children,
}: TitleBarButtonProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const isClose = variant === 'close';
  const hoverBg = isClose ? '#e81123' : 'rgba(255,255,255,0.08)';
  const hoverColor = isClose ? '#ffffff' : '#f1f5f9';

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      style={{
        WebkitAppRegion: 'no-drag',
        height: '100%',
        width: '46px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hovered ? hoverBg : 'transparent',
        color: hovered ? hoverColor : '#cbd5e1',
        border: 'none',
        cursor: 'default',
        outline: 'none',
        transition: 'background 80ms ease, color 80ms ease',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

// 10 px monochrome SVGs sized to match Windows 11 caption buttons.
function MinimizeGlyph(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaximizeGlyph(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function RestoreGlyph(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="#0f172a" />
    </svg>
  );
}

function CloseGlyph(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}
