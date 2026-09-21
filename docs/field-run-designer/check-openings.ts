/**
 * Ducktective check (temporary, host-authored): on a real persisted wire, no
 * opening may be mis-hosted such that its lintel/sill strip is oversized or its
 * frame floats off the host wall.
 *
 *   npx tsx dt-check-openings.ts examplewire.json   # the real wire
 *   npx tsx dt-check-openings.ts --synthetic        # known-good control
 *
 * Exits 1 (throws) when an anomaly is found, 0 otherwise.
 */
import { readFileSync } from "node:fs";
import {
  applyOpeningCutsToWallSpecs,
  floorsInputFromWire,
  openingSpecsFromFloor,
  wallSpecsFromFloor,
} from "./packages/ifc/writer/src/index.js";

const SYNTHETIC = {
  floors: [{ id: "f1", name: "Ground", height: 3 }],
  spaces: [
    {
      id: "s1",
      name: "Room",
      floorId: "f1",
      polygon: {
        points: [
          { x: 0, y: 0 },
          { x: 6, y: 0 },
          { x: 6, y: 4 },
          { x: 0, y: 4 },
        ],
      },
    },
  ],
  openings: [
    { id: "d1", kind: "door", floorId: "f1", parentSpaceId: "s1", center: { x: 3, y: 0 }, widthM: 0.9 },
  ],
};

function load(): unknown {
  const arg = process.argv[2] ?? "examplewire.json";
  if (arg === "--synthetic") return SYNTHETIC;
  return JSON.parse(readFileSync(arg, "utf8"));
}

const floors = floorsInputFromWire(load());
let anomalies = 0;
let maxDepthOff = 0;
const details: string[] = [];

for (const floor of floors) {
  const walls = wallSpecsFromFloor(floor);
  const openings = openingSpecsFromFloor(floor);
  const cuts = applyOpeningCutsToWallSpecs(walls, openings, floor.height ?? 3);
  const byName = new Map(openings.map((o) => [o.name, o]));

  for (const op of openings) {
    const d = Math.abs(op.depthOffsetM ?? 0);
    maxDepthOff = Math.max(maxDepthOff, d);
    if (d > op.thicknessM / 2 + 0.05) {
      anomalies += 1;
      details.push(
        `${floor.id ?? "?"} ${op.name}: depthOffset ${d.toFixed(2)}m > half-thickness ${(op.thicknessM / 2).toFixed(2)}m`,
      );
    }
  }

  for (const piece of cuts) {
    const m = /^(.*)-(lintel|sill)$/.exec(piece.name ?? "");
    if (!m || !piece.footprint) continue;
    const op = byName.get(m[1]);
    if (!op) continue;
    const t = op.tangent;
    const n = { x: -t.y, y: t.x };
    let tMin = Infinity;
    let tMax = -Infinity;
    let nMin = Infinity;
    let nMax = -Infinity;
    for (const p of piece.footprint) {
      const dt = (p.x - op.center.x) * t.x + (p.y - op.center.y) * t.y;
      const dn = (p.x - op.center.x) * n.x + (p.y - op.center.y) * n.y;
      tMin = Math.min(tMin, dt);
      tMax = Math.max(tMax, dt);
      nMin = Math.min(nMin, dn);
      nMax = Math.max(nMax, dn);
    }
    const span = tMax - tMin;
    const depth = nMax - nMin;
    if (span > op.widthM + 0.6 || depth > 0.5) {
      anomalies += 1;
      details.push(
        `${floor.id ?? "?"} ${piece.name}: strip span ${span.toFixed(2)}m depth ${depth.toFixed(2)}m (opening width ${op.widthM.toFixed(2)}m)`,
      );
    }
  }
}

console.log(JSON.stringify({ floors: floors.length, anomalies, maxDepthOff: Number(maxDepthOff.toFixed(3)) }));
if (details.length) console.log(details.slice(0, 25).join("\n"));
if (anomalies > 0) throw new Error(`${anomalies} opening-cut anomaly(ies) on the real wire`);
