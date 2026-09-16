# PrivAgent — Evaluation Datasets & Methodology

## Overview

This directory contains the synthetic ground-truth benchmark datasets used to evaluate **PrivAgent's On-Device Sensitive Data Perception and Redaction Pipeline** under SIH / ISRO competitive criteria.

To satisfy data governance regulations (GDPR, DPDPA 2023, PCI-DSS v4.0), **zero real customer data** is stored in these datasets. All samples are synthetic, programmatically verified for syntax validity (e.g. Luhn algorithm for payment cards, official Income Tax Department regex for Indian PAN), and paired with diverse DOM markup contexts.

---

## Dataset Schema (`pii_benchmark_dataset.json` — Version 1.1.0)

The dataset contains **75 total labelled samples**:
* **50 Positive PII Cases**: 5 distinct test samples per sensitive entity class.
* **25 Negative Control Cases**: Common web entities that look like sensitive tokens but must NOT be redacted (avoiding false alarms and maintaining agent perception).

### Sensitive Entity Classes (50 Positive Cases)

| Category | Real-World Target | Format Variations Tested |
|---|---|---|
| `password` | Passwords, Passcodes, Master Keys | `<input type="password">`, credentials in text, passcode inputs |
| `otp` | 2FA / One-Time Verification Codes | 4-digit SMS codes, 6-digit banking OTPs, verification prompts |
| `cvv` | Card Verification Values / CVC | 3-digit Visa/MC CVV, 4-digit Amex CVC, back-of-card labels |
| `pan` | Indian Permanent Account Number | 10-character alphanumeric (`[A-Z]{5}[0-9]{4}[A-Z]{1}`) |
| `account_number` | Bank Account / Deposit Numbers | 9–18 digit sequences with checking/savings DOM contexts |
| `credit_card` | Payment Cards (Luhn Compliant) | Visa, Mastercard, Amex, Discover formatted & spaced |
| `email` | Electronic Mail Addresses | Standard, subdomain, plus-addressed, mixed-case |
| `phone` | Voice & SMS Numbers | E.164 (`+91`), US domestic `(555) 234-5678`, UK `+44`, raw 10-digit |
| `name` | Legal / Cardholder Full Names | Indian, Western, title-prefixed (`Dr.`, `M.`) |
| `address` | Physical Postal Addresses | Indian PIN addresses, US Street addresses with ZIP |

### Hard Negative Controls (25 Cases)

To evaluate **Specificity and False Positive Rate**, the dataset includes realistic web identifiers:
* **Order IDs**: `ORD-984210`, `ORDER #402-91823-19`
* **Invoices**: `INV-2026-0941`, `BILL/2026/MAR/004`
* **Flight Codes**: `AI-802`, `6E-2431`, `BA-178`
* **Currencies & Prices**: `₹1,499.00`, `$349.95`, `€128.50`, `₹45,000`
* **Timestamps**: `2026-09-16 08:30:00 UTC`, `16-Sep-2026 14:45 IST`, `2026-10-01T12:00:00.000Z`
* **Network Ports / IPs**: `5173`, `4173`, `8010`
* **Product SKUs**: `SKU-BAGGY-PANTS-BEIGE-M`, `ITEM-9981-RED`
* **Logistics Barcodes**: `TRK-981029381023`, `AWB-7749120`
* **Git Hashes & Hashes**: 40-char SHA-1 commit hashes, 64-char SHA-256 digests
* **Geographical Coordinates & Versions**: `18.5204 N, 73.8567 E`, `v2.14.0-rc3`

---

## Evaluation Metrics

PrivAgent evaluates performance using standard information retrieval metrics:

$$ \text{Precision} = \frac{TP}{TP + FP} $$

$$ \text{Recall} = \frac{TP}{TP + FN} $$

$$ \text{F1 Score} = 2 \cdot \frac{\text{Precision} \cdot \text{Recall}}{\text{Precision} + \text{Recall}} $$

Where:
* **True Positive ($TP$)**: Target sensitive entity correctly identified and redacted.
* **False Positive ($FP$)**: Negative control entity erroneously classified as sensitive.
* **False Negative ($FN$)**: Sensitive entity missed by both DOM scanner and OCR fallback.
* **True Negative ($TN$)**: Non-sensitive entity preserved intact for reasoning context.

---

## Running the Benchmark

```bash
npx tsx evaluation/scripts/run_sih_benchmark.ts
```

The runner produces a verified artifact at `evaluation/reports/sih_evaluation_report.json`.
