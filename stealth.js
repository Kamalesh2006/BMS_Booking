// Fingerprint hardening: present automated Chrome as one ordinary Windows
// desktop, described by a profile from fingerprint.js. Defeats the cheap
// automation checks and the "same machine again" heuristic that promotes a
// repeat visitor to an interactive challenge. It does not defeat a CAPTCHA that
// has already been served, and it does not help a banned IP.
//
// Guiding rule throughout: only override what headless actually gets wrong.
// A patched value that fails an `instanceof` or stringifies as JavaScript is a
// louder signal than the wrong value would have been.

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

export function launchArgs(profile) {
  return [
    // Stops Chrome advertising itself as automation-controlled, which is what
    // sets navigator.webdriver.
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',

    `--window-size=${profile.window.outerWidth},${profile.window.outerHeight}`,
    '--window-position=0,0',
    '--lang=en-IN',

    // Software rasteriser, but a real GL implementation.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',

    // Without this the WebRTC candidate gathering exposes the runner's private
    // address range, which does not match anything else we claim to be.
    '--force-webrtc-ip-handling-policy=default_public_interface_only',

    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',

    // Headless throttles background work; the timing profile that produces is
    // measurably different from a foreground tab.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ];
}

// navigator.languages and the Accept-Language header have to tell the same
// story; a header of "en-IN" beside languages of ["en-IN","en-GB","en"] is a
// free catch. Playwright's `locale` option sets only the bare locale, so the
// header is rebuilt here from the profile's list.
const acceptLanguage = (languages) => languages
  .map((l, i) => (i ? `${l};q=${(1 - i * 0.1).toFixed(1)}` : l))
  .join(',');

/**
 * Capture the browser's own `sec-ch-ua` header, with the headless giveaway
 * removed.
 *
 * Brands cannot be hardcoded: the GREASE entry, its punctuation and its version
 * all change between Chrome releases, so a literal dates itself within months.
 * They cannot be used verbatim either - bundled Chromium announces
 * `"HeadlessChrome";v="151"`, which is the loudest single string this file
 * exists to remove. Real Chrome via the `chrome` channel needs no correction
 * and gets none.
 *
 * The value is read off the wire rather than out of `navigator.userAgentData`
 * because that object only exists in a secure context - about:blank and data:
 * URLs both report `undefined`. A one-shot loopback server is a secure origin,
 * costs no external request, and cannot leave a cookie on the real target.
 */
export async function probeClientHints(browser) {
  const http = await import('node:http');

  let resolveHeader;
  const captured = new Promise((r) => { resolveHeader = r; });
  const server = http.createServer((req, res) => {
    resolveHeader(req.headers['sec-ch-ua'] ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>.</title>');
  });

  const context = await browser.newContext();
  try {
    await new Promise((r, j) => server.listen(0, '127.0.0.1', r).on('error', j));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { timeout: 10000 });

    const raw = await Promise.race([
      captured,
      new Promise((r) => setTimeout(() => r(''), 5000))
    ]);
    return parseBrands(raw).map((b) => ({
      brand: b.brand === 'HeadlessChrome' ? 'Google Chrome' : b.brand,
      version: b.version
    }));
  } catch {
    // Falling back to the browser's own header is safe on real Chrome and only
    // costs us the HeadlessChrome rewrite on the bundled build.
    return [];
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
}

// Matched globally rather than split on "," because GREASE brand names contain
// punctuation - ";" and "," among the characters Chrome picks from.
const BRAND_ITEM = /"((?:[^"\\]|\\.)*)";v="([^"]*)"/g;

function parseBrands(header) {
  return [...String(header).matchAll(BRAND_ITEM)]
    .map((m) => ({ brand: m[1], version: m[2] }));
}

/** Serialise brands back into a `sec-ch-ua` header value. */
function brandHeader(brands) {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/**
 * Rewrite `Accept-Language` on the way out.
 *
 * Playwright's `locale` option is what makes navigator.language, navigator
 * .languages and Intl all agree - but it also pins Accept-Language to the bare
 * locale ("en-IN"), and it wins over extraHTTPHeaders. Real Chrome always
 * appends the fallback chain with q-values, so the bare form is a known
 * automation artifact. Passing the q-string as the locale instead produces a
 * malformed header ("en-GB;q=0.9;q=0.9") and breaks Intl, so the header is
 * corrected at the network layer and the locale left alone.
 */
export async function fixAcceptLanguage(context, profile) {
  const value = acceptLanguage(profile.languages);
  await context.route('**/*', (route) => {
    route.continue({
      headers: { ...route.request().headers(), 'accept-language': value }
    }).catch(() => route.continue().catch(() => {}));
  });
}

/**
 * Context options for a given profile.
 *
 * viewport / screen / deviceScaleFactor are set here rather than patched in JS
 * so that CSS media queries (`resolution`, `device-width`) agree with what
 * JavaScript reports. A JS-only screen patch is trivially caught by asking CSS
 * the same question.
 */
export function contextOptions(profile, userAgent) {
  return {
    userAgent,
    viewport: { width: profile.viewport.width, height: profile.viewport.height },
    screen: { width: profile.screen.width, height: profile.screen.height },
    deviceScaleFactor: profile.screen.dpr,
    isMobile: false,
    hasTouch: false,
    locale: profile.locale,
    timezoneId: profile.timezone,
    geolocation: { latitude: 13.0827, longitude: 80.2707 },  // Chennai
    permissions: ['geolocation'],
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    forcedColors: 'none',

    // `sec-ch-ua-platform` would otherwise announce "Linux" underneath a
    // Windows UA, and `sec-ch-ua` would name HeadlessChrome on the bundled
    // build. Both are corrected; `sec-ch-ua-mobile` is already right.
    //
    // The high-entropy hints (-platform-version, -arch, -bitness, -model) are
    // deliberately NOT sent: Chrome only sends those after a server asks via
    // Accept-CH, so volunteering them on a first request is itself anomalous.
    // They are answered through navigator.userAgentData instead.
    //
    // Accept-Language is handled by fixAcceptLanguage() instead - `locale`
    // overrides it here.
    extraHTTPHeaders: {
      'sec-ch-ua-platform': '"Windows"',
      ...(profile.uaBrands?.length
        ? { 'sec-ch-ua': brandHeader(profile.uaBrands) }
        : {})
    }
  };
}

/**
 * Runs in the page before any site script.
 *
 * Receives the profile as an argument because Playwright serialises this
 * function - it cannot close over anything in this module.
 */
export function stealthInitScript(fp) {
  // --- native-looking patching --------------------------------------------
  // Anything installed below must stringify as [native code], including the
  // getters, or `Function.prototype.toString` becomes the detector.

  const nativeFns = new WeakSet();
  const originalToString = Function.prototype.toString;

  const mark = (fn, name) => {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch { /* frozen */ }
    nativeFns.add(fn);
    return fn;
  };

  const patchedToString = function toString() {
    return nativeFns.has(this)
      ? `function ${this.name}() { [native code] }`
      : originalToString.call(this);
  };
  mark(patchedToString, 'toString');
  Function.prototype.toString = patchedToString;

  /** Install a value behind a native-looking getter. */
  const def = (obj, prop, value) => {
    if (!obj) return;
    try {
      const get = function () { return value; };
      mark(get, `get ${prop}`);
      Object.defineProperty(obj, prop, {
        get, set: undefined, enumerable: true, configurable: true
      });
    } catch { /* non-configurable */ }
  };

  /** Replace a method, keeping it native-looking. */
  const method = (obj, prop, impl) => {
    if (!obj) return;
    try {
      mark(impl, prop);
      Object.defineProperty(obj, prop, {
        value: impl, writable: true, enumerable: false, configurable: true
      });
    } catch { /* non-configurable */ }
  };

  // Position-keyed noise. Pure in (x, y, channel), so two reads of the same
  // pixel always agree - a canvas that returns different bytes on consecutive
  // reads is a stronger bot signal than a stable unusual one.
  const noiseAt = (x, y, c) => {
    let h = (fp.noiseSeed ^ Math.imul(x + 1, 374761393) ^
             Math.imul(y + 1, 668265263) ^ Math.imul(c + 1, 2246822519)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  };

  // --- navigator: CPU, RAM, platform --------------------------------------

  const nav = Navigator.prototype;

  def(nav, 'webdriver', false);            // real Chrome exposes false, not absent
  def(nav, 'hardwareConcurrency', fp.cpu.cores);
  def(nav, 'deviceMemory', fp.memory.deviceMemory);
  def(nav, 'platform', 'Win32');
  def(nav, 'vendor', 'Google Inc.');
  def(nav, 'vendorSub', '');
  def(nav, 'productSub', '20030107');
  def(nav, 'maxTouchPoints', 0);
  def(nav, 'languages', Object.freeze(fp.languages));
  def(nav, 'pdfViewerEnabled', true);

  // --- navigator.userAgentData --------------------------------------------
  // Uses the same sanitised brand list that went out in the `sec-ch-ua` header,
  // so the two cannot disagree. Falls back to deriving one only if the probe
  // came back empty.

  {
    const major = String(fp.chromeVersion).split('.')[0];
    const source = fp.uaBrands?.length ? fp.uaBrands : [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: '24' }
    ];
    const brands = Object.freeze(
      source.map((b) => Object.freeze({ brand: b.brand, version: b.version }))
    );

    // Real brands report the full four-part version; GREASE entries pad theirs.
    const fullVersionList = Object.freeze(brands.map((b) => Object.freeze({
      brand: b.brand,
      version: b.version === major ? fp.chromeVersion : `${b.version}.0.0.0`
    })));

    const highEntropy = {
      architecture: 'x86',
      bitness: '64',
      model: '',
      platformVersion: fp.platformVersion,
      uaFullVersion: fp.chromeVersion,
      fullVersionList,
      wow64: false,
      formFactors: Object.freeze(['Desktop'])
    };

    const uaData = Object.create(
      window.NavigatorUAData?.prototype ?? Object.prototype
    );
    def(uaData, 'brands', brands);
    def(uaData, 'mobile', false);
    def(uaData, 'platform', 'Windows');
    method(uaData, 'getHighEntropyValues', function getHighEntropyValues(hints) {
      // Chrome always returns the low-entropy trio plus whatever was asked for.
      const out = { brands, mobile: false, platform: 'Windows' };
      for (const hint of hints ?? []) {
        if (hint in highEntropy) out[hint] = highEntropy[hint];
      }
      return Promise.resolve(out);
    });
    method(uaData, 'toJSON', function toJSON() {
      return { brands, mobile: false, platform: 'Windows' };
    });
    def(nav, 'userAgentData', uaData);
  }

  // --- screen and window metrics ------------------------------------------
  // width/height/devicePixelRatio come from the browser itself (set as context
  // options) so CSS agrees. Only the work area and the window frame need
  // fixing: headless reports availHeight === height and outerHeight ===
  // innerHeight, neither of which happens on a machine with a taskbar and a
  // browser toolbar.

  def(Screen.prototype, 'availWidth', fp.screen.availWidth);
  def(Screen.prototype, 'availHeight', fp.screen.availHeight);
  def(Screen.prototype, 'availLeft', fp.screen.availLeft);
  def(Screen.prototype, 'availTop', fp.screen.availTop);
  def(Screen.prototype, 'colorDepth', fp.screen.colorDepth);
  def(Screen.prototype, 'pixelDepth', fp.screen.pixelDepth);

  def(window, 'outerWidth', fp.window.outerWidth);
  def(window, 'outerHeight', fp.window.outerHeight);
  def(window, 'screenX', fp.window.screenX);
  def(window, 'screenY', fp.window.screenY);
  def(window, 'screenLeft', fp.window.screenX);
  def(window, 'screenTop', fp.window.screenY);

  // --- GPU ------------------------------------------------------------------
  // Both the renderer strings and the limits. Rewriting only the strings leaves
  // SwiftShader's 8192 max texture size and 8192x8192 viewport in place, which
  // no Direct3D11 adapter reports - that mismatch is worse than an honest
  // SwiftShader.

  const patchGL = (Ctor, extensions) => {
    const proto = Ctor?.prototype;
    if (!proto) return;

    const overrides = new Map();
    for (const [name, value] of Object.entries(fp.gpu.limits)) {
      const pname = Ctor[name];
      if (pname !== undefined) overrides.set(pname, value);
    }
    overrides.set(0x9245, fp.gpu.vendor);    // UNMASKED_VENDOR_WEBGL
    overrides.set(0x9246, fp.gpu.renderer);  // UNMASKED_RENDERER_WEBGL

    const originalGetParameter = proto.getParameter;
    method(proto, 'getParameter', function getParameter(pname) {
      if (overrides.has(pname)) {
        const v = overrides.get(pname);
        // These two are typed arrays natively; hand back a fresh copy so a
        // caller mutating the result cannot corrupt the next read.
        return Array.isArray(v) ? new Int32Array(v) : v;
      }
      // MAX_TEXTURE_MAX_ANISOTROPY_EXT
      if (pname === 0x84ff) return fp.gpu.maxAnisotropy;
      return originalGetParameter.call(this, pname);
    });

    const originalGetSupported = proto.getSupportedExtensions;
    method(proto, 'getSupportedExtensions', function getSupportedExtensions() {
      const actual = originalGetSupported.call(this);
      // Intersect rather than assert: claiming an extension the context cannot
      // actually hand back from getExtension() is self-contradicting.
      return actual ? extensions.filter((e) => actual.includes(e)) : actual;
    });
  };

  patchGL(window.WebGLRenderingContext, fp.gpu.extensions1);
  patchGL(window.WebGL2RenderingContext, fp.gpu.extensions2);

  // --- memory ---------------------------------------------------------------
  // performance.memory's heap ceiling is set by V8 from installed RAM, so it
  // has to agree with the profile. Used/total drift a little per read, as they
  // do in a real page.

  if (window.performance) {
    const base = 10 * 1024 * 1024 + (fp.noiseSeed % (6 * 1024 * 1024));
    const t0 = Date.now();
    const memory = Object.create(
      window.performance.memory ? Object.getPrototypeOf(window.performance.memory)
                                : Object.prototype
    );
    def(memory, 'jsHeapSizeLimit', fp.memory.jsHeapSizeLimit);
    Object.defineProperty(memory, 'totalJSHeapSize', {
      get: mark(function () {
        return base + ((Date.now() - t0) % 2048) * 1024;
      }, 'get totalJSHeapSize'),
      configurable: true, enumerable: true
    });
    Object.defineProperty(memory, 'usedJSHeapSize', {
      get: mark(function () {
        return Math.floor(base * 0.72) + ((Date.now() - t0) % 1024) * 512;
      }, 'get usedJSHeapSize'),
      configurable: true, enumerable: true
    });
    def(window.performance, 'memory', memory);
  }

  // --- storage --------------------------------------------------------------

  if (navigator.storage?.estimate) {
    const original = navigator.storage.estimate.bind(navigator.storage);
    method(Object.getPrototypeOf(navigator.storage), 'estimate',
      function estimate() {
        return original()
          .then((r) => ({ ...r, quota: fp.storage.quota }))
          .catch(() => ({ quota: fp.storage.quota, usage: 0, usageDetails: {} }));
      });
  }

  // --- network --------------------------------------------------------------

  if (navigator.connection) {
    const conn = Object.getPrototypeOf(navigator.connection);
    def(conn, 'effectiveType', fp.network.effectiveType);
    def(conn, 'rtt', fp.network.rtt);
    def(conn, 'downlink', fp.network.downlink);
    def(conn, 'saveData', fp.network.saveData);
  }

  // --- battery --------------------------------------------------------------
  // A mains-powered desktop. Headless Chrome has no battery service at all and
  // getBattery() hangs or rejects, which is itself measurable.

  method(nav, 'getBattery', function getBattery() {
    return Promise.resolve({
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 1,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
    });
  });

  // --- media devices --------------------------------------------------------
  // Headless enumerates zero devices. A real desktop lists its inputs and
  // outputs with blank ids and labels until permission is granted.

  if (navigator.mediaDevices?.enumerateDevices) {
    const original = navigator.mediaDevices.enumerateDevices
      .bind(navigator.mediaDevices);
    method(Object.getPrototypeOf(navigator.mediaDevices), 'enumerateDevices',
      function enumerateDevices() {
        return original().then((list) => (list && list.length ? list : [
          { deviceId: '', kind: 'audioinput',  label: '', groupId: '', toJSON() { return this; } },
          { deviceId: '', kind: 'videoinput',  label: '', groupId: '', toJSON() { return this; } },
          { deviceId: '', kind: 'audiooutput', label: '', groupId: '', toJSON() { return this; } }
        ]));
      });
  }

  // --- permissions ----------------------------------------------------------
  // Headless answers "denied" for notifications while Notification.permission
  // says "default". The pair disagreeing is the classic tell.

  {
    // Bundled Chromium reports "denied" with no prompt ever shown; real Chrome
    // reports "default". Normalise to the latter, then make query() agree, so
    // the pair is both consistent and the value an ordinary visitor has.
    if (window.Notification && Notification.permission === 'denied') {
      def(window.Notification, 'permission', 'default');
    }

    const query = navigator.permissions?.query;
    if (query) {
      method(Object.getPrototypeOf(navigator.permissions), 'query',
        function queryPermission(params) {
          return params?.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission, onchange: null })
            : query.call(navigator.permissions, params);
        });
    }
  }

  // --- window.chrome --------------------------------------------------------
  // Installed only when genuinely missing. Newer headless ships a real one, and
  // a hand-rolled stand-in fails more checks than it passes.

  if (!window.chrome) {
    const start = Date.now();
    // Shape and key order copied from real Chrome on an ordinary page:
    // exactly loadTimes, csi, app. Note there is deliberately no `runtime` -
    // real Chrome only exposes that when an extension is installed, so adding
    // it (as most stealth snippets do) is itself a flag rather than a fix.
    window.chrome = {
      loadTimes: mark(function loadTimes() {
        const t = start / 1000;
        return {
          commitLoadTime: t, connectionInfo: 'h2', finishDocumentLoadTime: t,
          finishLoadTime: t, firstPaintAfterLoadTime: 0, firstPaintTime: t,
          navigationType: 'Other', npnNegotiatedProtocol: 'h2',
          requestTime: t, startLoadTime: t, wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true, wasNpnNegotiated: true
        };
      }, 'loadTimes'),
      csi: mark(function csi() {
        return { onloadT: start, startE: start, pageT: Date.now() - start, tran: 15 };
      }, 'csi'),
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: mark(function getDetails() { return null; }, 'getDetails'),
        getIsInstalled: mark(function getIsInstalled() { return false; }, 'getIsInstalled')
      }
    };
  }

  // --- plugins --------------------------------------------------------------
  // Same principle: current headless already reports Chrome's five PDF
  // pseudo-plugins with real Plugin objects. Only stand in when the list is
  // empty, because these substitutes fail `instanceof Plugin`.

  if (!navigator.plugins || navigator.plugins.length === 0) {
    // Built on the real prototypes so `plugins[0] instanceof Plugin` holds -
    // detectors do check that, and a plain object there is as good as an empty
    // list. Own data properties shadow the prototype's accessors, which would
    // otherwise throw on an object with no internal slots.
    const arrayLike = (Ctor, items, keyOf) => {
      const obj = Object.create(Ctor?.prototype ?? Object.prototype);
      items.forEach((item, i) => Object.defineProperty(obj, i, {
        value: item, enumerable: true, configurable: true
      }));
      Object.defineProperty(obj, 'length', {
        value: items.length, enumerable: false, configurable: true
      });
      method(obj, 'item', function item(i) { return items[i] ?? null; });
      method(obj, 'namedItem', function namedItem(n) {
        return items.find((it) => keyOf(it) === n) ?? null;
      });
      Object.defineProperty(obj, Symbol.iterator, {
        value: Array.prototype.values, writable: true, configurable: true
      });
      return obj;
    };

    const fields = (Ctor, props) => {
      const obj = Object.create(Ctor?.prototype ?? Object.prototype);
      for (const [k, v] of Object.entries(props)) {
        Object.defineProperty(obj, k, { value: v, enumerable: true, configurable: true });
      }
      return obj;
    };

    const mime = (type) => fields(window.MimeType, {
      type, suffixes: 'pdf', description: 'Portable Document Format'
    });
    const pdfTypes = [mime('application/pdf'), mime('text/pdf')];

    const plugins = [
      'PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
      'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'
    ].map((name) => {
      const p = arrayLike(window.Plugin, pdfTypes, (m) => m.type);
      Object.defineProperties(p, {
        name: { value: name, enumerable: true, configurable: true },
        filename: { value: 'internal-pdf-viewer', enumerable: true, configurable: true },
        description: { value: 'Portable Document Format', enumerable: true, configurable: true }
      });
      return p;
    });

    const pluginArray = arrayLike(window.PluginArray, plugins, (p) => p.name);
    method(pluginArray, 'refresh', function refresh() {});

    for (const m of pdfTypes) {
      Object.defineProperty(m, 'enabledPlugin', {
        value: plugins[0], enumerable: true, configurable: true
      });
    }

    def(nav, 'plugins', pluginArray);
    def(nav, 'mimeTypes', arrayLike(window.MimeTypeArray, pdfTypes, (m) => m.type));
  }

  // --- canvas ---------------------------------------------------------------
  // The canvas hash is what links this visit to the previous hour's visit even
  // across a changed IP. Perturbing a sparse, deterministic set of subpixels
  // gives each profile its own stable hash: identical within a page load,
  // different between runs.

  {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;

    // Fingerprinting canvases are small. Skipping the giant ones keeps a
    // full-page <canvas> readback from paying for a multi-megapixel loop.
    const MAX_NOISED_PIXELS = 4_000_000;

    const perturb = (imageData, offsetX, offsetY) => {
      const { data, width, height } = imageData;
      if (width * height > MAX_NOISED_PIXELS) return imageData;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const h = noiseAt(x + offsetX, y + offsetY, 0);
          if (h % 173 !== 0) continue;                 // ~0.6% of pixels
          const i = (y * width + x) * 4;
          const channel = h % 3;
          const delta = (h >>> 8) % 2 ? 1 : -1;
          data[i + channel] = Math.max(0, Math.min(255, data[i + channel] + delta));
        }
      }
      return imageData;
    };

    method(CanvasRenderingContext2D.prototype, 'getImageData',
      function getImageData(sx, sy, sw, sh, settings) {
        const out = origGetImageData.call(this, sx, sy, sw, sh, settings);
        return perturb(out, sx | 0, sy | 0);
      });

    // Read paths that bypass getImageData get the noise via an off-screen copy,
    // so the visible canvas is never mutated.
    const noisyClone = (canvas) => {
      const clone = document.createElement('canvas');
      clone.width = canvas.width;
      clone.height = canvas.height;
      if (!clone.width || !clone.height) return null;
      const ctx = clone.getContext('2d');
      if (!ctx) return null;
      try {
        ctx.drawImage(canvas, 0, 0);
        ctx.putImageData(perturb(origGetImageData.call(ctx, 0, 0, clone.width, clone.height), 0, 0), 0, 0);
      } catch {
        return null;   // tainted by a cross-origin draw
      }
      return clone;
    };

    method(HTMLCanvasElement.prototype, 'toDataURL',
      function toDataURL(...args) {
        const clone = noisyClone(this);
        return origToDataURL.apply(clone ?? this, args);
      });

    method(HTMLCanvasElement.prototype, 'toBlob',
      function toBlob(callback, ...args) {
        const clone = noisyClone(this);
        return origToBlob.apply(clone ?? this, [callback, ...args]);
      });
  }

  // --- audio ----------------------------------------------------------------
  // The other cross-run linker: the OfflineAudioContext oscillator hash. Same
  // treatment - a fixed, tiny, profile-specific bias, applied once per buffer
  // so repeated reads stay consistent.

  {
    const bias = (arr, scale) => {
      for (let i = 0; i < arr.length; i += 137) {
        const h = noiseAt(i, 0, 7);
        arr[i] += ((h % 1000) / 1000 - 0.5) * scale;
      }
      return arr;
    };

    if (window.AudioBuffer) {
      // getChannelData hands back the *same* Float32Array on every call, so
      // biasing per call would compound. Applied once per buffer instead.
      const biased = new WeakSet();
      const orig = AudioBuffer.prototype.getChannelData;
      method(AudioBuffer.prototype, 'getChannelData', function getChannelData(ch) {
        const arr = orig.call(this, ch);
        if (!biased.has(arr)) {
          biased.add(arr);
          bias(arr, 1e-7);
        }
        return arr;
      });
    }
    if (window.AnalyserNode) {
      const orig = AnalyserNode.prototype.getFloatFrequencyData;
      method(AnalyserNode.prototype, 'getFloatFrequencyData',
        function getFloatFrequencyData(array) {
          orig.call(this, array);
          bias(array, 1e-4);
        });
    }
  }
}

export const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Pointer and scroll activity; bot scoring rewards real input events. */
export async function actHuman(page, profile) {
  const w = profile?.viewport?.width ?? 1280;
  const h = profile?.viewport?.height ?? 720;
  try {
    // Stay inside the profile's viewport - pointer events at coordinates the
    // window does not contain are not something a mouse can produce.
    for (let i = 0; i < rand(3, 6); i++) {
      await page.mouse.move(rand(20, w - 20), rand(20, h - 20), { steps: rand(8, 20) });
      await page.waitForTimeout(rand(120, 400));
    }
    for (let i = 0; i < rand(2, 4); i++) {
      await page.mouse.wheel(0, rand(300, 900));
      await page.waitForTimeout(rand(400, 1100));
    }
  } catch { /* page may navigate mid-gesture */ }
}
