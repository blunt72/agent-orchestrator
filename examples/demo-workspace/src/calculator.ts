/**
 * Simple arithmetic calculator module
 */

export class Calculator {
  private validateOperands(a: number, b: number): void {
    if (!this.isValidNumber(a) || !this.isValidNumber(b)) {
      throw new Error("Operands must be finite numbers");
    }
  }

  private isValidNumber(value: number): boolean {
    return typeof value === "number" && Number.isFinite(value);
  }

  public add(a: number, b: number): number {
    this.validateOperands(a, b);
    return a + b;
  }

  public subtract(a: number, b: number): number {
    this.validateOperands(a, b);
    return a - b;
  }

  public multiply(a: number, b: number): number {
    this.validateOperands(a, b);
    return a * b;
  }

  public divide(a: number, b: number): number {
    this.validateOperands(a, b);
    if (b === 0) {
      throw new Error("Division by zero");
    }
    return a / b;
  }
}
