import * as fs from 'fs';
import { NormalizedTimeline, LossFunction } from '../types/CSL';

interface TimelineWrapper {
  prompt: string;
  totalDuration: number;
  timeline: NormalizedTimeline;
}

function formatParams(loss: LossFunction): string {
  const params = loss.parameters ?? {};
  const values = Object.values(params);
  if (values.length === 0) return "";
  return `: ${values.map(String).join(', ')}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateSvgTimeline(filePath: string): string {
  let wrapper: TimelineWrapper;
  const raw = fs.readFileSync(filePath, 'utf8');
  wrapper = JSON.parse(raw) as TimelineWrapper;

  const totalDuration = wrapper.totalDuration ?? 24;
  const data = wrapper.timeline ?? [];
  const promptText = wrapper.prompt ?? 'Camera Timeline';

  const WIDTH = 1400;
  const HEIGHT = 550;
  const MARGIN = 100;
  const TIMELINE_Y = 400;
  const SCALE = (WIDTH - 2 * MARGIN) / totalDuration;

  const colors = ["#3498db", "#e74c3c", "#2ecc71", "#f1c40f", "#9b59b6"];
  const svg: string[] = [];

  svg.push(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">`);
  svg.push('<rect width="100%" height="100%" fill="#f8f9fa" />');

  const truncatedPrompt = escapeXml(promptText.length > 110 ? promptText.slice(0, 110) + '...' : promptText);
  svg.push(`<text x="${MARGIN}" y="40" font-family="Arial" font-size="16" fill="#333" font-weight="bold">${truncatedPrompt}</text>`);

  svg.push(`<line x1="${MARGIN}" y1="${TIMELINE_Y}" x2="${WIDTH - MARGIN}" y2="${TIMELINE_Y}" stroke="#333" stroke-width="3" />`);

  let colorIdx = 0;

  for (const segment of data) {
    if (segment.kind === 'point') {
      const x = MARGIN + segment.time * SCALE;
      svg.push(`<line x1="${x}" y1="${TIMELINE_Y}" x2="${x}" y2="${TIMELINE_Y - 140}" stroke="#c0392b" stroke-width="2" stroke-dasharray="4"/>`);
      svg.push(`<circle cx="${x}" cy="${TIMELINE_Y}" r="6" fill="#c0392b" />`);

      for (let i = 0; i < segment.lossFunctions.length; i++) {
        const loss = segment.lossFunctions[i]!;
        const label = escapeXml(`${loss.type}${formatParams(loss)} (${segment.time}s)`);
        svg.push(`<text x="${x}" y="${TIMELINE_Y - 150 - i * 20}" font-family="Arial" font-size="11" text-anchor="middle" fill="#c0392b" font-weight="bold">${label}</text>`);
      }
    } else if (segment.kind === 'interval') {
      const sT = segment.startTime;
      const eT = segment.endTime;
      const xStart = MARGIN + sT * SCALE;
      const xEnd = MARGIN + eT * SCALE;
      const w = Math.max(xEnd - xStart, 2);
      const color = colors[colorIdx % colors.length]!;
      colorIdx++;

      svg.push(`<rect x="${xStart}" y="${TIMELINE_Y - 15}" width="${w}" height="30" fill="${color}" fill-opacity="0.7" stroke="white" stroke-width="1" rx="4" />`);

      const midX = xStart + w / 2;
      for (let i = 0; i < segment.lossFunctions.length; i++) {
        const loss = segment.lossFunctions[i]!;
        const label = escapeXml(`${loss.type}${formatParams(loss)} [${sT}s -> ${eT}s]`);
        svg.push(`<text x="${midX}" y="${TIMELINE_Y - 50 - i * 20}" font-family="Arial" font-size="11" text-anchor="middle" fill="${color}" font-weight="bold">${label}</text>`);
      }
    }
  }

  for (let t = 0; t <= Math.floor(totalDuration); t++) {
    const x = MARGIN + t * SCALE;
    const isMajor = t % 5 === 0;
    svg.push(`<line x1="${x}" y1="${TIMELINE_Y}" x2="${x}" y2="${TIMELINE_Y + (isMajor ? 15 : 8)}" stroke="#333" stroke-width="${isMajor ? 2 : 1}" />`);
    if (isMajor) {
      svg.push(`<text x="${x}" y="${TIMELINE_Y + 35}" font-family="Arial" font-size="12" text-anchor="middle" font-weight="bold">${t}s</text>`);
    }
  }

  svg.push('</svg>');

  return svg.join('\n');
}
