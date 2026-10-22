import { describe, it, expect } from "vitest";
import { Calculator } from "../src/calculator.js";

describe("Calculator", () => {
  const calc = new Calculator();
  const operations = [
    ["add", (a: number, b: number) => calc.add(a, b)],
    ["subtract", (a: number, b: number) => calc.subtract(a, b)],
    ["multiply", (a: number, b: number) => calc.multiply(a, b)],
    ["divide", (a: number, b: number) => calc.divide(a, b)],
  ] as const;

  it("adds two numbers", () => {
    expect(calc.add(2, 3)).toBe(5);
  });

  it("subtracts two numbers", () => {
    expect(calc.subtract(5, 3)).toBe(2);
  });

  it("multiplies two numbers", () => {
    expect(calc.multiply(4, 2)).toBe(8);
  });

  it("divides two numbers", () => {
    expect(calc.divide(10, 2)).toBe(5);
  });

  it("throws on division by zero", () => {
    expect(() => calc.divide(10, 0)).toThrow("Division by zero");
  });

  it("throws on division by negative zero", () => {
    expect(() => calc.divide(10, -0)).toThrow("Division by zero");
  });

  it.each(operations)("throws on invalid operands for %s", (_name, operation) => {
    const invalidOperands = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "4",
      null,
      undefined,
      false,
      {},
      [],
      Symbol("sym"),
    ] as unknown as number[];

    for (const invalidOperand of invalidOperands) {
      expect(() => operation(invalidOperand, 1)).toThrow("Operands must be finite numbers");
      expect(() => operation(1, invalidOperand)).toThrow("Operands must be finite numbers");
    }
  });

  it("accepts safe integer boundary operands", () => {
    expect(calc.add(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(calc.subtract(Number.MIN_SAFE_INTEGER, 0)).toBe(Number.MIN_SAFE_INTEGER);
  });

  it("follows JavaScript number semantics for non-finite arithmetic results", () => {
    expect(calc.add(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Number.POSITIVE_INFINITY);
    expect(calc.multiply(Number.MAX_VALUE, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it("preserves signed zero for zero numerator division", () => {
    expect(Object.is(calc.divide(0, 5), 0)).toBe(true);
    expect(Object.is(calc.divide(0, -5), -0)).toBe(true);
    expect(Object.is(calc.divide(-0, 5), -0)).toBe(true);
    expect(Object.is(calc.divide(-0, -5), 0)).toBe(true);
  });

  it("throws on indeterminate zero division before evaluation", () => {
    expect(() => calc.divide(0, 0)).toThrow("Division by zero");
    expect(() => calc.divide(-0, 0)).toThrow("Division by zero");
  });

  it("preserves IEEE-754 signed zero in multiplication", () => {
    expect(Object.is(calc.multiply(-0, 2), -0)).toBe(true);
    expect(Object.is(calc.multiply(2, -0), -0)).toBe(true);
    expect(Object.is(calc.multiply(-0, -2), 0)).toBe(true);
  });

  it("handles standard floating point precision and subnormal bounds", () => {
    expect(calc.add(0.1, 0.2)).toBeCloseTo(0.3, 10);
    expect(calc.divide(Number.MIN_VALUE, 2)).toBe(0);
    expect(Object.is(calc.divide(Number.MIN_VALUE, 2), 0)).toBe(true);
  });

  it("retains safe integer bounds and follows IEEE-754 beyond them", () => {
    expect(calc.add(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(calc.subtract(Number.MIN_SAFE_INTEGER, 0)).toBe(Number.MIN_SAFE_INTEGER);

    expect(calc.add(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(calc.add(Number.MAX_SAFE_INTEGER, 2)).toBe(Number.MAX_SAFE_INTEGER + 2);
    expect(calc.add(Number.MAX_SAFE_INTEGER, 1)).toBe(calc.add(Number.MAX_SAFE_INTEGER, 2));
  });
});
