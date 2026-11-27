// Главный модуль: связывает панели, сцену и воркер геометрии.

import './ui/styles.css';
import { Viewer } from './viewer/viewer.ts';
import { parseSTL, STLError } from './geometry/stl.ts';
import {
  initialState,
  allCuts,
  primaryCut,
  secondaryCut,
  planeRange,
  centerOf,
  sizeOf,
} from './app/state.ts';
import type { AppState, Axis } from './app/state.ts';
import type {
  LoadedResponse,
  ResultResponse,
  PreviewResponse,
  WorkerResponse,
} from './worker/protocol.ts';
import type { PartGeometry, CutStats, Vec2, Vec3 } from './geometry/types.ts';
import { basisFromNormal } from './geometry/math.ts';
import GeometryWorker from './worker/geometry.worker.ts?worker&inline';
import { downloadPart, savePartsToFolder, serializeProject, parseProject, downloadBlob, safeName } from './io/files.ts';

const state: AppState = initialState();
const viewer = new Viewer(document.getElementById('viewport') as HTMLElement);
viewer.start();

const worker = new GeometryWorker();
let requestId = 0;
const pending = new Map<number, (msg: WorkerResponse) => void>();
let lastParts: PartGeometry[] = [];
let lastStats: CutStats[] = [];
let busy = false;

/* ------------------------------------------------------------------ утилиты */

/** Человеческое имя оси мира для подсказок: u = (−1,0,0) → «−X». */
function axisName(v: Vec3): string {
  const axes: Array<[string, number]> = [
    ['X', v[0]],
    ['Y', v[1]],
    ['Z', v[2]],
  ];
  for (const [name, value] of axes) {
    if (Math.abs(Math.abs(value) - 1) < 0.02) return value > 0 ? `+${name}` : `−${name}`;
  }
  // Наклонная плоскость: показываем доминирующую ось со знаком.
  const sorted = [...axes].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const [name, value] = sorted[0];
  return value > 0 ? `+${name}` : `−${name}`;
}

/** Подсказка, вдоль каких осей мира двигаются ползунки окна реза. */
function updateAreaAxesHint(basis: { u: Vec3; v: Vec3 }) {
  const host = document.getElementById('cut-area-axes');
  if (!host) return;
  const text = host.querySelector('span:last-child');
  if (!text) return;
  text.textContent = `Оси окна: ширина вдоль ${axisName(basis.u)}, высота вдоль ${axisName(basis.v)}.`;
}

function setAreaCoverageWarning(covered: boolean) {
  document.getElementById('cut-area-full')?.classList.toggle('hidden', !covered);
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

function fmt(n: number, digits = 1): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU');
}

function setValue(name: string, text: string) {
  const el = document.querySelector<HTMLElement>(`[data-value="${name}"]`);
  if (el) el.textContent = text;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${fmt(n / 1024, 0)} КБ`;
  return `${fmt(n / (1024 * 1024), 1)} МБ`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function note(tone: 'ok' | 'warn' | 'bad', mark: string, text: string): string {
  return `<div class="note note--${tone}"><span class="note__mark">${mark}</span><span>${escapeHtml(text)}</span></div>`;
}

/* --------------------------------------------------------------- статус-бар */

type StatusTone = 'idle' | 'busy' | 'ok' | 'warn' | 'bad';

function setStatus(tone: StatusTone, text: string, message = '') {
  const dot = $('#status-state .status__dot');
  const label = $('#status-state span:last-child');
  dot.className = `status__dot status__dot--${tone === 'idle' ? '' : tone}`.trim();
  label.textContent = text;
  $('#status-message').textContent = message;
}

function setTime(ms: number | null) {
  $('#status-time').textContent = ms === null ? '' : `${fmt(ms, 0)} мс`;
}

/* ------------------------------------------------------------------ воркер */

function ask<T extends WorkerResponse>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = ++requestId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Расчёт занял слишком много времени. Попробуйте упростить модель.'));
    }, 180_000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      pending.delete(id);
      if (response.type === 'error') reject(new Error(response.message));
      else resolve(response as T);
    });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const handler = pending.get(e.data.id);
  if (handler) handler(e.data);
};

worker.onerror = (e) => {
  console.error('Воркер упал:', e);
  setStatus('bad', 'Ошибка расчёта', String(e.message ?? 'Внутренняя ошибка геометрического ядра.'));
  busy = false;
};

/* ---------------------------------------------------------------- модальное */

function showModal(title: string, text: string, options: { ok?: string; cancel?: string } = {}) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text;
  $('#modal-ok').textContent = options.ok ?? 'Понятно';
  const cancel = $('#modal-cancel');
  cancel.textContent = options.cancel ?? 'Закрыть';
  cancel.classList.toggle('hidden', !options.cancel);
  modal.hidden = false;
  ($('#modal-ok') as HTMLButtonElement).focus();
}

function hideModal() {
  $('#modal').hidden = true;
}

$('#modal-ok').addEventListener('click', hideModal);
$('#modal-cancel').addEventListener('click', hideModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) hideModal();
});

/* ------------------------------------------------------------------- панели */

for (const section of $$('.section')) {
  const head = section.querySelector('.section__head') as HTMLButtonElement;
  head.addEventListener('click', () => {
    const open = section.dataset.open === 'true';
    section.dataset.open = String(!open);
    head.setAttribute('aria-expanded', String(!open));
  });
}

function setBadge(name: string, text: string | null) {
  for (const el of $$(`[data-badge="${name}"]`)) {
    el.classList.toggle('hidden', !text);
    el.textContent = text ?? '';
  }
}

/* ------------------------------------------------------------- модель: ввод */

async function openFile(file: File) {
  if (busy) return;
  busy = true;
  setStatus('busy', 'Читаю файл', file.name);
  setTime(null);
  try {
    const buffer = await file.arrayBuffer();
    let parsed;
    try {
      parsed = parseSTL(buffer);
    } catch (err) {
      const message = err instanceof STLError ? err.message : String((err as Error)?.message ?? err);
      setStatus('bad', 'Файл не читается', message);
      showModal('Не удалось прочитать файл', message);
      busy = false;
      return;
    }

    const response = await ask<LoadedResponse>(
      { type: 'load', positions: parsed.positions, name: file.name.replace(/\.stl$/i, '') },
      [parsed.positions.buffer],
    );

    if (!response.ok) {
      setStatus('bad', 'Модель не готова к нарезке', response.error ?? '');
      showModal('Модель не замкнута', response.error ?? 'Не удалось подготовить модель.', { ok: 'Понятно' });
      renderModelInfo(null);
      setControlsEnabled(false);
      busy = false;
      return;
    }

    state.model = {
      name: file.name.replace(/\.stl$/i, ''),
      triangles: parsed.triangles,
      weldedVertices: response.weldedVertices,
      degenerate: response.degenerate,
      duplicate: response.duplicate,
      volume: response.volume,
      bboxMin: response.bboxMin,
      bboxMax: response.bboxMax,
      format: parsed.format,
    };
    state.manualPins = [];
    state.planePos = 0;
    state.planeAngle = 0;
    state.extraPos = 0;

    lastParts = [];
    lastStats = [];
    renderParts([]);
    renderChecks(null);
    renderWarnings([]);

    viewer.setSource({
      id: 'source',
      label: state.model.name,
      side: 'A',
      positions: response.positions,
      indices: response.indices,
      volume: response.volume,
      triangles: response.triangles,
      bboxMin: response.bboxMin,
      bboxMax: response.bboxMax,
    });

    renderModelInfo(state.model);
    setControlsEnabled(true);
    syncRangeLimits();
    setStatus('ok', 'Модель загружена', `${fmtInt(parsed.triangles)} треугольников, ${bytes(buffer.byteLength)}`);
    setTime(response.ms);
    setBadge('file', `${fmtInt(parsed.triangles)} тр.`);
    $('#status-tris').textContent = `${fmtInt(parsed.triangles)} тр.`;
    $('#status-parts').textContent = '—';
    updateExtraInfo();
    updatePlaneVisual();
    schedulePreview(0);
  } catch (err) {
    setStatus('bad', 'Ошибка', String((err as Error)?.message ?? err));
    showModal('Что-то пошло не так', String((err as Error)?.message ?? err));
  } finally {
    busy = false;
  }
}

function renderModelInfo(model: AppState['model']) {
  const host = $('#model-info');
  if (!model) {
    host.innerHTML = '';
    return;
  }
  const size = [
    model.bboxMax[0] - model.bboxMin[0],
    model.bboxMax[1] - model.bboxMin[1],
    model.bboxMax[2] - model.bboxMin[2],
  ];
  const notes: string[] = [];
  notes.push(note('ok', 'Габарит', `${size.map((v) => fmt(v, 1)).join(' × ')} мм`));
  notes.push(note('ok', 'Объём', `${fmt(model.volume / 1000, 1)} см³`));
  if (model.duplicate > 0) {
    notes.push(note('warn', 'Дубли', `${fmtInt(model.duplicate)} одинаковых треугольников удалено`));
  }
  if (model.degenerate > 0) {
    notes.push(note('warn', 'Вырожденные', `${fmtInt(model.degenerate)} треугольников нулевой площади удалено`));
  }
  if (Math.max(...size) < 1) {
    notes.push(note('warn', 'Масштаб', 'Модель меньше 1 мм — возможно, файл в дюймах. Увеличьте её в слайсере на 2540 %.'));
  }
  host.innerHTML = notes.join('');
}

/* ------------------------------------------------------------------ вход */

const drop = $('#drop');
const fileInput = $('#file-input') as HTMLInputElement;

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('drop--active');
  });
}
for (const type of ['dragleave', 'drop']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && (e as DragEvent).relatedTarget) return;
    drop.classList.remove('drop--active');
  });
}
window.addEventListener('drop', (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void openFile(file);
});

/* ------------------------------------------------------------------ контролы */

const bindRange = (id: string, key: keyof AppState, format: (v: number) => string) => {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  const update = () => {
    const value = Number(input.value);
    (state[key] as unknown as number) = value;
    setValue(id, format(value));
  };
  input.addEventListener('input', () => {
    update();
    schedulePreview();
  });
  input.value = String(state[key]);
  setValue(id, format(Number(input.value)));
};

const bindSwitch = (id: string, key: keyof AppState, onChange?: (on: boolean) => void) => {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.checked = Boolean(state[key]);
  input.addEventListener('change', () => {
    (state[key] as unknown as boolean) = input.checked;
    onChange?.(input.checked);
    schedulePreview();
  });
};

// Плоскость
for (const button of $$('[data-axis]')) {
  button.addEventListener('click', () => {
    const axis = button.dataset.axis as Axis;
    state.axis = axis;
    for (const b of $$('[data-axis]')) b.setAttribute('aria-pressed', String(b.dataset.axis === axis));
    state.planePos = 0;
    ($('#plane-pos') as HTMLInputElement).value = '0';
    syncRangeLimits();
    updateExtraInfo();
    updatePlaneVisual();
    schedulePreview(0);
  });
}

bindRange('plane-pos', 'planePos', (v) => `${fmt(v, 1)} мм`);
bindRange('plane-angle', 'planeAngle', (v) => {
  updatePlaneVisual();
  return `${fmt(v, 0)}°`;
});
bindSwitch('plane-visible', 'planeVisible', () => updatePlaneVisual());
bindSwitch('cut-area-enabled', 'cutAreaEnabled', () => {
  toggleGroup('cut-area', state.cutAreaEnabled);
  updatePlaneVisual();
  schedulePreview(0);
});
bindRange('cut-width', 'cutWidth', (v) => {
  updatePlaneVisual();
  return `${fmt(v, 0)} мм`;
});
bindRange('cut-height', 'cutHeight', (v) => {
  updatePlaneVisual();
  return `${fmt(v, 0)} мм`;
});
bindRange('cut-offset-u', 'cutOffsetU', (v) => {
  updatePlaneVisual();
  return `${fmt(v, 1)} мм`;
});
bindRange('cut-offset-v', 'cutOffsetV', (v) => {
  updatePlaneVisual();
  return `${fmt(v, 1)} мм`;
});

// Профиль
for (const button of $$('[data-profile]')) {
  button.addEventListener('click', () => {
    const shape = button.dataset.profile as AppState['profileShape'];
    state.profileShape = shape;
    for (const b of $$('[data-profile]')) b.setAttribute('aria-pressed', String(b.dataset.profile === shape));
    updateProfileUi();
    schedulePreview(0);
  });
}
for (const button of $$('[data-falloff]')) {
  button.addEventListener('click', () => {
    const falloff = button.dataset.falloff as AppState['falloff'];
    state.falloff = falloff;
    for (const b of $$('[data-falloff]')) b.setAttribute('aria-pressed', String(b.dataset.falloff === falloff));
    schedulePreview(0);
  });
}
bindRange('profile-height', 'profileHeight', (v) => `${fmt(v, 1)} мм`);

function updateProfileUi() {
  const height = $('[data-field="profile-height"]');
  height.classList.toggle('hidden', state.profileShape === 'flat');
  const hint = $('[data-hint="profile"]');
  hint.textContent =
    state.profileShape === 'flat'
      ? 'Плоский срез: две ровные поверхности, проще всего печатать.'
      : state.profileShape === 'dome'
        ? 'Выпуклость на части A: срез выгибается наружу, стык встаёт сам и держит от сдвига.'
        : 'Вогнутость на части A: срез с ложем, край детали защищён от сколов.';
}

// Замки
bindSwitch('step-enabled', 'stepEnabled', (on) => toggleGroup('step', on));
bindRange('step-width', 'stepWidth', (v) => `${fmt(v, 1)} мм`);
bindRange('step-height', 'stepHeight', (v) => `${fmt(v, 2)} мм`);

bindSwitch('pins-enabled', 'pinsEnabled', (on) => {
  toggleGroup('pins', on);
  state.manualPins = [];
});
bindRange('pin-diameter', 'pinDiameter', (v) => `${fmt(v, 1)} мм`);
bindRange('pin-depth', 'pinDepth', (v) => `${fmt(v, 1)} мм`);
bindRange('pin-count', 'pinCount', (v) => `${Math.round(v)}`);
bindRange('pin-clearance', 'pinClearance', (v) => `${fmt(v, 2)} мм`);

bindSwitch('tongue-enabled', 'tongueEnabled', (on) => toggleGroup('tongue', on));
bindRange('tongue-width', 'tongueWidth', (v) => `${fmt(v, 1)} мм`);
bindRange('tongue-depth', 'tongueDepth', (v) => `${fmt(v, 1)} мм`);

// Второй рез
bindSwitch('extra-enabled', 'extraEnabled', (on) => {
  toggleGroup('extra', on);
  if (on) syncRangeLimits();
  updateExtraInfo();
  updatePlaneVisual();
  schedulePreview(0);
});
bindRange('extra-pos', 'extraPos', (v) => {
  updateExtraInfo();
  updatePlaneVisual();
  return `${fmt(v, 1)} мм`;
});
bindRange('extra-angle', 'extraAngle', (v) => {
  updateExtraInfo();
  updatePlaneVisual();
  return `${fmt(v, 0)}°`;
});
bindSwitch('extra-parallel', 'extraParallel', () => {
  const angleInput = $('#extra-angle') as HTMLInputElement;
  angleInput.disabled = state.extraParallel;
  updateExtraInfo();
  updatePlaneVisual();
  schedulePreview(0);
});
bindSwitch('extra-visible', 'extraVisible', () => updatePlaneVisual());

for (const button of $$('[data-extra-axis]')) {
  button.addEventListener('click', () => {
    const axis = button.dataset.extraAxis as Axis;
    state.extraAxis = axis;
    for (const b of $$('[data-extra-axis]')) {
      b.setAttribute('aria-pressed', String(b.dataset.extraAxis === axis));
    }
    state.extraPos = 0;
    ($('#extra-pos') as HTMLInputElement).value = '0';
    syncRangeLimits();
    updateExtraInfo();
    updatePlaneVisual();
    schedulePreview(0);
  });
}

/** Подсказка под вторым резом: где он пройдёт и не совпадёт ли с первым. */
function updateExtraInfo() {
  const host = $('#extra-info');
  if (!host) return;
  if (!state.extraEnabled || !state.model) {
    host.innerHTML = '';
    return;
  }
  const notes: string[] = [];
  const first = primaryCut(state);
  const second = secondaryCut(state);
  const dot =
    first.plane.normal[0] * second.plane.normal[0] +
    first.plane.normal[1] * second.plane.normal[1] +
    first.plane.normal[2] * second.plane.normal[2];
  const parallel = Math.abs(Math.abs(dot) - 1) < 0.01;
  if (parallel) {
    notes.push(
      note(
        'warn',
        'Параллельно',
        'Второй рез параллелен первому: он отрежет только край и не поделит деталь на четыре части. Выберите другую ось.',
      ),
    );
  }
  const d =
    (second.plane.point[0] - first.plane.point[0]) * first.plane.normal[0] +
    (second.plane.point[1] - first.plane.point[1]) * first.plane.normal[1] +
    (second.plane.point[2] - first.plane.point[2]) * first.plane.normal[2];
  if (Math.abs(d) < 0.01) {
    notes.push(note('warn', 'Совпадение', 'Плоскости совпадают — второй рез пройдёт по линии первого. Сдвиньте его ползунком.'));
  }
  const axisName = state.extraAxis === 'x' ? 'X' : state.extraAxis === 'y' ? 'Y' : 'Z';
  notes.push(
    note(
      'ok',
      'Второй рез',
      `Ось ${axisName}, смещение ${fmt(state.extraPos, 1)} мм, наклон ${fmt(state.extraParallel ? state.planeAngle : state.extraAngle, 0)}°.`,
    ),
  );
  host.innerHTML = notes.join('');
}

function toggleGroup(name: string, on: boolean) {
  const group = document.querySelector<HTMLElement>(`[data-group="${name}"]`);
  group?.classList.toggle('hidden', !on);
}

// Части
bindRange('explode', 'explode', (v) => `${fmt(v, 0)} мм`);
$('#explode').addEventListener('input', () => {
  const cut = primaryCut(state);
  viewer.setExplode(state.explode, cut.plane.normal);
});
bindSwitch('table-layout', 'tableLayout', (on) => viewer.setTableLayout(on));

function syncRangeLimits() {
  const pos = $('#plane-pos') as HTMLInputElement;
  const range = planeRange(state);
  pos.min = String(Math.floor(range.min * 10) / 10);
  pos.max = String(Math.ceil(range.max * 10) / 10);
  if (Number(pos.value) < Number(pos.min) || Number(pos.value) > Number(pos.max)) {
    pos.value = '0';
    state.planePos = 0;
  }
  setValue('plane-pos', `${fmt(state.planePos, 1)} мм`);

  const extra = $('#extra-pos') as HTMLInputElement;
  const extraRange = planeRange(state, state.extraAxis);
  extra.min = String(Math.floor(extraRange.min * 10) / 10);
  extra.max = String(Math.ceil(extraRange.max * 10) / 10);
  if (Number(extra.value) < Number(extra.min) || Number(extra.value) > Number(extra.max)) {
    extra.value = '0';
    state.extraPos = 0;
  }
  setValue('extra-pos', `${fmt(state.extraPos, 1)} мм`);
  setValue('extra-angle', `${fmt(state.extraParallel ? state.planeAngle : state.extraAngle, 0)}°`);
}

function setControlsEnabled(on: boolean) {
  // Поля реза без модели бессмысленны, но кнопка «Открыть STL» и выбор файла
  // обязаны работать всегда: disabled на input[type=file] блокирует выбор файла.
  for (const el of $$('.panel--left input, .panel--left .segmented__option')) {
    const input = el as HTMLInputElement;
    if (input.type === 'file') continue;
    input.disabled = !on;
  }
  ($('#save-parts') as HTMLButtonElement).disabled = !on;
}

/* ------------------------------------------------------------- плоскость */

function updatePlaneVisual() {
  const cut = primaryCut(state);
  const size = sizeOf(state);
  const diag = Math.hypot(size[0], size[1], size[2]);
  if (state.cutAreaEnabled) {
    // Плоскость превращается в окно реза: видно и размер, и сдвиг.
    const basis = basisFromNormal(cut.plane.normal);
    updateAreaAxesHint(basis);
    const point: Vec3 = [
      cut.plane.point[0] + basis.u[0] * state.cutOffsetU + basis.v[0] * state.cutOffsetV,
      cut.plane.point[1] + basis.u[1] * state.cutOffsetU + basis.v[1] * state.cutOffsetV,
      cut.plane.point[2] + basis.u[2] * state.cutOffsetU + basis.v[2] * state.cutOffsetV,
    ];
    viewer.setPlaneRect(point, cut.plane.normal, state.cutWidth, state.cutHeight, state.planeVisible && !busy);
  } else {
    viewer.setPlaneSize(Math.max(diag * 1.25, 10));
    viewer.setPlane(cut.plane.point, cut.plane.normal, state.planeVisible && !busy);
  }

  // Вторая плоскость: видна только когда включён второй рез.
  if (state.extraEnabled) {
    const second = secondaryCut(state);
    viewer.setPlane2(second.plane.point, second.plane.normal, state.extraVisible && !busy);
  } else {
    viewer.setPlane2([0, 0, 0], [0, 0, 1], false);
  }
  viewer.setOverlayVisible(state.planeVisible || (state.extraEnabled && state.extraVisible));
}

/* -------------------------------------------------------------- предпросмотр */

let previewTimer = 0;
let previewToken = 0;

function schedulePreview(delay = 90) {
  if (!state.model) return;
  updatePlaneVisual();
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void runPreview(), delay);
}

async function runPreview() {
  if (!state.model) return;
  const token = ++previewToken;
  try {
    const response = await ask<PreviewResponse>({ type: 'preview', cut: primaryCut(state) });
    if (token !== previewToken) return;
    viewer.setPreview(response.preview, state.pinDiameter / 2);
    setAreaCoverageWarning(Boolean(response.preview?.area?.coversSection));
    if (response.preview && !response.preview.ok) {
      setStatus('warn', 'Плоскость вне модели', 'Сдвиньте плоскость ближе к центру детали.');
    }
  } catch {
    /* предпросмотр не критичен */
  }
}

/* ------------------------------------------------------------------- расчёт */

async function runCut() {
  if (!state.model || busy) return;
  const cuts = allCuts(state);
  busy = true;
  setStatus('busy', 'Режу', 'Считаю геометрию…');
  setTime(null);
  ($('#save-parts') as HTMLButtonElement).disabled = true;
  try {
    const started = performance.now();
    const response = await ask<ResultResponse>({ type: 'compute', cuts });
    const elapsed = performance.now() - started;

    if (!response.ok) {
      setStatus('bad', 'Не получилось', response.error ?? '');
      showModal('Рез не выполнен', response.error ?? 'Неизвестная ошибка.');
      return;
    }

    lastParts = response.parts;
    lastStats = response.stats;
    viewer.clearParts();
    viewer.setSourceGeometryHidden(true);
    for (const part of response.parts) viewer.addPart(part);
    viewer.frameAll();

    const explodeInput = $('#explode') as HTMLInputElement;
    explodeInput.value = '0';
    state.explode = 0;
    setValue('explode', '0 мм');
    if (state.tableLayout) viewer.setTableLayout(true);

    renderParts(response.parts);
    renderChecks(response.stats);
    renderWarnings(response.stats.flatMap((s) => s.warnings));
    updateJointBadge(response.stats);

    ($('#save-parts') as HTMLButtonElement).disabled = false;
    ($('#save-parts-loose') as HTMLButtonElement).disabled = false;
    ($('#save-project') as HTMLButtonElement).disabled = false;

    const totalTris = response.parts.reduce((s, p) => s + p.triangles, 0);
    $('#status-tris').textContent = `${fmtInt(totalTris)} тр.`;
    $('#status-parts').textContent = `${response.parts.length} частей`;
    setTime(elapsed);

    const failed = response.stats.filter((s) => !s.ok);
    if (failed.length > 0) {
      setStatus('warn', 'Рез с оговорками', failed.map((s) => s.error).filter(Boolean).join('; '));
    } else {
      setStatus('ok', 'Готово', `Разрезано на ${response.parts.length} частей`);
    }
  } catch (err) {
    setStatus('bad', 'Ошибка расчёта', String((err as Error)?.message ?? err));
  } finally {
    busy = false;
    updatePlaneVisual();
  }
}

/* --------------------------------------------------------------- отрисовка */

function renderParts(parts: PartGeometry[]) {
  const host = $('#parts-list');
  const badge = document.querySelector<HTMLElement>('[data-badge-parts]');
  if (parts.length === 0) {
    host.innerHTML = '<div class="empty">Разрежьте модель,<br />и части появятся здесь.</div>';
    if (badge) badge.textContent = '—';
    return;
  }
  if (badge) badge.textContent = `${parts.length}`;
  host.innerHTML = parts
    .map(
      (p) => `
      <div class="part-row" data-part="${p.id}" data-selected="false" role="button" tabindex="0">
        <span class="part-row__swatch" style="background:${p.side === 'A' ? '#9bb8d9' : '#d9b98f'}"></span>
        <span class="part-row__name">${escapeHtml(p.label)}</span>
        <span class="part-row__meta">${fmt(p.volume / 1000, 1)} см³</span>
      </div>`,
    )
    .join('');

  for (const row of $$('#parts-list .part-row')) {
    const id = row.dataset.part!;
    const choose = () => {
      for (const r of $$('#parts-list .part-row')) r.dataset.selected = String(r.dataset.part === id);
      viewer.selectPart(id);
      const part = lastParts.find((p) => p.id === id);
      if (part) {
        setStatus('ok', 'Часть выбрана', `${part.label}: ${fmt(part.volume / 1000, 1)} см³, ${fmtInt(part.triangles)} треугольников`);
      }
    };
    row.addEventListener('click', choose);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose();
      }
    });
  }
}

function renderChecks(stats: CutStats[] | null) {
  const host = $('#checks');
  if (!stats || stats.length === 0) {
    host.innerHTML = '<div class="empty">Появятся после первого реза.</div>';
    setBadge('checks', null);
    return;
  }
  const rows: string[] = [];
  let allOk = true;
  let anyWarn = false;

  for (const s of stats) {
    if (!s.ok) {
      allOk = false;
      rows.push(checkRow('bad', '✕', s.name, s.error ?? 'не выполнен'));
      continue;
    }
    // Главная проверка: части не должны пересекаться, иначе их не собрать.
    const interOk = s.intersectionVolume < Math.max(0.05, s.volumeBefore * 1e-5);
    if (!interOk) anyWarn = true;
    rows.push(
      checkRow(interOk ? 'ok' : 'warn', interOk ? '✓' : '!', 'Части не пересекаются', `${fmt(s.intersectionVolume, 3)} мм³`),
    );

    // Объём меняется на величину замков — это нормально, но он не должен
    // выходить за пределы добавленного и вычтенного.
    const actual = s.volumeAfter - s.volumeBefore;
    const inBounds = actual <= s.jointVolumeAdded + 1 && actual >= -s.jointVolumeRemoved - 1;
    if (!inBounds) anyWarn = true;
    rows.push(
      checkRow(
        inBounds ? 'ok' : 'warn',
        inBounds ? '✓' : '!',
        'Материал в пределах замков',
        `${actual >= 0 ? '+' : ''}${fmt(actual, 0)} мм³`,
      ),
    );

    rows.push(checkRow('ok', '·', 'Площадь среза', `${fmt(s.sectionArea / 100, 1)} см²`));
    if (s.stepApplied) rows.push(checkRow('ok', '·', 'Ступенька', `${fmt(s.stepWidth, 1)} мм`));
    if (s.pinCount > 0) rows.push(checkRow('ok', '·', 'Штифты', `${s.pinCount} шт`));
    if (s.tongueApplied) rows.push(checkRow('ok', '·', 'Шип-паз', 'есть'));
  }

  host.innerHTML = rows.join('');
  setBadge('checks', allOk ? (anyWarn ? 'есть замечания' : 'всё в порядке') : 'ошибка');
}

function checkRow(tone: 'ok' | 'warn' | 'bad', mark: string, label: string, value: string): string {
  return `<div class="check check--${tone}"><span class="check__mark">${mark}</span><span class="check__label">${escapeHtml(label)}</span><span class="check__value">${escapeHtml(value)}</span></div>`;
}

function renderWarnings(warnings: string[]) {
  const host = $('#warnings');
  host.innerHTML = warnings.length === 0 ? '' : warnings.map((w) => note('warn', '!', w)).join('');
}

function updateJointBadge(stats: CutStats[]) {
  const kinds: string[] = [];
  if (stats.some((s) => s.stepApplied)) kinds.push('ступенька');
  if (stats.some((s) => s.pinCount > 0)) kinds.push('штифты');
  if (stats.some((s) => s.tongueApplied)) kinds.push('шип');
  setBadge('joints', kinds.length > 0 ? kinds.join(' + ') : 'нет');
  setBadge('file', state.model ? `${fmtInt(state.model.triangles)} тр.` : null);
}

/* ---------------------------------------------------------------- действия */

for (const tool of $$('[data-tool]')) {
  tool.addEventListener('click', () => {
    const name = tool.dataset.tool;
    if (name === 'frame') {
      viewer.frameAll();
      return;
    }
    if (name === 'translate' || name === 'rotate') {
      viewer.setTransformMode(name);
      for (const t of $$('[data-tool]')) {
        if (t.dataset.tool === 'translate' || t.dataset.tool === 'rotate') {
          t.setAttribute('aria-pressed', String(t.dataset.tool === name));
        }
      }
    }
  });
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void runCut();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === 'g') viewer.setTransformMode('translate');
  else if (key === 'r') viewer.setTransformMode('rotate');
  else if (key === 'f') viewer.frameAll();
  else if (key === 'escape') {
    viewer.selectPart(null);
    for (const r of $$('#parts-list .part-row')) r.dataset.selected = 'false';
  }
});

$('#save-parts').addEventListener('click', async () => {
  if (lastParts.length === 0) return;
  const name = state.model?.name ?? 'модель';
  setStatus('busy', 'Сохраняю', 'Выберите папку…');
  try {
    const written = await savePartsToFolder(lastParts, name);
    if (written === null) {
      for (const part of lastParts) downloadPart(part, name);
      setStatus('warn', 'Скачивание по файлам', 'Браузер не дал выбрать папку — файлы скачиваются по очереди.');
      return;
    }
    if (written === 0) {
      setStatus('idle', 'Сохранение отменено', '');
      return;
    }
    setStatus('ok', 'Сохранено', `${written} STL в выбранной папке`);
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    setStatus('bad', 'Не удалось сохранить', message);
    showModal('Сохранение не удалось', message);
  }
});

$('#save-parts-loose').addEventListener('click', () => {
  if (lastParts.length === 0) return;
  const name = state.model?.name ?? 'модель';
  for (const part of lastParts) downloadPart(part, name);
  setStatus('ok', 'Скачивание', `Файлов: ${lastParts.length}`);
});

$('#save-project').addEventListener('click', () => {
  const project = serializeProject(state);
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${safeName(state.model?.name ?? 'проект')}.razrez.json`);
  setStatus('ok', 'Проект сохранён', 'Настройки реза можно открыть позже');
});

const projectInput = $('#project-input') as HTMLInputElement;
$('#load-project').addEventListener('click', () => projectInput.click());
projectInput.addEventListener('change', async () => {
  const file = projectInput.files?.[0];
  projectInput.value = '';
  if (!file) return;
  try {
    const project = parseProject(await file.text());
    Object.assign(state, project.state);
    syncInputsFromState();
    setStatus('ok', 'Проект открыт', `Настройки из «${project.modelName}». Откройте тот же STL.`);
  } catch (err) {
    showModal('Проект не открылся', String((err as Error)?.message ?? err));
  }
});

function syncInputsFromState() {
  for (const [id, key] of [
    ['plane-pos', 'planePos'],
    ['plane-angle', 'planeAngle'],
    ['cut-width', 'cutWidth'],
    ['cut-height', 'cutHeight'],
    ['cut-offset-u', 'cutOffsetU'],
    ['cut-offset-v', 'cutOffsetV'],
    ['profile-height', 'profileHeight'],
    ['step-width', 'stepWidth'],
    ['step-height', 'stepHeight'],
    ['pin-diameter', 'pinDiameter'],
    ['pin-depth', 'pinDepth'],
    ['pin-count', 'pinCount'],
    ['pin-clearance', 'pinClearance'],
    ['tongue-width', 'tongueWidth'],
    ['tongue-depth', 'tongueDepth'],
    ['extra-pos', 'extraPos'],
    ['extra-angle', 'extraAngle'],
    ['explode', 'explode'],
  ] as const) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = String(state[key]);
  }
  for (const [id, key] of [
    ['plane-visible', 'planeVisible'],
    ['cut-area-enabled', 'cutAreaEnabled'],
    ['step-enabled', 'stepEnabled'],
    ['pins-enabled', 'pinsEnabled'],
    ['tongue-enabled', 'tongueEnabled'],
    ['extra-enabled', 'extraEnabled'],
    ['extra-parallel', 'extraParallel'],
    ['extra-visible', 'extraVisible'],
    ['table-layout', 'tableLayout'],
  ] as const) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.checked = Boolean(state[key]);
  }
  for (const b of $$('[data-axis]')) b.setAttribute('aria-pressed', String(b.dataset.axis === state.axis));
  for (const b of $$('[data-extra-axis]')) {
    b.setAttribute('aria-pressed', String(b.dataset.extraAxis === state.extraAxis));
  }
  for (const b of $$('[data-profile]')) b.setAttribute('aria-pressed', String(b.dataset.profile === state.profileShape));
  for (const b of $$('[data-falloff]')) b.setAttribute('aria-pressed', String(b.dataset.falloff === state.falloff));
  toggleGroup('step', state.stepEnabled);
  toggleGroup('pins', state.pinsEnabled);
  toggleGroup('tongue', state.tongueEnabled);
  toggleGroup('extra', state.extraEnabled);
  toggleGroup('cut-area', state.cutAreaEnabled);
  const extraAngle = $('#extra-angle') as HTMLInputElement | null;
  if (extraAngle) extraAngle.disabled = state.extraParallel;
  updateProfileUi();
  syncRangeLimits();
  updateExtraInfo();
  updatePlaneVisual();
}

/* ------------------------------------------------------- кнопка «Разрезать» */

function installCutButton() {
  const chips = $('#viewport-chips');
  const button = document.createElement('button');
  button.className = 'chip';
  button.type = 'button';
  button.id = 'cut-run';
  button.textContent = 'Разрезать  Ctrl+↵';
  button.style.cursor = 'pointer';
  button.style.color = '#fff';
  button.style.background = 'rgba(216, 68, 28, 0.92)';
  button.style.borderColor = 'rgba(216, 68, 28, 0.92)';
  button.style.fontFamily = 'var(--font)';
  button.style.fontSize = '12px';
  button.style.padding = '6px 13px';
  button.addEventListener('click', () => void runCut());
  chips.appendChild(button);
}

installCutButton();
setControlsEnabled(false);
updateProfileUi();
toggleGroup('step', state.stepEnabled);
setStatus('idle', 'Готов', 'Откройте STL, чтобы начать');
$('#status-tris').textContent = '—';
$('#status-parts').textContent = '—';

// Клик по сцене: выбрать часть; Shift + клик по срезу — добавить штифт.
viewer.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.shiftKey && state.pinsEnabled && state.model) {
    const cut = primaryCut(state);
    const world = viewer.pickPoint(e, cut.plane.point, cut.plane.normal);
    if (!world) return;
    const local = toSectionCoords(world, cut.plane.point, cut.plane.normal);
    state.manualPins.push(local);
    setStatus('ok', 'Штифт добавлен', `${fmt(local[0], 1)} / ${fmt(local[1], 1)} мм на срезе`);
    void runPreview();
    e.preventDefault();
    return;
  }
  const id = viewer.pickPart(e);
  if (id) {
    viewer.selectPart(id);
    for (const r of $$('#parts-list .part-row')) r.dataset.selected = String(r.dataset.part === id);
  }
});

function toSectionCoords(
  world: [number, number, number],
  origin: [number, number, number],
  normal: [number, number, number],
): Vec2 {
  const n = normal;
  const helper: [number, number, number] = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const u = norm(cross(helper, n));
  const v = cross(n, u);
  const d: [number, number, number] = [world[0] - origin[0], world[1] - origin[1], world[2] - origin[2]];
  return [d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * v[0] + d[1] * v[1] + d[2] * v[2]];
}

// Экспорт состояния для автотестов (не влияет на работу интерфейса).
declare global {
  interface Window {
    __RAZREZ__?: {
      openFile: (file: File) => Promise<void>;
      runCut: () => Promise<void>;
      state: AppState;
      parts: () => PartGeometry[];
      stats: () => CutStats[];
      center: () => [number, number, number];
    };
  }
}

window.__RAZREZ__ = {
  openFile,
  runCut,
  state,
  parts: () => lastParts,
  stats: () => lastStats,
  center: () => centerOf(state),
};
