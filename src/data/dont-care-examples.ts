import type { ResolvedPromptExampleFixture } from "./resolved-example-fixtures";
import { resolvedPromptExampleFixtures } from "./resolved-example-fixtures";
export interface DontCarePromptExampleFixture extends ResolvedPromptExampleFixture {
  title: string; sourceExampleId: string; explanation: string;
}
/** Sparse-prompt experiments reuse existing scenes; they do not add environments. */
export const dontCarePromptExampleFixtures: DontCarePromptExampleFixture[] = resolvedPromptExampleFixtures.map(f => ({
  ...f, title: f.environmentId === "stadium" ? "ورزشگاه" : "کارخانه", sourceExampleId: f.id,
  explanation: "Camera amounts are left free; the shared scene and its clock do not change.",
}));
