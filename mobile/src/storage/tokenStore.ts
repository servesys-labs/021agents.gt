import * as Keychain from "react-native-keychain";

const SERVICE = "oneshots.jwt";

export async function saveJwt(token: string): Promise<void> {
  await Keychain.setGenericPassword("jwt", token, { service: SERVICE });
}

export async function loadJwt(): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({ service: SERVICE });
  if (!creds) return null;
  return creds.password;
}

export async function clearJwt(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}

