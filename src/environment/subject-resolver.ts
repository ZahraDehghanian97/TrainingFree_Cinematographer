import type { EnvironmentV1 } from "../types/environment";
import type {
  ResolveSubjectsRequest,
  SubjectResolver,
  SubjectResolutionResponse,
} from "../types/subject-binding";
import {
  parseEnvironmentQuery,
  type EnvironmentQueryOptions,
} from "./query";

function subjectBindingRequest(request: ResolveSubjectsRequest): string {
  return `Bind the following semantic CSL subject references to runtime targets.
The CSL has already assigned movement/framing/event roles. Do not reinterpret
the camera direction; only identify matching recognized environment targets.

Director prompt context:
${request.directorPrompt}

CSL subject references:
${JSON.stringify(request.references, null, 2)}`;
}

export interface EnvironmentSubjectResolverOptions extends EnvironmentQueryOptions {
  /** Optional simulator catalog/observation revision for stale-scene checks. */
  sceneRevision?: string;
}

/** EnvironmentV1-backed simulator adapter for the future real 4D resolver. */
export async function resolveEnvironmentSubjectReferences(
  env: EnvironmentV1,
  request: ResolveSubjectsRequest,
  options: EnvironmentSubjectResolverOptions = {},
): Promise<SubjectResolutionResponse> {
  const { sceneRevision, ...queryOptions } = options;
  const scene = {
    id: env.id,
    ...(sceneRevision === undefined ? {} : { revision: sceneRevision }),
  };
  if (
    request.scene.id !== scene.id
    || (request.scene.revision !== undefined
      && request.scene.revision !== scene.revision)
  ) {
    throw new Error(
      `Environment simulator is bound to ${JSON.stringify(scene)}, `
      + `not requested scene ${JSON.stringify(request.scene)}`,
    );
  }

  const query = await parseEnvironmentQuery(
    env,
    subjectBindingRequest(request),
    queryOptions,
  );

  if (query.type !== "resolveSubjectReferences") {
    const detail = query.type === "unsupported"
      ? `: ${query.reason}`
      : `; received ${query.type}`;
    throw new Error(`Environment simulator could not bind CSL subjects${detail}`);
  }

  return { scene, bindings: query.bindings };
}

export function createEnvironmentSubjectResolver(
  env: EnvironmentV1,
  options: EnvironmentSubjectResolverOptions = {},
): SubjectResolver {
  return {
    resolveSubjects: (request) => resolveEnvironmentSubjectReferences(
      env,
      request,
      options,
    ),
  };
}
