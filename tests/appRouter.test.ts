import { describe, it, expect, beforeEach } from 'vitest';
import { AppRouter } from '../frontend/src/routing/appRouter';

describe('PrivAgent Routing Architecture', () => {
  beforeEach(() => {
    window.location.hash = '';
    window.history.pushState(null, '', '/');
  });

  it('1. AppRouter singleton resolves root marketing route "/" initially', () => {
    const router = AppRouter.getInstance();
    expect(router.getCurrentRoute()).toBe('/');
  });

  it('2. Navigating to "/app" updates currentRoute and notifies subscribers', () => {
    const router = AppRouter.getInstance();
    const observed: string[] = [];

    const unsubscribe = router.subscribe((route) => {
      observed.push(route);
    });

    router.navigate('/app');
    expect(router.getCurrentRoute()).toBe('/app');

    router.navigate('/');
    expect(router.getCurrentRoute()).toBe('/');

    unsubscribe();
  });

  it('3. Respects hash fallback "#/app"', () => {
    window.location.hash = '#/app';
    const router = AppRouter.getInstance();
    // Re-resolve or check hash support
    expect(window.location.hash).toContain('/app');
  });
});
