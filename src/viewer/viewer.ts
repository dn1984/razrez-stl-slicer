// Сцена three.js: камера, свет, части модели, плоскость реза, маркеры замков.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { CutPreview, PartGeometry, Vec3 } from '../geometry/types.ts';

export interface PartView {
  id: string;
  mesh: THREE.Mesh;
  edge: THREE.LineSegments;
  geometry: PartGeometry;
  /** Смещение, на которое часть отодвинута ползунком «разнести». */
  explodeOffset: THREE.Vector3;
  /** Собственное перемещение части мышью. */
  userOffset: THREE.Vector3;
  userRotation: THREE.Euler;
}

const COLORS = {
  A: 0x9bb8d9,
  B: 0xd9b98f,
  section: 0xe8542a,
  pin: 0x2e8b84,
  plane: 0xffffff,
  /** Вторая плоскость реза: бирюзовая, чтобы отличать от первой. */
  plane2: 0x3fb8ae,
};

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly transform: TransformControls;

  private readonly root = new THREE.Group();
  private readonly partsGroup = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly planeMesh: THREE.Mesh;
  private readonly planeEdge: THREE.Line;
  private readonly planeMesh2: THREE.Mesh;
  private readonly planeEdge2: THREE.Line;
  private readonly sectionLines: THREE.LineSegments;
  private readonly pinMarkers: THREE.InstancedMesh;
  private readonly profileArc: THREE.Line;

  private partViews = new Map<string, PartView>();
  private sourceMesh: THREE.Mesh | null = null;
  private selected: PartView | null = null;
  private sectionGeometryCount = 0;
  private animationLoop: (() => void) | null = null;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x17191c, 1);
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
    this.camera.position.set(120, 90, 140);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Свет: мягкий общий + два направленных, чтобы читалась форма.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1, 1.6, 1);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfd8e6, 0.9);
    fill.position.set(-1.2, 0.4, -0.8);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(0, -1, 0.4);
    this.scene.add(rim);

    this.grid = new THREE.GridHelper(400, 40, 0x2b2f36, 0x22262c);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.75;
    this.scene.add(this.grid);

    this.scene.add(this.root);
    this.root.add(this.partsGroup);
    this.root.add(this.overlay);

    // Плоскость реза — визуальный герой: полупрозрачная, с ярким контуром.
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    this.planeMesh = new THREE.Mesh(
      planeGeo,
      new THREE.MeshBasicMaterial({
        color: COLORS.plane,
        transparent: true,
        opacity: 0.075,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.planeMesh.renderOrder = 2;
    this.overlay.add(this.planeMesh);

    this.planeEdge = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, -0.5, 0),
        new THREE.Vector3(0.5, -0.5, 0),
        new THREE.Vector3(0.5, 0.5, 0),
        new THREE.Vector3(-0.5, 0.5, 0),
        new THREE.Vector3(-0.5, -0.5, 0),
      ]),
      new THREE.LineBasicMaterial({ color: COLORS.section, transparent: true, opacity: 0.85 }),
    );
    this.planeEdge.renderOrder = 3;
    this.planeEdge.visible = false;
    this.overlay.add(this.planeEdge);

    // Вторая плоскость реза — другого цвета, чтобы её не путать с первой.
    this.planeMesh2 = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: COLORS.plane2,
        transparent: true,
        opacity: 0.06,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.planeMesh2.renderOrder = 2;
    this.planeMesh2.visible = false;
    this.overlay.add(this.planeMesh2);

    this.planeEdge2 = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, -0.5, 0),
        new THREE.Vector3(0.5, -0.5, 0),
        new THREE.Vector3(0.5, 0.5, 0),
        new THREE.Vector3(-0.5, 0.5, 0),
        new THREE.Vector3(-0.5, -0.5, 0),
      ]),
      new THREE.LineDashedMaterial({
        color: COLORS.plane2,
        dashSize: 4,
        gapSize: 3,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.planeEdge2.renderOrder = 3;
    this.planeEdge2.visible = false;
    this.planeEdge2.computeLineDistances();
    this.overlay.add(this.planeEdge2);

    this.sectionLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COLORS.section, linewidth: 2 }),
    );
    this.sectionLines.renderOrder = 4;
    this.overlay.add(this.sectionLines);

    this.pinMarkers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.pin, transparent: true, opacity: 0.95 }),
      64,
    );
    this.pinMarkers.count = 0;
    this.pinMarkers.renderOrder = 5;
    this.overlay.add(this.pinMarkers);

    this.profileArc = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: COLORS.section, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.6 }),
    );
    this.overlay.add(this.profileArc);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setMode('translate');
    this.transform.setSpace('world');
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.transform.addEventListener('objectChange', () => {
      if (this.selected) {
        this.selected.userOffset.copy(this.selected.mesh.position);
        this.selected.userRotation.copy(this.selected.mesh.rotation);
      }
    });

    const resize = () => this.resize();
    window.addEventListener('resize', resize);
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(host);
  }

  private resizeObserver: ResizeObserver;

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.animationLoop) return;
    this.animationLoop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(this.animationLoop!);
    };
    requestAnimationFrame(this.animationLoop);
  }

  /* ---------------------------------------------------------- исходная модель */

  /**
   * STL/boolean meshes имеют общие вершины на острых рёбрах. Обычный
   * computeVertexNormals() сглаживает через эти рёбра и рисует крупные тёмные
   * треугольники на гравировке и вокруг штифтов. Для отображения делаем
   * отдельные вершины на каждую грань — нормаль каждой грани остаётся плоской,
   * сама геометрия при этом не меняется.
   */
  private renderGeometry(geometry: PartGeometry): THREE.BufferGeometry {
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3));
    indexed.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
    const render = indexed.toNonIndexed();
    indexed.dispose();
    render.computeVertexNormals();
    return render;
  }

  setSource(geometry: PartGeometry) {
    this.clearParts();
    if (this.sourceMesh) {
      this.sourceMesh.geometry.dispose();
      this.scene.remove(this.sourceMesh);
      this.sourceMesh = null;
    }
    if (geometry.positions.length === 0) return;
    const geo = this.renderGeometry(geometry);
    this.sourceMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xb9c4d0, metalness: 0.05, roughness: 0.85, flatShading: false }),
    );
    this.sourceMesh.visible = this.partViews.size === 0;
    this.scene.add(this.sourceMesh);
    this.frameAll();
    this.grid.position.set(0, geometry.bboxMin[1] - 0.5, 0);
  }

  /** Исходная модель прячется, когда есть разрезанные части. */
  setSourceGeometryHidden(hidden: boolean) {
    if (this.sourceMesh) this.sourceMesh.visible = !hidden;
  }

  clearParts() {
    // Манипулятор держит ссылку на объект — отпускаем его до удаления сеток,
    // иначе он ругается, что объект не в сцене.
    this.transform.detach();
    this.selected = null;
    for (const view of this.partViews.values()) {
      this.partsGroup.remove(view.mesh);
      this.partsGroup.remove(view.edge);
      view.mesh.geometry.dispose();
      (view.mesh.material as THREE.Material).dispose();
      view.edge.geometry.dispose();
      (view.edge.material as THREE.Material).dispose();
    }
    this.partViews.clear();
  }

  addPart(geometry: PartGeometry) {
    const geo = this.renderGeometry(geometry);

    const material = new THREE.MeshStandardMaterial({
      color: geometry.side === 'A' ? COLORS.A : COLORS.B,
      metalness: 0.06,
      roughness: 0.72,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.partId = geometry.id;

    const edgeGeo = new THREE.EdgesGeometry(geo, 32);
    const edge = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({ color: 0x11131a, transparent: true, opacity: 0.35 }),
    );

    const view: PartView = {
      id: geometry.id,
      mesh,
      edge,
      geometry,
      explodeOffset: new THREE.Vector3(),
      userOffset: new THREE.Vector3(),
      userRotation: new THREE.Euler(),
    };
    this.partViews.set(geometry.id, view);
    this.partsGroup.add(mesh);
    this.partsGroup.add(edge);
    return view;
  }

  /** Растаскивание частей вдоль нормали реза — «взрыв-вид». */
  setExplode(amount: number, normal: Vec3) {
    const dir = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
    for (const view of this.partViews.values()) {
      const sign = view.geometry.side === 'A' ? 1 : -1;
      view.explodeOffset.copy(dir).multiplyScalar(sign * amount);
      this.applyTransform(view);
    }
  }

  /** Раскладка на столе: каждую часть на z=0, рядом, без наложения. */
  setTableLayout(enabled: boolean) {
    const views = [...this.partViews.values()];
    if (!enabled) {
      for (const v of views) {
        v.explodeOffset.set(0, 0, 0);
        this.applyTransform(v);
      }
      return;
    }
    const gaps = 6;
    let cursor = 0;
    for (const v of views) {
      const { bboxMin, bboxMax } = v.geometry;
      const w = bboxMax[0] - bboxMin[0];
      const centreX = (bboxMin[0] + bboxMax[0]) / 2;
      v.explodeOffset.set(cursor - centreX, 0, -bboxMin[2]);
      cursor += w + gaps;
      this.applyTransform(v);
    }
    // Центрируем всю группу на столе.
    const shift = cursor / 2;
    for (const v of views) {
      v.explodeOffset.x -= shift;
      this.applyTransform(v);
    }
  }

  private applyTransform(view: PartView) {
    view.mesh.position.copy(view.explodeOffset).add(view.userOffset);
    view.mesh.rotation.copy(view.userRotation);
    view.edge.position.copy(view.mesh.position);
    view.edge.rotation.copy(view.mesh.rotation);
  }

  /** Габарит всех видимых частей (или исходной модели). */
  private contentBox(): THREE.Box3 {
    const box = new THREE.Box3();
    if (this.partViews.size > 0) {
      for (const v of this.partViews.values()) {
        v.mesh.geometry.computeBoundingBox();
        const b = v.mesh.geometry.boundingBox!.clone().applyMatrix4(v.mesh.matrixWorld);
        box.union(b);
      }
    } else if (this.sourceMesh) {
      this.sourceMesh.geometry.computeBoundingBox();
      box.copy(this.sourceMesh.geometry.boundingBox!);
    } else {
      box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(100, 100, 100));
    }
    return box;
  }

  frameAll() {
    const box = this.contentBox();
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05;
    this.camera.position.copy(centre).add(new THREE.Vector3(0.75, 0.55, 0.85).normalize().multiplyScalar(dist));
    this.camera.near = Math.max(0.05, dist / 2000);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.grid.position.set(0, box.min.y - 0.5, 0);
    this.grid.scale.setScalar(Math.max(0.2, radius / 100));
  }

  /** Размер плоскости реза — по габариту модели. */
  setPlaneSize(size: number) {
    this.planeMesh.scale.set(size, size, 1);
    this.planeEdge.scale.set(size, size, 1);
    this.planeMesh2.scale.set(size, size, 1);
    this.planeEdge2.scale.set(size, size, 1);
    this.planeEdge.visible = true;
  }

  /** Положение плоскости: точка и нормаль. */
  setPlane(point: Vec3, normal: Vec3, visible: boolean) {
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.planeMesh.position.set(point[0], point[1], point[2]);
    this.planeMesh.quaternion.copy(q);
    this.planeMesh.visible = visible;
    this.planeEdge.position.copy(this.planeMesh.position);
    this.planeEdge.quaternion.copy(q);
    this.planeEdge.visible = visible;
  }

  /** Положение второй плоскости реза. */
  setPlane2(point: Vec3, normal: Vec3, visible: boolean) {
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.planeMesh2.position.set(point[0], point[1], point[2]);
    this.planeMesh2.quaternion.copy(q);
    this.planeMesh2.visible = visible;
    this.planeEdge2.position.copy(this.planeMesh2.position);
    this.planeEdge2.quaternion.copy(q);
    this.planeEdge2.scale.copy(this.planeMesh2.scale);
    this.planeEdge2.visible = visible;
  }

  setOverlayVisible(visible: boolean) {
    this.overlay.visible = visible;
    this.planeEdge.visible = visible;
  }

  /** Контуры сечения и маркеры штифтов. */
  setPreview(preview: CutPreview | null, pinRadius: number) {
    if (!preview || !preview.ok) {
      this.sectionLines.geometry.dispose();
      this.sectionLines.geometry = new THREE.BufferGeometry();
      this.pinMarkers.count = 0;
      this.profileArc.geometry.dispose();
      this.profileArc.geometry = new THREE.BufferGeometry();
      this.sectionGeometryCount = 0;
      return;
    }

    const points: number[] = [];
    for (const poly of preview.section) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        points.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    this.sectionLines.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.sectionLines.geometry = geo;
    this.sectionGeometryCount = preview.section.length;

    const count = Math.min(preview.pins.length, this.pinMarkers.instanceMatrix.count);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const p = preview.pins[i];
      matrix.makeTranslation(p[0], p[1], p[2]);
      matrix.scale(new THREE.Vector3(pinRadius, pinRadius, pinRadius));
      this.pinMarkers.setMatrixAt(i, matrix);
    }
    this.pinMarkers.count = count;
    this.pinMarkers.instanceMatrix.needsUpdate = true;

    // Дуга профиля: показывает искривление среза в центре.
    if (preview.profileRadius > 0 && Math.abs(preview.profilePeak) > 0.01) {
      const arcPoints: THREE.Vector3[] = [];
      const c = new THREE.Vector3(preview.profileCenter[0], preview.profileCenter[1], preview.profileCenter[2]);
      for (let i = 0; i <= 32; i++) {
        const t = (i / 32) * 2 - 1;
        arcPoints.push(new THREE.Vector3(t * preview.profileRadius, 0, preview.profilePeak * (1 - t * t)));
      }
      const g = new THREE.BufferGeometry().setFromPoints(arcPoints);
      this.profileArc.geometry.dispose();
      this.profileArc.geometry = g;
      this.profileArc.computeLineDistances();
      this.profileArc.position.copy(c);
      // Ориентируем дугу по нормали плоскости.
      const n = new THREE.Vector3(
        preview.section[0]?.[0]?.[0] ?? 0,
        preview.section[0]?.[0]?.[1] ?? 0,
        preview.section[0]?.[0]?.[2] ?? 0,
      );
      void n;
      this.profileArc.visible = true;
    } else {
      this.profileArc.visible = false;
    }
  }

  get sectionCount() {
    return this.sectionGeometryCount;
  }

  /* --------------------------------------------------------------- выделение */

  selectPart(id: string | null) {
    if (this.selected) {
      const material = this.selected.mesh.material as THREE.MeshStandardMaterial;
      material.emissive.setHex(0x000000);
    }
    this.selected = id ? this.partViews.get(id) ?? null : null;
    if (this.selected) {
      const material = this.selected.mesh.material as THREE.MeshStandardMaterial;
      material.emissive.setHex(0x1c2530);
      this.transform.attach(this.selected.mesh);
    } else {
      this.transform.detach();
    }
  }

  /** Часть под курсором (raycast). */
  pickPart(event: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = [...this.partViews.values()].map((v) => v.mesh);
    const hits = ray.intersectObjects(meshes, false);
    return hits.length > 0 ? (hits[0].object.userData.partId as string) : null;
  }

  /** Куда попал клик в координатах мира (для постановки штифта). */
  pickPoint(event: PointerEvent, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(planeNormal[0], planeNormal[1], planeNormal[2]).normalize(), 0);
    plane.constant = -plane.normal.dot(new THREE.Vector3(planePoint[0], planePoint[1], planePoint[2]));
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y, hit.z];
  }

  setTransformMode(mode: 'translate' | 'rotate') {
    this.transform.setMode(mode);
  }

  getTransformMode(): 'translate' | 'rotate' {
    return this.transform.mode as 'translate' | 'rotate';
  }

  get partOrder(): PartView[] {
    return [...this.partViews.values()];
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.transform.dispose();
    this.renderer.dispose();
  }
}
