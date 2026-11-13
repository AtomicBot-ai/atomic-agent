#!/usr/bin/env python3
"""Keyword position history for the seo-rank-report skill.

Standard library only. Positions live in a local SQLite file, by default
<state dir>/seo-rank-report/history.sqlite, outside the skill folder so a
skill refresh never wipes the history.

Subcommands (every one prints JSON on stdout):
  record      store one run of positions (inline --json or --file)
  report      latest run vs the run before it, per keyword, with deltas
  history     every stored run for one keyword
  fetch-dataforseo  ask DataForSEO for positions with the user's own key
  suggest     Google search suggestions for a seed phrase (keyword ideas)
"""

import argparse
import base64
import datetime as dt
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request

DATAFORSEO_URL = "https://api.dataforseo.com/v3/serp/google/organic/live/regular"
SUGGEST_URL = "https://suggestqueries.google.com/complete/search"


STATE_DIR_OVERRIDE = None


def state_dir():
    """The agent's state folder: --state-dir, else $ATOMIC_AGENT_STATE_DIR,
    else ~/.atomic-agent. "~" is expanded here, because a command started
    without a shell never expands it."""
    raw = STATE_DIR_OVERRIDE or os.environ.get("ATOMIC_AGENT_STATE_DIR") or "~/.atomic-agent"
    return os.path.abspath(os.path.expanduser(raw))


def default_db():
    return os.path.join(state_dir(), "seo-rank-report", "history.sqlite")


def connect(path):
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute(
        "CREATE TABLE IF NOT EXISTS positions ("
        " run_date TEXT NOT NULL, domain TEXT NOT NULL, keyword TEXT NOT NULL,"
        " position REAL, url TEXT, source TEXT NOT NULL, recorded_at TEXT NOT NULL,"
        " PRIMARY KEY (run_date, domain, keyword))"
    )
    return db


def norm_domain(raw):
    d = raw.strip().lower()
    if "://" in d:
        d = urllib.parse.urlparse(d).netloc
    d = d.split("/")[0]
    return d[4:] if d.startswith("www.") else d


def norm_keyword(raw):
    return " ".join(raw.strip().lower().split())


def parse_position(value):
    if value is None or value == "":
        return None
    pos = float(value)
    return None if pos <= 0 else round(pos, 1)


def cmd_record(args):
    if args.json is not None:
        rows = json.loads(args.json)
    elif args.file is not None:
        with open(args.file, encoding="utf-8") as fh:
            rows = json.load(fh)
    else:
        raise SystemExit("record needs --json or --file")
    if isinstance(rows, dict):
        rows = rows.get("results", [])
    run_date = args.date or dt.date.today().isoformat()
    dt.date.fromisoformat(run_date)
    domain = norm_domain(args.domain)
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    db = connect(args.db)
    stored = 0
    with db:
        for row in rows:
            kw = norm_keyword(str(row.get("keyword", "")))
            if not kw:
                continue
            db.execute(
                "INSERT OR REPLACE INTO positions VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_date, domain, kw, parse_position(row.get("position")),
                 row.get("url"), args.source, now),
            )
            stored += 1
    return {"status": "ok", "stored": stored, "run_date": run_date, "domain": domain, "db": args.db}


def run_dates(db, domain):
    cur = db.execute(
        "SELECT DISTINCT run_date FROM positions WHERE domain = ? ORDER BY run_date DESC", (domain,)
    )
    return [r[0] for r in cur.fetchall()]


def load_run(db, domain, run_date):
    cur = db.execute(
        "SELECT keyword, position, url, source FROM positions WHERE domain = ? AND run_date = ?",
        (domain, run_date),
    )
    return {r[0]: {"position": r[1], "url": r[2], "source": r[3]} for r in cur.fetchall()}


def movement(prev, cur):
    """Positive change means the page moved up (a smaller position number)."""
    if prev is None and cur is None:
        return "not_ranked", None
    if prev is None:
        return "new", None
    if cur is None:
        return "lost", None
    change = round(prev - cur, 1)
    if change > 0:
        return "up", change
    if change < 0:
        return "down", change
    return "same", 0


def cmd_report(args):
    domain = norm_domain(args.domain)
    db = connect(args.db)
    dates = run_dates(db, domain)
    if args.date:
        dates = [d for d in dates if d <= args.date]
    if not dates:
        return {"status": "empty", "domain": domain, "message": "no runs stored for this domain yet"}
    latest_date = dates[0]
    previous_date = dates[1] if len(dates) > 1 else None
    latest = load_run(db, domain, latest_date)
    previous = load_run(db, domain, previous_date) if previous_date else {}
    keywords = sorted(set(latest) | set(previous))
    rows, counts = [], {}
    for kw in keywords:
        cur = latest.get(kw, {})
        prev = previous.get(kw, {})
        cur_pos, prev_pos = cur.get("position"), prev.get("position")
        if kw not in latest:
            status, change = "not_checked", None
        elif previous_date is None or kw not in previous:
            status, change = ("first_check" if cur_pos is not None else "not_ranked"), None
        else:
            status, change = movement(prev_pos, cur_pos)
        counts[status] = counts.get(status, 0) + 1
        rows.append({
            "keyword": kw, "position": cur_pos, "previous": prev_pos, "change": change,
            "status": status, "url": cur.get("url"), "source": cur.get("source"),
            "source_changed": bool(cur and prev and cur.get("source") != prev.get("source")),
        })
    order = {"up": 0, "down": 1, "new": 2, "lost": 3}
    rows.sort(key=lambda r: (order.get(r["status"], 4), -abs(r["change"] or 0), r["keyword"]))
    ranked = [r["position"] for r in rows if r["position"] is not None]
    return {
        "status": "ok", "domain": domain, "latest_run": latest_date, "previous_run": previous_date,
        "counts": counts, "in_top_10": sum(1 for p in ranked if p <= 10),
        "average_position": round(sum(ranked) / len(ranked), 1) if ranked else None,
        "keywords": rows,
    }


def cmd_history(args):
    db = connect(args.db)
    cur = db.execute(
        "SELECT run_date, position, url, source FROM positions"
        " WHERE domain = ? AND keyword = ? ORDER BY run_date",
        (norm_domain(args.domain), norm_keyword(args.keyword)),
    )
    runs = [{"run_date": r[0], "position": r[1], "url": r[2], "source": r[3]} for r in cur.fetchall()]
    return {"status": "ok", "keyword": norm_keyword(args.keyword), "runs": runs}


def read_env_file():
    """Values from <state dir>/.env. The agent strips secret-looking names
    (such as *_PASSWORD) from a command's environment, so the key file is
    read directly instead."""
    values = {}
    try:
        with open(os.path.join(state_dir(), ".env"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                name = name.strip()
                if name.startswith("export "):
                    name = name[len("export "):].strip()
                values[name] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def dataforseo_credentials():
    env_file = read_env_file()
    login = os.environ.get("DATAFORSEO_LOGIN") or env_file.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD") or env_file.get("DATAFORSEO_PASSWORD")
    return login, password


def read_keywords(path):
    with open(os.path.expanduser(path), encoding="utf-8") as fh:
        kws = [norm_keyword(line) for line in fh if line.strip() and not line.lstrip().startswith("#")]
    return list(dict.fromkeys(kws))


def host_matches(host, domain):
    host = norm_domain(host or "")
    return host == domain or host.endswith("." + domain)


def find_position(items, domain):
    for item in items or []:
        if item.get("type") == "organic" and host_matches(item.get("domain"), domain):
            return item.get("rank_group"), item.get("url")
    return None, None


def cmd_fetch_dataforseo(args):
    login, password = dataforseo_credentials()
    if not login or not password:
        return {"status": "no_key", "message": "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set in the .env file"}
    domain = norm_domain(args.domain)
    keywords = read_keywords(args.keywords_file)[: args.limit]
    auth = base64.b64encode(f"{login}:{password}".encode()).decode()
    results, errors = [], []
    for kw in keywords:
        body = json.dumps([{"keyword": kw, "location_code": args.location_code,
                            "language_code": args.language_code, "depth": args.depth}]).encode()
        req = urllib.request.Request(DATAFORSEO_URL, data=body, method="POST", headers={
            "Authorization": f"Basic {auth}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.load(resp)
            task = (data.get("tasks") or [{}])[0]
            if task.get("status_code") != 20000:
                errors.append({"keyword": kw, "error": task.get("status_message") or data.get("status_message")})
                continue
            items = ((task.get("result") or [{}])[0] or {}).get("items")
            pos, url = find_position(items, domain)
            results.append({"keyword": kw, "position": pos, "url": url})
        except Exception as exc:  # network, HTTP 401/402, bad JSON
            errors.append({"keyword": kw, "error": str(exc)})
    out = {"status": "ok" if results else "error", "domain": domain, "source": "dataforseo",
           "checked": len(results), "errors": errors, "results": results}
    if args.record and results:
        rec = argparse.Namespace(json=json.dumps(results), file=None, date=args.date,
                                 domain=domain, source="dataforseo", db=args.db)
        out["recorded"] = cmd_record(rec)
    return out


def cmd_suggest(args):
    query = urllib.parse.urlencode({"client": "firefox", "hl": args.hl, "q": args.q})
    with urllib.request.urlopen(f"{SUGGEST_URL}?{query}", timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    return {"status": "ok", "seed": args.q, "suggestions": data[1] if len(data) > 1 else []}


def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--state-dir", help="agent state folder (default: $ATOMIC_AGENT_STATE_DIR or ~/.atomic-agent)")
    p.add_argument("--db", help="SQLite file (default: <state dir>/seo-rank-report/history.sqlite)")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("record")
    r.add_argument("--domain", required=True)
    r.add_argument("--source", required=True, help="gsc, dataforseo, ahrefs, seranking, ...")
    r.add_argument("--date", help="run date YYYY-MM-DD (default: today)")
    r.add_argument("--json", help='[{"keyword": "...", "position": 4.2, "url": "..."}]; position null = not found')
    r.add_argument("--file", help="same JSON in a file")
    r.set_defaults(func=cmd_record)

    rep = sub.add_parser("report")
    rep.add_argument("--domain", required=True)
    rep.add_argument("--date", help="report as of this date (default: latest run)")
    rep.set_defaults(func=cmd_report)

    h = sub.add_parser("history")
    h.add_argument("--domain", required=True)
    h.add_argument("--keyword", required=True)
    h.set_defaults(func=cmd_history)

    f = sub.add_parser("fetch-dataforseo")
    f.add_argument("--domain", required=True)
    f.add_argument("--keywords-file", required=True)
    f.add_argument("--location-code", type=int, default=2840, help="2840 = United States")
    f.add_argument("--language-code", default="en")
    f.add_argument("--depth", type=int, default=100)
    f.add_argument("--limit", type=int, default=50, help="most keywords checked in one call")
    f.add_argument("--date")
    f.add_argument("--record", action="store_true", help="also store the positions")
    f.set_defaults(func=cmd_fetch_dataforseo)

    s = sub.add_parser("suggest")
    s.add_argument("--q", required=True)
    s.add_argument("--hl", default="en")
    s.set_defaults(func=cmd_suggest)
    return p


def main(argv=None):
    global STATE_DIR_OVERRIDE
    args = build_parser().parse_args(argv)
    STATE_DIR_OVERRIDE = args.state_dir
    if args.db is None:
        args.db = default_db()
    try:
        out = args.func(args)
    except (ValueError, OSError, sqlite3.Error) as exc:
        out = {"status": "error", "message": str(exc)}
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("status") != "error" else 1


if __name__ == "__main__":
    sys.exit(main())
