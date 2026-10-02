"""STEP 10.5 Part 6.8 — verify the model actually receives the improved
destination instruction, on the real production prompt builder."""
import json
import sys

sys.path.insert(0, "backend")

from app.reasoner import _build_user_prompt  # noqa: E402

prompt = _build_user_prompt(
    task="open the store catalog",
    url="http://localhost:4174/",
    viewport={"width": 1280, "height": 900},
    screenshot_dimensions=None,
    detections=[],
    history=[],
    steps_used=1,
    max_steps=5,
    page_type="UNKNOWN",
    semantic_context={
        "pageType": "UNKNOWN",
        "confidence": 0.1,
        "pageGeneration": 4,
        "affordances": [{
            "id": "a1", "type": "ENTER_QUERY",
            "targetElementId": "input-search-query",
            "requiresConfirmation": False,
            "description": "Input search keyword into query bar",
        }],
        "declaredDestination": {
            "provenance": "USER_DECLARED_DESTINATION",
            "role": ["LISTING"],
        },
    },
)

i = prompt.index("USER DECLARED DESTINATION")
j = prompt.index("Semantic Understanding")
print(prompt[i:j])
print("=" * 78)

checks = {
    "heading present": "USER DECLARED DESTINATION" in prompt,
    "G6 guardrail kept": "observation, not user intent" in prompt,
    "G6 arrival guard kept": "never treat this declaration as evidence that you have arrived" in prompt,
    "new: names the role": "semantic role is LISTING" in prompt,
    "new: tells it to act": "the one action that most moves you toward that" in prompt,
    "new: query route": "fill it in and submit it" in prompt,
    "new: no scroll instead of acting": "do not scroll in place of acting" in prompt,
    "new: role is not a URL": "never" in prompt and "invent, guess or hardcode a URL" in prompt,
    "new: verifier is authority": "only it can mark the destination reached" in prompt,
    "no fixture path anywhere": "results.html" not in prompt and "search.html" not in prompt,
    "no fixture label anywhere": "Browse Catalog" not in prompt and "Shop Now" not in prompt,
}
for k, v in checks.items():
    print(f"  [{'OK ' if v else 'FAIL'}] {k}")
print()
print("ALL PASS" if all(checks.values()) else "SOME FAILED")
