import { useStore, type Node } from "@xyflow/react";

/**
 * AlignmentGuides renders horizontal and vertical snap lines on the canvas
 * when a node is being dragged near alignment with other nodes.
 *
 * It checks center-to-center, top-to-top, bottom-to-bottom, left-to-left,
 * and right-to-right alignment within a configurable threshold.
 */

const SNAP_THRESHOLD = 8; // pixels in flow coordinates

interface GuideLine {
  type: "horizontal" | "vertical";
  pos: number; // y for horizontal, x for vertical
  from: number; // start coordinate
  to: number; // end coordinate
}

export function AlignmentGuides() {
  const transform = useStore((s) => s.transform);
  const nodes = useStore((s) => s.nodes);

  // Find the node being dragged
  const draggingNode = nodes.find((n: Node) => n.dragging);

  if (!draggingNode) return null;

  const guides = computeGuides(draggingNode, nodes);

  if (guides.length === 0) return null;

  const [tx, ty, zoom] = transform;

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20"
      style={{ width: "100%", height: "100%" }}
    >
      {guides.map((g, i) => {
        if (g.type === "horizontal") {
          // Horizontal line at y = g.pos
          const screenY = g.pos * zoom + ty;
          const screenX1 = g.from * zoom + tx;
          const screenX2 = g.to * zoom + tx;
          return (
            <line
              key={`h-${i}`}
              x1={screenX1}
              y1={screenY}
              x2={screenX2}
              y2={screenY}
              stroke="rgba(245, 158, 11, 0.5)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          );
        } else {
          // Vertical line at x = g.pos
          const screenX = g.pos * zoom + tx;
          const screenY1 = g.from * zoom + ty;
          const screenY2 = g.to * zoom + ty;
          return (
            <line
              key={`v-${i}`}
              x1={screenX}
              y1={screenY1}
              x2={screenX}
              y2={screenY2}
              stroke="rgba(245, 158, 11, 0.5)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          );
        }
      })}
    </svg>
  );
}

function computeGuides(dragging: Node, allNodes: Node[]): GuideLine[] {
  const guides: GuideLine[] = [];

  const dw = (dragging.measured?.width ?? dragging.width ?? 200);
  const dh = (dragging.measured?.height ?? dragging.height ?? 100);
  const dCx = dragging.position.x + dw / 2;
  const dCy = dragging.position.y + dh / 2;
  const dTop = dragging.position.y;
  const dBottom = dragging.position.y + dh;
  const dLeft = dragging.position.x;
  const dRight = dragging.position.x + dw;

  for (const node of allNodes) {
    if (node.id === dragging.id || node.hidden) continue;

    const nw = (node.measured?.width ?? node.width ?? 200);
    const nh = (node.measured?.height ?? node.height ?? 100);
    const nCx = node.position.x + nw / 2;
    const nCy = node.position.y + nh / 2;
    const nTop = node.position.y;
    const nBottom = node.position.y + nh;
    const nLeft = node.position.x;
    const nRight = node.position.x + nw;

    // Horizontal alignments (same Y)
    const hChecks = [
      { dy: dCy, ny: nCy }, // center-center
      { dy: dTop, ny: nTop }, // top-top
      { dy: dBottom, ny: nBottom }, // bottom-bottom
      { dy: dTop, ny: nBottom }, // top-bottom
      { dy: dBottom, ny: nTop }, // bottom-top
    ];

    for (const { dy, ny } of hChecks) {
      if (Math.abs(dy - ny) < SNAP_THRESHOLD) {
        const minX = Math.min(dLeft, nLeft) - 20;
        const maxX = Math.max(dRight, nRight) + 20;
        guides.push({ type: "horizontal", pos: ny, from: minX, to: maxX });
      }
    }

    // Vertical alignments (same X)
    const vChecks = [
      { dx: dCx, nx: nCx }, // center-center
      { dx: dLeft, nx: nLeft }, // left-left
      { dx: dRight, nx: nRight }, // right-right
      { dx: dLeft, nx: nRight }, // left-right
      { dx: dRight, nx: nLeft }, // right-left
    ];

    for (const { dx, nx } of vChecks) {
      if (Math.abs(dx - nx) < SNAP_THRESHOLD) {
        const minY = Math.min(dTop, nTop) - 20;
        const maxY = Math.max(dBottom, nBottom) + 20;
        guides.push({ type: "vertical", pos: nx, from: minY, to: maxY });
      }
    }
  }

  // Deduplicate similar guides
  const deduped: GuideLine[] = [];
  for (const g of guides) {
    const exists = deduped.some(
      (d) => d.type === g.type && Math.abs(d.pos - g.pos) < 2,
    );
    if (!exists) deduped.push(g);
  }

  return deduped;
}
