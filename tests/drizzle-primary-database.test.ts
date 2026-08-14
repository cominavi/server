import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { migratedTables } from "../src/lib/db/schema";

const homepageRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeBatchBridge = "src/lib/db/batch.ts";

test("the authoritative Drizzle manifest keeps all 82 final D1 tables under parity coverage", async () => {
  assert.equal(Object.keys(migratedTables).length, 82);
  assert.equal(new Set(Object.keys(migratedTables)).size, 82);

  const parityTest = await readFile(
    join(homepageRoot, "tests/drizzle-schema.test.ts"),
    "utf8",
  );
  assert.match(
    parityTest,
    /assert\.deepEqual\(Object\.keys\(migratedTables\)\.sort\(\), migratedTableNames\)/,
    "the migration parity test must continue comparing every final D1 table to the Drizzle manifest",
  );
  for (const migration of [
    "0001",
    "0002",
    "0003",
    "0004",
    "0005",
    "0006",
    "0007",
    "0008",
    "0009",
    "0010",
  ]) {
    assert.match(
      parityTest,
      new RegExp(`migrations/${migration}_[^"']+\\.sql`),
      `the schema parity test must continue applying migration ${migration}`,
    );
  }
});

test("server persistence uses Drizzle except for the centralized native D1 batch bridge", async () => {
  const sourcePaths = [
    ...(await typeScriptFiles(join(homepageRoot, "src/lib/server"))),
    ...(await typeScriptFiles(join(homepageRoot, "src/api"))),
    join(homepageRoot, nativeBatchBridge),
  ];
  const violations: string[] = [];
  const bridgeCalls: string[] = [];

  for (const path of sourcePaths) {
    const source = await readFile(path, "utf8");
    const relativePath = relative(homepageRoot, path);
    const sourceFile = ts.createSourceFile(
      basename(path),
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const drizzleBindings = findDrizzleBindings(sourceFile);

    visit(sourceFile, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      ) {
        return;
      }
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const location = sourceLocation(relativePath, sourceFile, node);

      if (method === "prepare") {
        if (relativePath === nativeBatchBridge)
          bridgeCalls.push(`prepare:${location}`);
        else
          violations.push(
            `${location}: direct native-style .prepare() is forbidden`,
          );
      }

      if (method === "batch") {
        if (relativePath === nativeBatchBridge) {
          bridgeCalls.push(`batch:${location}`);
        } else if (!isDrizzleReceiver(receiver, drizzleBindings)) {
          violations.push(
            `${location}: binding-level .batch() is forbidden; use Drizzle db.batch() or runDrizzleBatch()`,
          );
        }
      }

      if (method === "raw" && isSQLNamespace(receiver)) {
        const argument = node.arguments[0];
        if (argument && unsafeRawSQLArgument(argument)) {
          violations.push(
            `${location}: sql.raw() must not interpolate or concatenate runtime values; use the sql template`,
          );
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Drizzle primary-database boundary violations:\n${violations.join("\n")}`,
  );
  assert.equal(
    bridgeCalls.filter((call) => call.startsWith("prepare:")).length,
    1,
    "the centralized bridge must contain exactly one native D1 prepare boundary",
  );
  assert.equal(
    bridgeCalls.filter((call) => call.startsWith("batch:")).length,
    1,
    "the centralized bridge must contain exactly one binding-level D1 batch boundary",
  );

  const bridgeSource = await readFile(
    join(homepageRoot, nativeBatchBridge),
    "utf8",
  );
  assert.match(bridgeSource, /single native preparation[\s*]+boundary/);
  assert.match(bridgeSource, /raw strings are deliberately not accepted/);
  assert.match(
    bridgeSource,
    /queries:\s*readonly \[SQLWrapper, \.\.\.SQLWrapper\[\]\]/,
    "the native bridge must accept only parameterized Drizzle SQL wrappers",
  );
  assert.match(
    bridgeSource,
    /database\.prepare\(built\.sql\)\.bind\(\.\.\.built\.params\)/,
    "the bridge must bind Drizzle-generated parameters rather than interpolate values",
  );
  assert.match(bridgeSource, /return database\.batch\(statements\)/);
});

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return paths.flat().sort();
}

function findDrizzleBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  visit(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateDatabaseCall(node.initializer)
    ) {
      bindings.add(node.name.text);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      const type = node.type.getText(sourceFile);
      if (
        type.includes("CominaviDatabase") ||
        type.includes("ReturnType<typeof createDatabase>")
      ) {
        bindings.add(node.name.text);
      }
    }
  });
  return bindings;
}

function isCreateDatabaseCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "createDatabase"
  );
}

function isDrizzleReceiver(
  receiver: ts.Expression,
  bindings: Set<string>,
): boolean {
  return (
    (ts.isIdentifier(receiver) && bindings.has(receiver.text)) ||
    isCreateDatabaseCall(receiver)
  );
}

function isSQLNamespace(receiver: ts.Expression): boolean {
  return ts.isIdentifier(receiver) && receiver.text === "sql";
}

function unsafeRawSQLArgument(argument: ts.Expression): boolean {
  return (
    ts.isTemplateExpression(argument) ||
    ts.isTaggedTemplateExpression(argument) ||
    (ts.isBinaryExpression(argument) &&
      argument.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

function sourceLocation(
  relativePath: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): string {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `${relativePath}:${position.line + 1}:${position.character + 1}`;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
