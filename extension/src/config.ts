export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3000";
export const WS_BASE = API_BASE.replace(/^http/, "ws");
