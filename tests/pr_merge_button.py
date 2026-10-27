from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_JS = ROOT / "assets/workbench/picker.js"
SOURCE_CSS = ROOT / "assets/workbench/picker.css"


def test_pr_squash_merge_uses_labeled_button():
    source_js = SOURCE_JS.read_text()
    source_css = SOURCE_CSS.read_text()

    assert "sweetiebot-pr-squash-merge" in source_js
    assert "Squash and merge" in source_js
    assert "/Squash and Merge into main/i" in source_js
    assert ".sweetiebot-pr-squash-merge.action-label" in source_css
    assert "content: none !important;" in source_css
