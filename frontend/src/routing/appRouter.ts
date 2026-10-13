/**
 * PrivAgent — Lightweight Client-Side Application Router
 *
 * Supports two distinct experiences:
 * 1. '/'     → Public marketing homepage
 * 2. '/app'  → Existing PrivAgent browser-agent workspace application
 *
 * Robust against both HTML5 pushState routes and Hash fallbacks:
 * Supports '/app', '#/app', '/', and '#/'.
 */

export type AppRoute = '/' | '/app';

export type RouteListener = (route: AppRoute) => void;

export class AppRouter {
  private static instance: AppRouter | null = null;
  private currentRoute: AppRoute = '/';
  private listeners: Set<RouteListener> = new Set();

  private constructor() {
    this.currentRoute = this.resolveCurrentRoute();
    this.setupListeners();
  }

  static getInstance(): AppRouter {
    if (!AppRouter.instance) {
      AppRouter.instance = new AppRouter();
    }
    return AppRouter.instance;
  }

  getCurrentRoute(): AppRoute {
    return this.currentRoute;
  }

  navigate(to: AppRoute): void {
    if (this.currentRoute === to) return;
    this.currentRoute = to;

    // Use pushState with a clean path or fallback hash if on file/static host
    try {
      const url = new URL(window.location.href);
      if (to === '/app') {
        url.pathname = '/app';
        if (url.hash.startsWith('#/')) url.hash = '';
      } else {
        url.pathname = '/';
        if (url.hash.startsWith('#/')) url.hash = '';
      }
      window.history.pushState({ route: to }, '', url.toString());
    } catch {
      window.location.hash = `#${to}`;
    }

    this.notify();
  }

  subscribe(listener: RouteListener): () => void {
    this.listeners.add(listener);
    // Notify immediately with current route
    listener(this.currentRoute);
    return () => this.listeners.delete(listener);
  }

  private resolveCurrentRoute(): AppRoute {
    if (typeof window === 'undefined') return '/';

    const hash = window.location.hash;
    const pathname = window.location.pathname.toLowerCase();

    // Check hash first (e.g. #/app or #app)
    if (hash === '#/app' || hash === '#app' || hash.startsWith('#/app')) {
      return '/app';
    }

    // Check pathname (e.g. /app or /app/)
    if (pathname === '/app' || pathname === '/app/' || pathname.endsWith('/app') || pathname.endsWith('/app/')) {
      return '/app';
    }

    return '/';
  }

  private setupListeners(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('popstate', () => {
      const newRoute = this.resolveCurrentRoute();
      if (newRoute !== this.currentRoute) {
        this.currentRoute = newRoute;
        this.notify();
      }
    });

    window.addEventListener('hashchange', () => {
      const newRoute = this.resolveCurrentRoute();
      if (newRoute !== this.currentRoute) {
        this.currentRoute = newRoute;
        this.notify();
      }
    });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.currentRoute);
      } catch (err) {
        console.error('Error in route listener:', err);
      }
    }
  }
}

export const appRouter = AppRouter.getInstance();
