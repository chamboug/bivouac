export interface AppUser {
  sub: string;
  name: string;
  email?: string;
  groups: string[];
}

export function useUser() {
  return useFetch<AppUser>("/api/me", { key: "bivouac-user" });
}
