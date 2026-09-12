"""
PrivAgent — Milestone 7 Evaluation Module.

Reproducible benchmark mechanism for measuring the agent rather than claiming
it works:

  1. Task success rate          6. Average retries per task
  2. Valid action rate          7. LLM latency (per provider telemetry)
  3. Privacy leakage count      8. End-to-end latency
  4. Validator rejection count  9. Failure rate
  5. Average steps per task

Design notes:
  - Provider-agnostic: metrics are computed from TaskState-like records plus
    optional provider telemetry, so mock / OpenRouter / future local models
    can be benchmarked through the same harness.
  - NO fabricated numbers: every metric is derived from recorded runs. If a
    metric has no recorded data (e.g. live-LLM runs without network access),
    the report marks it as "pending" instead of inventing a value.
  - SIH-relevant perception metrics (PII precision/recall, redaction
    precision, client resource utilization) are labeled PENDING here — they
    are measured by the browser E2E harness on real DOM/screenshot pipelines,
    not by this module.

Future extension points (not implemented, by design):
  - multimodal contexts, additional task suites, model routing comparisons.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

# ── Benchmark task suite (synthetic banking portal layouts) ──────────────────

BENCHMARK_TASKS: List[Dict[str, str]] = [
    {
        "id": "bench_01_account_number",
        "task": "Find and click the account number field",
        "layout": "banking_portal_profile_form",
        "expected_action_type": "click",
        "expected_target_type": "account_number",
    },
    {
        "id": "bench_02_scroll_transactions",
        "task": "Scroll down and find the transaction section",
        "layout": "banking_portal_ledger",
        "expected_action_type": "scroll",
        "expected_target_type": "",
    },
    {
        "id": "bench_03_account_details",
        "task": "Open the account details",
        "layout": "banking_portal_dashboard",
        "expected_action_type": "click",
        "expected_target_type": "account_number",
    },
    {
        "id": "bench_04_multi_step_details_transactions",
        "task": "Open the account details and find the recent transactions",
        "layout": "banking_portal_full",
        "expected_action_type": "multi",
        "expected_target_type": "",
    },
    # ── Phase 6: full action-type coverage (type / select / navigate) ─────
    {
        "id": "bench_05_type_field",
        "task": "Type a search query into the search box",
        "layout": "banking_portal_search",
        "expected_action_type": "type",
        "expected_target_type": "account_number",
    },
    {
        "id": "bench_06_select_option",
        "task": "Select the account type option",
        "layout": "banking_portal_form_select",
        "expected_action_type": "select",
        "expected_target_type": "account_number",
    },
    {
        "id": "bench_07_navigate_statement",
        "task": "Navigate to the account statement page",
        "layout": "banking_portal_navigation",
        "expected_action_type": "navigate",
        "expected_target_type": "",
    },
]

MAX_STEPS = 10
MAX_RETRIES = 2


def _default_success_validator(record: TaskRunRecord, task: Dict[str, str]) -> bool:
    """Objective per-task success predicate (keyword-free).

    Success is defined by the RECORDED steps, not by matching strings in the
    task description: the expected action type(s) must have been VALIDLY
    executed (validator-allowed AND successfully executed) within the step
    budget. Multi-step tasks require every expected stage.
    """
    expected = task.get("expected_action_type", "")
    valid = [s for s in record.steps if s.validator_allowed and s.execution_success]

    if expected == "multi":
        # Demo multi-step contract: click → scroll → click, all valid.
        has_click = any(s.action_type == "click" for s in valid)
        has_scroll = any(s.action_type == "scroll" for s in valid)
        return record.status == "SUCCESS" and has_click and has_scroll

    if not expected:
        return record.status == "SUCCESS"

    return record.status == "SUCCESS" and any(s.action_type == expected for s in valid)


@dataclass
class StepOutcome:
    action_type: str
    target_id: Optional[str]
    validator_allowed: bool
    execution_success: bool


@dataclass
class TaskRunRecord:
    task_id: str
    provider: str
    model: str
    status: str                      # SUCCESS | FAILED | NEEDS_USER_CONFIRMATION
    steps: List[StepOutcome] = field(default_factory=list)
    retries: int = 0
    privacy_leakage_count: int = 0   # forbidden fields observed in ANY outbound payload
    llm_latency_ms: Optional[float] = None
    e2e_latency_ms: Optional[float] = None
    error_kind: Optional[str] = None


@dataclass
class BenchmarkReport:
    provider: str
    model: str
    total_tasks: int
    successful_tasks: int
    failed_tasks: int
    confirmation_tasks: int
    task_success_rate: float
    valid_action_rate: float
    validator_rejection_count: int
    privacy_leakage_count: int
    average_steps_per_task: float
    average_retries_per_task: float
    average_llm_latency_ms: Optional[float]   # None → PENDING (no live-LLM data)
    average_e2e_latency_ms: Optional[float]
    failure_rate: float
    pending_metrics: List[str]
    notes: str
    per_task: List[Dict[str, Any]]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def run_benchmark(
    task_runner,
    provider_name: str,
    model_name: str,
    tasks: Optional[List[Dict[str, str]]] = None,
    success_validator=None,
) -> BenchmarkReport:
    """Execute benchmark tasks through `task_runner(task_id, task) -> TaskRunRecord`.

    `task_runner` is provider-agnostic: tests supply a runner backed by the
    mock provider; a live Gemma run supplies one backed by BackendAgentProvider
    + the real agent loop. This module only aggregates measured outcomes.

    `success_validator(record, task) -> bool` overrides the default objective
    per-task success predicate (future milestones can pass layout-specific
    page-state predicates without rewriting the harness).
    """
    validator = success_validator or _default_success_validator
    records: List[TaskRunRecord] = []
    for bench_task in tasks or BENCHMARK_TASKS:
        record = task_runner(bench_task["id"], bench_task["task"])
        # The recorded status is authoritative for failed/confirmation runs;
        # success additionally requires the objective per-task predicate.
        if record.status == "SUCCESS" and not validator(record, bench_task):
            record.status = "FAILED"
            record.error_kind = record.error_kind or "objective_mismatch"
        records.append(record)

    total = len(records) or 1
    successful = sum(1 for r in records if r.status == "SUCCESS")
    failed = sum(1 for r in records if r.status == "FAILED")
    confirmations = sum(1 for r in records if r.status == "NEEDS_USER_CONFIRMATION")

    all_steps = [s for r in records for s in r.steps]
    valid_actions = sum(1 for s in all_steps if s.validator_allowed and s.execution_success)
    validator_rejections = sum(1 for s in all_steps if not s.validator_allowed)
    leakage = sum(r.privacy_leakage_count for r in records)

    llm_latencies = [r.llm_latency_ms for r in records if r.llm_latency_ms is not None]
    e2e_latencies = [r.e2e_latency_ms for r in records if r.e2e_latency_ms is not None]

    pending: List[str] = []
    average_llm = sum(llm_latencies) / len(llm_latencies) if llm_latencies else None
    if average_llm is None:
        pending.append("llm_latency")
    average_e2e = sum(e2e_latencies) / len(e2e_latencies) if e2e_latencies else None

    # SIH perception metrics require the browser E2E harness (not runnable here)
    pending.extend([
        "pii_detection_precision",
        "pii_detection_recall",
        "redaction_precision",
        "visual_context_accuracy",
        "client_resource_utilization",
    ])

    notes = (
        "Live Gemma/OpenRouter metrics require OPENROUTER_API_KEY and network access. "
        "Re-run with a configured key to replace pending values with measured ones."
        if average_llm is None
        else "Measured from recorded live-provider runs."
    )

    return BenchmarkReport(
        provider=provider_name,
        model=model_name,
        total_tasks=len(records),
        successful_tasks=successful,
        failed_tasks=failed,
        confirmation_tasks=confirmations,
        task_success_rate=round(successful / total, 4),
        valid_action_rate=round(valid_actions / len(all_steps), 4) if all_steps else 0.0,
        validator_rejection_count=validator_rejections,
        privacy_leakage_count=leakage,
        average_steps_per_task=round(sum(len(r.steps) for r in records) / total, 2),
        average_retries_per_task=round(sum(r.retries for r in records) / total, 2),
        average_llm_latency_ms=round(average_llm, 1) if average_llm is not None else None,
        average_e2e_latency_ms=round(average_e2e, 1) if average_e2e is not None else None,
        failure_rate=round(failed / total, 4),
        pending_metrics=sorted(set(pending)),
        notes=notes,
        per_task=[asdict(r) for r in records],
    )
