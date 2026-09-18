export interface TrajectorySourceManifestEntry {
  promptExampleId: string;
  optimizedTrajectoryUrl?: string;
  sampleTrajectoryUrl?: string;
  referenceTrajectoryUrl?: string;
  optimizedTrajectoryStale?: boolean;
}

export type AutomaticTrajectorySourceKind = "requested" | "reference" | "optimized" | "sample";

export interface AutomaticTrajectorySource {
  kind: AutomaticTrajectorySourceKind;
  label: string;
  url: string;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Returns automatic trajectory sources in priority order.
 *
 * Explicit requests win, then the authored reference. Legacy optimizer outputs
 * marked stale are never silently used as a fallback.
 * Optimizer output has a deterministic public path so the pipeline can publish
 * a result without rewriting the environment manifest. A manifest URL can
 * override that convention for deployments with a different layout.
 */
export function automaticTrajectorySources(
  entry: TrajectorySourceManifestEntry,
  requestedTrajectoryUrl?: string | null,
): AutomaticTrajectorySource[] {
  const requested = nonEmpty(requestedTrajectoryUrl);
  const optimized = nonEmpty(entry.optimizedTrajectoryUrl)
    ?? `/trajectories/optimized/${encodeURIComponent(entry.promptExampleId)}-camera.json`;
  const sample = nonEmpty(entry.sampleTrajectoryUrl);
  const sources: AutomaticTrajectorySource[] = [];

  if (requested) {
    sources.push({ kind: "requested", label: "Requested trajectory", url: requested });
  }
  const reference = nonEmpty(entry.referenceTrajectoryUrl);
  if (reference) {
    sources.push({ kind: "reference", label: "Authored reference (not optimized)", url: reference });
  }
  if (entry.optimizedTrajectoryStale) {
    if (sample && sample !== optimized) sources.push({ kind: 'sample', label: 'Bundled demo', url: sample });
  } else if (sample === optimized) {
    sources.push({ kind: "sample", label: "Bundled demo", url: sample });
  } else {
    sources.push({ kind: "optimized", label: "Optimized trajectory", url: optimized });
    if (sample) {
      sources.push({ kind: "sample", label: "Bundled demo", url: sample });
    }
  }

  const seen = new Set<string>();
  return sources.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/** Absolute and protocol-relative URLs should not be rewritten under Vite's public base. */
export function isAbsoluteTrajectoryUrl(url: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//");
}
