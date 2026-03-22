import dataProvider from "@refinedev/simple-rest";

const API_URL = "/api/v1";

// Wrap the simple-rest data provider to add auth headers
const baseProvider = dataProvider(API_URL);

const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const agentosDataProvider = {
  ...baseProvider,
  getList: async (params: any) => {
    return baseProvider.getList({ ...params, meta: { ...params.meta, headers: authHeaders() } });
  },
  getOne: async (params: any) => {
    return baseProvider.getOne({ ...params, meta: { ...params.meta, headers: authHeaders() } });
  },
  create: async (params: any) => {
    return baseProvider.create({ ...params, meta: { ...params.meta, headers: authHeaders() } });
  },
  update: async (params: any) => {
    return baseProvider.update({ ...params, meta: { ...params.meta, headers: authHeaders() } });
  },
  deleteOne: async (params: any) => {
    return baseProvider.deleteOne({ ...params, meta: { ...params.meta, headers: authHeaders() } });
  },
  custom: async (params: any) => {
    return baseProvider.custom?.({ ...params, meta: { ...params.meta, headers: authHeaders() } }) ?? { data: {} as any };
  },
};
