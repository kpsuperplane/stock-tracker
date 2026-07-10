import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

const digest = async (value: string) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );

const safeEqual = async (left: string, right: string) => {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  for (
    let index = 0;
    index < Math.max(leftDigest.length, rightDigest.length);
    index += 1
  ) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
};

export const requireBasicAuth = (): MiddlewareHandler<{ Bindings: Env }> =>
  async (context, next) => {
    const header = context.req.header("Authorization");
    const encoded = header?.startsWith("Basic ") ? header.slice(6) : "";
    let supplied = "";
    try {
      supplied = atob(encoded);
    } catch {
      supplied = "";
    }
    const expected = `${context.env.BASIC_AUTH_USERNAME}:${context.env.BASIC_AUTH_PASSWORD}`;
    if (!(await safeEqual(supplied, expected))) {
      return context.body("Authentication required", 401, {
        "WWW-Authenticate": 'Basic realm="Stock Tracker"',
      });
    }
    await next();
  };
