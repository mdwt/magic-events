import { isDeepStrictEqual } from "node:util";
import { errorOf, send, type Call, type Client } from "../harness/api.ts";
import { admin, logLinesOf, printedOf } from "../harness/cli.ts";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { literal, one, query } from "../harness/db.ts";
import { ids, WINTER, type Experience, type SearchResult } from "../harness/feed.ts";
import { connect, rpc, toolResultOf } from "../harness/mcp.ts";
import type { CommandResult } from "../harness/process.ts";
import { scenario } from "../harness/scenario.ts";
import { LEVEL } from "../harness/server.ts";
import { clientFor } from "../harness/setup.ts";
import { client, mainServer, recall, state } from "../harness/state.ts";

// Onboarding (UC4) from the command line, suspension, revocation and several tenants at once: E2E-31 to E2E-36.

const SECOND = "planner@second-agency.example.com";
const APP_USER = "planner@second-app.example.com";

function keyIn(result: CommandResult): string | undefined {
  return /\b(mev_[A-Za-z0-9]+)\b/.exec(result.stdout)?.[1];
}

function checkCommand(c: Checks, result: CommandResult, what: string): boolean {
  return c.ok(result.code === 0, `${what} exited with ${String(result.code)}: ${printedOf(result).trim().slice(-300)}`);
}

// A key is printed once, in the block that says so, and in none of the command's log lines.
function checkKeyPrintedOnce(c: Checks, result: CommandResult, key: string, what: string): void {
  c.equal(result.stdout.split(key).length - 1, 1, `${what}: times the key is printed`);
  c.ok(/SHOWN ONCE/.test(result.stdout), `${what}: the key is in the block that says it cannot be shown again`);
  c.ok(!logLinesOf(result).some((line) => JSON.stringify(line).includes(key)), `${what}: the key is in a log line`);
}

async function issue(c: Checks, label: string, email: string, name: string, kind: "person" | "agent", extra: Record<string, string> = {}): Promise<Client | undefined> {
  const issued = await admin(["key", "issue", "--user", email, "--name", name, "--kind", kind], extra);
  if (!checkCommand(c, issued, `key issue ${name}`)) return undefined;
  const key = keyIn(issued);
  if (!c.ok(key !== undefined, `key issue ${name} printed a key`) || key === undefined) return undefined;
  checkKeyPrintedOnce(c, issued, key, `key issue ${name}`);
  return clientFor(label, email, name, key);
}

async function restSearch(who: Client): Promise<Call> {
  return send(mainServer(), { path: "/v1/experiences/search", client: who, body: { ...WINTER, limit: 100 } });
}

async function mcpSearch(who: Client): Promise<Call> {
  return rpc(mainServer(), who, "tools/call", { name: "search_experiences", arguments: { ...WINTER, limit: 100 } });
}

function sameAsWinter(c: Checks, answer: unknown, what: string): void {
  const first = recall<{ total: number; items: Experience[] }>("E2E-01");
  const result = answer as SearchResult | undefined;
  if (first === undefined || result === undefined) {
    c.fail(`${what}: nothing to compare`);
    return;
  }
  c.equal(result.total, first.total, `${what}: total`);
  c.equal(ids(result.items), ids(first.items), `${what}: the items of E2E-01 in its order`);
}

export function registerOnboarding(): void {
  scenario("E2E-31", "Onboard a travel agency from the command line", async ({ c, logs }) => {
    const created = await admin(["tenant", "create", "--name", "Second Example Agency", "--slug", "second-example-agency", "--kind", "travel_agency"]);
    checkCommand(c, created, "tenant create");
    const tenant = await one<{ id: string; status: string; kind: string }>(
      state.dbUrl,
      "select id, status::text as status, kind::text as kind from tenant where slug = 'second-example-agency'",
    );
    c.equal([tenant.status, tenant.kind], ["active", "travel_agency"], "the tenant");
    const added = await admin(["user", "add", "--tenant", "second-example-agency", "--name", "Second Planner", "--email", SECOND]);
    checkCommand(c, added, "user add");
    const user = await one<{ role: string; tenant_id: string }>(state.dbUrl, `select role::text as role, tenant_id from "user" where email = ${literal(SECOND)}`);
    c.equal([user.role, user.tenant_id], ["client", tenant.id], "the user's role and tenant");

    const person = await issue(c, "second person", SECOND, "planning desk", "person");
    const agent = await issue(c, "second agent", SECOND, "trip assistant", "agent");
    if (person) {
      const rest = await restSearch(person);
      c.equal(rest.status, 200, "the person key's REST search, with no wait");
      sameAsWinter(c, rest.json, "the person key's REST search");
    }
    if (agent) {
      const session = await connect(mainServer(), agent);
      try {
        const answer = await session.callTool("search_experiences", { ...WINTER, limit: 100 });
        c.ok(!answer.isError, "the agent key's MCP search is not an error");
        sameAsWinter(c, answer.structuredContent, "the agent key's MCP search");
      } finally {
        await session.close();
      }
    }

    const listed = await admin(["key", "list", "--user", SECOND]);
    checkCommand(c, listed, "key list");
    c.ok(/enabled\s+person\s+planning desk/.test(listed.stdout), `the list shows the person key enabled: ${listed.stdout.trim()}`);
    c.ok(/enabled\s+agent\s+trip assistant/.test(listed.stdout), "the list shows the agent key enabled");
    c.ok(!/mev_/.test(listed.output), "the list holds no key");
    const shown = await admin(["tenant", "show", "--slug", "second-example-agency"]);
    checkCommand(c, shown, "tenant show");
    c.ok(shown.stdout.includes(SECOND) && (shown.stdout.match(/<[^>]+@[^>]+>/g) ?? []).length === 1, `the tenant shows its one user: ${shown.stdout.trim()}`);

    const again = await admin(["tenant", "create", "--name", "Second Example Agency", "--slug", "second-example-agency", "--kind", "travel_agency"]);
    c.ok(again.code === 1 && /slug/i.test(again.stderr) && /taken|already|exists/i.test(again.stderr), `creating it again fails and says the slug is taken: ${again.stderr.trim()}`);
    const twice = await admin(["user", "add", "--tenant", "second-example-agency", "--name", "Second Planner", "--email", SECOND]);
    c.ok(twice.code === 1 && /email/i.test(twice.stderr) && /taken|already|exists/i.test(twice.stderr), `adding the user again fails and says the email is taken: ${twice.stderr.trim()}`);

    logs((lc) => {
      const lines = [created, added, ...state.commands.filter((one) => one.command.includes("key issue"))].flatMap(logLinesOf);
      lc.ok(lines.some((line) => line.msg === "Tenant created" && line.level === LEVEL.info), "the command logs the tenant created at info");
      lc.ok(lines.some((line) => line.msg === "User created" && line.level === LEVEL.info), "the command logs the user added at info");
      const issuedLines = lines.filter((line) => line.msg === "Credential issued");
      lc.ok(issuedLines.length >= 2, "the command logs each key issued, with the subject");
      lc.ok(issuedLines.every((line) => JSON.stringify(line).search(/mev_/) === -1), "the issued key is not in its log line");
      for (const refused of [again, twice]) {
        const line = logLinesOf(refused).find((one) => one.msg === "Admin command refused");
        lc.ok(line?.level === LEVEL.warn && typeof line.reason === "string", `a refused command is logged at warn with its reason: ${refused.stderr.trim().slice(0, 80)}`);
      }
    });
  });

  scenario("E2E-32", "Onboard a travel app from the command line", async ({ c }) => {
    const created = await admin([
      "tenant", "create", "--name", "Second Example App", "--slug", "second-example-app", "--kind", "travel_app", "--configuration", '{"currency":"ZAR"}',
    ]);
    checkCommand(c, created, "tenant create");
    const tenant = await one<{ kind: string; status: string; configuration: unknown }>(
      state.dbUrl,
      "select kind::text as kind, status::text as status, configuration from tenant where slug = 'second-example-app'",
    );
    c.equal([tenant.kind, tenant.status, tenant.configuration], ["travel_app", "active", { currency: "ZAR" }], "the tenant");
    checkCommand(c, await admin(["user", "add", "--tenant", "second-example-app", "--name", "App Assistant Owner", "--email", APP_USER]), "user add");
    const agent = await issue(c, "second app agent", APP_USER, "app assistant", "agent");
    const listed = await admin(["tenant", "list"]);
    checkCommand(c, listed, "tenant list");
    const slugs = await query<{ slug: string }>(state.dbUrl, "select slug from tenant");
    for (const { slug } of slugs) c.ok(listed.stdout.includes(slug), `tenant list shows ${slug}`);
    const shown = await admin(["tenant", "show", "--slug", "second-example-app"]);
    c.ok(shown.code === 0 && shown.stdout.includes(APP_USER) && shown.stdout.includes("travel_app"), "tenant show shows the app and its user");
    if (agent) {
      const session = await connect(mainServer(), agent);
      try {
        const answer = await session.callTool("search_experiences", { ...WINTER, limit: 100 });
        sameAsWinter(c, answer.structuredContent, "the app's key over MCP, straight away");
      } finally {
        await session.close();
      }
    }
  });

  scenario("E2E-33", "A suspended tenant is refused", async ({ c, logs }) => {
    const person = client("second person");
    const agent = client("second agent");
    checkCommand(c, await admin(["tenant", "update", "--slug", "second-example-agency", "--status", "suspended"]), "tenant update suspended");
    const refused: Call[] = [];
    for (const call of [await restSearch(person), await restSearch(agent), await mcpSearch(person), await mcpSearch(agent)]) {
      refused.push(call);
      const error = errorOf(call.json);
      c.ok(call.status === 403 && error?.code === "forbidden", `while suspended ${call.client?.label ?? ""} ${call.path} is ${call.status} ${error?.code ?? ""}`);
    }
    checkCommand(c, await admin(["tenant", "update", "--slug", "second-example-agency", "--status", "active"]), "tenant update active");
    for (const call of [await restSearch(person), await restSearch(agent), await mcpSearch(person), await mcpSearch(agent)]) {
      c.ok(call.status === 200, `once active ${call.client?.label ?? ""} ${call.path} is ${call.status}`);
      if (call.path === "/mcp") c.ok(toolResultOf(call)?.isError === false, "once active the MCP search is not a tool error");
    }
    logs((lc) => {
      for (const call of refused) {
        const line = mainServer().find((one) => one.requestId === call.requestId && one.msg === "Action refused");
        lc.ok(line?.level === LEVEL.warn && /suspend|not active/.test(String(line.reason)), `the refusal says the tenant is not active (${call.requestId ?? ""})`);
      }
    });
  });

  scenario("E2E-34", "A revoked key is refused", async ({ c }) => {
    const person = client("second person");
    const agent = client("second agent");
    const listed = await admin(["key", "list", "--user", SECOND]);
    c.ok(listed.stdout.includes(person.credentialId), "key list shows the person key's ID");
    const revoked = await admin(["key", "revoke", "--user", SECOND, "--key", person.credentialId]);
    checkCommand(c, revoked, "key revoke");
    c.ok(/revoked/i.test(revoked.stdout), `the revoke says the key is revoked: ${revoked.stdout.trim()}`);
    for (const round of [1, 2]) {
      const call = await restSearch(person);
      c.ok(call.status === 401 && errorOf(call.json)?.code === "unauthenticated", `the revoked key, try ${round}: ${call.status}`);
      c.ok(call.headers.get("www-authenticate") !== null, "the 401 has WWW-Authenticate");
    }
    c.equal((await restSearch(agent)).status, 200, "the agent key still works");
    const after = await admin(["key", "list", "--user", SECOND]);
    c.ok(/revoked\s+person\s+planning desk/.test(after.stdout), `the list shows the person key revoked: ${after.stdout.trim()}`);
    c.ok(/enabled\s+agent\s+trip assistant/.test(after.stdout), "the list shows the agent key enabled");
  });

  scenario("E2E-35", "Every tenant sees the same feed", async ({ c }) => {
    const everyone = ["agency person", "agency agent", "app person", "app agent", "second agent", "second app agent"].map(client);
    const answers: { who: string; result: unknown }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const sent = everyone.flatMap((who) => [restSearch(who), mcpSearch(who)]);
      for (const call of await Promise.all(sent)) {
        c.ok(call.status === 200, `${call.client?.label ?? ""} ${call.path}: ${call.status}`);
        const result = call.path === "/mcp" ? toolResultOf(call)?.structuredContent : call.json;
        answers.push({ who: `${call.client?.label ?? ""} ${call.path}`, result });
        const text = JSON.stringify(result ?? null);
        for (const who of everyone) {
          for (const secret of [who.email, who.userId, who.tenantSlug ?? "", who.tenantId ?? "", who.credentialId].filter(Boolean)) {
            if (text.includes(secret)) c.fail(`${call.client?.label ?? ""}'s answer holds ${secret}`);
          }
        }
      }
    }
    const [first] = answers;
    for (const answer of answers) {
      if (first && !isDeepStrictEqual(answer.result, first.result)) c.fail(`${answer.who}'s answer differs from ${first.who}'s`);
    }
  });

  scenario("E2E-36", "A client cannot reach tenants, users or keys", async ({ c }) => {
    const app = client("app person");
    const paths: [string, string, unknown][] = [
      ["GET", "/v1/tenants", undefined],
      ["GET", "/v1/tenants/example-travel-app", undefined],
      ["POST", "/v1/tenants", { name: "Sneaky", slug: "sneaky", kind: "travel_agency" }],
      ["PATCH", "/v1/tenants/example-travel-app", { status: "suspended" }],
      ["GET", `/v1/users/${app.userId}/credentials`, undefined],
      ["DELETE", `/v1/users/${app.userId}/credentials/${app.credentialId}`, undefined],
    ];
    for (const who of [client("agency person"), client("admin")]) {
      for (const [method, path, body] of paths) {
        const call = await send(mainServer(), { method, path, client: who, ...(body === undefined ? {} : { body }) });
        c.ok(call.status === 404 && errorOf(call.json)?.code === "not_found", `${who.label}: ${method} ${path} is ${call.status} ${errorOf(call.json)?.code ?? ""}`);
      }
      const session = await connect(mainServer(), who);
      try {
        const tools = await session.listTools();
        c.equal(tools.map((tool) => tool.name).sort(), ["get_experience_changes", "search_experiences"], `${who.label}: tools/list`);
      } finally {
        await session.close();
      }
      for (const name of ["list_tenants", "issue_credential"]) {
        const call = await rpc(mainServer(), who, "tools/call", { name, arguments: {} });
        const error = (call.json as { error?: { code?: number; message?: string } } | undefined)?.error;
        c.ok(call.status === 200 && error?.code === -32602, `${who.label}: tools/call ${name} is refused as unknown: ${show(call.json)}`);
      }
    }
    const document = await send(mainServer(), { path: "/openapi.json", client: client("agency person") });
    const paths2 = Object.keys((document.json as { paths?: Record<string, unknown> } | undefined)?.paths ?? {});
    c.equal(paths2.filter((path) => /tenant|user|credential/.test(path)), [], "tenant, user or credential paths in the OpenAPI document");
    c.equal((await restSearch(app)).status, 200, "the App Planner's person key still works");
    c.equal((await restSearch(client("app agent"))).status, 200, "the App Planner's agent key still works");
  });
}
