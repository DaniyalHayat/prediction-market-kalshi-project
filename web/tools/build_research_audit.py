from pathlib import Path
import argparse
import html
import hashlib
import json
import re
import shutil
import subprocess
from reportlab.lib import colors
from reportlab import Version as REPORTLAB_VERSION
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, CondPageBreak
from reportlab.platypus.tableofcontents import TableOfContents
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
    ("Kalman (1960): A New Approach to Linear Filtering and Prediction Problems", "https://doi.org/10.1115/1.3662552"),
    ("Rabiner (1989): A tutorial on hidden Markov models", "https://web.ece.ucsb.edu/Faculty/Rabiner/ece259/Reprints/tutorial%20on%20hmm%20and%20applications.pdf"),
    ("Howard et al.: Time-uniform Chernoff bounds via nonnegative supermartingales", "https://arxiv.org/abs/1808.03204"),
    ("Supabase: selected-ticker hybrid search methods", "https://supabase.com/docs/guides/ai/hybrid-search"),
    ("Hugging Face Transformers.js documentation", "https://huggingface.co/docs/transformers.js"),
    ("MiniLM: deep self-attention distillation", "https://arxiv.org/abs/2002.10957"),
    ("gRPC HTTP/2 protocol specification", "https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md"),
    ("Protocol Buffers encoding guide", "https://protobuf.dev/programming-guides/encoding/"),
    ("Vercel Drains: current export pricing and schemas", "https://vercel.com/docs/drains"),
    ("Supabase self-hosting scope and responsibilities", "https://supabase.com/docs/guides/self-hosting"),
    ("Supabase Docker requirements", "https://supabase.com/docs/guides/self-hosting/docker"),
    ("PostgreSQL release versioning policy", "https://www.postgresql.org/support/versioning/"),
    ("Supabase Wrappers: supported remote-system catalog", "https://github.com/supabase/wrappers/blob/main/README.md"),
    ("X API pricing", "https://docs.x.com/x-api/getting-started/pricing"),
    ("Reddit developer FAQ", "https://developers.reddit.com/docs/guides/faq"),
    ("Rotten Tomatoes score definitions", "https://www.rottentomatoes.com/about"),
    ("NBA official participation reports", "https://official.nba.com/nba-injury-report-2026-27-season"),
    ("Google Ads API access migration", "https://developers.google.com/google-ads/api/docs/api-policy/developer-token"),
    ("Ploy company-owned LinkedIn page; identity remains tentative", "https://www.linkedin.com/company/ploy-ai/"),
]

def text(value):
    value = str(value).replace("\u2014", " - ").replace("\u2013", "-").replace("\u2011", "-")
    value = value.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"').replace("\u2192", " -> ")
    replacements = {"\u2212":"-", "\u2264":"<=", "\u2265":">=", "\u00b1":"+/-", "\u00d7":"x", "\u0394":"Delta", "\u03a3":"sum", "\u03bb":"lambda", "\u03b1":"alpha", "\u03b2":"beta", "\u03bc":"mu", "\u03c3":"sigma", "\u03a6":"Phi", "\u221e":"infinity", "\u2013":"-", "\u2026":"...", "\u2022":"-", "\u2009":" ", "\u00a0":" "}
    for original, replacement in replacements.items(): value = value.replace(original, replacement)
    safe = html.escape(value)
    safe = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<link href="\2" color="#333333"><u>\1</u></link>', safe)
    safe = re.sub(r"\[([^\]]+)\]\((?!https?://)[^)]+\)", r"\1", safe)
    safe = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", safe)
    return re.sub(r"`([^`]+)`", r'<font name="Courier" size="8.6">\1</font>', safe)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="BodyAudit", fontName="Helvetica", fontSize=11.2, leading=15.4, spaceAfter=8, textColor=colors.HexColor("#262626")))
styles.add(ParagraphStyle(name="SmallAudit", parent=styles["BodyAudit"], fontSize=9.5, leading=12.4, spaceAfter=5))
styles.add(ParagraphStyle(name="TableAudit", parent=styles["BodyAudit"], fontSize=9.5, leading=12.8, spaceAfter=0))
styles.add(ParagraphStyle(name="TitleAudit", fontName="Helvetica-Bold", fontSize=29, leading=34, textColor=colors.HexColor("#171717"), spaceAfter=12))
styles.add(ParagraphStyle(name="H1Audit", fontName="Helvetica-Bold", fontSize=17, leading=22, spaceBefore=15, spaceAfter=10, keepWithNext=True))
styles.add(ParagraphStyle(name="H2Audit", fontName="Helvetica-Bold", fontSize=12.5, leading=17, spaceBefore=11, spaceAfter=6, keepWithNext=True))
styles.add(ParagraphStyle(name="H3Audit", parent=styles["H2Audit"], fontSize=11.2, leading=15.4, spaceBefore=9))
styles.add(ParagraphStyle(name="TableHeadingAudit", parent=styles["H2Audit"], keepWithNext=False))
styles.add(ParagraphStyle(name="ContentsAudit", parent=styles["BodyAudit"], fontSize=10.5, leading=14, spaceBefore=7, leftIndent=0, firstLineIndent=0))
styles.add(ParagraphStyle(name="FormulaAudit", parent=styles["SmallAudit"], fontName="Courier", fontSize=9.1, leading=13, spaceAfter=0))
P = lambda value, style="BodyAudit": Paragraph(text(value), styles[style])

class AuditDocTemplate(SimpleDocTemplate):
    def beforeDocument(self):
        self.heading_sequence=0

    def afterFlowable(self,flowable):
        if isinstance(flowable,Paragraph) and flowable.style.name=="H1Audit":
            title=flowable.getPlainText()
            if title in {"Contents","Research, mathematics and engineering audit"}: return
            self.heading_sequence+=1
            key=f"section-{self.heading_sequence}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(title,key,level=0)
            self.notify("TOCEntry",(0,title,self.page,key))

def table(rows, widths, header=True):
    rendered = [[P(cell, "TableAudit") for cell in row] for row in rows]
    result = Table(rendered, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 7), ("RIGHTPADDING", (0,0), (-1,-1), 7),
                ("TOPPADDING", (0,0), (-1,-1), 7), ("BOTTOMPADDING", (0,0), (-1,-1), 7), ("LINEBELOW", (0,0), (-1,0), .8, colors.HexColor("#aaaaaa"))]
    if header: commands += [("BACKGROUND", (0,0), (-1,0), colors.HexColor("#ededed"))]
    for index in range(1 if header else 0, len(rows)):
        if index % 2: commands.append(("BACKGROUND", (0,index), (-1,index), colors.HexColor("#fafafa")))
    result.setStyle(TableStyle(commands))
    return result

def append_markdown(story, path):
    lines = path.read_text(encoding="utf-8").splitlines()
    index = 0
    in_code = False
    while index < len(lines):
        line = lines[index].strip()
        if line.startswith("```"):
            in_code = not in_code
            index += 1
            continue
        if in_code:
            story.append(P(line, "FormulaAudit"))
            index += 1
            continue
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
            headers=[cell.lower() for cell in rows[0]]
            widths=[528 / columns] * columns
            if columns==3:
                widths=[135,238,155]
                if "status" in headers[1] or "decision" in headers[1]: widths=[132,138,258]
                elif "named tools" in headers[1]: widths=[105,180,243]
                elif headers[1]=="surface": widths=[55,135,338]
            elif columns==4:
                widths=[105,120,120,183]
                if headers[0]=="rank": widths=[45,110,170,203]
            story += [table(rows, widths), Spacer(1,10)]
            continue
        if line.startswith("## "):
            next_line=next((value.strip() for value in lines[index+1:] if value.strip()),"")
            if next_line.startswith("|"):
                story.append(CondPageBreak(130))
                story.append(P(line[3:],"TableHeadingAudit"))
            else: story.append(P(line[3:], "H2Audit"))
        elif line.startswith("### "):
            story.append(P(line[4:], "H3Audit"))
        elif line.startswith("- "):
            story.append(P("- " + line[2:]))
        else:
            paragraph = [line]
            while index+1 < len(lines) and lines[index+1].strip() and not lines[index+1].lstrip().startswith(("#", "|", "- ")):
                index += 1
                paragraph.append(lines[index].strip())
            story.append(P(" ".join(paragraph)))
        index += 1

def section_document(story, title, path, optional=False):
    story += [PageBreak(), P(title, "H1Audit")]
    if path.exists():
        append_markdown(story, path)
    elif optional:
        story.append(P("Preliminary report: final source documentation for this section is pending. No additional verification is claimed."))
    else:
        raise FileNotFoundError(path)

def formula(story, label, equations, explanation):
    story.append(P(label, "H2Audit"))
    box=Table([[P(line,"FormulaAudit")] for line in equations],colWidths=[528])
    box.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),colors.HexColor("#f0f1f2")),("BOX",(0,0),(-1,-1),.5,colors.HexColor("#c8cbd0")),("LEFTPADDING",(0,0),(-1,-1),12),("RIGHTPADDING",(0,0),(-1,-1),12),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6)]))
    story += [box,Spacer(1,9),P(explanation)]

def technical_math(story):
    story += [PageBreak(),P("V3 mathematics: equations, targets and accounting","H1Audit"),P("The context filters, score simulation and martingale bounds below are isolated experiments requiring explicit numeric inputs and assumptions. Those experiments have no import into the forecast/sizing path, emit affects_forecast=false and supply no probability adjustment. Cash conservation instead governs staged paper-account bookkeeping; cosine/RRF supports staged evidence retrieval. These equations explain different computational roles, without certifying data or guaranteeing trading outcomes.")]
    formula(story,"Scalar Kalman filter [29]",["m_pred = m_prev; P_pred = P_prev + q * Delta_hours","K = P_pred / (P_pred + R)","m = m_pred + K * (y - m_pred)","P = (1-K)^2 * P_pred + K^2 * R"],"The assumed latent context follows a random walk and the observation error has declared variance R. Process variance q scales with elapsed hours. The final line is the Joseph-form covariance update. Source credibility is not inferred from a follower count or editorial ranking. Intervals describe uncertainty under the supplied linear/Gaussian model, not empirical coverage for market outcomes.")
    formula(story,"Three-state HMM forward recursion [30]",["a_1 = declared prior; later a_t(j) = sum_i f_prev(i) * A(i,j)","f_t(j) = a_t(j) * Normal(y_t; mu_j, s^2) / Z_t"],"States represent assumed negative, neutral and positive context. A is an exposed transition matrix and Z_t normalizes the weights. Regular observation cadence and normalized priors/transition rows are required. The implementation uses log-domain normalization. The parameters are fixed assumptions, not learned sentiment classes, source truth or a posterior over the contract result.")
    formula(story,"Terminal regulation score-margin diffusion [1]",["T = remaining_seconds / 60","M_T = margin + drift * T + volatility * sqrt(T) * Z","Z ~ Normal(0,1)","E[M_T] = margin + drift * T; Var[M_T] = volatility^2 * T"],"Exact terminal Gaussian sampling avoids small-step discretization error for this assumed process. Drift is points/minute and volatility is points/sqrt(minute). Regulation lead frequency is not final-game win probability because overtime exists. More Monte Carlo draws reduce sampling error, not errors from omitted possession, fouling, discrete scores, lineups or model misspecification.")
    formula(story,"Conditional maximal loss and drawdown bounds [31]",["S_0 = 0; a > 0; E[Delta S_i | past] = 0; |Delta S_i| <= c_i","V = sum_i c_i^2; P(min_{k<=n} S_k <= -a) <= exp(-a^2/(2*V))","D = max_{0<=j<=k<=n}(S_j-S_k); V_tail(j) = sum_{i=j+1..n} c_i^2","P(D >= a) <= min(1, sum_{0<=j<n} exp(-a^2/(2*V_tail(j))))","Zero-variance tail terms contribute 0 for positive a."],"For positive lambda, the exponential process exp(-lambda*S_k - lambda^2*sum_{i<=k}c_i^2/2) is a nonnegative supermartingale under these assumptions. A maximal crossing argument gives exp(-lambda*a+lambda^2*V/2), minimized at lambda=a/V. Applying the same argument after each possible peak and taking a union bound yields the drawdown expression. It distinguishes initial loss from peak-to-trough drawdown and can be loose or equal to one. Fees, gaps, leverage and adaptive stakes can violate its assumptions. This is not the doubling-after-losses betting strategy.")
    formula(story,"Paper account cash conservation",["available = B0 + additions - decreases + realized_PnL - remaining_basis","released_basis = prior_basis * filled_quantity / prior_quantity","realized_close = net_close_proceeds - released_basis"],"B0 is $20,000 for migrated/new guest accounts. All entry costs include modeled fees; partial closes release proportional basis. Deposits and decreases are cash transfers, not trading profit. A decrease cannot exceed available cash or remove position funding. A confirmed binary settlement is a separate journal action, not a fictitious bid fill. These invariants are covered by deterministic cash-ledger tests.")
    formula(story,"Retained-evidence similarity and reciprocal-rank fusion [32]-[34]",["u = embedding / L2_norm(embedding); dimensions = 384","cosine(u,v) = sum_i(u_i*v_i) / (L2_norm(u)*L2_norm(v))","RRF(document) = sum_{r in {lexical,semantic}} 1/(60+rank_r(document))","An absent candidate contributes 0; rank positions start at 1."],"The real pinned q8 MiniLM model supplies embeddings; numeric arrays are not random or fabricated. Candidate sets are bounded to retained public evidence for the exact selected ticker. The implementation uses an experimental cosine floor of 0.15 and exact native pgvector cosine, with a tested stored-array fallback. RRF is a ranking rule, not an accuracy estimate or contract probability. Semantic similarity cannot certify truth, freshness or settlement relevance, and no HNSW performance gain is claimed.")

def recruiter_assessment(story):
    story += [PageBreak(),P("Recruiter assessment and defensible project claims","H1Audit"),P("This is independent project work. It is strongest as evidence of careful financial-software engineering: reproducible experiments, explicit units, source lineage, realistic cash accounting, negative results and a clear distinction between code, measurements and deployment. No employment responsibilities, professional transaction work or live-money results are established by this audit.")]
    story.append(table([["Hiring context","Evidence strength and limit"],["Software / fintech engineering","Strong project discussion material: shared ingestion, bounded retries, schema/transaction tests, account conflict handling and clear public/private boundaries. A reviewer should still inspect ownership, source code, test runs and operational behavior."],["Data / analytics / applied ML","Credible experimental design: chronological partitions, an independent baseline, proper scores, calibration and recorded model failures. The 1.554% Brier point improvement has uncertainty crossing zero; it is not a validated general lift."],["Quant research","Useful demonstrations of cost-aware decisions and mathematical implementation. Missing prospective calibration, realistic strategy evaluation and transaction-cost/outcome evidence prevent an alpha or profitable-strategy claim."],["Low-latency / HFT systems","The SPSC ring, protobuf/gRPC and book simulator are bounded experiments. Same-thread local benchmarks exclude networks and exchange execution. They do not establish HRT-scale systems, production latency or equivalence to a trading firm's infrastructure."]],[138,390]))
    story += [P("Claim wording that the evidence supports","H2Audit"),P("Built a source-backed prediction-market research and paper-trading application with explicit settlement rules, dated evidence, fee/depth-aware execution, shared streaming and auditable paper cash movements."),P("Trained and evaluated NBA model candidates on chronological historical partitions; retained experimental promotion gates and exported the selected model with native-inference parity."),P("Implemented and tested conditional context filters, regulation-score simulations and martingale bounds with declared assumptions; kept unvalidated context out of the forecast and allocation path."),P("Do not claim newly discovered mathematics, proven source accuracy, guaranteed fills, realized live-money profit or equivalence to HRT, Two Sigma or Citadel. Their primary materials describe broad research/engineering practices and do not certify this project [7]-[11].")]

def bars(label, values):
    drawing = Drawing(528, 117)
    drawing.add(String(0, 103, label, fontName="Helvetica-Bold", fontSize=11, fillColor=colors.HexColor("#262626")))
    maximum = max(value for _,value in values)
    for i,(name,value) in enumerate(values):
        y = 69-i*36
        drawing.add(String(0,y+5,name,fontName="Helvetica",fontSize=9.5))
        drawing.add(Rect(147,y,max(1,value/maximum*290),20,fillColor=colors.HexColor("#333333" if i==0 else "#888888"),strokeColor=None))
        drawing.add(String(447,y+5,f"{value:.6f}",fontName="Helvetica",fontSize=9.5))
    return drawing

def build(destination,verification_path):
    nba=json.loads((BASE/"docs/nba-challenger-validation.json").read_text())
    live=json.loads((BASE/"docs/nba-inplay-validation.json").read_text())
    runtime=json.loads((BASE/"docs/runtime-benchmark.json").read_text())
    sizing=json.loads((BASE/"docs/sizing-benchmark.json").read_text())
    inference=json.loads((BASE/"docs/nba-inference-benchmark.json").read_text())
    try: revision=subprocess.check_output(["git","rev-parse","HEAD"],cwd=REPO,text=True).strip()
    except (OSError,subprocess.CalledProcessError): revision="Source checkout identified by the accompanying repository"
    current_documents=[("V3 selected-contract evidence and source controls",BASE/"docs/EVIDENCE_RESEARCH.md"),
                       ("V3 conditional mathematics: full assumptions and checks",BASE/"docs/QUANT_CONTEXT_EXPERIMENTS.md"),
                       ("V3 semantic evidence retrieval",BASE/"docs/SEMANTIC_EVIDENCE.md"),
                       ("V3 paper accounts, privacy and retained records",REPO/"docs/account-activation.md"),
                       ("V3 analytics configuration and privacy",BASE/"docs/ANALYTICS_SETUP.md"),
                       ("V3 runtime engineering and infrastructure boundaries",REPO/"docs/engineering-runtime.md"),
                       ("Current request and platform disposition",REPO/"docs/request-matrix-v3.md")]
    final_verification=verification_path.exists() and "Status: final-local-review" in verification_path.read_text(encoding="utf-8")
    preliminary=not final_verification or any(not path.exists() for _,path in current_documents)
    contents=TableOfContents();contents.levelStyles=[styles["ContentsAudit"]]
    story=[Spacer(1,20),P("Kalshi Market Lab", "TitleAudit"),P("Research, mathematics and engineering audit", "H1Audit"),
           P("November 4, 2026 | America/New_York"),P("V3 review branch - production release held"),
           P("Existing public origin: https://predictir.dev. New features described here are staged locally unless an explicitly dated earlier-release check says otherwise. This report does not certify the current public deployment."),
           P("A source-backed account of hypotheses tested, models trained, code staged, costs considered and evidence still missing. This is independent project engineering; employment verification and live-money performance are outside its evidence."),
           table([["Evidence class","Meaning"],["Staged and tested","Code exists locally and is exercised by named tests or reproducible tools; this does not mean deployed."],["Measured","A dated local fixture or held-out model result, with its scope stated."],["Experimental","A conditional research computation whose empirical promotion requirements remain separate."],["Held / not established","No new production release, self-hosted migration, advertising optimizer or live-money return is claimed."]],[120,408]),
           Spacer(1,15),P("The notable mathematical addition is a tested composition of calibrated independent forecasts, fresh score-clock conditioning, executable depth, uncertainty-aware position decisions, a discrete risk constraint and an event-overlap graph. Established papers motivate the components; the project's own measurements evaluate this implementation."),
           P("PRELIMINARY: awaiting final local verification and remaining source documentation." if preliminary else "Final local-review evidence is included. Production remains held pending the user's review.","SmallAudit"),
           P("Source base revision when rendered: "+revision+". Report authoring may be committed after this base.","SmallAudit"),PageBreak(),P("Contents","H1Audit"),contents,PageBreak(),P("Earlier measurements retained: model comparisons","H1Audit"),
           bars("Pregame: lower Brier is better, same 514-game holdout",[("Team-strength baseline",nba["baseline"]["brier"]),("Selected challenger",nba["validation"]["brier"])]),
           P("The 1.554% relative Brier point improvement is observable. Its paired whole-week uncertainty interval includes zero, so the challenger remains an explicit experimental option rather than being silently promoted. The neural candidate was trained and its non-convergence retained in the record."),
           bars("In-play: separate 20-game / 60-quarter-state replay",[("Frozen pregame estimate",live["validation"]["baseline"]["brier"]),("Conditional live model",live["validation"]["brier"])]),
           P("The live replay is small and retrospective, with three correlated quarter states per game. Forty earlier calibration games estimate the score-process scale; twenty held-out games evaluate it. This does not establish a calibrated live-money advantage. The model also requires a current matched score and clock before it emits an in-play estimate."),
           P("In-play calculation", "H2Audit"),P("P(home win | margin L, elapsed fraction t) = Phi((L + mu*(1-t)) / (sigma*sqrt(1-t))). The independent pregame chance p0 supplies mu=sigma*Phi_inverse(p0). Sigma is estimated from historical calibration-game score increments. Current fitted sigma is "+f"{live['sigma']:.4f}"+" points, with a whole-game bootstrap sensitivity range "+f"[{live['sigma_interval'][0]:.4f}, {live['sigma_interval'][1]:.4f}]."),
           P("This regulation model omits possession, strategic fouling, live lineups and non-Gaussian endgame behavior. Missing scores are not zero; missing time is not inferred from the scheduled start. Overtime and unsupported boundaries are withheld. Current game state expires after 30 seconds; research caches use five seconds for in-play estimates. Source: Stern [1]; exact capture and replay files accompany the code."),
           P("Earlier engineering measurements retained", "H1Audit"),
           table([["Operation","Measured result","Interpretation"],
                  ["Compiled ensemble",f"{inference['ensemble']['cached_residual_median_microseconds_per_score']:.3f} microseconds per cached score","Local CPU inference; excludes sources, network and rendering."],
                  ["Repeated fill sizing",f"{sizing['construction_median_ms']+sizing['prefix_median_ms']:.3f} ms including construction vs {sizing['reparse_median_ms']:.3f} ms","1,000 sizing queries on one synthetic 1,000-level book; cash-flow parity checked."],
                  ["Book broadcast",f"{runtime['book_snapshot']['all_levels_bytes']:,} to {runtime['book_snapshot']['top100_bytes']:,} bytes","Bounds displayed depth; retains full indexed source reconstruction and fresh REST execution."],
                  ["Schema and fanout","See runtime-benchmark.json and RUNTIME_RESEARCH.md","Contains query plans, concurrency, backpressure and negative partition results."]],[130,180,218]),
           P("The sizing curve parses and sorts the book once, builds quantity/notional/fee prefixes, then answers a quantity query by binary search. Construction is O(L log L) including sorting plus O(L) prefix work; subsequent fill queries are O(log L). This saves repeated parsing during sizing and risk enumeration. It is not a claim that the whole website became hundreds of times faster."),
           P("Audit and reproduction checklist","H1Audit"),
           P("Inspect the frozen source hashes and split dates; reproduce native model training; verify Python/JavaScript parity; run the PostgreSQL and pgTAP checks; replay the independent cash-flow tests; review the full runtime query plans; compare hosted latency before/after region changes; and inspect a paper entry, live mark, close and confirmed settlement. Use the deployment guide for private environment setup. Credentials and private journals are excluded from this report."),
           P("Pinned PDF regeneration: create a Python environment, install tools/report-requirements.txt, then run python tools/build_research_audit.py --output /chosen/path/Research_Audit.pdf. Add --public-copy public/research/research-audit.pdf only when updating the local public artifact too. No private artifact package is required.")]
    story += [PageBreak(),P("Current implementation and release boundary","H1Audit"),
              P("V3 adds a neutral black interface; separate analysis/news reading modes; explicit selected-contract evidence loading; source access and pricing limits; auditable $20,000 paper accounts; cash additions/decreases; browser-scoped guest sessions; owner account synchronization with conflict preservation; and optional consent-gated analytics. Runtime, protocol and mathematical experiments are documented separately from the production data path."),
              P("The current forecasting estimates continue to require exact event/outcome matching, fresh source timestamps and explicit uncertainty. Source reputation, social votes, a smoothed context score, embedding similarity or a critic preference is never silently converted into a trading probability. A more readable long-form explanation is not stronger statistical evidence."),
              P("Self-hosting, the separate advertising optimizer, cloud provisioning, broker activation and production cutover remain held or optional. No technology name alone establishes a speed improvement, cost saving or profitable strategy. The shared-ring microbenchmark was slower than the simple same-thread queue; the report preserves that negative result."),
              P("Final verification is tracked separately from implementation. A local test pass does not prove current hosted credentials, third-party access, future source availability or production deployment.")]
    technical_math(story)
    for title,path in current_documents:
        section_document(story,title,path,optional=path.name in {"SEMANTIC_EVIDENCE.md","account-activation.md"})
    recruiter_assessment(story)
    section_document(story,"Final local verification and unresolved release gates",verification_path,optional=True)
    story += [PageBreak(),P("Earlier release audit: retained historical record","H1Audit"),P("The following section preserves prior model, engineering and hosted-check observations. It is not a statement that V3 was deployed or that the current public site has passed these checks. Earlier theme labels, platform prices, model-catalog observations and region/deployment checks retain their original scope; current decisions above supersede them. No historical benchmark is extrapolated into a present profitability or runtime claim.")]
    append_markdown(story,BASE/"docs/FEATURE_REVIEW.md")
    story += [PageBreak(),P("Research sources and what they contribute","H1Audit"),
              P("[1]-[6] supply earlier score-process, allocation, calibration and scoring methods. [7]-[11] describe research/engineering practice without disclosing proprietary strategies or certifying this app. [12]-[28] support earlier implementation/pricing decisions and public-trader boundaries. [29]-[34] supply context-filter and retrieval background. Later sources document protocol, source-access and platform boundaries. Inline links in each section identify the more specific supporting pages. Forum claims remain unverified and do not train outcome models."),
              P("The broad search included first-party research-firm material, original papers, platform documentation and public community discussion. The report does not infer a top trader's private tools or claim access to proprietary HRT methods. A direct official leaderboard request was throttled; no rate-limit bypass or private-profile retrieval was used.")]
    for number,(title,url) in enumerate(SOURCES,1):
        story.append(P(f"[{number}] [{title}]({url})", "SmallAudit"))
    story += [PageBreak(),P("Source-input manifest and reproducibility","H1Audit"),P("The following SHA-256 values identify the source documents and numerical fixtures used for this render. They identify inputs, not proof of production deployment. Full source, exact test commands and capture limitations remain in the repository.")]
    inputs=[BASE/"docs/FEATURE_REVIEW.md",*[path for _,path in current_documents],verification_path,*[BASE/"docs"/name for name in ["nba-challenger-validation.json","nba-inplay-validation.json","runtime-benchmark.json","sizing-benchmark.json","nba-inference-benchmark.json","semantic-verification.json","evidence-verification.json"]],*[REPO/"review"/name for name in ["browser-validation-v3.json","npm-test-after-account-fixes.txt","typecheck-final.txt","next-build-final.txt"]]]
    story.append(table([["Input","SHA-256"],*[[str(path.relative_to(REPO)),hashlib.sha256(path.read_bytes()).hexdigest()] for path in inputs if path.exists()]],[233,295]))
    destination.parent.mkdir(parents=True,exist_ok=True)
    doc=AuditDocTemplate(str(destination),pagesize=letter,rightMargin=42,leftMargin=42,topMargin=43,bottomMargin=42,title="Kalshi Market Lab - Research and engineering audit",author="Kalshi Market Lab",pageCompression=1)
    def decorate(canvas,document):
        canvas.saveState();canvas.setStrokeColor(colors.HexColor("#cccccc"));canvas.line(42,30,570,30);canvas.setFont("Helvetica",8);canvas.setFillColor(colors.HexColor("#606060"));canvas.drawString(42,19,"Kalshi Market Lab | V3 review branch | Production release held");canvas.drawRightString(570,19,str(document.page));canvas.restoreState()
    doc.multiBuild(story,onFirstPage=decorate,onLaterPages=decorate)
    manifest={"classification":"local_review_artifact_not_production_verification","preliminary":preliminary,"source_base_revision":revision,"reportlab_version":REPORTLAB_VERSION,"page_count":doc.page,"pdf_sha256":hashlib.sha256(destination.read_bytes()).hexdigest(),"inputs":[{"path":path.relative_to(REPO).as_posix(),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()} for path in inputs if path.exists()]}
    destination.with_suffix(".manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(str(destination.resolve()))

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--output",type=Path,default=REPO/"output/pdf/Kalshi_Market_Lab_Research_Audit.pdf");parser.add_argument("--public-copy",type=Path);parser.add_argument("--verification",type=Path,default=BASE/"docs/V3_VERIFICATION.md");args=parser.parse_args();build(args.output,args.verification)
    if args.public_copy:
        args.public_copy.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(args.output,args.public_copy);print(str(args.public_copy.resolve()))
