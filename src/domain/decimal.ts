import Decimal from "decimal.js";

const ArithmeticDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1_000_000,
  toExpPos: 1_000_000,
});

export interface DecimalBounds {
  maximum: string;
  maximumFractionDigits: number;
}

export const INPUT_DECIMAL_BOUNDS: DecimalBounds = Object.freeze({
  maximum: "1000000000",
  maximumFractionDigits: 6,
});

export class DecimalDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalDomainError";
  }
}

type DecimalOperand = DecimalValue | string;

const decimalPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

const canonicalString = (value: Decimal): string => {
  const fixed = value.toFixed();
  if (fixed === "-0") return "0";
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integerPart = "0", fractionPart] = unsigned.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "");
  const fraction = fractionPart?.replace(/0+$/, "") ?? "";
  const canonical = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return canonical === "0" ? "0" : negative ? `-${canonical}` : canonical;
};

const validateInput = (value: string, bounds?: DecimalBounds): string => {
  const match = decimalPattern.exec(value);
  if (!match) {
    throw new DecimalDomainError("invalid decimal string");
  }

  const fraction = match[3] ?? match[4] ?? "";
  if (bounds && fraction.length > bounds.maximumFractionDigits) {
    throw new DecimalDomainError(
      "decimal fractional precision exceeds configured maximum",
    );
  }

  const parsed = new ArithmeticDecimal(value);
  if (bounds) {
    const maximum = new ArithmeticDecimal(bounds.maximum);
    if (!maximum.isFinite() || maximum.isNegative()) {
      throw new DecimalDomainError("invalid decimal maximum");
    }
    if (parsed.abs().greaterThan(maximum)) {
      throw new DecimalDomainError("decimal exceeds configured maximum");
    }
  }
  return canonicalString(parsed);
};

/**
 * An arbitrary-precision decimal value. Its constructor is private so domain
 * callers can only cross the boundary through a decimal string.
 */
export class DecimalValue {
  private constructor(private readonly value: Decimal) {}

  private static asDecimal(value: DecimalOperand): Decimal {
    return value instanceof DecimalValue
      ? value.value
      : new ArithmeticDecimal(validateInput(value));
  }

  static parse(value: string, bounds?: DecimalBounds): DecimalValue {
    return new DecimalValue(
      new ArithmeticDecimal(validateInput(value, bounds)),
    );
  }

  static zero(): DecimalValue {
    return new DecimalValue(new ArithmeticDecimal(0));
  }

  add(value: DecimalOperand): DecimalValue {
    return new DecimalValue(this.value.plus(DecimalValue.asDecimal(value)));
  }

  subtract(value: DecimalOperand): DecimalValue {
    return new DecimalValue(this.value.minus(DecimalValue.asDecimal(value)));
  }

  multiply(value: DecimalOperand): DecimalValue {
    return new DecimalValue(this.value.times(DecimalValue.asDecimal(value)));
  }

  divide(value: DecimalOperand): DecimalValue {
    const divisor = DecimalValue.asDecimal(value);
    if (divisor.isZero())
      throw new DecimalDomainError("decimal division by zero");
    return new DecimalValue(this.value.dividedBy(divisor));
  }

  compare(value: DecimalOperand): -1 | 0 | 1 {
    const comparison = this.value.comparedTo(DecimalValue.asDecimal(value));
    return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
  }

  equals(value: DecimalOperand): boolean {
    return this.compare(value) === 0;
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  toString(): string {
    return canonicalString(this.value);
  }

  toDisplayString(fractionDigits = 6): string {
    if (!Number.isInteger(fractionDigits) || fractionDigits < 0) {
      throw new DecimalDomainError(
        "display fraction digits must be a non-negative integer",
      );
    }
    return this.value.toFixed(fractionDigits, ArithmeticDecimal.ROUND_HALF_UP);
  }
}

export const canonicalizeDecimal = (value: string, bounds?: DecimalBounds) =>
  DecimalValue.parse(value, bounds).toString();

export const formatDecimal = (value: string, fractionDigits = 6) =>
  DecimalValue.parse(value).toDisplayString(fractionDigits);
