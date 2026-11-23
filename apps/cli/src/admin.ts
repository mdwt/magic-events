import { createDb } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { loadSettings } from "@magic-events/core/adapters/settings/env.ts";
import { CALLER_KINDS, type CallerKind, type Identity } from "@magic-events/core/identity/ports.ts";
import {
  TENANT_KINDS,
  TENANT_STATUSES,
  type Organizations,
  type Tenant,
  type TenantKind,
  type TenantStatus,
  type UpdateTenantInput,
  type User,
} from "@magic-events/core/organizations/ports.ts";
import { createServices } from "@magic-events/core/services.ts";
import { AppError } from "@magic-events/core/shared/errors.ts";

// What a system admin does, from the command line: onboarding a tenant, adding its users, issuing and revoking their
// API keys, and suspending a tenant. The API is for clients and has no admin endpoints. One command per run.
//
//   pnpm cli:admin tenant create --name NAME --slug SLUG --kind travel_agency|travel_app [--configuration JSON]
//   pnpm cli:admin tenant list
//   pnpm cli:admin tenant show --slug SLUG                       the tenant and its users
//   pnpm cli:admin tenant update --slug SLUG [--name NAME] [--status active|suspended] [--configuration JSON]
//   pnpm cli:admin user add --tenant SLUG --name NAME --email EMAIL     a client user of that tenant
//   pnpm cli:admin key issue --user EMAIL --name NAME --kind person|agent   prints the key, once
//   pnpm cli:admin key list --user EMAIL                         the user's keys, never the keys themselves
//   pnpm cli:admin key revoke --user EMAIL --key CREDENTIAL_ID
//
// A user is named by their email address. --configuration is a JSON object, and replaces the whole configuration.

export const USAGE = [
  "admin tenant create --name NAME --slug SLUG --kind travel_agency|travel_app [--configuration JSON]",
  "admin tenant list",
  "admin tenant show --slug SLUG",
  "admin tenant update --slug SLUG [--name NAME] [--status active|suspended] [--configuration JSON]",
  "admin user add --tenant SLUG --name NAME --email EMAIL",
  "admin key issue --user EMAIL --name NAME --kind person|agent",
  "admin key list --user EMAIL",
  "admin key revoke --user EMAIL --key CREDENTIAL_ID",
];

// A command line that does not say one command with what it needs. Nothing has been asked of the services.
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type AdminCommand =
  | { command: "tenant create"; name: string; slug: string; kind: TenantKind; configuration?: Record<string, unknown> }
  | { command: "tenant list" }
  | { command: "tenant show"; slug: string }
  | { command: "tenant update"; slug: string; changes: UpdateTenantInput }
  | { command: "user add"; tenant: string; name: string; email: string }
  | { command: "key issue"; user: string; name: string; kind: CallerKind }
  | { command: "key list"; user: string }
  | { command: "key revoke"; user: string; key: string };

// The options each command takes: those it needs, then those it may be given.
const OPTIONS = {
  "tenant create": { required: ["--name", "--slug", "--kind"], optional: ["--configuration"] },
  "tenant list": { required: [], optional: [] },
  "tenant show": { required: ["--slug"], optional: [] },
  "tenant update": { required: ["--slug"], optional: ["--name", "--status", "--configuration"] },
  "user add": { required: ["--tenant", "--name", "--email"], optional: [] },
  "key issue": { required: ["--user", "--name", "--kind"], optional: [] },
  "key list": { required: ["--user"], optional: [] },
  "key revoke": { required: ["--user", "--key"], optional: [] },
} as const satisfies Record<AdminCommand["command"], { required: readonly string[]; optional: readonly string[] }>;

type CommandName = keyof typeof OPTIONS;

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(OPTIONS, name);
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

function oneOf<T extends string>(option: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((one) => one === value);
  if (found === undefined) throw new UsageError(`${option} must be ${allowed.join(" or ")}, not "${value}".`);
  return found;
}

function jsonObject(option: string, value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${option} must be a JSON object, such as '{"currency":"ZAR"}'.`);
  }
  return { ...parsed };
}

// The options given after the command, as --name value pairs, each one the command takes and each given once.
function readOptions(name: CommandName, args: string[]): Map<string, string> {
  const { required, optional } = OPTIONS[name];
  const takes: readonly string[] = [...required, ...optional];
  const given = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index] ?? "";
    if (!option.startsWith("--")) throw new UsageError(`Unexpected "${option}". Give options as --name value.`);
    if (!takes.includes(option)) {
      throw new UsageError(
        takes.length === 0
          ? `admin ${name} takes no options, so not ${option}.`
          : `admin ${name} does not take ${option}. It takes ${list(takes)}.`,
      );
    }
    if (given.has(option)) throw new UsageError(`Give ${option} once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`Give ${option} a value.`);
    given.set(option, value);
  }
  const missing = required.filter((option) => !given.has(option));
  if (missing.length > 0) throw new UsageError(`admin ${name} needs ${list(missing)}.`);
  return given;
}

// Reads the command line, without the program's own arguments. Fails with a UsageError, and asks nothing of the
// services, when it does not say exactly one command with what it needs.
export function parseAdmin(argv: string[]): AdminCommand {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [group, action, ...rest] = args;
  const name = `${group ?? ""} ${action ?? ""}`;
  if (!isCommand(name)) {
    throw new UsageError(
      "Say what to do: tenant create, tenant list, tenant show, tenant update, user add, key issue, key list or " +
        "key revoke.",
    );
  }
  const options = readOptions(name, rest);
  // Every option asked for here was checked as required, or is read as optional.
  const value = (option: string): string => options.get(option) ?? "";

  switch (name) {
    case "tenant create": {
      const configuration = options.get("--configuration");
      return {
        command: name,
        name: value("--name"),
        slug: value("--slug"),
        kind: oneOf("--kind", value("--kind"), TENANT_KINDS),
        ...(configuration === undefined ? {} : { configuration: jsonObject("--configuration", configuration) }),
      };
    }
    case "tenant list":
      return { command: name };
    case "tenant show":
      return { command: name, slug: value("--slug") };
    case "tenant update": {
      const changes: UpdateTenantInput = {};
      const newName = options.get("--name");
      const status = options.get("--status");
      const configuration = options.get("--configuration");
      if (newName !== undefined) changes.name = newName;
      if (status !== undefined) changes.status = oneOf<TenantStatus>("--status", status, TENANT_STATUSES);
      if (configuration !== undefined) changes.configuration = jsonObject("--configuration", configuration);
      return { command: name, slug: value("--slug"), changes };
    }
    case "user add":
      return { command: name, tenant: value("--tenant"), name: value("--name"), email: value("--email") };
    case "key issue":
      return { command: name, user: value("--user"), name: value("--name"), kind: oneOf("--kind", value("--kind"), CALLER_KINDS) };
    case "key list":
      return { command: name, user: value("--user") };
    case "key revoke":
      return { command: name, user: value("--user"), key: value("--key") };
  }
}

function tenantLines(tenant: Tenant): string[] {
  return [
    `Tenant ${tenant.slug}`,
    `  name:          ${tenant.name}`,
    `  kind:          ${tenant.kind}`,
    `  status:        ${tenant.status}`,
    `  id:            ${tenant.id}`,
    `  configuration: ${JSON.stringify(tenant.configuration)}`,
  ];
}

function person(user: User): string {
  return `${user.name} <${user.email}>`;
}

// Runs one command on the services and prints what came back. A refusal is the service's AppError, thrown as it is.
export async function runAdmin(
  command: AdminCommand,
  services: { organizations: Organizations; identity: Identity },
  print: (line: string) => void,
): Promise<void> {
  const { organizations, identity } = services;
  const printAll = (lines: string[]) => {
    for (const line of lines) print(line);
  };

  switch (command.command) {
    case "tenant create": {
      const tenant = await organizations.createTenant({
        name: command.name,
        slug: command.slug,
        kind: command.kind,
        ...(command.configuration === undefined ? {} : { configuration: command.configuration }),
      });
      print("Created the tenant, active.");
      printAll(tenantLines(tenant));
      print(`Add its first user next: admin user add --tenant ${tenant.slug} --name NAME --email EMAIL`);
      return;
    }
    case "tenant list": {
      const tenants = await organizations.listTenants();
      if (tenants.length === 0) {
        print("There are no tenants.");
        return;
      }
      const width = Math.max(...tenants.map((tenant) => tenant.slug.length));
      for (const tenant of tenants) {
        print(`${tenant.slug.padEnd(width)}  ${tenant.status.padEnd(9)}  ${tenant.kind.padEnd(13)}  ${tenant.name}`);
      }
      return;
    }
    case "tenant show": {
      const tenant = await organizations.getTenantBySlug(command.slug);
      const users = await organizations.listUsers(tenant.id);
      printAll(tenantLines(tenant));
      print(users.length === 0 ? "  users:         none" : "  users:");
      for (const user of users) print(`    ${person(user)}, ${user.role}, ${user.id}`);
      return;
    }
    case "tenant update": {
      const tenant = await organizations.updateTenant(command.slug, command.changes);
      print("Changed the tenant.");
      printAll(tenantLines(tenant));
      return;
    }
    case "user add": {
      const user = await organizations.createUser({
        name: command.name,
        email: command.email,
        role: "client",
        tenantSlug: command.tenant,
      });
      print(`Added ${person(user)} to ${command.tenant} as a client. User ID ${user.id}.`);
      print(`Issue their API keys next: admin key issue --user ${user.email} --name NAME --kind person|agent`);
      return;
    }
    case "key issue": {
      const user = await organizations.getUserByEmail(command.user);
      const issued = await identity.issueCredential({ userId: user.id, kind: command.kind, name: command.name });
      const rule = "=".repeat(78);
      print(rule);
      print("NEW API KEY, SHOWN ONCE. It is stored only as a hash and cannot be shown again.");
      print(rule);
      print(`${person(user)}, ${command.kind} key "${command.name.trim()}", credential ID ${issued.id}`);
      print(`  ${issued.key}`);
      print(rule);
      return;
    }
    case "key list": {
      const user = await organizations.getUserByEmail(command.user);
      const credentials = await identity.listCredentials(user.id);
      if (credentials.length === 0) {
        print(`${person(user)} has no API keys.`);
        return;
      }
      print(`The API keys of ${person(user)}:`);
      for (const credential of credentials) {
        const state = credential.enabled ? "enabled" : "revoked";
        print(`  ${credential.id}  ${state}  ${credential.kind.padEnd(6)}  ${credential.name ?? "(no name)"}`);
      }
      return;
    }
    case "key revoke": {
      const user = await organizations.getUserByEmail(command.user);
      const revoked = await identity.revokeCredential(user.id, command.key);
      print(
        `Revoked the ${revoked.kind} key "${revoked.name ?? "(no name)"}" of ${person(user)}, ID ${revoked.id}. ` +
          "Every call with it is refused from now on.",
      );
      return;
    }
  }
}

// What the operator reads when a command fails: a usage error with the usage, or the service's message with what
// each detail says.
export function failureLines(error: unknown): string[] {
  if (error instanceof UsageError) return [error.message, "", "Usage:", ...USAGE.map((line) => `  ${line}`)];
  if (error instanceof AppError) {
    return [error.message, ...(error.details ?? []).map((detail) => `  ${detail.path}: ${detail.message}`)];
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function main(): Promise<void> {
  const command = parseAdmin(process.argv.slice(2));
  const settings = loadSettings();
  const logger = createLogger(settings.api);
  const { db, close } = createDb(settings.database.url, { max: 1 });
  try {
    const { organizations, identity } = createServices({ settings, db, logger });
    await runAdmin(command, { organizations, identity }, (line) => {
      console.log(line);
    });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    for (const line of failureLines(error)) console.error(line);
    process.exitCode = 1;
  }
}
