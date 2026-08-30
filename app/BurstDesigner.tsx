"use client";

/**
 * The explosion designer.
 *
 * A view over `@ccllc/arcade/burst`, the way SpriteStudio is a view over the
 * sprite model: every number here is a field of a `BurstDefinition`, and every
 * pixel is drawn by the package's own `drawBurst`. Nothing about what an
 * explosion IS lives in this file — which is what makes the preview honest,
 * because it runs the same runtime the game runs.
 *
 * It sits here rather than in `@ccllc/studio` because no `BurstStudio` exists
 * there yet. If one lands, this is the thing it replaces: keep the seam at the
 * `ExplosionSet` in and out, and the swap stays a one-line import change.
 *
 * The two preview canvases are the module's central claim made visible — one
 * document, one frame, handed to the same emitter twice, once plain and once
 * with a pixel grid and a palette. That is why the pixel look cannot drift from
 * the vector one: there is no second design, only a second call.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EbAccordion, EbAccordionItem } from "@electricblazor/react";
import {
  BURST_LAYER_KINDS,
  advanceBurst,
  burstDuration,
  burstFrame,
  createBurstRuntime,
  drawBurst,
  normalizeBurst,
  type BurstLayer,
  type BurstLayerKind,
} from "@ccllc/arcade/burst";
import {
  EXPLOSION_ROLES, ROLE_LABELS, ROLE_NOTES, defaultExplosions,
  type ExplosionRole, type ExplosionSet,
} from "./explosions";

const PREVIEW_W = 300;
const PREVIEW_H = 240;

/**
 * The editable surface, as data. A table beats three dozen hand-written
 * sliders: it keeps the ranges in one place where they can be read against
 * each other, and adding a field is a row.
 *
 * `kinds` narrows a row to the layer kinds it means anything for — a ring has
 * no spread and a flash does not travel — so the panel shows what applies
 * instead of greying out two thirds of itself.
 */
type FieldRow = {
  key: keyof BurstLayer;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  kinds?: readonly BurstLayerKind[];
};

const MOVERS = ["spark", "smoke", "shard"] as const;

const FIELDS: readonly FieldRow[] = [
  { key: "count", label: "COUNT", min: 1, max: 80, step: 1, kinds: MOVERS },
  { key: "speed", label: "SPEED", min: 0, max: 600, step: 10, unit: "u/s", kinds: MOVERS },
  { key: "speedVary", label: "SPEED VARY", min: 0, max: 1, step: 0.05, kinds: MOVERS },
  { key: "spread", label: "SPREAD", min: 0, max: 6.2832, step: 0.1, unit: "rad", kinds: MOVERS },
  { key: "angle", label: "AIM", min: 0, max: 6.2832, step: 0.1, unit: "rad", kinds: MOVERS },
  { key: "gravity", label: "GRAVITY", min: -300, max: 600, step: 10, kinds: MOVERS },
  { key: "drag", label: "DRAG", min: 0, max: 6, step: 0.1, kinds: MOVERS },
  { key: "spin", label: "SPIN", min: 0, max: 12, step: 0.5, kinds: ["shard"] },
  { key: "size", label: "SIZE", min: 0.5, max: 60, step: 0.5 },
  { key: "sizeEnd", label: "SIZE END", min: 0, max: 90, step: 0.5 },
  { key: "life", label: "LIFE", min: 0.05, max: 2, step: 0.05, unit: "s" },
  { key: "lifeVary", label: "LIFE VARY", min: 0, max: 1, step: 0.05, kinds: MOVERS },
  { key: "delay", label: "DELAY", min: 0, max: 1, step: 0.05, unit: "s" },
  { key: "hold", label: "HOLD", min: 0, max: 1, step: 0.05 },
];

const applies = (row: FieldRow, kind: BurstLayerKind) => !row.kinds || row.kinds.includes(kind);

export interface BurstDesignerProps {
  explosions: ExplosionSet;
  onApply: (set: ExplosionSet) => void;
  onCancel: () => void;
}

export default function BurstDesigner({ explosions, onApply, onCancel }: BurstDesignerProps) {
  const [set, setSet] = useState<ExplosionSet>(explosions);
  const [role, setRole] = useState<ExplosionRole>("blast");
  const [layerIndex, setLayerIndex] = useState(0);
  const smoothRef = useRef<HTMLCanvasElement | null>(null);
  const pixelRef = useRef<HTMLCanvasElement | null>(null);
  // The loop reads these every frame and must not be rebuilt by a render, the
  // same arrangement the game's own loop uses for the state it needs -- and
  // mirrored through effects rather than assigned during render, which is both
  // the rule and this codebase's existing idiom for exactly this.
  const setRef = useRef(set);
  const roleRef = useRef(role);
  useEffect(() => { setRef.current = set; }, [set]);
  useEffect(() => { roleRef.current = role; }, [role]);

  const explosion = set[role];
  const layers = explosion.burst.layers;
  const layer: BurstLayer | undefined = layers[layerIndex] ?? layers[0];

  const editBurst = useCallback((role: ExplosionRole, next: Parameters<typeof normalizeBurst>[0]) => {
    // Every edit lands through normalize, so the panel cannot put a document
    // into a state a saved file could not also be in.
    setSet((current) => ({ ...current, [role]: { ...current[role], burst: normalizeBurst(next) } }));
  }, []);

  const editLayer = useCallback((patch: Partial<BurstLayer>) => {
    const current = setRef.current[roleRef.current].burst;
    const target = current.layers[layerIndex] ?? current.layers[0];
    if (!target) return;
    editBurst(roleRef.current, {
      ...current,
      layers: current.layers.map((entry) => (entry === target ? { ...entry, ...patch } : entry)),
    });
  }, [editBurst, layerIndex]);

  const addLayer = useCallback(() => {
    const current = setRef.current[roleRef.current].burst;
    editBurst(roleRef.current, { ...current, layers: [...current.layers, { kind: "spark", count: 8 }] });
    setLayerIndex(current.layers.length);
  }, [editBurst]);

  const removeLayer = useCallback(() => {
    const current = setRef.current[roleRef.current].burst;
    if (current.layers.length <= 1) return;
    editBurst(roleRef.current, { ...current, layers: current.layers.filter((_, at) => at !== layerIndex) });
    setLayerIndex((at) => Math.max(0, at - 1));
  }, [editBurst, layerIndex]);

  // One preview loop for both canvases, replaying on a beat so an explosion
  // that lasts a third of a second can still be judged.
  useEffect(() => {
    let frame = 0;
    let runtime = createBurstRuntime(setRef.current[roleRef.current].burst, PREVIEW_W / 2, PREVIEW_H / 2);
    let rest = 0;
    let last = performance.now();
    let shownFor = "";

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const active = setRef.current[roleRef.current];
      const signature = JSON.stringify(active.burst);
      // Restart the moment the document changes, so a slider shows its own
      // result rather than the tail of the previous explosion.
      if (signature !== shownFor) {
        shownFor = signature;
        runtime = createBurstRuntime(active.burst, PREVIEW_W / 2, PREVIEW_H / 2);
        rest = 0;
      } else if (!advanceBurst(runtime, dt)) {
        rest += dt;
        if (rest > 0.45) { runtime = createBurstRuntime(active.burst, PREVIEW_W / 2, PREVIEW_H / 2); rest = 0; }
      }

      const grid = setRef.current.pixelGrid;
      const shot = burstFrame(runtime);
      for (const [canvas, pixelled] of [[smoothRef.current, false], [pixelRef.current, true]] as const) {
        const context = canvas?.getContext("2d");
        if (!context) continue;
        context.fillStyle = "#050b11";
        context.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
        drawBurst(context, shot, pixelled
          ? { pixelGrid: Math.max(1, grid || 3), palette: active.burst.palette }
          : {});
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const numberRow = (row: FieldRow, value: number) => (
    <label className="range-field" key={row.key}>
      <span><b>{row.label}</b><em>{row.step < 1 ? value.toFixed(2) : Math.round(value)}{row.unit ?? ""}</em></span>
      <input
        type="range" min={row.min} max={row.max} step={row.step} value={value}
        onChange={(event) => editLayer({ [row.key]: Number(event.target.value) } as Partial<BurstLayer>)}
      />
    </label>
  );

  return (
    <div className="studio-overlay burst-designer" role="dialog" aria-modal="true" aria-label="Explosion designer">
      <div className="studio-shell">
        <header className="studio-head">
          <h2>EXPLOSION DESIGNER</h2>
          <p>One document, drawn two ways. The sector&apos;s explosions are designed here and played by the game exactly as previewed.</p>
        </header>

        <div className="burst-body">
          <div className="burst-roles">
            {EXPLOSION_ROLES.map((entry) => (
              <button
                key={entry} type="button"
                className={"burst-role" + (entry === role ? " active" : "")}
                aria-pressed={entry === role}
                onClick={() => { setRole(entry); setLayerIndex(0); }}
              >
                <b>{ROLE_LABELS[entry]}</b><em>{ROLE_NOTES[entry]}</em>
              </button>
            ))}
            <label className="range-field burst-global">
              <span><b>PIXEL GRID</b><em>{set.pixelGrid === 0 ? "SMOOTH" : set.pixelGrid + "px"}</em></span>
              <input type="range" min="0" max="8" step="1" value={set.pixelGrid}
                onChange={(event) => setSet((current) => ({ ...current, pixelGrid: Number(event.target.value) }))} />
            </label>
            <p className="inspector-note">Zero draws the game&apos;s explosions smooth. Above zero snaps them to a grid and to the palette — era art from the same document, applied to the whole sector.</p>
          </div>

          <div className="burst-stages">
            <figure><figcaption>VECTOR{set.pixelGrid === 0 ? " — IN GAME" : ""}</figcaption>
              <canvas ref={smoothRef} width={PREVIEW_W} height={PREVIEW_H} /></figure>
            <figure><figcaption>PIXEL ART{set.pixelGrid > 0 ? " — IN GAME" : ""}</figcaption>
              <canvas ref={pixelRef} width={PREVIEW_W} height={PREVIEW_H} /></figure>
            <p className="burst-readout">
              {ROLE_LABELS[role]} — {burstDuration(explosion.burst).toFixed(2)}s, {layers.length} layer{layers.length === 1 ? "" : "s"}
            </p>
            <label className="range-field">
              <span><b>WORLD TINT</b><em>{Math.round(explosion.tint * 100)}%</em></span>
              <input type="range" min="0" max="1" step="0.05" value={explosion.tint}
                onChange={(event) => setSet((current) => ({ ...current, [role]: { ...current[role], tint: Number(event.target.value) } }))} />
            </label>
            <p className="inspector-note">How far the engine&apos;s colour for the event pulls these colours toward it. At zero the design keeps its own fire; at full a shot sparks in the shot&apos;s colour.</p>
          </div>

          <div className="burst-layers">
            <div className="burst-layer-list">
              {layers.map((entry, at) => (
                <button key={entry.id ?? at} type="button"
                  className={"burst-layer-chip" + (at === layerIndex ? " active" : "")}
                  aria-pressed={at === layerIndex}
                  onClick={() => setLayerIndex(at)}>
                  <i style={{ background: entry.colorFrom }} />{entry.kind.toUpperCase()}
                </button>
              ))}
              <button type="button" className="burst-layer-add" onClick={addLayer}>+ LAYER</button>
            </div>

            {layer && <EbAccordion allowMultiple>
              <EbAccordionItem title="LAYER" defaultExpanded>
                <label className="field wide"><span>KIND</span>
                  <select value={layer.kind} onChange={(event) => editLayer({ kind: event.target.value as BurstLayerKind })}>
                    {BURST_LAYER_KINDS.map((kind) => <option key={kind} value={kind}>{kind.toUpperCase()}</option>)}
                  </select>
                </label>
                <div className="field-grid">
                  <label className="field"><span>FROM</span>
                    <input type="color" value={layer.colorFrom} onChange={(event) => editLayer({ colorFrom: event.target.value })} /></label>
                  <label className="field"><span>TO</span>
                    <input type="color" value={layer.colorTo} onChange={(event) => editLayer({ colorTo: event.target.value })} /></label>
                </div>
                {layers.length > 1 && <button type="button" className="inspector-action" onClick={removeLayer}>REMOVE THIS LAYER</button>}
              </EbAccordionItem>
              <EbAccordionItem title="SHAPE" defaultExpanded>
                {FIELDS.filter((row) => applies(row, layer.kind)).map((row) => numberRow(row, Number(layer[row.key])))}
              </EbAccordionItem>
            </EbAccordion>}
          </div>
        </div>

        <footer className="studio-foot">
          <button type="button" onClick={() => setSet(defaultExplosions())}>RESET ALL</button>
          <span className="studio-spacer" />
          <button type="button" onClick={onCancel}>CANCEL</button>
          <button type="button" className="studio-commit" onClick={() => onApply(set)}>SAVE EXPLOSIONS</button>
        </footer>
      </div>
    </div>
  );
}
