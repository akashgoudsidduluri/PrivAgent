"""
PrivAgent Backend Tests — Milestone 7 Evaluation Harness.

Validates that the benchmark report:
  - aggregates measured outcomes correctly (success rate, valid action rate,
    validator rejections, privacy leakage, steps, retries, failure rate),
  - marks unmeasurable metrics as PENDING instead of fabricating values,
  - applies an OBJECTIVE per-task success predicate (recorded steps, not
    task-string matching),
  - covers all five action types (click/scroll/type/select/navigate),
  - serializes to JSON for reproducible artifacts.
"""
from __future__ import annotations

import json

from app.evaluation import (
    BENCHMARK_TASKS,
    StepOutcome,
    TaskRunRecord,
    run_benchmark,
)


def _mock_runner_factory():
    """A deterministic runner backed by measured mock outcomes.

    Mirrors what the real agent loop records, without any network access.
    """

    def runner(task_id: str, task: str) -> TaskRunRecord:
        if "multi" in task_id or "details and" in task:
            steps = [
                StepOutcome("click", "element_details", True, True),
                StepOutcome("scroll", None, True, True),
                StepOutcome("click", "element_transactions", True, True),
            ]
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=steps,
                retries=0,
                llm_latency_ms=0.0,
                e2e_latency_ms=12.0,
            )
        if "scroll" in task_id:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("scroll", None, True, True)],
                llm_latency_ms=0.0,
                e2e_latency_ms=4.0,
            )
        if "type" in task_id:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("type", "element_search", True, True)],
                llm_latency_ms=0.0,
                e2e_latency_ms=5.0,
            )
        if "select" in task_id:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("select", "element_account_select", True, True)],
                llm_latency_ms=0.0,
                e2e_latency_ms=5.0,
            )
        if "navigate" in task_id:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("navigate", None, True, True)],
                llm_latency_ms=0.0,
                e2e_latency_ms=6.0,
            )
        return TaskRunRecord(
            task_id=task_id,
            provider="mock",
            model="mock",
            status="SUCCESS",
            steps=[StepOutcome("click", "element_account_num", True, True)],
            llm_latency_ms=0.0,
            e2e_latency_ms=5.0,
        )

    return runner


class TestBenchmarkSuite:
    def test_all_action_types_covered(self):
        expected_types = {"click", "scroll", "type", "select", "navigate", "multi"}
        covered = {t["expected_action_type"] for t in BENCHMARK_TASKS}
        assert expected_types <= covered

    def test_all_benchmark_tasks_defined(self):
        assert len(BENCHMARK_TASKS) >= 7
        ids = [t["id"] for t in BENCHMARK_TASKS]
        assert len(ids) == len(set(ids))


class TestBenchmarkReport:
    def test_success_rate_and_valid_action_rate(self):
        report = run_benchmark(_mock_runner_factory(), provider_name="mock", model_name="mock")
        assert report.total_tasks == len(BENCHMARK_TASKS)
        assert report.successful_tasks == report.total_tasks
        assert report.task_success_rate == 1.0
        assert report.failure_rate == 0.0
        # All executed steps were valid
        assert report.valid_action_rate == 1.0
        assert report.validator_rejection_count == 0
        assert report.privacy_leakage_count == 0

    def test_multi_step_task_records_three_steps(self):
        report = run_benchmark(_mock_runner_factory(), provider_name="mock", model_name="mock")
        multi = next(
            t for t in report.per_task if t["task_id"] == "bench_04_multi_step_details_transactions"
        )
        assert len(multi["steps"]) == 3
        assert report.average_steps_per_task > 1

    def test_validator_rejections_and_leakage_are_counted(self):
        def runner(task_id: str, task: str) -> TaskRunRecord:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="FAILED",
                steps=[StepOutcome("click", "stale_element", False, False)],
                retries=3,
                privacy_leakage_count=1,
                error_kind="unknown_target",
            )

        report = run_benchmark(runner, provider_name="mock", model_name="mock")
        assert report.validator_rejection_count == len(BENCHMARK_TASKS)
        assert report.privacy_leakage_count == len(BENCHMARK_TASKS)
        assert report.task_success_rate == 0.0
        assert report.failure_rate == 1.0
        assert report.average_retries_per_task == 3.0

    def test_objective_predicate_fails_wrong_action_success(self):
        """A run marked SUCCESS whose recorded steps never performed the
        expected action type is demoted to FAILED (no string matching)."""

        def runner(task_id: str, task: str) -> TaskRunRecord:
            # bench_05 expects `type`; runner records only a scroll.
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("scroll", None, True, True)],
                llm_latency_ms=0.0,
                e2e_latency_ms=5.0,
            )

        report = run_benchmark(runner, provider_name="mock", model_name="mock")
        bench05 = next(t for t in report.per_task if t["task_id"] == "bench_05_type_field")
        assert bench05["status"] == "FAILED"
        assert bench05["error_kind"] == "objective_mismatch"
        # bench_02 legitimately expects scroll and still succeeds; bench_05 is demoted.
        assert report.successful_tasks == 1
        assert report.failure_rate == round(6 / len(BENCHMARK_TASKS), 4)

    def test_objective_predicate_accepts_correct_type_action(self):
        report = run_benchmark(_mock_runner_factory(), provider_name="mock", model_name="mock")
        bench05 = next(t for t in report.per_task if t["task_id"] == "bench_05_type_field")
        assert bench05["status"] == "SUCCESS"
        bench06 = next(t for t in report.per_task if t["task_id"] == "bench_06_select_option")
        assert bench06["status"] == "SUCCESS"
        bench07 = next(t for t in report.per_task if t["task_id"] == "bench_07_navigate_statement")
        assert bench07["status"] == "SUCCESS"

    def test_custom_success_validator_is_used(self):
        """Future milestones can pass layout-specific page-state predicates."""

        def validator(record: TaskRunRecord, task) -> bool:
            return len(record.steps) >= 2

        def runner(task_id: str, task: str) -> TaskRunRecord:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("click", "x", True, True)],
                llm_latency_ms=0.0,
                e2e_latency_ms=5.0,
            )

        report = run_benchmark(
            runner, provider_name="mock", model_name="mock", success_validator=validator
        )
        assert report.successful_tasks == 0  # only 1 step, validator requires 2

    def test_missing_llm_latency_is_pending_not_fabricated(self):
        def runner(task_id: str, task: str) -> TaskRunRecord:
            return TaskRunRecord(
                task_id=task_id,
                provider="mock",
                model="mock",
                status="SUCCESS",
                steps=[StepOutcome("click", "x", True, True)],
                llm_latency_ms=None,
                e2e_latency_ms=None,
            )

        report = run_benchmark(runner, provider_name="mock", model_name="mock")
        assert report.average_llm_latency_ms is None
        assert "llm_latency" in report.pending_metrics
        # SIH perception metrics always pending in this module (E2E measures them)
        assert "pii_detection_precision" in report.pending_metrics
        assert "pii_detection_recall" in report.pending_metrics
        assert "redaction_precision" in report.pending_metrics
        assert "visual_context_accuracy" in report.pending_metrics
        assert "client_resource_utilization" in report.pending_metrics

    def test_report_serializes_to_json(self):
        report = run_benchmark(_mock_runner_factory(), provider_name="mock", model_name="mock")
        parsed = json.loads(report.to_json())
        assert parsed["provider"] == "mock"
        assert "task_success_rate" in parsed
        assert parsed["total_tasks"] == len(BENCHMARK_TASKS)
