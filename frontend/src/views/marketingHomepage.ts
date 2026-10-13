/**
 * PrivAgent — Public Marketing Homepage View
 *
 * Implements the 9 required marketing sections inspired by the clean,
 * technical AI infrastructure aesthetics of Browser Use and Skyvern:
 *
 * Section 1: Navigation with geometric logo, navigation links, and "Launch PrivAgent" CTA
 * Section 2: Hero with eyebrow, headline, description, CTAs, and art-directed product visual
 * Section 3: How It Works with 6 connected stages (Observe, Sanitize, Plan, Validate, Execute, Verify)
 * Section 4: Privacy Architecture diagram distinguishing local runtime from remote reasoning
 * Section 5: Security Features with 6 compact, consistent cards
 * Section 6: Product Preview of the browser-agent workspace
 * Section 7: Evaluation with strictly verified project metrics
 * Section 8: Final CTA
 * Section 9: Footer with SIH 2026 & ISRO Problem Statement 26171 branding
 */

import { appRouter } from '../routing/appRouter';

export class MarketingHomepage {
  private container: HTMLElement;
  private isMobileMenuOpen = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
    this.setupInteractivity();
  }

  private render(): void {
    this.container.innerHTML = `
      <!-- =================================================================
           SECTION 1 — NAVIGATION
           ================================================================= -->
      <header class="hp-nav">
        <div class="hp-container hp-nav-inner">
          <a href="#" class="hp-brand" id="hp-brand-logo">
            <div class="hp-logo-mark" aria-hidden="true">
              <!-- Geometric shield & viewport aperture logo -->
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 3L4 8V16C4 23.5 9.1 30.5 16 32C22.9 30.5 28 23.5 28 16V8L16 3Z" stroke="#FE750E" stroke-width="2.2" stroke-linejoin="round"/>
                <circle cx="16" cy="16" r="5" stroke="#FAFAFA" stroke-width="1.8"/>
                <path d="M16 8V11M16 21V24M8 16H11M21 16H24" stroke="#789090" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </div>
            <span class="hp-brand-name">PrivAgent</span>
            <span class="hp-brand-tag">ISRO PS-26171</span>
          </a>

          <nav>
            <ul class="hp-nav-links" id="hp-nav-links-menu">
              <li><a href="#product" class="hp-nav-link">Product</a></li>
              <li><a href="#architecture" class="hp-nav-link">Architecture</a></li>
              <li><a href="#security" class="hp-nav-link">Security</a></li>
              <li><a href="#evaluation" class="hp-nav-link">Evaluation</a></li>
              <li><a href="https://github.com/akashgoudsidduluri/PrivAgent" target="_blank" rel="noopener noreferrer" class="hp-nav-link">GitHub</a></li>
            </ul>
          </nav>

          <div class="hp-nav-actions">
            <button class="hp-btn hp-btn-primary hp-launch-btn" id="hp-nav-launch-btn">
              <span>Launch PrivAgent</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
            <button class="hp-mobile-menu-btn" id="hp-mobile-toggle" aria-label="Toggle navigation menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main>
        <!-- =================================================================
             SECTION 2 — HERO
             ================================================================= -->
        <section class="hp-section hp-hero-section" id="product">
          <div class="hp-container">
            <div class="hp-hero-content">
              <span class="hp-hero-eyebrow">PRIVACY-FIRST BROWSER AUTOMATION</span>
              <h1 class="hp-hero-headline">Your browser.
Your data.
Your control.</h1>
              <p class="hp-hero-desc">
                Meet PrivAgent — a privacy-first browser agent that protects sensitive information locally, validates browser actions, and verifies outcomes before reporting success.
              </p>
              <div class="hp-hero-ctas">
                <button class="hp-btn hp-btn-primary hp-launch-btn" id="hp-hero-launch-btn">
                  <span>Launch PrivAgent</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                    <polyline points="12 5 19 12 12 19"></polyline>
                  </svg>
                </button>
                <a href="#architecture" class="hp-btn hp-btn-secondary" id="hp-hero-arch-btn">
                  <span>Explore Architecture</span>
                </a>
              </div>
            </div>

            <!-- Large Art-Directed Product Visual (Mockup) -->
            <div class="hp-product-visual" role="region" aria-label="PrivAgent illustrative product visual">
              <div class="hp-browser-chrome">
                <div class="hp-browser-controls">
                  <span class="hp-window-dot"></span>
                  <span class="hp-window-dot"></span>
                  <span class="hp-window-dot"></span>
                </div>
                <div class="hp-browser-addressbar">
                  <span class="hp-ssl-lock">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                  </span>
                  <span>https://secure-banking-portal.isro.internal/accounts/transfers</span>
                </div>
                <span class="hp-boundary-badge">Local Privacy Boundary Active</span>
              </div>

              <div class="hp-browser-viewport-layout">
                <!-- Left: Synthetic Webpage with Illustrative Redaction -->
                <div class="hp-synthetic-page">
                  <div class="hp-page-header-mock">
                    <div class="hp-page-mock-title">Authorized Fund Transfer</div>
                    <div class="hp-page-mock-sub">Beneficiary account verification and one-time approval</div>
                  </div>

                  <div class="hp-form-mock-row">
                    <span class="hp-mock-label">Recipient Account / UPI ID</span>
                    <div class="hp-mock-input">
                      <span>isro-space-research@gov.in</span>
                      <span class="hp-mono-tag" style="color:var(--hp-technical)">Discovered #inp-dest</span>
                    </div>
                  </div>

                  <div class="hp-form-mock-row">
                    <span class="hp-mock-label">Transfer Amount</span>
                    <div class="hp-mock-input">
                      <span>₹ 25,000.00</span>
                      <span class="hp-mono-tag" style="color:var(--hp-technical)">Grounded #inp-amt</span>
                    </div>
                  </div>

                  <div class="hp-form-mock-row">
                    <span class="hp-mock-label">Security Authorization PIN</span>
                    <div class="hp-mock-input">
                      <span class="hp-mask-overlay">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                        <span>[PII_PIN: LOCAL_VAULT_REDACTED]</span>
                      </span>
                      <span class="hp-mask-tag">Zero Bytes Exfiltrated</span>
                    </div>
                  </div>

                  <div class="hp-form-mock-row" style="margin-top: 24px;">
                    <div style="display:inline-flex;padding:10px 20px;background:#181818;border:1px solid #333333;border-radius:4px;font-size:14px;color:#ffffff;align-items:center;gap:8px">
                      <span style="width:8px;height:8px;border-radius:50%;background:#4ade80"></span>
                      <span>Authorize Transaction (#btn-confirm)</span>
                    </div>
                  </div>
                </div>

                <!-- Right: Browser Context & Action Validation Panel -->
                <div class="hp-context-panel">
                  <div class="hp-panel-title">Runtime Verification Panel</div>

                  <div class="hp-status-card-mini">
                    <div class="hp-status-item-label">Target Browser Tab</div>
                    <div class="hp-status-item-val" style="color: #FAFAFA;">
                      <span>Verified Active [Tab #412]</span>
                    </div>
                  </div>

                  <div class="hp-status-card-mini">
                    <div class="hp-status-item-label">Action Validation Status</div>
                    <div class="hp-status-item-val">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                      <span>Approved: Policy Enforced</span>
                    </div>
                  </div>

                  <div class="hp-status-card-mini">
                    <div class="hp-status-item-label">Privacy Sanitization</div>
                    <div class="hp-status-item-val" style="color: var(--hp-accent);">
                      <span>1 Sensitive Field Isolated</span>
                    </div>
                  </div>

                  <div>
                    <div class="hp-status-item-label" style="margin-bottom: 8px;">Execution Timeline</div>
                    <div class="hp-timeline-mini">
                      <div class="hp-timeline-step">
                        <span class="hp-step-marker">✓</span>
                        <span class="hp-step-text">DOM scanned & element map built</span>
                      </div>
                      <div class="hp-timeline-step">
                        <span class="hp-step-marker">✓</span>
                        <span class="hp-step-text">PIN redacted on-device</span>
                      </div>
                      <div class="hp-timeline-step">
                        <span class="hp-step-marker active">●</span>
                        <span class="hp-step-text" style="color:var(--hp-text-primary)">Grounded click(#btn-confirm)</span>
                      </div>
                      <div class="hp-timeline-step">
                        <span class="hp-step-marker">○</span>
                        <span class="hp-step-text" style="color:var(--hp-text-muted)">Await post-action URL verify</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="hp-visual-caption">
                <span>Illustrative Architecture Preview — Real execution runs in the PrivAgent workspace at /app</span>
                <span>Chrome MV3 Extension + Local Python Runtime</span>
              </div>
            </div>
          </div>
        </section>

        <!-- =================================================================
             SECTION 3 — HOW IT WORKS
             ================================================================= -->
        <section class="hp-section" id="how-it-works">
          <div class="hp-container">
            <div class="hp-section-header">
              <span class="hp-section-eyebrow">DETERMINISTIC PIPELINE</span>
              <h2 class="hp-section-title">Automation with a boundary.</h2>
              <p class="hp-section-subtitle">
                Every browser step passes through six sequential safety barriers before touching the active web page.
              </p>
            </div>

            <div class="hp-timeline-grid">
              <!-- Stage 01 -->
              <div class="hp-stage-card">
                <span class="hp-stage-num">01 / STAGE</span>
                <h3 class="hp-stage-title">Observe</h3>
                <p class="hp-stage-desc">
                  Inspect the active page and discover relevant elements.
                </p>
              </div>

              <!-- Stage 02 -->
              <div class="hp-stage-card">
                <span class="hp-stage-num">02 / STAGE</span>
                <h3 class="hp-stage-title">Sanitize</h3>
                <p class="hp-stage-desc">
                  Detect sensitive information locally and minimize the context sent for reasoning.
                </p>
              </div>

              <!-- Stage 03 -->
              <div class="hp-stage-card">
                <span class="hp-stage-num">03 / STAGE</span>
                <h3 class="hp-stage-title">Plan</h3>
                <p class="hp-stage-desc">
                  Generate a structured browser-action proposal.
                </p>
              </div>

              <!-- Stage 04 -->
              <div class="hp-stage-card">
                <span class="hp-stage-num">04 / STAGE</span>
                <h3 class="hp-stage-title">Validate</h3>
                <p class="hp-stage-desc">
                  Check the proposed action against the active page and security policies.
                </p>
              </div>

              <!-- Stage 05 -->
              <div class="hp-stage-card">
                <span class="hp-stage-num">05 / STAGE</span>
                <h3 class="hp-stage-title">Execute</h3>
                <p class="hp-stage-desc">
                  Dispatch only authorized actions through the browser extension.
                </p>
              </div>

              <!-- Stage 06 -->
              <div class="hp-stage-card">
                <span class="hp-stage-num">06 / STAGE</span>
                <h3 class="hp-stage-title">Verify</h3>
                <p class="hp-stage-desc">
                  Check the observed browser state before reporting completion.
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- =================================================================
             SECTION 4 — PRIVACY ARCHITECTURE
             ================================================================= -->
        <section class="hp-section" id="architecture">
          <div class="hp-container">
            <div class="hp-section-header">
              <span class="hp-section-eyebrow">SECURITY BOUNDARY</span>
              <h2 class="hp-section-title">Sensitive data stays behind the boundary.</h2>
              <p class="hp-section-subtitle">
                Reasoning proposes. The local runtime decides.
              </p>
            </div>

            <div class="hp-arch-diagram-wrapper">
              <div class="hp-arch-zones">
                <!-- Zone 1: Local On-Device Boundary -->
                <div class="hp-arch-zone local">
                  <div class="hp-zone-header">
                    <span class="hp-zone-title">Local Runtime Boundary</span>
                    <span class="hp-zone-pill local">On-Device Execution</span>
                  </div>
                  <div class="hp-arch-flow">
                    <div class="hp-arch-step-node">
                      <span class="hp-arch-step-name">1. Browser DOM & Layout</span>
                      <span class="hp-arch-step-detail">Live Chrome Viewport</span>
                    </div>
                    <div class="hp-arch-step-node">
                      <span class="hp-arch-step-name">2. Local Perception</span>
                      <span class="hp-arch-step-detail">Spatial & Semantic Extraction</span>
                    </div>
                    <div class="hp-arch-step-node">
                      <span class="hp-arch-step-name">3. PII Detection & Redaction</span>
                      <span class="hp-arch-step-detail">Local Vault Replacement</span>
                    </div>
                    <div class="hp-arch-step-node" style="border-color: var(--hp-accent);">
                      <span class="hp-arch-step-name">4. Sanitized Context Egress</span>
                      <span class="hp-arch-step-detail">Zero Raw Secrets</span>
                    </div>
                    <div class="hp-arch-step-node">
                      <span class="hp-arch-step-name">6. Local Validation</span>
                      <span class="hp-arch-step-detail">Target Grounding & Safety</span>
                    </div>
                    <div class="hp-arch-step-node">
                      <span class="hp-arch-step-name">7. Authorized Browser Action</span>
                      <span class="hp-arch-step-detail">Dispatched to MV3 Extension</span>
                    </div>
                    <div class="hp-arch-step-node">
                      <span class="hp-arch-step-name">8. Effect Verification</span>
                      <span class="hp-arch-step-detail">Observed DOM Outcome Check</span>
                    </div>
                  </div>
                </div>

                <!-- Zone 2: Remote Reasoning Boundary -->
                <div class="hp-arch-zone remote">
                  <div class="hp-zone-header">
                    <span class="hp-zone-title">Remote Reasoning Boundary</span>
                    <span class="hp-zone-pill remote">Zero-Knowledge Reasoning</span>
                  </div>
                  <div class="hp-arch-flow">
                    <div class="hp-arch-step-node" style="min-height: 90px; align-items: flex-start; flex-direction: column; justify-content: center;">
                      <span class="hp-arch-step-name">5. Remote Reasoning Model</span>
                      <span class="hp-arch-step-detail" style="margin-top: 6px;">Receives only token-minimized, masked schema. Proposes next abstract browser step.</span>
                    </div>
                    <div class="hp-arch-step-node" style="background: #0d0d0d; border-color: #333333;">
                      <span class="hp-arch-step-name">Proposed Action Payload</span>
                      <span class="hp-arch-step-detail">Non-Executable Suggestion</span>
                    </div>
                    <div style="padding: 24px; border: 1px dashed #262626; border-radius: 4px; font-size: 13px; color: var(--hp-text-secondary); line-height: 1.6;">
                      <p style="margin: 0 0 8px 0; color: var(--hp-technical); font-weight: 600;">Strict Architectural Contract:</p>
                      The remote reasoning model never receives raw account credentials, passwords, or personal identity numbers. It has no direct access to browser socket connections or tabs.
                    </div>
                  </div>
                </div>
              </div>

              <div class="hp-arch-boundary-banner">
                <div class="hp-boundary-quote">"Reasoning proposes. The local runtime decides."</div>
                <div class="hp-boundary-subquote">
                  Browser commands are validated against live DOM elements and executed strictly through the local extension runtime.
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- =================================================================
             SECTION 5 — SECURITY FEATURES
             ================================================================= -->
        <section class="hp-section" id="security">
          <div class="hp-container">
            <div class="hp-section-header">
              <span class="hp-section-eyebrow">SECURITY GUARANTEES</span>
              <h2 class="hp-section-title">Engineered for hostile web environments.</h2>
              <p class="hp-section-subtitle">
                Six integrated security safeguards protecting user credentials, page integrity, and workflow predictability.
              </p>
            </div>

            <div class="hp-security-grid">
              <!-- Card 1 -->
              <div class="hp-security-card">
                <div class="hp-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <h3 class="hp-security-title">Local Privacy</h3>
                <p class="hp-security-desc">
                  Redacts passwords, authentication tokens, and sensitive form elements locally on-device before any context reaches reasoning providers.
                </p>
              </div>

              <!-- Card 2 -->
              <div class="hp-security-card">
                <div class="hp-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="22" y1="12" x2="18" y2="12"></line>
                    <line x1="6" y1="12" x2="2" y2="12"></line>
                    <line x1="12" y1="6" x2="12" y2="2"></line>
                    <line x1="12" y1="22" x2="12" y2="18"></line>
                  </svg>
                </div>
                <h3 class="hp-security-title">Target Grounding</h3>
                <p class="hp-security-desc">
                  Binds every proposed action to unambiguous live DOM selectors and verified spatial coordinates, preventing phantom clicks and element hallucination.
                </p>
              </div>

              <!-- Card 3 -->
              <div class="hp-security-card">
                <div class="hp-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11l3 3L22 4"></path>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                  </svg>
                </div>
                <h3 class="hp-security-title">Action Validation</h3>
                <p class="hp-security-desc">
                  Strict schema and safety validators inspect proposed operations prior to dispatch, rejecting unauthorized downloads, risky transitions, or malformed inputs.
                </p>
              </div>

              <!-- Card 4 -->
              <div class="hp-security-card">
                <div class="hp-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                  </svg>
                </div>
                <h3 class="hp-security-title">Risk Controls</h3>
                <p class="hp-security-desc">
                  Dynamic risk classification detects financial submissions and critical account operations, pausing the pipeline for human confirmation.
                </p>
              </div>

              <!-- Card 5 -->
              <div class="hp-security-card">
                <div class="hp-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 12h20M20 12l-4-4m4 4l-4 4"></path>
                  </svg>
                </div>
                <h3 class="hp-security-title">Effect Verification</h3>
                <p class="hp-security-desc">
                  Observes real DOM mutations, network state, and destination URLs after each action to confirm real browser effects before continuing.
                </p>
              </div>

              <!-- Card 6 -->
              <div class="hp-security-card">
                <div class="hp-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
                  </svg>
                </div>
                <h3 class="hp-security-title">Failure Containment</h3>
                <p class="hp-security-desc">
                  Isolates unexpected navigation barriers, popups, and rate limits with clean error classification rather than indefinite looping or corrupted states.
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- =================================================================
             SECTION 6 — PRODUCT PREVIEW
             ================================================================= -->
        <section class="hp-section" id="workspace-preview">
          <div class="hp-container">
            <div class="hp-section-header">
              <span class="hp-section-eyebrow">AGENT WORKSPACE PREVIEW</span>
              <h2 class="hp-section-title">The browser-agent workspace.</h2>
              <p class="hp-section-subtitle">
                An information-dense interface for composing tasks, monitoring browser diagnostics, and verifying privacy receipts.
              </p>
            </div>

            <!-- Workspace Preview Mockup -->
            <div class="hp-preview-frame">
              <div class="hp-preview-topbar">
                <div style="display:flex;align-items:center;gap:12px">
                  <span style="font-weight:600;font-size:14px;color:#FAFAFA;">PrivAgent Workspace</span>
                  <span class="hp-mono-tag" style="background:#111111;padding:2px 8px;border-radius:3px;border:1px solid #222222;color:var(--hp-technical)">Route /app</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#4ade80">
                    <span style="width:6px;height:6px;border-radius:50%;background:#4ade80"></span>
                    <span>Privacy Protected</span>
                  </span>
                  <button class="hp-btn hp-btn-primary hp-launch-btn" style="padding:6px 14px;font-size:13px" id="hp-preview-launch-btn">
                    Launch Live Workspace
                  </button>
                </div>
              </div>

              <div class="hp-preview-body">
                <!-- Left: Sessions & Controls -->
                <div class="hp-preview-sidebar">
                  <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#141414;border:1px solid var(--hp-border);border-radius:4px;font-size:13px;color:#FAFAFA">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    <span>New Task</span>
                  </div>

                  <div style="font-size:11px;font-family:var(--hp-font-mono);color:var(--hp-text-muted);text-transform:uppercase;margin-top:8px">Recent Task Receipts</div>

                  <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">
                    <div style="padding:8px;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:4px;">
                      <div style="color:#eeeeee;font-size:12px;">Query ISRO payload stats</div>
                      <div style="font-size:11px;color:#4ade80;margin-top:2px">SUCCESS · 0 bytes leaked</div>
                    </div>
                    <div style="padding:8px;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:4px;">
                      <div style="color:#eeeeee;font-size:12px;">Authenticate demo banking portal</div>
                      <div style="font-size:11px;color:#4ade80;margin-top:2px">SUCCESS · 2 fields masked</div>
                    </div>
                    <div style="padding:8px;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:4px;">
                      <div style="color:#eeeeee;font-size:12px;">Retrieve GitRank developer score</div>
                      <div style="font-size:11px;color:var(--hp-accent);margin-top:2px">COMPLETED · Grounded</div>
                    </div>
                  </div>
                </div>

                <!-- Center: Conversation Stream & Composer -->
                <div class="hp-preview-main">
                  <div>
                    <div class="hp-chat-bubble-mock user">
                      Navigate to the academic portal, query research publications from 2024, and extract citation summaries.
                    </div>

                    <div class="hp-chat-bubble-mock agent">
                      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;color:#4ade80;font-size:12px;font-family:var(--hp-font-mono)">
                        <span>● STEP 03 / EXECUTED & VERIFIED</span>
                      </div>
                      <p style="margin:0 0 8px 0">
                        Discovered 18 publication entries. Targeted the 2024 filter dropdown, verified URL parameter update, and extracted 6 peer-reviewed documents without transmitting personal browser session cookies.
                      </p>
                      <div style="font-size:12px;color:var(--hp-text-muted);font-family:var(--hp-font-mono)">
                        Target: #pub-grid-2024 · Verification: Observed DOM mutation confirmed
                      </div>
                    </div>
                  </div>

                  <div class="hp-mock-composer">
                    <span>Ask PrivAgent to navigate, fill forms, or extract data safely...</span>
                    <div style="width:28px;height:28px;background:var(--hp-accent);border-radius:4px;display:flex;align-items:center;justify-content:center;color:#000000">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                      </svg>
                    </div>
                  </div>
                </div>

                <!-- Right: Diagnostics & State -->
                <div class="hp-preview-right">
                  <div style="font-size:11px;font-family:var(--hp-font-mono);color:var(--hp-text-muted);text-transform:uppercase">Active Tab Inspection</div>

                  <div class="hp-status-card-mini">
                    <div class="hp-status-item-label">Target URL</div>
                    <div style="font-size:12px;color:#FAFAFA;word-break:break-all;font-family:var(--hp-font-mono)">https://portal.isro.gov.in/research</div>
                  </div>

                  <div class="hp-status-card-mini">
                    <div class="hp-status-item-label">Privacy Receipt</div>
                    <div style="font-size:12px;color:var(--hp-accent);font-family:var(--hp-font-mono)">0 raw secrets exposed</div>
                  </div>

                  <div class="hp-status-card-mini">
                    <div class="hp-status-item-label">Destination Check</div>
                    <div style="font-size:12px;color:#4ade80;font-family:var(--hp-font-mono)">Deterministic Match</div>
                  </div>
                </div>
              </div>

              <div class="hp-visual-caption">
                <span>Interactive Agent Application operates at /app with full Chrome Extension integration</span>
                <span>Preview Mode — No execution dispatched from marketing view</span>
              </div>
            </div>
          </div>
        </section>

        <!-- =================================================================
             SECTION 7 — EVALUATION
             ================================================================= -->
        <section class="hp-section" id="evaluation">
          <div class="hp-container">
            <div class="hp-section-header">
              <span class="hp-section-eyebrow">VERIFIED BENCHMARKS</span>
              <h2 class="hp-section-title">Built to be tested, not just trusted.</h2>
              <p class="hp-section-subtitle">
                Rigorous empirical validation across synthetic suites, controlled fixtures, and live browser environments.
              </p>
            </div>

            <!-- Verified Metrics Grid -->
            <div class="hp-metrics-grid">
              <div class="hp-metric-card">
                <div class="hp-metric-num">3,031</div>
                <div class="hp-metric-label">Frontend & Extension Tests</div>
                <div class="hp-metric-sub">176 test files · 100% passing (Vitest)</div>
              </div>

              <div class="hp-metric-card">
                <div class="hp-metric-num">672</div>
                <div class="hp-metric-label">Backend Pipeline Tests</div>
                <div class="hp-metric-sub">22 test modules · 100% passing (Pytest)</div>
              </div>

              <div class="hp-metric-card">
                <div class="hp-metric-num">0 bytes</div>
                <div class="hp-metric-label">Raw Secrets Transmitted</div>
                <div class="hp-metric-sub">Zero PII egress across reasoning boundaries</div>
              </div>

              <div class="hp-metric-card">
                <div class="hp-metric-num">100%</div>
                <div class="hp-metric-label">Action Validation Grounding</div>
                <div class="hp-metric-sub">Every dispatched click mapped to live DOM element</div>
              </div>
            </div>

            <!-- Controlled Fixtures Breakdown -->
            <div class="hp-eval-fixtures-grid">
              <div class="hp-fixture-card">
                <span class="hp-fixture-tag">SYNTHETIC SUITE</span>
                <h3 class="hp-fixture-title">Synthetic Banking Portal</h3>
                <p class="hp-fixture-desc">
                  Simulates multi-field authentication, beneficiary management, and high-risk monetary transfers with on-device redaction of PINs and account numbers.
                </p>
              </div>

              <div class="hp-fixture-card">
                <span class="hp-fixture-tag">CONTROLLED FIXTURE</span>
                <h3 class="hp-fixture-title">E-Commerce Checkout Flow</h3>
                <p class="hp-fixture-desc">
                  Validates dynamic form completion, shipping address masking, and cart interactions with zero exfiltration of user payment credentials.
                </p>
              </div>

              <div class="hp-fixture-card">
                <span class="hp-fixture-tag">LIVE BROWSER RUNTIME</span>
                <h3 class="hp-fixture-title">Chrome MV3 Grounding</h3>
                <p class="hp-fixture-desc">
                  Real Chrome extension execution utilizing native tab messaging, visual OCR bounding coordinates, and deterministic post-condition verification.
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- =================================================================
             SECTION 8 — FINAL CTA
             ================================================================= -->
        <section class="hp-cta-section">
          <div class="hp-container hp-cta-inner">
            <h2 class="hp-cta-title">Give your browser agent a boundary.</h2>
            <p class="hp-cta-desc">
              Explore the architecture behind privacy-preserving browser automation.
            </p>
            <div class="hp-cta-buttons">
              <button class="hp-btn hp-btn-primary hp-launch-btn" id="hp-final-launch-btn">
                <span>Launch PrivAgent</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                  <polyline points="12 5 19 12 12 19"></polyline>
                </svg>
              </button>
              <a href="https://github.com/akashgoudsidduluri/PrivAgent" target="_blank" rel="noopener noreferrer" class="hp-btn hp-btn-secondary">
                <span>View on GitHub</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <!-- =================================================================
           SECTION 9 — FOOTER
           ================================================================= -->
      <footer class="hp-footer">
        <div class="hp-container">
          <div class="hp-footer-grid">
            <div>
              <div class="hp-brand" style="margin-bottom: 16px;">
                <div class="hp-logo-mark" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
                    <path d="M16 3L4 8V16C4 23.5 9.1 30.5 16 32C22.9 30.5 28 23.5 28 16V8L16 3Z" stroke="#FE750E" stroke-width="2.2" stroke-linejoin="round"/>
                    <circle cx="16" cy="16" r="5" stroke="#FAFAFA" stroke-width="1.8"/>
                  </svg>
                </div>
                <span class="hp-brand-name">PrivAgent</span>
              </div>
              <p class="hp-body-text" style="font-size: 14px; max-width: 320px; color: var(--hp-text-muted);">
                Autonomous privacy-first browser agent built for Smart India Hackathon 2026, ISRO Problem Statement 26171.
              </p>
            </div>

            <div>
              <div class="hp-footer-col-title">Navigation</div>
              <ul class="hp-footer-links">
                <li><a href="#product" class="hp-footer-link">Product</a></li>
                <li><a href="#architecture" class="hp-footer-link">Architecture</a></li>
                <li><a href="#security" class="hp-footer-link">Security</a></li>
                <li><a href="#evaluation" class="hp-footer-link">Evaluation</a></li>
              </ul>
            </div>

            <div>
              <div class="hp-footer-col-title">Resources</div>
              <ul class="hp-footer-links">
                <li><a href="https://github.com/akashgoudsidduluri/PrivAgent" target="_blank" rel="noopener noreferrer" class="hp-footer-link">GitHub Repository</a></li>
                <li><a href="#how-it-works" class="hp-footer-link">Pipeline Spec</a></li>
                <li><a href="#architecture" class="hp-footer-link">Security Perimeter</a></li>
              </ul>
            </div>

            <div>
              <div class="hp-footer-col-title">Hackathon & Problem Statement</div>
              <p style="font-size: 13px; color: var(--hp-text-secondary); margin: 0 0 8px 0;">
                Smart India Hackathon 2026
              </p>
              <p style="font-size: 12px; color: var(--hp-text-muted); font-family: var(--hp-font-mono); margin: 0;">
                ISRO Problem Statement: 26171
              </p>
              <div style="margin-top: 16px;">
                <button class="hp-btn hp-btn-secondary hp-launch-btn" style="padding: 8px 16px; font-size: 13px;">
                  Launch /app
                </button>
              </div>
            </div>
          </div>

          <div class="hp-footer-bottom">
            <span>© 2026 PrivAgent Team · Developed for ISRO Problem Statement 26171</span>
            <span>Reasoning proposes · The local runtime decides</span>
          </div>
        </div>
      </footer>
    `;
  }

  private setupInteractivity(): void {
    // 1. Wire all "Launch PrivAgent" buttons to route to /app
    const launchButtons = this.container.querySelectorAll<HTMLButtonElement>('.hp-launch-btn');
    launchButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        appRouter.navigate('/app');
      });
    });

    // 2. Wire smooth scroll anchors
    const anchorLinks = this.container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]');
    anchorLinks.forEach((anchor) => {
      anchor.addEventListener('click', (e) => {
        const href = anchor.getAttribute('href');
        if (!href || href === '#') return;
        const targetEl = this.container.querySelector(href);
        if (targetEl) {
          e.preventDefault();
          targetEl.scrollIntoView({ behavior: 'smooth' });
          if (this.isMobileMenuOpen) {
            this.toggleMobileMenu(false);
          }
        }
      });
    });

    // 3. Mobile menu toggle
    const mobileBtn = this.container.querySelector('#hp-mobile-toggle');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => {
        this.toggleMobileMenu(!this.isMobileMenuOpen);
      });
    }
  }

  private toggleMobileMenu(open: boolean): void {
    this.isMobileMenuOpen = open;
    const menuEl = this.container.querySelector('#hp-nav-links-menu');
    if (menuEl) {
      if (this.isMobileMenuOpen) {
        menuEl.classList.add('open');
      } else {
        menuEl.classList.remove('open');
      }
    }
  }
}
