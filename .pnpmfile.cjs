// TypeScript 7 ships no JS compiler API yet. typescript-eslint needs it, so its packages
// get TS 6's API (@typescript/typescript6) instead of the workspace's TypeScript 7.
const TS6 = "npm:@typescript/typescript6@^6.0.2";
const needsTs6 = (name) =>
  name === "typescript-eslint" || name === "ts-api-utils" || name.startsWith("@typescript-eslint/");

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (needsTs6(pkg.name) && (pkg.peerDependencies?.typescript || pkg.dependencies?.typescript)) {
        delete pkg.peerDependencies?.typescript;
        delete pkg.peerDependenciesMeta?.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
      }
      return pkg;
    },
  },
};
