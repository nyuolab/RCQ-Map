"""Agreement statistics for the clinician validation set.

Every function takes `ratings`: an (items x raters) object array of labels with
None/NaN for a missing rating; here every item carries exactly three.
"""
import numpy as np


def _cats(ratings, categories=None):
    vals = [v for row in ratings for v in row if v is not None and v == v]
    return list(categories) if categories is not None else sorted(set(vals), key=str)


def _counts(ratings, cats):
    """items x categories count matrix."""
    idx = {c: i for i, c in enumerate(cats)}
    M = np.zeros((len(ratings), len(cats)))
    for i, row in enumerate(ratings):
        for v in row:
            if v is not None and v == v:
                M[i, idx[v]] += 1
    return M


def observed_agreement(ratings, cats=None):
    """Mean pairwise agreement across items (Fleiss' P-bar)."""
    M = _counts(ratings, _cats(ratings, cats))
    r = M.sum(1)
    keep = r >= 2
    M, r = M[keep], r[keep]
    return float(np.mean((M * (M - 1)).sum(1) / (r * (r - 1))))


def unanimous(ratings):
    return float(np.mean([len(set(map(str, row))) == 1 for row in ratings]))


def majority_exists(ratings):
    out = []
    for row in ratings:
        _, c = np.unique(np.array(row, dtype=str), return_counts=True)
        out.append(c.max() * 2 > len(row))
    return float(np.mean(out))


def fleiss_kappa(ratings, cats=None):
    cats = _cats(ratings, cats)
    M = _counts(ratings, cats)
    r = M.sum(1)
    pa = np.mean((M * (M - 1)).sum(1) / (r * (r - 1)))
    p = M.sum(0) / M.sum()
    pe = (p ** 2).sum()
    return float((pa - pe) / (1 - pe)) if pe < 1 else np.nan


def gwet_ac1(ratings, categories):
    """Gwet's AC1 with Q = the number of categories the codebook allows."""
    cats = list(categories)
    M = _counts(ratings, cats)
    r = M.sum(1)
    pa = np.mean((M * (M - 1)).sum(1) / (r * (r - 1)))
    pi = np.mean(M / r[:, None], axis=0)
    Q = len(cats)
    pe = (pi * (1 - pi)).sum() / (Q - 1)
    return float((pa - pe) / (1 - pe))


def krippendorff_alpha(ratings, level='nominal', order=None):
    """Krippendorff's alpha from the coincidence matrix. `order` gives the rank
    order of values for the ordinal metric."""
    cats = list(order) if order is not None else _cats(ratings)
    idx = {c: i for i, c in enumerate(cats)}
    K = len(cats)
    O = np.zeros((K, K))
    for row in ratings:
        vals = [idx[v] for v in row if v is not None and v == v]
        m = len(vals)
        if m < 2:
            continue
        for a in range(m):
            for b in range(m):
                if a != b:
                    O[vals[a], vals[b]] += 1.0 / (m - 1)
    n_c = O.sum(1)
    n = n_c.sum()
    if level == 'nominal':
        D = 1 - np.eye(K)
    elif level == 'ordinal':
        D = np.zeros((K, K))
        for c in range(K):
            for k in range(K):
                lo, hi = min(c, k), max(c, k)
                D[c, k] = (n_c[lo:hi + 1].sum() - (n_c[c] + n_c[k]) / 2) ** 2
    else:
        raise ValueError(level)
    do = (O * D).sum()
    de = (np.outer(n_c, n_c) * D).sum() / (n - 1)
    return float(1 - do / de) if de > 0 else np.nan


def cohen_kappa(a, b, cats=None, weights=None, order=None):
    a, b = list(a), list(b)
    cats = list(order) if order is not None else sorted(set(a) | set(b), key=str)
    idx = {c: i for i, c in enumerate(cats)}
    K = len(cats)
    C = np.zeros((K, K))
    for x, y in zip(a, b):
        C[idx[x], idx[y]] += 1
    C /= C.sum()
    E = np.outer(C.sum(1), C.sum(0))
    if weights is None:
        W = 1 - np.eye(K)
    else:
        g = np.arange(K)
        W = (np.subtract.outer(g, g) ** 2) / max((K - 1) ** 2, 1)
    denom = (W * E).sum()
    return float(1 - (W * C).sum() / denom) if denom > 0 else np.nan


def majority_label(row, order=None):
    """Label chosen by >=2 of 3 raters; for ordinal fields with no majority,
    the median rank; otherwise None."""
    vals, cnt = np.unique(np.array(row, dtype=object).astype(str),
                          return_counts=True)
    if cnt.max() * 2 > len(row):
        winner = vals[cnt.argmax()]
        return next(v for v in row if str(v) == winner)
    if order is not None:
        ranks = sorted(order.index(v) for v in row)
        return order[ranks[len(ranks) // 2]]
    return None
