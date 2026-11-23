"""Checks the API's answers against the database, independently of the API's own code.

For each search below it asks the running API, over REST and over MCP, pages through the whole answer, and compares it
with a list worked out by a separate SQL statement written from the documented rules:

- an experience is returned when its status is expected, announced, confirmed or postponed, it has a scheduled
  session that overlaps the stay, and it is within the radius of the place (its own position, or its location's
  centre when it has none);
- the order is most premium first (luxury, premium, standard, everyday; no tier counts as standard), then the first
  matching session's start date, then the title;
- bookable means confirmed, booking open, and a booking link or a page address.

Usage: python3 verify-answers.py <base url> <api key> <output markdown file>
"""
import json
import subprocess
import sys
import urllib.request

BASE, KEY, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
CENTRE = (-34.4187, 19.2345)  # the location hermanus

CASES = [
    ("A whale-season stay, most premium first", {"location": "hermanus", "from": "2027-09-20", "to": "2027-09-30"}),
    ("A week before Christmas", {"location": "hermanus", "from": "2026-12-14", "to": "2026-12-20"}),
    ("Only the premium end, a year", {"location": "hermanus", "from": "2026-12-01", "to": "2027-11-30", "attributes": {"tier": ["luxury", "premium"]}}),
    ("Only what can be booked now, December", {"location": "hermanus", "from": "2026-12-01", "to": "2026-12-31", "bookable": True}),
    ("Tagged whales, the whale season", {"location": "hermanus", "from": "2027-06-01", "to": "2027-11-30", "tags": ["whales"]}),
    ("A family with a child of 10, July school holidays", {"location": "hermanus", "from": "2027-07-01", "to": "2027-07-20", "attributes": {"minimum_age": {"max": 10}}}),
    ("Around Stanford, 10 km", {"near": {"lat": -34.4414, "lng": 19.4553}, "radiusKm": 10, "from": "2026-12-01", "to": "2026-12-31"}),
    ("Expected next editions, 2027", {"location": "hermanus", "from": "2027-01-01", "to": "2027-12-31", "status": ["expected"]}),
    ("Eighteen months ahead", {"location": "hermanus", "from": "2028-05-01", "to": "2028-05-14"}),
    ("Beyond what is known", {"location": "hermanus", "from": "2028-12-01", "to": "2028-12-14"}),
]


def post(path, body):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"authorization": "Bearer " + KEY, "content-type": "application/json", "accept": "application/json, text/event-stream"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read()), response.headers.get("x-request-id")


def rest_all(body):
    items, offset, total, request_ids = [], 0, None, []
    while True:
        answer, request_id = post("/v1/experiences/search", {**body, "limit": 100, "offset": offset})
        request_ids.append(request_id)
        total = answer["total"]
        items += answer["items"]
        offset += 100
        if offset >= total:
            return items, total, request_ids


def mcp_all(body):
    items, offset, total = [], 0, None
    while True:
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search_experiences", "arguments": {**body, "limit": 100, "offset": offset}}}
        answer, _ = post("/mcp", call)
        result = answer["result"]
        if result.get("isError"):
            raise SystemExit("MCP refused: " + json.dumps(result)[:400])
        content = result["structuredContent"]
        total = content["total"]
        items += content["items"]
        offset += 100
        if offset >= total:
            return items, total


def sql_rows(statement):
    out = subprocess.run(
        ["docker", "exec", "magic-events-postgres-1", "psql", "-U", "magic", "-d", "magic_events", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return json.loads(out) if out else []


def quote(text):
    return "'" + str(text).replace("'", "''") + "'"


def expected(body):
    lat, lng = (body["near"]["lat"], body["near"]["lng"]) if "near" in body else CENTRE
    radius = body.get("radiusKm", 60)
    statuses = body.get("status", ["expected", "announced", "confirmed", "postponed"])
    where = [
        "e.status::text in (" + ", ".join(quote(s) for s in statuses) + ")",
        f"exists (select 1 from experience_session s where s.experience_id = e.id and s.status = 'scheduled' and s.start_date <= {quote(body['to'])} and s.end_date >= {quote(body['from'])})",
        f"6371 * 2 * asin(sqrt(power(sin(radians(coalesce(e.latitude, l.latitude) - ({lat})) / 2), 2) + cos(radians({lat})) * cos(radians(coalesce(e.latitude, l.latitude))) * power(sin(radians(coalesce(e.longitude, l.longitude) - ({lng})) / 2), 2))) <= {radius}",
    ]
    if body.get("bookable"):
        where.append("e.status = 'confirmed' and e.booking = 'open' and (e.booking_url is not null or e.page_url is not null)")
    if "tags" in body:
        where.append("exists (select 1 from experience_tag t where t.experience_id = e.id and t.tag in (" + ", ".join(quote(t) for t in body["tags"]) + "))")
    attributes = body.get("attributes", {})
    if "tier" in attributes:
        where.append("exists (select 1 from experience_attribute_value v where v.experience_id = e.id and v.attribute_key = 'tier' and v.value #>> '{}' in (" + ", ".join(quote(t) for t in attributes["tier"]) + "))")
    if "minimum_age" in attributes:
        top = attributes["minimum_age"]["max"]
        where.append(f"not exists (select 1 from experience_attribute_value v where v.experience_id = e.id and v.attribute_key = 'minimum_age' and (v.value #>> '{{}}')::numeric > {top})")
    statement = f"""
      select coalesce(json_agg(row_to_json(x) order by x.tier_rank, x.first_session, x.title, x.id), '[]') from (
        select e.id, e.title, e.status::text as status, e.booking::text as booking,
          (e.status = 'confirmed' and e.booking = 'open' and (e.booking_url is not null or e.page_url is not null)) as bookable,
          e.price_min::float as price_min, e.price_max::float as price_max,
          coalesce((select v.value #>> '{{}}' from experience_attribute_value v where v.experience_id = e.id and v.attribute_key = 'tier' limit 1), 'standard') as tier,
          coalesce((select array_position(array['luxury','premium','standard','everyday'], v.value #>> '{{}}') from experience_attribute_value v where v.experience_id = e.id and v.attribute_key = 'tier' limit 1), 3) as tier_rank,
          (select min(s.start_date) from experience_session s where s.experience_id = e.id and s.status = 'scheduled' and s.start_date <= {quote(body['to'])} and s.end_date >= {quote(body['from'])}) as first_session,
          (select count(*) from experience_session s where s.experience_id = e.id and s.status = 'scheduled' and s.start_date <= {quote(body['to'])} and s.end_date >= {quote(body['from'])}) as sessions
        from experience e join location l on l.id = e.location_id
        where {' and '.join('(' + w + ')' for w in where)}
      ) x"""
    return sql_rows(statement)


def tier_of(item):
    value = item.get("attributes", {}).get("tier")
    if isinstance(value, list):
        value = value[0] if value else None
    return value or "standard"


def compare(want, got):
    problems = []
    if [w["id"] for w in want] != [g["id"] for g in got]:
        missing = [w["title"] for w in want if w["id"] not in {g["id"] for g in got}]
        extra = [g["title"] for g in got if g["id"] not in {w["id"] for w in want}]
        if missing or extra:
            problems.append(f"missing {missing[:5]} extra {extra[:5]}")
        else:
            first = next(i for i, (w, g) in enumerate(zip(want, got)) if w["id"] != g["id"])
            problems.append(f"same items, order differs from place {first + 1}: expected {want[first]['title']!r}, got {got[first]['title']!r}")
    by_id = {w["id"]: w for w in want}
    for g in got:
        w = by_id.get(g["id"])
        if w is None:
            continue
        price = g.get("price") or {}
        checks = [
            ("title", w["title"], g["title"]),
            ("status", w["status"], g["status"]),
            ("booking", w["booking"], g["booking"]),
            ("bookable", w["bookable"], g["bookable"]),
            ("price.min", w["price_min"], price.get("min")),
            ("price.max", w["price_max"], price.get("max")),
            ("tier", w["tier"], tier_of(g)),
            ("sessions in the stay", w["sessions"], len(g["sessions"])),
        ]
        for name, a, b in checks:
            if a != b:
                problems.append(f"{g['title']}: {name} is {b!r} in the answer and {a!r} in the database")
    return problems


lines = ["| Search | Request | In the database | REST | MCP | First three returned | Result |", "| --- | --- | --- | --- | --- | --- | --- |"]
failures = 0
for name, body in CASES:
    want = expected(body)
    rest, rest_total, request_ids = rest_all(body)
    mcp, mcp_total = mcp_all(body)
    problems = compare(want, rest)
    if rest_total != len(want):
        problems.append(f"total says {rest_total}, the database has {len(want)}")
    if [i["id"] for i in rest] != [i["id"] for i in mcp] or mcp_total != rest_total:
        problems.append("MCP and REST differ")
    if json.dumps(rest, sort_keys=True) != json.dumps(mcp, sort_keys=True):
        problems.append("MCP and REST items differ in content")
    failures += bool(problems)
    first = "; ".join(f"{i['title']} ({tier_of(i)})" for i in rest[:3]) or "nothing"
    lines.append(f"| {name} | `{json.dumps(body)}` | {len(want)} | {rest_total} | {mcp_total} | {first} | {'matches' if not problems else 'DIFFERS: ' + ' / '.join(problems[:6])} |")
    print(name, "->", "ok" if not problems else problems[:6], "request", request_ids[0])

open(OUT, "w").write("\n".join(lines) + "\n")
print("cases", len(CASES), "with differences", failures)
sys.exit(1 if failures else 0)
