/**
 * Screenshot geometry (PC tools V2, D2): every coordinate an agent sends or reads is a pixel of the screenshots it
 * sees. Linux PCs are 1280x800 (WXGA, the trained resolution), so the mapping is 1:1 there; a larger screen (a macOS
 * VM) is shown scaled to a 1280-long-edge image of at most ~1.02 MP, and coordinates are scaled back. The model never
 * picks the image size.
 */

import type { Rect } from '../../../contracts/PcApi.js';

export interface ScreenGeometry {
  /** The guest screen in pixels. */
  readonly screenW: number;
  readonly screenH: number;
  /** The screenshot (and coordinate space) the agent sees. */
  readonly imgW: number;
  readonly imgH: number;
  /** Image pixels per screen pixel (at most 1). */
  readonly scale: number;
}

/** Longest image edge. */
export const IMAGE_LONG_EDGE = 1280;
/** Most image pixels (1280x800). */
export const IMAGE_MAX_PIXELS = 1_024_000;

export function geometryFor(screen: { readonly w: number; readonly h: number }): ScreenGeometry {
  const w = Math.max(1, Math.round(screen.w));
  const h = Math.max(1, Math.round(screen.h));
  const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(w, h), Math.sqrt(IMAGE_MAX_PIXELS / (w * h)));
  return {
    screenW: w,
    screenH: h,
    imgW: Math.max(1, Math.round(w * scale)),
    imgH: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/** Image tokens of an image (⌈w/28⌉·⌈h/28⌉): 1280x800 is 1,334. */
export function imageTokens(w: number, h: number): number {
  return Math.ceil(w / 28) * Math.ceil(h / 28);
}

export type PointCheck = { ok: true; x: number; y: number } | { ok: false; x: number; y: number };

/** An image point (rounded) checked against the image bounds. */
export function checkPoint(g: ScreenGeometry, xy: readonly number[]): PointCheck {
  const x = Math.round(Number(xy[0]));
  const y = Math.round(Number(xy[1]));
  const ok = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < g.imgW && y < g.imgH;
  return { ok, x, y };
}

/** An image point as screen pixels. */
export function toScreen(g: ScreenGeometry, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(g.screenW - 1, Math.round(x / g.scale))),
    y: Math.max(0, Math.min(g.screenH - 1, Math.round(y / g.scale))),
  };
}

/** A screen point as image pixels. */
export function toImage(g: ScreenGeometry, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(g.imgW - 1, Math.round(x * g.scale))),
    y: Math.max(0, Math.min(g.imgH - 1, Math.round(y * g.scale))),
  };
}

/** The centre of a screen rectangle, in image pixels. */
export function centreOf(g: ScreenGeometry, r: Rect): { x: number; y: number } {
  return toImage(g, r.x + r.w / 2, r.y + r.h / 2);
}

/** `[x0, y0, x1, y1]` in image pixels as a screen rectangle, or null when it is empty or off the image. */
export function regionToScreen(g: ScreenGeometry, region: readonly number[]): Rect | null {
  if (region.length !== 4) return null;
  const [x0, y0, x1, y1] = region.map((v) => Math.round(Number(v))) as [number, number, number, number];
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > g.imgW || y1 > g.imgH) return null;
  const a = toScreen(g, x0, y0);
  const w = Math.max(1, Math.round((x1 - x0) / g.scale));
  const h = Math.max(1, Math.round((y1 - y0) / g.scale));
  return { x: a.x, y: a.y, w: Math.min(w, g.screenW - a.x), h: Math.min(h, g.screenH - a.y) };
}
