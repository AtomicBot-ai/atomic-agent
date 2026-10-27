/**
 * Mapping between the pixels of the screenshot the model looked at and
 * the screen points CoreGraphics clicks in.
 *
 * A capture is downscaled (a Retina screen is ~2 px per point, and the
 * long side is capped for the vision model), so the model's `x, y` are
 * image pixels: `point = origin + pixel / scale`, where `scale` is image
 * pixels per screen point and `origin` is the top-left of the captured
 * region in points (0,0 for the whole primary display).
 */
export interface CaptureGeometry {
  originX: number;
  originY: number;
  /** Image pixels per screen point. */
  scale: number;
  imageWidth: number;
  imageHeight: number;
}

/** Long side of the image handed to the vision model, in pixels. */
export const SCREENSHOT_MAX_SIDE = 1280;

/**
 * The image size after the downscale: unchanged when it already fits,
 * otherwise the long side becomes `maxSide` and the short one follows
 * (what `sips -Z` does).
 */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number = SCREENSHOT_MAX_SIDE,
): { width: number; height: number; resize: boolean } {
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height, resize: false };
  const ratio = maxSide / long;
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
    resize: true,
  };
}

export function captureGeometry(
  region: { x: number; y: number; width: number; height: number },
  image: { width: number; height: number },
): CaptureGeometry {
  return {
    originX: region.x,
    originY: region.y,
    scale: image.width / region.width,
    imageWidth: image.width,
    imageHeight: image.height,
  };
}

const SCALE_EPSILON = 1e-3;

/**
 * Screen point for a model coordinate.
 *
 * - No `scale` argument: the session's last capture decides (its scale
 *   and its region origin), or points 1:1 when nothing was captured.
 * - A `scale` equal to the last capture's: that capture, origin included.
 * - Any other `scale`: a full-screen image at that scale, origin 0,0.
 */
export function toScreenPoint(
  x: number,
  y: number,
  last: CaptureGeometry | undefined,
  scaleArg?: number,
): { x: number; y: number; scale: number; originX: number; originY: number } {
  const useLast =
    last !== undefined &&
    (scaleArg === undefined || Math.abs(scaleArg - last.scale) < SCALE_EPSILON);
  const scale = useLast ? last.scale : (scaleArg ?? 1);
  const originX = useLast ? last.originX : 0;
  const originY = useLast ? last.originY : 0;
  return {
    x: round1(originX + x / scale),
    y: round1(originY + y / scale),
    scale,
    originX,
    originY,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Last capture per session, so a click can map back without echoing it. */
export class ScreenGeometryStore {
  private readonly bySession = new Map<string, CaptureGeometry>();

  constructor(private readonly maxSessions = 64) {}

  set(sessionId: string, geometry: CaptureGeometry): void {
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, geometry);
    while (this.bySession.size > this.maxSessions) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
  }

  get(sessionId: string): CaptureGeometry | undefined {
    return this.bySession.get(sessionId);
  }
}
