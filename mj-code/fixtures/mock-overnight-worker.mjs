import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.env.MJ_OVERNIGHT_REPO_ROOT;
if (!repoRoot) {
  throw new Error("Missing MJ_OVERNIGHT_REPO_ROOT.");
}

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}

const outputPath = path.join(repoRoot, "overnight-demo.txt");
await fs.writeFile(outputPath, "overnight iteration 1\n", "utf8");
process.stdout.write(`worker wrote ${outputPath}\n`);
process.stdout.write(`prompt preview: ${prompt.slice(0, 120)}\n`);
