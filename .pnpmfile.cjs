// TypeScript 7 ships no JS compiler API yet. typescript-eslint needs it, so its packages
// get TS 6's API (@typescript/typescript6) instead of the workspace's TypeScript 7.
const TS6 = "npm:@typescript/typescript6@^6.0.2";
const needsTs6 = (name) =>
  name === "typescript-eslint" || name === "ts-api-utils" || name.startsWith("@typescript-eslint/");

// drizzle-orm lists every database driver and tracing library as an optional peer. pnpm installs one copy of it for
// each set of those peers a project happens to have, so the API and the db package would get two copies whose types
// do not match. The workspace uses it with postgres only, so that is the one peer it keeps.
const DRIZZLE_PEERS = ["postgres"];

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (needsTs6(pkg.name) && (pkg.peerDependencies?.typescript || pkg.dependencies?.typescript)) {
        delete pkg.peerDependencies?.typescript;
        delete pkg.peerDependenciesMeta?.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
      }
      if (pkg.name === "drizzle-orm") {
        for (const field of ["peerDependencies", "peerDependenciesMeta"]) {
          pkg[field] = Object.fromEntries(Object.entries(pkg[field] ?? {}).filter(([name]) => DRIZZLE_PEERS.includes(name)));
        }
      }
      return pkg;
    },
  },
};
