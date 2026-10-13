/**
 * Client-side view of a server function's result after it has gone through
 * NextResponse.json(): Dates arrive as ISO strings, Prisma Decimals as strings,
 * and everything else keeps its shape. Use with `import type` so no server code
 * reaches the client bundle:
 *
 *   import type { listThings } from "@/lib/things";
 *   type Thing = ApiResult<typeof listThings>[number];
 */
type DecimalLike = { toFixed(digits?: number): string; toNumber(): number };

export type Serialized<T> = T extends Date
  ? string
  : T extends DecimalLike
    ? string
    : T extends (infer U)[]
      ? Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic constraint over any function
export type ApiResult<F extends (...args: any[]) => unknown> = Serialized<Awaited<ReturnType<F>>>;
