import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ServiceInfo {
  name: string;
  version: string;
}

export function createServiceServer(info: ServiceInfo) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        status: "ok",
        service: info.name,
        version: info.version
      }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
}
