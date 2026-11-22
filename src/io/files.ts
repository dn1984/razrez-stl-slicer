// Сохранение частей в STL и проекта в JSON.

import { writeBinarySTLIndexed } from '../geometry/stl.ts';
import type { PartGeometry } from '../geometry/types.ts';
import type { AppState } from '../app/state.ts';

/** Безопасное имя файла из названия модели. */
export function safeName(name: string): string {
  return (
    name
      .replace(/\.stl$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'модель'
  );
}

export function partFileName(modelName: string, part: PartGeometry): string {
  return `${safeName(modelName)}_${part.side}${part.id.replace(/[^0-9]/g, '')}.stl`;
}

export function partBuffer(part: PartGeometry, modelName: string): ArrayBuffer {
  return writeBinarySTLIndexed(part.positions, part.indices, partFileName(modelName, part));
}

interface FileSystemWritable {
  write(data: ArrayBuffer | Blob | string): Promise<void>;
  close(): Promise<void>;
}
interface DirectoryHandle {
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<FileSystemWritable> }>;
}
interface PickerWindow {
  showDirectoryPicker?: (options?: { mode?: string; id?: string }) => Promise<DirectoryHandle>;
}

/**
 * Сохраняет все части в выбранную папку одним действием.
 * Возвращает число записанных файлов или null, если API недоступен.
 */
export async function savePartsToFolder(parts: PartGeometry[], modelName: string): Promise<number | null> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  let handle: DirectoryHandle;
  try {
    handle = await picker({ mode: 'readwrite', id: 'razrez-parts' });
  } catch (err) {
    // Пользователь закрыл диалог — это не ошибка.
    if ((err as Error)?.name === 'AbortError') return 0;
    return null;
  }
  let written = 0;
  for (const part of parts) {
    const name = partFileName(modelName, part);
    const file = await handle.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(new Blob([partBuffer(part, modelName)], { type: 'model/stl' }));
    await writable.close();
    written++;
  }
  return written;
}

/** Резервный путь: по одному файлу через загрузки браузера. */
export function downloadPart(part: PartGeometry, modelName: string) {
  const blob = new Blob([partBuffer(part, modelName)], { type: 'model/stl' });
  downloadBlob(blob, partFileName(modelName, part));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Даём браузеру время начать загрузку.
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

/* ------------------------------------------------------------------ проект */

export interface ProjectFile {
  app: 'razrez';
  version: 1;
  savedAt: string;
  modelName: string;
  state: Omit<AppState, 'model'>;
}

export function serializeProject(state: AppState): ProjectFile {
  const { model, ...rest } = state;
  return {
    app: 'razrez',
    version: 1,
    savedAt: new Date().toISOString(),
    modelName: model?.name ?? 'модель',
    state: rest,
  };
}

export function parseProject(text: string): ProjectFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл проекта повреждён: это не JSON.');
  }
  const obj = data as Partial<ProjectFile>;
  if (obj.app !== 'razrez') throw new Error('Это не файл проекта «Разрез».');
  if (!obj.state || typeof obj.state !== 'object') throw new Error('В проекте нет настроек реза.');
  return obj as ProjectFile;
}
