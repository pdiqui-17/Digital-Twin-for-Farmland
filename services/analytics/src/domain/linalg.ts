/** Giải hệ A x = b bằng khử Gauss có chọn trụ. Ném lỗi nếu ma trận suy biến. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) throw new Error("singular matrix");
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** Bình phương tối thiểu qua phương trình chuẩn, có ridge nhỏ cho ổn định số. */
export function leastSquares(X: number[][], y: number[], ridge = 1e-9): number[] {
  const p = X[0]?.length ?? 0;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  X.forEach((row, i) => {
    for (let j = 0; j < p; j++) {
      b[j]! += row[j]! * y[i]!;
      for (let k = 0; k < p; k++) A[j]![k]! += row[j]! * row[k]!;
    }
  });
  for (let j = 0; j < p; j++) A[j]![j]! += ridge;
  return solve(A, b);
}
