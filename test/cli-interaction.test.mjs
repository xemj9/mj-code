import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function findExpect() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["expect"]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

test("cli status, about, and history expose bounded operator summaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-cli-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });

  const about = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "about",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });
  assert.match(about.stdout, /谢明锦/);
  assert.match(about.stdout, /Xie Mingjin/);

  const status = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "status",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });
  assert.match(status.stdout, /^Status$/m);
  assert.match(status.stdout, /Now: session=inspect-only · continuity=unavailable/);
  assert.match(status.stdout, /Work: plan=idle · verifier=none · runtime=/);
  assert.match(status.stdout, /Mode: mock\/mock-mj-code-v1 · approval=on-write · net=docs-only · tokens=0/);

  const history = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "history",
    "all",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });
  assert.match(history.stdout, /History · all/);
  assert.match(history.stdout, /Focus: none · ref=current -> unavailable/);
  assert.match(history.stdout, /Guide: open status · recommended=none · paths=0/);
  assert.match(history.stdout, /Why: no recorded session continuity exists yet/);

  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "run",
    "What",
    "is",
    "the",
    "current",
    "working",
    "directory?",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });

  const lineage = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "history",
    "lineage",
    "latest",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });
  assert.match(lineage.stdout, /History · lineage/);
  assert.match(lineage.stdout, /Tree: root=/);

  const replay = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "history",
    "replay",
    "latest",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });
  assert.match(replay.stdout, /History · replay/);
  assert.match(replay.stdout, /Replay: .* · prompts=/);

  const recommend = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "resume",
    "recommend",
    "latest",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd() });
  assert.match(recommend.stdout, /^Resume$/m);
  assert.match(recommend.stdout, /Guide: target=.* · status=(recommended|discouraged|not_needed|unavailable) · next=/);
});

test("interactive repl accepts piped slash commands without tty-only readline failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-repl-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });

  const child = spawn(process.execPath, [
    "src/cli.mjs",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end("/\n/status\n/history sessions summary\n/history lineage latest summary\n/resume recommend latest summary\n/about\n/exit\n");

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /^MJ Code · mock\/mock-mj-code-v1 · \/ commands · \/continue$/m);
  assert.match(stdout, /╭─+ Launcher · start/);
  assert.match(stdout, /start with \/continue, \/status, or \/history/);
  assert.match(stdout, /\/continue/);
  assert.match(stdout, /\/history sessions/);
  assert.match(stdout, /↵ \/continue/);
  assert.match(stdout, /^Status$/m);
  assert.match(stdout, /History · sessions/);
  assert.match(stdout, /History · lineage/);
  assert.match(stdout, /^Resume$/m);
  assert.match(stdout, /MJ Code · xiemingjin edition/);
  assert.doesNotMatch(stdout, /readline was closed/);
});

test("interactive repl routes unknown slash queries into the compact query fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-query-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });

  const child = spawn(process.execPath, [
    "src/cli.mjs",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.end("/res\n/exit\n");

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0);
  assert.match(stdout, /╭─+ Launcher/);
  assert.match(stdout, /\/res · \d+ matches/);
  assert.match(stdout, /◆ \/resume/);
  assert.doesNotMatch(stdout, /◆ \/clear/);
  assert.doesNotMatch(stdout, /Unknown command/);
});

test("actual cli pty opens the bare slash overlay and enters the default continue browser", async (t) => {
  const expectPath = await findExpect();
  if (!expectPath) {
    t.skip("expect is unavailable");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-pty-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "run",
    "seed",
    "session",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });

  const expectScript = [
    "log_user 1",
    "set timeout 12",
    `spawn ${process.execPath} src/cli.mjs --cwd ${root} --provider mock`,
    'expect "╰─ mj › "',
    'send "/\\r"',
    'expect {',
    '  -re "Launcher · start" {}',
    '  timeout { exit 2 }',
    '}',
    'expect {',
    '  -re "Continue Browser" {}',
    '  timeout { exit 3 }',
    '}',
    'send "/exit\\r"',
    "expect eof",
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(expectPath, ["-c", expectScript], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /ask MJ Code for a task, or type \//);
  assert.match(stdout, /╰─ mj › \/\r?\n/);
  assert.match(stdout, /╭─+ Launcher · start/);
  assert.match(stdout, /start with \/continue, \/status, or \/history/);
  assert.match(stdout, /\/continue/);
  assert.match(stdout, /\/history sessions/);
  assert.match(stdout, /↵ \/continue/);
  assert.match(stdout, /╰─+ filter · ↵ insert · esc close/);
  assert.match(stdout, /Continue Browser/);
  assert.match(stdout, /step 1 · target chooser/);
  assert.doesNotMatch(stdout, /\/continue\/exit/);
  assert.doesNotMatch(stdout, /filter \/continue\/exit/);
  assert.doesNotMatch(stdout, /Slash Launcher/);
});

test("actual cli pty can drive the history replay chooser from the compact launcher into an injected summary command", async (t) => {
  const expectPath = await findExpect();
  if (!expectPath) {
    t.skip("expect is unavailable");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-pty-replay-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "run",
    "seed",
    "session",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });

  const expectScript = [
    "log_user 1",
    "set timeout 20",
    `spawn ${process.execPath} src/cli.mjs --cwd ${root} --provider mock`,
    'expect "╰─ mj › "',
    'send "/history replay\\r"',
    'expect {',
    '  -re "Replay Chooser" {}',
    '  timeout { exit 2 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "Replay Action Picker" {}',
    '  timeout { exit 3 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "History · replay" {}',
    '  timeout { exit 4 }',
    '}',
    'send "/exit\\r"',
    "expect eof",
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(expectPath, ["-c", expectScript], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Replay Chooser/);
  assert.match(stdout, /Replay Action Picker/);
  assert.match(stdout, /History · replay/);
  assert.match(stdout, /↵ \/history replay /);
  assert.match(stdout, /runs now/);
});

test("actual cli pty can drive the resume recommendation chooser into an executed resume command", async (t) => {
  const expectPath = await findExpect();
  if (!expectPath) {
    t.skip("expect is unavailable");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-pty-resume-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "run",
    "seed",
    "session",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });

  const expectScript = [
    "log_user 1",
    "set timeout 20",
    `spawn ${process.execPath} src/cli.mjs --cwd ${root} --provider mock`,
    'expect "╰─ mj › "',
    'send "/resume recommend\\r"',
    'expect {',
    '  -re "Resume Recommendation Picker" {}',
    '  timeout { exit 2 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "Recommendation Action Picker" {}',
    '  timeout { exit 3 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "Loaded .*bootstrap" {}',
    '  timeout { exit 4 }',
    '}',
    'send "/exit\\r"',
    "expect eof",
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(expectPath, ["-c", expectScript], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Resume Recommendation Picker/);
  assert.match(stdout, /Recommendation Action Picker/);
  assert.match(stdout, /↵ resume, why, replay, lineage\./);
  assert.match(stdout, /runs now/);
  assert.match(stdout, /Loaded .*bootstrap/);
});

test("actual cli pty can drive the history sessions chooser into a replay summary command", async (t) => {
  const expectPath = await findExpect();
  if (!expectPath) {
    t.skip("expect is unavailable");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-pty-sessions-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });

  const expectScript = [
    "log_user 1",
    "set timeout 20",
    `spawn ${process.execPath} src/cli.mjs --cwd ${root} --provider mock`,
    'expect "╰─ mj › "',
    'send "/history sessions\\r"',
    'expect {',
    '  -re "Session Browser Picker" {}',
    '  timeout { exit 2 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "Session Action Picker" {}',
    '  timeout { exit 3 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "History · replay" {}',
    '  timeout { exit 4 }',
    '}',
    'send "/exit\\r"',
    "expect eof",
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(expectPath, ["-c", expectScript], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Session Browser Picker/);
  assert.match(stdout, /Session Action Picker/);
  assert.match(stdout, /History · replay/);
  assert.match(stdout, /↵ resume, replay, why, plan\./);
});

test("actual cli pty can drive the history lineage chooser from the compact launcher into a lineage summary command", async (t) => {
  const expectPath = await findExpect();
  if (!expectPath) {
    t.skip("expect is unavailable");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-pty-lineage-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "run",
    "seed",
    "session",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });

  const expectScript = [
    "log_user 1",
    "set timeout 20",
    `spawn ${process.execPath} src/cli.mjs --cwd ${root} --provider mock`,
    'expect "╰─ mj › "',
    'send "/history lineage\\r"',
    'expect {',
    '  -re "Lineage Picker" {}',
    '  timeout { exit 2 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "Lineage Action Picker" {}',
    '  timeout { exit 3 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "History · lineage" {}',
    '  timeout { exit 4 }',
    '}',
    'send "/exit\\r"',
    "expect eof",
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(expectPath, ["-c", expectScript], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Lineage Picker/);
  assert.match(stdout, /Lineage Action Picker/);
  assert.match(stdout, /History · lineage/);
  assert.match(stdout, /↵ lineage, replay, resume\./);
  assert.match(stdout, /runs now/);
});

test("actual cli pty can drive the continue browser into a lineage summary for the current session", async (t) => {
  const expectPath = await findExpect();
  if (!expectPath) {
    t.skip("expect is unavailable");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-interaction-pty-continue-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "run",
    "seed",
    "session",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });

  const expectScript = [
    "log_user 1",
    "set timeout 20",
    `spawn ${process.execPath} src/cli.mjs --cwd ${root} --provider mock`,
    'expect "╰─ mj › "',
    'send "/continue\\r"',
    'expect {',
    '  -re "Continue Browser" {}',
    '  timeout { exit 2 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "Continue Actions" {}',
    '  timeout { exit 3 }',
    '}',
    'send "\\r"',
    'expect {',
    '  -re "History · lineage" {}',
    '  timeout { exit 4 }',
    '}',
    'send "/exit\\r"',
    "expect eof",
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(expectPath, ["-c", expectScript], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Continue Browser/);
  assert.match(stdout, /Continue Actions/);
  assert.match(stdout, /History · lineage/);
  assert.match(stdout, /Open lineage/);
  assert.match(stdout, /runs now/);
});
