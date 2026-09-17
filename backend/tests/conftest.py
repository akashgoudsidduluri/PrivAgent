"""
PrivAgent Backend Test Configuration.

Milestone 7: the production reasoner is Gemma via OpenRouter, which requires
an API key and network access. Automated tests run against the deterministic
mock reasoner so CI stays offline-safe. The real OpenRouter path is exercised
through mocked HTTP in test_reasoner.py.
"""
from __future__ import annotations

import os

# Must be set before app modules import backend.app.config.
os.environ["PRIVAGENT_REASONER"] = "mock"
os.environ["REASONER_PROVIDER"] = "mock"
os.environ["REASONER_FALLBACK_PROVIDER"] = ""

