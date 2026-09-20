/**
 * PrivAgent 2.0 — Subphase P2.5: Bounded Video Key-Frame Perception Test Suite
 *
 * Covers:
 *  1. Video element detection and metadata extraction (bbox, duration, readyState)
 *  2. Strict frame count limit enforcement (ceiling of 3 frames max)
 *  3. Generation stamping (pageGeneration) and perception source ('layout')
 *  4. Invariant: Zero raw frame pixels or data URLs in output findings
 *  5. Invisible/microscopic video suppression
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sampleVideoKeyFrames } from '../extension/src/visualPerception/videoKeyFrameSampler';

describe('Subphase P2.5 — Video Key-Frame Perception', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects video elements and enforces strict max-3 key frame ceiling', async () => {
    document.body.innerHTML = `
      <video id="hero-video" width="640" height="360" src="/media/demo.mp4"></video>
    `;

    const vid = document.getElementById('hero-video') as HTMLVideoElement;
    vid.getBoundingClientRect = () => ({
      left: 20, top: 20, right: 660, bottom: 380, width: 640, height: 360, x: 20, y: 20, toJSON: () => {}
    });
    Object.defineProperty(vid, 'duration', { value: 12.5, writable: true });
    Object.defineProperty(vid, 'paused', { value: false, writable: true });
    Object.defineProperty(vid, 'readyState', { value: 4, writable: true });

    // Request 10 frames — system MUST strictly cap at 3
    const findings = await sampleVideoKeyFrames({
      pageGeneration: 6,
      root: document,
      maxFramesPerVideo: 10,
    });

    expect(findings.length).toBe(3); // Strict ceiling enforced!
    expect(findings[0]!.totalFramesSampled).toBe(3);
    expect(findings[0]!.frameIndex).toBe(1);
    expect(findings[1]!.frameIndex).toBe(2);
    expect(findings[2]!.frameIndex).toBe(3);

    // Verify metadata
    expect(findings[0]!.elementId).toBe('hero-video');
    expect(findings[0]!.durationSeconds).toBe(12.5);
    expect(findings[0]!.hasMotion).toBe(true);
    expect(findings[0]!.pageGeneration).toBe(6);
    expect(findings[0]!.source).toBe('layout');

    // INVARIANT: No raw frame data in findings
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('base64');
  });

  it('ignores microscopic videos smaller than 16x16 pixels', async () => {
    document.body.innerHTML = `
      <video id="tracker-pixel-video" width="1" height="1"></video>
    `;

    const vid = document.getElementById('tracker-pixel-video') as HTMLVideoElement;
    vid.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0, toJSON: () => {}
    });

    const findings = await sampleVideoKeyFrames({ pageGeneration: 1, root: document });
    expect(findings.length).toBe(0);
  });
});
