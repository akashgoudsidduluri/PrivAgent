/**
 * PrivAgent — Modern Bottom Task Composer Component (Phase 18)
 *
 * Requirements:
 * - Large comfortable input
 * - Clear submit button
 * - Keyboard-friendly (Enter to submit, Shift+Enter for newline)
 * - Disabled / loading / running / completed states
 * - Stop button when running
 * - Directly invokes existing startTask pipeline
 */

import { DashboardAgentState } from '../types/dashboard';

export interface TaskComposerCallbacks {
  onSubmitTask: (task: string) => void;
  onStopTask: () => void;
}

export class TaskComposer {
  private container: HTMLElement;
  private callbacks: TaskComposerCallbacks;
  private latestState: DashboardAgentState | null = null;
  private textarea!: HTMLTextAreaElement;
  private runBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;

  constructor(container: HTMLElement, callbacks: TaskComposerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="composer-dock-container">
        <div class="composer-card" id="composer-card">
          <div class="composer-input-row">
            <textarea
              id="composer-input"
              class="composer-textarea"
              placeholder="Message PrivAgent — ask anything, or describe a browser task to run"
              rows="1"
            ></textarea>
          </div>

          <div class="composer-controls-row">
            <div class="composer-privacy-badge">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              <span>On-device privacy boundary active (zero raw PII)</span>
            </div>

            <div class="composer-actions">
              <button id="composer-btn-stop" class="btn-stop-agent" style="display:none" title="Stop current task">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="5" y="5" width="14" height="14" rx="2" ry="2"></rect>
                </svg>
                <span>Stop</span>
              </button>

              <button id="composer-btn-run" class="btn-run-agent" title="Run Agent (Enter)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="12" y1="19" x2="12" y2="5"></line>
                  <polyline points="5 12 12 5 19 12"></polyline>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.textarea = this.container.querySelector('#composer-input') as HTMLTextAreaElement;
    this.runBtn = this.container.querySelector('#composer-btn-run') as HTMLButtonElement;
    this.stopBtn = this.container.querySelector('#composer-btn-stop') as HTMLButtonElement;

    this.setupEvents();
  }

  private setupEvents(): void {
    // Auto-expand textarea
    this.textarea.addEventListener('input', () => {
      this.textarea.style.height = 'auto';
      this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 180)}px`;
    });

    // Keyboard submission
    this.textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });

    this.runBtn.addEventListener('click', () => {
      this.submit();
    });

    this.stopBtn.addEventListener('click', () => {
      this.callbacks.onStopTask();
    });
  }

  private submit(): void {
    const text = this.textarea.value.trim();
    if (!text) return;

    // Clear input immediately upon submission
    this.textarea.value = '';
    this.textarea.style.height = 'auto';

    this.callbacks.onSubmitTask(text);
  }

  setTaskPrompt(text: string): void {
    this.textarea.value = text;
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 180)}px`;
    this.textarea.focus();
  }

  update(state: DashboardAgentState): void {
    this.latestState = state;
    const isRunning = state.status === 'RUNNING';

    if (isRunning) {
      this.stopBtn.style.display = 'inline-flex';
    } else {
      this.stopBtn.style.display = 'none';
    }
    this.runBtn.disabled = false;
    this.runBtn.style.opacity = '1';
  }
}
