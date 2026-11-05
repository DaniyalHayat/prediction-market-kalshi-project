from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import unicodedata
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import PageBreak, Spacer
from reportlab.platypus.tableofcontents import TableOfContents
import build_research_audit as audit

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / "web"
original_text = audit.text


def ascii_text(value):
    value = str(value)
    replacements = {"✓": "[x]", "☑": "[x]", "☐": "[ ]", "√": "sqrt", "η": "eta", "γ": "gamma", "κ": "kappa", "λ": "lambda", "σ": "sigma", "μ": "mu", "α": "alpha", "β": "beta", "δ": "delta", "τ": "tau", "θ": "theta", "ρ": "rho", "ε": "epsilon", "π": "pi", "Δ": "Delta", "Σ": "sum", "Φ": "Phi", "²": "^2", "³": "^3", "≤": "<=", "≥": ">=", "×": "x", "·": " * ", "→": " -> ", "∞": "infinity", "−": "-", "—": " - ", "–": "-", "‑": "-", "’": "'", "“": '"', "”": '"', "§§": "sections ", "§": "section ", "≈": "~", "\u202a": "", "\u202c": ""}
    for source, target in replacements.items():
        value = value.replace(source, target)
    return original_text(unicodedata.normalize("NFKD", value).encode("ascii", "replace").decode("ascii"))


audit.text = ascii_text
P = audit.P


def build(destination, public_copy=None):
    result_path = REPO / "review/execution-research-validation.json"
    results = json.loads(result_path.read_text(encoding="utf-8"))
    documents = [
        ("Implementation and verification", REPO / "docs/IMPLEMENTATION_VERIFICATION.md"),
        ("Execution model, equations and validation", REPO / "docs/EXECUTION_RESEARCH.md"),
        ("Database correctness and production evidence", REPO / "docs/postgres-query-hardening.md"),
        ("Database A/B experiment", REPO / "docs/query-optimization-benchmark.md"),
        ("Research source coverage and gap analysis", REPO / "docs/quant-research-source-ledger.md"),
    ]
    for _, path in documents:
        if not path.exists():
            raise FileNotFoundError(path)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    contents = TableOfContents()
    contents.levelStyles = [audit.styles["ContentsAudit"]]
    latency = results["latency"]
    story = [Spacer(1, 20), P("Predictir", "TitleAudit"), P("Execution research and database audit", "H1Audit"),
             P("November 4, 2026 | America/New_York"),
             P("This supplement records the pre-release verification of the execution model and database changes. Production rollout and subsequent checks are documented separately."),
             P("The new model studies execution cost, quote dynamics and inventory risk. It preserves the independent event-outcome forecast. Established research motivates each component; this report documents the actual implementation, measured experiments and remaining empirical gaps."),
             audit.table([["Evidence", "What the measurement establishes"],
                          ["32 category cases", "Synthetic adapters cover eight categories, both sides and both actions; they do not validate category-specific forecasts."],
                          ["Five toggle ablations", "Each switch changes its named numerical computation. Unchanged independent settlement probabilities are checked."],
                          ["Quote-signal controls", "Planted and null synthetic processes test the local fit/holdout gates; they are not market returns."],
                          ["Stock simulations", "Three separate 10,000-path liquidation scenarios compare execution cost/risk using common random paths; no profitable stock strategy is claimed."],
                          ["Local CPU benchmark", f"512 synthetic quote events: p50 {latency['p50_ms']:.3f} ms; p95 {latency['p95_ms']:.3f} ms over {latency['trials']} measured trials. Excludes network, browser and exchange time."]], [126, 402]),
             Spacer(1, 12), P("Repository HEAD at render " + revision, "SmallAudit"),
             P("The accompanying research audit covers the broader market workbench. This supplement focuses on equations, experiments, implementation checks, and database findings.", "SmallAudit"),
             PageBreak(), P("Contents", "H1Audit"), contents,
             PageBreak(), P("Inspectable switch comparisons", "H1Audit"),
             P("These ablations use a seeded synthetic process with a planted quote signal and arrival clustering. They demonstrate working controls under stated conditions. A live contract without sufficient aligned observations correctly withholds those fitted adjustments."),
             audit.table([["Switch", "Measured output", "On", "Off"], *[[row["feature"], row["metric"], f"{row['on']:.8g}", f"{row['off']:.8g}"] for row in results["toggle_ablations"]]], [100, 230, 99, 99]),
             P("All switches preserve the supplied independent settlement probability. A failed quote-model gate does not force a different forecast merely to make a toggle appear active. The schedule's objective includes a chosen risk preference; an objective reduction is not an expected profit or a latency improvement.")]
    for title, path in documents:
        audit.section_document(story, title, path)
    inputs = [result_path, REPO / "review/quant-research-sources.json", *[path for _, path in documents], BASE / "lib/workspace/execution-research.mjs", BASE / "lib/workspace/microstructure-model.mjs", BASE / "lib/workspace/execution-service.mjs", BASE / "lib/cloud/microstructure-window.mjs", BASE / "lib/cloud/feed.mjs", BASE / "tools/validate_execution_research.mjs", BASE / "tools/build_execution_audit.py", BASE / "tools/build_research_audit.py", BASE / "tools/report-requirements.txt"]
    input_records = [
        {
            "path": path.relative_to(REPO).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest(),
        }
        for path in inputs
    ]
    story += [PageBreak(), P("Input hashes and regeneration", "H1Audit"),
              P("Install the pinned dependencies from web/tools/report-requirements.txt, then run python web/tools/build_execution_audit.py from the repository. Use --output and --public-copy to select output paths."),
              P("The hashes cover the source documents, code, and numerical fixtures with LF line endings. See the separate production verification for deployment evidence."),
              audit.table([["Input", "SHA-256"], *[[item["path"], item["sha256"]] for item in input_records]], [225, 303])]
    destination.parent.mkdir(parents=True, exist_ok=True)
    document = audit.AuditDocTemplate(str(destination), pagesize=letter, rightMargin=42, leftMargin=42, topMargin=43, bottomMargin=42, title="Predictir - Execution research and database audit", author="Predictir", pageCompression=1)

    def decorate(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#cccccc"))
        canvas.line(42, 30, 570, 30)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(42, 19, "Predictir | Pre-release research verification")
        canvas.drawRightString(570, 19, str(doc.page))
        canvas.restoreState()

    document.multiBuild(story, onFirstPage=decorate, onLaterPages=decorate)
    manifest = {
        "classification": "local_review_supplement_not_production_verification",
        "source_revision": revision,
        "pages": document.page,
        "reportlab_version": audit.REPORTLAB_VERSION,
        "pdf_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "input_line_endings": "LF",
        "inputs": input_records,
    }
    destination.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if public_copy:
        public_copy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(destination, public_copy)
    print(json.dumps({"path": str(destination.resolve()), "pages": document.page, "sha256": manifest["pdf_sha256"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=REPO / "output/pdf/Predictir_Execution_Research_Audit.pdf")
    parser.add_argument("--public-copy", type=Path)
    args = parser.parse_args()
    build(args.output, args.public_copy)
