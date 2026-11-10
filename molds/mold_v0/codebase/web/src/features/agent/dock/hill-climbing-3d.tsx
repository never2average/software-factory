'use client';
// A target's objective space, as a 3D plot (mold_v0-292): the program's metric up, its floors across, the green box the region
// its floors allow. A point is one measured version; the line is the climb between them. Axes are scaled 0..1 for drawing; the
// labels carry the metric's name. Loaded only where a climb is shown (three.js is large).
import { OrbitControls, Line, PerspectiveCamera } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const MICRO = 'text-[11px]';
const META = 'text-xs';

export interface ClimbPoint {
  /** What produced this state — a deployment, an evaluation. */
  id: string;
  label: string;
  /** Normalized 0..1 per axis, in axis order. Missing axes are unplotted. */
  coords: [number | null, number | null, number | null];
  /** The real values, for the readout. */
  values: (number | null)[];
  at: string;
  color: string;
}

export interface ClimbAxis {
  metric: string;
  higherIsBetter: boolean;
  role: "objective" | "constraint";
  /** Normalized bound of the allowed region on this axis, when constrained. */
  bound: number | null;
}

const AXIS_COLORS = ["#ec4899", "#06b6d4", "#f59e0b"] as const;
const GRID = "#7f7f7f33";

function Axes({ axes }: { readonly axes: ClimbAxis[] }) {
  const gridLines = useMemo(() => {
    const lines: React.ReactElement[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const p = i / 5;
      const segs: [number, number, number][][] = [
        [[p, 0, 0], [p, 1, 0]],
        [[0, p, 0], [1, p, 0]],
        [[p, 0, 0], [p, 0, 1]],
        [[0, 0, p], [1, 0, p]],
        [[0, p, 0], [0, p, 1]],
        [[0, 0, p], [0, 1, p]],
      ];
      segs.forEach((points, k) => {
        lines.push(<Line color={GRID} key={`g-${i}-${k}`} lineWidth={0.5} points={points} />);
      });
    }
    return lines;
  }, []);

  return (
    <>
      {gridLines}
      <Line color={AXIS_COLORS[1]} lineWidth={3} points={[[0, 0, 0], [1.1, 0, 0]]} />
      <Line color={AXIS_COLORS[0]} lineWidth={3} points={[[0, 0, 0], [0, 1.1, 0]]} />
      <Line color={AXIS_COLORS[2]} lineWidth={3} points={[[0, 0, 0], [0, 0, 1.1]]} />
    </>
  );
}

/** The region the constraints allow: bounded on every constrained axis. */
function AllowedRegion({ axes }: { readonly axes: ClimbAxis[] }) {
  const box = useMemo(() => {
    const span = (a: ClimbAxis | undefined): [number, number] => {
      if (!a) return [0, 1];
      if (a.role === "objective") return a.higherIsBetter ? [0.6, 1] : [0, 0.4];
      const bound = a.bound ?? 0.4;
      return a.higherIsBetter ? [bound, 1] : [0, bound];
    };
    const [y0, y1] = span(axes[0]);
    const [x0, x1] = span(axes[1]);
    const [z0, z1] = span(axes[2]);
    return { x0, x1, y0, y1, z0, z1 };
  }, [axes]);

  const edges = useMemo(() => {
    const { x0, x1, y0, y1, z0, z1 } = box;
    const c: [number, number, number][] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const pairs = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    return pairs.map(([a, b]) => [c[a], c[b]] as [number, number, number][]);
  }, [box]);

  return (
    <>
      {edges.map((points, i) => (
        <Line color="#10b981" dashSize={0.02} dashed gapSize={0.01} key={`edge-${i}`} lineWidth={2} points={points} />
      ))}
      <mesh position={[(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2]}>
        <boxGeometry args={[box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0]} />
        <meshStandardMaterial color="#10b981" opacity={0.08} side={THREE.DoubleSide} transparent />
      </mesh>
    </>
  );
}

function Point({
  point,
  position,
  selected,
  onHover,
  onToggle,
}: {
  readonly point: ClimbPoint;
  readonly position: [number, number, number];
  readonly selected: boolean;
  readonly onHover: (p: ClimbPoint | null) => void;
  readonly onToggle: (id: string) => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  return (
    <group position={position}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onToggle(point.id);
        }}
        onPointerEnter={() => {
          setHovered(true);
          onHover(point);
        }}
        onPointerLeave={() => {
          setHovered(false);
          onHover(null);
        }}
        ref={mesh}
        scale={selected ? 2 : hovered ? 1.8 : 1}
      >
        <sphereGeometry args={[0.018, 16, 16]} />
        <meshStandardMaterial
          color={selected ? "#ffffff" : point.color}
          emissive={selected ? "#ffffff" : point.color}
          emissiveIntensity={selected ? 1 : hovered ? 0.9 : 0.4}
        />
      </mesh>
      {selected ? (
        <mesh>
          <sphereGeometry args={[0.032, 16, 16]} />
          <meshBasicMaterial color={point.color} opacity={0.25} transparent />
        </mesh>
      ) : null}
    </group>
  );
}

/** Where each axis's name sits, in the scene: past the end of its line. */
const LABEL_AT: [number, number, number][] = [[-0.16, 1.28, 0], [1.32, -0.12, 0], [0, -0.12, 1.32]];

/** Moves the axis names (plain page text over the canvas) to where their axes end, every frame; hidden behind the camera. */
function AxisLabels({ labels }: { readonly labels: React.RefObject<(HTMLSpanElement | null)[]> }) {
  const { camera, size } = useThree();
  const vec = useRef(new THREE.Vector3());
  useFrame(() => {
    LABEL_AT.forEach((at, i) => {
      const el = labels.current[i];
      if (!el) return;
      const v = vec.current.set(...at).project(camera);
      el.style.visibility = v.z > 1 ? "hidden" : "visible";
      el.style.transform = `translate(${(v.x * 0.5 + 0.5) * size.width}px, ${(-v.y * 0.5 + 0.5) * size.height}px) translate(-50%, -50%)`;
    });
  });
  return null;
}

/** Reports where each point currently sits on screen, so a marquee drawn
 *  over the canvas can hit-test against it. */
function Projector({
  placed,
  onProject,
}: {
  readonly placed: { id: string; xyz: [number, number, number] }[];
  readonly onProject: (screen: { id: string; x: number; y: number }[]) => void;
}) {
  const { camera, size } = useThree();
  const vec = useRef(new THREE.Vector3());
  useFrame(() => {
    onProject(
      placed.map(({ id, xyz }) => {
        const v = vec.current.set(xyz[1], xyz[0], xyz[2]).project(camera);
        return { id, x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height };
      }),
    );
  });
  return null;
}

function Climb({
  points,
  selected,
  onHover,
  onToggle,
}: {
  readonly points: ClimbPoint[];
  readonly selected: Set<string>;
  readonly onHover: (p: ClimbPoint | null) => void;
  readonly onToggle: (id: string) => void;
}) {
  const placed = points
    .map((p) => ({ p, xyz: p.coords.map((c) => c ?? 0) as [number, number, number] }))
    .filter(({ p }) => p.coords.some((c) => c !== null));
  return (
    <>
      {placed.map(({ p, xyz }) => (
        <Point
          key={p.id}
          onHover={onHover}
          onToggle={onToggle}
          point={p}
          position={[xyz[1], xyz[0], xyz[2]]}
          selected={selected.has(p.id)}
        />
      ))}
      {placed.slice(0, -1).map(({ xyz }, i) => {
        const next = placed[i + 1].xyz;
        return (
          <Line
            color="#8a8a8a"
            key={`climb-${i}`}
            lineWidth={1.5}
            points={[
              [xyz[1], xyz[0], xyz[2]],
              [next[1], next[0], next[2]],
            ]}
          />
        );
      })}
    </>
  );
}

export function HillClimbing3D({
  axes,
  points,
  height,
  className,
  onAsk,
}: {
  readonly axes: ClimbAxis[];
  readonly points: ClimbPoint[];
  readonly height?: number;
  readonly className?: string;
  /** Ask about a chunk of the space: the points a person selected. */
  readonly onAsk?: (selected: ClimbPoint[]) => void;
}) {
  const [hovered, setHovered] = useState<ClimbPoint | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const screen = useRef<{ id: string; x: number; y: number }[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  // While Shift is held an overlay takes the pointer, so the drag draws a
  // marquee instead of orbiting the camera.
  const [shift, setShift] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShift(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShift(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const placed = points.filter((p) => p.coords.some((c) => c !== null));
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const onProject = useCallback((s: { id: string; x: number; y: number }[]) => {
    screen.current = s;
  }, []);

  // Shift-drag draws a marquee and takes everything inside it; a plain drag
  // still orbits the camera.
  const start = (e: React.PointerEvent) => {
    if (placed.length === 0) return;
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setMarquee({ x0: x, y0: y, x1: x, y1: y });
  };
  const move = (e: React.PointerEvent) => {
    if (!marquee) return;
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setMarquee({ ...marquee, x1: e.clientX - r.left, y1: e.clientY - r.top });
  };
  const end = () => {
    if (!marquee) return;
    const x0 = Math.min(marquee.x0, marquee.x1);
    const x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1);
    const y1 = Math.max(marquee.y0, marquee.y1);
    if (x1 - x0 > 4 && y1 - y0 > 4) {
      const hit = screen.current.filter((s) => s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1).map((s) => s.id);
      setSelected(new Set(hit));
    }
    setMarquee(null);
  };

  const chosen = points.filter((p) => selected.has(p.id));

  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-lg border border-border bg-background/60", className)}
      ref={box}
      style={height ? { height } : undefined}
    >
      <Canvas dpr={[1, 2]} gl={{ antialias: true }}>
        <PerspectiveCamera makeDefault position={[2, 2, 2]} />
        <OrbitControls
          enableDamping={false}
          enablePan
          enableRotate={marquee === null}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
        />
        <ambientLight intensity={0.6} />
        <pointLight intensity={0.8} position={[3, 3, 3]} />
        <Axes axes={axes} />
        <AxisLabels labels={labels} />
        <AllowedRegion axes={axes} />
        <Climb onHover={setHovered} onToggle={toggle} points={points} selected={selected} />
        <Projector
          onProject={onProject}
          placed={placed.map((p) => ({ id: p.id, xyz: p.coords.map((c) => c ?? 0) as [number, number, number] }))}
        />
      </Canvas>

      {axes.slice(0, 3).map((a, i) => (
        <span key={a.metric} ref={(el) => { labels.current[i] = el; }} className={cn("pointer-events-none absolute top-0 left-0 whitespace-nowrap font-medium", MICRO)} style={{ color: AXIS_COLORS[i], visibility: "hidden" }} data-climb-axis={a.metric}>{a.metric}</span>
      ))}

      <div
        className={cn("absolute inset-0", shift || marquee ? "cursor-crosshair" : "pointer-events-none")}
        onPointerDown={start}
        onPointerLeave={end}
        onPointerMove={move}
        onPointerUp={end}
      />

      {marquee ? (
        <div
          className="pointer-events-none absolute border border-primary/70 bg-primary/10"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      ) : null}

      {placed.length === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <span className={cn("rounded-md bg-background/80 px-2 py-1 text-muted-foreground", MICRO)}>
            The allowed region only: nothing measured on these axes yet
          </span>
        </div>
      ) : (
        <div className={cn("pointer-events-none absolute right-2 bottom-2 rounded-md bg-background/80 px-2 py-1 text-muted-foreground", MICRO)}>
          Drag to orbit. Shift-drag to select. Click a point.
        </div>
      )}

      {hovered ? (
        <div className={cn("pointer-events-none absolute top-2 left-2 rounded-md border border-border bg-popover/95 px-2 py-1.5", MICRO)}>
          <p className="font-medium text-foreground">{hovered.label}</p>
          {axes.map((a, i) => (
            <p className="text-muted-foreground tabular-nums" key={a.metric}>
              {a.metric}: {hovered.values[i] === null ? "None" : hovered.values[i]}
            </p>
          ))}
        </div>
      ) : null}

      {chosen.length > 0 ? (
        <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-md border border-border bg-popover/95 px-2 py-1.5">
          <span className={cn("min-w-0 flex-1 truncate text-foreground/85", META)}>
            {chosen.length} point{chosen.length === 1 ? "" : "s"} selected: {chosen.map((p) => p.label).join(", ")}
          </span>
          {onAsk ? (
            <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={() => onAsk(chosen)}>Ask about these</Button>
          ) : null}
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      ) : null}
    </div>
  );
}
