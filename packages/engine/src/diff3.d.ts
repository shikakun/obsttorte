declare module "node-diff3" {
  export type Diff3Region<T> =
    | { ok: T[] }
    | {
        conflict: {
          a: T[];
          aIndex: number;
          o: T[];
          oIndex: number;
          b: T[];
          bIndex: number;
        };
      };

  export function diff3Merge<T>(
    a: T[],
    o: T[],
    b: T[],
    options?: { excludeFalseConflicts?: boolean },
  ): Array<Diff3Region<T>>;
}
