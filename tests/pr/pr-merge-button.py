
import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
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
