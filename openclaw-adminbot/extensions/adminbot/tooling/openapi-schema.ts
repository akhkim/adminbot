// JSON Schema projection of the server's TypeScript types. Unknown stays unknown:
// a handler accepting Record<string, unknown> is not a typed public contract.
import ts from "typescript";

export type Schema = Record<string, unknown>;
export class SchemaEmitter {
  readonly components: Record<string, Schema> = {};
  private readonly names = new Map<ts.Type, string>();
  constructor(private readonly checker: ts.TypeChecker) {}

  emit(type: ts.Type, depth = 0): Schema {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      return {};
    }
    if (type.flags & ts.TypeFlags.Never) {
      return { not: {} };
    }
    if (type.flags & ts.TypeFlags.Null) {
      return { type: "null" };
    }
    if (type.isStringLiteral()) {
      return { type: "string", const: type.value };
    }
    if (type.isNumberLiteral()) {
      return { type: "number", const: type.value };
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return { type: "boolean", const: this.checker.typeToString(type) === "true" };
    }
    if (type.flags & ts.TypeFlags.StringLike) {
      return { type: "string" };
    }
    if (type.flags & ts.TypeFlags.NumberLike) {
      return { type: "number" };
    }
    if (type.flags & ts.TypeFlags.BooleanLike) {
      return { type: "boolean" };
    }
    if (type.isUnion()) {
      const parts = type.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined));
      if (parts.length === 1) {
        return this.emit(parts[0], depth);
      }
      if (parts.every((part) => part.isStringLiteral())) {
        return { type: "string", enum: parts.map((part) => part.value) };
      }
      if (parts.every((part) => part.flags & ts.TypeFlags.BooleanLiteral)) {
        return { type: "boolean" };
      }
      return { anyOf: parts.map((part) => this.emit(part, depth + 1)) };
    }
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const args = this.checker.getTypeArguments(type as ts.TypeReference);
      if (this.checker.isTupleType(type)) {
        return { type: "array", prefixItems: args.map((part) => this.emit(part, depth + 1)) };
      }
      return { type: "array", items: args[0] ? this.emit(args[0], depth + 1) : {} };
    }
    if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) {
      return {};
    }
    const existing = this.names.get(type);
    if (existing) {
      return { $ref: `#/components/schemas/${existing}` };
    }
    if (depth > 20) {
      throw new Error(`Schema nesting exceeds 20 at ${this.checker.typeToString(type)}`);
    }
    const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
    const named =
      name &&
      name !== "__type" &&
      name !== "__object" &&
      !["Record", "Partial", "Pick", "Omit"].includes(name);
    let component: string | undefined;
    if (named) {
      component = name;
      for (let suffix = 2; this.components[component]; suffix++) {
        component = `${name}_${suffix}`;
      }
      this.names.set(type, component);
      this.components[component] = {};
    }
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const property of this.checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) {
        continue;
      }
      properties[property.name] = this.emit(
        this.checker.getTypeOfSymbolAtLocation(property, declaration),
        depth + 1,
      );
      if (!(property.flags & ts.SymbolFlags.Optional)) {
        required.push(property.name);
      }
    }
    const index = this.checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const schema: Schema = {
      type: "object",
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(required.length ? { required } : {}),
      additionalProperties: index ? this.emit(index, depth + 1) : true,
    };
    if (component) {
      this.components[component] = schema;
      return { $ref: `#/components/schemas/${component}` };
    }
    return schema;
  }

  resolve(schema: Schema): Schema {
    return typeof schema.$ref === "string"
      ? this.components[schema.$ref.split("/").at(-1)!]
      : schema;
  }
}
