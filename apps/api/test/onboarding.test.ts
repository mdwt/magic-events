import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHarness, type Harness } from "./helpers/harness.ts";

// UC4: a system admin onboards a travel agency, over REST and over MCP, and the keys it issues then work.

let harness: Harness;
let adminKey: string;
let clientKey: string;

before(async () => {
  harness = await createHarness();
  ({ key: adminKey } = await harness.createCaller({ role: "system_admin" }));
  ({ key: clientKey } = await harness.createCaller());
});

after(() => harness.close());

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const SEARCH = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-06-10", to: "2027-06-20" };

interface Tenant {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  configuration: Record<string, unknown>;
}

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string | null;
}

interface Credential {
  id: string;
  name: string | null;
  kind: string;
  enabled: boolean;
}

interface Issued {
  id: string;
  key: string;
}

function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, key: string | null, payload?: object) {
  return harness.app.inject({
    method,
    url,
    headers: key === null ? {} : bearer(key),
    ...(payload === undefined ? {} : { payload }),
  });
}

// The answer's body, once its status is the one expected.
async function json<T>(response: LightMyRequestResponse | Promise<LightMyRequestResponse>, status: number): Promise<T> {
  const answer = await response;
  assert.equal(answer.statusCode, status, answer.body);
  return answer.json<T>();
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

async function search(key: string): Promise<number> {
  return (await call("POST", "/v1/experiences/search", key, SEARCH)).statusCode;
}

let nextId = 1;

function mcp(key: string, method: string, params: object) {
  return harness.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...bearer(key) },
    payload: { jsonrpc: "2.0", id: nextId++, method, params },
  });
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content: { type: string; text: string }[];
}

async function tool(key: string, name: string, args: object): Promise<ToolResult> {
  const response = await mcp(key, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ result?: ToolResult; error?: unknown }>();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  assert.ok(body.result);
  return body.result;
}

async function toolAnswer<T>(key: string, name: string, args: object): Promise<T> {
  const result = await tool(key, name, args);
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent as T;
}

function toolErrorCode(result: ToolResult): string {
  assert.equal(result.isError, true);
  const answer = JSON.parse(result.content[0]?.text ?? "{}") as { error: { code: string } };
  return answer.error.code;
}

describe("over REST", () => {
  let tenant: Tenant;
  let user: User;
  let personKey: Issued;
  let agentKey: Issued;

  test("the admin creates a travel agency, adds its first user and issues a person key and an agent key", async () => {
    tenant = await json<Tenant>(
      await call("POST", "/v1/tenants", adminKey, {
        name: "Fynbos Journeys",
        slug: "fynbos-journeys",
        kind: "travel_agency",
        configuration: { currency: "ZAR" },
      }),
      201,
    );
    assert.equal(tenant.status, "active");
    assert.equal(tenant.kind, "travel_agency");
    assert.deepEqual(tenant.configuration, { currency: "ZAR" });

    const thandi = { name: "Thandi", email: "Thandi@Fynbos.example.com" };
    user = await json<User>(call("POST", "/v1/tenants/fynbos-journeys/users", adminKey, thandi), 201);
    assert.equal(user.role, "client");
    assert.equal(user.tenantId, tenant.id);
    assert.equal(user.email, "thandi@fynbos.example.com");

    const issue = (name: string, kind: string) =>
      json<Issued>(call("POST", `/v1/users/${user.id}/credentials`, adminKey, { name, kind }), 201);
    personKey = await issue("planning desk", "person");
    agentKey = await issue("trip assistant", "agent");
    assert.ok(personKey.key.startsWith("mev_"));
    assert.deepEqual(Object.keys(personKey).sort(), ["id", "key"]);
  });

  test("the issued keys authenticate as that user and can search", async () => {
    assert.equal(await search(personKey.key), 200);
    assert.equal(await search(agentKey.key), 200);
    const caller = await harness.services.identity.authenticate(agentKey.key);
    assert.equal(caller.userId, user.id);
    assert.equal(caller.kind, "agent");
    assert.equal(caller.tenant?.id, tenant.id);
  });

  test("the credentials are listed without the keys", async () => {
    const response = await call("GET", `/v1/users/${user.id}/credentials`, adminKey);
    const { items } = await json<{ items: Credential[] }>(response, 200);
    assert.deepEqual(
      items.map(({ name, kind, enabled }) => ({ name, kind, enabled })).sort((a, b) => a.kind.localeCompare(b.kind)),
      [
        { name: "trip assistant", kind: "agent", enabled: true },
        { name: "planning desk", kind: "person", enabled: true },
      ],
    );
    assert.ok(!response.body.includes(personKey.key));
    assert.ok(!response.body.includes(agentKey.key));
  });

  test("the tenants are listed, and one tenant is read with its users", async () => {
    const { items } = await json<{ items: Tenant[] }>(call("GET", "/v1/tenants", adminKey), 200);
    assert.ok(items.some((one) => one.slug === "fynbos-journeys"));

    const read = await json<Tenant & { users: User[] }>(call("GET", "/v1/tenants/fynbos-journeys", adminKey), 200);
    assert.equal(read.id, tenant.id);
    assert.deepEqual(read.users, [user]);

    assert.equal((await call("GET", "/v1/tenants/nowhere", adminKey)).statusCode, 404);
  });

  test("revoking a key makes the next call with it 401, while the user's other key still works", async () => {
    const revoked = await json<Credential>(
      await call("DELETE", `/v1/users/${user.id}/credentials/${personKey.id}`, adminKey),
      200,
    );
    assert.equal(revoked.enabled, false);
    assert.equal(await search(personKey.key), 401);
    assert.equal(await search(agentKey.key), 200);

    const { items } = await json<{ items: Credential[] }>(call("GET", `/v1/users/${user.id}/credentials`, adminKey), 200);
    assert.equal(items.find((one) => one.id === personKey.id)?.enabled, false);
  });

  test("a credential is revoked only through its own user", async () => {
    const other = await harness.createCaller();
    const response = await call("DELETE", `/v1/users/${other.userId}/credentials/${agentKey.id}`, adminKey);
    assert.equal(response.statusCode, 404);
    assert.equal(await search(agentKey.key), 200);
    assert.equal((await call("GET", "/v1/users/no-such-user/credentials", adminKey)).statusCode, 404);
  });

  test("suspending the tenant makes its user's next call 403, and making it active again lets them back in", async () => {
    const suspend = { status: "suspended" };
    const suspended = await json<Tenant>(call("PATCH", "/v1/tenants/fynbos-journeys", adminKey, suspend), 200);
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.name, "Fynbos Journeys");
    assert.equal(await search(agentKey.key), 403);

    await json<Tenant>(call("PATCH", "/v1/tenants/fynbos-journeys", adminKey, { status: "active" }), 200);
    assert.equal(await search(agentKey.key), 200);
  });

  test("a tenant's name and configuration are changed", async () => {
    const changed = await json<Tenant>(
      await call("PATCH", "/v1/tenants/fynbos-journeys", adminKey, { name: "Fynbos Journeys Ltd", configuration: {} }),
      200,
    );
    assert.equal(changed.name, "Fynbos Journeys Ltd");
    assert.deepEqual(changed.configuration, {});
    assert.equal((await call("PATCH", "/v1/tenants/nowhere", adminKey, { status: "active" })).statusCode, 404);
  });

  test("a duplicate slug and a duplicate email are 409 conflict", async () => {
    const slug = await call("POST", "/v1/tenants", adminKey, { name: "Copy", slug: "fynbos-journeys", kind: "travel_app" });
    assert.equal(slug.statusCode, 409);
    assert.equal(errorCode(slug), "conflict");

    const email = await call("POST", "/v1/tenants/fynbos-journeys/users", adminKey, {
      name: "Thandi again",
      email: "thandi@fynbos.example.com",
    });
    assert.equal(email.statusCode, 409);
    assert.equal(errorCode(email), "conflict");
  });

  test("a bad slug, a bad email and an unknown tenant are refused", async () => {
    const slug = await call("POST", "/v1/tenants", adminKey, { name: "Bad", slug: "Bad Slug", kind: "travel_app" });
    assert.equal(slug.statusCode, 400);
    const email = await call("POST", "/v1/tenants/fynbos-journeys/users", adminKey, { name: "X", email: "not-an-email" });
    assert.equal(email.statusCode, 400);
    const unknown = await call("POST", "/v1/tenants/nowhere/users", adminKey, { name: "X", email: "x@example.com" });
    assert.equal(unknown.statusCode, 404);
  });
});

describe("over MCP", () => {
  test("the admin onboards a travel app through the tools, and its keys can search", async () => {
    const tenant = await toolAnswer<Tenant>(adminKey, "create_tenant", {
      name: "Whale Route",
      slug: "whale-route",
      kind: "travel_app",
    });
    assert.equal(tenant.status, "active");

    const user = await toolAnswer<User>(adminKey, "add_tenant_user", {
      slug: "whale-route",
      name: "Pieter",
      email: "pieter@whale-route.example.com",
    });
    assert.equal(user.tenantId, tenant.id);
    assert.equal(user.role, "client");

    const person = await toolAnswer<Issued>(adminKey, "issue_credential", {
      userId: user.id,
      name: "app backend",
      kind: "person",
    });
    const agent = await toolAnswer<Issued>(adminKey, "issue_credential", {
      userId: user.id,
      name: "app assistant",
      kind: "agent",
    });
    assert.equal(await search(person.key), 200);
    assert.equal(await search(agent.key), 200);

    const listed = await tool(adminKey, "list_credentials", { userId: user.id });
    assert.equal((listed.structuredContent as { items: Credential[] }).items.length, 2);
    assert.ok(!JSON.stringify(listed).includes(person.key));
    assert.ok(!JSON.stringify(listed).includes(agent.key));

    const { items } = await toolAnswer<{ items: Tenant[] }>(adminKey, "list_tenants", {});
    assert.ok(items.some((one) => one.slug === "whale-route"));
    const read = await toolAnswer<Tenant & { users: User[] }>(adminKey, "get_tenant", { slug: "whale-route" });
    assert.deepEqual(read.users, [user]);

    const revoke = { userId: user.id, credentialId: person.id };
    const revoked = await toolAnswer<Credential>(adminKey, "revoke_credential", revoke);
    assert.equal(revoked.enabled, false);
    assert.equal(await search(person.key), 401);
    assert.equal(await search(agent.key), 200);

    const suspended = await toolAnswer<Tenant>(adminKey, "update_tenant", { slug: "whale-route", status: "suspended" });
    assert.equal(suspended.status, "suspended");
    assert.equal(await search(agent.key), 403);
  });

  test("a duplicate slug, a duplicate email and an unknown tenant are tool errors", async () => {
    await toolAnswer(adminKey, "create_tenant", { name: "Cliff Path", slug: "cliff-path", kind: "travel_agency" });
    assert.equal(
      toolErrorCode(await tool(adminKey, "create_tenant", { name: "Copy", slug: "cliff-path", kind: "travel_app" })),
      "conflict",
    );
    const add = { slug: "cliff-path", name: "Lee", email: "lee@cliff.example.com" };
    await toolAnswer(adminKey, "add_tenant_user", add);
    assert.equal(toolErrorCode(await tool(adminKey, "add_tenant_user", add)), "conflict");
    assert.equal(toolErrorCode(await tool(adminKey, "get_tenant", { slug: "nowhere" })), "not_found");
  });

  test("the onboarding tools are listed for every caller, and only the reading ones are marked read-only", async () => {
    const response = await mcp(clientKey, "tools/list", {});
    assert.equal(response.statusCode, 200);
    const tools = response.json<{ result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }>()
      .result.tools;
    const readOnly = Object.fromEntries(tools.map((one) => [one.name, one.annotations?.readOnlyHint]));
    assert.deepEqual(
      {
        search_experiences: readOnly.search_experiences,
        list_tenants: readOnly.list_tenants,
        get_tenant: readOnly.get_tenant,
        list_credentials: readOnly.list_credentials,
        create_tenant: readOnly.create_tenant,
        update_tenant: readOnly.update_tenant,
        add_tenant_user: readOnly.add_tenant_user,
        issue_credential: readOnly.issue_credential,
        revoke_credential: readOnly.revoke_credential,
      },
      {
        search_experiences: true,
        list_tenants: true,
        get_tenant: true,
        list_credentials: true,
        create_tenant: false,
        update_tenant: false,
        add_tenant_user: false,
        issue_credential: false,
        revoke_credential: false,
      },
    );
  });
});

describe("a client", () => {
  test("is 403 on every onboarding route, and learns nothing about any tenant", async () => {
    const { userId } = await harness.createCaller();
    const routes = [
      ["POST", "/v1/tenants", { name: "Mine", slug: "mine", kind: "travel_agency" }],
      ["GET", "/v1/tenants"],
      ["GET", "/v1/tenants/fynbos-journeys"],
      ["GET", "/v1/tenants/nowhere"],
      ["PATCH", "/v1/tenants/fynbos-journeys", { status: "suspended" }],
      ["POST", "/v1/tenants/fynbos-journeys/users", { name: "Me", email: "me@example.com" }],
      ["POST", `/v1/users/${userId}/credentials`, { name: "more", kind: "agent" }],
      ["GET", `/v1/users/${userId}/credentials`],
      ["DELETE", `/v1/users/${userId}/credentials/anything`],
    ] as const;
    for (const [method, url, payload] of routes) {
      const response = await call(method, url, clientKey, payload);
      assert.equal(response.statusCode, 403, `${method} ${url}`);
      assert.equal(errorCode(response), "forbidden");
      assert.doesNotMatch(response.body, /fynbos|Thandi/i);
    }
    assert.equal((await harness.services.organizations.listTenants()).some((one) => one.slug === "mine"), false);
  });

  test("gets the forbidden tool error from every onboarding tool", async () => {
    const { userId } = await harness.createCaller();
    const calls = [
      ["create_tenant", { name: "Mine", slug: "mine", kind: "travel_agency" }],
      ["list_tenants", {}],
      ["get_tenant", { slug: "fynbos-journeys" }],
      ["update_tenant", { slug: "fynbos-journeys", status: "suspended" }],
      ["add_tenant_user", { slug: "fynbos-journeys", name: "Me", email: "me@example.com" }],
      ["issue_credential", { userId, name: "more", kind: "agent" }],
      ["list_credentials", { userId }],
      ["revoke_credential", { userId, credentialId: "anything" }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await tool(clientKey, name, args);
      assert.equal(toolErrorCode(result), "forbidden", name);
      assert.doesNotMatch(JSON.stringify(result), /fynbos|Thandi/i);
    }
  });
});

describe("without a key", () => {
  test("every onboarding route is 401", async () => {
    for (const [method, url] of [
      ["POST", "/v1/tenants"],
      ["GET", "/v1/tenants"],
      ["GET", "/v1/tenants/fynbos-journeys"],
      ["PATCH", "/v1/tenants/fynbos-journeys"],
      ["POST", "/v1/tenants/fynbos-journeys/users"],
      ["POST", "/v1/users/someone/credentials"],
      ["GET", "/v1/users/someone/credentials"],
      ["DELETE", "/v1/users/someone/credentials/anything"],
    ] as const) {
      const response = await call(method, url, null, method === "GET" || method === "DELETE" ? undefined : {});
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.equal(errorCode(response), "unauthenticated");
    }
  });
});
