from pathlib import Path
import argparse
import html
import json
import re
import subprocess
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.graphics.shapes import Drawing, Rect, String

BASE = Path(__file__).resolve().parents[1]
REPO = BASE.parent
SOURCES = [
    ("Stern: Brownian score-difference model", "https://www.stat.berkeley.edu/~aldous/157/Papers/stern.pdf"),
    ("Busseti, Ryu and Boyd: Risk-Constrained Kelly Gambling", "https://arxiv.org/abs/1603.06183"),
    ("Kull, Silva Filho and Flach: Beta calibration", "https://proceedings.mlr.press/v54/kull17a.html"),
    ("Chen and Guestrin: XGBoost", "https://arxiv.org/abs/1603.02754"),
    ("Guo et al.: On Calibration of Modern Neural Networks", "https://proceedings.mlr.press/v70/guo17a.html"),
    ("Gneiting and Raftery: Strictly Proper Scoring Rules", "https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf"),
    ("HRT: Machine Learning and AI", "https://www.hudsonrivertrading.com/machine-learning/"),
    ("HRT: SharedWorker framework for real-time trading views", "https://www.hudsonrivertrading.com/hrtbeat/hrtworker-a-sharedworker-framework/"),
    ("HRT: Engineering, latency and research scale", "https://www.hudsonrivertrading.com/hrtbeat/engineering-and-interviewing-at-hrt/"),
    ("Two Sigma: Scientific research and technology approach", "https://www.twosigma.com/"),
    ("Citadel: Alternative data research workflow", "https://www.citadel.com/careers/career-perspectives/real-people-real-impact-how-alternative-data-powers-investment-decisions-at-citadel/"),
    ("PostgreSQL 17: Index types", "https://www.postgresql.org/docs/17/indexes-types.html"),
    ("PostgreSQL 17: Partitioning", "https://www.postgresql.org/docs/17/ddl-partitioning.html"),
    ("W3C Trace Context", "https://www.w3.org/TR/trace-context/"),
    ("Supabase Realtime source", "https://github.com/supabase/realtime"),
    ("Supabase Broadcast", "https://supabase.com/docs/guides/realtime/broadcast"),
    ("Supabase Presence", "https://supabase.com/docs/guides/realtime/presence"),
    ("Supabase Postgres Changes", "https://supabase.com/docs/guides/realtime/postgres-changes"),
    ("Supabase Edge Function pricing", "https://supabase.com/docs/guides/functions/pricing"),
    ("Railway deployment regions", "https://docs.railway.com/deployments/regions"),
    ("Railway resource pricing", "https://docs.railway.com/reference/pricing/plans"),
    ("Vercel AI Gateway live model catalog", "https://ai-gateway.vercel.sh/v1/models"),
    ("Google Developer Program credit benefits", "https://developers.google.com/profile/help/benefits"),
    ("Eligible ChatGPT API-credit benefit", "https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions"),
    ("Vercel: ChatGPT API credits integration", "https://vercel.com/i/chatgpt-api-credits-ai-gateway"),
    ("Kalshi official leaderboard explanation", "https://help.kalshi.com/en/articles/13823809-leaderboard"),
    ("Kalshi public leaderboard", "https://kalshi.com/social/leaderboard"),
    ("Community winner-sample discussion, unverified hypotheses", "https://www.reddit.com/r/PredictionMarkets/comments/1wzo82n/i_pulled_the_100_biggest_winners_on_kalshi_over/"),
]

def text(value):
    value = str(value).replace("\u2014", " - ").replace("\u2013", "-").replace("\u2011", "-")
    value = value.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"').replace("\u2192", " -> ")
    safe = html.escape(value)
    safe = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<link href="\2" color="#3155a5">\1</link>', safe)
    safe = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", safe)
    return re.sub(r"`([^`]+)`", r'<font name="Courier" size="8.6">\1</font>', safe)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="BodyAudit", fontName="Helvetica", fontSize=11.2, leading=15.4, spaceAfter=8, textColor=colors.HexColor("#202a36")))
styles.add(ParagraphStyle(name="SmallAudit", parent=styles["BodyAudit"], fontSize=9.5, leading=12.4, spaceAfter=5))
styles.add(ParagraphStyle(name="TableAudit", parent=styles["BodyAudit"], fontSize=9.5, leading=12.8, spaceAfter=0))
styles.add(ParagraphStyle(name="TitleAudit", fontName="Helvetica-Bold", fontSize=29, leading=34, textColor=colors.HexColor("#111b2b"), spaceAfter=12))
styles.add(ParagraphStyle(name="H1Audit", fontName="Helvetica-Bold", fontSize=17, leading=22, spaceBefore=15, spaceAfter=10, keepWithNext=True))
styles.add(ParagraphStyle(name="H2Audit", fontName="Helvetica-Bold", fontSize=12.5, leading=17, spaceBefore=11, spaceAfter=6, keepWithNext=True))
P = lambda value, style="BodyAudit": Paragraph(text(value), styles[style])

def table(rows, widths, header=True):
    rendered = [[P(cell, "TableAudit") for cell in row] for row in rows]
    result = Table(rendered, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 7), ("RIGHTPADDING", (0,0), (-1,-1), 7),
                ("TOPPADDING", (0,0), (-1,-1), 7), ("BOTTOMPADDING", (0,0), (-1,-1), 7), ("LINEBELOW", (0,0), (-1,0), .8, colors.HexColor("#8da0b8"))]
    if header: commands += [("BACKGROUND", (0,0), (-1,0), colors.HexColor("#e7edf5"))]
    for index in range(1 if header else 0, len(rows)):
        if index % 2: commands.append(("BACKGROUND", (0,index), (-1,index), colors.HexColor("#f5f7fa")))
    result.setStyle(TableStyle(commands))
    return result

def append_markdown(story, path):
    lines = path.read_text(encoding="utf-8").splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line or line.startswith("# "):
            index += 1
            continue
        if line.startswith("|"):
            rows = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r"[-: ]+", cell) for cell in cells): rows.append(cells)
                index += 1
            columns = len(rows[0])
            widths = [135, 238, 155] if columns == 3 else [528 / columns] * columns
            story += [table(rows, widths), Spacer(1,10)]
            continue
        if line.startswith("## "):
            story.append(P(line[3:], "H1Audit"))
        elif line.startswith("### "):
            story.append(P(line[4:], "H2Audit"))
        elif line.startswith("- "):
            story.append(P("- " + line[2:]))
        else:
            paragraph = [line]
            while index+1 < len(lines) and lines[index+1].strip() and not lines[index+1].lstrip().startswith(("#", "|", "- ")):
                index += 1
                paragraph.append(lines[index].strip())
            story.append(P(" ".join(paragraph)))
        index += 1

def bars(label, values):
    drawing = Drawing(528, 117)
    drawing.add(String(0, 103, label, fontName="Helvetica-Bold", fontSize=11, fillColor=colors.HexColor("#202a36")))
    maximum = max(value for _,value in values)
    for i,(name,value) in enumerate(values):
        y = 69-i*36
        drawing.add(String(0,y+5,name,fontName="Helvetica",fontSize=9.5))
        drawing.add(Rect(147,y,max(1,value/maximum*290),20,fillColor=colors.HexColor("#354d75" if i==0 else "#7089ad"),strokeColor=None))
        drawing.add(String(447,y+5,f"{value:.6f}",fontName="Helvetica",fontSize=9.5))
    return drawing

def build(destination):
    nba=json.loads((BASE/"docs/nba-challenger-validation.json").read_text())
    live=json.loads((BASE/"docs/nba-inplay-validation.json").read_text())
    runtime=json.loads((BASE/"docs/runtime-benchmark.json").read_text())
    sizing=json.loads((BASE/"docs/sizing-benchmark.json").read_text())
    inference=json.loads((BASE/"docs/nba-inference-benchmark.json").read_text())
    try: revision=subprocess.check_output(["git","rev-parse","HEAD"],cwd=REPO,text=True).strip()
    except (OSError,subprocess.CalledProcessError): revision="Source checkout identified by the accompanying repository"
    story=[Spacer(1,20),P("Kalshi Market Lab", "TitleAudit"),P("Research, mathematics and engineering audit", "H1Audit"),
           P("November 4, 2026 | America/New_York"),P("Public research and paper trading at https://predictir.dev"),
           P("A source-backed account of the hypotheses tested, models trained, code shipped, costs considered and evidence still missing. This report covers independent project engineering and excludes employment verification."),
           table([["Evidence class","Meaning"],["Implemented","Code exists and is exercised by named tests or reproducible tools."],["Measured","A dated local fixture or held-out model result, with its scope stated."],["Experimental","A usable paper-research estimate whose statistical promotion gate has not passed."],["Not established","No claim is made for unavailable data, private trader motives or realized trading returns."]],[120,408]),
           Spacer(1,15),P("The notable mathematical addition is a tested composition of calibrated independent forecasts, fresh score-clock conditioning, executable depth, uncertainty-aware position decisions, a discrete risk constraint and an event-overlap graph. Established papers motivate the components; the project's own measurements evaluate this implementation."),
           P("Source revision available when the report was rendered: "+revision,"SmallAudit"),PageBreak(),P("Measured model comparisons","H1Audit"),
           bars("Pregame: lower Brier is better, same 514-game holdout",[("Team-strength baseline",nba["baseline"]["brier"]),("Selected challenger",nba["validation"]["brier"])]),
           P("The 1.554% relative Brier point improvement is observable. Its paired whole-week uncertainty interval includes zero, so the challenger remains an explicit experimental option rather than being silently promoted. The neural candidate was trained and its non-convergence retained in the record."),
           bars("In-play: separate 20-game / 60-quarter-state replay",[("Frozen pregame estimate",live["validation"]["baseline"]["brier"]),("Conditional live model",live["validation"]["brier"])]),
           P("The live replay is small and retrospective, with three correlated quarter states per game. Forty earlier calibration games estimate the score-process scale; twenty held-out games evaluate it. This does not establish a calibrated live-money advantage. The model also requires a current matched score and clock before it emits an in-play estimate."),
           P("In-play calculation", "H2Audit"),P("P(home win | margin L, elapsed fraction t) = Phi((L + mu*(1-t)) / (sigma*sqrt(1-t))). The independent pregame chance p0 supplies mu=sigma*Phi_inverse(p0). Sigma is estimated from historical calibration-game score increments. Current fitted sigma is "+f"{live['sigma']:.4f}"+" points, with a whole-game bootstrap sensitivity range "+f"[{live['sigma_interval'][0]:.4f}, {live['sigma_interval'][1]:.4f}]."),
           P("This regulation model omits possession, strategic fouling, live lineups and non-Gaussian endgame behavior. Missing scores are not zero; missing time is not inferred from the scheduled start. Overtime and unsupported boundaries are withheld. Current game state expires after 30 seconds; research caches use five seconds for in-play estimates. Source: Stern [1]; exact capture and replay files accompany the code."),
           P("Engineering measurements", "H1Audit"),
           table([["Operation","Measured result","Interpretation"],
                  ["Compiled ensemble",f"{inference['ensemble']['cached_residual_median_microseconds_per_score']:.3f} microseconds per cached score","Local CPU inference; excludes sources, network and rendering."],
                  ["Repeated fill sizing",f"{sizing['construction_median_ms']+sizing['prefix_median_ms']:.3f} ms including construction vs {sizing['reparse_median_ms']:.3f} ms","1,000 sizing queries on one synthetic 1,000-level book; cash-flow parity checked."],
                  ["Book broadcast",f"{runtime['book_snapshot']['all_levels_bytes']:,} to {runtime['book_snapshot']['top100_bytes']:,} bytes","Bounds displayed depth; retains full indexed source reconstruction and fresh REST execution."],
                  ["Schema and fanout","See runtime-benchmark.json and RUNTIME_RESEARCH.md","Contains query plans, concurrency, backpressure and negative partition results."]],[130,180,218]),
           P("The sizing curve parses and sorts the book once, builds quantity/notional/fee prefixes, then answers a quantity query by binary search. Construction is O(L log L) including sorting plus O(L) prefix work; subsequent fill queries are O(log L). This saves repeated parsing during sizing and risk enumeration. It is not a claim that the whole website became hundreds of times faster."),
           P("Audit and reproduction checklist","H1Audit"),
           P("Inspect the frozen source hashes and split dates; reproduce native model training; verify Python/JavaScript parity; run the PostgreSQL and pgTAP checks; replay the independent cash-flow tests; review the full runtime query plans; compare hosted latency before/after region changes; and inspect a paper entry, live mark, close and confirmed settlement. Use the deployment guide for private environment setup. Credentials and private journals are excluded from this report."),
           P("Pinned PDF regeneration: create a Python environment, install tools/report-requirements.txt, then run python tools/build_research_audit.py --output /chosen/path/Research_Audit.pdf. No bundled private runtime or proprietary document package is required."),PageBreak()]
    story.append(P("Feature-by-feature audit","H1Audit"))
    append_markdown(story,BASE/"docs/FEATURE_REVIEW.md")
    story += [PageBreak(),P("Research sources and what they contribute","H1Audit"),
              P("[1]-[6] supply score-process, allocation, calibration, tree/NN and proper-score methods. [7]-[11] supply first-party descriptions of quantitative research and systems practice; they do not disclose proprietary strategies or certify this app. [12]-[25] support implementation and pricing decisions. [26]-[28] support the public-trader evidence boundaries and hypotheses. Forum claims remain unverified and do not train the outcome models."),
              P("The broad search included first-party research-firm material, original papers, platform documentation and public community discussion. The report does not infer a top trader's private tools or claim access to proprietary HRT methods. A direct official leaderboard request was throttled; no rate-limit bypass or private-profile retrieval was used.")]
    for number,(title,url) in enumerate(SOURCES,1):
        story.append(P(f"[{number}] [{title}]({url})", "SmallAudit"))
    destination.parent.mkdir(parents=True,exist_ok=True)
    doc=SimpleDocTemplate(str(destination),pagesize=letter,rightMargin=42,leftMargin=42,topMargin=43,bottomMargin=42,title="Kalshi Market Lab - Research and engineering audit",author="Kalshi Market Lab",pageCompression=1)
    def decorate(canvas,document):
        canvas.saveState();canvas.setStrokeColor(colors.HexColor("#b7c3d3"));canvas.line(42,30,570,30);canvas.setFont("Helvetica",8);canvas.setFillColor(colors.HexColor("#536174"));canvas.drawString(42,19,"Kalshi Market Lab | Research audit | November 4, 2026");canvas.drawRightString(570,19,str(document.page));canvas.restoreState()
    doc.build(story,onFirstPage=decorate,onLaterPages=decorate)
    print(str(destination.resolve()))

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--output",type=Path,default=REPO/"output/pdf/Kalshi_Market_Lab_Research_Audit.pdf");args=parser.parse_args();build(args.output)
