from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_JS = ROOT / "assets/workbench/picker.js"
BUNDLED_JS = ROOT / "Sweetiebot Installer.app/Contents/Resources/toolkit/assets/workbench/picker.js"
SOURCE_CSS = ROOT / "assets/workbench/picker.css"
BUNDLED_CSS = ROOT / "Sweetiebot Installer.app/Contents/Resources/toolkit/assets/workbench/picker.css"


def test_pr_squash_merge_uses_labeled_button():
    source_js = SOURCE_JS.read_text()
    bundled_js = BUNDLED_JS.read_text()
    source_css = SOURCE_CSS.read_text()
    bundled_css = BUNDLED_CSS.read_text()

    assert source_js == bundled_js
    assert source_css == bundled_css
    assert "sweetiebot-pr-squash-merge" in source_js
    assert "Squash and merge" in source_js
    assert "/Squash and Merge into main/i" in source_js
    assert ".sweetiebot-pr-squash-merge.action-label" in source_css
    assert "content: none !important;" in source_css
