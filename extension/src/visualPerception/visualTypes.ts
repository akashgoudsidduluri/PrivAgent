/**
 * PrivAgent 2.0 — Visual Perception Types (Phase 2)
 *
 * Strongly typed structural metadata contracts for local multimodal perception.
 *
 * CRITICAL PRIVACY INVARIANT:
 *  - Raw screenshots, image buffers, and canvas pixel data must NEVER leave local device memory.
 *  - The remote LLM receives ONLY sanitized structural metadata (bounding boxes, classifications,
 *    confidence scores, perception source, and generation stamps).
 */

export type PerceptionSource = 'layout' | 'ocr' | 'pixel' | 'vision';

export type VisualRegionType =
  | 'container'
  | 'card'
  | 'button_like'
  | 'image'
  | 'canvas'
  | 'video'
  | 'text_block'
  | 'modal'
  | 'banner'
  | 'unknown';

export interface VisualRegion {
  id: string;
  type: VisualRegionType;
  bbox: [number, number, number, number]; // [x, y, width, height] in standard viewport coordinates
  visible: boolean;
  confidence: number;
  pageGeneration: number;
  source: PerceptionSource;
  semanticHint?: string; // Sanitized safe hint only (no raw credentials)
  associatedElementId?: string;
}

export interface ScreenshotCaptureOptions {
  maxDimension?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
  pageGeneration: number;
}

export interface LocalScreenshot {
  id: string;
  pageGeneration: number;
  timestamp: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  source: PerceptionSource;
  release: () => void;
  isReleased: () => boolean;
  getRawDataUrl: () => string;
}

export interface ScreenshotProvider {
  captureViewport(options: ScreenshotCaptureOptions): Promise<LocalScreenshot>;
}

export type ImageFindingType =
  | 'icon'
  | 'logo'
  | 'product_image'
  | 'avatar'
  | 'card'
  | 'banner'
  | 'visual_control'
  | 'unknown';

export interface ImageFinding {
  id: string;
  type: ImageFindingType;
  bbox: [number, number, number, number];
  confidence: number;
  pageGeneration: number;
  source: PerceptionSource;
  associatedElementId?: string;
  label?: string; // Sanitized structural label
}

export type VisualInteractiveCandidateType =
  | 'canvas_button'
  | 'image_button'
  | 'visual_control'
  | 'unknown';

export interface VisualInteractiveCandidate {
  id: string;
  type: VisualInteractiveCandidateType;
  bbox: [number, number, number, number];
  confidence: number;
  pageGeneration: number;
  source: PerceptionSource;
  suggestedAction: 'click' | 'focus' | 'hover';
  label?: string;
  associatedElementId?: string;
}

export interface CanvasFinding {
  id: string;
  bbox: [number, number, number, number];
  hasInteractiveElements: boolean;
  detectedText: boolean;
  textSensitivity: 'safe' | 'sensitive' | 'unknown';
  isChartOrGraphic: boolean;
  confidence: number;
  pageGeneration: number;
  source: PerceptionSource;
  associatedElementId?: string;
  interactiveCandidates: VisualInteractiveCandidate[];
}

export interface VideoKeyFrameFinding {
  id: string;
  elementId?: string;
  bbox: [number, number, number, number];
  frameIndex: number;
  totalFramesSampled: number;
  durationSeconds?: number;
  visualChangeScore?: number;
  hasMotion: boolean;
  pageGeneration: number;
  source: PerceptionSource;
  detectedSceneSummary?: string; // Optional metadata, never raw frame bytes
}

export interface MultimodalPerceptionReport {
  pageGeneration: number;
  captureTimestamp: number;
  visualRegions: VisualRegion[];
  imageFindings: ImageFinding[];
  canvasFindings: CanvasFinding[];
  videoFindings: VideoKeyFrameFinding[];
  interactiveCandidates: VisualInteractiveCandidate[];
  durationMs: number;
}
