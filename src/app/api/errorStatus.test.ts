import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Every API route must answer an error with an error status. This walks every
 * route file's syntax tree and flags:
 *   - a handler returning an object literal with an `error` key (or `ok: false`)
 *     as its result — withApiErrors would send that as 200;
 *   - NextResponse.json / Response.json with an `error` body and no status.
 */
const API_ROOT = path.resolve(__dirname);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
}

const propName = (p: ts.ObjectLiteralElementLike) =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;

function isErrorBody(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((p) => {
    const name = propName(p);
    if (name === "error") return true;
    return name === "ok" && ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword;
  });
}

function hasStatus(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (!ts.isObjectLiteralExpression(arg)) return true; // a variable init — can't tell; don't flag
  return arg.properties.some((p) => propName(p) === "status");
}

export function findErrorBodiesWith200(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const where = (n: ts.Node) => `${path.relative(API_ROOT, file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && isErrorBody(node.expression)) found.push(`${where(node)} returns an error body as a result`);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && isErrorBody(node.body as ts.Expression)) found.push(`${where(node)} returns an error body as a result`);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "json"
      && ["NextResponse", "Response"].includes(node.expression.expression.getText(src))
      && isErrorBody(node.arguments[0]) && !hasStatus(node.arguments[1])) {
      found.push(`${where(node)} sends an error body without a status`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

describe("API routes never answer an error with 200", () => {
  it("has no error body without an error status", () => {
    const files = routeFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(findErrorBodiesWith200)).toEqual([]);
  });
});
