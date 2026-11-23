import { after } from "node:test";
import { anyFailed, resultsTable, writeResults } from "./harness/results.ts";
import { commitRunAgainst, tearDown } from "./harness/setup.ts";
import { state } from "./harness/state.ts";
import { registerChanges, registerNothingChanged } from "./scenarios/changes.ts";
import { registerChecks, registerSetup, registerStop } from "./scenarios/checks.ts";
import { registerEndpoints } from "./scenarios/endpoints.ts";
import { registerFeed, registerFeedChanges } from "./scenarios/feed.ts";
import { registerOnboarding } from "./scenarios/onboarding.ts";
import { registerPlanning } from "./scenarios/plan.ts";
import { registerQuality } from "./scenarios/quality.ts";
import { registerSafety, registerSweep } from "./scenarios/safety.ts";

// The scenarios, in the order they run: the set-up and its checks, the scenarios that only read, then those that
// change data in the order docs/end-to-end.md gives, the endpoint and log checks over the whole run, the clean stop,
// and the workspace checks last, as they take longest.

registerSetup();
registerPlanning();
registerFeed();
registerNothingChanged();
registerFeedChanges();
registerChanges();
registerOnboarding();
registerSafety();
registerQuality();
registerEndpoints();
registerSweep();
registerStop();
registerChecks();

after(async () => {
  const notes = await tearDown();
  const commit = await commitRunAgainst();
  const table = resultsTable({ commit, startedAt: state.startedAt, durationMs: Date.now() - state.startedAt.getTime(), notes });
  const path = writeResults(table);
  process.stdout.write(`\n${table}\nWritten to ${path}\n`);
  if (anyFailed()) process.exitCode = 1;
});
