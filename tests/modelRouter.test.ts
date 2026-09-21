import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter } from '../extension/src/agent/modelRouter';
import { AgentProvider } from '../extension/src/agent/agentProvider';

describe('ModelRouter (Phase 6)', () => {
  let mockBackendProvider: AgentProvider;

  beforeEach(() => {
    mockBackendProvider = {
      name: 'MockBackend',
      requestAction: vi.fn().mockResolvedValue({ action: 'navigate', url: 'https://example.com' }),
      reviewAction: vi.fn().mockResolvedValue({ safe: true, reason: 'Safe' }),
    };
  });

  it('routes to FAST for simple tasks initially', async () => {
    const router = new ModelRouter(mockBackendProvider);
    await router.requestAction('simple task', { detections: [] } as any, []);
    expect(mockBackendProvider.requestAction).toHaveBeenCalledWith(
      'simple task',
      expect.anything(),
      [],
      'FAST'
    );
  });

  it('escalates to STRONG on first failure', async () => {
    const router = new ModelRouter(mockBackendProvider);
    router.registerFailure(); // 1st failure
    await router.requestAction('simple task', { detections: [] } as any, []);
    expect(mockBackendProvider.requestAction).toHaveBeenCalledWith(
      'simple task',
      expect.anything(),
      [],
      'STRONG'
    );
  });

  it('escalates to VISION on second failure', async () => {
    const router = new ModelRouter(mockBackendProvider);
    router.registerFailure(); // 1st
    router.registerFailure(); // 2nd
    await router.requestAction('simple task', { detections: [] } as any, []);
    expect(mockBackendProvider.requestAction).toHaveBeenCalledWith(
      'simple task',
      expect.anything(),
      [],
      'VISION'
    );
  });

  it('routes to STRONG for complex tasks immediately', async () => {
    const router = new ModelRouter(mockBackendProvider);
    const complexTask = 'This is a very long and complex task that exceeds the word limit and character count threshold';
    await router.requestAction(complexTask, { detections: [] } as any, []);
    expect(mockBackendProvider.requestAction).toHaveBeenCalledWith(
      complexTask,
      expect.anything(),
      [],
      'STRONG'
    );
  });

  it('delegates safety review', async () => {
    const router = new ModelRouter(mockBackendProvider);
    const result = await router.reviewAction({ action: 'click', target: 'test' } as any, 'task', {} as any);
    expect(mockBackendProvider.reviewAction).toHaveBeenCalled();
    expect(result.safe).toBe(true);
  });
});
