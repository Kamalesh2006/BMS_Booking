// Synthetic hardware profiles: CPU, RAM, GPU, display, storage and network,
// generated as one *coherent* machine rather than a bag of independent values.
//
// Why coherence and not just "randomise everything": bot scoring does not look
// for unusual values, it looks for combinations that cannot exist. A 32 GB
// workstation reporting 2 CPU cores, a discrete RTX card driving a 1366x768
// panel, or `deviceMemory: 16` (a value the spec does not allow) is a far
// stronger signal than the boring defaults it replaced. So a profile is built
// from a machine archetype outwards, and every derived number - viewport,
// available screen area, JS heap ceiling - is computed from it.
//
// Why it rotates: the checker loads the same URL every hour. Repeating one
// byte-identical fingerprint against the same origin is exactly the pattern
// that gets a visitor promoted to "interactive challenge". Each run (and each
// retry within a run) draws a different machine, seeded so a given run is
// reproducible from its log line.

// --- seeded PRNG -------------------------------------------------------------
// Deterministic so a failing run can be replayed with the same profile from the
// seed printed in its log.

function hashSeed(input) {
  let h = 2166136261 >>> 0;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- hardware tables ---------------------------------------------------------

/**
 * ANGLE's D3D11 backend reports the same limits regardless of which card is
 * underneath, so these are shared and only the vendor/renderer strings vary.
 * That is also what makes them worth spoofing: SwiftShader's numbers are
 * visibly smaller (8192 max texture, 8192 viewport) and give the software
 * rasteriser away even when the renderer string has been rewritten.
 */
const ANGLE_D3D11_LIMITS = {
  MAX_TEXTURE_SIZE: 16384,
  MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
  MAX_RENDERBUFFER_SIZE: 16384,
  MAX_VIEWPORT_DIMS: [32767, 32767],
  MAX_VERTEX_ATTRIBS: 16,
  MAX_VERTEX_UNIFORM_VECTORS: 4096,
  MAX_VARYING_VECTORS: 30,
  MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  ALIASED_LINE_WIDTH_RANGE: [1, 1],
  ALIASED_POINT_SIZE_RANGE: [1, 1024],
  // WebGL2 only; ignored when the constant does not exist on the context.
  MAX_3D_TEXTURE_SIZE: 2048,
  MAX_ARRAY_TEXTURE_LAYERS: 2048,
  MAX_DRAW_BUFFERS: 8,
  MAX_COLOR_ATTACHMENTS: 8,
  MAX_SAMPLES: 8,
  MAX_UNIFORM_BUFFER_BINDINGS: 24,
  MAX_ELEMENT_INDEX: 4294967294
};

/** Extension list a real Chrome/Windows/D3D11 context advertises for WebGL1. */
const WEBGL1_EXTENSIONS = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control',
  'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_float_blend',
  'EXT_frag_depth', 'EXT_polygon_offset_clamp', 'EXT_shader_texture_lod',
  'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic', 'EXT_texture_mirror_clamp_to_edge',
  'EXT_sRGB', 'KHR_parallel_shader_compile', 'OES_element_index_uint',
  'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float',
  'OES_texture_float_linear', 'OES_texture_half_float',
  'OES_texture_half_float_linear', 'OES_vertex_array_object',
  'WEBGL_blend_func_extended', 'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture',
  'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw',
  'WEBGL_polygon_mode'
];

const WEBGL2_EXTENSIONS = [
  'EXT_clip_control', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float',
  'EXT_conservative_depth', 'EXT_depth_clamp', 'EXT_disjoint_timer_query_webgl2',
  'EXT_float_blend', 'EXT_polygon_offset_clamp', 'EXT_render_snorm',
  'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic', 'EXT_texture_mirror_clamp_to_edge',
  'EXT_texture_norm16', 'KHR_parallel_shader_compile',
  'NV_shader_noperspective_interpolation', 'OES_draw_buffers_indexed',
  'OES_sample_variables', 'OES_shader_multisample_interpolation',
  'OES_texture_float_linear', 'OVR_multiview2',
  'WEBGL_blend_func_extended', 'WEBGL_clip_cull_distance',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_lose_context',
  'WEBGL_multi_draw', 'WEBGL_polygon_mode', 'WEBGL_provoking_vertex',
  'WEBGL_stencil_texturing'
];

/**
 * Displays as Chrome reports them: `screen.width/height` are already divided by
 * the Windows scaling factor, so a 1080p panel at 125% reports 1536x864 and a
 * devicePixelRatio of 1.25. `taskbar` is the strip Windows reserves, which is
 * what makes availHeight < height - the equality headless produces is a tell.
 */
const DISPLAYS = {
  fhd:        { width: 1920, height: 1080, dpr: 1,    taskbar: 40 },
  fhd125:     { width: 1536, height: 864,  dpr: 1.25, taskbar: 32 },
  qhd:        { width: 2560, height: 1440, dpr: 1,    taskbar: 48 },
  qhd150:     { width: 1707, height: 960,  dpr: 1.5,  taskbar: 36 },
  laptop_hd:  { width: 1366, height: 768,  dpr: 1,    taskbar: 40 },
  laptop_fhd: { width: 1600, height: 900,  dpr: 1,    taskbar: 40 }
};

/**
 * Machine archetypes. Cores, RAM and panel are constrained per archetype so a
 * draw can never produce a combination that does not ship: nobody pairs a
 * Radeon RX 6600 with 4 GB of RAM and a 1366x768 screen.
 */
const MACHINES = [
  {
    id: 'nvidia-rtx3060-desktop',
    gpuVendor: 'Google Inc. (NVIDIA)',
    gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [8, 12, 16],
    ramGiB: [16, 32],
    displays: ['fhd', 'qhd', 'qhd150']
  },
  {
    id: 'nvidia-gtx1650-desktop',
    gpuVendor: 'Google Inc. (NVIDIA)',
    gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [6, 8],
    ramGiB: [8, 16],
    displays: ['fhd', 'fhd125']
  },
  {
    id: 'nvidia-rtx4060-laptop',
    gpuVendor: 'Google Inc. (NVIDIA)',
    gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [12, 16],
    ramGiB: [16, 32],
    displays: ['fhd125', 'qhd150', 'fhd']
  },
  {
    id: 'intel-irisxe-laptop',
    gpuVendor: 'Google Inc. (Intel)',
    gpuRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A8) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [8, 12],
    ramGiB: [8, 16],
    displays: ['fhd125', 'fhd', 'laptop_fhd']
  },
  {
    id: 'intel-uhd630-desktop',
    gpuVendor: 'Google Inc. (Intel)',
    gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [4, 6, 8],
    ramGiB: [8, 16],
    displays: ['fhd', 'laptop_hd', 'laptop_fhd']
  },
  {
    id: 'intel-uhd620-laptop',
    gpuVendor: 'Google Inc. (Intel)',
    gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [4, 8],
    ramGiB: [8, 16],
    displays: ['laptop_hd', 'fhd125', 'fhd']
  },
  {
    id: 'amd-rx6600-desktop',
    gpuVendor: 'Google Inc. (AMD)',
    gpuRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [8, 12, 16],
    ramGiB: [16, 32],
    displays: ['fhd', 'qhd']
  },
  {
    id: 'amd-vega-laptop',
    gpuVendor: 'Google Inc. (AMD)',
    gpuRenderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: [8, 12],
    ramGiB: [8, 16],
    displays: ['fhd125', 'fhd', 'laptop_fhd']
  }
];

// Chrome's own UI: tab strip + omnibox, in CSS pixels. It stays roughly
// constant across scaling factors because the browser chrome scales with it.
const BROWSER_CHROME_PX = 119;

// --- profile construction ----------------------------------------------------

/**
 * Build one internally consistent machine.
 *
 * @param seed  anything stringifiable; the same seed always yields the same
 *              machine, so a run can be reproduced from its log.
 */
export function buildProfile(seed) {
  const seedInt = hashSeed(seed);
  const rnd = mulberry32(seedInt);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const machine = pick(MACHINES);
  const cores = pick(machine.cores);
  const ramGiB = pick(machine.ramGiB);
  const display = DISPLAYS[pick(machine.displays)];

  const availWidth = display.width;
  const availHeight = display.height - display.taskbar;

  // A maximized window: the frame fills the work area and the viewport is what
  // is left under Chrome's own UI. Deriving it this way keeps
  // innerHeight < outerHeight <= availHeight <= height, which is the ordering a
  // real window always satisfies and headless frequently does not.
  const outerWidth = availWidth;
  const outerHeight = availHeight;
  const viewport = {
    width: outerWidth,
    height: Math.max(600, outerHeight - BROWSER_CHROME_PX)
  };

  // navigator.deviceMemory is quantised and capped at 8 by the spec. Reporting
  // the true 16 or 32 is an immediate giveaway, so the real figure is kept only
  // for the heap ceiling below.
  const deviceMemory = Math.min(8, ramGiB);

  // V8 raises its heap ceiling on machines with plenty of RAM; the two values
  // below are the ones 64-bit desktop Chrome actually reports.
  const jsHeapSizeLimit = ramGiB >= 16 ? 4294705152 : 2172649472;

  // Quota is ~60% of free disk, so it varies per machine but stays in a
  // believable band for a consumer SSD.
  const quota = Math.floor((90 + rnd() * 320) * 1024 * 1024 * 1024);

  return {
    seed: String(seed),
    seedInt,
    id: machine.id,

    cpu: { cores },

    memory: { ramGiB, deviceMemory, jsHeapSizeLimit },

    gpu: {
      vendor: machine.gpuVendor,
      renderer: machine.gpuRenderer,
      limits: ANGLE_D3D11_LIMITS,
      maxAnisotropy: 16,
      extensions1: WEBGL1_EXTENSIONS,
      extensions2: WEBGL2_EXTENSIONS
    },

    screen: {
      width: display.width,
      height: display.height,
      availWidth,
      availHeight,
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      pixelDepth: 24,
      dpr: display.dpr
    },

    viewport,
    window: { outerWidth, outerHeight, screenX: 0, screenY: 0 },

    storage: { quota },

    // Chrome quantises these before exposing them: rtt to 25 ms, downlink to
    // 0.05 Mbps and capped at 10. Values outside that lattice do not occur.
    network: {
      effectiveType: '4g',
      rtt: pick([50, 75, 100, 125, 150]),
      downlink: pick([5, 6.55, 7.7, 8.95, 10]),
      saveData: false
    },

    // Chennai. navigator.languages and the Accept-Language header are both
    // derived from this one list so they cannot drift apart.
    languages: ['en-IN', 'en-GB', 'en'],
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',

    // Windows 11 reports platform version 15.0.0, Windows 10 reports 10.0.0 -
    // both while the UA string still says "Windows NT 10.0". Weighted towards
    // 11, matching the current desktop install base.
    platformVersion: rnd() < 0.75 ? '15.0.0' : '10.0.0',

    // Seeds the canvas and audio perturbation. Separate from seedInt so the
    // hardware draw and the noise field are independent.
    noiseSeed: (seedInt ^ 0x9e3779b9) >>> 0
  };
}

/** One-line summary for the run log, so a blocked run is reproducible. */
export function describeProfile(p) {
  return `${p.id} | ${p.cpu.cores} cores | ${p.memory.ramGiB} GB ` +
         `(deviceMemory ${p.memory.deviceMemory}) | ` +
         `${p.screen.width}x${p.screen.height}@${p.screen.dpr} | ` +
         `viewport ${p.viewport.width}x${p.viewport.height} | seed ${p.seed}`;
}
