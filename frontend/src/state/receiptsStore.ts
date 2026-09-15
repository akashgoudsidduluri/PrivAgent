import { PrivacyReceipt } from '../types/dashboard';

const STORAGE_KEY = 'privagent_privacy_receipts';

class ReceiptsStore {
  private receipts: PrivacyReceipt[] = [];
  private listeners: Array<() => void> = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        this.receipts = JSON.parse(data);
      }
    } catch {
      this.receipts = [];
    }

    // Populate standard demo receipts if empty
    if (this.receipts.length === 0) {
      this.receipts = [
        {
          id: 'rcpt-demo-1',
          task: 'Find my recent transactions',
          timestamp: Date.now() - 1000 * 60 * 15,
          result: 'SUCCESS',
          sensitiveDetectedCount: 6,
          sensitiveTransmittedCount: 0,
          rawScreenshotsTransmitted: 0,
          rawDomTransmitted: 0,
          categoriesDetected: ['account_number', 'credit_card', 'email'],
          sanitizedContextShared: ['Button labels', 'Table headers', 'Safe coordinates', 'Non-sensitive text'],
          llmRequestsCount: 3,
          browserActionsCount: 4,
          latencyMs: 1420,
          steps: [
            {
              step: 1,
              actionType: 'click',
              targetDescription: 'Account Overview Button',
              validationPassed: true,
              executionSuccess: true,
              timestamp: Date.now() - 1000 * 60 * 15 + 300,
            },
            {
              step: 2,
              actionType: 'scroll',
              targetDescription: 'Scroll down 300px',
              validationPassed: true,
              executionSuccess: true,
              timestamp: Date.now() - 1000 * 60 * 15 + 750,
            },
            {
              step: 3,
              actionType: 'click',
              targetDescription: 'Transaction History Tab',
              validationPassed: true,
              executionSuccess: true,
              sensitiveCategoryDetected: 'account_number',
              timestamp: Date.now() - 1000 * 60 * 15 + 1420,
            },
          ],
        },
        {
          id: 'rcpt-demo-2',
          task: 'Open account details',
          timestamp: Date.now() - 1000 * 60 * 60,
          result: 'SUCCESS',
          sensitiveDetectedCount: 4,
          sensitiveTransmittedCount: 0,
          rawScreenshotsTransmitted: 0,
          rawDomTransmitted: 0,
          categoriesDetected: ['password', 'account_number'],
          sanitizedContextShared: ['Page structure', 'Safe coordinates'],
          llmRequestsCount: 1,
          browserActionsCount: 1,
          latencyMs: 480,
          steps: [
            {
              step: 1,
              actionType: 'click',
              targetDescription: 'Account Details Link',
              validationPassed: true,
              executionSuccess: true,
              sensitiveCategoryDetected: 'account_number',
              timestamp: Date.now() - 1000 * 60 * 60 + 480,
            },
          ],
        },
      ];
      this.save();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.receipts));
    } catch {
      // ignore storage errors
    }
    this.notify();
  }

  getAll(): PrivacyReceipt[] {
    return [...this.receipts];
  }

  getById(id: string): PrivacyReceipt | undefined {
    return this.receipts.find((r) => r.id === id);
  }

  addReceipt(receipt: PrivacyReceipt): void {
    this.receipts.unshift(receipt);
    // Keep max 50 receipts
    if (this.receipts.length > 50) {
      this.receipts = this.receipts.slice(0, 50);
    }
    this.save();
  }

  clearAll(): void {
    this.receipts = [];
    this.save();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const receiptsStore = new ReceiptsStore();
