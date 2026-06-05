import process from "node:process";

function buildDecision() {
  const reviewRound = Number.parseInt(process.env.MJ_OVERNIGHT_REVIEW_ROUND ?? "0", 10);
  if (reviewRound === 0) {
    return {
      status: "continue",
      summary: "Seed the first overnight implementation step.",
      findings: ["Start with a small, verifiable change."],
      next_prompt: "Create overnight-demo.txt in the repo root with the exact text: overnight iteration 1",
      suggested_checks: ["Verify overnight-demo.txt exists"],
    };
  }

  return {
    status: "stop",
    summary: "The mock worker completed the requested overnight demo change.",
    findings: ["The handoff loop executed at least one worker iteration."],
    next_prompt: "",
    suggested_checks: ["Inspect overnight-demo.txt"],
  };
}

process.stdout.write(`${JSON.stringify(buildDecision())}\n`);
