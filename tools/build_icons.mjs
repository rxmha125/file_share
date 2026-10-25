/**
 * build_icons.mjs — generate an inline SVG sprite from @hugeicons/core-free-icons.
 *
 * Reads the package's ESM icon modules (each exports an array of
 * [tagName, attrs] tuples), converts camelCase attrs to kebab-case, and writes
 * a <symbol> sprite into public/assets/icons.sprite.html.
 *
 * The sprite is then inlined into public/index.html between the markers
 *   <!-- ICON_SPRITE:START -->  ...  <!-- ICON_SPRITE:END -->
 * so <use href="#i-name"> resolves same-document and inherits currentColor.
 *
 *   node tools/build_icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'node_modules/@hugeicons/core-free-icons/dist/esm');
const OUT = path.join(ROOT, 'public/assets/icons.sprite.html');
const HTML = path.join(ROOT, 'public/index.html');

// sprite id -> hugeicons module name
const ICONS = {
  'i-home':      'Home01Icon',
  'i-clock':     'Clock01Icon',
  'i-image':     'Image01Icon',
  'i-video':     'Video01Icon',
  'i-file':      'File01Icon',
  'i-folder':    'Folder01Icon',
  'i-link':      'Link01Icon',
  'i-trash':     'Delete02Icon',
  'i-plus':      'PlusSignIcon',
  'i-search':    'Search01Icon',
  'i-sun':       'Sun01Icon',
  'i-moon':      'Moon02Icon',
  'i-help':      'HelpCircleIcon',
  'i-grid':      'GridViewIcon',
  'i-list':      'ListIcon',
  'i-more':      'MoreVerticalIcon',
  'i-upload':    'Upload01Icon',
  'i-cloud':     'CloudUploadIcon',
  'i-download':  'Download01Icon',
  'i-copy':      'Copy01Icon',
  'i-external':  'ArrowUpRight01Icon',
  'i-alert':     'AlertCircleIcon',
  'i-menu':      'Menu01Icon',
  'i-storage':   'HardDriveIcon',
  'i-check':     'Tick02Icon',
  'i-chevron':   'ArrowDown01Icon',
  'i-close':     'Cancel01Icon',
  'i-user':      'UserIcon',
  'i-music':     'MusicNote01Icon',
  'i-archive':   'FileArchiveIcon',
  'i-chevron-r': 'ChevronRightIcon',
};

const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

function attrString(attrs) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'key') continue;
    // Hugeicons uses stroke: "currentColor" + strokeWidth. Normalise to kebab.
    parts.push(`${kebab(k)}="${String(v).replace(/"/g, '&quot;')}"`);
  }
  return parts.join(' ');
}

function loadIcon(moduleName) {
  const file = path.join(PKG, moduleName + '.js');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  // The module body is a literal array; evaluate it in isolation.
  const m = src.match(/const\s+\w+\s*=\s*(\[[\s\S]*?\n\]);/);
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1]});`)();
}

const symbols = [];
const missing = [];

for (const [id, moduleName] of Object.entries(ICONS)) {
  const nodes = loadIcon(moduleName);
  if (!nodes) { missing.push(`${id} -> ${moduleName}`); continue; }
  const inner = nodes
    .map(([tag, attrs]) => `<${tag} ${attrString(attrs)}/>`)
    .join('');
  symbols.push(`<symbol id="${id}" viewBox="0 0 24 24" fill="none">${inner}</symbol>`);
}

if (missing.length) {
  console.warn('MISSING ICONS:\n  ' + missing.join('\n  '));
}

const sprite =
  `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" ` +
  `style="position:absolute;width:0;height:0;overflow:hidden">\n` +
  symbols.join('\n') +
  `\n</svg>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, sprite, 'utf8');
console.log(`wrote ${path.relative(ROOT, OUT)} — ${symbols.length} symbols, ${sprite.length} bytes`);

// Inline into index.html between the markers, if present.
if (fs.existsSync(HTML)) {
  const html = fs.readFileSync(HTML, 'utf8');
  const start = '<!-- ICON_SPRITE:START -->';
  const end = '<!-- ICON_SPRITE:END -->';
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a !== -1 && b !== -1 && b > a) {
    const next = html.slice(0, a + start.length) + '\n' + sprite + '\n' + html.slice(b);
    fs.writeFileSync(HTML, next, 'utf8');
    console.log('inlined sprite into public/index.html');
  } else {
    console.log('(no markers in index.html — sprite left as a standalone file)');
  }
}
