"""Checks what Claude told the planner against the feed and the database.

Reads Claude's own tool calls from the server's log (the "Tool called" lines of the requests that came through the
tunnel from Anthropic's addresses), sends each again over REST with the same arguments, works out the same answer
with a separate SQL statement where the order does not depend on a query text, and writes what the feed returned,
so it can be read beside Claude's words in transcript.md.

Usage: python3 verify-claude.py <server log> <base url> <api key> <evidence folder>
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

LOG, BASE, KEY, OUT = sys.argv[1:5]


def post(path, body):
    request = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"authorization": "Bearer " + KEY, "content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def sql(statement):
    out = subprocess.run(
        ["docker", "exec", "magic-events-postgres-1", "psql", "-U", "magic", "-d", "magic_events", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement],
        capture_output=True, text=True, check=True).stdout.strip()
    return json.loads(out) if out else []


def tier(item):
    value = item.get("attributes", {}).get("tier")
    return (value[0] if isinstance(value, list) and value else value) or "standard"


def price(item):
    p = item.get("price") or {}
    if p.get("min") is None and p.get("max") is None:
        return "not stated"
    return "free" if p.get("min") == 0 and p.get("max") == 0 else f"R{p.get('min'):g} to R{p.get('max'):g}"


lines = [json.loads(line) for line in open(LOG) if line.startswith("{")]
by_request = {}
for line in lines:
    by_request.setdefault(line.get("requestId"), []).append(line)
# Claude's calls are the tool calls whose request came from outside this machine, through the tunnel.
calls = []
for request_id, group in by_request.items():
    called = next((l for l in group if l.get("msg") == "Tool called"), None)
    started = next((l for l in group if l.get("msg") == "Request started"), None)
    if called and started and started.get("address") not in (None, "127.0.0.1", "::1"):
        calls.append((request_id, called, group))
calls.sort(key=lambda c: c[1]["time"])

report = ["# Claude's answers, checked against the feed", "",
          "Each of Claude's tool calls, as the server logged it, sent again over REST with the same arguments.", ""]
trace = []
ok = True
for number, (request_id, called, group) in enumerate(calls, 1):
    arguments = called["arguments"]
    tool = called["tool"]
    path = "/v1/experiences/search" if tool == "search_experiences" else "/v1/experiences/changes"
    status, answer = post(path, arguments)
    completed = next(l for l in group if l.get("msg") == "Request completed")
    report += [f"## Call {number}: `{tool}`", "",
               f"- **Arguments Claude sent:** `{json.dumps(arguments, ensure_ascii=False)}`",
               f"- **Logged as:** request `{request_id}`, from {completed.get('address')}, tenant `{called.get('tenantId')}`, user `{called.get('userId')}`, the {called.get('callerKind')} key `{called.get('credentialId')}`, answered {completed.get('statusCode')} in {completed.get('durationMs')} ms",
               f"- **The same call over REST:** {status}"]
    trace += group
    if status != 200:
        error = answer["error"]
        report += [f"- **The feed's answer:** `{error['code']}`: {error['message']}", ""]
        continue
    report += [f"- **Total the feed reports:** {answer['total']}", ""]
    if tool == "search_experiences":
        report += ["| # | Title | Tier | Status | Booking | Bookable | Price | Sessions in the stay |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for place, item in enumerate(answer["items"], 1):
            report.append(f"| {place} | {item['title']} | {tier(item)} | {item['status']} | {item['booking']} | {'yes' if item['bookable'] else 'no'} | {price(item)} | {len(item['sessions'])} |")
        ranks = [["luxury", "premium", "standard", "everyday"].index(tier(i)) for i in answer["items"]]
        ordered = ranks == sorted(ranks)
        report += ["", f"Most premium first: {'holds' if ordered else 'DOES NOT HOLD'}."]
        ok = ok and ordered
        if "query" not in arguments:
            # Without a query text the order is fixed by the documented rule, so the database can be asked for it.
            where = ["e.status::text in ('expected','announced','confirmed','postponed')",
                     f"exists (select 1 from experience_session s where s.experience_id = e.id and s.status = 'scheduled' and s.start_date <= '{arguments['to']}' and s.end_date >= '{arguments['from']}')"]
            if arguments.get("bookable"):
                where.append("e.status = 'confirmed' and e.booking = 'open' and (e.booking_url is not null or e.page_url is not null)")
            tiers = arguments.get("attributes", {}).get("tier")
            if tiers:
                listed = ", ".join("'" + t + "'" for t in tiers)
                where.append(f"exists (select 1 from experience_attribute_value v where v.experience_id = e.id and v.attribute_key = 'tier' and v.value #>> '{{}}' in ({listed}))")
            want = sql(f"""select coalesce(json_agg(x.title order by x.rank, x.first, x.title, x.id), '[]') from (
              select e.id, e.title,
                coalesce((select array_position(array['luxury','premium','standard','everyday'], v.value #>> '{{}}') from experience_attribute_value v where v.experience_id = e.id and v.attribute_key = 'tier' limit 1), 3) as rank,
                (select min(s.start_date) from experience_session s where s.experience_id = e.id and s.status = 'scheduled' and s.start_date <= '{arguments['to']}' and s.end_date >= '{arguments['from']}') as first
              from experience e where {' and '.join('(' + w + ')' for w in where)}) x""")
            same = want == [i["title"] for i in answer["items"]]
            report.append(f"The database, asked separately for the same filters and order, gives {len(want)} titles: {'the same, in the same order' if same else 'DIFFERENT: ' + json.dumps(want)}.")
            ok = ok and same
    else:
        report += ["| Title | Kind | Fields changed | Before | Now | Moved out of the stay |", "| --- | --- | --- | --- | --- | --- |"]
        for item in answer["items"]:
            change, experience = item["change"], item["experience"]
            before = change["previous"] or {}
            if "sessions" in before:
                before = {**before, "sessions": [s["startDate"] + (" " + s["startTime"] if s.get("startTime") else "") for s in before["sessions"]]}
            now = {field: experience.get(field) for field in change["fields"]}
            if "sessions" in now:
                now["sessions"] = [s["startDate"] + (" " + s["startTime"] if s.get("startTime") else "") + (" cancelled" if s.get("status") == "cancelled" else "") for s in experience["sessions"]]
            report.append(f"| {experience['title']} | {change['kind']} | {', '.join(change['fields'])} | `{json.dumps(before, ensure_ascii=False)}` | `{json.dumps(now, ensure_ascii=False)}` | {'yes' if item['movedOut'] else 'no'} |")
        rows = sql(f"""select coalesce(json_agg(json_build_object('title', e.title, 'kind', c.kind::text) order by c.changed_at desc), '[]')
          from experience_change c join experience e on e.id = c.experience_id where c.changed_at > '{arguments['since']}'""")
        report += ["", f"The database has {len(rows)} change rows after `{arguments['since']}`: " + "; ".join(f"{r['title']} ({r['kind']})" for r in rows) + "."]
    report.append("")

open(OUT + "/answers-checked.md", "w").write("\n".join(report) + "\n")
with open(OUT + "/server-log.jsonl", "w") as out:
    for line in sorted(trace, key=lambda l: l["time"]):
        line = {k: v for k, v in line.items() if k not in ("pid", "hostname")}
        out.write(json.dumps(line, ensure_ascii=False) + "\n")
print("calls", len(calls), "all checks hold" if ok else "A CHECK FAILED")
