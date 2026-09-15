import { Router } from "express";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { UPLOAD_ROOT } from "../utils/categoryView.js";

const CDN = process.env.IBSHER_CDN || "https://cdn.ibsher.com";

export const mediaRouter = Router();

function sendLocal(req, res) {
  const relative = (req.path || "").replace(/^\/local\/?/, "").replace(/\\/g, "/");
  if (!relative || relative.includes("..")) {
    return res.status(404).end();
  }
  const file = path.normalize(path.join(UPLOAD_ROOT, relative));
  const root = path.normalize(UPLOAD_ROOT);
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.status(404).end();
  }
  res.setHeader("Cache-Control", "public, max-age=604800");
  return res.sendFile(file);
}

async function sendMedia(req, res) {
  if ((req.path || "").startsWith("/local/")) {
    return sendLocal(req, res);
  }
  try {
    const cdn = new URL(CDN);
    const relative = (req.path || "/").replace(/\\/g, "/");
    if (!relative || relative === "/" || relative.includes("..")) {
      return res.status(404).end();
    }

    const target = new URL(relative, cdn.origin);
    if (req.url.includes("?")) {
      target.search = req.url.slice(req.url.indexOf("?"));
    }
    if (target.hostname !== cdn.hostname) {
      return res.status(400).end();
    }

    const upstream = await fetch(target, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status === 404 ? 404 : 502).end();
    }

    const type = upstream.headers.get("content-type") || "application/octet-stream";
    if (type.startsWith("text/") || type.includes("json") || type.includes("html")) {
      return res.status(502).end();
    }

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);

    if (req.method === "HEAD" || !upstream.body) {
      return res.end();
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
}

mediaRouter.get("*", sendMedia);
mediaRouter.head("*", sendMedia);
