// Minimal TypeScript declarations for snarkjs 0.7.x (ships no bundled types).
declare module "snarkjs" {
  const snarkjs: {
    wtns: {
      calculate(input: unknown, wasmPath: string, witnessPath: string): Promise<void>;
    };
    groth16: {
      fullProve(
        input: unknown,
        wasmPath: string,
        zkeyPath: string,
      ): Promise<{ proof: unknown; publicSignals: string[] }>;
      verify(vk: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
    };
  };
  export = snarkjs;
}
