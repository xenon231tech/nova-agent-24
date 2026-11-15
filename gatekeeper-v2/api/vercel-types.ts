// Minimal Vercel request/response shapes (avoids a @vercel/node dependency).
export interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

export interface VercelResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}
