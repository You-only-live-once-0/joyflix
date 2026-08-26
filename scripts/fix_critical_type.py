from pathlib import Path

path = Path('src/lib/downstream.ts')
text = path.read_text()
old = "const hasExactFirstPageMatch = results.some(\n      (result) =>"
new = "const hasExactFirstPageMatch = results.some(\n      (result: SearchResult) =>"
if text.count(old) != 1:
    raise SystemExit(f'expected one type-fix target, got {text.count(old)}')
path.write_text(text.replace(old, new, 1))
