import type { ModelInstance, ModelProvider, Role } from "./prototype-models";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

type ProviderWire = {
  id: string;
  preset_id: string;
  name: string;
  base_url: string;
  api_key_masked: string;
  default_protocol: string;
  health: ModelProvider["health"];
  model_count: number;
  last_latency_ms: number | null;
  last_error: string | null;
  last_checked_at: string | null;
};

type ModelWire = {
  id: string;
  provider_id: string;
  name: string;
  model_id: string;
  model_type: ModelInstance["modelType"];
  protocol: string;
  context_length: number | null;
  vector_dimension: number | null;
  timeout_seconds: number;
  enabled: boolean;
};

export type ProviderInput = {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultProtocol: string;
};

export type ModelInput = {
  providerId: string;
  name: string;
  modelId: string;
  modelType: ModelInstance["modelType"];
  protocol: string;
  contextLength: number | null;
  vectorDimension: number | null;
  timeoutSeconds: number;
  enabled: boolean;
};

export type HealthCheckResult = {
  provider_id: string;
  model_id: string;
  status: ModelProvider["health"];
  latency_ms: number;
  protocol: string;
  checks: Record<string, boolean>;
  usage: Record<string, number> | null;
  message: string;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  modelType: ModelInstance["modelType"];
  typeConfidence: "high" | "medium" | "low";
};

export type ModelDiscoveryInput = {
  providerId?: string;
  presetId: string;
  baseUrl: string;
  apiKey: string;
  protocol: string;
};

export type ModelDiscoveryResult = {
  models: DiscoveredModel[];
  truncated: boolean;
};

export type ModelDefaults = {
  routing_embedding: string | null;
  routing_llm: string | null;
  default_rerank: string | null;
  vision: string | null;
};

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const payload = await response.json() as { detail?: string | Array<{ msg?: string }> };
      if (typeof payload.detail === "string") message = payload.detail;
      if (Array.isArray(payload.detail)) message = payload.detail.map((item) => item.msg).filter(Boolean).join("；") || message;
    } catch {
      // Keep the status-based fallback when an upstream service does not return JSON.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function mapProvider(provider: ProviderWire): ModelProvider {
  return {
    id: provider.id,
    presetId: provider.preset_id,
    name: provider.name,
    baseUrl: provider.base_url,
    apiKeyMasked: provider.api_key_masked,
    defaultProtocol: provider.default_protocol,
    health: provider.health,
    modelCount: provider.model_count,
    lastLatencyMs: provider.last_latency_ms,
    lastError: provider.last_error,
    lastCheckedAt: provider.last_checked_at,
  };
}

function mapModel(model: ModelWire): ModelInstance {
  return {
    id: model.id,
    providerId: model.provider_id,
    name: model.name,
    modelId: model.model_id,
    modelType: model.model_type,
    protocol: model.protocol,
    contextLength: model.context_length,
    vectorDimension: model.vector_dimension,
    timeoutSeconds: model.timeout_seconds,
    enabled: model.enabled,
  };
}

export async function getSession(): Promise<{ id: string; role: Role }> {
  return apiRequest("/session");
}

export async function updateSessionRole(role: Role): Promise<{ id: string; role: Role }> {
  return apiRequest("/session", { method: "PUT", body: JSON.stringify({ role }) });
}

export async function listProviders(): Promise<ModelProvider[]> {
  return (await apiRequest<ProviderWire[]>("/providers")).map(mapProvider);
}

export async function createProvider(input: ProviderInput): Promise<ModelProvider> {
  const provider = await apiRequest<ProviderWire>("/providers", {
    method: "POST",
    body: JSON.stringify({
      preset_id: input.presetId,
      name: input.name,
      base_url: input.baseUrl,
      api_key: input.apiKey,
      default_protocol: input.defaultProtocol,
    }),
  });
  return mapProvider(provider);
}

export async function updateProvider(id: string, input: ProviderInput): Promise<ModelProvider> {
  const body: Record<string, string> = {
    name: input.name,
    base_url: input.baseUrl,
    default_protocol: input.defaultProtocol,
  };
  if (input.apiKey) body.api_key = input.apiKey;
  const provider = await apiRequest<ProviderWire>(`/providers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return mapProvider(provider);
}

export async function deleteProvider(id: string): Promise<void> {
  return apiRequest(`/providers/${id}`, { method: "DELETE" });
}

export async function discoverProviderModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const body: Record<string, string> = {
    preset_id: input.presetId,
    base_url: input.baseUrl,
    protocol: input.protocol,
  };
  if (input.providerId) body.provider_id = input.providerId;
  if (input.apiKey) body.api_key = input.apiKey;
  const result = await apiRequest<{
    models: Array<{ id: string; name: string; model_type: ModelInstance["modelType"]; type_confidence: "high" | "medium" | "low" }>;
    truncated: boolean;
  }>("/providers/discover-models", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    models: result.models.map((model) => ({
      id: model.id,
      name: model.name,
      modelType: model.model_type,
      typeConfidence: model.type_confidence,
    })),
    truncated: result.truncated,
  };
}

export async function listModels(providerId?: string): Promise<ModelInstance[]> {
  const query = providerId ? `?provider_id=${encodeURIComponent(providerId)}` : "";
  return (await apiRequest<ModelWire[]>(`/models${query}`)).map(mapModel);
}

export async function createModel(input: ModelInput): Promise<ModelInstance> {
  const model = await apiRequest<ModelWire>("/models", {
    method: "POST",
    body: JSON.stringify({
      provider_id: input.providerId,
      name: input.name,
      model_id: input.modelId,
      model_type: input.modelType,
      protocol: input.protocol,
      context_length: input.contextLength,
      vector_dimension: input.vectorDimension,
      timeout_seconds: input.timeoutSeconds,
      enabled: input.enabled,
    }),
  });
  return mapModel(model);
}

export async function updateModel(id: string, input: ModelInput): Promise<ModelInstance> {
  const model = await apiRequest<ModelWire>(`/models/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: input.name,
      model_id: input.modelId,
      model_type: input.modelType,
      protocol: input.protocol,
      context_length: input.contextLength,
      vector_dimension: input.vectorDimension,
      timeout_seconds: input.timeoutSeconds,
      enabled: input.enabled,
    }),
  });
  return mapModel(model);
}

export async function checkProvider(id: string): Promise<HealthCheckResult> {
  return apiRequest(`/providers/${id}/health-check`, { method: "POST" });
}

export async function getModelDefaults(): Promise<ModelDefaults> {
  return apiRequest("/model-defaults");
}

export async function updateModelDefaults(defaults: ModelDefaults): Promise<ModelDefaults> {
  return apiRequest("/model-defaults", { method: "PUT", body: JSON.stringify(defaults) });
}
