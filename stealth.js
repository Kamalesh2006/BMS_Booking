// Fingerprint hardening: make automated Chrome look like ordinary desktop
// Chrome. Defeats the cheap automation checks; does not defeat an interactive
// CAPTCHA or a banned IP.

/**
 * A Windows UA built from the real browser version.
 *
 * Windows, not Linux: BookMyShow's WAF 403s Chrome's honest Linux UA and
 * passes the identical request with a Windows one.
 */
export function windowsUserAgent(browserVersion) {
  const major = String(browserVersion).split('.')[0] || '131';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
         `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export const LAUNCH_ARGS = [
  // Stops Chrome advertising itself as automation-controlled, which is what
  // sets navigator.webdriver.
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--window-size=1920,1080',
  '--lang=en-IN',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic'
];

export const CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 1080 },
  screen: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  geolocation: { latitude: 13.0827, longitude: 80.2707 },  // Chennai
  permissions: ['geolocation'],
  colorScheme: 'light'
};

/** Runs in the page before any site script, patching what headless gets wrong. */
export function stealthInitScript() {
  return () => {
    const def = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, { get: () => value, configurable: true });
      } catch { /* already locked */ }
    };

    def(Navigator.prototype, 'webdriver', undefined);
    delete Object.getPrototypeOf(navigator).webdriver;

    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: { isInstalled: false, InstallState: {}, RunningState: {} }
      };
    }

    const plugin = (name) => ({
      name, filename: 'internal-pdf-viewer',
      description: 'Portable Document Format', length: 1
    });
    const plugins = [
      plugin('PDF Viewer'), plugin('Chrome PDF Viewer'), plugin('Chromium PDF Viewer'),
      plugin('Microsoft Edge PDF Viewer'), plugin('WebKit built-in PDF')
    ];
    plugins.item = function (i) { return this[i] ?? null; };
    plugins.namedItem = function (n) { return this.find((p) => p.name === n) ?? null; };
    plugins.refresh = function () {};
    def(Navigator.prototype, 'plugins', plugins);
    def(Navigator.prototype, 'mimeTypes', Object.assign(
      [{ type: 'application/pdf', suffixes: 'pdf', description: '' }],
      { item: () => null, namedItem: () => null }
    ));

    def(Navigator.prototype, 'languages', ['en-IN', 'en-GB', 'en']);
    def(Navigator.prototype, 'hardwareConcurrency', 8);
    def(Navigator.prototype, 'deviceMemory', 8);
    def(Navigator.prototype, 'platform', 'Win32');
    def(Navigator.prototype, 'maxTouchPoints', 0);
    def(Navigator.prototype, 'vendor', 'Google Inc.');

    // SwiftShader in the WebGL strings is a dead giveaway.
    const patchGL = (proto) => {
      if (!proto) return;
      const original = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 37445) return 'Google Inc. (NVIDIA)';
        if (param === 37446) {
          return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        }
        return original.apply(this, arguments);
      };
    };
    patchGL(window.WebGLRenderingContext?.prototype);
    patchGL(window.WebGL2RenderingContext?.prototype);

    // Headless returns "denied" while Notification.permission says "default".
    const query = window.navigator.permissions?.query;
    if (query) {
      window.navigator.permissions.query = (params) =>
        params?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : query.call(window.navigator.permissions, params);
    }

    // A patched native function must still stringify as [native code].
    const nativeToString = Function.prototype.toString;
    const patched = new WeakSet();
    [window.chrome?.runtime, navigator.permissions?.query]
      .forEach((f) => { if (typeof f === 'function') patched.add(f); });
    Function.prototype.toString = function () {
      return patched.has(this)
        ? `function ${this.name}() { [native code] }`
        : nativeToString.call(this);
    };

    def(window.screen, 'availWidth', 1920);
    def(window.screen, 'availHeight', 1040);
    def(window.screen, 'colorDepth', 24);
    def(window.screen, 'pixelDepth', 24);
  };
}

export const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Pointer and scroll activity; bot scoring rewards real input events. */
export async function actHuman(page) {
  try {
    for (let i = 0; i < rand(3, 6); i++) {
      await page.mouse.move(rand(100, 1800), rand(100, 900), { steps: rand(8, 20) });
      await page.waitForTimeout(rand(120, 400));
    }
    for (let i = 0; i < rand(2, 4); i++) {
      await page.mouse.wheel(0, rand(300, 900));
      await page.waitForTimeout(rand(400, 1100));
    }
  } catch { /* page may navigate mid-gesture */ }
}
