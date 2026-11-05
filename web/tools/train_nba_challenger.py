import hashlib
import json
import math
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import scipy
import sklearn
import xgboost
from scipy.optimize import minimize
from scipy.special import expit
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

WEB = Path(__file__).resolve().parents[1]
DATA = WEB / '.research' / 'nba-training-features.json'
SEED = 72129


def metrics(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return {'n': len(y), 'brier': float(np.mean((y - p) ** 2)),
            'log_loss': float(-np.mean(y * np.log(p) + (1 - y) * np.log1p(-p)))}


def beta_map(p, beta):
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return expit(beta[0] * np.log(p) - beta[1] * np.log1p(-p) + beta[2])


def fit_beta(p, y):
    def loss(beta):
        q = np.clip(beta_map(p, beta), 1e-9, 1 - 1e-9)
        penalty = 10 * np.sum((beta - np.array([1, 1, 0])) ** 2)
        return float(-np.sum(y * np.log(q) + (1 - y) * np.log1p(-q)) + penalty)
    result = minimize(loss, [1., 1., 0.], method='L-BFGS-B', bounds=[(0, 5), (0, 5), (-3, 3)])
    if not result.success:
        raise RuntimeError('Calibration optimization did not converge')
    return result.x


def block_interval(rows, differences):
    grouped = {}
    for row, value in zip(rows, differences):
        stamp = datetime.fromisoformat(row['played_at'].replace('Z', '+00:00')).timestamp()
        grouped.setdefault(math.floor((stamp + 3 * 86400) / (7 * 86400)), []).append(float(value))
    blocks = list(grouped.values())
    rng = np.random.default_rng(SEED)
    values = []
    for _ in range(2000):
        chosen = [blocks[i] for i in rng.integers(0, len(blocks), len(blocks))]
        values.append(np.mean([value for block in chosen for value in block]))
    return {'weekly_blocks': len(blocks), 'replicates': len(values),
            'mean': float(np.mean(differences)),
            'lower_95': float(np.quantile(values, .025)), 'upper_95': float(np.quantile(values, .975))}


def main():
    started = time.perf_counter()
    data = json.loads(DATA.read_text(encoding='utf-8'))
    rows = data['rows']
    x = np.asarray([r['x'] for r in rows], dtype=np.float64)
    y = np.asarray([r['y'] for r in rows], dtype=np.float64)
    masks = {name: np.asarray([r['split'] == name for r in rows]) for name in ['train', 'selection', 'calibration', 'test']}
    if not all(np.isfinite(x).all(axis=1)) or len(set(r['id'] for r in rows)) != len(rows):
        raise ValueError('Training input contains invalid features or duplicate games')
    scaler = StandardScaler().fit(x[masks['train']])
    scaled = scaler.transform(x)
    models = {
        'ridge_logistic': LogisticRegression(C=.25, max_iter=1500, random_state=SEED),
        'xgboost_depth2': XGBClassifier(n_estimators=120, max_depth=2, learning_rate=.035, min_child_weight=30,
                                     reg_lambda=12, subsample=1, colsample_bytree=1, n_jobs=1, random_state=SEED,
                                     objective='binary:logistic', tree_method='hist', eval_metric='logloss'),
        'neural_16_8': MLPClassifier(hidden_layer_sizes=(16, 8), alpha=2, max_iter=500, random_state=SEED,
                                    learning_rate_init=.002, early_stopping=False, shuffle=False, solver='lbfgs')}
    predictions, exported, convergence, fit_times = {}, {}, {}, {}
    for name, model in models.items():
        before = time.perf_counter()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always', ConvergenceWarning)
            model.fit(scaled[masks['train']], y[masks['train']])
        convergence[name] = not any(issubclass(w.category, ConvergenceWarning) for w in caught)
        fit_times[name] = time.perf_counter() - before
        predictions[name] = model.predict_proba(scaled)[:, 1]
        if name == 'ridge_logistic':
            exported[name] = {'kind': 'logistic', 'coefficients': model.coef_[0].tolist(), 'intercept': float(model.intercept_[0])}
        elif name == 'xgboost_depth2':
            configuration = json.loads(model.get_booster().save_config())
            base = configuration['learner']['learner_model_param']['base_score'].strip('[]')
            exported[name] = {'kind': 'xgboost', 'base_score': float(base),
                              'trees': [json.loads(tree) for tree in model.get_booster().get_dump(dump_format='json')]}
        else:
            exported[name] = {'kind': 'neural', 'weights': [v.tolist() for v in model.coefs_],
                              'biases': [v.tolist() for v in model.intercepts_], 'activation': model.activation}
    bt = np.asarray([r['bt60'] if r['bt60'] is not None else .5 for r in rows])
    comparison = np.asarray([r['bt80'] if r['bt80'] is not None else .5 for r in rows])
    candidates = [{'model': 'bradley_terry', 'weight': 0., **metrics(y[masks['selection']], bt[masks['selection']])}]
    for name, p in predictions.items():
        if not convergence[name]:
            continue
        for weight in [.25, .5, .75, 1.]:
            q = (1 - weight) * bt + weight * p
            candidates.append({'model': name, 'weight': weight, **metrics(y[masks['selection']], q[masks['selection']])})
    chosen = min(candidates, key=lambda c: (c['brier'], c['log_loss'], c['weight']))
    p = bt if chosen['model'] == 'bradley_terry' else (1 - chosen['weight']) * bt + chosen['weight'] * predictions[chosen['model']]
    beta = fit_beta(p[masks['calibration']], y[masks['calibration']])
    calibrated = beta_map(p, beta)
    held_rows = [r for r in rows if r['split'] == 'test']
    truth, final, baseline = y[masks['test']], calibrated[masks['test']], comparison[masks['test']]
    score, base_score = metrics(truth, final), metrics(truth, baseline)
    uncertainty = block_interval(held_rows, (truth - baseline) ** 2 - (truth - final) ** 2)
    improvement = 1 - score['brier'] / base_score['brier']
    promotion = bool(len(truth) >= 100 and uncertainty['weekly_blocks'] >= 12 and improvement >= .01 and
                     uncertainty['lower_95'] > 0 and score['log_loss'] <= base_score['log_loss'] and
                     data['coverage']['partial'] is False)
    artifacts = WEB / 'lib' / 'workspace' / 'models'
    artifacts.mkdir(parents=True, exist_ok=True)
    residuals = [{'id': r['id'], 'played_at': r['played_at'], 'p': float(q), 'y': int(label), 'error': float(label-q)}
                 for r, q, label in zip([r for r in rows if r['split'] == 'calibration'], calibrated[masks['calibration']], y[masks['calibration']])]
    artifact = {'schema_version': 1, 'trained_at': datetime.now(timezone.utc).isoformat(), 'league': 'nba',
                'source_captured_at': data['captured_at'],
                'feature_names': data['features'], 'games_sha256': data['games_sha256'], 'baseline_training_sha256': data['baseline_training_sha256'],
                'scaler': {'mean': scaler.mean_.tolist(), 'scale': scaler.scale_.tolist()},
                'selected': {'model': chosen['model'], 'weight': chosen['weight'], 'beta': beta.tolist()},
                'models': exported, 'residuals': residuals, 'promoted': promotion,
                'validation': {**score, 'baseline_brier': base_score['brier'], 'baseline_log_loss': base_score['log_loss'],
                               'brier_skill': improvement, 'improvement_95_lower': uncertainty['lower_95'],
                               'weekly_blocks': uncertainty['weekly_blocks'], 'coverage': 1., 'unmatched_games': 0,
                               'passed': promotion, 'train_end': data['train_end'], 'test_start': held_rows[0]['played_at'],
                               'test_end': held_rows[-1]['played_at'],
                               'protocol': '60/10/10/20 strictly chronological train/model-selection/beta-calibration/test; equal timestamps stay together. Lag features include only earlier final scores. Fixed pre-specified candidates; final holdout is not used for model selection. Paired Brier differences use 2,000 seeded whole-week bootstrap replicates.'}}
    path = artifacts / 'nba-challenger.json'
    path.write_text(json.dumps(artifact, indent=2) + '\n', encoding='utf-8')
    fixture = {'feature_names': data['features'], 'rows': [{'x': r['x'], 'predictions': {name: float(values[i]) for name, values in predictions.items()}}
                for i, r in enumerate(rows) if i % 211 == 0]}
    (WEB / 'tests' / 'fixtures').mkdir(exist_ok=True)
    (WEB / 'tests' / 'fixtures' / 'nba-ml-parity.json').write_text(json.dumps(fixture, indent=2)+'\n', encoding='utf-8')
    card = {'evaluated_at': artifact['trained_at'], 'classification': 'Retrospective public-score model comparison; not a trading-return backtest',
            'selected': artifact['selected'], 'promoted': promotion, 'validation': artifact['validation'],
            'baseline': base_score, 'paired_weekly_bootstrap': uncertainty, 'candidate_selection_scores': candidates,
            'candidate_converged': convergence, 'candidate_fit_seconds': fit_times,
            'software': {'numpy': np.__version__, 'scipy': scipy.__version__, 'scikit-learn': sklearn.__version__, 'xgboost': xgboost.__version__},
            'input': {'games': len(rows), 'games_sha256': data['games_sha256'], 'source_count': len(data['source_manifest']),
                      'coverage': data['coverage'], 'features': data['features'], 'source_examples':data['source_manifest'][:3],
                      'splits': {name: int(mask.sum()) for name, mask in masks.items()}},
            'artifact_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'elapsed_seconds': time.perf_counter()-started,
            'promotion_rule': 'At least 1% lower final-holdout Brier than the existing 80%-fit frozen Bradley-Terry baseline, non-worse log loss, positive 95% whole-week-bootstrap lower improvement, >=100 cases, >=12 weeks and complete source coverage.',
            'limitations': ['Game final-score history is not a point-in-time roster or injury archive.', 'Historical public data may be corrected; original capture hashes identify inputs.',
                           'Whole-week bootstrap resampling does not eliminate repeated-team dependence across weeks or seasonal regime changes.',
                           'Same-game updates are grouped by scheduled timestamps; actual historical result-publication timestamps are unavailable.',
                           'The new composition uses established algorithms; no claim of a new theorem or HRT-like trading edge.',
                           'Conditional calibration residuals are empirical sensitivity evidence, not guaranteed event-probability intervals.',
                           'Models exclude Kalshi prices, order flow, lineups, bookmaker odds and news. No trading profitability was measured.'],
            'sources': [{'title':'XGBoost: A Scalable Tree Boosting System','url':'https://arxiv.org/abs/1603.02754'},
                        {'title':'Beta calibration','url':'https://proceedings.mlr.press/v54/kull17a.html'},
                        {'title':'On Calibration of Modern Neural Networks','url':'https://proceedings.mlr.press/v70/guo17a.html'},
                        {'title':'Strictly Proper Scoring Rules, Prediction, and Estimation','url':'https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf'}]}
    (WEB / 'docs' / 'nba-challenger-validation.json').write_text(json.dumps(card, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k:card[k] for k in ['selected','promoted','validation','candidate_converged','candidate_fit_seconds','elapsed_seconds']},indent=2))


if __name__ == '__main__':
    main()
