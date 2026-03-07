const processShim = {
  env: {},
  argv: [],
  arch: 'browser',
  platform: 'browser',
  version: '0.0.0-browser',
  versions: {},
  browser: true,
  pid: 1,
  noDeprecation: false,
  traceDeprecation: false,
  throwDeprecation: false,
  cwd: () => '/',
  chdir: () => {},
  exit: () => {},
  emitWarning: (...args: unknown[]) => {
    console.warn(...args);
  },
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => callback(...args));
  },
  on: () => processShim,
  off: () => processShim,
  once: () => processShim,
  removeListener: () => processShim,
  stdout: {
    fd: 1,
    isTTY: false,
    write: (...args: unknown[]) => {
      console.log(...args);
      return true;
    },
  },
  stderr: {
    fd: 2,
    isTTY: false,
    write: (...args: unknown[]) => {
      console.warn(...args);
      return true;
    },
  },
};

const globalScope = globalThis as typeof globalThis & {
  global?: typeof globalThis;
  process?: unknown;
};

if (!('global' in globalScope)) {
  globalScope.global = globalThis;
}

if (!('process' in globalScope)) {
  (globalThis as any).process = processShim;
}

await import('../../rivet/packages/app/src/utils/deserializeProject');
await import('../../rivet/packages/app/src/index.css');
await import('../../rivet/packages/app/src/colors.css');

const isEditorFrame = new URLSearchParams(window.location.search).has('editor');

const { default: ReactDOM } = await import('react-dom/client');
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

if (isEditorFrame) {
  // Inside the iframe — render the normal Rivet editor + message bridge
  const [{ default: App }, { EditorMessageBridge }] = await Promise.all([
    import('../../rivet/packages/app/src/App.tsx'),
    import('./dashboard/EditorMessageBridge'),
  ]);
  root.render(
    <>
      <App />
      <EditorMessageBridge />
    </>,
  );
} else {
  // Top-level page — render dashboard with sidebar + editor iframe
  const { DashboardPage } = await import('./dashboard/DashboardPage');
  root.render(<DashboardPage />);
}

export {};
