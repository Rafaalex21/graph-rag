import { criarApp } from "./app.ts";

const porta = Number(process.env["API_PORT"] ?? 3000);
const app = criarApp();

// RNF-1: escuta só no endereço local.
await app.listen({ host: "127.0.0.1", port: porta });
console.log(`API no ar em http://127.0.0.1:${porta}`);
