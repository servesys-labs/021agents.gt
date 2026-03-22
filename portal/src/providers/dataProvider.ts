import type { DataProvider } from "@refinedev/core";
import dataProvider from "@refinedev/simple-rest";

const API_URL = "/api/v1";

const baseProvider = dataProvider(API_URL) as DataProvider;

const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

function withHeaders<TParams extends { meta?: Record<string, unknown> }>(params: TParams): TParams {
  return {
    ...params,
    meta: {
      ...params.meta,
      headers: {
        ...(params.meta?.headers as Record<string, string> | undefined),
        ...authHeaders(),
      },
    },
  };
}

export const agentosDataProvider: DataProvider = {
  ...baseProvider,
  getList: async (params) => {
    return baseProvider.getList(withHeaders(params));
  },
  getOne: async (params) => {
    return baseProvider.getOne(withHeaders(params));
  },
  create: async (params) => {
    return baseProvider.create(withHeaders(params));
  },
  update: async (params) => {
    return baseProvider.update(withHeaders(params));
  },
  deleteOne: async (params) => {
    return baseProvider.deleteOne(withHeaders(params));
  },
  custom: async (params) => {
    return baseProvider.custom!(withHeaders(params));
  },
};
