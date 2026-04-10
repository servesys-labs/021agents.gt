#!/usr/bin/env bash
# E2E sandbox image capability suite (assistant-office profile).
# Verifies that the pre-baked image supports common personal-assistant workflows:
# docs, slides, spreadsheets, PDF pipelines, OCR, charts, and media basics.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${E2E_SANDBOX_IMAGE_TAG:-agentos-sandbox-assistant-office:e2e}"
SKIP_BUILD="${E2E_SANDBOX_SKIP_BUILD:-0}"
DOCKER_PLATFORM="${E2E_SANDBOX_DOCKER_PLATFORM:-linux/amd64}"

pass=0
fail=0
total=0

run_test() {
  local name="$1"
  total=$((total + 1))
  printf "  [%02d] %s ... " "$total" "$name"
}

mark_pass() {
  pass=$((pass + 1))
  echo "PASS"
}

mark_fail() {
  fail=$((fail + 1))
  echo "FAIL${1:+ — $1}"
  if [[ -f /tmp/e2e_sandbox_container.log ]]; then
    echo "    └─ container log tail:"
    tail -n 20 /tmp/e2e_sandbox_container.log | sed 's/^/       /'
  fi
}

run_in_container() {
  local cmd="$1"
  docker run --rm --platform "$DOCKER_PLATFORM" --entrypoint /bin/bash "$IMAGE_TAG" -lc "$cmd" >/tmp/e2e_sandbox_container.log 2>&1
}

echo "══════════════════════════════════════════════════════════════"
echo " Sandbox Image E2E (assistant-office)"
echo " Image tag: $IMAGE_TAG"
echo " Platform:  $DOCKER_PLATFORM"
echo "══════════════════════════════════════════════════════════════"
echo ""

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "Building sandbox image..."
  docker build --platform "$DOCKER_PLATFORM" -f "${REPO_ROOT}/deploy/sandbox.Dockerfile" "${REPO_ROOT}/deploy" -t "$IMAGE_TAG"
  echo ""
else
  echo "Skipping build (E2E_SANDBOX_SKIP_BUILD=1)"
  echo ""
fi

run_test "core binaries available (soffice/pandoc/tesseract/ffmpeg/pdftotext)"
if run_in_container "command -v soffice && command -v pandoc && command -v tesseract && command -v ffmpeg && command -v pdftotext >/dev/null"; then
  mark_pass
else
  mark_fail "missing required binary"
fi

run_test "python dependency imports"
if run_in_container "python3 - <<'PY'
mods = [
  'requests', 'httpx', 'orjson', 'pydantic', 'dateutil',
  'yaml', 'toml', 'jsonschema', 'markdown', 'jinja2',
  'docx', 'docxtpl', 'pypdf', 'reportlab', 'weasyprint', 'pdfplumber',
  'openpyxl', 'xlsxwriter', 'pyarrow',
  'bs4', 'lxml', 'matplotlib', 'seaborn', 'PIL',
  'pptx', 'rapidfuzz', 'babel', 'slugify', 'pytz', 'pydub', 'py7zr',
]
missing = []
for m in mods:
  try:
    __import__(m)
  except Exception:
    missing.append(m)
if missing:
  raise SystemExit('Missing imports: ' + ', '.join(missing))
print('ok')
PY"; then
  mark_pass
else
  mark_fail "one or more imports failed"
fi

run_test "artifact generation (docx/pptx/xlsx/chart/pdf)"
if run_in_container "python3 - <<'PY'
from pathlib import Path
from docx import Document
from pptx import Presentation
from openpyxl import Workbook
from reportlab.pdfgen import canvas
import matplotlib.pyplot as plt

out = Path('/tmp/e2e-artifacts')
out.mkdir(parents=True, exist_ok=True)
marker = 'assistant-office-e2e'

doc = Document()
doc.add_heading('E2E Office Document', 1)
doc.add_paragraph(f'Marker: {marker}')
doc.save(out / 'sample.docx')

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = 'E2E Slide'
slide.placeholders[1].text = f'Marker: {marker}'
prs.save(out / 'sample.pptx')

wb = Workbook()
ws = wb.active
ws.title = 'Data'
ws.append(['item', 'value'])
ws.append(['marker', marker])
wb.save(out / 'sample.xlsx')

plt.figure()
plt.plot([1, 2, 3], [2, 4, 6])
plt.title('E2E Chart')
plt.savefig(out / 'chart.png')
plt.close()

pdf = canvas.Canvas(str(out / 'sample.pdf'))
pdf.drawString(72, 720, f'E2E PDF Marker: {marker}')
pdf.save()

for f in ['sample.docx', 'sample.pptx', 'sample.xlsx', 'chart.png', 'sample.pdf']:
  p = out / f
  if not p.exists() or p.stat().st_size <= 0:
    raise SystemExit(f'Artifact missing or empty: {f}')
print('ok')
PY"; then
  mark_pass
else
  mark_fail "artifact creation failed"
fi

run_test "pandoc markdown -> docx conversion"
if run_in_container "mkdir -p /tmp/e2e-artifacts
cat > /tmp/e2e-artifacts/input.md <<'MD'
# E2E Markdown

This is a conversion test for assistant-office profile.
MD
pandoc /tmp/e2e-artifacts/input.md -o /tmp/e2e-artifacts/from_markdown.docx
python3 - <<'PY'
from pathlib import Path
p = Path('/tmp/e2e-artifacts/from_markdown.docx')
raise SystemExit(0 if p.exists() and p.stat().st_size > 0 else 1)
PY"; then
  mark_pass
else
  mark_fail "pandoc conversion failed"
fi

run_test "libreoffice headless docx -> pdf conversion"
if run_in_container "mkdir -p /tmp/e2e-artifacts
python3 - <<'PY'
from docx import Document
d = Document()
d.add_heading('E2E Doc', 0)
d.add_paragraph('office path works')
d.save('/tmp/e2e-artifacts/sample.docx')
PY
soffice --headless --convert-to pdf --outdir /tmp/e2e-artifacts /tmp/e2e-artifacts/sample.docx >/tmp/e2e-artifacts/soffice.log 2>&1
python3 - <<'PY'
from pathlib import Path
p = Path('/tmp/e2e-artifacts/sample.pdf')
raise SystemExit(0 if p.exists() and p.stat().st_size > 0 else 1)
PY"; then
  mark_pass
else
  mark_fail "libreoffice conversion failed"
fi

run_test "pdf text extraction (pdftotext + pypdf)"
if run_in_container "mkdir -p /tmp/e2e-artifacts
python3 - <<'PY'
from reportlab.pdfgen import canvas
c = canvas.Canvas('/tmp/e2e-artifacts/sample.pdf')
c.drawString(72, 720, 'E2E PDF Marker')
c.save()
PY
pdftotext /tmp/e2e-artifacts/sample.pdf - > /tmp/e2e-artifacts/sample.txt
python3 - <<'PY'
from pathlib import Path
from pypdf import PdfReader
txt = Path('/tmp/e2e-artifacts/sample.txt').read_text(errors='ignore')
if 'E2E' not in txt:
  raise SystemExit('pdftotext output missing marker')
reader = PdfReader('/tmp/e2e-artifacts/sample.pdf')
content = ''.join((page.extract_text() or '') for page in reader.pages)
if 'E2E' not in content:
  raise SystemExit('pypdf extraction missing marker')
print('ok')
PY"; then
  mark_pass
else
  mark_fail "pdf extraction failed"
fi

run_test "ocr pipeline command (tesseract)"
if run_in_container "mkdir -p /tmp/e2e-artifacts
python3 - <<'PY'
from PIL import Image, ImageDraw
img = Image.new('RGB', (420, 120), color='white')
d = ImageDraw.Draw(img)
d.text((20, 40), 'E2E OCR TEST 123', fill='black')
img.save('/tmp/e2e-artifacts/ocr.png')
PY
tesseract /tmp/e2e-artifacts/ocr.png /tmp/e2e-artifacts/ocr_out >/tmp/e2e-artifacts/ocr.log 2>&1
python3 - <<'PY'
from pathlib import Path
p = Path('/tmp/e2e-artifacts/ocr_out.txt')
raise SystemExit(0 if p.exists() and p.stat().st_size > 0 else 1)
PY"; then
  mark_pass
else
  mark_fail "tesseract failed"
fi

run_test "media generation path (ffmpeg + pydub)"
if run_in_container "mkdir -p /tmp/e2e-artifacts
ffmpeg -f lavfi -i sine=frequency=1000:duration=1 -y /tmp/e2e-artifacts/tone.wav -loglevel error
python3 - <<'PY'
from pathlib import Path
from pydub import AudioSegment
p = Path('/tmp/e2e-artifacts/tone.wav')
if not p.exists() or p.stat().st_size <= 0:
  raise SystemExit('tone.wav missing')
audio = AudioSegment.from_wav(str(p))
if len(audio) < 900:
  raise SystemExit('audio too short')
print('ok')
PY"; then
  mark_pass
else
  mark_fail "ffmpeg/pydub failed"
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Results: $pass/$total passed, $fail failed"
echo "══════════════════════════════════════════════════════════════"

if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
