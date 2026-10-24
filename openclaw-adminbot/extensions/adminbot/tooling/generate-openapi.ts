// Run with: node --import tsx extensions/adminbot/tooling/generate-openapi.ts [--check]
// The existing router and its TypeScript contracts are the source of truth. This
// generator projects them into OpenAPI; no per-operation route/schema table lives here.
//
// The output is deliberately a function of the API alone: no source line numbers and no hash of
// the source tree. A comment or an unrelated refactor leaves it byte-identical, so `--check` fails
// only when a route, a parameter or a request/response type actually changed.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { discoverRoutes, type Route } from "./openapi-routes.js";
import { SchemaEmitter, type Schema } from "./openapi-schema.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(extensionRoot, "../..");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const visit = (node: ts.Node, fn: (child: ts.Node) => void) => {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
};
const isRead = (node: ts.Node) =>
  ts.isCallExpression(node) && ["readJson", "readJsonOrEmpty"].includes(node.expression.getText());

const TRANSPORT_HEADERS =
  /^(authorization|cookie|origin|host|content-type|content-length|accept|user-agent|x-forwarded-.+|x-real-ip|cf-.+)$/iu;

/** The one contract file. The CLI package ships it and the service serves it. */
export const OPENAPI_OUTPUT = join(extensionRoot, "cli/openapi.generated.json");

export function buildOpenApi(root = extensionRoot) {
  const apiRoot = join(root, "src/api");
  const routeDir = join(apiRoot, "routes");
  const files = [
    ...readdirSync(apiRoot)
      .filter((file) => /^server(?:\.[\w-]+)?\.ts$/u.test(file) && !file.endsWith(".test.ts"))
      .map((file) => join(apiRoot, file)),
    ...(existsSync(routeDir)
      ? readdirSync(routeDir)
          .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
          .map((file) => join(routeDir, file))
      : []),
  ].toSorted();
  const configFile = ts.readConfigFile(join(workspaceRoot, "tsconfig.json"), (file) =>
    ts.sys.readFile(file),
  );
  const options = ts.parseJsonConfigFileContent(configFile.config, ts.sys, workspaceRoot).options;
  const program = ts.createProgram(files, { ...options, declaration: false, noEmit: true });
  const checker = program.getTypeChecker();
  const emitter = new SchemaEmitter(checker);
  const sources = files.map((file) => program.getSourceFile(file)!);
  const routes = discoverRoutes(checker, sources, apiRoot);
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();
  const anonymousRoutes = new Set<string>();
  for (const source of sources) {
    visit(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText() === "ANONYMOUS_ROUTES" &&
        node.initializer
      ) {
        visit(node.initializer, (item) => {
          if (ts.isStringLiteral(item)) {
            anonymousRoutes.add(item.text);
          }
        });
      }
    });
  }

  function nodesFor(route: Route): ts.Node[] {
    const nodes: ts.Node[] = [];
    const seen = new Set<ts.Node>();
    const collect = (rootNode: ts.Node) => {
      if (seen.has(rootNode)) {
        return;
      }
      seen.add(rootNode);
      visit(rootNode, (node) => {
        nodes.push(node);
        // Follow the request into the helpers it is handed to -- and the URL, since list routes
        // read their query through helpers such as readListPage(url).
        if (
          !ts.isCallExpression(node) ||
          !node.arguments.some((arg) => ["req", "url"].includes(arg.getText()))
        ) {
          return;
        }
        let symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        for (const declaration of symbol?.declarations ?? []) {
          if (
            ts.isFunctionDeclaration(declaration) &&
            declaration.body &&
            declaration.getSourceFile().fileName.startsWith(join(root, "src/api")) &&
            !["readJson", "readJsonOrEmpty"].includes(declaration.name?.text ?? "")
          ) {
            collect(declaration.body);
          }
        }
      });
    };
    collect(route.node);
    return nodes;
  }

  function bodySchema(nodes: ts.Node[]): Schema {
    const isRawRead = (node: ts.Expression): boolean => {
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isAwaitExpression(node)
      ) {
        return isRawRead(node.expression);
      }
      if (!ts.isCallExpression(node)) {
        return false;
      }
      if (["readJson", "readJsonOrEmpty"].includes(node.expression.getText())) {
        return true;
      }
      return (
        node.expression.getText() === "readRecord" &&
        node.arguments[0] !== undefined &&
        isRawRead(node.arguments[0])
      );
    };
    const declarations = nodes.filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        isRawRead(node.initializer),
    );
    const candidates: Schema[] = [];
    let hasTypedRead = false;
    const inferred: Record<string, Schema> = {};
    for (const declaration of declarations) {
      const name = declaration.name.getText();
      const declared = emitter.resolve(emitter.emit(checker.getTypeAtLocation(declaration.name)));
      if (declared.properties) {
        candidates.push(declared);
        hasTypedRead = true;
      }
      for (const node of nodes) {
        if (ts.isAsExpression(node) && node.expression.getText() === name) {
          const cast = emitter.resolve(emitter.emit(checker.getTypeAtLocation(node)));
          if (cast.properties) {
            candidates.push(cast);
          }
        }
        if (!ts.isPropertyAccessExpression(node) || node.expression.getText() !== name) {
          continue;
        }
        const key = node.name.text;
        let schema = emitter.emit(checker.getTypeAtLocation(node));
        const parent = node.parent;
        if (
          ts.isCallExpression(parent) &&
          ["asString", "String"].includes(parent.expression.getText())
        ) {
          schema = { type: "string" };
        }
        if (ts.isCallExpression(parent) && parent.expression.getText() === "Number") {
          schema = { type: "number" };
        }
        if (ts.isCallExpression(parent) && parent.expression.getText() === "Boolean") {
          schema = { type: "boolean" };
        }
        if (ts.isAsExpression(parent)) {
          schema = emitter.emit(checker.getTypeAtLocation(parent));
        }
        if (
          ts.isTypeOfExpression(parent) &&
          ts.isBinaryExpression(parent.parent) &&
          ts.isStringLiteral(parent.parent.right)
        ) {
          const type = parent.parent.right.text;
          if (["string", "number", "boolean"].includes(type)) {
            schema = { type };
          }
        }
        if (Object.keys(schema).length || !inferred[key]) {
          inferred[key] = schema;
        }
      }
    }
    // Casts at the read site outrank inferred property uses. All inferred additions
    // remain optional: a coercion is not proof of a server-side required-field rule.
    const strongest = candidates.toSorted(
      (left, right) =>
        Object.keys(right.properties as object).length -
        Object.keys(left.properties as object).length,
    )[0];
    const schema: Schema = strongest
      ? structuredClone(strongest)
      : {
          type: "object",
          properties: inferred,
          additionalProperties: true,
          "x-schema-coverage": "inferred; server validation remains authoritative",
        };
    const bodyNames = new Set(declarations.map((declaration) => declaration.name.getText()));
    const omitted = new Set<string>();
    for (const node of nodes) {
      if (
        !ts.isObjectLiteralExpression(node) ||
        !node.properties.some(
          (property) =>
            ts.isSpreadAssignment(property) && bodyNames.has(property.expression.getText()),
        )
      ) {
        continue;
      }
      let afterBody = false;
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property) && bodyNames.has(property.expression.getText())) {
          afterBody = true;
          continue;
        }
        if (!afterBody) {
          continue;
        }
        if (ts.isSpreadAssignment(property)) {
          checker
            .getPropertiesOfType(checker.getTypeAtLocation(property.expression))
            .forEach((symbol) => omitted.add(symbol.name));
        } else if (property.name) {
          omitted.add(property.name.getText().replace(/^['"]|['"]$/gu, ""));
        }
      }
    }
    const properties = { ...(schema.properties as Record<string, Schema>) };
    for (const key of omitted) {
      delete properties[key];
    }
    schema.properties = properties;
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.filter((key) => !omitted.has(String(key)));
    }
    if (!hasTypedRead) {
      delete schema.required;
      schema["x-schema-coverage"] =
        "inferred from property access or downstream casts; semantic validation remains server-side";
    }
    if (
      strongest &&
      declarations.length > 1 &&
      declarations.some(
        (declaration) =>
          !emitter.resolve(emitter.emit(checker.getTypeAtLocation(declaration.name))).properties,
      )
    ) {
      return {
        anyOf: [schema, { type: "object", additionalProperties: true }],
        "x-schema-coverage":
          "role-dependent typed and dynamic request shapes; server validation remains authoritative",
      };
    }
    return schema;
  }

  for (const route of routes) {
    const nodes = nodesFor(route);
    const operationId = `${route.method.toLowerCase()}-${
      route.path
        .split("/")
        .filter(Boolean)
        .map((segment) =>
          segment.startsWith("{") ? `by-${segment.slice(1, -1).replaceAll("_", "-")}` : segment,
        )
        .join("-") || "root"
    }`;
    if (operationIds.has(operationId)) {
      throw new Error(`Duplicate operationId: ${operationId}`);
    }
    operationIds.add(operationId);
    const parameters: Record<string, unknown>[] = [...route.path.matchAll(/\{([^}]+)\}/gu)].map(
      (match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      }),
    );
    const query = new Set<string>();
    const headers = new Set<string>();
    // `url.searchParams.get("x")`, or the same through a local alias:
    // `const params = url.searchParams; params.get("x")`.
    const isSearchParams = (expression: ts.Expression): boolean => {
      if (expression.getText() === "url.searchParams") {
        return true;
      }
      if (!ts.isIdentifier(expression)) {
        return false;
      }
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      return Boolean(
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer?.getText() === "url.searchParams",
      );
    };
    for (const node of nodes) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["get", "getAll", "has"].includes(node.expression.name.text) &&
        isSearchParams(node.expression.expression) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        query.add(node.arguments[0].text);
      }
    }
    for (const node of nodes) {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "req.headers") {
        headers.add(node.name.text);
      }
      if (
        ts.isElementAccessExpression(node) &&
        node.expression.getText() === "req.headers" &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        headers.add(node.argumentExpression.text);
      }
    }
    [...headers]
      .toSorted()
      // Credentials, and the headers a proxy or the HTTP stack sets, are not caller parameters:
      // a CLI flag for X-Forwarded-For would only be an invitation to spoof it.
      .filter((name) => !TRANSPORT_HEADERS.test(name))
      .forEach((name) => parameters.push({ name, in: "header", schema: { type: "string" } }));
    [...query]
      .toSorted()
      .forEach((name) => parameters.push({ name, in: "query", schema: { type: "string" } }));
    const responses: Record<string, Record<string, unknown>> = {};
    let hasSuccess = false;
    for (const node of nodes) {
      if (!ts.isCallExpression(node)) {
        continue;
      }
      if (node.expression.getText() === "sendServiceResult" && node.arguments[1]) {
        const result = checker.getAwaitedType(checker.getTypeAtLocation(node.arguments[1]));
        const types = result?.isUnion() ? result.types : result ? [result] : [];
        const payloads = types.flatMap((type) => {
          const payload = type.getProperty("payload");
          return payload ? [emitter.emit(checker.getTypeOfSymbolAtLocation(payload, node))] : [];
        });
        responses["2XX"] = {
          description: "Successful service result",
          content: {
            "application/json": {
              schema:
                payloads.length === 1 ? payloads[0] : payloads.length ? { anyOf: payloads } : {},
            },
          },
        };
        hasSuccess = true;
      }
      if (
        ["sendJson", "sendHtml"].includes(node.expression.getText()) &&
        node.arguments[1] &&
        ts.isNumericLiteral(node.arguments[1]) &&
        node.arguments[2]
      ) {
        const status = node.arguments[1].text;
        if (status.startsWith("2")) {
          hasSuccess = true;
        }
        responses[status] = {
          description: status.startsWith("2") ? "Success" : "Server response",
          content: {
            [node.expression.getText() === "sendHtml" ? "text/html" : "application/json"]: {
              schema:
                node.expression.getText() === "sendHtml"
                  ? { type: "string" }
                  : route.path === "/openapi.json"
                    ? { type: "object" }
                    : emitter.emit(checker.getTypeAtLocation(node.arguments[2])),
            },
          },
        };
      }
    }
    if (!hasSuccess) {
      responses["2XX"] = { description: "Success; response shape is validated by the server" };
    }
    responses.default = {
      description: "Authentication, authorization, validation, policy, or connector error",
      content: { "application/json": { schema: { type: "object", properties: { error: {} } } } },
    };
    const hasBody = !["GET", "HEAD", "DELETE"].includes(route.method) && nodes.some(isRead);
    const protectedAuth = nodes.some(
      (node) =>
        ts.isCallExpression(node) &&
        ["resolvePrincipal", "requirePrivileged", "requireMemberPrivileged"].includes(
          node.expression.getText(),
        ),
    );
    const operation = {
      operationId,
      summary: `${route.method} ${route.path}`,
      tags: [route.path.split("/")[1] || "service"],
      "x-source": relative(root, route.source.fileName),
      ...(parameters.length ? { parameters } : {}),
      ...(hasBody
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: bodySchema(nodes) } },
            },
          }
        : {}),
      ...(anonymousRoutes.has(`${route.method} ${route.path}`)
        ? { security: [{}, { bearerAuth: [] }] }
        : route.public && !protectedAuth
          ? { security: [] }
          : {}),
      responses,
    };
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.1",
    info: {
      title: "AdminBot HTTP API",
      version: "0.1.0",
      description:
        "Generated from the live TypeScript router and contracts. Request/response types are projected where statically available; dynamic records are explicitly marked. Policy and semantic validation remain server-side.",
    },
    servers: [{ url: "https://admin.safe.eu" }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: emitter.components,
    },
    "x-generated-by": "extensions/adminbot/tooling/generate-openapi.ts",
  };
}

export function generate(check = false) {
  const spec = buildOpenApi();
  const output = json(spec);
  if (check) {
    if (!existsSync(OPENAPI_OUTPUT) || readFileSync(OPENAPI_OUTPUT, "utf8") !== output) {
      throw new Error(
        `OpenAPI drift: run \`pnpm adminbot:api:generate\` and commit ${relative(workspaceRoot, OPENAPI_OUTPUT)}`,
      );
    }
  } else {
    writeFileSync(OPENAPI_OUTPUT, output);
  }
  const count = Object.values(spec.paths).reduce((sum, path) => sum + Object.keys(path).length, 0);
  console.log(
    `${check ? "Checked" : "Generated"} OpenAPI: ${count} operations, ${Object.keys(spec.components.schemas).length} schemas`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generate(process.argv.includes("--check"));
}
