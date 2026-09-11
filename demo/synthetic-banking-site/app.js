// Apex Horizon Bank — PrivAgent Interactive Demo Client
// Purely client-side demo logic with synthetic data.

document.addEventListener('DOMContentLoaded', () => {
  // Modal Elements
  const transferModal = document.getElementById('transfer-modal');
  const btnOpenTransfer = document.getElementById('btn-open-transfer');
  const btnQuickTransfer = document.getElementById('btn-quick-transfer');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const btnCancelTransfer = document.getElementById('btn-cancel-transfer');
  const transferForm = document.getElementById('transfer-form');

  // Password visibility toggle
  const btnTogglePass = document.getElementById('btn-toggle-pass');
  const inputPassword = document.getElementById('input-account-password');

  if (btnTogglePass && inputPassword) {
    btnTogglePass.addEventListener('click', () => {
      const isPass = inputPassword.type === 'password';
      inputPassword.type = isPass ? 'text' : 'password';
      btnTogglePass.textContent = isPass ? '🔒' : '👁️';
    });
  }

  // Open modal
  const openModal = () => {
    if (transferModal) {
      transferModal.classList.add('open');
    }
  };

  const closeModal = () => {
    if (transferModal) {
      transferModal.classList.remove('open');
    }
  };

  btnOpenTransfer?.addEventListener('click', openModal);
  btnQuickTransfer?.addEventListener('click', openModal);
  modalCloseBtn?.addEventListener('click', closeModal);
  btnCancelTransfer?.addEventListener('click', closeModal);

  // Close modal when clicking outside
  transferModal?.addEventListener('click', (e) => {
    if (e.target === transferModal) {
      closeModal();
    }
  });

  // Handle Transfer Submission
  transferForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const recipientInput = document.getElementById('transfer-recipient-name');
    const amountInput = document.getElementById('transfer-amount');
    const recipient = recipientInput && 'value' in recipientInput ? recipientInput.value : 'Beneficiary';
    const amountVal = amountInput && 'value' in amountInput ? amountInput.value : '0';
    const numAmount = parseFloat(amountVal);

    if (isNaN(numAmount) || numAmount <= 0) {
      alert('Please enter a valid transfer amount.');
      return;
    }

    // Prepend to transaction table
    const tableBody = document.getElementById('transaction-rows');
    if (tableBody) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="tx-title">IMPS Transfer to ${recipient}</div>
          <div class="tx-category">Immediate Payment</div>
        </td>
        <td>
          <span class="mono">${recipient}</span>
          <div class="tx-acc-meta">Synthetic Transfer Ref: #AHB-${Math.floor(100000 + Math.random() * 900000)}</div>
        </td>
        <td class="tx-date">Just now</td>
        <td><span class="badge badge-success">Completed</span></td>
        <td class="text-right tx-debit">-₹${numAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      `;
      tableBody.insertBefore(tr, tableBody.firstChild);
    }

    // Deduct from balance
    const balanceElem = document.getElementById('account-balance');
    if (balanceElem) {
      const current = 125000 - numAmount;
      balanceElem.textContent = `₹${current.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    }

    closeModal();
    transferForm.reset();
  });

  // Local Save Feedback
  const btnSaveProfile = document.getElementById('btn-save-profile');
  btnSaveProfile?.addEventListener('click', () => {
    const originalText = btnSaveProfile.textContent;
    btnSaveProfile.textContent = 'Saved In Local Memory!';
    btnSaveProfile.classList.add('badge-success');
    setTimeout(() => {
      btnSaveProfile.textContent = originalText;
      btnSaveProfile.classList.remove('badge-success');
    }, 2000);
  });
});
