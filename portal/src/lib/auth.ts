export function hasAuthToken(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  const token = storage.getItem("token");
  return Boolean(token && token.trim().length > 0);
}
