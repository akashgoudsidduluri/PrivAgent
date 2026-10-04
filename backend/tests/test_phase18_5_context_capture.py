"""
PHASE 18.5 / TIER 1.3 — capture instrumentation is OBSERVATION, not change.

The single most important property of the capture is that it does not alter
the model-facing prompt. If instrumentation could change what the LLM sees,
every Tier 1.3 conclusion drawn from it would be unsound.

These tests pin:
  * the prompt is byte-for-byte identical with capture OFF and capture ON;
  * capture writes nothing at all when PRIVAGENT_CAPTURE_DIR is unset;
  * a capture failure can never break a live reasoning call;
  * the privacy self-check actually detects what it claims to detect;
  * the privacy self-check reports rawScreenshotsTransmitted = 0 for a normal
    payload and flags one that carries image data.
"""
import os

import pytest


def _prompt():
    from app.reasoner import _build_user_prompt

    return _build_user_prompt(
        "open store catalog",
        "http://localhost:4174/",
        {"width": 1280, "height": 800},
        None,
        [],
        [],
        0,
        10,
        "LISTING",
        None,
    )


def test_prompt_is_identical_with_capture_off(monkeypatch):
    monkeypatch.delenv("PRIVAGENT_CAPTURE_DIR", raising=False)
    baseline = _prompt()

    monkeypatch.setenv("PRIVAGENT_CAPTURE_DIR", "/tmp/should_not_be_read")
    with_capture = _prompt()

    assert with_capture == baseline, (
        "capture must not alter a single character of the model-facing prompt"
    )


def test_capture_writes_nothing_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("PRIVAGENT_CAPTURE_DIR", raising=False)
    from app.context_capture import write_capture

    assert write_capture("t", {}, None) is None


def test_capture_records_the_exact_prompt_when_enabled(monkeypatch, tmp_path):
    from app import context_capture

    monkeypatch.setenv("PRIVAGENT_CAPTURE_DIR", str(tmp_path))
    context_capture.take_prompt()  # clear
    expected = _prompt()

    path = context_capture.write_capture(
        task="open store catalog",
        envelope={"task": "open store catalog"},
        prompt_bundle=context_capture.take_prompt(),
    )
    assert path is not None
    import json

    artifact = json.load(open(path))
    assert artifact["exactModelFacingPrompt"] == expected
    # Bound to the envelope that produced it.
    assert artifact["requestEnvelope"]["task"] == "open store catalog"


def test_capture_failure_never_breaks_reasoning(monkeypatch):
    """An audit aid must not be able to fail a live reasoning call."""
    monkeypatch.setenv("PRIVAGENT_CAPTURE_DIR", "/proc/definitely/not/writable")
    # Prompt still builds and returns normally.
    assert isinstance(_prompt(), str)


def test_privacy_self_check_flags_nothing_on_a_clean_payload():
    from app.context_capture import privacy_self_check

    result = privacy_self_check("normal prompt text", {"url": "http://localhost:4174/"})
    assert result["clean"] is True
    assert result["rawScreenshotsTransmitted"] == 0


def test_privacy_self_check_detects_a_forbidden_key():
    from app.context_capture import privacy_self_check

    result = privacy_self_check('element {"textContent": "secret"}', {})
    assert result["clean"] is False
    assert "textContent" in result["forbiddenKeyMarkersFound"]


def test_privacy_self_check_detects_image_data_and_counts_it():
    from app.context_capture import privacy_self_check

    envelope = {"screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="}
    result = privacy_self_check("p", envelope)
    assert result["clean"] is False
    assert result["rawScreenshotsTransmitted"] > 0


def test_privacy_self_check_allows_dimension_only_metadata():
    """Dimensions are metadata, not pixels, and must NOT trip the check."""
    from app.context_capture import privacy_self_check

    envelope = {"screenshot_dimensions": {"width": 1265, "height": 757}}
    result = privacy_self_check("p", envelope)
    assert result["clean"] is True
    assert result["rawScreenshotsTransmitted"] == 0