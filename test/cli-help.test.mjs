import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cli help is layered into core, advanced, and debug surfaces", async () => {
  const core = await execFileAsync(process.execPath, ["src/cli.mjs", "help"], {
    cwd: process.cwd(),
  });
  assert.match(core.stdout, /Core Workflow:/);
  assert.match(core.stdout, /help advanced/);
  assert.match(core.stdout, /status \[json\|summary\]/);
  assert.match(core.stdout, /about \[json\|summary\]/);
  assert.match(core.stdout, /history \[all\|changes\|sessions\|lineage\|replay\] \[current\|latest\|<session-id>\] \[json\|summary\|failures\]/);
  assert.match(core.stdout, /resume recommend \[current\|latest\|<session-id>\] \[json\|summary\|failures\]/);
  assert.match(core.stdout, /resume lineage \[current\|latest\|<session-id>\] \[json\|summary\|failures\]/);
  assert.match(core.stdout, /--format <profile>/);
  assert.doesNotMatch(core.stdout, /search "query"/);

  const advanced = await execFileAsync(process.execPath, ["src/cli.mjs", "help", "advanced"], {
    cwd: process.cwd(),
  });
  assert.match(advanced.stdout, /Advanced Optional:/);
  assert.match(advanced.stdout, /search "query"/);
  assert.match(advanced.stdout, /plan \[task\|last\|current \[json\|summary\|failures\]\|timeline \[current\|trace\|replay:<id>\|latest\] \[json\|summary\|failures\]\]/);
  assert.match(advanced.stdout, /why \[overview\|route\|model\|tool\|plan\|verifier\] \[current\|trace\|replay:<id>\|latest\] \[json\|summary\|failures\]/);
  assert.match(advanced.stdout, /next \[current\|trace\|replay:<id>\|latest\] \[json\|summary\|failures\]/);
  assert.match(advanced.stdout, /recover \[current\|trace\|replay:<id>\|latest\] \[json\|summary\|failures\]/);

  const debug = await execFileAsync(process.execPath, ["src/cli.mjs", "help", "debug"], {
    cwd: process.cwd(),
  });
  assert.match(debug.stdout, /Debug \/ Internal:/);
  assert.match(debug.stdout, /runtime health/);
  assert.match(debug.stdout, /verifier \[trace\|replay/);
  assert.match(debug.stdout, /verifier export \[current\|trace\|replay/);
  assert.match(debug.stdout, /verifier exports \[json\|summary\]/);
  assert.match(debug.stdout, /verifier baseline pin <current\|trace\|replay:<id>\|snapshot:<id>> <name>/);
  assert.match(debug.stdout, /verifier baselines \[json\|summary\]/);
  assert.match(debug.stdout, /verifier promotion plan <baseline-name> \[latest\|<artifact-id>\] \[json\|summary\|failures\] \[--policy <profile>\]/);
  assert.match(debug.stdout, /verifier promotion approve <plan-id> \[json\|summary\|failures\] \[--approver-id <id>\] \[--approver-name <name>\] \[--approval-source <source>\] \[--approval-mode <mode>\]/);
  assert.match(debug.stdout, /verifier promotion history <baseline-name> \[json\|summary\]/);
  assert.match(debug.stdout, /verifier policies \[json\|summary\]/);
  assert.match(debug.stdout, /verifier compare <current\|trace\|replay:<id>\|snapshot:<id>\|baseline:<name>>/);
  assert.match(debug.stdout, /verifier gate <current\|trace\|replay:<id>\|snapshot:<id>\|baseline:<name>>/);
  assert.match(debug.stdout, /verifier artifacts \[json\|summary\]/);
  assert.match(debug.stdout, /verifier artifacts prune \[json\|summary\] \[--dry-run\] \[--max-count <n>\] \[--max-age-days <n>\]/);
  assert.match(debug.stdout, /verifier artifact <id> \[json\|summary\|failures\]/);
  assert.match(debug.stdout, /verifier handoff \[<artifact-id>\|latest\] \[json\|summary\|failures\]/);
  assert.match(debug.stdout, /verifier handoff export \[<artifact-id>\|latest\] \[json\|summary\]/);
  assert.match(debug.stdout, /verifier triage summary \[<artifact-id>\|latest\] \[json\|summary\|failures\] \[--github-actions\]/);
  assert.match(debug.stdout, /verifier drilldown \[<reference>\|latest\] \[json\|summary\|failures\] \[--github-actions\]/);
  assert.match(debug.stdout, /verifier timeline \[<reference>\|latest\] \[json\|summary\|failures\] \[--github-actions\]/);
  assert.match(debug.stdout, /verifier checks summary \[<artifact-id>\|latest\] \[json\|summary\] \[--github-actions\]/);
  assert.match(debug.stdout, /verifier checks export \[<artifact-id>\|latest\] \[json\|summary\] \[--github-actions\]/);
  assert.match(debug.stdout, /verifier github apply \[<artifact-id>\|latest\] \[json\|summary\|failures\] \[--github-actions\]/);
  assert.match(debug.stdout, /verifier github result \[<mutation-id>\|latest\] \[json\|summary\|failures\]/);
  assert.match(debug.stdout, /json\|summary\|failures\|repair\|context/);
  assert.match(debug.stdout, /--limit <n>/);
  assert.match(debug.stdout, /--baseline <ref>/);
  assert.match(debug.stdout, /--baseline-target <ref>/);
  assert.match(debug.stdout, /--policy <profile>/);
  assert.match(debug.stdout, /--write-artifact/);
  assert.match(debug.stdout, /--write-bundle/);
  assert.match(debug.stdout, /--dry-run/);
  assert.match(debug.stdout, /--max-count <n>/);
  assert.match(debug.stdout, /--max-age-days <n>/);
  assert.match(debug.stdout, /--github-actions/);
  assert.match(debug.stdout, /--approver-id <id>/);
  assert.match(debug.stdout, /--approver-name <name>/);
  assert.match(debug.stdout, /--approval-source <source>/);
  assert.match(debug.stdout, /--approval-mode <mode>/);
});
