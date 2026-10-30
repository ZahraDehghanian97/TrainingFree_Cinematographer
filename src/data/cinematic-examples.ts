/** Ten scene-grounded films; environment IDs remain stadium/factory. */
import type { ResolvedPromptExampleFixture } from './resolved-example-fixtures';
import dataset from '../../examples/cinematic-suite/dataset.json';
export const cinematicPromptExampleFixtures = dataset.examples.map(({ id, environmentId, prompt, resolvedCsl }) => ({ id, environmentId, prompt, resolvedCsl })) as ResolvedPromptExampleFixture[];
