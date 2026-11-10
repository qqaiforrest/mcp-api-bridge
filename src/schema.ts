/** Turns the config's input specs into one zod object schema the MCP SDK can validate and advertise. */
import { z } from "zod";
import type { InputSpec, ToolSpec } from "./config.js";

function one(spec: InputSpec): z.ZodType {
  let s: z.ZodType;
  switch (spec.type) {
    case "string":
    case "file":
    case "base64": {
      let str = z.string();
      if (spec.minLength !== undefined) str = str.min(spec.minLength);
      if (spec.maxLength !== undefined) str = str.max(spec.maxLength);
      if (spec.type === "string" && spec.minLength === undefined) str = str.min(1, "must not be empty");
      s = str;
      break;
    }
    case "number":
    case "integer": {
      let num = spec.type === "integer" ? z.number().int() : z.number();
      if (spec.min !== undefined) num = num.min(spec.min);
      if (spec.max !== undefined) num = num.max(spec.max);
      s = num;
      break;
    }
    case "boolean":
      s = z.boolean();
      break;
    case "enum":
      s = z.enum(spec.enum as [string, ...string[]]);
      break;
  }
  const described = spec.description ? s.describe(spec.description) : s;
  return spec.optional ? described.optional() : described;
}

export function buildInputSchema(tool: ToolSpec) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, spec] of Object.entries(tool.inputs)) shape[k] = one(spec);
  const base = z.object(shape).strict();
  const groups = tool.exactlyOneOf ?? [];
  if (groups.length === 0) return base;
  return base.superRefine((val, ctx) => {
    for (const group of groups) {
      const given = group.filter((k) => (val as Record<string, unknown>)[k] !== undefined);
      if (given.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `give exactly one of ${group.join(", ")} (got ${given.length === 0 ? "none" : given.join(", ")})`
        });
      }
    }
  });
}
