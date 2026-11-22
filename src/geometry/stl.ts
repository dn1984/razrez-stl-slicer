// STL: разбор (бинарный и ASCII) и запись (бинарный).

export interface ParsedSTL {
  /** Позиции вершин треугольной каши: 9 чисел на треугольник. */
  positions: Float32Array;
  triangles: number;
  format: 'binary' | 'ascii';
}

const FILE_HEADER = 84;
const TRI_SIZE = 50;

export class STLError extends Error {}

function looksBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < FILE_HEADER) return false;
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  // Точное совпадение размера — самый надёжный признак бинарного STL.
  if (FILE_HEADER + count * TRI_SIZE === buffer.byteLength) return true;
  // Иногда в конце файла есть мусор: проверяем, что размер не меньше ожидаемого.
  if (FILE_HEADER + count * TRI_SIZE <= buffer.byteLength) {
    const head = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength));
    let text = '';
    for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
    return !/^\s*solid\s/i.test(text) || count > 0;
  }
  return false;
}

export function parseSTL(buffer: ArrayBuffer): ParsedSTL {
  if (buffer.byteLength === 0) throw new STLError('Файл пуст.');
  if (looksBinary(buffer)) return parseBinary(buffer);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (/^\s*solid\s/i.test(text)) return parseASCII(text);
  // Не ASCII и не похоже на бинарный — пробуем бинарный разбор как последний шанс.
  return parseBinary(buffer);
}

function parseBinary(buffer: ArrayBuffer): ParsedSTL {
  if (buffer.byteLength < FILE_HEADER) throw new STLError('Файл короче заголовка STL.');
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const need = FILE_HEADER + count * TRI_SIZE;
  if (count === 0) throw new STLError('В файле нет треугольников.');
  if (need > buffer.byteLength) {
    throw new STLError(`Файл обрезан: заявлено ${count} треугольников, не хватает ${need - buffer.byteLength} байт.`);
  }
  const positions = new Float32Array(count * 9);
  let o = 0;
  for (let i = 0; i < count; i++) {
    let p = FILE_HEADER + i * TRI_SIZE + 12; // пропускаем нормаль
    for (let v = 0; v < 9; v++) {
      positions[o++] = view.getFloat32(p, true);
      p += 4;
    }
  }
  return { positions, triangles: count, format: 'binary' };
}

const VERTEX_RE = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;

function parseASCII(text: string): ParsedSTL {
  const values: number[] = [];
  VERTEX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VERTEX_RE.exec(text)) !== null) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (values.length === 0) throw new STLError('В ASCII-STL не найдено ни одной вершины (нет строк «vertex»).');
  const triangles = Math.floor(values.length / 9);
  if (triangles === 0) throw new STLError('В ASCII-STL меньше трёх вершин.');
  const positions = new Float32Array(triangles * 9);
  for (let i = 0; i < triangles * 9; i++) positions[i] = values[i];
  return { positions, triangles, format: 'ascii' };
}

/** Записывает бинарный STL. Позиции должны быть «кашей» (9 чисел на треугольник). */
export function writeBinarySTL(positions: ArrayLike<number>, name = 'razrez'): ArrayBuffer {
  const triangles = Math.floor(positions.length / 9);
  const buffer = new ArrayBuffer(FILE_HEADER + triangles * TRI_SIZE);
  const view = new DataView(buffer);
  writeHeader(view, triangles, name);
  let o = FILE_HEADER;
  for (let t = 0; t < triangles; t++) {
    const b = t * 9;
    o = writeTriangle(view, o, positions, b, b + 3, b + 6);
  }
  return buffer;
}

/** Записывает бинарный STL из индексированной сетки (как хранит сцена). */
export function writeBinarySTLIndexed(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  name = 'razrez',
): ArrayBuffer {
  const triangles = Math.floor(indices.length / 3);
  const buffer = new ArrayBuffer(FILE_HEADER + triangles * TRI_SIZE);
  const view = new DataView(buffer);
  writeHeader(view, triangles, name);
  let o = FILE_HEADER;
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    o = writeTriangle(view, o, positions, a, b, c);
  }
  return buffer;
}

function writeHeader(view: DataView, triangles: number, name: string) {
  const header = `${name} — Разрез`.slice(0, 79);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, triangles, true);
}

/** Пишет один треугольник (нормаль + 3 вершины + атрибут), возвращает новое смещение. */
function writeTriangle(
  view: DataView,
  offset: number,
  source: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
): number {
  const ax = source[ia], ay = source[ia + 1], az = source[ia + 2];
  const bx = source[ib], by = source[ib + 1], bz = source[ib + 2];
  const cx = source[ic], cy = source[ic + 1], cz = source[ic + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-12) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = ny = nz = 0;
  }
  let o = offset;
  view.setFloat32(o, nx, true);
  view.setFloat32(o + 4, ny, true);
  view.setFloat32(o + 8, nz, true);
  o += 12;
  for (const v of [ax, ay, az, bx, by, bz, cx, cy, cz]) {
    view.setFloat32(o, v, true);
    o += 4;
  }
  view.setUint16(o, 0, true);
  return o + 2;
}
