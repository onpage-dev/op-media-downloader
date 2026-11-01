/**
 * The app's icons, drawn from the On Page mark (the power button of the logo, as onpage-ui's OpLogo
 * draws it: the ring in ink, the bar in the brand green) and rendered by the command line of
 * VectorCraft (https://getartcraft.com/apps/vectorcraft) one size at a time, so small icons stay sharp:
 *
 * - macOS, build/icon.icns: Apple's rounded square, 824 of 1024 with continuous corners and a shadow;
 *   build/icon.png is its 1024 px picture (the README)
 * - Windows, build/icon.ico: a tile as large as the icon, so that 16 px still reads
 * - Linux, build/icons/<n>x<n>.png (the window's icon too): GNOME's grid, with the depth of the tile's
 *   bottom edge
 * - the tray, build/tray.png (32 px), and the window's title bar, src/renderer/assets/app-icon.png: the
 *   Windows tile; -dark.png the same tile for a dark taskbar or window
 * - macOS's menu bar, build/trayTemplate.png (32 px): the mark alone in black, a template image that macOS
 *   paints in the menu bar's colour
 *
 * `vectorcraft-cli` from VECTORCRAFT_CLI, VectorCraft's Windows install folder or the PATH.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMP = mkdtempSync(path.join(os.tmpdir(), 'app-icons-'))

/** The mark of OpLogo (`small`) in its own units; the logo files paint it in these two inks */
const MARK = {
  ring: 'M158.967 33.7571C158.967 31.9227 160.842 30.6894 162.502 31.4706C200.076 49.1539 226.075 87.3545 226.076 131.618C226.075 192.713 176.546 242.242 115.451 242.242C54.3578 242.241 4.83188 192.712 4.8313 131.618L4.8521 129.443C5.69469 85.752 31.8691 48.2575 69.3103 31.0501C70.9685 30.288 72.8254 31.5216 72.8252 33.3465L72.8215 75.1642C72.8214 75.9552 72.4531 76.6994 71.8362 77.1944C55.9158 89.9694 45.7104 109.604 45.7102 131.618C45.7108 170.134 76.9356 201.358 115.451 201.359L117.252 201.334C154.937 200.379 185.196 169.533 185.197 131.618L185.168 129.555C184.571 109.017 175.088 90.7056 160.448 78.3316L159.899 77.8796C159.309 77.3941 158.967 76.6703 158.967 75.9064V33.7571Z',
  bar: 'M95.6567 26.114C95.6572 14.9567 104.702 5.91205 115.859 5.91162C127.017 5.91162 136.061 14.9564 136.061 26.114V94.0001L136.037 95.0399C135.495 105.714 126.668 114.202 115.859 114.202C105.051 114.202 96.2237 105.714 95.6817 95.0399L95.6567 94.0001V26.114Z',
  ink: '#181818',
  green: '#52ca7c',
  /** OpLogo centres the ring across and the whole mark from top to bottom */
  center_x: 115.451,
  top: 5.91162,
  bottom: 242.242,
}

const num = value => Number(value.toFixed(3))

/** `units` of the 1024 drawing rounded to whole pixels at `size`, so that edges fall on the pixel grid */
const snap = (units, size) => (Math.round((units * size) / 1024) * 1024) / size

const gradient = (id, top, bottom) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`

/** The mark `height` units tall, centred on (x, y) */
function mark(x, y, height, ink = MARK.ink, green = MARK.green) {
  const scale = height / (MARK.bottom - MARK.top)
  const left = x - MARK.center_x * scale
  const top = y - ((MARK.top + MARK.bottom) / 2) * scale
  return (
    `<g transform="translate(${num(left)} ${num(top)}) scale(${num(scale)})">` +
    `<path d="${MARK.ring}" fill="${ink}" fill-rule="evenodd"/>` +
    `<path d="${MARK.bar}" fill="${green}" fill-rule="evenodd"/></g>`
  )
}

/**
 * A rounded square with continuous corners, as Figma draws them with corner smoothing: the curve
 * eases into the straight sides instead of meeting them as a circle does
 */
function squircle(x, y, side, radius, smoothing) {
  const rad = degrees => (degrees * Math.PI) / 180
  const p = (1 + smoothing) * radius
  const arc_measure = 90 * (1 - smoothing)
  const arc = Math.sin(rad(arc_measure / 2)) * radius * Math.SQRT2
  const alpha = (90 - arc_measure) / 2
  const c = radius * Math.tan(rad(alpha / 2)) * Math.cos(rad(45 * smoothing))
  const d = c * Math.tan(rad(45 * smoothing))
  const b = (p - arc - c - d) / 3
  const a = 2 * b
  const [A, AB, ABC, R, ARC, C, D, BC] = [a, a + b, a + b + c, radius, arc, c, d, b + c].map(num)
  return [
    `M${num(x + side - p)} ${num(y)}`,
    `c${A} 0 ${AB} 0 ${ABC} ${D}a${R} ${R} 0 0 1 ${ARC} ${ARC}c${D} ${C} ${D} ${BC} ${D} ${ABC}`,
    `L${num(x + side)} ${num(y + side - p)}`,
    `c0 ${A} 0 ${AB} ${-D} ${ABC}a${R} ${R} 0 0 1 ${-ARC} ${ARC}c${-C} ${D} ${-BC} ${D} ${-ABC} ${D}`,
    `L${num(x + p)} ${num(y + side)}`,
    `c${-A} 0 ${-AB} 0 ${-ABC} ${-D}a${R} ${R} 0 0 1 ${-ARC} ${-ARC}c${-D} ${-C} ${-D} ${-BC} ${-D} ${-ABC}`,
    `L${num(x)} ${num(y + p)}`,
    `c0 ${-A} 0 ${-AB} ${D} ${-ABC}a${R} ${R} 0 0 1 ${ARC} ${-ARC}c${C} ${-D} ${BC} ${-D} ${ABC} ${-D}Z`,
  ].join('')
}

const LAYOUTS = {
  /** Apple's grid: the rounded square 824 of 1024, its shadow below and a one-pixel edge for white windows */
  macos(size) {
    const px = 1024 / size
    return {
      defs:
        gradient('face', '#ffffff', '#e8e8e5') +
        '<filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">' +
        '<feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000000" flood-opacity="0.3"/></filter>',
      body:
        `<path d="${squircle(100, 100, 824, 185.4, 0.6)}" fill="url(#face)" filter="url(#shadow)"/>` +
        `<path d="${squircle(100 + px / 2, 100 + px / 2, 824 - px, 185.4 - px / 2, 0.6)}" fill="none" ` +
        `stroke="#000000" stroke-opacity="0.1" stroke-width="${num(px)}"/>` +
        mark(512, 512, 0.58 * 824),
    }
  },

  /** The whole icon, with a pixel around it from 32 px up; the mark larger where pixels are few */
  windows(size, dark = false) {
    const px = 1024 / size
    const inset = snap(20, size)
    const side = 1024 - 2 * inset
    const radius = num(0.19 * side)
    const [top, bottom, edge, ink] = dark
      ? ['#3a3a3a', '#252525', '#ffffff', '#f2f2f0']
      : ['#ffffff', '#ebebe8', '#000000', MARK.ink]
    return {
      defs: gradient('face', top, bottom),
      body:
        `<rect x="${num(inset)}" y="${num(inset)}" width="${num(side)}" height="${num(side)}" rx="${radius}" ` +
        `fill="url(#face)"/>` +
        `<rect x="${num(inset + px / 2)}" y="${num(inset + px / 2)}" width="${num(side - px)}" ` +
        `height="${num(side - px)}" rx="${num(radius - px / 2)}" fill="none" stroke="${edge}" ` +
        `stroke-opacity="${dark ? 0.18 : 0.14}" stroke-width="${num(px)}"/>` +
        mark(512, 512, (size <= 32 ? 0.68 : 0.62) * side, ink),
    }
  },

  /** The same tile for dark windows and taskbars: a dark face, the ring light as the text on it */
  windows_dark(size) {
    return LAYOUTS.windows(size, true)
  },

  /** GNOME's grid of 128: 8 around the tile, the bottom 4 a darker edge that gives the tile its depth */
  linux(size) {
    const px = 1024 / size
    const margin = snap(64, size)
    const depth = Math.max(snap(32, size), px)
    const side = 1024 - 2 * margin
    const radius = num(0.16 * side)
    const face = side - depth
    return {
      defs: gradient('face', '#ffffff', '#efefec'),
      body:
        `<rect x="${num(margin)}" y="${num(margin)}" width="${num(side)}" height="${num(side)}" rx="${radius}" ` +
        `fill="#c9c9c4"/>` +
        `<rect x="${num(margin)}" y="${num(margin)}" width="${num(side)}" height="${num(face)}" rx="${radius}" ` +
        `fill="url(#face)"/>` +
        `<rect x="${num(margin + px / 2)}" y="${num(margin + px / 2)}" width="${num(side - px)}" ` +
        `height="${num(side - px)}" rx="${num(radius - px / 2)}" fill="none" stroke="#000000" ` +
        `stroke-opacity="0.12" stroke-width="${num(px)}"/>` +
        mark(512, margin + face / 2, 0.6 * side),
    }
  },

  /** macOS's menu bar: the mark alone, as tall as the icon, in black (macOS reads only its transparency) */
  menubar() {
    return { defs: '', body: mark(512, 512, 0.94 * 1024, '#000000', '#000000') }
  },
}

function vectorcraft() {
  if (process.env.VECTORCRAFT_CLI) return process.env.VECTORCRAFT_CLI
  const installed = 'C:\\Program Files\\VectorCraft\\vectorcraft-cli.exe'
  return process.platform == 'win32' && existsSync(installed) ? installed : 'vectorcraft-cli'
}

/** The layout at `size` pixels, as PNG */
function render(layout, size) {
  const { defs, body } = LAYOUTS[layout](size)
  const source = path.join(TEMP, `${layout}-${size}.svg`)
  const target = path.join(TEMP, `${layout}-${size}.png`)
  writeFileSync(
    source,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">` +
      `<defs>${defs}</defs>${body}</svg>`,
  )
  execFileSync(vectorcraft(), ['convert', source, target, '--scale', String(size / 1024)], { stdio: 'pipe' })
  const png = readFileSync(target)
  if (png.readUInt32BE(16) != size || png.readUInt32BE(20) != size)
    throw new Error(`${layout} at ${size} px: wrong size`)
  return png
}

/** The pixels of an 8-bit RGBA PNG, as VectorCraft writes them */
function pixels(png) {
  const parts = []
  let width = 0
  let height = 0
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    if (type == 'IHDR') {
      ;[width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)]
      if (data[8] != 8 || data[9] != 6 || data[12] != 0) throw new Error('Not an 8-bit RGBA PNG')
    }
    if (type == 'IDAT') parts.push(data)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * 4
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? out[y * stride + i - 4] : 0
      const up = y > 0 ? out[(y - 1) * stride + i] : 0
      const corner = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0
      const value = raw[y * (stride + 1) + 1 + i]
      const guess = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter]
      out[y * stride + i] = (value + guess) & 0xff
    }
  }
  return out
}

function paeth(left, up, corner) {
  const p = left + up - corner
  const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)]
  return a <= b && a <= c ? left : b <= c ? up : corner
}

/** An icon's 32-bit bitmap: BGRA rows from the bottom up, then the mask of its transparent pixels */
function bitmap(png, size) {
  const rgba = pixels(png)
  const mask_row = Math.ceil(size / 32) * 4
  const out = Buffer.alloc(40 + size * size * 4 + mask_row * size)
  out.writeUInt32LE(40, 0)
  out.writeInt32LE(size, 4)
  out.writeInt32LE(size * 2, 8)
  out.writeUInt16LE(1, 12)
  out.writeUInt16LE(32, 14)
  out.writeUInt32LE(size * size * 4 + mask_row * size, 20)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = 40 + ((size - 1 - y) * size + x) * 4
      ;[out[to], out[to + 1], out[to + 2], out[to + 3]] = [rgba[from + 2], rgba[from + 1], rgba[from], rgba[from + 3]]
      if (rgba[from + 3] == 0) out[40 + size * size * 4 + (size - 1 - y) * mask_row + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return out
}

/** Windows: bitmaps up to 128 px, as the installer and every Explorer read them; 256 px as PNG */
function ico(sizes) {
  const images = sizes.map(size => ({
    size,
    data: size < 256 ? bitmap(render('windows', size), size) : render('windows', size),
  }))
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    head[at] = head[at + 1] = size < 256 ? size : 0
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(data.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map(image => image.data)])
}

/** macOS: every size as PNG, under each type macOS reads it from (1x and 2x) */
function icns() {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32],
    ['icp6', 64],
    ['ic12', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024],
  ]
  const pngs = new Map()
  const chunks = types.map(([type, size]) => {
    if (!pngs.has(size)) pngs.set(size, render('macos', size))
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(8 + pngs.get(size).length, 4)
    return Buffer.concat([head, pngs.get(size)])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

function write(file, data) {
  mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true })
  writeFileSync(path.join(ROOT, file), data)
  console.log(`${file} (${Math.round(data.length / 1024)} KB)`)
}

try {
  write('build/icon.icns', icns())
  write('build/icon.ico', ico([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]))
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512])
    write(`build/icons/${size}x${size}.png`, render('linux', size))
  write('build/icon.png', render('macos', 1024))
  write('build/tray.png', render('windows', 32))
  write('build/tray-dark.png', render('windows_dark', 32))
  write('build/trayTemplate.png', render('menubar', 32))
  write('src/renderer/assets/app-icon.png', render('windows', 64))
  write('src/renderer/assets/app-icon-dark.png', render('windows_dark', 64))
} catch (error) {
  console.error(
    error.code == 'ENOENT'
      ? 'App icons: no vectorcraft-cli. Install VectorCraft (https://getartcraft.com/apps/vectorcraft) or set VECTORCRAFT_CLI'
      : `App icons: ${error.stderr?.toString().trim() || error.message}`,
  )
  process.exitCode = 1
} finally {
  rmSync(TEMP, { recursive: true, force: true })
}
