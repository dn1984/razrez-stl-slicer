// Детектор повреждённой кодировки.
//
// Признак разрушения — символ замены U+FFFD: байты не удалось декодировать.
// Признак двойного перекодирования — кириллическая «Р»/«С», за которой идёт
// символ Latin-1 Supplement (0x80–0xBF): «Р°», «С‚». Обычный русский текст
// («Рез», «Ступенька») под это правило НЕ попадает.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOUBLE_ENCODED = /[РС][\u0080-\u00bf]/g;
const skipDirs = new Set(['node_modules', 'dist', 'out', '.git']);
const exts = /\.(ts|css|html|mjs|md)$/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!skipDirs.has(name)) walk(full, out);
    } else if (exts.test(name) && !name.startsWith('check-encoding')) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
let broken = 0;
for (const full of files) {
  const text = readFileSync(full, 'utf8');
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  const doubled = (text.match(DOUBLE_ENCODED) ?? []).length;
  if (replacement > 0 || doubled > 0) {
    broken++;
    const state = replacement > 20 ? 'РАЗРУШЕН' : doubled > 0 ? 'двойное перекодирование' : 'единичный сбой';
    console.log(
      `${path.relative(ROOT, full).padEnd(34)} U+FFFD ${String(replacement).padStart(5)}  ` +
        `двойных ${String(doubled).padStart(4)}  ${state}`,
    );
  }
}
console.log(broken === 0 ? '\nКодировка в порядке.' : `\nФайлов с проблемами: ${broken}`);
process.exit(broken === 0 ? 0 : 1);
