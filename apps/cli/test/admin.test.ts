import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AppError } from "@magic-events/core/shared/errors.ts";
import { createHarness, type Harness } from "@magic-events/core/testing/harness.ts";
import { failureLines, parseAdmin, runAdmin, UsageError } from "../src/admin.ts";

// UC4 through the command line: a system admin onboards a travel agency, and the keys it issues then work. Each
// command is run as the operator types it, against the test database, without spawning a process.

let harness: Harness;

before(async () => {
  harness = await createHarness();
});

after(() => harness.close());

// Runs one command line and returns what it printed.
async function admin(...argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  await runAdmin(parseAdmin(argv), harness.services, (line) => lines.push(line));
  return lines;
}

function failsWith(code: AppError["code"], message?: RegExp) {
  return (error: unknown) => error instanceof AppError && error.code === code && (message?.test(error.message) ?? true);
}

function unauthenticated(error: unknown): boolean {
  return error instanceof AppError && error.code === "unauthenticated";
}

function forbidden(error: unknown): boolean {
  return error instanceof AppError && error.code === "forbidden";
}

// The key in what key issue printed, on its own line.
function keyIn(lines: string[]): string {
  const line = lines.find((one) => /^\s+mev_/.test(one));
  assert.ok(line, lines.join("\n"));
  return line.trim();
}

function credentialIdIn(lines: string[]): string {
  const match = /credential ID (\S+)$/.exec(lines.find((one) => one.includes("credential ID")) ?? "");
  assert.ok(match?.[1], lines.join("\n"));
  return match[1];
}

describe("UC4: a system admin onboards a travel agency from the command line", () => {
  const EMAIL = "thandi@fynbos.example.com";
  let personKey: string;
  let agentKey: string;
  let personKeyId: string;

  test("tenant create makes an active travel agency with its configuration", async () => {
    const lines = await admin(
      "tenant", "create", "--name", "Fynbos Journeys", "--slug", "fynbos-journeys", "--kind", "travel_agency",
      "--configuration", '{"currency":"ZAR"}',
    );
    assert.equal(lines[0], "Created the tenant, active.");
    assert.ok(lines.includes("Tenant fynbos-journeys"));
    assert.ok(lines.includes("  status:        active"));
    assert.ok(lines.includes('  configuration: {"currency":"ZAR"}'));
    const tenant = await harness.services.organizations.getTenantBySlug("fynbos-journeys");
    assert.equal(tenant.kind, "travel_agency");
    assert.deepEqual(tenant.configuration, { currency: "ZAR" });
  });

  test("tenant list shows it", async () => {
    const lines = await admin("tenant", "list");
    assert.ok(lines.some((line) => /^fynbos-journeys\s+active\s+travel_agency\s+Fynbos Journeys$/.test(line)), lines.join("\n"));
  });

  test("user add makes its first user, a client, with the email address lower-cased", async () => {
    const lines = await admin("user", "add", "--tenant", "fynbos-journeys", "--name", "Thandi", "--email", "Thandi@Fynbos.example.com");
    assert.match(lines[0] ?? "", /^Added Thandi <thandi@fynbos\.example\.com> to fynbos-journeys as a client\. User ID /);
    const user = await harness.services.organizations.getUserByEmail(EMAIL);
    assert.equal(user.role, "client");
    assert.equal(user.tenantId, (await harness.services.organizations.getTenantBySlug("fynbos-journeys")).id);
  });

  test("tenant show gives the tenant and its users", async () => {
    const lines = await admin("tenant", "show", "--slug", "fynbos-journeys");
    assert.ok(lines.includes("Tenant fynbos-journeys"));
    assert.ok(lines.some((line) => line.startsWith("    Thandi <thandi@fynbos.example.com>, client, ")), lines.join("\n"));
  });

  test("key issue prints a person's key and an agent's key once, in the marked block", async () => {
    const person = await admin("key", "issue", "--user", EMAIL, "--name", "planning desk", "--kind", "person");
    assert.ok(person.some((line) => line.includes("SHOWN ONCE") && line.includes("cannot be shown again")));
    assert.ok(person.some((line) => line.startsWith('Thandi <thandi@fynbos.example.com>, person key "planning desk"')));
    personKey = keyIn(person);
    personKeyId = credentialIdIn(person);
    // Only the one line carries the key.
    assert.equal(person.filter((line) => line.includes(personKey)).length, 1);

    // The address may be written in any case.
    agentKey = keyIn(await admin("key", "issue", "--user", "THANDI@fynbos.example.com", "--name", "trip assistant", "--kind", "agent"));
    assert.notEqual(personKey, agentKey);
  });

  test("both keys authenticate at once as that user, in that tenant, and may search", async () => {
    const user = await harness.services.organizations.getUserByEmail(EMAIL);
    for (const [key, kind] of [[personKey, "person"], [agentKey, "agent"]] as const) {
      const caller = await harness.services.identity.authenticate(key);
      assert.equal(caller.userId, user.id);
      assert.equal(caller.kind, kind);
      assert.equal(caller.tenant?.slug, "fynbos-journeys");
      harness.services.identity.authorise(caller, "experiences.search");
      harness.services.identity.authorise(caller, "mcp.use");
    }
  });

  test("key list shows both keys, enabled, without the keys themselves", async () => {
    const lines = await admin("key", "list", "--user", EMAIL);
    assert.equal(lines[0], "The API keys of Thandi <thandi@fynbos.example.com>:");
    assert.ok(lines.some((line) => line.includes(personKeyId) && /enabled\s+person\s+planning desk$/.test(line)));
    assert.ok(lines.some((line) => /enabled\s+agent\s+trip assistant$/.test(line)));
    assert.equal(lines.length, 3);
    const printed = lines.join("\n");
    assert.ok(!printed.includes(personKey));
    assert.ok(!printed.includes(agentKey));
  });

  test("suspending the tenant refuses its user's next call, and making it active lets them back in", async () => {
    const lines = await admin("tenant", "update", "--slug", "fynbos-journeys", "--status", "suspended");
    assert.equal(lines[0], "Changed the tenant.");
    assert.ok(lines.includes("  status:        suspended"));
    assert.ok(lines.includes("  name:          Fynbos Journeys"));
    const suspended = await harness.services.identity.authenticate(agentKey);
    assert.throws(() => {
      harness.services.identity.authorise(suspended, "experiences.search");
    }, forbidden);

    await admin("tenant", "update", "--slug", "fynbos-journeys", "--status", "active");
    harness.services.identity.authorise(await harness.services.identity.authenticate(agentKey), "experiences.search");
  });

  test("revoking a key refuses it from then on, while the user's other key still works", async () => {
    const lines = await admin("key", "revoke", "--user", EMAIL, "--key", personKeyId);
    assert.match(lines[0] ?? "", /^Revoked the person key "planning desk" of Thandi <thandi@fynbos\.example\.com>/);
    await assert.rejects(harness.services.identity.authenticate(personKey), unauthenticated);
    await harness.services.identity.authenticate(agentKey);

    const listed = await admin("key", "list", "--user", EMAIL);
    assert.ok(listed.some((line) => line.includes(personKeyId) && line.includes("revoked")), listed.join("\n"));
  });

  test("tenant update changes the name and replaces the configuration", async () => {
    await admin("tenant", "update", "--slug", "fynbos-journeys", "--name", "Fynbos Journeys Ltd", "--configuration", "{}");
    const tenant = await harness.services.organizations.getTenantBySlug("fynbos-journeys");
    assert.equal(tenant.name, "Fynbos Journeys Ltd");
    assert.deepEqual(tenant.configuration, {});
    assert.equal(tenant.status, "active");
  });

  test("a taken slug, a taken email and things that do not exist are the service's refusals", async () => {
    await assert.rejects(
      admin("tenant", "create", "--name", "Copy", "--slug", "fynbos-journeys", "--kind", "travel_app"),
      failsWith("conflict"),
    );
    await assert.rejects(
      admin("user", "add", "--tenant", "fynbos-journeys", "--name", "Thandi again", "--email", EMAIL),
      failsWith("conflict"),
    );
    await assert.rejects(admin("tenant", "show", "--slug", "nowhere"), failsWith("not_found", /nowhere/));
    await assert.rejects(admin("tenant", "update", "--slug", "nowhere", "--status", "active"), failsWith("not_found"));
    await assert.rejects(admin("tenant", "update", "--slug", "fynbos-journeys"), failsWith("invalid_input"));
    await assert.rejects(
      admin("user", "add", "--tenant", "nowhere", "--name", "X", "--email", "x@example.com"),
      failsWith("not_found"),
    );
    await assert.rejects(
      admin("key", "issue", "--user", "nobody@example.com", "--name", "desk", "--kind", "person"),
      failsWith("not_found", /nobody@example\.com/),
    );
    await assert.rejects(admin("key", "list", "--user", "nobody@example.com"), failsWith("not_found"));
    await assert.rejects(admin("key", "revoke", "--user", EMAIL, "--key", "no-such-key"), failsWith("not_found"));
    await assert.rejects(
      admin("tenant", "create", "--name", "Bad", "--slug", "Bad Slug", "--kind", "travel_app"),
      failsWith("invalid_input"),
    );
    await assert.rejects(
      admin("user", "add", "--tenant", "fynbos-journeys", "--name", "X", "--email", "not-an-email"),
      failsWith("invalid_input"),
    );
  });

  test("a key is revoked only through its own user", async () => {
    const other = await harness.createCaller();
    const otherUser = (await harness.services.organizations.getMembership(other.userId))?.user;
    assert.ok(otherUser);
    const agentKeyId = (await harness.services.identity.listCredentials(
      (await harness.services.organizations.getUserByEmail(EMAIL)).id,
    )).find((one) => one.kind === "agent")?.id;
    assert.ok(agentKeyId);
    await assert.rejects(admin("key", "revoke", "--user", otherUser.email, "--key", agentKeyId), failsWith("not_found"));
    await harness.services.identity.authenticate(agentKey);
  });

  test("a refusal prints the service's message and what each detail says", async () => {
    const error: unknown = await admin("tenant", "create", "--name", "Copy", "--slug", "fynbos-journeys", "--kind", "travel_app")
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof AppError);
    assert.ok((error.details ?? []).length > 0);
    assert.deepEqual(failureLines(error), [
      error.message,
      ...(error.details ?? []).map((detail) => `  ${detail.path}: ${detail.message}`),
    ]);
  });
});

describe("usage errors", () => {
  const CASES: [string[], RegExp][] = [
    [[], /^Say what to do: tenant create, .* or key revoke\.$/],
    [["tenant"], /^Say what to do/],
    [["tenant", "delete", "--slug", "x"], /^Say what to do/],
    [["users", "add"], /^Say what to do/],
    [["tenant", "create", "--name", "X", "--slug", "x"], /^admin tenant create needs --kind\.$/],
    [["tenant", "create"], /^admin tenant create needs --name, --slug and --kind\.$/],
    [["tenant", "create", "--name", "X", "--slug", "x", "--kind", "hotel"], /^--kind must be travel_agency or travel_app, not "hotel"\.$/],
    [["tenant", "create", "--name", "X", "--slug", "x", "--kind", "travel_app", "--configuration", "[1]"], /^--configuration must be a JSON object/],
    [["tenant", "create", "--name", "X", "--slug", "x", "--kind", "travel_app", "--configuration", "{nope"], /^--configuration must be a JSON object/],
    [["tenant", "create", "--name", "--slug", "x", "--kind", "travel_app"], /^Give --name a value\.$/],
    [["tenant", "create", "--name", "X", "--name", "Y", "--slug", "x", "--kind", "travel_app"], /^Give --name once\.$/],
    [["tenant", "create", "--name", "X", "--slug", "x", "--kind", "travel_app", "--status", "active"], /^admin tenant create does not take --status\. It takes --name, --slug, --kind and --configuration\.$/],
    [["tenant", "list", "--slug", "x"], /^admin tenant list takes no options, so not --slug\.$/],
    [["tenant", "list", "extra"], /^Unexpected "extra"\. Give options as --name value\.$/],
    [["tenant", "show"], /^admin tenant show needs --slug\.$/],
    [["tenant", "show", "--slug"], /^Give --slug a value\.$/],
    [["tenant", "update", "--status", "active"], /^admin tenant update needs --slug\.$/],
    [["tenant", "update", "--slug", "x", "--status", "paused"], /^--status must be active or suspended, not "paused"\.$/],
    [["tenant", "update", "--slug", "x", "--configuration", "null"], /^--configuration must be a JSON object/],
    [["user", "add", "--tenant", "x", "--name", "Ann"], /^admin user add needs --email\.$/],
    [["user", "add", "--tenant", "x", "--name", "Ann", "--email", "a@b.example", "--role", "system_admin"], /^admin user add does not take --role\./],
    [["key", "issue", "--user", "a@b.example", "--name", "desk"], /^admin key issue needs --kind\.$/],
    [["key", "issue", "--user", "a@b.example", "--name", "desk", "--kind", "robot"], /^--kind must be person or agent, not "robot"\.$/],
    [["key", "list"], /^admin key list needs --user\.$/],
    [["key", "revoke", "--user", "a@b.example"], /^admin key revoke needs --key\.$/],
    [["key", "revoke", "--key", "k1"], /^admin key revoke needs --user\.$/],
  ];

  for (const [argv, message] of CASES) {
    test(`admin ${argv.join(" ")}`.trim(), () => {
      assert.throws(() => parseAdmin(argv), (error: unknown) => error instanceof UsageError && message.test(error.message));
    });
  }

  test("a usage error prints the usage of every command", () => {
    const lines = failureLines(new UsageError("admin key list needs --user."));
    assert.equal(lines[0], "admin key list needs --user.");
    assert.ok(lines.includes("Usage:"));
    for (const command of ["tenant create", "tenant list", "tenant show", "tenant update", "user add", "key issue", "key list", "key revoke"]) {
      assert.ok(lines.some((line) => line.startsWith(`  admin ${command}`)), command);
    }
  });

  test("the -- that a package runner puts before the arguments is passed over", () => {
    assert.deepEqual(parseAdmin(["--", "tenant", "list"]), { command: "tenant list" });
  });
});
