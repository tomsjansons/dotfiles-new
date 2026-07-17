import type { JobProvider, JobType } from "./types.ts";

export class JobProviderRegistry {
  readonly #providers = new Map<JobType, JobProvider>();

  register(provider: JobProvider): () => void {
    this.#providers.set(provider.type, provider);
    return () => {
      if (this.#providers.get(provider.type) === provider) this.#providers.delete(provider.type);
    };
  }

  get(type: JobType): JobProvider | undefined {
    return this.#providers.get(type);
  }

  types(): JobType[] {
    return [...this.#providers.keys()];
  }
}
