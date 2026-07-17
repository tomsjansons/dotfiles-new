import { Type } from "@sinclair/typebox";

/** Shared model-facing contracts for the three job operations. */
export const jobSchema = Type.Object({
  type: Type.Union([Type.Literal("js"), Type.Literal("bash")], { description: "Job provider type" }),
  cmd: Type.String({ description: "JavaScript function body or bash command" }),
  mode: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("async")], { description: "Default: sync" })),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds; no default" })),
});

export const jobListSchema = Type.Object({
  type: Type.Optional(Type.Union([Type.Literal("js"), Type.Literal("bash")])),
  include: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("non-running"), Type.Literal("all")])),
  cursor: Type.Optional(Type.String({ description: "Opaque cursor returned by an earlier job_list call" })),
});

export const jobStopSchema = Type.Object({
  id: Type.String({ description: "Job ID" }),
});
