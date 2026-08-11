import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateOpenAPIDocument } from "../src/api/openapi";

const arguments_ = process.argv.slice(2);
const outputIndex = arguments_.indexOf("--output");
const output = resolve(
  process.cwd(),
  outputIndex >= 0 && arguments_[outputIndex + 1]
    ? arguments_[outputIndex + 1]
    : "openapi/cominavi-openapi.json",
);
const check = arguments_.includes("--check");
const contents = `${JSON.stringify(await generateOpenAPIDocument(), null, 2)}\n`;

if (check) {
  const existing = await readFile(output, "utf8").catch(() => null);
  if (existing !== contents) {
    throw new Error(
      `OpenAPI document is stale: ${output}. Run pnpm openapi:generate.`,
    );
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents, "utf8");
  console.log(`Wrote ${output}`);
}
