/**
 * Public SDK subpath for embedding provider registration and runtime access.
 */
export {
  getEmbeddingProvider,
  listEmbeddingProviders,
} from "../plugins/embedding/embedding-provider-runtime.js";

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "../plugins/embedding/embedding-providers.js";
