import * as fs from "fs";
import sharp from "sharp";
import { FlattenedTimeline, LossFunction, TimeWarpSegment } from "../types/solver";

const SVG_WIDTH = 1400;
const SVG_HEIGHT = 550;
const MARGIN = 100;
const TIMELINE_Y = 500;
const TICK_MAJOR_INTERVAL = 5;
const MAX_PROMPT_LENGTH = 200;

const SEGMENT_COLORS = ["#3498db", "#e74c3c", "#2ecc71", "#f1c40f", "#9b59b6"];
const POINT_COLOR = "#c0392b";

// Persian/Arabic Unicode ranges for RTL detection
const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

interface TimelineFile {
  prompt: string;
  totalDuration: number;
  timeline: FlattenedTimeline;
  timeWarp: TimeWarpSegment[];
}


interface IntervalLane {
  seg: {
    startTime: number;
    endTime: number;
    lossFunctions: LossFunction[];
    rate?: number;
  };
  lane: number;
  color: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLossLabel(loss: LossFunction): string {
  const vals = Object.values(loss.parameters ?? {});
  const suffix = vals.length > 0 ? `: ${vals.map(String).join(", ")}` : "";
  return `${loss.type}${suffix}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function isRtlText(text: string): boolean {
  return RTL_REGEX.test(text);
}

export function generateSvgTimeline(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8");
  const wrapper = JSON.parse(raw) as TimelineFile;

  const totalDuration = wrapper.totalDuration ?? 24;
  const flattened = wrapper.timeline;
  const segments = flattened.timeline;
  const timeWarp = flattened.timeWarp;


  const segmentsWithRate = segments.map(seg => {
    if (seg.kind !== "interval") return seg;

    const warp = timeWarp.find(
      w =>
        w.startTimePlayback <= seg.startTime &&
        w.endTimePlayback >= seg.endTime
    );

    return {
      ...seg,
      rate: warp?.rate ?? 1
    };
  });


  const promptText = wrapper.prompt ?? "Camera Timeline";
  const rtl = isRtlText(promptText);

  const scale = (SVG_WIDTH - 2 * MARGIN) / totalDuration;
  const lines: string[] = [];

  lines.push(`<svg width="${SVG_WIDTH}" height="${SVG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">`);
  lines.push(`<defs><style>text { font-family: "Segoe UI", "Tahoma", "Arial", "Vazirmatn", sans-serif; }</style></defs>`);
  lines.push(`<rect width="100%" height="100%" fill="#f8f9fa" />`);

  const title = escapeXml(truncate(promptText, MAX_PROMPT_LENGTH));
  const titleX = SVG_WIDTH / 2;
  const titleAnchor = "middle";
  const titleDir = rtl ? ' direction="rtl" unicode-bidi="embed"' : "";
  lines.push(
    `<text x="${titleX}" y="40" font-size="16" fill="#333" font-weight="bold" text-anchor="${titleAnchor}"${titleDir}>${title}</text>`
  );

  lines.push(
    `<line x1="${MARGIN}" y1="${TIMELINE_Y}" x2="${SVG_WIDTH - MARGIN}" y2="${TIMELINE_Y}" stroke="#333" stroke-width="3" />`
  );


  const intervalLanes: IntervalLane[] = [];
  const laneEndTimes: number[] = [];

  let colorIdx = 0;

  // Assign lanes
  for (const seg of segmentsWithRate) {

    if (seg.kind !== "interval") continue;

    let lane = 0;

    while (
      lane < laneEndTimes.length &&
      seg.startTime < laneEndTimes[lane]!
    ) {
      lane++;
    }

    laneEndTimes[lane] = seg.endTime;

    intervalLanes.push({
      seg,
      lane,
      color: SEGMENT_COLORS[
        colorIdx++ % SEGMENT_COLORS.length
      ]!
    });
  }

  const maxLane =
    Math.max(
      0,
      ...intervalLanes.map(i => i.lane)
    );

  const intervalColorMap = new Map<number, string>();

  for (const item of intervalLanes) {
    intervalColorMap.set(
      item.seg.startTime,
      item.color
    );

    renderIntervalSegment(
      lines,
      item.seg,
      scale,
      item.color,
      item.lane
    );
  }

  const pointStacks = new Map<number, number>();

  for (const seg of segmentsWithRate) {

    if (seg.kind !== "point") continue;

    const stackIndex =
      pointStacks.get(seg.time) ?? 0;

    pointStacks.set(
      seg.time,
      stackIndex + 1
    );

    const color =
      intervalColorMap.get(seg.time) ??
      POINT_COLOR;

    renderPointSegment(
      lines,
      seg,
      scale,
      color,
      stackIndex,
      maxLane
    );

  }
  renderTickMarks(lines, totalDuration, scale);
  lines.push("</svg>");

  const svgContent = lines.join("\n");

  const svgPath = filePath.replace(/\.json$/, ".svg");
  fs.writeFileSync(svgPath, svgContent, "utf8");
  console.log(`  SVG saved: ${svgPath}`);

  return svgContent;
}

export async function generatePngTimeline(filePath: string): Promise<void> {
  const svgPath = filePath.replace(/\.json$/, ".svg");
  const pngPath = filePath.replace(/\.json$/, ".png");

  if (!fs.existsSync(svgPath)) {
    console.warn(`  ⚠ SVG file not found at ${svgPath} – generate SVG first.`);
    return;
  }

  const svgBuffer = fs.readFileSync(svgPath);

  await sharp(svgBuffer)
    .png()
    .toFile(pngPath);

  console.log(`  PNG saved: ${pngPath}`);
}

function renderPointSegment(
  lines: string[],
  seg: {
    time: number;
    lossFunctions: LossFunction[];
    easing?: {
      inDuration?: number;
      outDuration?: number;
      curve?: string;
    };
  },
  scale: number,
  color: string,
  stackIndex: number,
  maxLane: number,
): void {

  const x =
    MARGIN +
    seg.time * scale;

  const stackOffset =
    stackIndex * 90;

  const pointBaseY =
    TIMELINE_Y -
    80 -
    maxLane * 70;

  const baseTopY =
    pointBaseY -
    stackOffset;

  if (seg.easing) {
    const inDuration = seg.easing.inDuration ?? 0;
    const outDuration = seg.easing.outDuration ?? 0;
    const easedStartX = x - inDuration * scale;
    const easedEndX = x + outDuration * scale;
    if (easedEndX > easedStartX) {
      lines.push(
        `<rect x="${easedStartX}" y="${TIMELINE_Y - 7}" width="${easedEndX - easedStartX}" height="14" fill="${color}" fill-opacity="0.16" rx="7" />`
      );
    }
  }

  lines.push(
    `<line x1="${x}" y1="${TIMELINE_Y}" x2="${x}" y2="${baseTopY}" stroke="${color}" stroke-width="2" stroke-dasharray="4"/>`
  );

  lines.push(
    `<circle cx="${x}" cy="${TIMELINE_Y}" r="6" fill="${color}" />`
  );

  seg.lossFunctions.forEach((loss, i) => {

    const label =
      escapeXml(
        `${formatLossLabel(loss)} (${seg.time}s)`
      );

    const y =
      baseTopY -
      10 -
      i * 20;

    lines.push(`
      <rect
        x="${x - 80}"
        y="${y - 12}"
        width="160"
        height="16"
        fill="white"
        fill-opacity="0.9"
      />
    `);

    lines.push(
      `<text x="${x}" y="${y}" font-size="11" text-anchor="middle" fill="${color}" font-weight="bold">${label}</text>`
    );
  });
}

function renderIntervalSegment(
  lines: string[],
  seg: {
    startTime: number;
    endTime: number;
    lossFunctions: LossFunction[];
    rate?: number;
  },
  scale: number,
  color: string,
  lane: number,
): void {

  const laneHeight = 80;

  const y =
    TIMELINE_Y -
    15 -
    lane * laneHeight;

  const xStart =
    MARGIN +
    seg.startTime * scale;

  const xEnd =
    MARGIN +
    seg.endTime * scale;

  const width =
    Math.max(
      xEnd - xStart,
      2
    );

  const midX =
    xStart + width / 2;

  lines.push(
    `<rect x="${xStart}" y="${y}" width="${width}" height="30" fill="${color}" fill-opacity="0.7" stroke="white" stroke-width="1" rx="4" />`
  );

  const labels = [
    `rate: ${seg.rate ?? 1}x`,
    ...seg.lossFunctions.map(formatLossLabel)
  ];

  labels.forEach((labelText, i) => {

  const label = escapeXml(
    `${labelText} [${seg.startTime}s → ${seg.endTime}s]`
  );

    const labelY =
      y - 10 - i * 20;

    lines.push(`
      <rect
        x="${midX - 100}"
        y="${labelY - 12}"
        width="200"
        height="16"
        fill="white"
        fill-opacity="0.9"
      />
    `);

    lines.push(
      `<text x="${midX}" y="${labelY}" font-size="11" text-anchor="middle" fill="${color}" font-weight="bold">${label}</text>`
    );
  });
}

function renderTickMarks(lines: string[], totalDuration: number, scale: number): void {
  for (let t = 0; t <= Math.floor(totalDuration); t++) {
    const x = MARGIN + t * scale;
    const isMajor = t % TICK_MAJOR_INTERVAL === 0;
    const tickHeight = isMajor ? 15 : 8;
    const strokeWidth = isMajor ? 2 : 1;

    lines.push(
      `<line x1="${x}" y1="${TIMELINE_Y}" x2="${x}" y2="${TIMELINE_Y + tickHeight}" stroke="#333" stroke-width="${strokeWidth}" />`
    );

    if (isMajor) {
      lines.push(
        `<text x="${x}" y="${TIMELINE_Y + 35}" font-size="12" text-anchor="middle" font-weight="bold">${t}s</text>`
      );
    }
  }
}

