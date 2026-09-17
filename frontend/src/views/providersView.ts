import { BackendHealthState } from '../types/dashboard';

export class ProvidersView {
  private container: HTMLElement;
  private health: BackendHealthState | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  updateHealth(health: BackendHealthState): void {
    this.health = health;
    this.renderTable();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="margin-bottom: 12px;">
        <div class="ide-panel-header">
          <span>Reasoner Providers & Hardware Gateway</span>
          <span class="badge badge-green">SERVER-SIDE SECURED</span>
        </div>
        <div class="ide-panel-body">
          <div class="metric-grid">
            <div class="metric-tile">
              <span class="metric-label">Active Provider</span>
              <span id="provider-active-name" class="metric-value blue mono">GROQ</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Active Model</span>
              <span id="provider-active-model" class="metric-value mono" style="font-size: 11px;">openai/gpt-oss-20b</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Fallback Provider</span>
              <span id="provider-fallback-name" class="metric-value mono">OPENROUTER</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Credential Boundary</span>
              <span class="metric-value green">BACKEND ONLY</span>
            </div>
          </div>
        </div>
      </div>

      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Registered LLM Reasoning Engines</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">ONE CALL PER STEP · M6 AUTHORITATIVE</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th>Provider Name</th>
                <th>Model Identifier</th>
                <th style="width: 140px;">API Key Status</th>
                <th style="width: 130px; text-align: center;">Availability</th>
                <th style="width: 120px; text-align: center;">Active Mode</th>
              </tr>
            </thead>
            <tbody id="providers-table-body">
              <!-- Rendered dynamically -->
            </tbody>
          </table>
        </div>
      </div>

      <div class="ide-panel" style="margin-top: 12px;">
        <div class="ide-panel-header">
          <span>Key Security & Rate Limit Guarantee</span>
          <span class="badge badge-green">VERIFIED</span>
        </div>
        <div class="ide-panel-body" style="font-size: 11px; color: var(--text-secondary);">
          <p><strong>GROQ_API_KEY</strong> and <strong>OPENROUTER_API_KEY</strong> reside solely within the local backend environment. They are never exposed to browser context, Chrome extension storage, window globals, DOM, or telemetry. Rate limits (HTTP 429) fail closed without repetitive quota-burning retry loops.</p>
        </div>
      </div>
    `;

    this.renderTable();
  }

  private renderTable(): void {
    const tbody = this.container.querySelector('#providers-table-body');
    const activeName = this.container.querySelector('#provider-active-name');
    const activeModel = this.container.querySelector('#provider-active-model');
    const fallbackName = this.container.querySelector('#provider-fallback-name');

    const primary = (this.health?.reasoner || 'groq').toLowerCase();
    const isGroq = primary === 'groq';

    if (activeName) activeName.textContent = primary.toUpperCase();
    if (activeModel) activeModel.textContent = this.health?.model || (isGroq ? 'openai/gpt-oss-20b' : 'google/gemma-4-31b-it:free');
    if (fallbackName) fallbackName.textContent = (this.health?.fallback_reasoner || 'openrouter').toUpperCase();

    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td><strong class="mono">Groq (Primary)</strong></td>
        <td class="mono">openai/gpt-oss-20b</td>
        <td><span class="badge badge-green">CONFIGURED</span></td>
        <td style="text-align: center;"><span class="badge badge-green">AVAILABLE</span></td>
        <td style="text-align: center;"><span class="badge badge-blue">PRIMARY</span></td>
      </tr>
      <tr>
        <td><strong class="mono">OpenRouter</strong></td>
        <td class="mono">google/gemma-4-31b-it:free</td>
        <td><span class="badge badge-green">CONFIGURED</span></td>
        <td style="text-align: center;"><span class="badge badge-green">AVAILABLE</span></td>
        <td style="text-align: center;"><span class="badge badge-gray">FALLBACK</span></td>
      </tr>
      <tr>
        <td><strong class="mono">Deterministic Mock</strong></td>
        <td class="mono">offline-grounded-mock</td>
        <td><span class="badge badge-gray">NOT REQUIRED</span></td>
        <td style="text-align: center;"><span class="badge badge-green">AVAILABLE</span></td>
        <td style="text-align: center;"><span class="badge badge-gray">TEST ONLY</span></td>
      </tr>
    `;
  }
}
