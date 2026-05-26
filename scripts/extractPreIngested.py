#!/usr/bin/env python3
"""Real PDF -> rules extractor using pdfplumber's extract_words() + a
position-based row/column grouper. Much faster than extract_tables()."""

import json, re, sys, datetime
from pathlib import Path
import pdfplumber

CANONICAL = {
    'ma':       '2026-ma-pa-codelist-q2.pdf',
    'medsurg':  '2026-commercial-med-surg-pa-code-list.pdf',
    'pharm':    '2026-commercial-specialty-pharmacy-pa-code-list.pdf',
    'bh':       '2026-commercial-bh-pa-code-list.pdf'
}
LABELS = {
    'ma': 'Medicare Advantage',
    'medsurg': 'Commercial Med-Surg',
    'pharm': 'Specialty Pharmacy',
    'bh': 'Behavioral Health'
}
# Approximate x-position column boundaries per kind (PDF-specific).
# Each is a list of x_threshold values; words with x < first threshold go to
# col 0, between first and second to col 1, etc.
COL_BOUNDS = {
    # MA grid (4 cols): code, description, doc_req, effective_date
    'ma':       [130, 340, 630],   # boundaries -> 4 columns
    # 5-col grids: code, category, description, managed_by, updates
    'medsurg':  [90, 240, 440, 510],
    'pharm':    [90, 200, 320, 395],
    'bh':       [90, 175, 310, 380]
}
N_COLS = {'ma': 4, 'medsurg': 5, 'pharm': 5, 'bh': 5}

CODE_RE = re.compile(r'^[A-Z]?\d{4,5}[A-Z]?$')

def looks_like_code(s):
    return bool(s and CODE_RE.match(s.strip()))

def col_index(x, bounds):
    for i, b in enumerate(bounds):
        if x < b: return i
    return len(bounds)

def group_rows(words, kind):
    """Group words into rows by y-position, with anchor rows being those
    that have a code in column 0; continuation rows attach to the previous
    anchor row's columns."""
    if not words: return []
    bounds = COL_BOUNDS[kind]
    n = N_COLS[kind]
    # Sort by y, then x
    words = sorted(words, key=lambda w: (round(w['top'], 1), w['x0']))
    # Group by y
    rows_by_y = []
    cur_y = None
    cur = []
    for w in words:
        y = round(w['top'], 1)
        if cur_y is None or abs(y - cur_y) > 3:
            if cur: rows_by_y.append(cur)
            cur = [w]; cur_y = y
        else:
            cur.append(w)
    if cur: rows_by_y.append(cur)
    # For each y-row, assign each word to a column
    out_rows = []
    current = None
    for ywords in rows_by_y:
        cols = ['' for _ in range(n)]
        for w in ywords:
            c = col_index(w['x0'], bounds)
            if c >= n: c = n - 1
            cols[c] = (cols[c] + ' ' + w['text']).strip() if cols[c] else w['text']
        first = cols[0].strip()
        if looks_like_code(first):
            if current: out_rows.append(current)
            current = cols
        elif current is not None:
            for i in range(n):
                if cols[i]:
                    current[i] = (current[i] + ' ' + cols[i]).strip()
    if current: out_rows.append(current)
    return out_rows

def parse_managed_by(raw):
    raw = (raw or '').lower()
    has_c = 'carelon' in raw
    has_b = 'bcbsil' in raw or 'bcbs' in raw
    if has_c and (has_b or 'or bcbsil' in raw): return 'Carelon-or-BCBSIL-conditional'
    if has_c: return 'Carelon'
    if 'evicore' in raw: return 'EviCore'
    if 'lucet' in raw: return 'Lucet'
    if has_b: return 'BCBSIL'
    return 'BCBSIL'

def infer_managed_by_ma(code, desc):
    code = (code or '').strip(); desc = (desc or '').lower()
    if re.match(r'^7\d{4}$', code): return 'Carelon'
    if code.startswith('J') and any(s in desc for s in ['onco', 'chemo', 'antineoplas']):
        return 'Carelon'
    return 'BCBSIL'

def normalize_effective(s):
    s = (s or '').strip()
    m = re.search(r'(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})', s)
    if m:
        mo, dy, yr = m.groups()
        if len(yr) == 2: yr = '20' + yr
        return f'{yr}-{int(mo):02d}-{int(dy):02d}'
    if 'effective since before 9/1/2019' in s.lower(): return '2019-09-01'
    return '2026-01-01'

def bind_questionnaire(desc, doc_req='', category=''):
    d = (desc or '').lower(); r = (doc_req or '').lower(); c = (category or '').lower()
    if 'photograph' in r and 'eye' in r: return 'blepharoplasty-medical-necessity', 'blepharoplasty'
    if 'functional impairment' in r and 'operative report' in r:
        return 'cosmetic-surgery-medical-necessity', 'cosmetic-surgery'
    if 'treatment plan including condition being treated' in r:
        return 'oncology-biologic-medical-necessity', 'oncology-biologic'
    if 'statement of medical necessity' in r:
        return 'advanced-imaging-medical-necessity', 'advanced-imaging'
    if 'applied behavior' in (d + c): return 'aba-medical-necessity', 'aba'
    if 'transcranial magnetic' in (d + c): return 'rtms-medical-necessity', 'rtms'
    if 'oncology' in c or 'medical oncology' in c:
        return 'oncology-biologic-medical-necessity', 'oncology-biologic'
    if 'advanced imaging' in c or 'radiology' in c:
        return 'advanced-imaging-medical-necessity', 'advanced-imaging'
    return 'fallback-medical-necessity', None

def extract_pdf(path, kind):
    rules = []
    with pdfplumber.open(path) as pdf:
        for pi, page in enumerate(pdf.pages):
            words = page.extract_words()
            rows = group_rows(words, kind)
            for cols in rows:
                code = cols[0].strip()
                if not looks_like_code(code): continue
                if kind == 'ma':
                    desc = cols[1] if len(cols) > 1 else ''
                    doc_req = cols[2] if len(cols) > 2 else ''
                    eff = cols[3] if len(cols) > 3 else ''
                    q, cql = bind_questionnaire(desc, doc_req)
                    mgr = infer_managed_by_ma(code, desc)
                    rules.append({
                        'match_type': 'code', 'service_code': code,
                        'service_category': None, 'description': desc,
                        'pa_needed': 'auth-needed', 'managed_by': mgr,
                        'questionnaire_id': q, 'cql_library_id': cql,
                        'documentation_requirements': doc_req,
                        'effective_date': normalize_effective(eff),
                        'source_file': CANONICAL[kind], 'source_label': LABELS[kind],
                        'source_page': pi + 1
                    })
                else:
                    category = cols[1] if len(cols) > 1 else ''
                    desc = cols[2] if len(cols) > 2 else ''
                    mgr_raw = cols[3] if len(cols) > 3 else ''
                    upd = cols[4] if len(cols) > 4 else ''
                    mgr = 'Lucet' if kind == 'bh' else parse_managed_by(mgr_raw)
                    q, cql = bind_questionnaire(desc, '', category)
                    rules.append({
                        'match_type': 'code', 'service_code': code,
                        'service_category': category or None, 'description': desc,
                        'pa_needed': 'auth-needed', 'managed_by': mgr,
                        'questionnaire_id': q, 'cql_library_id': cql,
                        'documentation_requirements': '',
                        'effective_date': normalize_effective(upd),
                        'source_file': CANONICAL[kind], 'source_label': LABELS[kind],
                        'source_page': pi + 1
                    })
    return rules

# Hand-curated BH category rules (page 1 of the BH PDF lists services
# without codes; we render those as match_type=category).
BH_CATEGORIES = [
    'Partial Hospitalization Treatment Program',
    'Applied Behavior Analysis (ABA)',
    'Intensive Outpatient Programs (IOP)',
    'Repetitive Transcranial Magnetic Stimulation (rTMS)',
    'Psychological and Neuropsychological Testing'
]

def extract_bh_categories():
    rules = []
    for cat in BH_CATEGORIES:
        q, cql = bind_questionnaire(cat, '', cat)
        rules.append({
            'match_type': 'category', 'service_code': None,
            'service_category': cat, 'description': cat,
            'pa_needed': 'auth-needed', 'managed_by': 'Lucet',
            'questionnaire_id': q, 'cql_library_id': cql,
            'documentation_requirements': '',
            'effective_date': '2026-01-01',
            'source_file': CANONICAL['bh'], 'source_label': LABELS['bh'],
            'source_page': 1
        })
    return rules

def main():
    if len(sys.argv) < 3:
        sys.exit("Usage: extractPreIngested.py <kind> <pdf_path> [<out_path>]")
    kind, pdf_path = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else f'/tmp/extract-{kind}.json'
    if kind == 'bh-categories':
        rules = extract_bh_categories()
    else:
        rules = extract_pdf(pdf_path, kind)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(rules, indent=2))
    print(f'{kind}: {len(rules)} rules -> {out_path}')

if __name__ == '__main__':
    main()
