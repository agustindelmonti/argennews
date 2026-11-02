// Función serverless de Vercel: atiende /api/*, y por vercel.json también /mcp y /admin/api/*.
import { handle } from '../lib/app.js';

export default async function handler(req, res) {
  if (!(await handle(req, res))) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'No existe.' })); }
}
