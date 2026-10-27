// Route discovery reads the router itself, never a second table of URLs.
//
// Two shapes coexist in src/api. Most routes are entries in the declarative route table
// (routes/router.ts: `get(path, handler)`, `route(methods, path, handler)`), and those are read
// straight off the entry. The rest are if-chains on `req.method` and `url.pathname`: the public and
// auth dispatchers, and the sub-routers a `"*"`, `under(...)` or `startingWith(...)` entry hands a
// whole path prefix to. Those are walked, with the table entry's path seeding the walk, and their
// conditions are expanded together so optional regex suffixes keep their original method guards.
//
// Anything that selects a method and is not covered by a discovered route fails generation, so a
// new routing style is a loud error rather than an endpoint quietly missing from the contract.
import ts from "typescript";

export type Route = {
  method: string;
  path: string;
  node: ts.Node;
  source: ts.SourceFile;
  public: boolean;
};
type Term = {
  method?: string;
  path?: string;
  /** A path the walk was seeded with, used only when the branch names no path of its own. */
  implied?: boolean;
  regex?: ts.VariableDeclaration;
  group?: number;
  truthy?: boolean;
};
type Variant = { path: string; groups: Record<number, boolean> };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const ROUTER_HELPERS = new Map<string, readonly string[]>([
  ["get", ["GET"]],
  ["post", ["POST"]],
  ["put", ["PUT"]],
  ["patch", ["PATCH"]],
  ["del", ["DELETE"]],
]);
/** Dispatchers that run before authentication; their routes need no bearer token. */
const PUBLIC_DISPATCHERS = new Set(["routeRequest", "servePublicRoute"]);
/**
 * Route modules outside the table that the auth dispatcher hands requests to, walked like auth.ts.
 * In api-tokens.ts only `handleApiTokenRoute`'s own branches (the two `adminbot login` steps a CLI
 * makes before it holds a credential) are public; its member routes sit in a separate function.
 */
const AUTH_ROUTE_MODULES = /[/\\]routes[/\\](auth|api-tokens)\.ts$/u;
const PUBLIC_AUTH_FUNCTIONS = new Set(["handleApiTokenRoute"]);
const clean = (node: ts.Node) => node.getText().replace(/\?\./gu, ".");
const where = (node: ts.Node) =>
  `${node.getSourceFile().fileName}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

/** `/member-drafts/` -> `/member-drafts/{member_drafts_id}`: an opaque tail named by its collection. */
function prefixPath(base: string): string {
  const trimmed = base.replace(/\/$/u, "");
  const collection = trimmed.split("/").at(-1) || "resource";
  return `${trimmed}/{${collection.replaceAll("-", "_")}_id}`;
}

function regexDeclaration(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.VariableDeclaration | undefined {
  const expression = ts.isElementAccessExpression(node) ? node.expression : node;
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  const init = declaration.initializer;
  if (
    ts.isCallExpression(init) &&
    ts.isPropertyAccessExpression(init.expression) &&
    init.expression.name.text === "exec" &&
    ts.isRegularExpressionLiteral(init.expression.expression) &&
    init.arguments[0]?.getText() === "url.pathname"
  ) {
    return declaration;
  }
  return undefined;
}

function terms(checker: ts.TypeChecker, node: ts.Expression): Term[][] {
  if (ts.isParenthesizedExpression(node)) {
    return terms(checker, node.expression);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return terms(checker, node.left).flatMap((left) =>
        terms(checker, node.right).map((right) => left.concat(right)),
      );
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [...terms(checker, node.left), ...terms(checker, node.right)];
    }
    if (
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      for (const [left, right] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        if (!ts.isStringLiteral(right)) {
          continue;
        }
        if (clean(left) === "req.method" && METHODS.has(right.text)) {
          return [[{ method: right.text }]];
        }
        if (clean(left) === "url.pathname") {
          return [[{ path: right.text }]];
        }
      }
    }
  }
  // `url.pathname.startsWith("/avatars/")`: a prefix whose tail the handler parses itself.
  if (
    ts.isCallExpression(node) &&
    clean(node.expression) === "url.pathname.startsWith" &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return [[{ path: prefixPath(node.arguments[0].text) }]];
  }
  const negated =
    ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
  const target = negated ? node.operand : node;
  const regex = regexDeclaration(checker, target);
  if (regex) {
    return [
      [
        {
          regex,
          ...(ts.isElementAccessExpression(target) && ts.isNumericLiteral(target.argumentExpression)
            ? { group: Number(target.argumentExpression.text) }
            : {}),
          truthy: !negated,
        },
      ],
    ];
  }
  return [[]];
}

/**
 * The name a table handler gives capture `group`, from the typed call it is passed to:
 * `service.removeBadge(decodeURIComponent(params[1]!), ...)` names capture 1 after
 * `removeBadge`'s `memberId` parameter, as `member_id`.
 */
function captureName(checker: ts.TypeChecker, handler: ts.Node, group: number): string | undefined {
  let name: string | undefined;
  const visit = (node: ts.Node) => {
    if (name) {
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.expression.getText() === "params" &&
      ts.isNumericLiteral(node.argumentExpression) &&
      Number(node.argumentExpression.text) === group
    ) {
      // Step out of `!`, parentheses and `decodeURIComponent(...)` to the call the value feeds.
      let value: ts.Expression = node;
      while (
        ts.isNonNullExpression(value.parent) ||
        ts.isParenthesizedExpression(value.parent) ||
        (ts.isCallExpression(value.parent) &&
          value.parent.expression.getText() === "decodeURIComponent")
      ) {
        value = value.parent;
      }
      const call = value.parent;
      // Read the callee's declared parameter names, not its resolved signature: resolving
      // runs inference early and reorders the properties emitted for unrelated schemas.
      if (ts.isCallExpression(call) && call.expression !== value) {
        const callee = checker.getSymbolAtLocation(call.expression)?.valueDeclaration;
        const parameter =
          callee && ts.isFunctionLike(callee)
            ? callee.parameters[call.arguments.indexOf(value)]
            : undefined;
        name =
          parameter && ts.isIdentifier(parameter.name)
            ? parameter.name.text.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()
            : undefined;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
  return name;
}

export function regexPaths(
  text: string,
  captureName?: (group: number) => string | undefined,
): Variant[] {
  const last = text.lastIndexOf("/");
  let pattern = text.slice(1, last);
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new Error(`Unanchored route regex: ${text}`);
  }
  pattern = pattern.slice(1, -1).replace(/\\\//gu, "/");
  let variants: Variant[] = [{ path: "", groups: {} }];
  let group = 0;
  for (let offset = 0; offset < pattern.length; ) {
    if (pattern.startsWith("([^/]+)", offset)) {
      group++;
      variants.forEach((variant) => {
        variant.path += `{param${group}}`;
        variant.groups[group] = true;
      });
      offset += "([^/]+)".length;
    } else if (pattern[offset] === "(" && pattern[pattern.indexOf(")", offset) + 1] !== "?") {
      // `(approve|reject)`: a fixed set of literal segments, each its own path.
      const end = pattern.indexOf(")", offset);
      const alternatives = pattern.slice(offset + 1, end).split("|");
      if (end < 0 || !alternatives.every((alternative) => /^[\w-]+$/u.test(alternative))) {
        throw new Error(`Unsupported route regex: ${text}`);
      }
      group++;
      variants = variants.flatMap((variant) =>
        alternatives.map((alternative) => ({
          path: variant.path + alternative,
          groups: { ...variant.groups, [group]: true },
        })),
      );
      offset = end + 1;
    } else if (pattern[offset] === "(") {
      const end = pattern.indexOf(")", offset);
      const literal = pattern.slice(offset + 1, end);
      if (end < 0 || pattern[end + 1] !== "?" || !/^\/[\w/-]+$/u.test(literal)) {
        throw new Error(`Unsupported route regex: ${text}`);
      }
      group++;
      variants = variants.flatMap((variant) => [
        { path: variant.path, groups: { ...variant.groups, [group]: false } },
        { path: variant.path + literal, groups: { ...variant.groups, [group]: true } },
      ]);
      offset = end + 2;
    } else {
      if (!/[\w/.-]/u.test(pattern[offset])) {
        throw new Error(`Unsupported route regex: ${text}`);
      }
      variants.forEach((variant) => {
        variant.path += pattern[offset];
      });
      offset++;
    }
  }
  // Name opaque captures by their containing collection, keeping IDs stable if a
  // later segment is added. Repeated collection names get a numeric suffix. Adjacent
  // captures (`/assignments/{member}/{badge}`) have no collection of their own, so each
  // one in such a run takes the name the handler gives it.
  const isCapture = (segment: string | undefined) => Boolean(segment?.startsWith("{param"));
  return variants.map((variant) => {
    const segments = variant.path.split("/");
    const used = new Set<string>();
    variant.path = segments
      .map((segment, index) => {
        if (!isCapture(segment)) {
          return segment;
        }
        let base = `${(segments[index - 1] || "resource").replaceAll("-", "_")}_id`;
        if (isCapture(segments[index - 1]) || isCapture(segments[index + 1])) {
          const group = Number(segment.slice("{param".length, -1));
          const named = captureName?.(group);
          if (!named) {
            throw new Error(`Cannot name capture ${group} of adjacent captures in ${text}`);
          }
          base = named;
        }
        let name = base;
        for (let suffix = 2; used.has(name); suffix++) {
          name = `${base}_${suffix}`;
        }
        used.add(name);
        return `{${name}}`;
      })
      .join("/");
    return variant;
  });
}

function candidates(branchTerms: Term[]): { method: string; path: string }[] {
  const methods = [...new Set(branchTerms.flatMap((term) => (term.method ? [term.method] : [])))];
  if (methods.length !== 1) {
    return [];
  }
  const own = (implied: boolean) =>
    branchTerms.flatMap((term) =>
      term.path && Boolean(term.implied) === implied ? [term.path] : [],
    );
  const paths = own(false);
  if (paths.length) {
    return [...new Set(paths)].map((path) => ({ method: methods[0], path }));
  }
  const declarations = [
    ...new Set(branchTerms.flatMap((term) => (term.regex ? [term.regex] : []))),
  ];
  if (declarations.length > 1) {
    throw new Error("A route combines multiple regex matchers");
  }
  if (declarations.length === 1) {
    const declaration = declarations[0];
    const expression = (declaration.initializer as ts.CallExpression)
      .expression as ts.PropertyAccessExpression;
    return regexPaths(expression.expression.getText())
      .filter((variant) =>
        branchTerms
          .filter((term) => term.regex === declaration)
          .every(
            (term) =>
              term.group === undefined || (variant.groups[term.group] ?? false) === term.truthy,
          ),
      )
      .map((variant) => ({ method: methods[0], path: variant.path }));
  }
  return [...new Set(own(true))].map((path) => ({ method: methods[0], path }));
}

/**
 * Collect the routes an if-chain selects, starting from `root` with `seed` already in force.
 *
 * `isPublic` decides, per selecting `if`, whether the route answers before authentication.
 */
function walkIfChain(
  checker: ts.TypeChecker,
  root: ts.Node,
  seed: Term[][],
  routes: Map<string, Route>,
  isPublic: (node: ts.IfStatement) => boolean,
): void {
  const source = root.getSourceFile();
  const add = (branch: Term[], node: ts.Node, publicRoute: boolean) => {
    for (const candidate of candidates(branch)) {
      const key = `${candidate.method} ${candidate.path}`;
      if (!routes.has(key)) {
        routes.set(key, { ...candidate, node, source, public: publicRoute });
      }
    }
  };
  const walk = (node: ts.Node, context: Term[][]) => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      let flow = context;
      for (const statement of node.statements) {
        walk(statement, flow);
        // `if (req.method !== "PUT") { ...; return; }` narrows every statement after it.
        if (ts.isIfStatement(statement) && /return[;\s]/u.test(statement.thenStatement.getText())) {
          const allowed: string[] = [];
          const deniedOthers = (expression: ts.Expression): boolean => {
            if (ts.isParenthesizedExpression(expression)) {
              return deniedOthers(expression.expression);
            }
            if (!ts.isBinaryExpression(expression)) {
              return false;
            }
            if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
              return deniedOthers(expression.left) && deniedOthers(expression.right);
            }
            if (
              expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
              clean(expression.left) !== "req.method" ||
              !ts.isStringLiteral(expression.right) ||
              !METHODS.has(expression.right.text)
            ) {
              return false;
            }
            allowed.push(expression.right.text);
            return true;
          };
          if (deniedOthers(statement.expression) && allowed.length) {
            flow = flow.flatMap((branch) => allowed.map((method) => branch.concat({ method })));
            for (const branch of flow) {
              add(branch, node, isPublic(statement));
            }
          }
        }
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      const own = terms(checker, node.expression);
      const next = context.flatMap((left) => own.map((right) => left.concat(right)));
      for (const branch of next) {
        add(branch, node.thenStatement, isPublic(node));
      }
      walk(node.thenStatement, next);
      if (node.elseStatement) {
        walk(node.elseStatement, context);
      }
      return;
    }
    ts.forEachChild(node, (child) => walk(child, context));
  };
  walk(root, seed);
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  let parent: ts.Node | undefined = node;
  while (parent && !ts.isFunctionDeclaration(parent)) {
    parent = parent.parent;
  }
  return parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : undefined;
}

function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** The function a table entry runs, seen through its guard decorators (`memberOnly(fn)`). */
function handlerFunction(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return expression;
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return handlerFunction(checker, expression.expression);
  }
  if (ts.isCallExpression(expression) && expression.arguments[0]) {
    return handlerFunction(checker, expression.arguments[0]);
  }
  if (ts.isIdentifier(expression)) {
    for (const declaration of resolveSymbol(checker, expression)?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) {
        return declaration;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return handlerFunction(checker, declaration.initializer);
      }
    }
  }
  return undefined;
}

/** Functions under `apiRoot` that `fn` hands the request to: the sub-router it delegates to. */
function delegates(
  checker: ts.TypeChecker,
  fn: ts.FunctionLikeDeclaration,
  apiRoot: string,
): ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.some((arg) => arg.getText() === "req")) {
      for (const declaration of resolveSymbol(checker, node.expression)?.declarations ?? []) {
        if (
          ts.isFunctionDeclaration(declaration) &&
          declaration.body &&
          declaration.getSourceFile().fileName.startsWith(apiRoot) &&
          !["readJson", "readJsonOrEmpty"].includes(declaration.name?.text ?? "") &&
          !found.includes(declaration)
        ) {
          found.push(declaration);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) {
    visit(fn.body);
  }
  return found;
}

type TablePath =
  | { kind: "exact"; path: string }
  | { kind: "regex"; text: string }
  | { kind: "prefix"; base: string; includesBase: boolean };

function tablePath(checker: ts.TypeChecker, node: ts.Expression): TablePath {
  if (ts.isStringLiteral(node)) {
    return { kind: "exact", path: node.text };
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return { kind: "regex", text: node.text };
  }
  if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    const helper = resolveSymbol(checker, node.expression)?.name;
    if (helper === "under" || helper === "startingWith") {
      return { kind: "prefix", base: node.arguments[0].text, includesBase: helper === "under" };
    }
  }
  throw new Error(`Unsupported route path in the route table at ${where(node)}`);
}

/** A call to one of routes/router.ts's entry helpers, with what it declares. */
function tableEntry(
  checker: ts.TypeChecker,
  node: ts.CallExpression,
): { methods: readonly string[] | "*"; path: ts.Expression; handler: ts.Expression } | undefined {
  if (!ts.isIdentifier(node.expression)) {
    return undefined;
  }
  const symbol = resolveSymbol(checker, node.expression);
  const declared = symbol?.declarations?.[0]?.getSourceFile().fileName ?? "";
  if (!/[/\\]routes[/\\]router\.ts$/u.test(declared)) {
    return undefined;
  }
  const name = symbol?.name ?? "";
  const fixed = ROUTER_HELPERS.get(name);
  if (fixed && node.arguments.length >= 2) {
    return { methods: fixed, path: node.arguments[0], handler: node.arguments[1] };
  }
  if (name === "route" && node.arguments.length >= 3) {
    const [methodsArg, path, handler] = node.arguments;
    if (ts.isStringLiteral(methodsArg) && methodsArg.text === "*") {
      return { methods: "*", path, handler };
    }
    if (
      ts.isArrayLiteralExpression(methodsArg) &&
      methodsArg.elements.every((element) => ts.isStringLiteral(element))
    ) {
      return {
        methods: methodsArg.elements.map((element) => (element as ts.StringLiteral).text),
        path,
        handler,
      };
    }
    throw new Error(`Unsupported route methods in the route table at ${where(methodsArg)}`);
  }
  return undefined;
}

export function discoverRoutes(
  checker: ts.TypeChecker,
  sources: ts.SourceFile[],
  apiRoot: string,
): Route[] {
  const routes = new Map<string, Route>();

  // 1. The route table. Every entry is authenticated: handleAuthenticatedRoute dispatches it after
  // resolving the principal, and ANONYMOUS_ROUTES alone widens that.
  for (const source of sources) {
    // router.ts defines the helpers in terms of each other; it declares no routes.
    if (/[/\\]routes[/\\]router\.ts$/u.test(source.fileName)) {
      continue;
    }
    const visit = (node: ts.Node) => {
      const entry = ts.isCallExpression(node) ? tableEntry(checker, node) : undefined;
      if (!entry) {
        ts.forEachChild(node, visit);
        return;
      }
      const fn = handlerFunction(checker, entry.handler);
      if (!fn) {
        throw new Error(`Unresolvable route handler at ${where(entry.handler)}`);
      }
      const path = tablePath(checker, entry.path);
      const paths =
        path.kind === "exact"
          ? [path.path]
          : path.kind === "regex"
            ? regexPaths(path.text, (group) => captureName(checker, fn, group)).map(
                (variant) => variant.path,
              )
            : [];
      if (entry.methods !== "*" && paths.length) {
        for (const method of entry.methods) {
          for (const routePath of paths) {
            const key = `${method} ${routePath}`;
            if (!routes.has(key)) {
              routes.set(key, { method, path: routePath, node: fn, source, public: false });
            }
          }
        }
        return;
      }
      // A "*" or prefix entry hands the method, and for a prefix the rest of the path, to code
      // that selects them itself. Walk that code with what the entry already fixed.
      const seedPaths =
        path.kind === "prefix"
          ? [
              path.includesBase ? path.base : undefined,
              path.base.endsWith("/") ? prefixPath(path.base) : undefined,
            ].filter((value): value is string => Boolean(value))
          : paths;
      const seed: Term[][] = (seedPaths.length ? seedPaths : [undefined]).flatMap((seedPath) => {
        const base: Term[] = seedPath ? [{ path: seedPath, implied: true }] : [];
        return entry.methods === "*"
          ? [base]
          : entry.methods.map((method) => base.concat({ method }));
      });
      const before = routes.size;
      for (const body of [fn, ...delegates(checker, fn, apiRoot)]) {
        walkIfChain(checker, body, seed, routes, () => false);
      }
      if (routes.size === before) {
        throw new Error(`Route table entry selects no operation at ${where(node)}`);
      }
    };
    visit(source);
  }

  // 2. The dispatchers outside the table: public pages, the auth endpoints, and the sub-router
  // modules (walked on their own too, which finds the same routes the seeded walk did).
  for (const source of sources) {
    if (
      /[/\\]routes[/\\]/u.test(source.fileName) &&
      !AUTH_ROUTE_MODULES.test(source.fileName)
    ) {
      continue;
    }
    walkIfChain(checker, source, [[]], routes, (node) => {
      const name = enclosingFunctionName(node);
      // An auth endpoint is public unless its branch authenticates. Reading the token directly
      // counts: /auth/impersonate/stop takes the session's token without resolving a principal,
      // and a contract calling it public would make the CLI drop the very token it needs.
      const body = node.thenStatement.getText();
      return (
        (name !== undefined && (PUBLIC_DISPATCHERS.has(name) || PUBLIC_AUTH_FUNCTIONS.has(name))) ||
        (name === "handleAuthRoute" &&
          !["resolvePrincipal(", "requirePrivileged(", "bearerToken(", "cookieToken("].some(
            (call) => body.includes(call),
          ))
      );
    });
  }

  // An unrecognized selector must fail regeneration, rather than silently hiding a
  // newly added endpoint from the published contract and CLI.
  for (const source of sources) {
    const audit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node)) {
        const method =
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
            node.operatorToken.kind,
          ) &&
          [
            [node.left, node.right],
            [node.right, node.left],
          ].some(
            ([left, right]) =>
              clean(left) === "req.method" && ts.isStringLiteral(right) && METHODS.has(right.text),
          );
        if (method) {
          let guard: ts.Node | undefined = node.parent;
          while (guard && !ts.isIfStatement(guard)) {
            guard = guard.parent;
          }
          if (
            guard &&
            ts.isIfStatement(guard) &&
            ![...routes.values()].some(
              (route) =>
                route.source === source &&
                ((route.node.pos >= guard.pos && route.node.end <= guard.end) ||
                  (guard.pos >= route.node.pos && guard.end <= route.node.end)),
            )
          ) {
            throw new Error(`Uncovered route selector in ${where(node)}`);
          }
        }
      }
      ts.forEachChild(node, audit);
    };
    audit(source);
  }
  return [...routes.values()].toSorted((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}
