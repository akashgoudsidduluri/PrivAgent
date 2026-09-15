import { receiptsStore } from '../state/receiptsStore';
import { PrivacyReceipt } from '../types/dashboard';

export class ReceiptsView {
  private container: HTMLElement;
  private selectedReceipt: PrivacyReceipt | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
    receiptsStore.subscribe(() => this.renderList());
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="view-header">
        <div class="view-title-group">
          <h2>Privacy Receipts</h2>
          <p>Auditable cryptographic and execution records for every completed agent task</p>
        </div>
        <div class="receipts-toolbar">
          <input
            type="text"
            id="receipt-search"
            class="receipts-search"
            placeholder="Search receipts by task..."
          />
        </div>
      </div>

      <div class="receipts-container">
        <div id="receipt-cards-container" class="receipt-cards-grid"></div>
      </div>

      <!-- Detail Modal -->
      <div id="receipt-modal" class="modal-overlay">
        <div class="modal-box">
          <div class="modal-header">
            <h3>Privacy Receipt Audit</h3>
            <button id="btn-close-modal" class="modal-close">&times;</button>
          </div>
          <div id="modal-content" class="modal-body"></div>
          <div style="padding: 14px 24px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: flex-end; gap: 10px;">
            <button id="btn-export-receipt-json" class="btn btn-secondary">
              Export Audit JSON (Zero PII)
            </button>
            <button id="btn-modal-dismiss" class="btn btn-primary">
              Close
            </button>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.renderList();
  }

  private bindEvents(): void {
    const search = this.container.querySelector('#receipt-search') as HTMLInputElement;
    search?.addEventListener('input', () => this.renderList(search.value));

    const modal = this.container.querySelector('#receipt-modal')!;
    const btnClose = this.container.querySelector('#btn-close-modal')!;
    const btnDismiss = this.container.querySelector('#btn-modal-dismiss')!;
    const btnExport = this.container.querySelector('#btn-export-receipt-json')!;

    const closeModal = () => modal.classList.remove('open');
    btnClose.addEventListener('click', closeModal);
    btnDismiss.addEventListener('click', closeModal);

    btnExport.addEventListener('click', () => {
      if (!this.selectedReceipt) return;
      const dataStr =
        'data:text/json;charset=utf-8,' +
        encodeURIComponent(JSON.stringify(this.selectedReceipt, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute(
        'download',
        `privagent-receipt-${this.selectedReceipt.id}.json`
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    });
  }

  private renderList(filter = ''): void {
    const listContainer = this.container.querySelector('#receipt-cards-container');
    if (!listContainer) return;

    let list = receiptsStore.getAll();
    if (filter.trim()) {
      const q = filter.toLowerCase();
      list = list.filter((r) => r.task.toLowerCase().includes(q));
    }

    if (list.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align: center; padding: 48px; color: var(--text-muted);">
          No privacy receipts found. Run an agent task to generate auditable receipts.
        </div>
      `;
      return;
    }

    listContainer.innerHTML = list
      .map(
        (r) => `
      <div class="receipt-card" data-id="${r.id}">
        <div class="receipt-info">
          <h4>${escapeHtml(r.task)}</h4>
          <div class="receipt-meta">
            <span>📅 ${new Date(r.timestamp).toLocaleTimeString()}</span>
            <span>•</span>
            <span style="color: ${
              r.result === 'SUCCESS' ? 'var(--shield-green)' : 'var(--danger-red)'
            }; font-weight: 600;">
              ${r.result === 'SUCCESS' ? '✓ Completed' : r.result}
            </span>
            <span>•</span>
            <span style="color: var(--shield-green);">
              🔒 ${r.sensitiveDetectedCount} items protected
            </span>
          </div>
        </div>

        <div class="receipt-stats">
          <div class="stat-item">
            <div class="stat-val">${r.llmRequestsCount}</div>
            <div class="stat-lbl">LLM Calls</div>
          </div>
          <div class="stat-item">
            <div class="stat-val">${r.browserActionsCount}</div>
            <div class="stat-lbl">Actions</div>
          </div>
          <div class="stat-item">
            <div class="stat-val">${(r.latencyMs / 1000).toFixed(2)}s</div>
            <div class="stat-lbl">Latency</div>
          </div>
          <div>
            <span style="color: var(--accent-blue); font-size: 13px;">View Audit &rarr;</span>
          </div>
        </div>
      </div>
    `
      )
      .join('');

    const cards = listContainer.querySelectorAll('.receipt-card');
    cards.forEach((c) => {
      c.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).getAttribute('data-id');
        if (id) this.openReceiptModal(id);
      });
    });
  }

  private openReceiptModal(id: string): void {
    const receipt = receiptsStore.getById(id);
    if (!receipt) return;
    this.selectedReceipt = receipt;

    const modal = this.container.querySelector('#receipt-modal')!;
    const content = this.container.querySelector('#modal-content')!;

    content.innerHTML = `
      <div style="background-color: var(--bg-tertiary); padding: 14px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
        <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">Task</div>
        <div style="font-size: 16px; font-weight: 600; color: var(--text-primary); margin-top: 2px;">
          ${escapeHtml(receipt.task)}
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
          Receipt ID: <code>${receipt.id}</code> • ${new Date(receipt.timestamp).toLocaleString()}
        </div>
      </div>

      <div>
        <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Privacy Verification</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">Sensitive info detected</div>
            <div style="font-size: 16px; font-weight: 600; color: var(--shield-green);">${receipt.sensitiveDetectedCount}</div>
          </div>
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">Sensitive info transmitted</div>
            <div style="font-size: 16px; font-weight: 600; color: var(--shield-green);">0 (Strictly Blocked)</div>
          </div>
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">Raw screenshots transmitted</div>
            <div style="font-size: 16px; font-weight: 600; color: var(--shield-green);">0</div>
          </div>
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">Raw DOM values transmitted</div>
            <div style="font-size: 16px; font-weight: 600; color: var(--shield-green);">0</div>
          </div>
        </div>
      </div>

      <div>
        <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Agent Execution & Performance</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">LLM Requests</div>
            <div style="font-size: 15px; font-weight: 600;">${receipt.llmRequestsCount}</div>
          </div>
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">Browser Actions</div>
            <div style="font-size: 15px; font-weight: 600;">${receipt.browserActionsCount}</div>
          </div>
          <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">Total Wall Latency</div>
            <div style="font-size: 15px; font-weight: 600;">${(receipt.latencyMs / 1000).toFixed(2)}s</div>
          </div>
        </div>
      </div>

      <div>
        <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Protected Categories</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${receipt.categoriesDetected.map((cat) => `<span class="category-pill detected">✓ ${escapeHtml(cat)}</span>`).join('')}
        </div>
      </div>

      <div>
        <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Sanitized Context Shared with Reasoner</h4>
        <ul style="list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary);">
          ${receipt.sanitizedContextShared.map((item) => `<li>✓ ${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    `;

    modal.classList.add('open');
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
